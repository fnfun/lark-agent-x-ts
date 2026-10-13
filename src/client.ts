import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from './auth.js';
import { raiseForStatus, request, USER_AGENT } from './http.js';
import { accessKey, longRequestId, requestId } from './ids.js';
import { getLogger } from './log.js';
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
  type SearchHit,
} from './proto/builders.js';
import {
  decodePushMessages,
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

export interface SendOptions {
  /** 回复进话题（根消息 id）。 */
  rootId?: string | undefined;
  /** 引用某条消息（在话题内引用时同时给 rootId）。 */
  replyTo?: string | undefined;
}

/** sendMessage 的内容：纯文本、结构化富文本（text 为纯文本摘要）或 HTML 富文本。 */
export type MessageContent =
  | { text: string; links?: boolean }
  | { blocks: RichBlock[]; text: string }
  | { html: string; title?: string };

/** 服务端已受理发送请求，但拿不到消息 id，无法确认是否发出。 */
export class SendUnconfirmed extends Error {}

export type MessageHandler = (msg: LarkMessage) => Promise<void>;

/** 网页协议客户端：网关请求（HTTP + protobuf）与消息长连接。 */
export class LarkClient {
  private readonly threadChats = new Map<string, boolean>();

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
   */
  async connectWebsocket(onMessage: MessageHandler, signal?: AbortSignal): Promise<void> {
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

  private async dispatch(msg: LarkMessage, onMessage: MessageHandler): Promise<void> {
    try {
      // 推送里没有会话模式，话题群的根消息要查过 chatMode 才能归到它自己的话题
      if (msg.scope === 'chat' && msg.chat_type === 2 && (await this.isThreadChat(msg.chat_id))) {
        [msg.scope, msg.anchor] = resolveScope(msg.msg_id, msg.msg_type, 2, '', '', true);
      }
      await onMessage(msg);
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
    raiseForStatus(res);
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
   * 内容三选一：纯文本（links 时把 `[文字](url)` 渲染成带文字的超链接）、结构化富文本（text 是纯文本摘要）、HTML 富文本。
   */
  async sendMessage(chatId: string, content: MessageContent, o: SendOptions = {}): Promise<string> {
    const target = await this.threadTarget(chatId, o);
    const cid = longRequestId();
    const pkt =
      'blocks' in content
        ? buildRichMessagePacket(content.blocks, content.text, target, cid)
        : 'html' in content
          ? buildPostMessagePacket(content.html, target, cid, content.title ?? '')
          : buildSendMessagePacket(content.text, target, cid, content.links ?? false);
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
    const pkt = LarkClient.packet({
      cmd,
      cid: longRequestId(),
      ...(req ? { payload: toBinary(req, fromDict(req, data)) } : {}),
    });
    const content = await this.gatewayPost(pkt);
    const respPkt = fromBinary(protoType('Packet'), content);
    const payload = (respPkt as unknown as { payload: Uint8Array }).payload;
    if (resp && payload.length) return toDict(resp, fromBinary(resp, payload));
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
