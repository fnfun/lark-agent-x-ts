/** 网页客户端的 UA；网关与登录接口都按浏览器请求校验。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** 非 2xx 响应（对应 requests 的 raise_for_status，消息格式一致）。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    url: string,
  ) {
    super(`${status} ${status < 500 ? 'Client' : 'Server'} Error: ${statusText} for url: ${url}`);
  }
}

/** 连接失败、超时等网络层错误；消息带"网络"，调用方据此区分凭证问题与网络问题。 */
export class NetworkError extends Error {}

export const cookieHeader = (cookies: Record<string, string>): string =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

export interface RequestOptions {
  method?: string;
  params?: Record<string, string | number>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: RequestInit['body'];
  timeoutMs?: number;
  redirect?: RequestInit['redirect'];
}

export async function request(url: string, o: RequestOptions = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(o.params ?? {})) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookies && Object.keys(o.cookies).length) headers.cookie = cookieHeader(o.cookies);
  try {
    return await fetch(u, {
      method: o.method ?? 'GET',
      headers,
      ...(o.body === undefined ? {} : { body: o.body }),
      redirect: o.redirect ?? 'follow',
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const e = err as Error;
    const reason =
      e.name === 'TimeoutError' ? `Read timed out (${o.timeoutMs ?? 15_000}ms)` : e.message;
    throw new NetworkError(`网络请求失败(${u.host}): ${reason}`);
  }
}

export function raiseForStatus(res: Response): Response {
  if (!res.ok) throw new HttpError(res.status, res.statusText, res.url);
  return res;
}

function parseSetCookie(line: string): { name: string; value: string; expired: boolean } | null {
  const [pair = '', ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  let expired = false;
  for (const a of attrs) {
    const [k = '', v = ''] = a.trim().split('=');
    const key = k.toLowerCase();
    if (key === 'max-age' && Number(v) <= 0) expired = true;
    if (key === 'expires' && Date.parse(v) < Date.now()) expired = true;
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), expired };
}

/**
 * 登录流程用的 cookie 罐（对应 requests.Session）：手动跟随重定向，收下每一跳的 Set-Cookie，后续请求全部带上。
 * 登录涉及的都是同一区域的子域名，不按域名区分。
 */
export class CookieJar {
  readonly cookies: Record<string, string> = {};

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const c = parseSetCookie(line);
      if (!c) continue;
      if (c.expired) delete this.cookies[c.name];
      else this.cookies[c.name] = c.value;
    }
  }

  async fetch(url: string, o: RequestOptions = {}): Promise<Response> {
    let current = url;
    let opts: RequestOptions = { ...o };
    for (let hop = 0; hop < 10; hop++) {
      const res = await request(current, {
        ...opts,
        cookies: { ...this.cookies, ...(o.cookies ?? {}) },
        redirect: 'manual',
      });
      this.absorb(res);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      current = new URL(location, current).toString();
      // 与浏览器一致：303 及 POST 的 301/302 改为 GET 且丢弃请求体
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && opts.method === 'POST')
      ) {
        const { body: _body, params: _params, ...rest } = opts;
        opts = { ...rest, method: 'GET' };
      } else {
        const { params: _params, ...rest } = opts;
        opts = rest;
      }
    }
    throw new NetworkError(`网络请求失败(${new URL(url).host}): 重定向次数过多`);
  }
}
