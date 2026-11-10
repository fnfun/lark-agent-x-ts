import { create, fromJson, type JsonValue, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient } from '../src/client.js';
import type { Dict } from '../src/proto/dict.js';
import { fromDict } from '../src/proto/dict.js';
import { protoType, resolveCmd } from '../src/proto/registry.js';

/**
 * Offline client: auth carries only user_id; tests replace api / gatewayPost for gateway calls.
 */
export const newClient = (): LarkClient =>
  new (LarkClient as unknown as new (auth: LarkAuth) => LarkClient)({ userId: 'me' } as LarkAuth);

/** The content bytes of a text message. */
export const textContent = (text: string): Uint8Array =>
  toBinary(protoType('TextContent'), create(protoType('TextContent'), { text }));

/**
 * Entity message dict (as shaped in gateway responses); defaults to a text message in a group
 * chat.
 */
export const entity = (id: string, over: Dict = {}): Dict => ({
  id,
  type: 4,
  fromId: '7100000000000000001',
  chatId: '7200000000000000001',
  chatType: 2,
  createTime: 1_790_000_000n,
  content: textContent(`消息${id.slice(-2)}`),
  ...over,
});

/** Long-lived connection push frame (cmd=6): messages is a list of entity message dicts. */
export function pushFrame(messages: Dict[], sid = 'sid-1'): Uint8Array {
  const pmr = create(protoType('PushMessagesRequest'), {
    messages: Object.fromEntries(
      messages.map((m) => [String(m.id), fromDict(protoType('entities.Message'), jsonable(m))]),
    ),
  } as Record<string, unknown>);
  const packet = create(protoType('Packet'), {
    sid,
    cmd: 6,
    payload: toBinary(protoType('PushMessagesRequest'), pmr),
  } as Record<string, unknown>);
  return toBinary(
    protoType('Frame'),
    create(protoType('Frame'), { payload: toBinary(protoType('Packet'), packet) } as Record<
      string,
      unknown
    >),
  );
}

/** dict → values protobuf JSON accepts: bigint to string, bytes to base64. */
function jsonable(d: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(d))
    out[k] =
      typeof v === 'bigint'
        ? String(v)
        : v instanceof Uint8Array
          ? Buffer.from(v).toString('base64')
          : v;
  return out;
}

/**
 * Encodes a gateway request strictly against the real protocol definitions: an unknown field name
 * or enum value throws. The client's own encoding ignores unknown fields, so stubs of `api` use
 * this to catch misspelled request fields.
 */
export function strictRequest(typeName: string, data: Dict): void {
  const { req } = resolveCmd(typeName);
  if (!req) throw new Error(`${typeName} 不是请求类型`);
  fromJson(req, data as JsonValue);
}
