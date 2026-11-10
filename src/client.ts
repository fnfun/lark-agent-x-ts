import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from './auth.js';
import { HttpError, NetworkError, raiseForStatus, request, USER_AGENT } from './http.js';
import { accessKey, longRequestId, requestCid, requestId } from './ids.js';
import { getLogger } from './log.js';
import { mp4DurationMs, oggOpusDurationMs, uploadFile, uploadImage } from './media.js';
import {
  authorize,
  checkSource,
  guardMethods,
  type Permission,
  type PermissionSource,
} from './permissions.js';
import {
  buildAudioMessagePacket,
  buildCreateChatPacket,
  buildFileMessagePacket,
  buildGroupInfoPacket,
  buildImageMessagePacket,
  buildMarkdownMessagePacket,
  buildPostMessagePacket,
  buildRichMessagePacket,
  buildSearchPacket,
  buildSendMessagePacket,
  buildUserInfoPacket,
  buildVideoMessagePacket,
  decodeGroupInfoResponse,
  decodePutChatResponse,
  decodePutMessageResponse,
  decodeSearchResponse,
  decodeUserInfoResponse,
  type EditableContent,
  type MarkdownPart,
  type RichBlock,
  richTextOf,
  type SearchHit,
} from './proto/builders.js';
import {
  decodePushMessages,
  decodePushReactions,
  enumToInt,
  isThreadChat,
  type LarkMessage,
  parseWsFrame,
  type ReactionEvent,
  resolveScope,
  toLarkMessage,
} from './proto/decoders.js';
import { type Dict, fromDict, toDict } from './proto/dict.js';
import { larkType, protoType, resolveCmd } from './proto/registry.js';
import { urls, webOrigin } from './region.js';

const logger = getLogger('larkx.client');

type Packet = Message;

// Enum values of feed.PullFeedCardsRequest (FeedType.INBOX, PullType, PullFeedType.INBOX,
// BusinessType.LARK) and FeedCard.Type.CHAT
const FEED_INBOX = 1;
const PULL_REFRESH = 1;
const PULL_LOAD_MORE = 2;
const PULL_FEED_INBOX = 2;
const BUSINESS_LARK = 1;
const CARD_CHAT = 1;

export interface SendOptions {
  /** Reply into a thread (root message id). */
  rootId?: string | undefined;
  /** Quote-reply a message (when quoting inside a thread, also give rootId). */
  replyTo?: string | undefined;
  /**
   * Client id of the message, used as an idempotency key: the server deduplicates by it, so
   * resending with the same cid yields the same message.
   * Generated randomly when omitted; to resend after a SendUnconfirmed, send again with the cid it
   * carries and no duplicate is sent.
   */
  cid?: string | undefined;
  /**
   * Number of automatic retries with the same cid on network errors, 5xx, or a missing message id;
   * default 2.
   */
  retries?: number | undefined;
}

/**
 * Content for sendMessage: plain text, structured rich text (text is the plain-text summary), HTML
 * rich text, Markdown (rendered as Markdown by the client), an image or a file.
 * Images and files are passed as raw bytes and uploaded automatically before sending; name is the
 * file name (shown in file messages; for images it only indicates the format).
 */
export type MessageContent =
  | { text: string; links?: boolean }
  | { blocks: RichBlock[]; text: string }
  | { html: string; title?: string }
  /**
   * Markdown; `![alt](src)` images whose src is an image key (img_…) or an http(s) URL are uploaded
   * and shown inline, and with imageDir, so are relative paths under it (absolute paths and `..`
   * are refused). attachments are files shown in the message's attachment zone.
   */
  | {
      markdown: string;
      title?: string;
      imageDir?: string;
      attachments?: { data: Uint8Array; name: string }[];
    }
  | { image: Uint8Array; name?: string }
  | { file: Uint8Array; name: string }
  /** MP4 video; the duration is read from the file when omitted, cover is an optional image. */
  | { video: Uint8Array; name: string; cover?: Uint8Array; durationMs?: number }
  /** Voice message: an Ogg / Opus file (what the client records); duration read from the file. */
  | { audio: Uint8Array; durationMs?: number };

/**
 * The server accepted the send request but no message id came back, so delivery cannot be
 * confirmed; resending with the cid does not send a duplicate.
 */
export class SendUnconfirmed extends Error {
  constructor(
    message: string,
    readonly cid = '',
  ) {
    super(message);
  }
}

export type MessageHandler = (msg: LarkMessage) => Promise<void>;
export type ReactionHandler = (event: ReactionEvent) => Promise<void>;

/** A chat in the inbox: the feed card's update time + chat info. */
export interface RecentChat {
  chatId: string;
  /** Time of the chat's latest change (ms). */
  updatedAt: number;
  /** Chat info (entities.Chat, same as getChatInfo); null when the server omits it. */
  chat: Dict | null;
}

/**
 * A chat with unread messages: unread is the chat's unread count (topic groups also count new
 * threads).
 */
export interface UnreadChat {
  chatId: string;
  name: string;
  /**
   * 1 direct chat, 2 group chat, 3 legacy topic group (new topic groups are also 2; see
   * threadChat).
   */
  chatType: number;
  threadChat: boolean;
  unread: number;
  /** Number of unread new threads in a topic group. */
  unreadThreads: number;
}

/** Criteria for searching messages across chats; times are millisecond timestamps. */
export interface MessageSearchOptions {
  /** Only search these chats. */
  chatIds?: string[] | undefined;
  /** Only messages sent by these people. */
  fromIds?: string[] | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** Only messages that @ any of these people (the server also counts @all as a match). */
  atIds?: string[] | undefined;
  /** Only messages carrying these attachment kinds. */
  attachmentTypes?: AttachmentType[] | undefined;
  chatType?: 'group' | 'p2p' | undefined;
  /** Only messages from these kinds of senders. */
  senderTypes?: SenderType[] | undefined;
  /** Leave out messages from these kinds of senders. */
  excludeSenderTypes?: SenderType[] | undefined;
  /** Maximum number of results, default 20. */
  limit?: number | undefined;
}

/** Attachment kinds a message search can filter by (entities.Message.MessageAttachmentType). */
export const ATTACHMENT_TYPES = { image: 1, video: 2, file: 3, link: 4, folder: 5 } as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
/** usearch MessageFilter.FromType. */
const SENDER_TYPES = { bot: 1, user: 2 } as const;
export type SenderType = keyof typeof SENDER_TYPES;

/**
 * A search hit: summary is the server-provided summary ("sender: content…", with highlight markup
 * removed); chatTitle is the chat name.
 */
export interface MessageHit {
  msgId: string;
  chatId: string;
  chatTitle: string;
  fromId: string;
  /** Timestamp in seconds. */
  createTime: number;
  position: number | null;
  msgType: number;
  p2p: boolean;
  summary: string;
}

// usearch.SearchEntityType
const SEARCH_ENTITY_USER = 1;
const SEARCH_ENTITY_BOT = 2;
const SEARCH_ENTITY_GROUP = 3;
const SEARCH_ENTITY_MESSAGE = 5;
const unhighlight = (s: unknown) => String(s ?? '').replace(/<\/?h>/g, '');
/** `![alt](src)` in Markdown. */
const MD_IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** Criteria for searching people; the flags narrow the results, leaving them off does not. */
export interface UserSearchOptions {
  /** Only people I have chatted with. */
  chatted?: boolean | undefined;
  /** Leave out users from other tenants. */
  excludeExternal?: boolean | undefined;
  /** Only people who have left the organization. */
  resigned?: boolean | undefined;
  /** Only people with an enterprise email address. */
  enterpriseEmail?: boolean | undefined;
  /** Only these users (combine with a query to check which of them match). */
  userIds?: string[] | undefined;
  /** Maximum number of results, default 20. */
  limit?: number | undefined;
}

export interface UserHit {
  userId: string;
  name: string;
  /** What the client shows under the name: department, title or signature. */
  description: string;
  /** Direct chat with this user; empty when there is none yet. */
  chatId: string;
  email: string;
  crossTenant: boolean;
}

export interface BotSearchOptions {
  /** Only bots in these chats. */
  chatIds?: string[] | undefined;
  /** Only bots I have chatted with. */
  chatted?: boolean | undefined;
  limit?: number | undefined;
}

export interface BotHit {
  botId: string;
  name: string;
  description: string;
  /** Direct chat with this bot; empty when there is none yet. */
  chatId: string;
  /** An AI agent rather than a classic bot. */
  agent: boolean;
}

export interface ChatSearchOptions {
  /** Only groups that have all of these people as members. */
  memberIds?: string[] | undefined;
  /** Only regular groups or only topic groups. */
  mode?: 'group' | 'topic' | undefined;
  /** Server-side order; relevance when omitted. */
  sort?: 'active' | 'created' | 'members' | undefined;
  limit?: number | undefined;
}

export interface ChatHit {
  chatId: string;
  name: string;
  description: string;
  mode: 'group' | 'topic';
  memberCount: number;
  /** Whether I am a member. */
  member: boolean;
  public: boolean;
  crossTenant: boolean;
  /** Time of the last message (s); 0 when unknown. */
  lastMessageTime: number;
}

/** entities.GroupSortRuleType */
const GROUP_SORT = { active: 2, created: 3, members: 4 } as const;
// entities.Chat.ChatMode: THREAD and THREAD_V2 are topic groups
const TOPIC_MODES = new Set([2, 3]);

/** One line of a user's profile card, e.g. Email, Department, Status. */
export interface ProfileField {
  key: string;
  /** Field name in the account's language. */
  label: string;
  value: string;
}

export interface UserProfile {
  userId: string;
  name: string;
  /** Visible fields that have a value, in the order the client shows them. */
  fields: ProfileField[];
}

/** A chat as listed in the chat list. */
export interface ChatSummary {
  chatId: string;
  /** Group name; for a direct chat, the other person's name (my own for the self chat). */
  name: string;
  type: 'p2p' | 'group' | 'topic';
  /** For a direct chat, the other person's id (my own for the self chat); empty for groups. */
  peerId: string;
  /** Notifications are off (do not disturb). */
  muted: boolean;
  memberCount: number;
  unread: number;
  /** Time of the chat's latest change (ms). */
  updatedAt: number;
}

/** Group details (also usable for direct chats, where most group fields are empty). */
export interface ChatInfo {
  chatId: string;
  name: string;
  type: 'p2p' | 'group' | 'topic';
  description: string;
  ownerId: string;
  memberCount: number;
  /** Time the chat was created (s). */
  createTime: number;
  /** I am the owner or an admin. */
  admin: boolean;
  owner: boolean;
  muted: boolean;
  /** @all messages do not notify me either. */
  muteAtAll: boolean;
  public: boolean;
  crossTenant: boolean;
  /** Who may post: anyone, only admins, or a whitelist. */
  postType: 'anyone' | 'admins' | 'whitelist' | 'unknown';
}

const POST_TYPES = { 1: 'anyone', 2: 'admins', 3: 'whitelist' } as const;
const POST_TYPE_VALUES = { anyone: 1, admins: 2, whitelist: 3 } as const;
export type PostType = keyof typeof POST_TYPE_VALUES;

/** A request to join a group (someone applying, or a member inviting someone that needs approval). */
export interface JoinRequest {
  /** The person who would join. */
  userId: string;
  /** Who invited them; empty when they applied themselves. */
  inviterId: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'unknown';
  /** Time of the request (s). */
  time: number;
  /** How they found the group: share, invitation, qrcode, search, link, ... */
  via: string;
}

// chats.ApplyStatus
const APPLY_APPROVED = 1;
const APPLY_REFUSED = 2;
const APPLY_STATUS = { 1: 'approved', 2: 'rejected', 3: 'pending' } as const;
// chats.ApplyWays
const APPLY_WAYS: Record<number, string> = {
  1: 'share',
  2: 'invitation',
  3: 'qrcode',
  4: 'search',
  5: 'department',
  6: 'link',
  7: 'team',
  8: 'calendar',
};
// entities.ChatSetting.Field
const SETTING_IS_REMIND = 1;
const SETTING_MUTE_AT_ALL = 6;
// feed.FeedGroup.FeedGroupType.NORMAL; UpdateFeedGroupsRequest.UpdateFieldType.BASE
const FEED_GROUP_NORMAL = 1;
const FEED_GROUP_FIELD_BASE = 1;

/** Picks the value for locale from `{default_val, i18n_vals}` (either key spelling). */
function localized(v: Dict, locale: string): string {
  const i18n = (v.i18n_vals ?? v.i18nVals ?? {}) as Record<string, string>;
  return String(i18n[locale.toLowerCase()] || v.default_val || v.defaultVal || '');
}

/**
 * Display text of a profile field value (the JSON in strFieldVal). Shapes vary by field type, so
 * this walks the value: localized texts are resolved, link-like objects yield their text or URL,
 * and lists are joined; titles and icons are decoration and are skipped.
 */
export function profileText(v: unknown, locale: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v))
    return v
      .map((x) => profileText(x, locale))
      .filter(Boolean)
      .join('、');
  const d = v as Dict;
  if ('default_val' in d || 'defaultVal' in d || 'i18n_vals' in d || 'i18nVals' in d)
    return localized(d, locale);
  for (const key of ['text', 'content', 'name', 'value', 'url', 'link', 'href']) {
    const t = profileText(d[key], locale);
    if (t) return t;
  }
  return Object.entries(d)
    .filter(([k]) => !['title', 'icon', 'avatar', 'style', 'key'].includes(k))
    .map(([, x]) => profileText(x, locale))
    .filter(Boolean)
    .join('、');
}

const chatKind = (chat: Dict): ChatSummary['type'] =>
  enumToInt(chat.type ?? 0) === 1 ? 'p2p' : isThreadChat(chat) ? 'topic' : 'group';

/** Read status of a message (from the sender's view): who has read it and who hasn't. */
export interface ReadState {
  messageId: string;
  readCount: number;
  unreadCount: number;
  readUserIds: string[];
  unreadUserIds: string[];
  /** The most recent reader and read time (s). */
  lastRead: { userId: string; time: number } | null;
}

/**
 * A flag (an item in the client's "Flagged" list): the flagged message or chat; message flags
 * include the message itself.
 */
export interface FlagItem {
  type: 'message' | 'chat';
  id: string;
  /** Flag time (ms). */
  createTime: number;
  message: LarkMessage | null;
}

/** A pinned message in a chat. */
export interface PinnedMessage {
  pinId: string;
  messageId: string;
  /** Who pinned it. */
  pinnedBy: string;
  /** When it was pinned (ms). */
  pinnedAt: number;
  message: LarkMessage | null;
}

/** A scheduled message not yet sent. at is the planned send time (ms). */
export interface ScheduledMessage {
  messageId: string;
  at: number;
  status: 'pending' | 'suspended';
  message: LarkMessage | null;
}

// ScheduleMessage.Status, PullChatScheduleMessagesRequest.EntityType,
// PatchScheduleMessageRequest.PatchType
const SCHEDULE_PENDING = 1;
const SCHEDULE_SUSPEND = 2;
const SCHEDULE_CHAT_ONLY = 1;
const SCHEDULE_PATCH_UPDATE = 1;
const SCHEDULE_PATCH_DELETE = 3;

/** A feed tag (feed group) in the chat list. keyword marks a tag that auto-groups by keyword. */
export interface FeedGroup {
  id: string;
  name: string;
  type: 'normal' | 'keyword' | 'unknown';
}

/** Max tags / tag items per page (the server returns invalid request for too large a count). */
const FEED_GROUP_PAGE = 20;

// translate.ContentType.TEXT
const TRANSLATE_TEXT = 2;

// feed.Shortcut.Type.CHAT
const SHORTCUT_CHAT = 1;

// feed.FlagItem.FlagType and FeedCard.Type.CHAT
const FLAG_FEED = 1;
const FLAG_MESSAGE = 2;

/** A reaction on a message. */
export interface MessageReactions {
  messageId: string;
  reactions: { type: string; count: number; userIds: string[] }[];
}

/**
 * A group member (or a user looked up by id). name is already resolved as alias > display name in
 * the current locale > default name.
 */
export interface ChatMember {
  id: string;
  name: string;
  type: 'user' | 'bot' | 'ai' | 'unknown';
  /** Nickname the member set in this group (chatMembers only); empty when none. */
  nickname?: string;
}

const CHATTER_TYPES: Record<number, ChatMember['type']> = { 1: 'user', 2: 'bot', 3: 'ai' };

/**
 * entities.Chatter → display name: the alias I set takes precedence, then the display name in the
 * current locale, then the default display name and name.
 */
export function chatterName(v: Dict, locale = 'zh_CN'): string {
  const display = (v.displayName ?? {}) as {
    defaultVal?: string;
    i18nVals?: Record<string, string>;
  };
  return String(
    v.alias ||
      display.i18nVals?.[locale.toLowerCase()] ||
      display.defaultVal ||
      v.name ||
      v.enUsName ||
      '',
  );
}

const toMember = (id: string, v: Dict, locale: string): ChatMember => ({
  id,
  name: chatterName(v, locale),
  type: CHATTER_TYPES[enumToInt(v.type ?? 0)] ?? 'unknown',
});

/**
 * How to look up existing local records when backfilling messages missed while disconnected (all
 * optional; when omitted, treated as having nothing locally).
 */
export interface MissedOptions {
  /**
   * Max position of the chat already stored locally, -1 when there is none (chat positions start at
   * 0); only pull after it, to reduce duplicates.
   */
  localPosition?: (chatId: string) => Promise<number>;
  /**
   * Thread ids of the chat seen locally: thread replies in regular groups take no chat position and
   * can only be looked up per thread.
   */
  knownThreads?: (chatId: string) => Promise<string[]>;
  /** How many messages to look back per chat (or thread) at most, default 200. */
  maxPerChat?: number;
}

const CHANNEL_CHAT = 1;
// Chat.ChatMode.THREAD_V2 (new topic group); NAME and DESCRIPTION of
// PatchGroupChatRequest.UpdateFields
const CHAT_MODE_THREAD_V2 = 3;
const GROUP_FIELD_NAME = 1;
const GROUP_FIELD_DESCRIPTION = 3;
/** Long-lived connection push: reaction changes (reactions.PushReactions). */
const PUSH_REACTIONS = 27;
/** Number of threads to look back at a time in a topic group. */
const RECENT_THREADS = 20;
// users.PullUserProfileV2Request: Scene.BY_USER_ID, Source.CHAT
const PROFILE_BY_USER_ID = 1;
const PROFILE_FROM_CHAT = 2;

const int = (v: unknown, dflt = -1): number =>
  v === undefined || v === null ? dflt : Number(v as number | bigint);

/**
 * On gateway errors the response body is still a Packet, with the error text in the sid field;
 * empty string when it cannot be decoded.
 */
async function gatewayReason(res: Response): Promise<string> {
  try {
    const pkt = fromBinary(protoType('Packet'), new Uint8Array(await res.arrayBuffer()));
    return (pkt as unknown as { sid?: string }).sid ?? '';
  } catch {
    return '';
  }
}

export interface ClientOptions {
  /**
   * Permission check: `true` applies the same rules as the CLI (the account's own rules, otherwise
   * `LARKX_ALLOW` / `LARKX_DENY`), or pass a fixed set of rules; disallowed methods throw
   * PermissionDenied. When omitted, nothing is checked and everything is allowed.
   */
  permissions?: PermissionSource;
}

/** Web protocol client: gateway requests (HTTP + protobuf) and message long-lived connection. */
export class LarkClient {
  private readonly threadChats = new Map<string, boolean>();
  private readonly chatterNames = new Map<string, string>();

  private constructor(readonly auth: LarkAuth) {}

  /**
   * Validate the credentials (throws AuthExpired when invalid); fetch and save app_key / user_id if
   * missing.
   */
  static async create(auth: LarkAuth, o: ClientOptions = {}): Promise<LarkClient> {
    await auth.requireValid();
    if (!auth.appKey || !auth.userId) {
      await auth.validate(true);
      auth.save();
    }
    const client = new LarkClient(auth);
    const source = o.permissions;
    if (source) {
      checkSource(auth, source);
      guardMethods(client, METHOD_PERMISSIONS, (p) => authorize(auth, source, p));
    }
    return client;
  }

  async buildWsUrl(): Promise<string> {
    const deviceId = this.auth.deviceId;
    const params = new URLSearchParams({
      accept_encoding: 'gzip',
      sdk_version: '7.72.8',
      version_code: '7.72.8',
      type: 'sdk_main',
      platform: '',
      terminal_type: '2',
      device_model: '',
      lark_version: '7.72.0',
      net_status: '5',
      lark_env: 'online',
      request_id: requestId(),
      aid: '1',
      fpid: '2',
      device_id: deviceId,
      access_key: accessKey(`2${this.auth.appKey}${deviceId}f8a69f1719916z`),
      ticket: await this.auth.getTicket(),
    });
    return `${urls.ws(this.auth.region)}?${params}`;
  }

  private static wrapFrame(packet: Packet): Uint8Array {
    const seconds = BigInt(Math.floor(Date.now() / 1000));
    const frame = create(protoType('Frame'), {
      seqid: seconds,
      logid: seconds,
      service: 1,
      method: 1,
      headers: [{ key: 'x-request-time', value: String(Date.now()) }],
      payloadType: 'pb',
      payload: toBinary(protoType('Packet'), packet),
    } as Record<string, unknown>);
    return toBinary(protoType('Frame'), frame);
  }

  private static packet(fields: Record<string, unknown>): Packet {
    return create(protoType('Packet'), { payloadType: 1, ...fields });
  }

  /**
   * Long-lived connection timing: handshake timeout, heartbeat interval, and how long without any
   * frame counts as disconnected.
   * The server answers every heartbeat with a frame (cmd=200), so receiving nothing for two
   * heartbeat periods means the connection is dead.
   */
  wsTiming = { openTimeoutMs: 15_000, heartbeatMs: 30_000, idleTimeoutMs: 65_000 };

  /**
   * Connect the message long-lived connection and keep receiving until it closes (returns on a
   * normal close or signal abort, throws on failure).
   * Every frame with a sid is ACKed and application-level heartbeats are sent per wsTiming;
   * messages in pushes (cmd=6) are handed to onMessage serially in arrival order.
   * Handshake timeouts and unanswered heartbeats are treated as abnormal disconnects; the caller
   * reconnects.
   * onOpen is called once after connecting: all later messages will be pushed, so this is the place
   * to backfill messages missed while disconnected.
   * onReaction receives reaction changes (push cmd=27: who added / removed which reaction on which
   * message), on the same serial queue as messages.
   */
  async connectWebsocket(
    onMessage: MessageHandler,
    signal?: AbortSignal,
    onOpen?: () => void,
    onReaction?: ReactionHandler,
  ): Promise<void> {
    const url = await this.buildWsUrl();
    const { openTimeoutMs, heartbeatMs, idleTimeoutMs } = this.wsTiming;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let chain = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lastFrameAt = Date.now();
      let settled = false;
      // Node's WebSocket may fire neither error nor close when the handshake fails, so cleanup
      // cannot rely on the close event alone
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        clearInterval(heartbeat);
        signal?.removeEventListener('abort', onAbort);
        if (ws.readyState !== WebSocket.CLOSED) {
          if (err) ws.close();
          else ws.close(1000, 'stopped');
        }
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish();
      const openTimer = setTimeout(
        () => finish(new Error(`WS 握手超时(${openTimeoutMs}ms)`)),
        openTimeoutMs,
      );
      if (signal?.aborted) return finish();
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        clearTimeout(openTimer);
        lastFrameAt = Date.now();
        logger.info('WS 已连接');
        onOpen?.();
        heartbeat = setInterval(() => {
          if (Date.now() - lastFrameAt > idleTimeoutMs)
            return finish(new Error(`WS 心跳无回应: ${idleTimeoutMs}ms 内没有收到任何帧`));
          try {
            ws.send(LarkClient.wrapFrame(LarkClient.packet({ cmd: 4 })));
          } catch (err) {
            finish(new Error(`WS 心跳发送失败: ${(err as Error).message}`));
          }
        }, heartbeatMs);
      });
      ws.addEventListener('message', (ev) => {
        if (settled || !(ev.data instanceof ArrayBuffer)) return;
        lastFrameAt = Date.now();
        const raw = new Uint8Array(ev.data);
        try {
          const [, packet] = parseWsFrame(raw);
          if (packet.sid !== undefined) {
            ws.send(
              LarkClient.wrapFrame(
                LarkClient.packet({ cmd: 1, sid: packet.sid, payload: Uint8Array.of(0x08, 0x00) }),
              ),
            );
          }
          if (packet.cmd === PUSH_REACTIONS && onReaction && packet.payload) {
            for (const ev of decodePushReactions(packet.payload as Uint8Array))
              chain = chain.then(() =>
                onReaction(ev).catch((err) =>
                  logger.error(`表情回调异常: ${(err as Error).message}`),
                ),
              );
            return;
          }
          if (packet.cmd !== 6) return;
          for (const msg of decodePushMessages(raw)) {
            if (!msg.from_id) continue;
            chain = chain.then(() => this.dispatch(msg, onMessage));
          }
        } catch (err) {
          logger.debug(`跳过异常帧: ${(err as Error).message}`);
        }
      });
      ws.addEventListener('error', () => {
        // The actual reason comes in the following close event
      });
      ws.addEventListener('close', (ev) => {
        if (ev.code === 1000 || signal?.aborted) finish();
        else finish(new Error(`WS 连接关闭: code=${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`));
      });
    });
    await chain;
  }

  /**
   * Pushes and fetch-by-id results carry no chat mode; a topic group's root message can only be
   * assigned to its own thread after looking up chatMode.
   */
  private async fixThreadScope(msg: LarkMessage): Promise<LarkMessage> {
    if (msg.scope === 'chat' && msg.chat_type === 2 && (await this.isThreadChat(msg.chat_id)))
      [msg.scope, msg.anchor] = resolveScope(msg.msg_id, msg.msg_type, 2, '', '', true);
    return msg;
  }

  private async dispatch(msg: LarkMessage, onMessage: MessageHandler): Promise<void> {
    try {
      await onMessage(await this.fixThreadScope(msg));
    } catch (err) {
      logger.error(`消息回调异常: ${(err as Error).message}`);
    }
  }

  async gatewayPost(packet: Packet): Promise<Uint8Array> {
    const cmd = (packet as unknown as { cmd: number }).cmd;
    const res = await request(urls.gateway(this.auth.region), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        accept: '*/*',
        origin: webOrigin(this.auth.region),
        referer: `${webOrigin(this.auth.region)}/`,
        'user-agent': USER_AGENT,
        'x-appid': this.auth.gatewayAppId,
        'x-command': String(cmd),
        'x-command-version': '5.7.0',
        'x-lgw-os-type': '1',
        'x-lgw-terminal-type': '2',
        'x-source': 'web',
        'x-web-version': '3.9.32',
        'x-request-id': longRequestId(),
      },
      cookies: this.auth.cookies,
      body: toBinary(protoType('Packet'), packet),
    });
    if (!res.ok) throw new HttpError(res.status, res.statusText, res.url, await gatewayReason(res));
    return new Uint8Array(await res.arrayBuffer());
  }

  private async threadTarget(chatId: string, o: SendOptions) {
    return {
      chatId,
      rootId: o.rootId,
      replyTo: o.replyTo,
      threadChat: Boolean(o.rootId) && (await this.isThreadChat(chatId)),
      cid: o.cid || requestCid(),
    };
  }

  /** Interval between send retries (ms); the n-th retry waits n times this. */
  sendRetryDelayMs = 1000;

  /**
   * Send a message and confirm delivery, returning the message id assigned by the server; throws on
   * failure instead of returning null:
   * on network errors, 5xx, or a missing message id, retries o.retries times with the same cid (the
   * server deduplicates, so nothing is sent twice); if it still fails, throws NetworkError /
   * HttpError, or SendUnconfirmed (the server accepted it but no message id came back, so it may
   * have been sent; it carries the cid, which can be used to resend later).
   * For content see MessageContent: plain text (with links, `[text](url)` is rendered as a
   * hyperlink with text), structured rich text (text is the plain-text summary), HTML rich text,
   * image, file; images and files are uploaded before sending, and upload failures likewise throw
   * NetworkError / HttpError.
   */
  async sendMessage(chatId: string, content: MessageContent, o: SendOptions = {}): Promise<string> {
    const { pkt, cid } = await this.messagePacket(chatId, content, o);
    // The server deduplicates by message cid, so retrying the same packet sends nothing twice
    const retries = o.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postMessage(pkt, cid);
      } catch (err) {
        const retryable =
          err instanceof NetworkError ||
          err instanceof SendUnconfirmed ||
          (err instanceof HttpError && err.status >= 500);
        if (!retryable || attempt >= retries) throw err;
        logger.warning(`发送失败,重试(${attempt + 1}/${retries}): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, this.sendRetryDelayMs * (attempt + 1)));
      }
    }
  }

  /** Send packet (PutMessageRequest, cmd 5) and message cid; images and files are uploaded here. */
  private async messagePacket(
    chatId: string,
    content: MessageContent,
    o: SendOptions,
  ): Promise<{ pkt: Packet; cid: string }> {
    const target = await this.threadTarget(chatId, o);
    const requestId = longRequestId();
    let pkt: Packet;
    if ('image' in content)
      pkt = buildImageMessagePacket(
        await uploadImage(this.auth, content.image, content.name),
        target,
        requestId,
      );
    else if ('file' in content)
      pkt = buildFileMessagePacket(
        await uploadFile(this.auth, chatId, content.file, content.name),
        target,
        requestId,
      );
    else if ('video' in content) {
      const durationMs = content.durationMs ?? mp4DurationMs(content.video) ?? 0;
      const file = await uploadFile(this.auth, chatId, content.video, content.name);
      const cover = content.cover ? await uploadImage(this.auth, content.cover, 'cover.jpg') : '';
      pkt = buildVideoMessagePacket(file, durationMs, cover, target, requestId);
    } else if ('audio' in content) {
      const durationMs = content.durationMs ?? oggOpusDurationMs(content.audio);
      if (durationMs === null) throw new Error('语音消息要用 Ogg/Opus 文件(读不出时长)');
      const file = await uploadFile(this.auth, chatId, content.audio, 'voice.opus');
      // The server keeps whole seconds and truncates (1980 ms shows as 1 s), so round here
      const seconds = Math.max(1, Math.round(durationMs / 1000));
      pkt = buildAudioMessagePacket(file.key, seconds * 1000, target, requestId);
    } else if ('markdown' in content) {
      const parts = await this.markdownParts(content.markdown, content.imageDir);
      const attachments: string[] = [];
      for (const f of content.attachments ?? [])
        attachments.push((await uploadFile(this.auth, chatId, f.data, f.name)).key);
      pkt = buildMarkdownMessagePacket(parts, target, requestId, content.title ?? '', attachments);
    } else if ('blocks' in content)
      pkt = buildRichMessagePacket(content.blocks, content.text, target, requestId);
    else if ('html' in content)
      pkt = buildPostMessagePacket(content.html, target, requestId, content.title ?? '');
    else pkt = buildSendMessagePacket(content.text, target, requestId, content.links ?? false);
    return { pkt, cid: target.cid };
  }

  /**
   * Splits Markdown at its images and uploads them (see MessageContent): image keys are used as is,
   * URLs are downloaded, and relative paths are read under imageDir; other images stay as text.
   */
  private async markdownParts(markdown: string, imageDir?: string): Promise<MarkdownPart[]> {
    const parts: MarkdownPart[] = [];
    let pos = 0;
    for (const m of markdown.matchAll(MD_IMAGE_RE)) {
      const src = m[2] as string;
      let key: string | null = null;
      if (/^img_[\w-]+$/.test(src)) key = src;
      else if (/^https?:\/\//.test(src)) {
        const res = raiseForStatus(await request(src, { timeoutMs: 60_000 }));
        const data = new Uint8Array(await res.arrayBuffer());
        key = await uploadImage(this.auth, data, src.split(/[?#]/)[0]?.split('/').pop() || 'image');
      } else if (imageDir) {
        if (isAbsolute(src) || src.split(/[\\/]/).includes('..'))
          throw new Error(`Markdown 里的图片只能用相对路径: ${src}`);
        key = await uploadImage(this.auth, new Uint8Array(readFileSync(join(imageDir, src))), src);
      }
      if (key === null) continue;
      if (m.index > pos) parts.push({ md: markdown.slice(pos, m.index) });
      parts.push({ imageKey: key });
      pos = m.index + m[0].length;
    }
    if (pos < markdown.length || !parts.length) parts.push({ md: markdown.slice(pos) });
    return parts;
  }

  /**
   * Scheduled send: the server sends it at at (ms); returns the scheduled message id (which becomes
   * the message's id once sent). Content and reply options are the same as sendMessage.
   * A reply in a thread (o.rootId) goes under that thread.
   */
  async scheduleMessage(
    chatId: string,
    content: MessageContent,
    at: number,
    o: SendOptions = {},
  ): Promise<string> {
    const { pkt } = await this.messagePacket(chatId, content, o);
    const put = fromBinary(
      larkType('messages.PutMessageRequest'),
      (pkt as unknown as { payload: Uint8Array }).payload,
    );
    const resp = await this.call('messages.PutScheduleMessageRequest', {
      putRequest: put,
      scheduleTime: BigInt(Math.floor(at / 1000)),
      chatId,
      entityId: o.rootId || chatId,
    });
    const id = (resp.message as Dict | undefined)?.messageId;
    if (!id) throw new Error('定时发送失败: 响应里没有消息 id');
    return String(id);
  }

  /** Scheduled messages in a chat not yet sent (pending, paused), in ascending send-time order. */
  async scheduledMessages(chatId: string): Promise<ScheduledMessage[]> {
    const resp = await this.api('messages.PullChatScheduleMessagesRequest', {
      chatId,
      entityType: SCHEDULE_CHAT_ONLY,
      entityId: chatId,
      status: [SCHEDULE_PENDING, SCHEDULE_SUSPEND],
    });
    return ((resp.messages ?? []) as Dict[])
      .map((m) => ({
        messageId: String(m.messageId),
        at: int(m.scheduleTime, 0) * 1000,
        status:
          int(m.status, 0) === SCHEDULE_SUSPEND ? ('suspended' as const) : ('pending' as const),
        message: m.scheduleMessage
          ? toLarkMessage(m.scheduleMessage as Dict, { fallbackChatId: chatId })
          : null,
      }))
      .sort((a, b) => a.at - b.at);
  }

  /** Change the send time of a scheduled message (ms). */
  async rescheduleMessage(chatId: string, messageId: string, at: number): Promise<void> {
    await this.api('messages.PatchScheduleMessageRequest', {
      patchType: SCHEDULE_PATCH_UPDATE,
      messageId,
      chatId,
      scheduleTime: String(Math.floor(at / 1000)),
    });
  }

  /** Cancel a scheduled message (it will not be sent). */
  async cancelScheduledMessage(chatId: string, messageId: string): Promise<void> {
    await this.api('messages.PatchScheduleMessageRequest', {
      patchType: SCHEDULE_PATCH_DELETE,
      messageId,
      chatId,
    });
  }

  private async postMessage(pkt: Packet, cid: string): Promise<string> {
    const resp = await this.gatewayPost(pkt);
    let msgId: string;
    try {
      msgId = decodePutMessageResponse(resp);
    } catch (err) {
      throw new SendUnconfirmed(
        `服务端已接受发送请求,但响应解析失败,无法确认是否发出: ${(err as Error).message}`,
        cid,
      );
    }
    if (!msgId)
      throw new SendUnconfirmed('服务端已接受发送请求,但响应里没有消息 id,无法确认是否发出', cid);
    return msgId;
  }

  /**
   * Send a text message and return its message id; when the send cannot be confirmed, logs an error
   * and returns null. richLinks is the same as links of sendMessage.
   */
  async sendMsg(
    text: string,
    chatId: string,
    o: SendOptions = {},
    richLinks = false,
  ): Promise<string | null> {
    try {
      return await this.sendMessage(chatId, { text, links: richLinks }, o);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(err instanceof SendUnconfirmed ? msg : `发送消息失败: ${msg}`);
      return null;
    }
  }

  /**
   * Structured rich text (POST) message; innerText is the plain-text summary. Returns the message
   * id, or null on failure.
   */
  async sendRich(
    blocks: RichBlock[],
    innerText: string,
    chatId: string,
    o: SendOptions = {},
  ): Promise<string | null> {
    try {
      return await this.sendMessage(chatId, { blocks, text: innerText }, o);
    } catch (err) {
      logger.error(`发送富文本失败: ${(err as Error).message}`);
      return null;
    }
  }

  /** Rich text (POST) message from an HTML fragment. Returns the message id, or null on failure. */
  async sendPost(
    html: string,
    chatId: string,
    title = '',
    o: SendOptions = {},
  ): Promise<string | null> {
    try {
      return await this.sendMessage(chatId, { html, title }, o);
    } catch (err) {
      logger.error(`发送富文本失败: ${(err as Error).message}`);
      return null;
    }
  }

  async search(query: string): Promise<SearchHit[]> {
    const pkt = buildSearchPacket(query, longRequestId(), this.auth.region.locale);
    return decodeSearchResponse(await this.gatewayPost(pkt));
  }

  /**
   * Search messages across chats (like "Messages" in the client's search box), ordered by the
   * server's relevance; can filter by chat, sender and time.
   * Server search has indexing lag, so a message just sent may take a while to become searchable.
   */
  async searchMessages(query: string, o: MessageSearchOptions = {}): Promise<MessageHit[]> {
    const filter: Dict = {};
    if (o.chatIds?.length) filter.chatIds = o.chatIds;
    if (o.fromIds?.length) filter.creatorIds = o.fromIds;
    if (o.since !== undefined || o.until !== undefined)
      filter.timeRange = {
        ...(o.since !== undefined ? { startTime: String(Math.floor(o.since / 1000)) } : {}),
        ...(o.until !== undefined ? { endTime: String(Math.floor(o.until / 1000)) } : {}),
      };
    if (o.atIds?.length) filter.includeAtUserIds = o.atIds;
    if (o.attachmentTypes?.length)
      filter.includeAttachmentTypes = o.attachmentTypes.map((t) => ATTACHMENT_TYPES[t]);
    if (o.chatType) filter.chatType = o.chatType === 'group' ? 1 : 2;
    if (o.senderTypes?.length) filter.fromTypes = o.senderTypes.map((t) => SENDER_TYPES[t]);
    if (o.excludeSenderTypes?.length)
      filter.excludedFromTypes = o.excludeSenderTypes.map((t) => SENDER_TYPES[t]);
    return this.universalSearch(
      SEARCH_ENTITY_MESSAGE,
      'MESSAGE',
      query,
      { messageFilter: filter },
      o.limit ?? 20,
      (r, meta) => {
        const m = (meta.messageMeta ?? {}) as Dict;
        if (!m.id) return null;
        return {
          msgId: String(m.id),
          chatId: String(m.chatId ?? ''),
          chatTitle: unhighlight(r.titleHighlighted),
          fromId: String(m.fromId ?? ''),
          createTime: Number(m.createTime ?? 0),
          position: m.position === undefined ? null : Number(m.position),
          msgType: enumToInt(m.type ?? 0),
          p2p: m.isP2pChat === true,
          summary: unhighlight(r.summaryHighlighted),
        };
      },
    );
  }

  /**
   * Search people (like "Contacts" in the client's search box), ordered by relevance; an empty
   * query lists people matching the filters.
   */
  async searchUsers(query: string, o: UserSearchOptions = {}): Promise<UserHit[]> {
    const filter: Dict = {};
    if (o.chatted) filter.haveChatter = true;
    if (o.excludeExternal) filter.excludeOuterContact = true;
    if (o.resigned) filter.isResigned = true;
    if (o.enterpriseEmail) filter.existsEnterpriseEmail = true;
    if (o.userIds?.length) filter.inUserIds = o.userIds;
    return this.universalSearch(
      SEARCH_ENTITY_USER,
      'USER',
      query,
      { userFilter: filter },
      o.limit ?? 20,
      (r, meta) => {
        const m = (meta.userMeta ?? {}) as Dict;
        if (!m.id) return null;
        return {
          userId: String(m.id),
          name: unhighlight(r.titleHighlighted),
          description: unhighlight(r.summaryHighlighted),
          chatId: String(m.chatId ?? ''),
          email: String(m.enterpriseMailAddress || m.mailAddress || ''),
          crossTenant: m.isCrossTenant === true,
        };
      },
    );
  }

  /** Search bots and AI agents visible to me, ordered by relevance. */
  async searchBots(query: string, o: BotSearchOptions = {}): Promise<BotHit[]> {
    const filter: Dict = {};
    if (o.chatIds?.length) filter.chatIds = o.chatIds;
    if (o.chatted) filter.haveChatter = true;
    return this.universalSearch(
      SEARCH_ENTITY_BOT,
      'BOT',
      query,
      { botFilter: filter },
      o.limit ?? 20,
      (r, meta) => {
        const m = (meta.botMeta ?? {}) as Dict;
        if (!m.id) return null;
        return {
          botId: String(m.id),
          name: unhighlight(r.titleHighlighted),
          description: unhighlight(r.summaryHighlighted),
          chatId: String(m.chatId ?? ''),
          agent: m.isAgent === true,
        };
      },
    );
  }

  /**
   * Search group chats I can see by name (the server also matches member names), optionally only
   * groups with certain members; an empty query lists groups matching the filters.
   */
  async searchChats(query: string, o: ChatSearchOptions = {}): Promise<ChatHit[]> {
    const filter: Dict = {};
    if (o.memberIds?.length) filter.chatMemberIds = o.memberIds;
    if (o.sort) filter.sortType = GROUP_SORT[o.sort];
    // The server has no mode filter: skipping other modes while picking keeps paging until enough
    return this.universalSearch(
      SEARCH_ENTITY_GROUP,
      'GROUP_CHAT',
      query,
      { groupChatFilter: filter },
      o.limit ?? 20,
      (r, meta): ChatHit | null => {
        const m = (meta.groupChatMeta ?? {}) as Dict;
        const mode = TOPIC_MODES.has(enumToInt(m.mode ?? 0)) ? 'topic' : 'group';
        if (!m.id || (o.mode && mode !== o.mode)) return null;
        return {
          chatId: String(m.id),
          name: unhighlight(r.titleHighlighted),
          description: String(m.description ?? ''),
          mode,
          memberCount: Number(m.userCount ?? 0),
          member: m.isMember === true,
          public: m.isPublicV2 === true,
          crossTenant: m.isCrossTenant === true,
          lastMessageTime: Number(m.lastMessageTime ?? 0),
        };
      },
    );
  }

  /**
   * One kind of entity from the client's universal search, paging within one search session until
   * limit results or no more; pick maps a result (and its resultMeta) to the caller's shape, null
   * to skip it.
   */
  private async universalSearch<T>(
    entity: number,
    tagName: string,
    query: string,
    filter: Dict,
    limit: number,
    pick: (result: Dict, meta: Dict) => T | null,
  ): Promise<T[]> {
    const session = requestCid();
    const out: T[] = [];
    let token = '';
    for (let seq = 1; out.length < limit; seq++) {
      const resp = await this.api('usearch.UniversalSearchRequest', {
        header: {
          searchSession: session,
          sessionSeqId: seq,
          query,
          ...(token ? { paginationToken: token } : {}),
          searchContext: {
            tagName,
            entityItems: [{ type: entity, filter }],
            commonFilter: { includeOuterTenant: true },
            sourceKey: 'messenger',
          },
          locale: this.auth.region.locale,
          pageSize: Math.min(limit - out.length, 50),
          extraParam: {},
        },
      });
      for (const r of (resp.results ?? []) as Dict[]) {
        if (r.type !== entity) continue;
        const hit = pick(r, (r.resultMeta ?? {}) as Dict);
        if (hit !== null) out.push(hit);
      }
      const header = (resp.header ?? {}) as Dict;
      token = String(header.paginationToken ?? '');
      if (!header.hasMore || !token || !(resp.results as unknown[] | undefined)?.length) break;
    }
    return out.slice(0, limit);
  }

  /**
   * A user's profile card (as the client shows it): name plus the visible fields that have a value,
   * such as department, email and status. Fields depend on the tenant's settings and on what the
   * user may see.
   */
  async userProfile(userId: string): Promise<UserProfile> {
    const resp = await this.api('users.PullUserProfileV2Request', {
      scene: PROFILE_BY_USER_ID,
      userId,
      source: PROFILE_FROM_CHAT,
    });
    const profile = resp.profile as Dict | undefined;
    if (!profile) throw new Error(`查不到用户资料: ${userId}`);
    const locale = this.auth.region.locale;
    const fields: ProfileField[] = [];
    for (const f of (profile.fields ?? []) as Dict[]) {
      if (f.visible === false || !f.strFieldVal) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(f.strFieldVal));
      } catch {
        parsed = String(f.strFieldVal);
      }
      const value = profileText(parsed, locale);
      if (value)
        fields.push({
          key: String(f.key ?? ''),
          label: localized((f.i18nNames ?? {}) as Dict, locale) || String(f.key ?? ''),
          value,
        });
    }
    const name = (await this.userNames([userId])).get(userId) ?? '';
    return { userId, name, fields };
  }

  /**
   * Chats in my chat list (direct and group chats), most recently active first; o.types narrows the
   * kinds, o.excludeMuted drops chats with notifications off.
   */
  async chatList(
    o: {
      types?: ChatSummary['type'][] | undefined;
      excludeMuted?: boolean | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<ChatSummary[]> {
    const limit = o.limit ?? 50;
    const recent = await this.recentChats(0, Math.ceil(limit / 50) + 2);
    const missing = recent.filter((rc) => !rc.chat).map((rc) => rc.chatId);
    const fetched = missing.length
      ? (((await this.api('chats.PullChatsByIdsRequest', { chatIds: missing })).chats ??
          {}) as Record<string, Dict>)
      : {};
    const out: ChatSummary[] = [];
    for (const rc of recent) {
      const chat = rc.chat ?? fetched[rc.chatId];
      if (!chat) continue;
      const item: ChatSummary = {
        chatId: rc.chatId,
        name: String(chat.name ?? ''),
        type: chatKind(chat),
        peerId: '',
        muted: chat.isRemind === false,
        memberCount: Number(chat.userCount ?? chat.memberCount ?? 0),
        unread: int(chat.newMessageCount, 0),
        updatedAt: rc.updatedAt,
      };
      if (o.types?.length && !o.types.includes(item.type)) continue;
      if (o.excludeMuted && item.muted) continue;
      out.push(item);
      if (out.length >= limit) break;
    }
    // Direct chats carry no name or peer; one member lookup each fills them in
    for (const item of out) {
      if (item.type !== 'p2p') continue;
      const members = await this.chatMembers(item.chatId, 2);
      const peer = members.find((m) => m.id !== this.auth.userId) ?? members[0];
      if (!peer) continue;
      item.peerId = peer.id;
      item.name ||= peer.name;
    }
    return out;
  }

  /** Details of a chat; null when it does not exist or is not visible. */
  async chatInfo(chatId: string): Promise<ChatInfo | null> {
    const chat = await this.getChatInfo(chatId);
    if (!chat) return null;
    const ownerId = String(chat.ownerId ?? '');
    return {
      chatId,
      name: String(chat.name ?? ''),
      type: chatKind(chat),
      description: String(chat.description ?? ''),
      ownerId,
      memberCount: Number(chat.userCount ?? chat.memberCount ?? 0),
      createTime: int(chat.createTime, 0),
      admin: chat.isAdmin === true || (ownerId !== '' && ownerId === this.auth.userId),
      owner: ownerId !== '' && ownerId === this.auth.userId,
      muted: chat.isRemind === false,
      muteAtAll: (chat.userSetting as Dict | undefined)?.isMuteAtAll === true,
      public: chat.isPublicV2 === true || chat.isPublic === true,
      crossTenant: chat.isCrossTenant === true,
      postType: POST_TYPES[enumToInt(chat.postType ?? 0) as 1 | 2 | 3] ?? 'unknown',
    };
  }

  /**
   * The direct chat with a user (created on the server if it does not exist yet); throws when the
   * server returns no chat, e.g. for a user I may not message.
   */
  async directChat(userId: string): Promise<string> {
    const id = await this.createChat(userId);
    if (!id) throw new Error(`拿不到与 ${userId} 的私聊`);
    return id;
  }

  async createChat(userId: string): Promise<string | null> {
    return decodePutChatResponse(
      await this.gatewayPost(buildCreateChatPacket(userId, longRequestId())),
    );
  }

  /**
   * Official "message link" (the same applink as the client's "Copy message link"): for a single
   * message, opening it jumps to that message;
   * for several, it is one combined link that the client shows as a "From group chat" message
   * preview of all of them. Messages inside a thread likewise use the chat as their source.
   */
  async messageLink(chatId: string, messageIds: string[]): Promise<string | null> {
    const resp = await this.api('messages.PutMessageLinkRequest', {
      fromId: chatId,
      from: 1,
      copiedId: messageIds,
    });
    return (resp.tokenUrl as string | undefined) || null;
  }

  /**
   * The current account's self chat (Lark allows messaging yourself); the server creates it if it
   * does not exist.
   */
  selfChat(): Promise<string | null> {
    return this.createChat(this.auth.userId);
  }

  async getUserName(userId: string, chatId: string): Promise<string | null> {
    try {
      const content = await this.gatewayPost(buildUserInfoPacket(userId, chatId, longRequestId()));
      return decodeUserInfoResponse(content, this.auth.region.locale);
    } catch {
      return null;
    }
  }

  async getGroupName(chatId: string): Promise<string | null> {
    try {
      return decodeGroupInfoResponse(
        await this.gatewayPost(buildGroupInfoPacket(chatId, longRequestId())),
      );
    } catch {
      return null;
    }
  }

  /**
   * Look up display names of users (or bots) in bulk, returning id → name; ids not found are left
   * out. Results are cached in-process, so each id is looked up only once.
   */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter(Boolean))];
    const missing = want.filter((id) => !this.chatterNames.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const resp = await this.api('chatters.PullChattersByIdsRequest', {
        chatterIds: missing.slice(i, i + 100),
      });
      for (const [id, v] of Object.entries((resp.chatters ?? {}) as Record<string, Dict>))
        this.chatterNames.set(id, chatterName(v, this.auth.region.locale));
    }
    const out = new Map<string, string>();
    for (const id of want) {
      const name = this.chatterNames.get(id);
      if (name !== undefined) out.set(id, name);
    }
    return out;
  }

  /**
   * Chat members (including bots), at most max of them; paging parameters (cursor / offset /
   * orderCursor) are passed back as is until the server stops returning them.
   */
  async chatMembers(chatId: string, max = 5000): Promise<ChatMember[]> {
    const members = new Map<string, ChatMember>();
    let page: Dict = {};
    for (;;) {
      const resp = await this.api('chats.PullChatChattersRequest', { chatId, limit: 100, ...page });
      const before = members.size;
      // Group nicknames come in metas, keyed by member id
      const metas = (resp.metas ?? {}) as Record<string, Dict>;
      for (const field of ['chatters', 'updateChatters'])
        for (const [id, v] of Object.entries((resp[field] ?? {}) as Record<string, Dict>)) {
          const m = toMember(id, v, this.auth.region.locale);
          m.nickname = String(metas[id]?.groupNickname ?? '');
          members.set(id, m);
          this.chatterNames.set(id, m.name);
        }
      const next: Dict = {};
      if (resp.nextCursor) next.cursor = resp.nextCursor;
      if (resp.nextOffset) next.offset = resp.nextOffset;
      if (resp.nextOrderCursor) next.orderCursor = resp.nextOrderCursor;
      if (!Object.keys(next).length || members.size === before || members.size >= max) break;
      page = next;
    }
    return [...members.values()].slice(0, max);
  }

  /**
   * Create a group chat and add people (memberIds may be empty, i.e. just yourself); returns the
   * new group's chat_id. With topic true, creates a topic group.
   * The group is visible to its members and the added people are notified; resending with the same
   * cid does not create two groups.
   */
  async createGroup(
    name: string,
    memberIds: string[] = [],
    o: { description?: string; topic?: boolean; cid?: string } = {},
  ): Promise<string> {
    const resp = await this.api('chats.PutChatRequest', {
      type: 2,
      groupName: name,
      ...(o.description ? { groupDesc: o.description } : {}),
      chatterIds: memberIds,
      ...(o.topic ? { chatMode: CHAT_MODE_THREAD_V2 } : {}),
      cid: o.cid || requestCid(),
    });
    const id = String((resp.chat as Dict | undefined)?.id ?? '');
    if (!id) throw new Error('建群失败: 响应里没有会话 id');
    return id;
  }

  /** Add people to a group chat (requires permission to add members). */
  async addMembers(chatId: string, userIds: string[]): Promise<void> {
    await this.api('chats.PutChatChatterRequest', { chatId, chatterIds: userIds });
  }

  /** Remove people from a group chat (requires being the owner or an admin). */
  async removeMembers(chatId: string, userIds: string[]): Promise<void> {
    await this.api('chats.DeleteChatChatterRequest', { chatId, chatterIds: userIds });
  }

  /** Change the group name / description (whichever is given). */
  async updateGroup(chatId: string, o: { name?: string; description?: string }): Promise<void> {
    const fields: number[] = [];
    if (o.name !== undefined) fields.push(GROUP_FIELD_NAME);
    if (o.description !== undefined) fields.push(GROUP_FIELD_DESCRIPTION);
    if (!fields.length) return;
    await this.api('chats.PatchGroupChatRequest', {
      chatId,
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.description !== undefined ? { description: o.description } : {}),
      updateFields: fields,
    });
  }

  /**
   * Turn notifications for chats off (muted = true) or back on; with atAll, @all messages are
   * muted / unmuted as well. Only affects me.
   */
  async setMuted(chatIds: string[], muted: boolean, o: { atAll?: boolean } = {}): Promise<void> {
    for (const chatId of chatIds)
      await this.api('chats.PatchChatSettingRequest', {
        chatId,
        chatSetting: { isRemind: !muted, ...(o.atAll ? { isMuteAtAll: muted } : {}) },
        updateChatSettingField: o.atAll
          ? [SETTING_IS_REMIND, SETTING_MUTE_AT_ALL]
          : [SETTING_IS_REMIND],
      });
  }

  /** Set my nickname in a group (members see it instead of my name); an empty string clears it. */
  async setGroupNickname(chatId: string, nickname: string): Promise<void> {
    await this.api('chatters.PutGroupNicknameRequest', { chatId, nickname });
  }

  /** Group admins (user ids, in the order the client lists them); the owner is not included. */
  async chatAdmins(chatId: string): Promise<string[]> {
    const resp = await this.api('chats.PullChatAdminUsersRequest', { chatId });
    return ((resp.adminUsers ?? []) as Dict[])
      .sort((a, b) => int(a.orderWeight, 0) - int(b.orderWeight, 0))
      .map((u) => String(u.userId));
  }

  /** Add and remove group admins (owner only). */
  async updateAdmins(chatId: string, add: string[], remove: string[] = []): Promise<void> {
    await this.api('chats.PatchChatAdminUsersRequest', {
      chatId,
      toAddUserIds: add,
      toDelUserIds: remove,
    });
  }

  /**
   * Who may post in a group (owner or admin only); with 'whitelist', add / remove adjust the members
   * allowed to post.
   */
  async setPostPermission(
    chatId: string,
    type: PostType,
    o: { add?: string[]; remove?: string[] } = {},
  ): Promise<void> {
    await this.api('chats.PatchChatPostUserRequest', {
      chatId,
      postType: POST_TYPE_VALUES[type],
      toAddUserIds: o.add ?? [],
      toDelUserIds: o.remove ?? [],
    });
  }

  /** Requests to join a group, newest first (owner or admin only); at most max. */
  async joinRequests(chatId: string, max = 200): Promise<JoinRequest[]> {
    const out: JoinRequest[] = [];
    let cursor = '0';
    while (out.length < max) {
      const resp = await this.api('chats.PullAddChatChatterApplyRequest', { chatId, cursor });
      const applies = (resp.applies ?? []) as Dict[];
      for (const x of applies)
        out.push({
          userId: String(x.inviteeId ?? ''),
          inviterId: String(x.inviterId ?? ''),
          reason: String(x.reason ?? ''),
          status: APPLY_STATUS[enumToInt(x.status ?? 0) as 1 | 2 | 3] ?? 'unknown',
          time: int(x.time, 0),
          via: APPLY_WAYS[enumToInt(x.applyWays ?? 0)] ?? String(enumToInt(x.applyWays ?? 0)),
        });
      const next = String(resp.nextCursor ?? '');
      if (!applies.length || !next || next === cursor) break;
      cursor = next;
    }
    return out.sort((a, b) => b.time - a.time).slice(0, max);
  }

  /** Approve or reject someone's request to join a group (owner or admin only). */
  async handleJoinRequest(chatId: string, userId: string, approve: boolean): Promise<void> {
    await this.api('chats.PatchAddChatChatterApplyRequest', {
      chatId,
      inviteeId: userId,
      status: approve ? APPLY_APPROVED : APPLY_REFUSED,
    });
  }

  /**
   * A link others can open to join the group: valid for days (the client offers 7, 30 and 365) or
   * forever; expireTime is in seconds, 0 for a link that never expires.
   */
  async chatShareLink(
    chatId: string,
    o: { days?: number; forever?: boolean } = {},
  ): Promise<{ url: string; expireTime: number }> {
    const resp = await this.api('chats.PullChatLinkTokenRequest', {
      chatId,
      expiredDay: o.days ?? 7,
      isUnlimited: o.forever === true,
    });
    const url = String(resp.sharedUrl ?? '');
    if (!url) throw new Error('拿不到群分享链接: 响应里没有链接');
    return { url, expireTime: resp.isUnlimited ? 0 : int(resp.expireTime, 0) };
  }

  /** Create a feed tag, optionally with chats in it; returns the tag id. Only affects me. */
  async createFeedGroup(name: string, chatIds: string[] = []): Promise<string> {
    const resp = await this.api('feed.CreateFeedGroupRequest', {
      feedGroup: { name, type: FEED_GROUP_NORMAL },
      feedGroupItems: chatIds.map((id) => ({ feedCardId: id, feedCardType: CARD_CHAT })),
    });
    const id = (resp.feedGroup as Dict | undefined)?.id;
    if (id === undefined) throw new Error('建标签失败: 响应里没有标签 id');
    return String(id);
  }

  async renameFeedGroup(groupId: string, name: string): Promise<void> {
    await this.api('feed.UpdateFeedGroupsRequest', {
      feedGroups: [{ id: groupId, name, type: FEED_GROUP_NORMAL }],
      feedGroupsUpdateFields: { [groupId]: { fields: [FEED_GROUP_FIELD_BASE] } },
    });
  }

  /** Delete a feed tag; the chats in it stay in the chat list. */
  async deleteFeedGroup(groupId: string): Promise<void> {
    await this.api('feed.UpdateFeedGroupsRequest', { deletedGroups: [{ id: groupId }] });
  }

  async addToFeedGroup(groupId: string, chatIds: string[]): Promise<void> {
    await this.api('feed.UpdateFeedGroupsRequest', {
      feedGroupItems: chatIds.map((id) => ({ feedCardId: id, feedCardType: CARD_CHAT, groupId })),
    });
  }

  async removeFromFeedGroup(groupId: string, chatIds: string[]): Promise<void> {
    await this.api('feed.UpdateFeedGroupsRequest', {
      deletedFeedGroupItems: chatIds.map((id) => ({
        feedCardId: id,
        feedCardType: CARD_CHAT,
        groupId,
      })),
    });
  }

  /** Pin a message to the chat (visible to all chat members); returns the pin id. */
  async pinMessage(chatId: string, messageId: string): Promise<string> {
    const resp = await this.api('pin.PutPinRequest', { chatId, messageId });
    const id = (resp.pin as Dict | undefined)?.id;
    if (id === undefined) throw new Error('Pin 失败: 响应里没有 pin id');
    return String(id);
  }

  /** Unpin; returns false when the message was not pinned. */
  async unpinMessage(chatId: string, messageId: string): Promise<boolean> {
    const resp = await this.api('pin.PullPinsByMessageIDsRequest', { messageIds: [messageId] });
    const pin = Object.values((resp.pins ?? {}) as Record<string, Dict>).find(
      (p) => String(p.messageId) === messageId && !int(p.deletedTime, 0),
    );
    if (!pin) return false;
    await this.api('pin.DeletePinRequest', { id: String(pin.id), chatId });
    return true;
  }

  /**
   * Pinned messages in the chat (at most max), including the messages themselves, newest pin time
   * first.
   */
  async chatPins(chatId: string, max = 100): Promise<PinnedMessage[]> {
    const out: PinnedMessage[] = [];
    let cursor: bigint | undefined;
    while (out.length < max) {
      const resp = await this.api('pin.PullChatPinsRequest', {
        chatId,
        count: Math.min(50, max - out.length),
        withMessages: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const msgs = (resp.pinedMessages ?? {}) as Record<string, Dict>;
      for (const p of (resp.pins ?? []) as Dict[]) {
        const v = msgs[String(p.messageId)];
        out.push({
          pinId: String(p.id),
          messageId: String(p.messageId),
          pinnedBy: String(p.chatterId ?? ''),
          pinnedAt: int(p.createTime, 0),
          message: v
            ? toLarkMessage(v, { selfId: this.auth.userId, fallbackChatId: chatId })
            : null,
        });
      }
      const next = resp.nextCursor as bigint | undefined;
      if (!resp.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return out.sort((a, b) => b.pinnedAt - a.pinnedAt).slice(0, max);
  }

  /** My feed tags (feed groups), ordered by tag position. */
  async feedGroups(): Promise<FeedGroup[]> {
    const groups: Dict[] = [];
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const resp = await this.api('feed.PullFeedGroupsRequest', {
        count: String(FEED_GROUP_PAGE),
        ...(cursor ? { cursor } : {}),
      });
      groups.push(...((resp.feedGroups ?? []) as Dict[]));
      const next = String(resp.nextCursor ?? '');
      if (!resp.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return groups
      .sort((a, b) => int(a.pos, 0) - int(b.pos, 0))
      .map((g) => ({
        id: String(g.id),
        name: String(g.name ?? ''),
        type: ({ 1: 'normal', 2: 'keyword' } as const)[int(g.type, 0) as 1 | 2] ?? 'unknown',
      }));
  }

  /** Chats (chat_id) in a feed tag. */
  async feedGroupChats(groupId: string): Promise<string[]> {
    const out = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const resp = await this.api('feed.PullFeedGroupItemsRequest', {
        args: { [groupId]: { count: String(FEED_GROUP_PAGE), ...(cursor ? { cursor } : {}) } },
      });
      const data = ((resp.data ?? {}) as Record<string, Dict>)[groupId] ?? {};
      for (const it of (data.feedGroupItems ?? []) as Dict[])
        if (int(it.feedCardType, 0) === CARD_CHAT && !it.exclude) out.add(String(it.feedCardId));
      const next = String(data.nextCursor ?? '');
      if (!data.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return [...out];
  }

  /** Chats (chat_id) pinned as feed shortcuts in the chat list, in shortcut order. */
  async shortcuts(): Promise<string[]> {
    const resp = await this.api('feed.PullShortcutsRequest', { position: 0, count: 200 });
    return ((resp.shortcuts ?? []) as Dict[])
      .filter((x) => int(x.type, 0) === SHORTCUT_CHAT)
      .sort((a, b) => int(a.position, 0) - int(b.position, 0))
      .map((x) => String(x.id));
  }

  /**
   * Pin these chats as feed shortcuts in the chat list (after the existing ones). Only affects my
   * own chat list.
   */
  async addShortcuts(chatIds: string[]): Promise<void> {
    await this.api('feed.PutShortcutsRequest', {
      shortcuts: chatIds.map((id, i) => ({ id, type: SHORTCUT_CHAT, position: i })),
    });
  }

  /** Remove feed shortcuts. */
  async removeShortcuts(chatIds: string[]): Promise<void> {
    await this.api('feed.DeleteShortcutsRequest', {
      shortcuts: chatIds.map((id) => ({ id, type: SHORTCUT_CHAT })),
    });
  }

  /**
   * Flag / unflag messages (like the client's "Flag", to handle later; visible only to
   * yourself).
   */
  async flagMessages(messageIds: string[], remove = false): Promise<void> {
    const items = messageIds.map((id) => ({ itemId: id, flagType: FLAG_MESSAGE }));
    await this.api('feed.UpdateFlagsRequest', remove ? { deletedItems: items } : { items });
  }

  /** Flag / unflag chats. */
  async flagChats(chatIds: string[], remove = false): Promise<void> {
    const items = chatIds.map((id) => ({ itemId: id, itemType: CARD_CHAT, flagType: FLAG_FEED }));
    await this.api('feed.UpdateFlagsRequest', remove ? { deletedItems: items } : { items });
  }

  /** My flag list (at most max), newest flag time first. */
  async flags(max = 200): Promise<FlagItem[]> {
    const out: FlagItem[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const resp = await this.api('feed.PullFlagsRequest', {
        count: String(Math.min(50, max - out.length)),
        ...(cursor ? { cursor } : {}),
      });
      const msgs = (resp.messages ?? {}) as Record<string, Dict>;
      for (const f of (resp.items ?? []) as Dict[]) {
        const id = String(f.itemId);
        const isMsg = int(f.flagType, 0) === FLAG_MESSAGE;
        const v = isMsg ? msgs[id] : undefined;
        out.push({
          type: isMsg ? 'message' : 'chat',
          id,
          createTime: int(f.createTime, 0),
          message: v ? toLarkMessage(v, { selfId: this.auth.userId }) : null,
        });
      }
      const next = String(resp.nextCursor ?? '');
      if (!resp.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return out.sort((a, b) => b.createTime - a.createTime).slice(0, max);
  }

  /**
   * Forward a message to these chats (forwarded as is; recipients see "Forwarded from"), returning
   * chat id → new message id; chats where forwarding failed are left out.
   * Each target carries a message cid that the server deduplicates by, so retries within the same
   * call send nothing twice.
   */
  async forwardMessage(messageId: string, chatIds: string[]): Promise<Map<string, string>> {
    const resp = await this.api('messages.PutTransmitMessageRequest', {
      chatIds,
      messageId,
      cids: Object.fromEntries(chatIds.map((id) => [id, requestCid()])),
    });
    const out = new Map<string, string>();
    for (const [chatId, m] of Object.entries((resp.messages ?? {}) as Record<string, Dict>))
      if (m.id) out.set(chatId, String(m.id));
    return out;
  }

  /**
   * Forward a whole thread (its root message and replies) to these chats; recipients see it as one
   * thread card. Returns chat id → new message id; chats where forwarding failed are left out.
   */
  async forwardThread(rootId: string, chatIds: string[]): Promise<Map<string, string>> {
    const [root] = await this.getMessages([rootId]);
    if (!root) throw new Error(`找不到话题根消息: ${rootId}`);
    const resp = await this.api('thread.PutThreadShareRequest', {
      channelId: root.chat_id,
      threadId: rootId,
      targets: chatIds.map((chatId) => ({ toChat: { chatId } })),
    });
    const out = new Map<string, string>();
    for (const [chatId, m] of Object.entries((resp.messages ?? {}) as Record<string, Dict>))
      if (m.id) out.set(chatId, String(m.id));
    return out;
  }

  /**
   * Translate text (same as the client's "Translate"), returning translations in order.
   * targetLanguage is e.g. zh, en, ja; leave sourceLanguage empty to auto-detect.
   * Does not change the display state of any message.
   */
  async translateText(
    texts: string[],
    targetLanguage: string,
    sourceLanguage = '',
  ): Promise<string[]> {
    if (!texts.length) return [];
    const resp = await this.api('translate.TranslateWebXMLRequest', {
      srcContents: texts,
      srcLanguage: sourceLanguage,
      trgLanguage: targetLanguage,
      contentType: TRANSLATE_TEXT,
    });
    const out = ((resp.trgContents ?? []) as string[]).map(String);
    if (out.length !== texts.length)
      throw new Error(`翻译结果条数不符: ${out.length}/${texts.length}`);
    return out;
  }

  /**
   * Translate messages (using the plain-text summary of their content), returning original and
   * translated text; messages that don't exist or have no text content are skipped.
   */
  async translateMessages(
    messageIds: string[],
    targetLanguage: string,
  ): Promise<{ msgId: string; original: string; translated: string }[]> {
    const msgs = (await this.getMessages(messageIds)).filter((m) => m.content.trim());
    const translated = await this.translateText(
      msgs.map((m) => m.content),
      targetLanguage,
    );
    return msgs.map((m, i) => ({
      msgId: m.msg_id,
      original: m.content,
      translated: translated[i] ?? '',
    }));
  }

  /**
   * Recall a message (your own; group admins can also recall others' messages in the group). Throws
   * when the server does not confirm.
   */
  async recallMessage(msgId: string): Promise<void> {
    const resp = await this.api('messages.DeleteMessageRequest', { id: msgId });
    if (resp.message !== 'ok')
      throw new Error(`撤回失败: ${String(resp.message ?? '服务端没有确认')}`);
  }

  /**
   * Edit a text or rich text message you sent, replacing its whole content; others see "Edited".
   * A plain-text message can only become plain text (content uses text); rich text messages use
   * blocks or markdown. The server rejects edits past the editable time limit and the like
   * (HttpError.reason gives the cause).
   */
  async editMessage(msgId: string, content: EditableContent): Promise<void> {
    const { type, richText } = richTextOf(content);
    await this.call('messages.EditMessageRequest', {
      msgId: BigInt(msgId),
      cid: requestCid(),
      type,
      content: { richText },
    });
  }

  /**
   * Add a reaction to a message; reactionType is e.g. THUMBSUP, OK, DONE, SMILE (same as the keys
   * of the client's reaction panel).
   */
  async addReaction(msgId: string, reactionType: string): Promise<void> {
    await this.api('reactions.PutReactionRequest', { messageId: msgId, reactionType });
  }

  /** Remove a reaction you added. */
  async removeReaction(msgId: string, reactionType: string): Promise<void> {
    await this.api('reactions.DeleteReactionRequest', { messageId: msgId, reactionType });
  }

  /** Reactions on a message: the count and the people who added each reaction. */
  async reactions(messageIds: string[]): Promise<MessageReactions[]> {
    const resp = await this.api('reactions.PullReactionsRequest', { messageIds, fetchUsers: true });
    return ((resp.messageReactions ?? []) as Dict[]).map((mr) => ({
      messageId: String(mr.messageId),
      // After a reaction is fully removed the server still returns a count=0 record; ignore it
      reactions: ((mr.reactions ?? []) as Dict[])
        .filter((r) => Number(r.count ?? 0) > 0)
        .map((r) => ({
          type: String(r.type),
          count: Number(r.count ?? 0),
          userIds: [
            ...new Set([
              ...((r.userIds as string[] | undefined) ?? []),
              ...Object.keys((r.nanoUpdateTimes ?? r.udpateTimes ?? {}) as Dict),
            ]),
          ],
        })),
    }));
  }

  /**
   * Read status of messages (who has read, who hasn't); the messages must be in chat chatId;
   * messages not found are left out.
   */
  async readStates(chatId: string, messageIds: string[]): Promise<ReadState[]> {
    const resp = await this.api('messages.PullMessageReadStateRequest', {
      pairs: messageIds.map((messageId) => ({ chatId, messageId })),
    });
    const states = (resp.readStates ?? {}) as Record<string, Dict>;
    return messageIds
      .filter((id) => states[id])
      .map((id) => {
        const r = states[id] as Dict;
        const last = r.lastUserReadInfo as Dict | undefined;
        return {
          messageId: id,
          readCount: Number(r.readCount ?? 0),
          unreadCount: Number(r.unreadCount ?? 0),
          readUserIds: ((r.readUserIds as string[] | undefined) ?? []).map(String),
          unreadUserIds: ((r.unreadUserIds as string[] | undefined) ?? []).map(String),
          lastRead: last?.userId
            ? { userId: String(last.userId), time: Number(last.readTime ?? 0) }
            : null,
        };
      });
  }

  /** Whether I have read these messages: id → read time (s), null if unread. */
  async myReadStates(messageIds: string[]): Promise<Map<string, number | null>> {
    const resp = await this.api('messages.PullMessageMeReadStateRequest', {
      messageIds,
      needReadTime: true,
    });
    const status = (resp.readStatus ?? {}) as Record<string, boolean>;
    const times = (resp.readTimes ?? {}) as Record<string, bigint | number>;
    const out = new Map<string, number | null>();
    for (const id of messageIds)
      if (id in status) out.set(id, status[id] ? Number(times[id] ?? 0) : null);
    return out;
  }

  /** Mark a message as read on arrival (listen's LARKX_MARK_READ); failures only log at debug. */
  async markRead(chatId: string, maxPosition: number, messageIds?: string[]): Promise<boolean> {
    try {
      await this.api('messages.PutReadMessagesRequest', {
        chatId,
        maxPosition,
        ...(messageIds?.length ? { messageIds } : {}),
      });
      return true;
    } catch (err) {
      logger.debug(`标记已读失败: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Mark these messages as read, same as viewing them in the client: the chat/thread unread state
   * advances to the newest of them, and the sender sees "Read".
   * Messages in the main chat advance the chat's read position by position; thread replies advance
   * their thread by threadPosition, with the request's maxPosition set to the thread root message's
   * position (the server requires it, and it only moves forward, never back).
   * Throws when a message does not exist, does not belong to the chat, or the request fails.
   * Returns the number of messages marked.
   */
  async readMessages(chatId: string, messageIds: string[]): Promise<number> {
    const found = ((await this.api('messages.PullMessagesByIdsRequest', { messageIds })).messages ??
      {}) as Record<string, Dict>;
    const missing = messageIds.filter((m) => !(m in found));
    if (missing.length) throw new Error(`找不到消息: ${missing.join(', ')}`);
    const chatIds: string[] = [];
    let chatMax = -1;
    const threads = new Map<string, { ids: string[]; max: number }>();
    for (const mid of messageIds) {
      const v = found[mid] as Dict;
      if (String(v.chatId) !== chatId) throw new Error(`消息 ${mid} 不在会话 ${chatId} 里`);
      const position = v.position as number | undefined;
      if (position !== undefined && position >= 0) {
        chatIds.push(mid);
        chatMax = Math.max(chatMax, position);
      }
      // Only real thread replies carry threadPosition (>=0; -1 for the root message); quote replies
      // in regular groups have only position and live in the main chat
      const threadId = v.threadId as string | undefined;
      const threadPosition = v.threadPosition as number | undefined;
      if (threadId && threadPosition !== undefined && threadPosition >= 0) {
        const t = threads.get(threadId) ?? { ids: [], max: -1 };
        t.ids.push(mid);
        t.max = Math.max(t.max, threadPosition);
        threads.set(threadId, t);
      }
    }
    if (chatIds.length)
      await this.api('messages.PutReadMessagesRequest', {
        chatId,
        maxPosition: chatMax,
        messageIds: chatIds,
      });
    if (threads.size) {
      const roots = ((
        await this.api('messages.PullMessagesByIdsRequest', { messageIds: [...threads.keys()] })
      ).messages ?? {}) as Record<string, Dict>;
      for (const [threadId, t] of threads) {
        const rootPosition = roots[threadId]?.position;
        if (rootPosition === undefined) throw new Error(`找不到话题根消息: ${threadId}`);
        await this.api('messages.PutReadMessagesRequest', {
          chatId,
          maxPosition: rootPosition,
          threadId,
          threadMaxPosition: t.max,
          messageIds: t.ids,
        });
      }
    }
    return messageIds.length;
  }

  /**
   * Call any gateway API: by request type name (e.g. chats.PullChatsByIdsRequest) or cmd number;
   * returns the response dict (the Packet dict when there is no response type).
   */
  async api(typeOrCmd: string | number, data?: Dict | null): Promise<Dict> {
    const { cmd, req, resp } = resolveCmd(typeOrCmd);
    return this.post(cmd, req ? toBinary(req, fromDict(req, data)) : undefined, resp);
  }

  /**
   * Like api, but the request is built as a protobuf object: bytes fields take Uint8Array directly,
   * int64 takes bigint (the property of rich text elements is bytes).
   */
  private async call(typeName: string, init: Record<string, unknown>): Promise<Dict> {
    const { cmd, req, resp } = resolveCmd(typeName);
    if (!req) throw new Error(`${typeName} 不是请求类型`);
    return this.post(cmd, toBinary(req, create(req, init)), resp);
  }

  private async post(
    cmd: number,
    payload: Uint8Array | undefined,
    resp: ReturnType<typeof resolveCmd>['resp'],
  ): Promise<Dict> {
    const pkt = LarkClient.packet({ cmd, cid: longRequestId(), ...(payload ? { payload } : {}) });
    const content = await this.gatewayPost(pkt);
    const respPkt = fromBinary(protoType('Packet'), content);
    const body = (respPkt as unknown as { payload?: Uint8Array }).payload;
    if (resp && body?.length) return toDict(resp, fromBinary(resp, body));
    return toDict(protoType('Packet'), respPkt);
  }

  async getChatInfo(chatId: string): Promise<Dict | null> {
    const resp = await this.api('chats.PullChatsByIdsRequest', { chatIds: [chatId] });
    const chats = (resp.chats ?? {}) as Record<string, Dict>;
    return Object.values(chats)[0] ?? null;
  }

  async isThreadChat(chatId: string): Promise<boolean> {
    const cached = this.threadChats.get(chatId);
    if (cached !== undefined) return cached;
    let info: Dict | null;
    try {
      info = await this.getChatInfo(chatId);
    } catch (err) {
      logger.debug(`查询会话模式失败,按普通会话处理: ${(err as Error).message}`);
      return false;
    }
    if (!info) return false;
    const thread = isThreadChat(info);
    this.threadChats.set(chatId, thread);
    return thread;
  }

  /**
   * Chats in the inbox changed after since (ms), newest change first.
   * Only chat cards (direct chats, group chats); other cards such as threads, docs and mail are
   * skipped.
   */
  async recentChats(since: number, maxPages = 20): Promise<RecentChat[]> {
    const out: RecentChat[] = [];
    let cursor: bigint | undefined;
    for (let page = 0; page < maxPages; page++) {
      const resp = await this.api('feed.PullFeedCardsRequest', {
        type: FEED_INBOX,
        pullFeedType: PULL_FEED_INBOX,
        businessType: BUSINESS_LARK,
        pullType: cursor === undefined ? PULL_REFRESH : PULL_LOAD_MORE,
        count: 50,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const cards = (resp.cards ?? []) as Dict[];
      const chats = (resp.chats ?? {}) as Record<string, Dict>;
      for (const card of cards) {
        const updatedAt = Number(card.updateTimeMs ?? 0) || Number(card.updateTime ?? 0) * 1000;
        if (card.type !== CARD_CHAT || updatedAt < since) continue;
        const chatId = String(card.id);
        out.push({ chatId, updatedAt, chat: chats[chatId] ?? null });
      }
      // Cards are ordered by rankTime (s), newest first; once paging reaches cards older than
      // since, stop paging
      const oldest = Number(cards.at(-1)?.rankTime ?? 0) * 1000;
      const next = resp.nextCursor as bigint | undefined;
      if (!cards.length || !next || oldest < since) break;
      cursor = next;
    }
    return out;
  }

  /**
   * Fetch messages by id (across chats), returned in the given order; ids that don't exist or can't
   * be viewed are skipped.
   */
  async getMessages(messageIds: string[]): Promise<LarkMessage[]> {
    if (!messageIds.length) return [];
    const resp = await this.api('messages.PullMessagesByIdsRequest', { messageIds });
    const found = (resp.messages ?? {}) as Record<string, Dict>;
    const out: LarkMessage[] = [];
    for (const id of messageIds) {
      const v = found[id];
      if (v) out.push(await this.fixThreadScope(toLarkMessage(v, { selfId: this.auth.userId })));
    }
    return out;
  }

  /**
   * Full context of a thread: the root message first, then the latest limit replies; empty when the
   * root message does not exist.
   */
  async threadMessages(rootId: string, limit = 200): Promise<LarkMessage[]> {
    const [root] = await this.getMessages([rootId]);
    if (!root) return [];
    return [root, ...(await this.threadReplies(rootId, limit))];
  }

  /**
   * Messages in a thread (the replies after the root message), in thread order; only the latest
   * limit, empty when the thread does not exist.
   * Thread positions start at 0 (the first reply); requesting -1 returns the root message, but the
   * response records it at 0 because the root's threadPosition is unset, colliding with the first
   * reply, so it is not requested.
   */
  async threadReplies(threadId: string, limit = 200): Promise<LarkMessage[]> {
    const info = await this.api('thread.PullThreadsByIDsRequest', { threadIds: [threadId] });
    const thread = ((info.threads ?? {}) as Record<string, Dict>)[threadId];
    const last = int(thread?.lastMessagePosition);
    if (last < 0) return [];
    const first = Math.max(0, last - limit + 1);
    const positions = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    const resp = await this.api('thread.PullThreadMessagesByPositionsRequest', {
      threadId,
      positions,
    });
    return Object.entries((resp.messages ?? {}) as Record<string, Dict>)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => toLarkMessage(v, { selfId: this.auth.userId }));
  }

  /**
   * Messages that arrived after since (ms) but were not received over the long-lived connection:
   * used to backfill after reconnecting. Ascending by creation time; may duplicate messages already
   * received (the caller deduplicates by msg_id).
   * Only looks at inbox chats changed after since: for regular chats, pulls chat messages after the
   * local position, then checks threads seen locally and threads with replies in the new messages;
   * for topic groups, looks at recent threads by thread position and takes the root messages and
   * replies of threads updated after since.
   */
  async missedMessages(since: number, o: MissedOptions = {}): Promise<LarkMessage[]> {
    const max = o.maxPerChat ?? 200;
    const sinceSec = Math.floor(since / 1000);
    const fresh = (m: LarkMessage) => Boolean(m.from_id) && (m.create_time ?? 0) >= sinceSec;
    const out = new Map<string, LarkMessage>();
    const add = (msgs: LarkMessage[]) => {
      for (const m of msgs) if (fresh(m)) out.set(m.msg_id, m);
    };
    const addThreads = async (ids: Iterable<string>) => {
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return;
      const resp = await this.api('thread.PullThreadsByIDsRequest', { threadIds: unique });
      for (const [id, t] of Object.entries((resp.threads ?? {}) as Record<string, Dict>))
        if (int(t.updateTime, 0) >= sinceSec) add(await this.threadReplies(id, max));
    };
    for (const rc of await this.recentChats(since)) {
      const chat = rc.chat ?? (await this.getChatInfo(rc.chatId));
      if (!chat) continue;
      if (isThreadChat(chat)) {
        const lastThread = int(chat.lastThreadPosition);
        if (lastThread < 0) continue;
        const first = Math.max(0, lastThread - RECENT_THREADS + 1);
        const resp = await this.api('thread.PullThreadsByPositionsRequest', {
          channelId: rc.chatId,
          type: CHANNEL_CHAT,
          positions: Array.from({ length: lastThread - first + 1 }, (_, i) => first + i),
        });
        const roots = (resp.rootMessages ?? {}) as Record<string, Dict>;
        add(
          Object.values(roots).map((v) =>
            toLarkMessage(v, {
              threadChat: true,
              fallbackChatId: rc.chatId,
              selfId: this.auth.userId,
            }),
          ),
        );
        const updated = Object.values((resp.threads ?? {}) as Record<string, Dict>)
          .filter((t) => int(t.updateTime, 0) >= sinceSec && int(t.lastMessagePosition) >= 0)
          .map((t) => String(t.id));
        for (const id of updated) add(await this.threadReplies(id, max));
        continue;
      }
      const last = int(chat.lastMessagePosition);
      const local = (await o.localPosition?.(rc.chatId)) ?? -1;
      const first = Math.max(0, local + 1, last - max + 1);
      const threads: string[] = [];
      if (last >= first) {
        const resp = await this.api('messages.PullMessagesByPositionsRequest', {
          chatId: rc.chatId,
          positions: Array.from({ length: last - first + 1 }, (_, i) => first + i),
        });
        for (const [pos, v] of Object.entries((resp.messages ?? {}) as Record<string, Dict>)) {
          if (Number(v.replyCount ?? 0) > 0) threads.push(String(v.id));
          add([
            toLarkMessage(v, {
              fallbackChatId: rc.chatId,
              fallbackPosition: Number(pos),
              selfId: this.auth.userId,
            }),
          ]);
        }
      }
      if (enumToInt(chat.type ?? 0) !== 1)
        await addThreads([...threads, ...((await o.knownThreads?.(rc.chatId)) ?? [])]);
    }
    return [...out.values()].sort(
      (a, b) =>
        (a.create_time ?? 0) - (b.create_time ?? 0) || (a.position ?? 0) - (b.position ?? 0),
    );
  }

  /**
   * Inbox chats with unread messages (changed after since ms, default the last 30 days), most
   * recently changed first.
   * Unread counts match the client's badge: unread messages in the chat, plus unread new threads
   * for topic groups.
   */
  async unreadChats(since = Date.now() - 30 * 86_400_000): Promise<UnreadChat[]> {
    const out: UnreadChat[] = [];
    for (const rc of await this.recentChats(since)) {
      const chat = rc.chat ?? (await this.getChatInfo(rc.chatId));
      if (!chat) continue;
      const unread = int(chat.newMessageCount, 0);
      const unreadThreads = int(chat.newThreadCount, 0);
      if (unread <= 0 && unreadThreads <= 0) continue;
      out.push({
        chatId: rc.chatId,
        name: String(chat.name ?? ''),
        chatType: enumToInt(chat.type ?? 0),
        threadChat: isThreadChat(chat),
        unread,
        unreadThreads,
      });
    }
    return out;
  }

  /**
   * Unread messages in a chat (after the read position, at most limit), in ascending time order.
   * For topic groups, takes new threads after the read thread position, plus replies after the read
   * position in recent threads.
   */
  async unreadMessages(chatId: string, limit = 50): Promise<LarkMessage[]> {
    const chat = await this.getChatInfo(chatId);
    if (!chat) return [];
    const selfId = this.auth.userId;
    const out: LarkMessage[] = [];
    if (isThreadChat(chat)) {
      const lastThread = int(chat.lastThreadPosition);
      if (lastThread < 0) return [];
      const first = Math.max(0, lastThread - RECENT_THREADS + 1);
      const resp = await this.api('thread.PullThreadsByPositionsRequest', {
        channelId: chatId,
        type: CHANNEL_CHAT,
        positions: Array.from({ length: lastThread - first + 1 }, (_, i) => first + i),
      });
      const readThread = int(chat.readThreadPosition);
      const roots = (resp.rootMessages ?? {}) as Record<string, Dict>;
      for (const t of Object.values((resp.threads ?? {}) as Record<string, Dict>)) {
        const root = roots[String(t.id)];
        if (root && int(t.position) > readThread)
          out.push(toLarkMessage(root, { threadChat: true, fallbackChatId: chatId, selfId }));
        const read = int(t.readPosition);
        const last = int(t.lastMessagePosition);
        if (last <= read) continue;
        const from = Math.max(read + 1, last - limit + 1, 0);
        const replies = await this.api('thread.PullThreadMessagesByPositionsRequest', {
          threadId: String(t.id),
          positions: Array.from({ length: last - from + 1 }, (_, i) => from + i),
        });
        for (const v of Object.values((replies.messages ?? {}) as Record<string, Dict>))
          out.push(toLarkMessage(v, { selfId }));
      }
    } else {
      const last = int(chat.lastMessagePosition);
      const from = Math.max(int(chat.readPosition) + 1, last - limit + 1, 0);
      if (last >= from) {
        const resp = await this.api('messages.PullMessagesByPositionsRequest', {
          chatId,
          positions: Array.from({ length: last - from + 1 }, (_, i) => from + i),
        });
        for (const [pos, v] of Object.entries((resp.messages ?? {}) as Record<string, Dict>))
          out.push(
            toLarkMessage(v, { fallbackChatId: chatId, fallbackPosition: Number(pos), selfId }),
          );
      }
    }
    return out
      .filter((m) => m.from_id && m.from_id !== selfId && !m.recalled)
      .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0))
      .slice(-limit);
  }

  /** Unread messages across chats that @ me (or @all), in ascending time order. */
  async unreadMentions(since?: number): Promise<LarkMessage[]> {
    const out: LarkMessage[] = [];
    for (const chat of await this.unreadChats(since))
      out.push(...(await this.unreadMessages(chat.chatId)).filter((m) => m.at_me));
    return out.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  }

  /**
   * The position boundary that splits a chat by time: messages before it are all earlier than time
   * (ms), messages from it on are not; when all are earlier, it is the latest position + 1.
   * The boundary may land on a gap (a position with no message), which doesn't affect the result
   * when used as the starting point for pulling.
   * Binary search over positions, pulling a small range per step (positions may have gaps:
   * trace-free recalls, invisible messages); about log2(N) requests.
   */
  async positionAt(chatId: string, time: number, last?: number): Promise<number> {
    const end = last ?? int((await this.getChatInfo(chatId))?.lastMessagePosition);
    const target = Math.floor(time / 1000);
    /**
     * [position, creation time] of the first existing message from pos; null when there is none up
     * to end.
     */
    const probe = async (pos: number): Promise<[number, number] | null> => {
      for (let width = 8; pos <= end; pos += width, width *= 2) {
        const upto = Math.min(end, pos + width - 1);
        const resp = await this.api('messages.PullMessagesByPositionsRequest', {
          chatId,
          positions: Array.from({ length: upto - pos + 1 }, (_, i) => pos + i),
        });
        const found = Object.entries((resp.messages ?? {}) as Record<string, Dict>)
          .map(([k, v]) => [Number(k), int(v.createTime, 0)] as [number, number])
          .sort((a, b) => a[0] - b[0])[0];
        if (found) return found;
      }
      return null;
    };
    let lo = 0;
    let hi = end + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const p = await probe(mid);
      if (!p || p[1] >= target) hi = mid;
      else lo = p[0] + 1;
    }
    return lo;
  }

  /**
   * Chat messages within a time range (ms, inclusive on both ends; main chat stream, same as
   * pullHistory), at most the latest limit, in ascending position order.
   * First binary-searches the positions for the range, then pulls by position.
   */
  async historyRange(
    chatId: string,
    o: { since?: number | undefined; until?: number | undefined; limit?: number },
    save?: (msg: LarkMessage) => Promise<unknown>,
  ): Promise<LarkMessage[]> {
    const last = int((await this.getChatInfo(chatId))?.lastMessagePosition);
    if (last < 0) return [];
    const start = o.since === undefined ? 0 : await this.positionAt(chatId, o.since, last);
    const end =
      o.until === undefined ? last : (await this.positionAt(chatId, o.until + 1000, last)) - 1;
    const first = Math.max(start, end - (o.limit ?? 50) + 1);
    if (end < first) return [];
    const msgs = await this.pullHistory(
      chatId,
      Array.from({ length: end - first + 1 }, (_, i) => first + i),
    );
    const lo = o.since === undefined ? -Infinity : Math.floor(o.since / 1000);
    const hi = o.until === undefined ? Infinity : Math.floor(o.until / 1000);
    const inRange = msgs.filter((m) => (m.create_time ?? 0) >= lo && (m.create_time ?? 0) <= hi);
    if (save) for (const m of inRange) await save(m).catch(() => {});
    return inRange;
  }

  /**
   * Pull history messages by position and decode them; with save, saves each to the local database
   * (individual failures are ignored).
   */
  async pullHistory(
    chatId: string,
    positions: number[],
    save?: (msg: LarkMessage) => Promise<unknown>,
  ): Promise<LarkMessage[]> {
    const resp = await this.api('messages.PullMessagesByPositionsRequest', { chatId, positions });
    const messages = (resp.messages ?? {}) as Record<string, Dict>;
    const threadChat = await this.isThreadChat(chatId);
    const out: LarkMessage[] = [];
    for (const [posKey, v] of Object.entries(messages).sort(([a], [b]) => Number(a) - Number(b))) {
      const msg = toLarkMessage(v, {
        threadChat,
        fallbackChatId: chatId,
        fallbackPosition: Number(posKey),
      });
      out.push(msg);
      if (save) await save(msg).catch(() => {});
    }
    return out;
  }
}

/**
 * Library method → permission item (named like the CLI commands, grouped under the closest
 * command); the type requires every public method to be covered, so new methods must be assigned.
 */
type Methods<T> = {
  [K in keyof T]: T[K] extends (...args: never) => unknown ? K : never;
}[keyof T];

const METHOD_PERMISSIONS: {
  [K in Methods<LarkClient>]: Permission | ((...args: Parameters<LarkClient[K]>) => Permission);
} = {
  buildWsUrl: 'listen',
  connectWebsocket: 'listen',
  gatewayPost: 'api',
  api: 'api',
  sendMessage: (_chatId, content) =>
    'image' in content
      ? 'send-image'
      : 'file' in content
        ? 'send-file'
        : 'video' in content
          ? 'send-video'
          : 'audio' in content
            ? 'send-audio'
            : 'send',
  sendMsg: 'send',
  sendRich: 'send',
  sendPost: 'send',
  scheduleMessage: 'schedule',
  scheduledMessages: 'scheduled.list',
  rescheduleMessage: 'scheduled.reschedule',
  cancelScheduledMessage: 'scheduled.cancel',
  forwardMessage: 'forward',
  forwardThread: 'forward',
  search: 'search',
  createChat: 'search',
  getGroupName: 'search',
  getChatInfo: 'search',
  isThreadChat: 'search',
  searchMessages: 'search-messages',
  searchUsers: 'search-users',
  searchBots: 'search-bots',
  searchChats: 'chat-search',
  userProfile: 'user',
  chatList: 'chat-list',
  chatInfo: 'group.info',
  setMuted: 'mute',
  setGroupNickname: 'group.nickname',
  chatAdmins: 'group.admins',
  updateAdmins: 'group.admin',
  setPostPermission: 'group.moderation',
  joinRequests: 'group.requests',
  handleJoinRequest: 'group.approve',
  chatShareLink: 'group.link',
  createFeedGroup: 'tags.edit',
  renameFeedGroup: 'tags.edit',
  deleteFeedGroup: 'tags.edit',
  addToFeedGroup: 'tags.edit',
  removeFromFeedGroup: 'tags.edit',
  directChat: 'search',
  messageLink: 'message-link',
  selfChat: 'self-chat',
  getUserName: 'users',
  userNames: 'users',
  chatMembers: 'members',
  createGroup: 'group.create',
  addMembers: 'group.add',
  removeMembers: 'group.remove',
  updateGroup: 'group.rename',
  pinMessage: 'pin',
  unpinMessage: 'pin',
  chatPins: 'pins',
  feedGroups: 'tags.list',
  feedGroupChats: 'tags.list',
  shortcuts: 'shortcut.list',
  addShortcuts: 'shortcut.add',
  removeShortcuts: 'shortcut.remove',
  flagMessages: 'flag',
  flagChats: 'flag',
  flags: 'flags',
  translateText: 'translate',
  translateMessages: 'translate',
  recallMessage: 'recall',
  editMessage: 'edit',
  addReaction: 'react',
  removeReaction: 'react',
  reactions: 'reactions',
  readStates: 'read-status',
  myReadStates: 'read-status',
  markRead: 'read',
  readMessages: 'read',
  recentChats: 'unread',
  unreadChats: 'unread',
  unreadMessages: 'unread',
  unreadMentions: 'unread',
  getMessages: 'get',
  threadMessages: 'thread',
  threadReplies: 'thread',
  missedMessages: 'history',
  positionAt: 'history',
  historyRange: 'history',
  pullHistory: 'history',
};
