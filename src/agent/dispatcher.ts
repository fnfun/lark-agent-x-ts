import { type Config, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import type { LarkMessage } from '../proto/decoders.js';
import { head } from '../text.js';
import type { AgentBackend } from './backend.js';

const logger = getLogger('larkx.agent');

export const INSTRUCTIONS =
  '以上是飞书会话里新到的一条消息(XML 里有会话/发送者/内容)。你是这个数字人,完整对话历史你都有。如果对方也是机器人且只是互相客套寒暄,直接结束不要再接话。';
export const OUTPUT_RULES = '不需要回复就直接结束,不要解释、不要复述消息。';

/** 被引用（回复）的那条消息：数字人要看到原文才知道对方在接哪句话。 */
export interface QuotedMessage {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
}

/** 交给 agent 的消息：解码结果加上会话名、发送者名，回复别人时带上被引用的原文。 */
export interface AgentMessage extends LarkMessage {
  _chat_name?: string;
  _sender_name?: string;
  _quote?: QuotedMessage;
  /** 对方编辑了一条已经交给 agent 处理过的消息，这是编辑后的内容。 */
  _edited?: boolean;
  /** 这不是一条消息，而是对方对 _quote 那条（我发的）消息加了 / 取消了表情。 */
  _reaction?: { type: string; cancelled: boolean };
}

export type ReplyFn = (chatId: string, text: string, rootId?: string) => Promise<unknown>;

/** xml.sax.saxutils.escape。 */
export const xmlEscape = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('>', '&gt;').replaceAll('<', '&lt;');

/** xml.sax.saxutils.quoteattr：按内容选引号，换行与制表符转成字符引用。 */
export function quoteAttr(s: string): string {
  let v = xmlEscape(s).replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
  if (v.includes('"')) {
    if (v.includes("'")) v = `"${v.replaceAll('"', '&quot;')}"`;
    else v = `'${v}'`;
  } else v = `"${v}"`;
  return v;
}

const pad = (n: number) => String(n).padStart(2, '0');

function ts(m: LarkMessage): string {
  if (!m.create_time) return '';
  const d = new Date(Number(m.create_time) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function buildXmlMessage(m: AgentMessage): string {
  const lines = ['<message>'];
  lines.push(
    `  <chat id=${quoteAttr(String(m.chat_id))} name=${quoteAttr(m._chat_name || '')} type=${quoteAttr(m.chat_type_name || '')} anchor=${quoteAttr(m.anchor || '')}/>`,
  );
  lines.push(
    `  <sender id=${quoteAttr(String(m.from_id))} name=${quoteAttr(m._sender_name || '')}/>`,
  );
  if (m.at_me) lines.push('  <at_me>true</at_me>');
  if (m._edited) lines.push('  <edited>true</edited>');
  if (m._reaction)
    lines.push(
      `  <reaction type=${quoteAttr(m._reaction.type)} cancelled=${quoteAttr(String(m._reaction.cancelled))}/>`,
    );
  if (m._quote)
    lines.push(
      `  <quote id=${quoteAttr(m._quote.id)} sender_id=${quoteAttr(m._quote.sender_id)} sender_name=${quoteAttr(m._quote.sender_name)}>${xmlEscape(m._quote.content)}</quote>`,
    );
  lines.push(`  <time>${xmlEscape(ts(m))}</time>`);
  lines.push(`  <content>${xmlEscape(m.content || '')}</content>`);
  lines.push('</message>');
  return lines.join('\n');
}

/** 一个会话边界一条 FIFO 队列，消息逐条交给 agent，保证同一会话里的回复不乱序。 */
class SessionWorker {
  readonly queue: AgentMessage[] = [];
  private running = false;

  constructor(
    private readonly dispatcher: AgentDispatcher,
    private readonly sessionKey: string,
  ) {}

  push(msg: AgentMessage): void {
    this.queue.push(msg);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let msg = this.queue.shift(); msg; msg = this.queue.shift()) {
        try {
          await this.dispatcher.handleMessage(this.sessionKey, msg);
        } catch (err) {
          logger.error(`处理消息异常 [${this.sessionKey}]: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** 数字人分发：按触发规则筛消息、按会话边界排队，支持 /clear（开新会话）与 /stop（清空排队）。 */
export class AgentDispatcher {
  private readonly workers = new Map<string, SessionWorker>();
  private tagChats: Set<string> | null = null;

  /** LARKX_TRIGGER_INCLUDE_TAGS 解析出的会话（这些标签里的 chat_id）。 */
  setTagChats(chatIds: Iterable<string>): void {
    this.tagChats = new Set(chatIds);
  }

  constructor(
    private readonly backend: AgentBackend,
    private readonly replyFn: ReplyFn,
    readonly cfg: Config = loadConfig(),
  ) {}

  sessionKeyOf(msg: LarkMessage): string {
    const scope = this.cfg.context_scope;
    if (scope === 'global') return 'global';
    if (scope === 'chat') return String(msg.chat_id);
    return `${msg.chat_id}:${msg.anchor || ''}`;
  }

  shouldHandle(msg: LarkMessage, myUserId: string): boolean {
    if (String(msg.from_id) === String(myUserId)) return false;
    const t = this.cfg.triggers;
    const content = (msg.content || '').trim();
    const chatId = String(msg.chat_id);
    const senderId = String(msg.from_id);
    const typeName =
      ({ 1: 'p2p', 2: 'group', 3: 'topic_group' } as Record<number, string>)[msg.chat_type] ?? '';
    if (t.prefix && !content.startsWith(t.prefix)) return false;
    if (t.chat_types.length && !t.chat_types.includes(typeName)) return false;
    if (t.include_chats.length && !t.include_chats.map(String).includes(chatId)) return false;
    if (t.exclude_chats.length && t.exclude_chats.map(String).includes(chatId)) return false;
    if (t.include_senders.length && !t.include_senders.map(String).includes(senderId)) return false;
    // 标签里的会话由 listen 解析后经 setTagChats 给进来；还没解析到时宁可不处理
    if (t.include_tags.length && !this.tagChats?.has(chatId)) return false;
    if (t.keywords.length && !t.keywords.some((kw) => content.includes(kw))) return false;
    if (t.group_at_only && (typeName === 'group' || typeName === 'topic_group') && !msg.at_me)
      return false;
    return true;
  }

  async submit(
    msg: LarkMessage,
    chatName = '',
    senderName = '',
    myUserId = '',
    quote?: QuotedMessage,
  ): Promise<void> {
    if (!this.shouldHandle(msg, myUserId)) return;
    const [cmd, remainder] = this.parseCommand(msg.content || '');
    const key = this.sessionKeyOf(msg);
    const chatId = String(msg.chat_id);
    const rootId = msg.anchor || undefined;
    if (cmd === 'clear') {
      this.drainQueue(key);
      await this.backend.resetSession(key);
      if (!remainder) {
        await this.replyFn(chatId, '✅ 已开启新会话', rootId);
        return;
      }
    } else if (cmd === 'stop') {
      const n = this.drainQueue(key);
      if (!remainder) {
        await this.replyFn(chatId, n ? `⏹ 已清空 ${n} 条排队消息` : '⏹ 队列已清空', rootId);
        return;
      }
    }
    const item: AgentMessage = {
      ...msg,
      _chat_name: chatName,
      _sender_name: senderName,
      ...(quote ? { _quote: quote } : {}),
    };
    if (cmd) item.content = remainder ?? '';
    this.enqueue(item);
  }

  /** 对方撤回了消息：还在排队的那条不再交给 agent。返回撤下的条数。 */
  withdraw(msgId: string): number {
    let n = 0;
    for (const w of this.workers.values())
      for (let i = w.queue.length - 1; i >= 0; i--)
        if (w.queue[i]?.msg_id === msgId) {
          w.queue.splice(i, 1);
          n++;
        }
    return n;
  }

  /**
   * 对方编辑了消息：还在排队的直接换成新内容；已经处理过的作为一条新消息再交给 agent，并标明是编辑后的内容。
   * 同样经过触发规则筛选。
   */
  async revise(msg: LarkMessage, chatName = '', senderName = '', myUserId = ''): Promise<void> {
    if (!this.shouldHandle(msg, myUserId)) return;
    for (const w of this.workers.values()) {
      const queued = w.queue.find((m) => m.msg_id === msg.msg_id);
      if (queued) {
        queued.content = msg.content;
        queued.content_data = msg.content_data;
        return;
      }
    }
    this.enqueue({ ...msg, _chat_name: chatName, _sender_name: senderName, _edited: true });
  }

  /**
   * 对方对我发的消息加 / 取消了表情：作为一条事件交给 agent（被加表情的消息放在 quote 里）。
   * 会话、发送人的筛选照常生效；前缀、关键词、群里只认 @我 这几条针对消息内容，表情事件不受它们限制。
   */
  async submitReaction(
    ev: { message_id: string; reaction_type: string; user_id: string; cancelled: boolean },
    target: LarkMessage,
    quote: QuotedMessage,
    chatName = '',
    senderName = '',
    myUserId = '',
  ): Promise<void> {
    const msg: LarkMessage = {
      ...target,
      msg_id: `reaction:${ev.message_id}:${ev.reaction_type}:${ev.user_id}`,
      from_id: ev.user_id,
      at_me: true,
      content: '',
      content_data: null,
      parent_id: ev.message_id,
    };
    const t = { ...this.cfg.triggers, prefix: '', keywords: [], group_at_only: false };
    const filter = new AgentDispatcher(this.backend, this.replyFn, { ...this.cfg, triggers: t });
    if (this.tagChats) filter.setTagChats(this.tagChats);
    if (!filter.shouldHandle(msg, myUserId)) return;
    this.enqueue({
      ...msg,
      _chat_name: chatName,
      _sender_name: senderName,
      _quote: quote,
      _reaction: { type: ev.reaction_type, cancelled: ev.cancelled },
    });
  }

  private enqueue(item: AgentMessage): void {
    const key = this.sessionKeyOf(item);
    let worker = this.workers.get(key);
    if (!worker) {
      worker = new SessionWorker(this, key);
      this.workers.set(key, worker);
    }
    worker.push(item);
  }

  /** `/clear`、`/stop`（可跟在触发前缀之后）；返回 [命令, 余下内容]，不是命令为 [null, null]。 */
  parseCommand(content: string): [string | null, string | null] {
    const prefix = this.cfg.triggers.prefix;
    let c = content.trim();
    if (prefix && c.startsWith(prefix)) c = c.slice(prefix.length).trimStart();
    for (const cmd of ['/clear', '/stop']) {
      if (c === cmd) return [cmd.slice(1), ''];
      if (
        c.startsWith(cmd) &&
        c.length > cmd.length &&
        [' ', '\t', '\n'].includes(c[cmd.length] as string)
      )
        return [cmd.slice(1), c.slice(cmd.length).trim()];
    }
    return [null, null];
  }

  private drainQueue(key: string): number {
    const w = this.workers.get(key);
    if (!w) return 0;
    return w.queue.splice(0).length;
  }

  async handleMessage(sessionKey: string, msg: AgentMessage): Promise<void> {
    const body = buildXmlMessage(msg);
    const chatId = String(msg.chat_id);
    const rootId = msg.anchor || '';
    let replyCmd = `lark send ${chatId} "<回复内容>"`;
    if (rootId) replyCmd += ` --root ${rootId}`;
    const rules = `要回复就执行: ${replyCmd}\n${OUTPUT_RULES}`;
    const instructions = `${this.cfg.system_prompt || INSTRUCTIONS}\n${rules}`;
    const out = await this.backend.run(
      sessionKey,
      `${body}\n\n${instructions}`,
      chatId,
      msg.anchor || '',
    );
    if (out) logger.debug(`[${sessionKey}] agent 输出: ${head(out, 200)}`);
  }
}
