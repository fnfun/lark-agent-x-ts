import { describe, expect, test } from 'bun:test';
import { fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import {
  buildCreateChatPacket,
  buildGroupInfoPacket,
  buildPostMessagePacket,
  buildRichMessagePacket,
  buildSearchPacket,
  buildSendMessagePacket,
  buildUserInfoPacket,
  decodeGroupInfoResponse,
  decodePutChatResponse,
  decodePutMessageResponse,
  decodeSearchResponse,
  decodeUserInfoResponse,
  type RichBlock,
} from '../src/proto/builders.js';
import { decodeMessageContent, decodePushMessages } from '../src/proto/decoders.js';
import { type Dict, toDict } from '../src/proto/dict.js';
import { protoType } from '../src/proto/registry.js';
import { pyDumps } from '../src/pyjson.js';
import fixtures from './fixtures/parity.json';

// 样本由 scripts/gen-parity-fixtures.py 用原项目的 Python 实现生成（合成数据）。
const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const storageJson = (d: unknown) =>
  pyDumps(d, { fallback: (o) => (o instanceof Uint8Array ? `<${o.length} bytes>` : String(o)) });

/**
 * 发送包解码成结构再比（去掉随机的 cid / searchSession）：map 条目在线上的先后顺序两边不同
 * （upb 按哈希槽位、protobuf-es 按插入顺序），服务端不依赖它，所以不比字节。
 */
function decoded(bytes: Uint8Array, type: string): Dict {
  const P = protoType('Packet');
  const T = protoType(type);
  const pkt = toDict(P, fromBinary(P, bytes));
  const req = toDict(T, fromBinary(T, pkt.payload as Uint8Array));
  delete req.cid;
  if (req.header) delete (req.header as Dict).searchSession;
  delete pkt.cid;
  return { ...pkt, payload: req };
}

const same = (pkt: Message, type: string, expected: string) =>
  expect(decoded(toBinary(protoType('Packet'), pkt), type)).toEqual(decoded(unb64(expected), type));

/** 入库的 content_data 按 JSON 语义比较：map 字段的键顺序在 Python 侧取决于 upb 的哈希槽位，没有含义。 */
const sameJson = (got: string | null, expected: string | null) =>
  expect(got === null ? null : JSON.parse(got)).toEqual(
    expected === null ? null : JSON.parse(expected),
  );

describe('与原项目 Python 实现逐项对照', () => {
  for (const c of fixtures.contents) {
    test(`消息内容解码：${c.name}`, () => {
      const [summary, data] = decodeMessageContent(c.type, unb64(c.bytes));
      if (c.name === '系统消息') {
        // 拼接顺序随 map 遍历顺序（见 sameJson），只比内容
        expect(summary.split(' ').sort()).toEqual(c.summary.split(' ').sort());
      } else expect(summary).toBe(c.summary);
      sameJson(data === null ? null : storageJson(data), c.content_data);
    });
  }

  test('推送帧解析：@我、话题回复、缺省字段', () => {
    // 同一推送包里多条消息的先后：Python 按 upb 哈希顺序，这里按服务端下发顺序，按 id 对齐后比较
    const byId = <T extends { msg_id: string }>(xs: T[]) =>
      [...xs].sort((a, b) => a.msg_id.localeCompare(b.msg_id));
    const got = byId(decodePushMessages(unb64(fixtures.push.frame)));
    const want = byId(fixtures.push.messages);
    expect(got.map(({ content_data: _, ...m }) => m)).toEqual(
      want.map(({ content_data: _, ...m }) => m) as never,
    );
    got.forEach((m, i) =>
      sameJson(
        m.content_data === null ? null : storageJson(m.content_data),
        want[i]?.content_data ?? null,
      ),
    );
  });

  for (const s of fixtures.send) {
    test(`发送包：${s.name}`, () => {
      const pkt = buildSendMessagePacket(
        s.text,
        {
          chatId: s.chat,
          rootId: s.root ?? undefined,
          replyTo: s.reply ?? undefined,
          threadChat: s.thread_chat,
        },
        'req',
        s.links,
      );
      same(pkt, 'PutMessageRequest', s.packet);
    });
  }

  test('结构化富文本：加粗、列表、自定义文字链接、@、引用、空行', () => {
    const pkt = buildRichMessagePacket(
      fixtures.rich.spec.blocks as RichBlock[],
      '摘要',
      { chatId: 'c1', replyTo: 'm1' },
      'req',
    );
    same(pkt, 'PutMessageRequest', fixtures.rich.packet);
  });

  test('HTML 富文本、建会话、搜索、查用户、查群', () => {
    same(
      buildPostMessagePacket('<p>hi</p>', { chatId: 'c1', rootId: 'r1' }, 'req', '标题'),
      'PutMessageRequest',
      fixtures.post,
    );
    same(
      buildCreateChatPacket('7100000000000000002', 'req'),
      'PutChatRequest',
      fixtures.others.create_chat,
    );
    same(
      buildSearchPacket('同事', 'req', 'en_US'),
      'UniversalSearchRequest',
      fixtures.others.search,
    );
    same(
      buildUserInfoPacket('7100000000000000002', '7200000000000000001', 'req'),
      'GetUserInfoRequest',
      fixtures.others.user_info,
    );
    same(
      buildGroupInfoPacket('7200000000000000001', 'req'),
      'GetGroupInfoRequest',
      fixtures.others.group_info,
    );
  });

  test('响应解码', () => {
    const r = fixtures.responses;
    expect(decodePutMessageResponse(unb64(r.put_message.bytes))).toBe(r.put_message.expect);
    expect(decodePutChatResponse(unb64(r.put_chat.bytes))).toBe(r.put_chat.expect);
    expect(decodeSearchResponse(unb64(r.search.bytes))).toEqual(r.search.expect as never);
    expect(decodeUserInfoResponse(unb64(r.user_info_en.bytes), 'en_US')).toBe(
      r.user_info_en.expect,
    );
    expect(decodeUserInfoResponse(unb64(r.user_info_zh.bytes), 'zh_CN')).toBe(
      r.user_info_zh.expect,
    );
    expect(decodeGroupInfoResponse(unb64(r.group_info.bytes))).toBe(r.group_info.expect);
  });
});
