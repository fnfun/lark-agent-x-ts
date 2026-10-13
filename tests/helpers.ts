import { create, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient } from '../src/client.js';
import type { Dict } from '../src/proto/dict.js';
import { fromDict } from '../src/proto/dict.js';
import { protoType } from '../src/proto/registry.js';

/** 不联网的客户端：auth 只带 user_id，网关调用由测试替换 api / gatewayPost。 */
export const newClient = (): LarkClient =>
  new (LarkClient as unknown as new (auth: LarkAuth) => LarkClient)({ userId: 'me' } as LarkAuth);

/** 文本消息的 content 字节。 */
export const textContent = (text: string): Uint8Array =>
  toBinary(protoType('TextContent'), create(protoType('TextContent'), { text }));

/** 实体消息 dict（网关响应里的形态），默认是一条群聊文本消息。 */
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

/** 长连接推送帧（cmd=6）：messages 为实体消息 dict 列表。 */
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

/** dict → protobuf JSON 可接受的值：bigint 转字符串、字节转 base64。 */
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
