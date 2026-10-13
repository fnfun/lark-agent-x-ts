import { fromBinary } from '@bufbuild/protobuf';
import { floatRepr, PyFloat, pyDumps } from '../pyjson.js';
import { head } from '../text.js';
import { type Dict, toDict } from './dict.js';
import { protoEnum, protoType } from './registry.js';

export const MSG_TYPE_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  2: 'POST',
  3: 'FILE',
  4: 'TEXT',
  5: 'IMAGE',
  6: 'SYSTEM',
  7: 'AUDIO',
  8: 'EMAIL',
  9: 'SHARE_GROUP_CHAT',
  10: 'STICKER',
  11: 'MERGE_FORWARD',
  12: 'CALENDAR',
  13: 'CLOUD_FILE',
  14: 'CARD',
  15: 'MEDIA',
  16: 'SHARE_CALENDAR_EVENT',
  17: 'HONGBAO',
  18: 'GENERAL_CALENDAR',
  19: 'VIDEO_CHAT',
  20: 'LOCATION',
  22: 'COMMERCIALIZED_HONGBAO',
  23: 'SHARE_USER_CARD',
  24: 'TODO',
  25: 'FOLDER',
};
export const CHAT_TYPE_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'P2P',
  2: 'GROUP',
  3: 'TOPIC_GROUP',
};
/** Chat.ChatMode 的 THREAD / THREAD_V2：新建的话题群是 GROUP + 这两种模式，旧版话题群才是 TOPIC_GROUP。 */
const THREAD_CHAT_MODES = [2, 3];

const typeName = (t: number) => MSG_TYPE_NAMES[t] ?? String(t);

/** 一条解码后的消息，字段与原项目的消息 dict 一致（入库、agent、命令输出都用它）。 */
export interface LarkMessage {
  msg_id: string;
  msg_type: number;
  msg_type_name: string;
  from_id: string;
  chat_id: string;
  chat_type: number;
  chat_type_name: string;
  scope: 'chat' | 'topic';
  anchor: string;
  at_me: boolean;
  root_id: string;
  parent_id: string;
  cid: string;
  position: number | null;
  create_time: number | null;
  content: string;
  content_data: Dict | null;
  /** 已被撤回（推送里同一条消息以撤回状态重推）；只在为 true 时出现。 */
  recalled?: true;
  /** 被编辑过（content 是编辑后的内容）；只在为 true 时出现。 */
  edited?: true;
}

// entities.Message.Status
const STATUS_DELETED = 2;
const STATUS_MODIFIED = 3;

export function enumToInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const named = protoEnum('entities.Message.Type').values.find((v) => v.name === value);
    if (named) return named.number;
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

const num = (v: unknown): number | null =>
  v === undefined || v === null ? null : typeof v === 'bigint' ? Number(v) : (v as number);
/** dict 值转字符串（Python f-string 的效果）：缺省为空串，浮点按 Python repr。 */
const str = (v: unknown): string =>
  v === undefined || v === null ? '' : v instanceof PyFloat ? floatRepr(v.value) : String(v);

/** 话题群里每条根消息自成一个话题。chatInfo 为 chats.PullChatsByIdsRequest 返回的单个会话。 */
export function isThreadChat(chatInfo: Dict): boolean {
  return (
    THREAD_CHAT_MODES.includes(enumToInt(chatInfo.chatMode ?? 0)) ||
    enumToInt(chatInfo.type ?? 0) === 3
  );
}

/** 返回 [scope, anchor]：anchor 是回复时的 --root，也是 agent 的会话边界。 */
export function resolveScope(
  msgId: string,
  msgType: number,
  chatType: number,
  rootId: string,
  threadId: string,
  threadChat = false,
): ['chat' | 'topic', string] {
  if (chatType === 1) return ['chat', ''];
  if (rootId && rootId !== '0') return ['topic', threadId || rootId];
  // 话题群的根消息本身就开启一个话题（建群等系统提示除外）；普通群每条消息也带 threadId=自身 id，不能据此判断
  if ((threadChat || chatType === 3) && msgType !== 6) return ['topic', msgId || ''];
  return ['chat', ''];
}

const TAG_PLACEHOLDERS: Record<number, string> = {
  2: '[图片]',
  5: '[@]',
  10: '[表情]',
  18: '[视频]',
  22: '[文档]',
};

/** 富文本展平为纯文本：文本类元素取内容，段落后换行，@ 取显示名，其余给占位符。 */
export function extractRichText(richText: Dict | undefined): string {
  let text = '';
  try {
    const dictionary = (richText?.elements as Dict | undefined)?.dictionary as
      | Record<string, Dict>
      | undefined;
    if (!dictionary) return '';
    const elementIds = (richText?.elementIds as string[] | undefined) ?? [];
    let ordered: [string, Dict][];
    if (elementIds.length) {
      const listed = new Set(elementIds);
      ordered = elementIds.filter((k) => k in dictionary).map((k) => [k, dictionary[k] as Dict]);
      ordered.push(...Object.entries(dictionary).filter(([k]) => !listed.has(k)));
    } else {
      ordered = Object.entries(dictionary);
      if (ordered.every(([k]) => /^-?\d+$/.test(k)))
        ordered.sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    }
    for (const [, v] of ordered) {
      const tag = (v.tag as number | undefined) ?? 1;
      const prop = v.property as Uint8Array | undefined;
      if (!prop?.length) continue;
      if ([1, 3, 7, 8, 9, 17].includes(tag)) {
        try {
          text += str(
            toDict(protoType('TextProperty'), fromBinary(protoType('TextProperty'), prop)).content,
          );
          if (tag === 3) text += '\n';
          continue;
        } catch {}
      }
      if (tag === 5) {
        try {
          const at = toDict(protoType('AtProperty'), fromBinary(protoType('AtProperty'), prop));
          if (at.content) {
            text += str(at.content);
            continue;
          }
        } catch {}
      }
      text += TAG_PLACEHOLDERS[tag] ?? '';
    }
  } catch {}
  return text;
}

function parse(type: string, bytes: Uint8Array): Dict {
  const desc = protoType(type);
  let msg: ReturnType<typeof fromBinary>;
  try {
    msg = fromBinary(desc, bytes);
  } catch {
    // 与原项目（protobuf upb）的报错文本一致，它会进摘要并入库
    throw new Error(`Error parsing message with type '${type.split('.').at(-1)}'`);
  }
  return toDict(desc, msg);
}

const fmt1 = (ms: unknown) => (Number(ms ?? 0) / 1000).toFixed(1);
const get = (d: unknown, k: string): unknown => (d as Dict | undefined)?.[k];

/** 消息内容 → [摘要文本, 内容 dict]；与原项目 decode_message_content 的摘要格式逐字一致。 */
export function decodeMessageContent(
  messageType: number,
  content: Uint8Array = new Uint8Array(),
): [string, Dict | null] {
  try {
    switch (messageType) {
      case 4: {
        const d = parse('TextContent', content);
        return [extractRichText(d.richText as Dict | undefined) || str(d.text), d];
      }
      case 2: {
        const d = parse('PostContent', content);
        const text = extractRichText(d.richText as Dict | undefined) || str(d.text);
        return [`[富文本] ${str(d.title)}\n${text}`.trim(), d];
      }
      case 5: {
        const d = parse('ImageContent', content);
        const v2 = d.imageV2 as Dict | undefined;
        if (v2 && Object.keys(v2).length) {
          let width: unknown = '?';
          let height: unknown = '?';
          for (const variant of (v2.variants as Dict[] | undefined) ?? []) {
            if (variant.type === 1) {
              const size = (variant.size as Dict | undefined) ?? {};
              width = size.width ?? '?';
              height = size.height ?? '?';
              break;
            }
          }
          const crypto = 'crypto' in v2 ? ' 已加密' : '';
          return [`[图片] imageKey=${str(v2.imageKey)} (${str(width)}x${str(height)})${crypto}`, d];
        }
        const image = (d.image as Dict | undefined) ?? {};
        const img = (image.origin as Dict | undefined) ?? {};
        const key = img.key || image.key || image.imageKey || '';
        return [
          `[图片] imageKey=${str(key)} (${str(img.width ?? '?')}x${str(img.height ?? '?')})`,
          d,
        ];
      }
      case 3: {
        const d = parse('FileContent', content);
        return [
          `[文件] ${str(d.name)} (${str(d.mime)}, ${str(d.size ?? 0)}字节, key=${str(d.key)})`,
          d,
        ];
      }
      case 15: {
        const d = parse('MediaContent', content);
        return [
          `[视频] ${str(d.name)} (时长${fmt1(d.duration)}s, ${str(d.size ?? 0)}字节, key=${str(d.key)})`,
          d,
        ];
      }
      case 7: {
        const d = parse('AudioContent', content);
        return [`[语音] 时长${fmt1(d.duration)}s, key=${str(d.key)}`, d];
      }
      case 10: {
        const d = parse('StickerContent', content);
        return [`[表情包] stickerId=${str(d.stickerId)} key=${str(d.key)}`, d];
      }
      case 14: {
        const d = parse('CardContent', content);
        const header = (d.cardHeader as Dict | undefined) ?? {};
        const title = header.title || header.mainTitle || '';
        const jsonCard = str(d.jsonCard);
        const parts = ['[卡片]'];
        if (title) parts.push(str(title));
        if (d.cardDesc) parts.push(`(${str(d.cardDesc)})`);
        if (jsonCard) parts.push(head(jsonCard, 2000));
        else if (d.openCardContent)
          parts.push(`<openCardContent ${(d.openCardContent as Uint8Array).length}字节>`);
        return [parts.join(' '), d];
      }
      case 11: {
        const d = parse('MergeForwardContent', content);
        const msgs = (d.messages as Dict[] | undefined) ?? [];
        const name =
          str(d.groupChatName) || `${str(d.p2pCreatorName)}与${str(d.p2pPartnerName)}的会话`;
        const lines = [`[合并转发] ${name} 共${msgs.length}条:`];
        for (const m of msgs.slice(0, 20)) {
          const [sub] = decodeMessageContent(
            enumToInt(m.type ?? 0),
            (m.content as Uint8Array | undefined) ?? new Uint8Array(),
          );
          lines.push(`  ${str(m.fromId)}: ${sub}`);
        }
        return [lines.join('\n'), d];
      }
      case 20: {
        const d = parse('LocationContent', content);
        const desc = (d.locationDescription as Dict | undefined) ?? {};
        return [
          `[位置] ${str(desc.name)} ${str(desc.description)} (${str(d.latitude)},${str(d.longitude)})`,
          d,
        ];
      }
      case 6: {
        const d = parse('SystemContent', content);
        const texts: string[] = [];
        for (const cv of Object.values((d.sysContentValues as Record<string, Dict>) ?? {})) {
          for (const item of (get(cv, 'items') as Dict[] | undefined) ?? []) {
            if (item.text) texts.push(str(item.text));
          }
        }
        return [`[系统消息] type=${str(d.typeNum || d.type)} ${texts.join(' ')}`, d];
      }
      case 23: {
        const d = parse('ShareUserCardContent', content);
        return [`[名片] ${str(d.name)} (userId=${str(d.userId)})`, d];
      }
      case 9: {
        const d = parse('ShareGroupChatContent', content);
        const chat = (d.chat as Dict | undefined) ?? {};
        return [`[群分享] ${str(chat.name)} (chatId=${str(d.chatId || chat.id)})`, d];
      }
      case 16: {
        const d = parse('ShareCalendarEventContent', content);
        return [`[分享日程] 参与人数=${str(d.attendeesCount ?? '?')}`, d];
      }
      case 17: {
        const d = parse('HongbaoContent', content);
        return [`[红包] ${str(d.subject)}`, d];
      }
      case 12: {
        const d = parse('CalendarContent', content);
        return [`[日历] ${str(d.calendar)}`, d];
      }
      case 19: {
        const d = parse('VideoChatContent', content);
        return [`[视频会议] ${str(get(d.meetingCard, 'topic'))}`, d];
      }
      case 8: {
        const d = parse('EmailContent', content);
        return [`[邮件] ${str(d.title)} ${str(d.text)}`, d];
      }
    }
  } catch (err) {
    return [`[${typeName(messageType)}消息解析失败: ${(err as Error).message}]`, null];
  }
  return [`[${typeName(messageType)}类型消息]`, null];
}

/** 长连接帧 → [Frame dict, Packet dict]。 */
export function parseWsFrame(raw: Uint8Array): [Dict, Dict] {
  const frame = fromBinary(protoType('Frame'), raw);
  const frameDict = toDict(protoType('Frame'), frame);
  const payload = (frameDict.payload as Uint8Array | undefined) ?? new Uint8Array();
  return [frameDict, toDict(protoType('Packet'), fromBinary(protoType('Packet'), payload))];
}

/** 实体消息 dict（推送或拉取结果）→ LarkMessage。 */
export function toLarkMessage(
  v: Dict,
  o: { atMe?: boolean; threadChat?: boolean; fallbackChatId?: string; fallbackPosition?: number },
): LarkMessage {
  const msgType = enumToInt(v.type ?? 0);
  const chatType = enumToInt(v.chatType ?? 0);
  const [summary, data] = decodeMessageContent(
    msgType,
    (v.content as Uint8Array | undefined) ?? new Uint8Array(),
  );
  const rootId = str(v.rootId);
  const [scope, anchor] = resolveScope(
    str(v.id),
    msgType,
    chatType,
    rootId,
    str(v.threadId),
    o.threadChat ?? false,
  );
  const position = num(v.position);
  const status = enumToInt(v.status ?? 0);
  const recalled = status === STATUS_DELETED || v.isRemoved === true;
  const edited = !recalled && (status === STATUS_MODIFIED || Number(v.editVersion ?? 0) > 0);
  return {
    msg_id: str(v.id),
    msg_type: msgType,
    msg_type_name: typeName(msgType),
    from_id: str(v.fromId),
    chat_id: str(v.chatId || v.channelId || o.fallbackChatId),
    chat_type: chatType,
    chat_type_name: CHAT_TYPE_NAMES[chatType] ?? String(chatType),
    scope,
    anchor,
    at_me: o.atMe ?? false,
    root_id: rootId,
    parent_id: str(v.parentId),
    cid: str(v.cid),
    position: o.fallbackPosition === undefined ? position : position || o.fallbackPosition,
    create_time: num(v.createTime),
    content: summary,
    content_data: data,
    ...(recalled ? { recalled: true as const } : {}),
    ...(edited ? { edited: true as const } : {}),
  };
}

/** 推送帧（cmd=6）里的全部消息。 */
export function decodePushMessages(raw: Uint8Array): LarkMessage[] {
  const [, packet] = parseWsFrame(raw);
  if (!('payload' in packet)) return [];
  const pmr = parse('PushMessagesRequest', packet.payload as Uint8Array);
  const atMe = (pmr.messagesAtMe as Record<string, boolean> | undefined) ?? {};
  return Object.entries((pmr.messages as Record<string, Dict> | undefined) ?? {}).map(([k, v]) =>
    toLarkMessage(v, { atMe: Boolean(atMe[str(v.id)] || atMe[k]) }),
  );
}

/**
 * content_data 的入库格式（messages.db 的 content_data 列）：Python `json.dumps(ensure_ascii=False)` 的写法，
 * 原始字节（内联缩略图等）换成 `<n bytes>` 占位，截断到 2 万个字符；无内容时为空串。
 */
export function contentDataJson(data: Dict | null | undefined): string {
  if (data === null || data === undefined) return '';
  const fallback = (o: unknown): unknown =>
    o instanceof Uint8Array ? `<${o.length} bytes>` : String(o);
  return head(pyDumps(data, { fallback }), 20000);
}
