import { describe, expect, test } from 'bun:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient, SendUnconfirmed } from '../src/client.js';
import { CookieJar, HttpError, NetworkError, raiseForStatus, request } from '../src/http.js';
import type { Dict } from '../src/proto/dict.js';
import { protoType } from '../src/proto/registry.js';
import fixtures from './fixtures/parity.json';

const newClient = (): LarkClient =>
  new (LarkClient as unknown as new (auth: LarkAuth) => LarkClient)({ userId: 'me' } as LarkAuth);

describe('网关客户端', () => {
  test('标已读：主会话按 position、话题回复按话题推进，话题请求用根消息 position 作 maxPosition', async () => {
    const c = newClient();
    const calls: [string, Dict][] = [];
    const messages: Record<string, Dict> = {
      m1: { chatId: 'c1', position: 40 },
      m2: { chatId: 'c1', position: 41 },
      r1: { chatId: 'c1', position: 12, threadId: 'r1', threadPosition: -1 },
      t1: { chatId: 'c1', position: -3, threadId: 'r1', threadPosition: 0 },
      t2: { chatId: 'c1', position: -3, threadId: 'r1', threadPosition: 2 },
      q1: { chatId: 'c1', position: 42, threadId: 'r1' },
      x1: { chatId: 'c2', position: 1 },
    };
    c.api = async (type, data) => {
      calls.push([String(type), data as Dict]);
      if (type === 'messages.PullMessagesByIdsRequest') {
        const ids = (data as { messageIds: string[] }).messageIds;
        return {
          messages: Object.fromEntries(ids.filter((i) => messages[i]).map((i) => [i, messages[i]])),
        };
      }
      return {};
    };
    expect(await c.readMessages('c1', ['m1', 'm2', 't1', 't2', 'q1'])).toBe(5);
    expect(
      calls.filter(([t]) => t === 'messages.PutReadMessagesRequest').map(([, d]) => d),
    ).toEqual([
      { chatId: 'c1', maxPosition: 42, messageIds: ['m1', 'm2', 'q1'] },
      {
        chatId: 'c1',
        maxPosition: 12,
        threadId: 'r1',
        threadMaxPosition: 2,
        messageIds: ['t1', 't2'],
      },
    ]);
    await expect(c.readMessages('c1', ['m1', 'nope'])).rejects.toThrow('找不到消息: nope');
    await expect(c.readMessages('c1', ['x1'])).rejects.toThrow('消息 x1 不在会话 c1 里');
  });

  test('发送失败（网络或响应里没有消息 id）返回 null，不抛错', async () => {
    const c = newClient();
    c.isThreadChat = async () => false;
    c.gatewayPost = async () => {
      throw new NetworkError('网络请求失败(x): Read timed out');
    };
    expect(await c.sendMsg('收到', 'c1')).toBeNull();
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    expect(await c.sendMsg('收到', 'c1')).toBeNull();
    const ok = Buffer.from(fixtures.responses.put_message.bytes, 'base64');
    c.gatewayPost = async () => Uint8Array.from(ok);
    expect(await c.sendMsg('收到', 'c1', { rootId: 'r1' })).toBe('7000000000000000009');
  });

  test('sendMessage 失败时抛错：网络错误原样抛出，拿不到消息 id 抛 SendUnconfirmed', async () => {
    const c = newClient();
    c.isThreadChat = async () => false;
    c.gatewayPost = async () => {
      throw new NetworkError('网络请求失败(x): Read timed out');
    };
    await expect(c.sendMessage('c1', { text: '收到' })).rejects.toBeInstanceOf(NetworkError);
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    await expect(
      c.sendMessage('c1', { blocks: [{ type: 'p', runs: [{ text: '收到' }] }], text: '收到' }),
    ).rejects.toBeInstanceOf(SendUnconfirmed);
    const ok = Buffer.from(fixtures.responses.put_message.bytes, 'base64');
    c.gatewayPost = async () => Uint8Array.from(ok);
    expect(await c.sendMessage('c1', { html: '<p>收到</p>', title: '' })).toBe(
      '7000000000000000009',
    );
  });

  test('长连接：带 sid 的帧回 ACK，推送消息按顺序交给回调，话题群根消息归到自己的话题；服务端异常关闭时抛错', async () => {
    const acks: Dict[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(Buffer.from(fixtures.push.frame, 'base64'));
          setTimeout(() => ws.close(4001, 'bye'), 100);
        },
        message(_ws, data) {
          const frame = fromBinary(protoType('Frame'), data as Uint8Array) as unknown as {
            payload: Uint8Array;
          };
          const pkt = fromBinary(protoType('Packet'), frame.payload) as unknown as Dict;
          acks.push({ cmd: pkt.cmd, sid: pkt.sid });
        },
      },
    });
    try {
      const c = newClient();
      c.buildWsUrl = async () => `ws://localhost:${server.port}`;
      c.isThreadChat = async () => true;
      const got: { id: string; scope: string; anchor: string }[] = [];
      await expect(
        c.connectWebsocket(
          async (m) => void got.push({ id: m.msg_id, scope: m.scope, anchor: m.anchor }),
        ),
      ).rejects.toThrow('WS 连接关闭: code=4001 bye');
      expect(acks).toEqual([{ cmd: 1, sid: 'sid-1' }]);
      expect(got.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: '7000000000000000001', scope: 'topic', anchor: '7000000000000000001' },
        { id: '7000000000000000002', scope: 'topic', anchor: '7000000000000000001' },
      ]);
    } finally {
      server.stop(true);
    }
  });
});

describe('HTTP', () => {
  test('cookie 罐跟随重定向、收下途中的 Set-Cookie 并带到后续请求；过期的删除', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${url.pathname} ${req.headers.get('cookie') ?? ''}`);
        if (url.pathname === '/a')
          return new Response(null, {
            status: 302,
            headers: [
              ['location', '/b'],
              ['set-cookie', 'tenant=t1; Path=/; HttpOnly'],
              ['set-cookie', 'old=; Max-Age=0'],
            ],
          });
        return new Response('appKey: "k1"');
      },
    });
    try {
      const jar = new CookieJar({ session: 's', old: 'o' });
      const res = await jar.fetch(`http://localhost:${server.port}/a`);
      expect(await res.text()).toBe('appKey: "k1"');
      expect(seen).toEqual(['/a session=s; old=o', '/b session=s; tenant=t1']);
      expect(jar.cookies).toEqual({ session: 's', tenant: 't1' });
    } finally {
      server.stop(true);
    }
  });

  test('非 2xx 的报错格式同 requests；连不上时报网络错误', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('x', { status: 400 }) });
    try {
      const res = await request(`http://localhost:${server.port}/gw`);
      expect(() => raiseForStatus(res)).toThrow(
        new HttpError(400, 'Bad Request', `http://localhost:${server.port}/gw`).message,
      );
    } finally {
      server.stop(true);
    }
    await expect(request('http://127.0.0.1:9/x', { timeoutMs: 2000 })).rejects.toThrow(
      /^网络请求失败/,
    );
  });
});
