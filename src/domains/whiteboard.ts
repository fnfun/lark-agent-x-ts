/**
 * Editing whiteboards. The whiteboard engine sends node operations only over the docs WebSocket
 * ("frontier"), so this module opens one per call; read off the web app on 2026-11-11 and tested
 * on both test accounts with boards created for the test:
 *
 * - Connecting: `wss://<host>/ws/v2` with query fpid, aid, business_type "", tenant_id,
 *   sdk_version 1, version_code 5806, version 2, device_id (any number), xsack 1, device_platform
 *   web, session_ticket and stamp; `access_key` is md5(fpid + appKey + device_id +
 *   "f8a69f1719916z"). fpid, aid, appKey and the hosts are embedded in the Drive home page
 *   (`"frontier":{aid, appKey, fpid}` and `"frontier":[hosts]`); the ticket is `POST
 *   pandora_ws/ws_ticket/` (JSON {}), which also serves as the messages' user_ticket. No cookies
 *   are needed on the socket.
 * - Frames are protobuf: 1 seq, 2 log id, 3 service (2), 4 method (1), 5 headers ({1: key,
 *   2: value}: req_id, path `/api/whiteboard/user_change`, Req-Version 1), 7 payload type "json",
 *   8 payload (JSON, gzip'd in some replies). The payload is `{data: {member_id, user_ticket,
 *   uplink}, type: "doc", entities: [{type: "WHITEBOARD", token, ...}], version: 2, req_id}`; the
 *   reply's payload has `codeMsg.code` 0 on success.
 * - `uplink` carries `payload.body.data.nodeOperations` (type 20) with `baseSeq` = the board's
 *   `meta.appliedVersion`: nodeCreate (type 2: `{path: [], id, data, index}`), nodeUpdate (type 1:
 *   `{ids: [], cap: <partial node info>, type: 0, paths: [{path: [id]}]}`) and nodeDelete
 *   (type 3: `{id, path: [], index}`). New node ids are `o<prefix>:<n>`, the prefix from
 *   `GET whiteboard/node_prefix`.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { WebSession } from '../web.js';
import { check, Docs, type WhiteboardNode } from './docs.js';

type Dict = Record<string, unknown>;

const SALT = 'f8a69f1719916z';
const TIMEOUT_MS = 15_000;

/** A rectangle with text, as the web app creates it (its own defaults). */
function shapeData(text: string, box: { x: number; y: number; width: number; height: number }) {
  return {
    baseV2: { ...box, angle: 0, isUniform: false },
    textV2: {
      text,
      fontFamily: 'Noto Sans SC',
      fontSize: 14,
      italic: false,
      horizontalAlign: 1,
      verticalAlign: 1,
      sizeMode: 1,
      fontWeight: 'Regular',
      underline: false,
      lineThrough: false,
      paragraphStyles: { data: [] },
      overrideInfo: { characterStyleOverrides: { data: [] }, styleOverrideTable: { data: {} } },
    },
    extraTextInfo: {
      info1: { themeCapability: { fillCodeType: 0, fillColorCode: -1 } },
      info2: { themeCapability: { fillCodeType: 0, fillColorCode: -1 } },
    },
    theme: {
      fillCodeType: 0,
      textColorCodeType: 0,
      borderColorCodeType: 0,
      textBgColorCodeType: 0,
      fillColorCode: -1,
      borderColorCode: -1,
      borderStyleCode: -1,
      borderColorCodeVersion: -1,
      borderWidthCode: -1,
      borderHighPrecisionWidth: -1,
      connectColor: -1,
      connectWidthCode: -1,
      connectStyleCode: -1,
      connectTypeCode: -1,
      iconBorderColor: -1,
      iconFillColor: -1,
      textColorCode: -1,
      textBackgroundColorCode: -1,
    },
    compositeShape: { shapeType: 8, controlPoints: [] },
    opacity: { fillOpacity: 100, borderOpacity: 100 },
    flip: { hFlip: false, vFlip: false },
  };
}

// Minimal protobuf for frontier frames.
const varint = (n: number) => {
  const out: number[] = [];
  let x = n;
  do {
    out.push((x > 127 ? 0x80 : 0) | (x & 0x7f));
    x = Math.floor(x / 128);
  } while (x);
  return out;
};
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const lenField = (f: number, b: number[]) => [...varint(f * 8 + 2), ...varint(b.length), ...b];
const numField = (f: number, n: number) => [...varint(f * 8), ...varint(n)];

/** A request frame: headers and a JSON payload. */
export function encodeFrame(headers: Record<string, string>, payload: unknown): Uint8Array {
  return new Uint8Array([
    ...numField(1, 1),
    ...numField(2, 1),
    ...numField(3, 2),
    ...numField(4, 1),
    ...Object.entries(headers).flatMap(([k, v]) =>
      lenField(5, [...lenField(1, utf8(k)), ...lenField(2, utf8(v))]),
    ),
    ...lenField(7, utf8('json')),
    ...lenField(8, utf8(JSON.stringify(payload))),
  ]);
}

/** A received frame's headers and payload (gunzipped when needed). */
export function decodeFrame(b: Uint8Array): {
  headers: Record<string, string>;
  payload: Uint8Array;
} {
  const headers: Record<string, string> = {};
  let payload: Uint8Array = new Uint8Array();
  let i = 0;
  const read = () => {
    let r = 0;
    let s = 1;
    for (;;) {
      const x = b[i++] as number;
      r += (x & 0x7f) * s;
      if (x < 0x80) return r;
      s *= 128;
    }
  };
  const fields = (bytes: Uint8Array) => {
    const out = new Map<number, Uint8Array>();
    let j = 0;
    while (j < bytes.length) {
      let key = 0;
      let s = 1;
      for (;;) {
        const x = bytes[j++] as number;
        key += (x & 0x7f) * s;
        if (x < 0x80) break;
        s *= 128;
      }
      let len = 0;
      s = 1;
      for (;;) {
        const x = bytes[j++] as number;
        len += (x & 0x7f) * s;
        if (x < 0x80) break;
        s *= 128;
      }
      out.set(key >> 3, bytes.subarray(j, j + len));
      j += len;
    }
    return out;
  };
  while (i < b.length) {
    const key = read();
    const wire = key & 7;
    const field = key >> 3;
    if (wire === 0) read();
    else if (wire === 2) {
      const len = read();
      const value = b.subarray(i, i + len);
      i += len;
      if (field === 5) {
        const kv = fields(value);
        headers[new TextDecoder().decode(kv.get(1))] = new TextDecoder().decode(kv.get(2));
      } else if (field === 8) payload = value;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  if (payload[0] === 0x1f && payload[1] === 0x8b) payload = new Uint8Array(gunzipSync(payload));
  return { headers, payload };
}

export class WhiteboardEditor {
  constructor(readonly web: WebSession) {}

  /** Add a rectangle with text; returns the new node's id. */
  async addShape(
    token: string,
    text: string,
    box: { x?: number; y?: number; width?: number; height?: number } = {},
  ): Promise<string> {
    const { nodes, seq } = await this.board(token);
    const prefix = Number(
      (
        (check(
          await this.web.json('GET', '/space/api/whiteboard/node_prefix', {
            query: { blockToken: token, reqVersion: 1 },
          }),
          '读取画板',
        ).data ?? {}) as Dict
      ).prefix ?? 1,
    );
    const used = nodes
      .map((n) => new RegExp(`^o${prefix}:(\\d+)$`).exec(n.id)?.[1])
      .filter(Boolean)
      .map(Number);
    const id = `o${prefix}:${Math.max(0, ...used) + 1}`;
    const data = shapeData(text, {
      x: box.x ?? 0,
      y: box.y ?? 0,
      width: box.width ?? 120,
      height: box.height ?? 80,
    });
    await this.send(token, seq, [
      { nodeCreate: { path: [], id, data, index: nodes.length }, type: 2 },
    ]);
    return id;
  }

  /** Change a node's text. */
  async setText(token: string, id: string, text: string): Promise<void> {
    const { nodes, seq } = await this.board(token);
    nodeOf(nodes, id);
    await this.send(token, seq, [update(id, { textV2: { text } })]);
  }

  /** Move or resize a node; unset values keep their current ones. */
  async move(
    token: string,
    id: string,
    box: { x?: number; y?: number; width?: number; height?: number },
  ): Promise<void> {
    const { nodes, seq } = await this.board(token);
    const n = nodeOf(nodes, id);
    const baseV2 = {
      x: box.x ?? n.x,
      y: box.y ?? n.y,
      width: box.width ?? n.width,
      height: box.height ?? n.height,
      angle: 0,
      isUniform: false,
    };
    await this.send(token, seq, [update(id, { baseV2 })]);
  }

  /** Remove nodes; returns how many were removed. */
  async remove(token: string, ids: string[]): Promise<number> {
    const { nodes, seq } = await this.board(token);
    const order = nodes.map((n) => n.id);
    const targets = [...new Set(ids)].map((id) => {
      nodeOf(nodes, id);
      return id;
    });
    // Each delete names the node's index among those left, so go from the last one down.
    const ops = targets
      .sort((a, b) => order.indexOf(b) - order.indexOf(a))
      .map((id) => ({ nodeDelete: { id, path: [], index: order.indexOf(id) }, type: 3 }));
    await this.send(token, seq, ops);
    return ops.length;
  }

  private async board(token: string) {
    const data = (check(
      await this.web.json('GET', '/space/api/whiteboard/block', {
        query: { blockToken: token, reqVersion: 1, clientVersion: 14 },
      }),
      '读取画板',
    ).data ?? {}) as Dict;
    const seq = Number(((data.meta ?? {}) as Dict).appliedVersion ?? 0);
    return { nodes: await new Docs(this.web).whiteboard(token), seq };
  }

  /** Sends node operations over a fresh frontier connection and waits for the reply. */
  private async send(token: string, baseSeq: number, nodeOperations: Dict[]): Promise<void> {
    const page = await (
      await this.web.request('GET', '/drive/home/', { headers: { accept: 'text/html' } })
    ).text();
    const config = /"frontier":\{"aid":(\d+),"appKey":"([0-9a-f]+)","fpid":(\d+)\}/.exec(page);
    const host = /"frontier":\["([^"]+)"/.exec(page)?.[1];
    if (!config || !host) throw new Error('编辑画板失败: 页面里找不到协同连接的配置');
    const [, aid, appKey, fpid] = config as unknown as [string, string, string, string];
    const ticket = String(
      (
        (check(
          await this.web.json('POST', '/space/api/pandora_ws/ws_ticket/', { json: {} }),
          '编辑画板',
        ).data ?? {}) as Dict
      ).ticket ?? '',
    );
    const me = (check(await this.web.json('GET', '/space/api/user/'), '读取用户信息').data ??
      {}) as Dict;
    const deviceId = String(Math.floor(Math.random() * 9e13) + 1e13);
    const query = new URLSearchParams({
      fpid,
      aid,
      business_type: '',
      tenant_id: String(me.tenant_id ?? ''),
      sdk_version: '1',
      version_code: '5806',
      version: '2',
      device_id: deviceId,
      xsack: '1',
      device_platform: 'web',
      access_key: createHash('md5').update(`${fpid}${appKey}${deviceId}${SALT}`).digest('hex'),
      session_ticket: ticket,
      stamp: String(Date.now()),
    });
    const uplink = {
      payload: {
        body: { data: { nodeOperations, type: 20, extData: { actionTriggerSource: 0 } } },
        meta: { deviceId, userId: String(me.suid ?? ''), type: 20, pageId: crypto.randomUUID() },
      },
      whiteboardToken: token,
      baseSeq,
      opId: `larkx-${Date.now()}`,
      editTime: Date.now(),
      pkgVersion: 1,
    };
    const entity = {
      isNewProtocol: true,
      resource_type: 'structure',
      route_key: token,
      route_type: 'token',
      token,
      type: 'WHITEBOARD',
    };
    const reqId = String(Math.floor(Math.random() * 1e6));
    const frame = encodeFrame(
      { req_id: reqId, path: '/api/whiteboard/user_change', 'Req-Version': '1' },
      {
        data: { member_id: Number(deviceId), user_ticket: ticket, uplink },
        type: 'doc',
        entities: [entity],
        version: 2,
        req_id: Number(reqId),
      },
    );
    const reply = await new Promise<Dict>((resolve, reject) => {
      const ws = new WebSocket(`wss://${host}/ws/v2?${query}`);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('编辑画板超时: 协同连接没有回应'));
      }, TIMEOUT_MS);
      let settled = false;
      const finish = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        f();
      };
      ws.onopen = () => ws.send(frame);
      ws.onmessage = (e) => {
        const { headers, payload } = decodeFrame(new Uint8Array(e.data as ArrayBuffer));
        if (headers.req_id !== reqId) return;
        try {
          finish(() => resolve(JSON.parse(new TextDecoder().decode(payload)) as Dict));
        } catch {
          finish(() => reject(new Error('编辑画板失败: 看不懂协同连接的回应')));
        }
      };
      // The URL carries the ticket, so errors do not repeat it.
      ws.onerror = () => finish(() => reject(new Error('编辑画板失败: 协同连接建立失败')));
      ws.onclose = () => finish(() => reject(new Error('编辑画板失败: 协同连接在回应前关闭了')));
    });
    const code = (reply.codeMsg as Dict | undefined)?.code;
    if (code !== 0)
      throw new Error(
        `编辑画板失败: ${String((reply.codeMsg as Dict | undefined)?.message || code)}`,
      );
  }
}

const update = (id: string, cap: Dict) => ({
  nodeUpdate: { ids: [], cap, type: 0, paths: [{ path: [id] }] },
  type: 1,
});

function nodeOf(nodes: WhiteboardNode[], id: string): WhiteboardNode {
  const n = nodes.find((x) => x.id === id);
  if (!n) throw new Error(`画板上没有这个节点: ${id}`);
  return n;
}
