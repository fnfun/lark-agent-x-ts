import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AuthExpired, type LarkAuth } from '../src/auth.js';
import { HttpError } from '../src/http.js';
import { WebSession } from '../src/web.js';

/**
 * Fake web host: the messenger entry redirects into the "tenant" (same server), the Docs entry page
 * sets an app cookie, and the APIs echo back which cookies they received.
 */
let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      const cookie = req.headers.get('cookie') ?? '';
      if (url.pathname === '/next/messenger/')
        return new Response(null, { status: 302, headers: { location: '/tenant-home' } });
      if (url.pathname === '/tenant-home' || url.pathname === '/okr/') return new Response('ok');
      if (url.pathname === '/drive/home/')
        return new Response('docs', { headers: { 'set-cookie': 'sl_session=app; Path=/' } });
      if (url.pathname === '/space/api/user/') return Response.json({ code: 0, data: { cookie } });
      if (url.pathname === '/space/api/expired')
        return Response.json({ code: 5, msg: 'Login Required' });
      if (url.pathname === '/okr/api/broken')
        return Response.json({ msg: '参数错误' }, { status: 400 });
      if (url.pathname === '/minutes/home')
        return new Response(null, { status: 302, headers: { location: '/accounts/page/login' } });
      return new Response('login page');
    },
  });
});
afterAll(() => server.stop(true));

const session = () =>
  new WebSession(
    { cookies: { session: 's1' }, region: { domain: 'example.com' } } as unknown as LarkAuth,
    `http://127.0.0.1:${server.port}`,
  );

describe('网页接口', () => {
  test('先进对应应用的入口页拿 cookie，再带着它调接口；同一入口只进一次', async () => {
    const web = session();
    const body = (await web.json('GET', '/space/api/user/', { query: { n: 1 } })) as {
      data: { cookie: string };
    };
    expect(body.data.cookie).toContain('session=s1');
    expect(body.data.cookie).toContain('sl_session=app');
    await web.json('GET', '/space/api/user/');
    expect(seen.filter((p) => p === '/drive/home/')).toHaveLength(1);
  });

  test('被踢到登录页、或接口回 code=5 Login Required，都按凭证失效处理', async () => {
    await expect(session().json('GET', '/space/api/expired')).rejects.toBeInstanceOf(AuthExpired);
    await expect(session().request('GET', '/minutes/api/list')).rejects.toBeInstanceOf(AuthExpired);
  });

  test('非 2xx 抛 HttpError，带上服务端给的原因', async () => {
    const e = await session()
      .request('GET', '/okr/api/broken')
      .catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect([(e as HttpError).status, (e as HttpError).reason]).toEqual([400, '参数错误']);
  });
});
