import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodeFrame, encodeFrame, WhiteboardEditor } from '../src/domains/whiteboard.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;
const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

/** A fake frontier: records the URL and the decoded request, answers with `reply` (and a stray frame first). */
function fakeSocket(reply: Dict, gzip = false) {
  const seen: { url: string; request?: Dict; headers?: Record<string, string> } = { url: '' };
  class FakeSocket {
    binaryType = '';
    onopen?: () => void;
    onmessage?: (e: { data: ArrayBuffer }) => void;
    onerror?: () => void;
    onclose?: () => void;
    constructor(url: string) {
      seen.url = url;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(b: Uint8Array) {
      const { headers, payload } = decodeFrame(b);
      seen.headers = headers;
      seen.request = JSON.parse(new TextDecoder().decode(payload));
      const answer = (reqId: string, body: Dict) => {
        let frame = encodeFrame({ req_id: reqId }, body);
        if (gzip) {
          // Same frame with the payload gzip'd: rebuild with raw bytes.
          const json = new TextEncoder().encode(JSON.stringify(body));
          const z = new Uint8Array(gzipSync(json));
          const head = encodeFrame({ req_id: reqId }, '');
          frame = new Uint8Array([...head.slice(0, head.length - 4), 0x42, z.length, ...z]);
        }
        this.onmessage?.({
          data: frame.buffer.slice(
            frame.byteOffset,
            frame.byteOffset + frame.byteLength,
          ) as ArrayBuffer,
        });
      };
      setTimeout(() => {
        answer('other', { codeMsg: { code: 9 } });
        answer(headers.req_id as string, reply);
      }, 0);
    }
    close() {}
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  return seen;
}

/** A board with nodes o1:1 and o1:2 at applied version 7. */
const fakeWeb = () =>
  ({
    json: async (_m: string, path: string, _o: WebRequest = {}) => {
      if (path.endsWith('whiteboard/block'))
        return {
          code: 0,
          data: {
            meta: { appliedVersion: 7 },
            nodes: [
              { id: 'o1:1', info: { baseV2: { x: 1, y: 2, width: 3, height: 4 } } },
              { id: 'o1:2', info: { baseV2: { x: 5, y: 6, width: 7, height: 8 } } },
            ],
          },
        };
      if (path.endsWith('node_prefix')) return { code: 0, data: { prefix: 1 } };
      if (path.endsWith('ws_ticket/')) return { code: 0, data: { ticket: 'TICKET' } };
      return { code: 0, data: { suid: 'u1', tenant_id: 't1' } };
    },
    request: async () =>
      new Response(
        '<script>{"frontier":{"aid":1191,"appKey":"abc123","fpid":54}};{"frontier":["frontier.example"]}</script>',
      ),
  }) as unknown as WebSession;

const opsOf = (r: Dict | undefined) =>
  (
    ((((r as Dict).data as Dict).uplink as Dict).payload as Dict).body as {
      data: { nodeOperations: Dict[] };
    }
  ).data.nodeOperations;

describe('画板编辑', () => {
  test('连接：配置取自页面，access_key = md5(fpid + appKey + device_id + 盐)，ticket 同时作 session_ticket 和 user_ticket；按 req_id 认回复', async () => {
    const seen = fakeSocket({ codeMsg: { code: 0 } });
    await new WhiteboardEditor(fakeWeb()).setText('WB', 'o1:2', '新文字');
    const url = new URL(seen.url);
    expect(url.host).toBe('frontier.example');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({ fpid: '54', aid: '1191', session_ticket: 'TICKET', tenant_id: 't1' });
    const md5 = createHash('md5').update(`54abc123${q.device_id}f8a69f1719916z`).digest('hex');
    expect(q.access_key).toBe(md5);
    expect(seen.headers?.path).toBe('/api/whiteboard/user_change');
    const data = (seen.request as Dict).data as Dict;
    expect(data.user_ticket).toBe('TICKET');
    expect((data.uplink as Dict).baseSeq).toBe(7);
    expect(opsOf(seen.request)).toEqual([
      {
        nodeUpdate: {
          ids: [],
          cap: { textV2: { text: '新文字' } },
          type: 0,
          paths: [{ path: ['o1:2'] }],
        },
        type: 1,
      },
    ]);
  });

  test('新建排在最后、id 接着同前缀的最大序号；删除从后往前、index 是各自的位置；改位置保留没给的值', async () => {
    let seen = fakeSocket({ codeMsg: { code: 0 } });
    const editor = new WhiteboardEditor(fakeWeb());
    expect(await editor.addShape('WB', '框', { x: 10 })).toBe('o1:3');
    expect(opsOf(seen.request)[0]).toMatchObject({
      type: 2,
      nodeCreate: {
        id: 'o1:3',
        index: 2,
        data: { baseV2: { x: 10, y: 0, width: 120, height: 80 }, textV2: { text: '框' } },
      },
    });
    seen = fakeSocket({ codeMsg: { code: 0 } });
    await editor.remove('WB', ['o1:1', 'o1:2']);
    expect(opsOf(seen.request)).toEqual([
      { nodeDelete: { id: 'o1:2', path: [], index: 1 }, type: 3 },
      { nodeDelete: { id: 'o1:1', path: [], index: 0 }, type: 3 },
    ]);
    seen = fakeSocket({ codeMsg: { code: 0 } });
    await editor.move('WB', 'o1:1', { y: 20 });
    expect(opsOf(seen.request)[0]).toMatchObject({
      nodeUpdate: { cap: { baseV2: { x: 1, y: 20, width: 3, height: 4 } } },
    });
  });

  test('回复的错误码报出来；回复可以是 gzip 的；节点不存在时不连接', async () => {
    fakeSocket({ codeMsg: { code: 4002000, message: 'payload is nil' } });
    await expect(new WhiteboardEditor(fakeWeb()).setText('WB', 'o1:1', 'x')).rejects.toThrow(
      'payload is nil',
    );
    fakeSocket({ codeMsg: { code: 0 } }, true);
    await new WhiteboardEditor(fakeWeb()).setText('WB', 'o1:1', 'x');
    const seen = fakeSocket({ codeMsg: { code: 0 } });
    await expect(new WhiteboardEditor(fakeWeb()).setText('WB', 'o9:9', 'x')).rejects.toThrow(
      '没有这个节点',
    );
    expect(seen.url).toBe('');
  });
});
