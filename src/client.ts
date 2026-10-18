import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from './auth.js';
import { HttpError, NetworkError, request, USER_AGENT } from './http.js';
import { accessKey, longRequestId, requestCid, requestId } from './ids.js';
import { getLogger } from './log.js';
import { uploadFile, uploadImage } from './media.js';
import {
  authorize,
  checkSource,
  guardMethods,
  type Permission,
  type PermissionSource,
} from './permissions.js';
import {
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
  decodeGroupInfoResponse,
  decodePutChatResponse,
  decodePutMessageResponse,
  decodeSearchResponse,
  decodeUserInfoResponse,
  type EditableContent,
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

// feed.PullFeedCardsRequest 的枚举取值（FeedType.INBOX、PullType、PullFeedType.INBOX、BusinessType.LARK）与 FeedCard.Type.CHAT
const FEED_INBOX = 1;
const PULL_REFRESH = 1;
const PULL_LOAD_MORE = 2;
const PULL_FEED_INBOX = 2;
const BUSINESS_LARK = 1;
const CARD_CHAT = 1;

export interface SendOptions {
  /** 回复进话题（根消息 id）。 */
  rootId?: string | undefined;
  /** 引用某条消息（在话题内引用时同时给 rootId）。 */
  replyTo?: string | undefined;
  /**
   * 消息的客户端 id，用于幂等：服务端按它去重，同一个 cid 重发拿到的是同一条消息。
   * 不给时随机生成；拿到 SendUnconfirmed 后想补发，用它带回的 cid 再发一次即可，不会发重。
   */
  cid?: string | undefined;
  /** 网络错误、5xx 或拿不到消息 id 时用同一个 cid 自动重试的次数，默认 2。 */
  retries?: number | undefined;
}

/**
 * sendMessage 的内容：纯文本、结构化富文本（text 为纯文本摘要）、HTML 富文本、Markdown（客户端按 Markdown 渲染）、图片或文件。
 * 图片与文件传原始字节，发送前自动上传；name 是文件名（文件消息里显示它，图片只用来标注格式）。
 */
export type MessageContent =
  | { text: string; links?: boolean }
  | { blocks: RichBlock[]; text: string }
  | { html: string; title?: string }
  | { markdown: string; title?: string }
  | { image: Uint8Array; name?: string }
  | { file: Uint8Array; name: string };

/** 服务端已受理发送请求，但拿不到消息 id，无法确认是否发出；用 cid 重发不会发重。 */
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

/** 收件箱里的一个会话：feed 卡片的更新时间 + 会话信息。 */
export interface RecentChat {
  chatId: string;
  /** 会话最近一次变动的时间（毫秒）。 */
  updatedAt: number;
  /** 会话信息（与 getChatInfo 同为 entities.Chat）；服务端没带时为 null。 */
  chat: Dict | null;
}

/** 有未读的会话：unread 是会话未读数（话题群另计新话题数）。 */
export interface UnreadChat {
  chatId: string;
  name: string;
  /** 1 单聊、2 群聊、3 旧版话题群（新版话题群也是 2，看 threadChat）。 */
  chatType: number;
  threadChat: boolean;
  unread: number;
  /** 话题群里未读的新话题数。 */
  unreadThreads: number;
}

/** 跨会话搜消息的条件；时间为毫秒时间戳。 */
export interface MessageSearchOptions {
  /** 只搜这些会话。 */
  chatIds?: string[] | undefined;
  /** 只搜这些人发的。 */
  fromIds?: string[] | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** 最多返回多少条，默认 20。 */
  limit?: number | undefined;
}

/** 一条搜索命中：summary 是服务端给的摘要（"发送者: 内容…"，去掉了高亮标记），chatTitle 是会话名。 */
export interface MessageHit {
  msgId: string;
  chatId: string;
  chatTitle: string;
  fromId: string;
  /** 秒级时间戳。 */
  createTime: number;
  position: number | null;
  msgType: number;
  p2p: boolean;
  summary: string;
}

const SEARCH_ENTITY_MESSAGE = 5;
const unhighlight = (s: unknown) => String(s ?? '').replace(/<\/?h>/g, '');

/** 一条消息的已读情况（发送方视角）：谁读了、谁还没读。 */
export interface ReadState {
  messageId: string;
  readCount: number;
  unreadCount: number;
  readUserIds: string[];
  unreadUserIds: string[];
  /** 最近一个读的人与时间（秒）。 */
  lastRead: { userId: string; time: number } | null;
}

/** 一个标记（客户端"标记"列表里的一项）：被标记的消息或会话；消息标记带上消息本身。 */
export interface FlagItem {
  type: 'message' | 'chat';
  id: string;
  /** 标记时间（毫秒）。 */
  createTime: number;
  message: LarkMessage | null;
}

/** 会话里被 Pin 的一条消息。 */
export interface PinnedMessage {
  pinId: string;
  messageId: string;
  /** Pin 的人。 */
  pinnedBy: string;
  /** Pin 的时间（毫秒）。 */
  pinnedAt: number;
  message: LarkMessage | null;
}

/** 一条还没发出的定时消息。at 为计划发送时间（毫秒）。 */
export interface ScheduledMessage {
  messageId: string;
  at: number;
  status: 'pending' | 'suspended';
  message: LarkMessage | null;
}

// ScheduleMessage.Status、PullChatScheduleMessagesRequest.EntityType、PatchScheduleMessageRequest.PatchType
const SCHEDULE_PENDING = 1;
const SCHEDULE_SUSPEND = 2;
const SCHEDULE_CHAT_ONLY = 1;
const SCHEDULE_PATCH_UPDATE = 1;
const SCHEDULE_PATCH_DELETE = 3;

/** 会话列表里的一个标签（分组）。keyword 是按关键词自动归类的标签。 */
export interface FeedGroup {
  id: string;
  name: string;
  type: 'normal' | 'keyword' | 'unknown';
}

/** 一页最多取多少个标签 / 标签项（服务端对过大的 count 报 invalid request）。 */
const FEED_GROUP_PAGE = 20;

// translate.ContentType.TEXT
const TRANSLATE_TEXT = 2;

// feed.Shortcut.Type.CHAT
const SHORTCUT_CHAT = 1;

// feed.FlagItem.FlagType 与 FeedCard.Type.CHAT
const FLAG_FEED = 1;
const FLAG_MESSAGE = 2;

/** 一条消息上的表情回复。 */
export interface MessageReactions {
  messageId: string;
  reactions: { type: string; count: number; userIds: string[] }[];
}

/** 群成员（或按 id 查到的用户）。name 已按备注名 > 当前语言显示名 > 默认名取好。 */
export interface ChatMember {
  id: string;
  name: string;
  type: 'user' | 'bot' | 'ai' | 'unknown';
}

const CHATTER_TYPES: Record<number, ChatMember['type']> = { 1: 'user', 2: 'bot', 3: 'ai' };

/** entities.Chatter → 显示名：自己设的备注名优先，其次当前语言的显示名，再次默认显示名与 name。 */
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

/** 补收断线期间的消息时，本地已有记录的查询方式（都可省略，省略时按本地什么都没有处理）。 */
export interface MissedOptions {
  /** 本地已有的该会话最大 position，没有记录时为 -1（会话 position 从 0 起）；只从它之后拉，减少重复。 */
  localPosition?: (chatId: string) => Promise<number>;
  /** 本地见过的该会话话题 id：普通群的话题回复不占会话 position，只能按话题去查。 */
  knownThreads?: (chatId: string) => Promise<string[]>;
  /** 每个会话（或话题）最多往回看多少条，默认 200。 */
  maxPerChat?: number;
}

const CHANNEL_CHAT = 1;
// Chat.ChatMode.THREAD_V2（新版话题群）；PatchGroupChatRequest.UpdateFields 的 NAME、DESCRIPTION
const CHAT_MODE_THREAD_V2 = 3;
const GROUP_FIELD_NAME = 1;
const GROUP_FIELD_DESCRIPTION = 3;
/** 长连接推送：表情变化（reactions.PushReactions）。 */
const PUSH_REACTIONS = 27;
/** 话题群一次往回看的话题数。 */
const RECENT_THREADS = 20;

const int = (v: unknown, dflt = -1): number =>
  v === undefined || v === null ? dflt : Number(v as number | bigint);

/** 网关出错时响应体仍是 Packet，错误文本放在 sid 字段里；解不出来时为空串。 */
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
   * 权限检查：`true` 按与命令行相同的规则（账号自己的规则，没有则 `LARKX_ALLOW` / `LARKX_DENY`），或给一份固定规则；
   * 不允许时方法抛 PermissionDenied。不传时不检查，全部允许。
   */
  permissions?: PermissionSource;
}

/** 网页协议客户端：网关请求（HTTP + protobuf）与消息长连接。 */
export class LarkClient {
  private readonly threadChats = new Map<string, boolean>();
  private readonly chatterNames = new Map<string, string>();

  private constructor(readonly auth: LarkAuth) {}

  /** 校验凭证（失效时抛 AuthExpired），缺 app_key / user_id 时补抓并保存。 */
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
   * 长连接计时：握手超时、心跳间隔、多久收不到任何帧视为断线。
   * 服务端对每次心跳都回一帧（cmd=200），所以两个心跳周期都没收到东西就是连接已死。
   */
  wsTiming = { openTimeoutMs: 15_000, heartbeatMs: 30_000, idleTimeoutMs: 65_000 };

  /**
   * 连上消息长连接并持续接收，直到连接关闭（正常关闭或 signal 中止时返回，异常时抛错）。
   * 每个带 sid 的帧都回 ACK，按 wsTiming 发应用层心跳；推送（cmd=6）里的消息按到达顺序串行交给 onMessage。
   * 握手超时、心跳无回应都按异常断开处理，由调用方重连。
   * onOpen 在连上后调用一次：此后的消息都会推送过来，适合在这里补拉断线期间的消息。
   * onReaction 收表情变化（推送 cmd=27，谁对哪条消息加了 / 取消了哪个表情），与消息走同一条串行队列。
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
      // Node 的 WebSocket 握手失败时可能既不触发 error 也不触发 close，收尾不能只靠 close 事件
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
        // 具体原因在随后的 close 事件里
      });
      ws.addEventListener('close', (ev) => {
        if (ev.code === 1000 || signal?.aborted) finish();
        else finish(new Error(`WS 连接关闭: code=${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`));
      });
    });
    await chain;
  }

  /** 推送与按 id 拉取的结果里没有会话模式，话题群的根消息要查过 chatMode 才能归到它自己的话题。 */
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

  /** 发送重试的间隔（毫秒），第 n 次重试等 n 倍。 */
  sendRetryDelayMs = 1000;

  /**
   * 发送一条消息并确认送达，返回服务端分配的消息 id；失败时抛错而不是返回 null：
   * 网络错误、5xx、拿不到消息 id 时按 o.retries 用同一个 cid 重试（服务端去重，不会发重）；仍失败时抛 NetworkError / HttpError，
   * 或 SendUnconfirmed（服务端已受理但拿不到消息 id，可能已发出；带着 cid，之后用它重发即可）。
   * 内容见 MessageContent：纯文本（links 时把 `[文字](url)` 渲染成带文字的超链接）、结构化富文本（text 是纯文本摘要）、HTML 富文本、图片、文件；
   * 图片与文件先上传再发送，上传失败同样抛 NetworkError / HttpError。
   */
  async sendMessage(chatId: string, content: MessageContent, o: SendOptions = {}): Promise<string> {
    const { pkt, cid } = await this.messagePacket(chatId, content, o);
    // 服务端按消息 cid 去重，重试同一个包不会发重
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

  /** 发送包（PutMessageRequest，cmd 5）与消息 cid；图片、文件在这里先上传。 */
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
    else if ('markdown' in content)
      pkt = buildMarkdownMessagePacket(content.markdown, target, requestId, content.title ?? '');
    else if ('blocks' in content)
      pkt = buildRichMessagePacket(content.blocks, content.text, target, requestId);
    else if ('html' in content)
      pkt = buildPostMessagePacket(content.html, target, requestId, content.title ?? '');
    else pkt = buildSendMessagePacket(content.text, target, requestId, content.links ?? false);
    return { pkt, cid: target.cid };
  }

  /**
   * 定时发送：到 at（毫秒）时由服务端发出，返回定时消息 id（发出后就是这条消息的 id）。内容与回复选项同 sendMessage。
   * 话题里的回复（o.rootId）挂在该话题下。
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

  /** 会话里还没发出的定时消息（等待中、已暂停），按发送时间升序。 */
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

  /** 改定时消息的发送时间（毫秒）。 */
  async rescheduleMessage(chatId: string, messageId: string, at: number): Promise<void> {
    await this.api('messages.PatchScheduleMessageRequest', {
      patchType: SCHEDULE_PATCH_UPDATE,
      messageId,
      chatId,
      scheduleTime: String(Math.floor(at / 1000)),
    });
  }

  /** 取消定时消息（不再发出）。 */
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

  /** 发文本消息，返回消息 id；未能确认发送成功时记错误日志并返回 null。richLinks 同 sendMessage 的 links。 */
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

  /** 结构化富文本（POST）消息；innerText 是纯文本摘要。返回消息 id，失败 null。 */
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

  /** HTML 片段的富文本（POST）消息。返回消息 id，失败 null。 */
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
   * 跨会话搜消息（同客户端搜索框的"消息"），按服务端的相关度排序；可按会话、发送人、时间过滤。
   * 服务端的搜索有索引延迟，刚发出的消息可能要过一会儿才搜得到。
   */
  async searchMessages(query: string, o: MessageSearchOptions = {}): Promise<MessageHit[]> {
    const limit = o.limit ?? 20;
    const filter: Dict = {};
    if (o.chatIds?.length) filter.chatIds = o.chatIds;
    if (o.fromIds?.length) filter.creatorIds = o.fromIds;
    if (o.since !== undefined || o.until !== undefined)
      filter.timeRange = {
        ...(o.since !== undefined ? { startTime: String(Math.floor(o.since / 1000)) } : {}),
        ...(o.until !== undefined ? { endTime: String(Math.floor(o.until / 1000)) } : {}),
      };
    const session = requestCid();
    const out: MessageHit[] = [];
    let token = '';
    for (let seq = 1; out.length < limit; seq++) {
      const resp = await this.api('usearch.UniversalSearchRequest', {
        header: {
          searchSession: session,
          sessionSeqId: seq,
          query,
          ...(token ? { paginationToken: token } : {}),
          searchContext: {
            tagName: 'MESSAGE',
            entityItems: [{ type: SEARCH_ENTITY_MESSAGE, filter: { messageFilter: filter } }],
            commonFilter: { includeOuterTenant: true },
            sourceKey: 'messenger',
          },
          locale: this.auth.region.locale,
          pageSize: Math.min(limit - out.length, 50),
          extraParam: {},
        },
      });
      for (const r of (resp.results ?? []) as Dict[]) {
        const m = ((r.resultMeta as Dict | undefined)?.messageMeta ?? {}) as Dict;
        if (r.type !== SEARCH_ENTITY_MESSAGE || !m.id) continue;
        out.push({
          msgId: String(m.id),
          chatId: String(m.chatId ?? ''),
          chatTitle: unhighlight(r.titleHighlighted),
          fromId: String(m.fromId ?? ''),
          createTime: Number(m.createTime ?? 0),
          position: m.position === undefined ? null : Number(m.position),
          msgType: enumToInt(m.type ?? 0),
          p2p: m.isP2pChat === true,
          summary: unhighlight(r.summaryHighlighted),
        });
      }
      const header = (resp.header ?? {}) as Dict;
      token = String(header.paginationToken ?? '');
      if (!header.hasMore || !token || !(resp.results as unknown[] | undefined)?.length) break;
    }
    return out.slice(0, limit);
  }

  async createChat(userId: string): Promise<string | null> {
    return decodePutChatResponse(
      await this.gatewayPost(buildCreateChatPacket(userId, longRequestId())),
    );
  }

  /**
   * 官方"消息链接"（客户端"复制消息链接"同款 applink）：单条点开定位到该消息；
   * 多条则是一个合并链接，客户端以"来自群聊"的消息预览展示多条。话题内消息同样以会话为来源。
   */
  async messageLink(chatId: string, messageIds: string[]): Promise<string | null> {
    const resp = await this.api('messages.PutMessageLinkRequest', {
      fromId: chatId,
      from: 1,
      copiedId: messageIds,
    });
    return (resp.tokenUrl as string | undefined) || null;
  }

  /** 当前账号与自己的会话（Lark 允许给自己发消息）；不存在时服务端会创建。 */
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
   * 批量查用户（或机器人）的显示名，返回 id → 名字；查不到的 id 不在结果里。结果在进程内缓存，同一 id 只查一次。
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

  /** 会话成员（含机器人），最多取 max 个；翻页参数（cursor / offset / orderCursor）原样带回，直到服务端不再给。 */
  async chatMembers(chatId: string, max = 5000): Promise<ChatMember[]> {
    const members = new Map<string, ChatMember>();
    let page: Dict = {};
    for (;;) {
      const resp = await this.api('chats.PullChatChattersRequest', { chatId, limit: 100, ...page });
      const before = members.size;
      for (const field of ['chatters', 'updateChatters'])
        for (const [id, v] of Object.entries((resp[field] ?? {}) as Record<string, Dict>)) {
          const m = toMember(id, v, this.auth.region.locale);
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
   * 建群并拉人（memberIds 可为空，即只有自己），返回新群的 chat_id。topic 为 true 时建话题群。
   * 群对成员可见、会通知被拉的人；同一个 cid 重发不会建出两个群。
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

  /** 把人拉进群（需要有拉人权限）。 */
  async addMembers(chatId: string, userIds: string[]): Promise<void> {
    await this.api('chats.PutChatChatterRequest', { chatId, chatterIds: userIds });
  }

  /** 把人移出群（需要是群主或管理员）。 */
  async removeMembers(chatId: string, userIds: string[]): Promise<void> {
    await this.api('chats.DeleteChatChatterRequest', { chatId, chatterIds: userIds });
  }

  /** 改群名 / 群描述（给了哪个改哪个）。 */
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

  /** Pin 一条消息到会话（会话成员都看得到），返回 pin id。 */
  async pinMessage(chatId: string, messageId: string): Promise<string> {
    const resp = await this.api('pin.PutPinRequest', { chatId, messageId });
    const id = (resp.pin as Dict | undefined)?.id;
    if (id === undefined) throw new Error('Pin 失败: 响应里没有 pin id');
    return String(id);
  }

  /** 取消 Pin；消息没被 Pin 时返回 false。 */
  async unpinMessage(chatId: string, messageId: string): Promise<boolean> {
    const resp = await this.api('pin.PullPinsByMessageIDsRequest', { messageIds: [messageId] });
    const pin = Object.values((resp.pins ?? {}) as Record<string, Dict>).find(
      (p) => String(p.messageId) === messageId && !int(p.deletedTime, 0),
    );
    if (!pin) return false;
    await this.api('pin.DeletePinRequest', { id: String(pin.id), chatId });
    return true;
  }

  /** 会话里被 Pin 的消息（最多 max 条），带上消息本身，按 Pin 时间从新到旧。 */
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

  /** 我的会话标签（分组），按标签位置排序。 */
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

  /** 某个标签里的会话（chat_id）。 */
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

  /** 会话列表里置顶的会话（chat_id），按置顶顺序。 */
  async shortcuts(): Promise<string[]> {
    const resp = await this.api('feed.PullShortcutsRequest', { position: 0, count: 200 });
    return ((resp.shortcuts ?? []) as Dict[])
      .filter((x) => int(x.type, 0) === SHORTCUT_CHAT)
      .sort((a, b) => int(a.position, 0) - int(b.position, 0))
      .map((x) => String(x.id));
  }

  /** 在会话列表里置顶这些会话（排在已置顶的之后）。只影响自己的会话列表。 */
  async addShortcuts(chatIds: string[]): Promise<void> {
    await this.api('feed.PutShortcutsRequest', {
      shortcuts: chatIds.map((id, i) => ({ id, type: SHORTCUT_CHAT, position: i })),
    });
  }

  /** 取消置顶。 */
  async removeShortcuts(chatIds: string[]): Promise<void> {
    await this.api('feed.DeleteShortcutsRequest', {
      shortcuts: chatIds.map((id) => ({ id, type: SHORTCUT_CHAT })),
    });
  }

  /** 标记 / 取消标记消息（同客户端的"标记"，留给自己稍后处理；只有自己看得到）。 */
  async flagMessages(messageIds: string[], remove = false): Promise<void> {
    const items = messageIds.map((id) => ({ itemId: id, flagType: FLAG_MESSAGE }));
    await this.api('feed.UpdateFlagsRequest', remove ? { deletedItems: items } : { items });
  }

  /** 标记 / 取消标记会话。 */
  async flagChats(chatIds: string[], remove = false): Promise<void> {
    const items = chatIds.map((id) => ({ itemId: id, itemType: CARD_CHAT, flagType: FLAG_FEED }));
    await this.api('feed.UpdateFlagsRequest', remove ? { deletedItems: items } : { items });
  }

  /** 我的标记列表（最多 max 个），按标记时间从新到旧。 */
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
   * 把一条消息转发到这些会话（原样转发，接收方看到"转发自"），返回会话 id → 新消息 id；转发失败的会话不在结果里。
   * 每个目标带一个消息 cid，服务端据此去重，同一次调用里的重试不会发重。
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
   * 翻译文本（客户端"翻译"同款），按顺序返回译文。targetLanguage 如 zh、en、ja；sourceLanguage 留空自动识别。
   * 不改变任何消息的显示状态。
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

  /** 翻译消息（按消息内容的纯文本摘要翻译），返回原文与译文；不存在或没有文字内容的消息跳过。 */
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

  /** 撤回一条消息（自己发的；群管理员也可撤回群里别人的）。服务端没有确认时抛错。 */
  async recallMessage(msgId: string): Promise<void> {
    const resp = await this.api('messages.DeleteMessageRequest', { id: msgId });
    if (resp.message !== 'ok')
      throw new Error(`撤回失败: ${String(resp.message ?? '服务端没有确认')}`);
  }

  /**
   * 编辑自己发的文本或富文本消息，内容整条替换；对方看到"已编辑"。
   * 纯文本消息只能改成纯文本（content 用 text），富文本消息用 blocks 或 markdown；超过可编辑时限等由服务端拒绝（HttpError.reason 说明原因）。
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

  /** 给消息加表情回复，reactionType 如 THUMBSUP、OK、DONE、SMILE（与客户端表情面板的 key 一致）。 */
  async addReaction(msgId: string, reactionType: string): Promise<void> {
    await this.api('reactions.PutReactionRequest', { messageId: msgId, reactionType });
  }

  /** 去掉自己加的某个表情回复。 */
  async removeReaction(msgId: string, reactionType: string): Promise<void> {
    await this.api('reactions.DeleteReactionRequest', { messageId: msgId, reactionType });
  }

  /** 消息上的表情回复：每种表情的数量与加过的人。 */
  async reactions(messageIds: string[]): Promise<MessageReactions[]> {
    const resp = await this.api('reactions.PullReactionsRequest', { messageIds, fetchUsers: true });
    return ((resp.messageReactions ?? []) as Dict[]).map((mr) => ({
      messageId: String(mr.messageId),
      // 表情被全部去掉后服务端仍会返回一条 count=0 的记录，不算
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

  /** 消息的已读情况（谁读了、谁没读），消息须在 chatId 会话里；查不到的消息不在结果里。 */
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

  /** 我自己是否读过这些消息：id → 读过的时间（秒），没读过为 null。 */
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

  /** 收到消息即标已读（listen 的 LARKX_MARK_READ）；失败只记 debug。 */
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
   * 把这些消息标为已读，效果同在客户端里看过它们：会话/话题的未读推进到其中最新一条，发送方看到"已读"。
   * 主会话里的消息按 position 推进会话已读位置；话题回复按 threadPosition 推进该话题，
   * 请求里的 maxPosition 用话题根消息的 position（服务端要求必填，且只会前进不会回退）。
   * 消息不存在、不属于该会话或请求失败时抛错。返回标记的消息数。
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
      // 只有真正的话题回复带 threadPosition（>=0；根消息为 -1）；普通群的引用回复只有 position，在主会话里
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

  /** 调任意网关接口：请求类型名（如 chats.PullChatsByIdsRequest）或 cmd 数字；返回响应 dict（无响应类型时为 Packet dict）。 */
  async api(typeOrCmd: string | number, data?: Dict | null): Promise<Dict> {
    const { cmd, req, resp } = resolveCmd(typeOrCmd);
    return this.post(cmd, req ? toBinary(req, fromDict(req, data)) : undefined, resp);
  }

  /** 同 api，但请求按 protobuf 对象构造：字节字段直接给 Uint8Array，int64 给 bigint（富文本元素的 property 就是字节）。 */
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
   * 收件箱里 since（毫秒）之后有变动的会话，按变动时间从新到旧。
   * 只含会话卡片（单聊、群聊）；话题、文档、邮件等其他卡片跳过。
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
      // 卡片按 rankTime（秒）从新到旧排列，翻到比 since 还旧的就不用再往后翻
      const oldest = Number(cards.at(-1)?.rankTime ?? 0) * 1000;
      const next = resp.nextCursor as bigint | undefined;
      if (!cards.length || !next || oldest < since) break;
      cursor = next;
    }
    return out;
  }

  /** 按消息 id 取消息（可跨会话），按传入顺序返回；不存在或无权查看的 id 跳过。 */
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

  /** 一个话题的全部上下文：根消息在前，随后是最近 limit 条回复；根消息不存在时为空。 */
  async threadMessages(rootId: string, limit = 200): Promise<LarkMessage[]> {
    const [root] = await this.getMessages([rootId]);
    if (!root) return [];
    return [root, ...(await this.threadReplies(rootId, limit))];
  }

  /**
   * 一个话题里的消息（根消息之后的回复），按话题内顺序；只看最近 limit 条，话题不存在时为空。
   * 话题内 position 从 0 起（第一条回复）；请求 -1 会返回根消息，但响应按根消息未设置的 threadPosition 记在 0 上，与第一条回复冲突，所以不请求它。
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
   * since（毫秒）之后到达、但没经过长连接收到的消息：用于断线重连后补收。按创建时间升序，可能与已收到的重复（调用方按 msg_id 去重）。
   * 只看收件箱里 since 之后有变动的会话：普通会话拉本地 position 之后的会话消息，再查本地见过的和新消息里带回复的话题；
   * 话题群按话题位置看最近的话题，取 since 之后更新过的话题里的根消息与回复。
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
   * 收件箱里有未读的会话（since 毫秒之后有变动的，默认最近 30 天），按最近变动从新到旧。
   * 未读数同客户端角标：会话未读消息数，话题群另计未读的新话题数。
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
   * 一个会话里的未读消息（已读位置之后的，最多 limit 条），按时间升序。
   * 话题群取已读话题位置之后的新话题，以及最近话题里已读位置之后的回复。
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

  /** 各会话里还没读的、@ 了我（或 @所有人）的消息，按时间升序。 */
  async unreadMentions(since?: number): Promise<LarkMessage[]> {
    const out: LarkMessage[] = [];
    for (const chat of await this.unreadChats(since))
      out.push(...(await this.unreadMessages(chat.chatId)).filter((m) => m.at_me));
    return out.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  }

  /**
   * 按时间切分会话的 position 边界：在它之前的消息都早于 time（毫秒），从它起的都不早于 time；都更早时为最新 position + 1。
   * 边界可能落在空洞上（该 position 没有消息），作为拉取的起点不影响结果。
   * 在 position 上二分查找，每步拉一小段（position 可能有空洞：撤回无痕、不可见的消息），约 log2(N) 次请求。
   */
  async positionAt(chatId: string, time: number, last?: number): Promise<number> {
    const end = last ?? int((await this.getChatInfo(chatId))?.lastMessagePosition);
    const target = Math.floor(time / 1000);
    /** pos 起第一条存在的消息的 [position, 创建时间]；到 end 都没有时为 null。 */
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
   * 时间范围内（毫秒，含两端）的会话消息（主会话流，同 pullHistory），最多取最新的 limit 条，按 position 升序。
   * 先二分查出范围对应的 position，再按 position 拉取。
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

  /** 按 position 拉历史消息并解码；save 时逐条入库（单条失败忽略）。 */
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

/** 库方法 → 权限项（与命令行同名，按最接近的命令归类）；类型要求覆盖全部公开方法，新增方法时必须归类。 */
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
    'image' in content ? 'send-image' : 'file' in content ? 'send-file' : 'send',
  sendMsg: 'send',
  sendRich: 'send',
  sendPost: 'send',
  scheduleMessage: 'schedule',
  scheduledMessages: 'scheduled.list',
  rescheduleMessage: 'scheduled.reschedule',
  cancelScheduledMessage: 'scheduled.cancel',
  forwardMessage: 'forward',
  search: 'search',
  createChat: 'search',
  getGroupName: 'search',
  getChatInfo: 'search',
  isThreadChat: 'search',
  searchMessages: 'search-messages',
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
  feedGroups: 'tags',
  feedGroupChats: 'tags',
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
