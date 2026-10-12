import { type Config, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import type { LarkMessage } from '../proto/decoders.js';
import { head } from '../text.js';
import type { AgentBackend } from './backend.js';

const logger = getLogger('larkx.agent');

export const INSTRUCTIONS =
  '以上是飞书会话里新到的一条消息(XML 里有会话/发送者/内容)。你是这个数字人,完整对话历史你都有。如果对方也是机器人且只是互相客套寒暄,直接结束不要再接话。';
export const OUTPUT_RULES = '不需要回复就直接结束,不要解释、不要复述消息。';

/** 交给 agent 的消息：解码结果加上会话名、发送者名。 */
export interface AgentMessage extends LarkMessage {
  _chat_name?: string;
  _sender_name?: string;
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
  readonly cfg: Config = loadConfig();
  private readonly workers = new Map<string, SessionWorker>();

  constructor(
    private readonly backend: AgentBackend,
    private readonly replyFn: ReplyFn,
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
    if (t.keywords.length && !t.keywords.some((kw) => content.includes(kw))) return false;
    if (t.group_at_only && (typeName === 'group' || typeName === 'topic_group') && !msg.at_me)
      return false;
    return true;
  }

  async submit(msg: LarkMessage, chatName = '', senderName = '', myUserId = ''): Promise<void> {
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
    const item: AgentMessage = { ...msg, _chat_name: chatName, _sender_name: senderName };
    if (cmd) item.content = remainder ?? '';
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
