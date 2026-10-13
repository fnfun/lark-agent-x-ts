import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from './auth.js';
import { HttpError, request, USER_AGENT } from './http.js';
import { accessKey, longRequestId, requestCid, requestId } from './ids.js';
import { getLogger } from './log.js';
import { uploadFile, uploadImage } from './media.js';
import {
  buildCreateChatPacket,
  buildFileMessagePacket,
  buildGroupInfoPacket,
  buildImageMessagePacket,
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
  enumToInt,
  isThreadChat,
  type LarkMessage,
  parseWsFrame,
  resolveScope,
  toLarkMessage,
} from './proto/decoders.js';
import { type Dict, fromDict, toDict } from './proto/dict.js';
import { protoType, resolveCmd } from './proto/registry.js';
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
}

/**
 * sendMessage 的内容：纯文本、结构化富文本（text 为纯文本摘要）、HTML 富文本、图片或文件。
 * 图片与文件传原始字节，发送前自动上传；name 是文件名（文件消息里显示它，图片只用来标注格式）。
 */
export type MessageContent =
  | { text: string; links?: boolean }
  | { blocks: RichBlock[]; text: string }
  | { html: string; title?: string }
  | { image: Uint8Array; name?: string }
  | { file: Uint8Array; name: string };

/** 服务端已受理发送请求，但拿不到消息 id，无法确认是否发出。 */
export class SendUnconfirmed extends Error {}

export type MessageHandler = (msg: LarkMessage) => Promise<void>;

/** 收件箱里的一个会话：feed 卡片的更新时间 + 会话信息。 */
export interface RecentChat {
  chatId: string;
  /** 会话最近一次变动的时间（毫秒）。 */
  updatedAt: number;
  /** 会话信息（与 getChatInfo 同为 entities.Chat）；服务端没带时为 null。 */
  chat: Dict | null;
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

/** 网页协议客户端：网关请求（HTTP + protobuf）与消息长连接。 */
export class LarkClient {
  private readonly threadChats = new Map<string, boolean>();
  private readonly chatterNames = new Map<string, string>();

  private constructor(readonly auth: LarkAuth) {}

  /** 校验凭证（失效时抛 AuthExpired），缺 app_key / user_id 时补抓并保存。 */
  static async create(auth: LarkAuth): Promise<LarkClient> {
    await auth.requireValid();
    if (!auth.appKey || !auth.userId) {
      await auth.validate(true);
      auth.save();
    }
    return new LarkClient(auth);
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
   */
  async connectWebsocket(
    onMessage: MessageHandler,
    signal?: AbortSignal,
    onOpen?: () => void,
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
    };
  }

  /**
   * 发送一条消息并确认送达，返回服务端分配的消息 id；失败时抛错而不是返回 null：
   * 请求失败抛 NetworkError / HttpError，服务端已受理但拿不到消息 id 时抛 SendUnconfirmed（可能已发出，不宜直接重试）。
   * 内容见 MessageContent：纯文本（links 时把 `[文字](url)` 渲染成带文字的超链接）、结构化富文本（text 是纯文本摘要）、HTML 富文本、图片、文件；
   * 图片与文件先上传再发送，上传失败同样抛 NetworkError / HttpError。
   */
  async sendMessage(chatId: string, content: MessageContent, o: SendOptions = {}): Promise<string> {
    const target = await this.threadTarget(chatId, o);
    const cid = longRequestId();
    let pkt: Packet;
    if ('image' in content)
      pkt = buildImageMessagePacket(
        await uploadImage(this.auth, content.image, content.name),
        target,
        cid,
      );
    else if ('file' in content)
      pkt = buildFileMessagePacket(
        await uploadFile(this.auth, chatId, content.file, content.name),
        target,
        cid,
      );
    else if ('blocks' in content)
      pkt = buildRichMessagePacket(content.blocks, content.text, target, cid);
    else if ('html' in content)
      pkt = buildPostMessagePacket(content.html, target, cid, content.title ?? '');
    else pkt = buildSendMessagePacket(content.text, target, cid, content.links ?? false);
    const resp = await this.gatewayPost(pkt);
    let msgId: string;
    try {
      msgId = decodePutMessageResponse(resp);
    } catch (err) {
      throw new SendUnconfirmed(
        `服务端已接受发送请求,但响应解析失败,无法确认是否发出: ${(err as Error).message}`,
      );
    }
    if (!msgId)
      throw new SendUnconfirmed('服务端已接受发送请求,但响应里没有消息 id,无法确认是否发出');
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

  /** 撤回一条消息（自己发的；群管理员也可撤回群里别人的）。服务端没有确认时抛错。 */
  async recallMessage(msgId: string): Promise<void> {
    const resp = await this.api('messages.DeleteMessageRequest', { id: msgId });
    if (resp.message !== 'ok')
      throw new Error(`撤回失败: ${String(resp.message ?? '服务端没有确认')}`);
  }

  /**
   * 编辑自己发的文本或富文本消息，内容整条替换；对方看到"已编辑"。
   * 纯文本消息只能改成纯文本（content 用 text），富文本消息用 blocks；超过可编辑时限等由服务端拒绝（HttpError.reason 说明原因）。
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
      if (v) out.push(await this.fixThreadScope(toLarkMessage(v, {})));
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
      .map(([, v]) => toLarkMessage(v, {}));
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
            toLarkMessage(v, { threadChat: true, fallbackChatId: rc.chatId }),
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
          add([toLarkMessage(v, { fallbackChatId: rc.chatId, fallbackPosition: Number(pos) })]);
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
