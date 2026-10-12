import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import { requestCid } from '../ids.js';
import { type Dict, fromDict, toDict } from './dict.js';
import { larkType, protoType } from './registry.js';

type Fields = Record<string, unknown>;

/** 把请求消息包进网关 Packet。 */
export function wrapPacket(cmd: number, typeName: string, payload: Message, requestId: string) {
  return create(protoType('Packet'), {
    payloadType: 1,
    cmd,
    cid: requestId,
    payload: toBinary(protoType(typeName), payload),
  } as Fields);
}

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

interface RichTextInit {
  elementIds: string[];
  innerText?: string;
  elements: {
    dictionary: Record<string, Fields>;
    styleRefs: Record<string, { styleIds: number[] }>;
    styles: Fields[];
  };
  atIds: string[];
  anchorIds: string[];
  version?: number;
}

const emptyRichText = (): RichTextInit => ({
  elementIds: [],
  elements: { dictionary: {}, styleRefs: {}, styles: [] },
  atIds: [],
  anchorIds: [],
});

const bin = (type: string, fields: Fields, lark = false) => {
  const desc = lark ? larkType(type) : protoType(type);
  return toBinary(desc, create(desc, fields));
};

/**
 * 文本填进 richText：richLinks 时 `[文字](url)` 变成带文字的超链接元素（tag A），其余为文本元素。
 * 实测网页协议的 TEXT 消息接受多个 TEXT/A 元素；加粗、段落、POST 类型都会被服务端拒绝（400）。
 */
function fillRichText(text: string, richLinks: boolean): RichTextInit {
  const rt = emptyRichText();
  let n = 0;
  const nid = () => String(++n);
  const addText = (s: string) => {
    if (!s) return;
    const i = nid();
    rt.elements.dictionary[i] = { tag: 1, property: bin('TextProperty', { content: s }) };
    rt.elementIds.push(i);
  };
  const addAnchor = (label: string, href: string) => {
    const i = nid();
    rt.elements.dictionary[i] = {
      tag: 6,
      property: bin('entities.RichTextElement.AnchorProperty', { href, content: label }, true),
    };
    rt.elementIds.push(i);
    rt.anchorIds.push(i);
  };
  if (!richLinks) addText(text);
  else {
    let pos = 0;
    for (const m of text.matchAll(LINK_RE)) {
      addText(text.slice(pos, m.index));
      addAnchor(m[1] as string, m[2] as string);
      pos = (m.index ?? 0) + m[0].length;
    }
    addText(text.slice(pos));
  }
  rt.innerText = text;
  return rt;
}

/** 结构化富文本的 run：文本（可加粗）、带文字的链接、@某人。 */
export type RichRun =
  | { text?: string; bold?: boolean }
  | { link: { text?: string; href: string } }
  | { at: { user_id: string; text?: string } };

export type RichBlock =
  | { type?: 'p'; runs?: RichRun[] }
  | { type: 'ul'; items?: RichRun[][] }
  | { type: 'quote'; blocks?: RichBlock[] }
  | { type: 'blank' };

/**
 * 按结构化 spec 填 richText（POST 用）。实测要点：容器元素（p/ul/li/quote）必须显式带 property 字段（哪怕为空），
 * 否则服务端报 unmarshal failed；不要包 DOCS 根节点；innerText 必填；加粗用 TEXT 元素的 style fontWeight + styles/styleRefs。
 */
function fillRichBlocks(blocks: RichBlock[], innerText: string): RichTextInit {
  const rt = emptyRichText();
  let counter = 0;
  let usedBold = false;
  const el = (
    tag: number,
    children: string[] = [],
    prop = new Uint8Array(),
    style?: Record<string, string>,
  ) => {
    const i = String(++counter);
    rt.elements.dictionary[i] = {
      tag,
      childIds: children,
      property: prop,
      ...(style ? { style } : {}),
    };
    return i;
  };
  const runEl = (run: RichRun): string => {
    if ('link' in run) {
      const href = String(run.link.href);
      const content = String(run.link.text || run.link.href);
      // 自定义链接文字：客户端据 isCustom/scene 决定按文字渲染；否则会显示成"来自 xx 的消息链接"预览块
      const custom = content !== href ? { isCustom: true, scene: 3 } : {};
      const i = el(
        6,
        [],
        bin('entities.RichTextElement.AnchorProperty', { href, content, ...custom }, true),
      );
      rt.anchorIds.push(i);
      return i;
    }
    if ('at' in run) {
      const i = el(
        5,
        [],
        bin('AtProperty', { userId: String(run.at.user_id), content: String(run.at.text || '') }),
      );
      rt.atIds.push(i);
      return i;
    }
    const bold = Boolean(run.bold);
    usedBold ||= bold;
    return el(
      1,
      [],
      bin('TextProperty', { content: String(run.text ?? '') }),
      bold ? { fontWeight: 'bold' } : undefined,
    );
  };
  const blockEl = (block: RichBlock): string => {
    const t = block.type ?? 'p';
    if (t === 'blank') return el(3);
    if (t === 'p') return el(3, ((block as { runs?: RichRun[] }).runs ?? []).map(runEl));
    if (t === 'ul') {
      const items = ((block as { items?: RichRun[][] }).items ?? []).map((runs) =>
        el(28, runs.map(runEl)),
      );
      return el(26, items, Uint8Array.of(0x08, 0x00));
    }
    if (t === 'quote')
      return el(29, ((block as { blocks?: RichBlock[] }).blocks ?? []).map(blockEl));
    throw new Error(`未知的富文本块类型: ${t}`);
  };
  for (const b of blocks) rt.elementIds.push(blockEl(b));
  if (usedBold) {
    rt.elements.styles.push({ name: 'fontWeight', value: 'bold' });
    rt.elements.styleRefs.fontWeight = { styleIds: [0] };
  }
  rt.innerText = innerText;
  rt.version = 1;
  return rt;
}

export interface Target {
  chatId: string;
  rootId?: string | undefined;
  replyTo?: string | undefined;
  /** 会话是否为话题群（话题群拒收 isReplyInThread）。 */
  threadChat?: boolean;
}

/**
 * 回复关系：replyTo 为引用回复（parentId=rootId=被引用消息，不设 isReplyInThread 即普通引用样式）；
 * rootId 为回复进话题，普通群缺 isReplyInThread 会落进主会话，话题群反而拒收它（replyInThread not support chat）。
 */
function replyFields(t: Target): Fields {
  if (t.replyTo && (!t.rootId || t.rootId === t.replyTo))
    return { rootId: t.replyTo, parentId: t.replyTo };
  if (t.rootId)
    return {
      rootId: t.rootId,
      parentId: t.replyTo || t.rootId,
      ...(t.threadChat ? {} : { isReplyInThread: true }),
    };
  return {};
}

function putMessage(type: number, t: Target, content: Fields, requestId: string) {
  const req = create(protoType('PutMessageRequest'), {
    type,
    chatId: t.chatId,
    cid: requestCid(),
    isNotified: true,
    version: 1,
    ...replyFields(t),
    content,
  } as Fields);
  return wrapPacket(5, 'PutMessageRequest', req, requestId);
}

export function buildSendMessagePacket(
  text: string,
  t: Target,
  requestId: string,
  richLinks = false,
) {
  return putMessage(4, t, { richText: fillRichText(text, richLinks) }, requestId);
}

/** 结构化富文本（POST）消息；innerText 是纯文本摘要（通知/搜索用）。 */
export function buildRichMessagePacket(
  blocks: RichBlock[],
  innerText: string,
  t: Target,
  requestId: string,
) {
  return putMessage(2, t, { richText: fillRichBlocks(blocks, innerText) }, requestId);
}

/**
 * 富文本（POST）消息：content.text 直接放 HTML 片段，服务端自行解析为富文本元素。
 * 实测只保留 <p> <a href>；<b>/<i> 在客户端显示为"当前版本不支持"，列表/引用被丢弃。结构化的用 buildRichMessagePacket。
 */
export function buildPostMessagePacket(html: string, t: Target, requestId: string, title = '') {
  return putMessage(2, t, { ...(title ? { title } : {}), text: html }, requestId);
}

export function buildCreateChatPacket(userId: string, requestId: string) {
  return wrapPacket(
    13,
    'PutChatRequest',
    create(protoType('PutChatRequest'), { type: 1, chatterIds: [userId] } as Fields),
    requestId,
  );
}

export function buildSearchPacket(query: string, requestId: string, locale = 'zh_CN') {
  const req = fromDict(protoType('UniversalSearchRequest'), {
    header: {
      searchSession: requestCid(),
      sessionSeqId: 1,
      query,
      searchContext: {
        tagName: 'SMART_SEARCH',
        entityItems: [
          { type: 1 },
          { type: 2, filter: {} },
          { type: 3, filter: { groupChatFilter: {} } },
          { type: 10, filter: {} },
        ],
        commonFilter: { includeOuterTenant: true },
        sourceKey: 'messenger',
      },
      locale,
      extraParam: {},
    },
  });
  return wrapPacket(11021, 'UniversalSearchRequest', req, requestId);
}

export function buildUserInfoPacket(userId: string, chatId: string, requestId: string) {
  const req = fromDict(protoType('GetUserInfoRequest'), { userId, chatId, userType: 1 });
  return wrapPacket(5023, 'GetUserInfoRequest', req, requestId);
}

export function buildGroupInfoPacket(chatId: string, requestId: string) {
  return wrapPacket(
    64,
    'GetGroupInfoRequest',
    create(protoType('GetGroupInfoRequest'), { chatId } as Fields),
    requestId,
  );
}

/** 响应包的 payload；没有 payload 时为 null。 */
function payloadOf(content: Uint8Array): Uint8Array | null {
  const pkt = toDict(protoType('Packet'), fromBinary(protoType('Packet'), content));
  const payload = pkt.payload as Uint8Array | undefined;
  return payload?.length ? payload : null;
}

const decode = (type: string, bytes: Uint8Array): Dict =>
  toDict(protoType(type), fromBinary(protoType(type), bytes));

/** 发送响应里服务端分配的消息 id；拿不到为空串。 */
export function decodePutMessageResponse(content: Uint8Array): string {
  const payload = payloadOf(content) ?? new Uint8Array();
  return String((decode('PutMessageResponse', payload).message as Dict | undefined)?.id ?? '');
}

export function decodePutChatResponse(content: Uint8Array): string | null {
  const payload = payloadOf(content);
  if (!payload) return null;
  return String((decode('PutChatResponse', payload).chat as Dict | undefined)?.id ?? '');
}

export interface SearchHit {
  type: 'user' | 'group';
  id: string;
  title: string;
}

export function decodeSearchResponse(content: Uint8Array): SearchHit[] {
  const payload = payloadOf(content);
  if (!payload) return [];
  const results = (decode('UniversalSearchResponse', payload).results as Dict[] | undefined) ?? [];
  const out: SearchHit[] = [];
  for (const r of results) {
    const hit = { id: String(r.id ?? ''), title: String(r.titleHighlighted ?? '') };
    if (r.type === 1) out.push({ type: 'user', ...hit });
    else if (r.type === 3) out.push({ type: 'group', ...hit });
  }
  return out;
}

const utf8 = (b: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
};

/** 用户显示名：优先当前语言的翻译，其次昵称。 */
export function decodeUserInfoResponse(content: Uint8Array, locale = 'zh_CN'): string | null {
  const payload = payloadOf(content);
  if (!payload) return null;
  const detail =
    ((decode('UserInfo', payload).userInfoDetail as Dict | undefined)?.detail as
      | Dict
      | undefined) ?? {};
  for (const item of (detail.locales as Dict[] | undefined) ?? []) {
    if (item.key_string === locale.toLowerCase()) return String(item.translation ?? '');
  }
  const nickname = detail.nickname as Uint8Array | undefined;
  if (nickname?.length) return utf8(nickname) ?? new TextDecoder().decode(nickname);
  return null;
}

export function decodeGroupInfoResponse(content: Uint8Array): string | null {
  const payload = payloadOf(content);
  if (!payload) return null;
  const detail =
    ((decode('UserInfo', payload).userInfoDetail as Dict | undefined)?.detail as
      | Dict
      | undefined) ?? {};
  for (const field of [detail.nickname1, detail.nickname4] as (Uint8Array | undefined)[]) {
    if (field?.length) {
      const s = utf8(field);
      if (s !== null) return s;
    }
  }
  return null;
}
