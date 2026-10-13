import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getBackend } from '../agent/backend.js';
import { AgentDispatcher, type QuotedMessage } from '../agent/dispatcher.js';
import { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from '../auth.js';
import { LarkClient, type SendOptions } from '../client.js';
import { dataDir, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import { download, extractResourceKey, messageResourceUrl } from '../media.js';
import type { RichBlock } from '../proto/builders.js';
import { type LarkMessage, MSG_TYPE_NAMES } from '../proto/decoders.js';
import { type Dict, parseJsonKeepingBigInts } from '../proto/dict.js';
import { getRegion, REGIONS, type Region, urls } from '../region.js';
import { Storage } from '../storage/index.js';
import { head, preview } from '../text.js';
import type { CommandSpec, Option, Parsed } from './args.js';
import { errorText, printJson, pyDatetime, shortTime } from './format.js';
import { keepListening } from './listen-loop.js';
import { qrAscii, saveQrPng } from './qr.js';
import { parseTimeArg } from './time.js';

const logger = getLogger('larkx.cli');

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const s = (v: Parsed[string]) => (v === undefined ? undefined : String(v));

export interface Command extends CommandSpec {
  run(args: Parsed): Promise<number>;
}

const client = async () => LarkClient.create(new LarkAuth());

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** 扫码登录：最多刷新 6 次二维码，每次等 45 秒。 */
async function qrLogin(auth: LarkAuth, region: Region): Promise<number> {
  mkdirSync(dataDir(), { recursive: true });
  const pngPath = join(dataDir(), 'login_qr.png');
  for (let attempt = 1; attempt <= 6; attempt++) {
    let ql: QrLogin;
    try {
      ql = await QrLogin.start(region);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    await saveQrPng(ql.qrContent, pngPath);
    out(`[${attempt}/6] 二维码已刷新(请用 ${region.label} App 扫码): ${pngPath}`);
    if (attempt === 1) out(qrAscii(ql.qrContent));
    const [ok] = await ql.wait(45, 2, (status, step) =>
      out(
        `状态: ${status === undefined ? 'None' : (QR_STATUS_NAMES[status] ?? status)} (${step ?? 'None'})`,
      ),
    );
    if (ok) {
      try {
        out(`登录成功,凭证已保存: ${await ql.finish(auth)}`);
        return 0;
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
    }
    out('当前二维码已失效,自动刷新...');
  }
  err('多次刷新后仍未完成登录,请重试');
  return 1;
}

const auth: Command = {
  name: 'auth',
  help: '凭证管理',
  positionals: [{ name: 'action', choices: ['status', 'import', 'check', 'qr'] }],
  options: [
    { name: 'cookie', kind: 'string', help: '直接传 cookie 串' },
    { name: 'file', kind: 'string', help: '从文件读 cookie' },
    {
      name: 'region',
      kind: 'string',
      choices: Object.keys(REGIONS),
      help: 'qr/import 登录的区域: feishu=飞书(国内版) lark=Lark(国际版);默认沿用已有凭证,无凭证时取 LARKX_REGION',
    },
  ],
  async run(a) {
    const action = String(a.action);
    const la = new LarkAuth();
    // 新登录的区域：--region > 已有凭证的区域 > LARKX_REGION
    const region = a.region ? getRegion(String(a.region)) : la.region;
    if (action === 'status') {
      printJson(la.status());
      return 0;
    }
    if (action === 'import') {
      let cookieStr: string;
      if (a.cookie) cookieStr = String(a.cookie);
      else if (a.file) cookieStr = readFileSync(String(a.file), 'utf8');
      else {
        logger.info('请粘贴 cookie 串,回车结束:');
        cookieStr = await readLine('');
      }
      try {
        out(`导入成功(${region.name}): ${await la.importCookieString(cookieStr, region)}`);
        return 0;
      } catch (e) {
        err(`导入失败: ${(e as Error).message}`);
        return 1;
      }
    }
    if (action === 'check') {
      const [ok, msg] = await la.validate(true);
      if (ok) la.save();
      out(`${ok ? 'OK ' : 'EXPIRED '}${msg}`);
      return ok ? 0 : 1;
    }
    return qrLogin(la, region);
  },
};

const NAMES_OPTION: Option = {
  name: 'names',
  kind: 'flag',
  help: '发送者显示为名字(--json 时多一个 from_name)',
};

const REPLY_OPTIONS: Option[] = [
  { name: 'root', kind: 'string', help: '话题/线程根消息 id,回复进话题' },
  { name: 'reply', kind: 'string', help: '引用回复某条消息 id(被引用消息在话题里时自动进话题)' },
  {
    name: 'cid',
    kind: 'string',
    help: '消息的客户端 id(幂等键):同一个 cid 重发拿到的是同一条消息,不会发重',
  },
];

const send: Command = {
  name: 'send',
  help: '发送文本消息',
  positionals: [{ name: 'chat_id' }, { name: 'text', nargs: '+' }],
  options: [
    ...REPLY_OPTIONS,
    { name: 'links', kind: 'flag', help: '把文本里的 [文字](url) 发成带文字的超链接' },
    {
      name: 'post',
      kind: 'flag',
      help: '按富文本发送:text 是 HTML 片段(<p><b><a href><ul><li><blockquote><at user_id>)',
    },
    {
      name: 'md',
      kind: 'flag',
      help: '按 Markdown 发送(标题、列表、代码块、引用、加粗斜体、链接),客户端按 Markdown 渲染',
    },
    { name: 'title', kind: 'string', help: '富文本标题(配合 --post / --md)' },
    {
      name: 'rich',
      kind: 'string',
      help: '结构化富文本 JSON(或 @文件路径),text 作为纯文本摘要;blocks: p/ul/quote/blank,run: text|link|at',
    },
  ],
  async run(a) {
    const c = await client();
    const st = new Storage();
    const chatId = String(a.chat_id);
    const text = (a.text as string[]).join(' ');
    const o = await replyTarget(st, chatId, a);
    let msgId: string | null;
    if (a.rich) {
      const raw = String(a.rich);
      const spec = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as {
        blocks?: RichBlock[];
      };
      msgId = await c.sendRich(spec.blocks ?? [], text, chatId, o);
    } else if (a.md) {
      try {
        msgId = await c.sendMessage(chatId, { markdown: text, title: s(a.title) ?? '' }, o);
      } catch (e) {
        logger.error(`发送 Markdown 失败: ${errorText(e)}`);
        msgId = null;
      }
    } else if (a.post) {
      msgId = await c.sendPost(text, chatId, s(a.title) ?? '', o);
    } else {
      msgId = await c.sendMsg(text, chatId, o, Boolean(a.links));
    }
    const rich = Boolean(a.post || a.rich || a.md);
    return finishSend(st, c, chatId, msgId, o, rich ? 2 : 4, text);
  },
};

/** --root / --reply → 发送选项；被引用的消息若在话题里，引用要带上话题根，否则会落回主会话。 */
async function replyTarget(st: Storage, chatId: string, a: Parsed): Promise<SendOptions> {
  const reply = s(a.reply);
  let rootId = s(a.root);
  if (reply && !rootId) {
    const quoted = await st.getMessage(reply, chatId);
    if (quoted?.scope === 'topic' && quoted.anchor) rootId = quoted.anchor;
  }
  return { rootId, replyTo: reply, cid: s(a.cid) };
}

/** 发送结果：成功时用服务端 id 落库（监听收到回显时会补全这条而不是再插一条）并打印 msg_id。 */
async function finishSend(
  st: Storage,
  c: LarkClient,
  chatId: string,
  msgId: string | null,
  o: SendOptions,
  msgType: number,
  content: string,
): Promise<number> {
  if (!msgId) {
    await st.close();
    err('发送失败');
    return 1;
  }
  const { rootId, replyTo: reply } = o;
  const inTopic = Boolean(rootId) && rootId !== reply;
  await st.saveMessage(
    {
      msg_id: msgId,
      chat_id: chatId,
      chat_type: 0,
      chat_type_name: '',
      scope: inTopic ? 'topic' : 'chat',
      anchor: inTopic ? (rootId as string) : '',
      root_id: rootId || reply || '',
      parent_id: reply || rootId || '',
      from_id: c.auth.userId,
      msg_type: msgType,
      msg_type_name: MSG_TYPE_NAMES[msgType] ?? String(msgType),
      at_me: false,
      cid: '',
      position: null,
      content,
      content_data: null,
      create_time: Math.floor(Date.now() / 1000),
    },
    { senderName: '我', direction: 'out' },
  );
  await st.close();
  out(`已发送 msg_id=${msgId}`);
  return 0;
}

/** 发送图片或文件：读本地文件，上传后发出。 */
function mediaCommand(kind: 'image' | 'file'): Command {
  const label = kind === 'image' ? '图片' : '文件';
  return {
    name: `send-${kind}`,
    help: `发送${label}(本地文件,自动上传)`,
    positionals: [{ name: 'chat_id' }, { name: 'path' }],
    options: REPLY_OPTIONS,
    async run(a) {
      const c = await client();
      const st = new Storage();
      const chatId = String(a.chat_id);
      const path = String(a.path);
      const name = basename(path);
      let data: Uint8Array;
      try {
        data = new Uint8Array(readFileSync(path));
      } catch (e) {
        await st.close();
        err(`读取文件失败: ${(e as Error).message}`);
        return 1;
      }
      const o = await replyTarget(st, chatId, a);
      let msgId: string | null = null;
      try {
        msgId = await c.sendMessage(
          chatId,
          kind === 'image' ? { image: data, name } : { file: data, name },
          o,
        );
      } catch (e) {
        logger.error(`发送${label}失败: ${errorText(e)}`);
      }
      return finishSend(st, c, chatId, msgId, o, kind === 'image' ? 5 : 3, `[${label}] ${name}`);
    },
  };
}

const recall: Command = {
  name: 'recall',
  help: '撤回消息(自己发的;群管理员可撤回群里别人的)',
  positionals: [{ name: 'message_ids', nargs: '+' }],
  async run(a) {
    const c = await client();
    let failed = 0;
    for (const id of a.message_ids as string[]) {
      try {
        await c.recallMessage(id);
        out(`已撤回 msg_id=${id}`);
      } catch (e) {
        failed++;
        err(`撤回 ${id} 失败: ${errorText(e)}`);
      }
    }
    return failed ? 1 : 0;
  },
};

const edit: Command = {
  name: 'edit',
  help: '编辑自己发的文本/富文本消息(整条替换,对方看到"已编辑")',
  positionals: [{ name: 'msg_id' }, { name: 'text', nargs: '+' }],
  options: [
    { name: 'links', kind: 'flag', help: '把文本里的 [文字](url) 发成带文字的超链接' },
    { name: 'md', kind: 'flag', help: '按 Markdown 改写;原消息须是富文本' },
    {
      name: 'rich',
      kind: 'string',
      help: '结构化富文本 JSON(或 @文件路径),text 作为纯文本摘要;原消息须是富文本',
    },
  ],
  async run(a) {
    const c = await client();
    const id = String(a.msg_id);
    const text = (a.text as string[]).join(' ');
    try {
      if (a.rich) {
        const raw = String(a.rich);
        const spec = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as {
          blocks?: RichBlock[];
        };
        await c.editMessage(id, { blocks: spec.blocks ?? [], text });
      } else if (a.md) await c.editMessage(id, { markdown: text });
      else await c.editMessage(id, { text, links: Boolean(a.links) });
    } catch (e) {
      err(`编辑失败: ${errorText(e)}`);
      return 1;
    }
    out(`已编辑 msg_id=${id}`);
    return 0;
  },
};

const react: Command = {
  name: 'react',
  help: '给消息加表情回复(如 THUMBSUP、OK、DONE、SMILE);--remove 去掉',
  positionals: [{ name: 'msg_id' }, { name: 'reaction_type' }],
  options: [{ name: 'remove', kind: 'flag', help: '去掉自己加的这个表情' }],
  async run(a) {
    const c = await client();
    const id = String(a.msg_id);
    const type = String(a.reaction_type);
    try {
      if (a.remove) await c.removeReaction(id, type);
      else await c.addReaction(id, type);
    } catch (e) {
      err(`${a.remove ? '去掉' : '添加'}表情失败: ${errorText(e)}`);
      return 1;
    }
    out(`已${a.remove ? '去掉' : '添加'}表情 ${type} msg_id=${id}`);
    return 0;
  },
};

const reactions: Command = {
  name: 'reactions',
  help: '查看消息上的表情回复',
  positionals: [{ name: 'message_ids', nargs: '+' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const list = await (await client()).reactions(a.message_ids as string[]);
    if (a.json) printJson(list);
    else
      for (const m of list)
        for (const r of m.reactions)
          out(`${m.messageId}\t${r.type}\t${r.count}\t${r.userIds.join(',')}`);
    return 0;
  },
};

const readStatus: Command = {
  name: 'read-status',
  help: '消息的已读情况:谁读了、谁没读(发送方视角);--me 看我自己是否读过',
  positionals: [{ name: 'chat_id' }, { name: 'message_ids', nargs: '+' }],
  options: [
    { name: 'me', kind: 'flag', help: '看我自己是否读过这些消息' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const ids = a.message_ids as string[];
    if (a.me) {
      const mine = await c.myReadStates(ids);
      if (a.json) printJson(Object.fromEntries(mine));
      else
        for (const [id, t] of mine) out(`${id}\t${t === null ? '未读' : `已读 ${shortTime(t)}`}`);
      return 0;
    }
    const states = await c.readStates(String(a.chat_id), ids);
    const names = a.names
      ? await c.userNames(states.flatMap((st) => [...st.readUserIds, ...st.unreadUserIds]))
      : undefined;
    const who = (ids2: string[]) => ids2.map((id) => names?.get(id) || id).join(',');
    if (a.json) printJson(states);
    else
      for (const st of states)
        out(
          `${st.messageId}\t已读 ${st.readCount}\t未读 ${st.unreadCount}${st.unreadUserIds.length ? `\t未读: ${who(st.unreadUserIds)}` : ''}`,
        );
    return 0;
  },
};

const messageLink: Command = {
  name: 'message-link',
  help: '生成消息链接(applink client/message/link/open?token=...);多个消息 id 生成一个合并链接',
  positionals: [{ name: 'chat_id' }, { name: 'message_ids', nargs: '+' }],
  async run(a) {
    const url = await (await client()).messageLink(String(a.chat_id), a.message_ids as string[]);
    if (!url) {
      err('生成消息链接失败');
      return 1;
    }
    out(url);
    return 0;
  },
};

const selfChat: Command = {
  name: 'self-chat',
  help: '打印当前账号与自己的会话 chat_id(可用于 lark send 给自己留言)',
  async run() {
    const cid = await (await client()).selfChat();
    if (!cid) {
      err('获取自聊会话失败');
      return 1;
    }
    out(cid);
    return 0;
  },
};

const read: Command = {
  name: 'read',
  help: '把消息标为已读(同客户端看过:未读推进到其中最新一条,发送方看到已读;话题回复按话题标记)',
  positionals: [{ name: 'chat_id' }, { name: 'message_ids', nargs: '+' }],
  async run(a) {
    const c = await client();
    try {
      out(`已读 ${await c.readMessages(String(a.chat_id), a.message_ids as string[])} 条`);
      return 0;
    } catch (e) {
      err(`标记已读失败: ${(e as Error).message}`);
      return 1;
    }
  },
};

const config: Command = {
  name: 'config',
  help: '查看生效中的配置(配置项写在 .env 里)',
  async run() {
    printJson(loadConfig());
    return 0;
  },
};

const CHAT_TYPE_LABELS: Record<number, string> = { 1: '私聊', 2: '群聊', 3: '话题群' };

const chats: Command = {
  name: 'chats',
  help: '列出本地会话',
  options: [{ name: 'limit', kind: 'int', default: 50 }],
  async run(a) {
    const st = new Storage();
    for (const c of await st.listChats(Number(a.limit)))
      out(
        `${c.chat_id}\t${CHAT_TYPE_LABELS[c.chat_type] ?? '?'}\t${c.name || '(未命名)'}\t更新于 ${pyDatetime(c.updated_at)}`,
      );
    await st.close();
    return 0;
  },
};

const sessions: Command = {
  name: 'sessions',
  help: '列出 agent 会话(session 表)',
  options: [{ name: 'limit', kind: 'int', default: 50 }],
  async run(a) {
    const st = new Storage();
    for (const r of await st.listSessions(Number(a.limit))) {
      const scope = r.anchor ? '话题' : r.session_key === 'global' ? '全局' : '会话';
      out(
        `${r.session_key}\t${scope}\tchat=${r.chat_id}\tanchor=${r.anchor || '-'}\t${r.started ? '已建立' : '待建立'}\tmsg=${r.msg_count}\t活跃于 ${pyDatetime(r.last_active)}`,
      );
    }
    await st.close();
    return 0;
  },
};

const messages: Command = {
  name: 'messages',
  help: '读本地消息记录',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'anchor', kind: 'string', help: '话题 id;空字符串=仅主会话流' },
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const st = new Storage();
    const rows = await st.getMessages(String(a.chat_id), {
      anchor: s(a.anchor),
      limit: Number(a.limit),
    });
    await st.close();
    if (a.json) {
      printJson(rows.map((r) => ({ ...r, stored_at: pyDatetime(r.stored_at) })));
      return 0;
    }
    for (const r of rows) {
      const scope = r.anchor ? `[${r.scope}:${head(r.anchor, 8)}]` : '';
      out(
        `[${shortTime(r.create_time)}]${scope} ${r.sender_name || r.sender_id}: ${preview(r.content || '', 120)}`,
      );
    }
    return 0;
  },
};

const search: Command = {
  name: 'search',
  help: '搜索用户/群',
  positionals: [{ name: 'query', nargs: '+' }],
  async run(a) {
    printJson(await (await client()).search((a.query as string[]).join(' ')));
    return 0;
  },
};

const api: Command = {
  name: 'api',
  help: '调任意网关接口(类型名见 docs/cmd_table.md)',
  positionals: [
    { name: 'type', help: 'proto 请求类型名(如 chats.PullChatsByIdsRequest)或 cmd 数字' },
    { name: 'json_body', nargs: '?', help: '请求字段 JSON' },
  ],
  async run(a) {
    const c = await client();
    let data: Dict | null = null;
    if (a.json_body) {
      try {
        data = parseJsonKeepingBigInts(String(a.json_body)) as Dict;
      } catch (e) {
        err(`JSON 解析失败: ${(e as Error).message}`);
        return 1;
      }
    }
    let resp: Dict;
    try {
      resp = await c.api(String(a.type), data);
    } catch (e) {
      err(errorText(e));
      return 1;
    }
    printJson(resp);
    return 0;
  },
};

/**
 * 拉取结果的输出（history / get / thread 共用）：一行一条，或 --json 时去掉 content_data 的完整字段。
 * names 给出时（--names）发送者显示为名字，--json 多一个 from_name。
 */
function printMessages(msgs: LarkMessage[], json: boolean, names?: Map<string, string>): void {
  if (json) {
    printJson(
      msgs.map(({ content_data: _, ...rest }) =>
        names ? { ...rest, from_name: names.get(rest.from_id) ?? '' } : rest,
      ),
    );
    return;
  }
  for (const m of msgs) {
    const scope = m.anchor ? `[${m.scope}:${head(m.anchor, 8)}]` : '';
    const sender = names?.get(m.from_id) || m.from_id;
    out(
      `${String(m.position).padStart(6)} [${shortTime(m.create_time)}]${scope} ${sender}: ${preview(m.content || '', 120)}`,
    );
  }
}

/** --names 时查发送者名字；查不到的照旧显示 id。 */
async function senderNames(
  c: LarkClient,
  msgs: LarkMessage[],
  want: boolean,
): Promise<Map<string, string> | undefined> {
  if (!want) return undefined;
  try {
    return await c.userNames(msgs.map((m) => m.from_id));
  } catch (e) {
    logger.warning(`查发送者名字失败: ${errorText(e)}`);
    return new Map();
  }
}

const list = (v: Parsed[string]) =>
  v === undefined
    ? undefined
    : String(v)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

const searchMessages: Command = {
  name: 'search-messages',
  help: '跨会话搜消息(同客户端搜索框的"消息")',
  positionals: [{ name: 'query', nargs: '+' }],
  options: [
    { name: 'chat', kind: 'string', help: '只搜这些会话(chat_id,逗号分隔)' },
    { name: 'from', kind: 'string', help: '只搜这些人发的(user_id,逗号分隔)' },
    {
      name: 'since',
      kind: 'string',
      help: '起始时间:30m/2h/3d/1w、2026-10-01、2026-10-01 09:30 或时间戳',
    },
    { name: 'until', kind: 'string', help: '截止时间(格式同 --since)' },
    { name: 'limit', kind: 'int', default: 20 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    let since: number | undefined;
    let until: number | undefined;
    try {
      since = a.since === undefined ? undefined : parseTimeArg(String(a.since));
      until = a.until === undefined ? undefined : parseTimeArg(String(a.until));
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const hits = await (await client()).searchMessages((a.query as string[]).join(' '), {
      chatIds: list(a.chat),
      fromIds: list(a.from),
      since,
      until,
      limit: Number(a.limit),
    });
    if (a.json) printJson(hits);
    else
      for (const h of hits)
        out(
          `${h.msgId} [${shortTime(h.createTime)}] ${h.chatId}(${h.chatTitle}) ${preview(h.summary, 120)}`,
        );
    return 0;
  },
};

const unread: Command = {
  name: 'unread',
  help: '未读:默认列出有未读的会话;--chat 看某会话的未读消息;--at 只看 @我 的未读消息',
  options: [
    { name: 'chat', kind: 'string', help: '只看这个会话的未读消息' },
    { name: 'at', kind: 'flag', help: '各会话里 @我(或 @所有人)的未读消息' },
    {
      name: 'since',
      kind: 'string',
      help: '只看这之后有变动的会话(默认 30d;格式同 search-messages)',
    },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    let since: number | undefined;
    try {
      since = a.since === undefined ? undefined : parseTimeArg(String(a.since));
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const c = await client();
    if (a.chat || a.at) {
      const msgs = a.chat ? await c.unreadMessages(String(a.chat)) : await c.unreadMentions(since);
      printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
      return 0;
    }
    const chats = await c.unreadChats(since);
    if (a.json) printJson(chats);
    else
      for (const u of chats)
        out(
          `${u.chatId}\t${CHAT_TYPE_LABELS[u.threadChat ? 3 : u.chatType] ?? '?'}\t${u.name || '(未命名)'}\t未读 ${u.unread}${u.unreadThreads ? `,新话题 ${u.unreadThreads}` : ''}`,
        );
    return 0;
  },
};

const members: Command = {
  name: 'members',
  help: '列出会话成员(id、名字、类型 user/bot)',
  positionals: [{ name: 'chat_id' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const list = await (await client()).chatMembers(String(a.chat_id));
    if (a.json) printJson(list);
    else for (const m of list) out(`${m.id}\t${m.name}\t${m.type}`);
    return 0;
  },
};

const users: Command = {
  name: 'users',
  help: '按用户 id 查名字(批量)',
  positionals: [{ name: 'user_ids', nargs: '+' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const ids = a.user_ids as string[];
    const names = await (await client()).userNames(ids);
    if (a.json) printJson(Object.fromEntries(names));
    else for (const id of ids) if (names.has(id)) out(`${id}\t${names.get(id)}`);
    const missing = ids.filter((id) => !names.has(id));
    if (missing.length) err(`查不到: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
  },
};

const getCmd: Command = {
  name: 'get',
  help: '按消息 id 取消息(可跨会话;引用回复的原文、链接里的消息都能取)',
  positionals: [{ name: 'message_ids', nargs: '+' }],
  options: [
    { name: 'save', kind: 'flag', help: '同时写入本地库' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const ids = a.message_ids as string[];
    const c = await client();
    const msgs = await c.getMessages(ids);
    await saveAll(msgs, Boolean(a.save));
    printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
    const missing = ids.filter((id) => !msgs.some((m) => m.msg_id === id));
    if (missing.length) err(`找不到消息: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
  },
};

const thread: Command = {
  name: 'thread',
  help: '拉取一个话题:根消息加最近的回复',
  positionals: [{ name: 'root_id', help: '话题根消息 id(即消息的 anchor)' }],
  options: [
    { name: 'count', kind: 'int', default: 50, help: '最多取多少条回复' },
    { name: 'save', kind: 'flag', help: '同时写入本地库' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const msgs = await c.threadMessages(String(a.root_id), Number(a.count));
    if (!msgs.length) {
      err(`找不到话题根消息: ${a.root_id}`);
      return 1;
    }
    await saveAll(msgs, Boolean(a.save));
    printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
    return 0;
  },
};

async function saveAll(msgs: LarkMessage[], save: boolean): Promise<void> {
  if (!save) return;
  const st = new Storage();
  for (const m of msgs) await st.saveMessage(m).catch(() => {});
  await st.close();
}

const history: Command = {
  name: 'history',
  help: '拉取会话历史消息',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'start', kind: 'int', help: '起始 position(默认从最新往前)' },
    { name: 'count', kind: 'int', default: 20 },
    {
      name: 'since',
      kind: 'string',
      help: '只要这之后的消息(30m/2h/3d、2026-10-01 09:30 或时间戳;取范围内最新的 count 条)',
    },
    { name: 'until', kind: 'string', help: '只要这之前的消息(格式同 --since)' },
    { name: 'save', kind: 'flag', help: '同时写入本地库' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    const count = Number(a.count);
    if (a.since !== undefined || a.until !== undefined) {
      let since: number | undefined;
      let until: number | undefined;
      try {
        since = a.since === undefined ? undefined : parseTimeArg(String(a.since));
        until = a.until === undefined ? undefined : parseTimeArg(String(a.until));
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
      const st = a.save ? new Storage() : undefined;
      const msgs = await c.historyRange(
        chatId,
        { since, until, limit: count },
        st ? (m: LarkMessage) => st.saveMessage(m) : undefined,
      );
      await st?.close();
      printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
      if (a.save) out(`已入库 ${msgs.length} 条`);
      return 0;
    }
    let start: number;
    if (a.start !== undefined) start = Number(a.start);
    else {
      const info = await c.getChatInfo(chatId);
      if (!info?.lastMessagePosition) {
        err('拿不到会话的最新 position,请用 --start 指定');
        return 1;
      }
      start = Number(info.lastMessagePosition) - count + 1;
      if (info.name) {
        const st = new Storage();
        await st.updateChatName(
          chatId,
          String(info.name),
          typeof info.type === 'number' ? info.type : 0,
        );
        await st.close();
      }
    }
    const first = Math.max(1, start);
    const positions = Array.from({ length: count }, (_, i) => first + i);
    const st = a.save ? new Storage() : undefined;
    const msgs = await c.pullHistory(
      chatId,
      positions,
      st ? (m: LarkMessage) => st.saveMessage(m) : undefined,
    );
    await st?.close();
    printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
    if (a.save) out(`已入库 ${msgs.length} 条`);
    return 0;
  },
};

const downloadCmd: Command = {
  name: 'download',
  help: '下载消息里的图片/文件等资源',
  positionals: [{ name: 'msg_id', nargs: '?', help: '消息 id(从本地库查资源 key)' }],
  options: [
    { name: 'key', kind: 'string', help: '直接指定资源 key(img_v3_*/file_v3_*),需配合 --chat' },
    { name: 'chat', kind: 'string', help: 'chat_id(配合 --key 或加速本地查找)' },
    { name: 'out', short: '-o', kind: 'string', required: true, help: '保存路径' },
  ],
  async run(a) {
    const la = new LarkAuth();
    await la.requireValid();
    const fileHost = urls.fileHost(la.region);
    const msgId = s(a.msg_id);
    let url: string;
    if (a.key) {
      if (!a.chat) {
        err('--key 需要配合 --chat <chat_id>');
        return 1;
      }
      url = messageResourceUrl(msgId || '0', String(a.key), String(a.chat), fileHost);
    } else {
      const st = new Storage();
      const rows = a.chat
        ? (await st.getMessages(String(a.chat), { limit: 500 })).filter((r) => r.msg_id === msgId)
        : await st.findMessages(String(msgId));
      await st.close();
      const r = rows.at(-1);
      let found:
        | Pick<LarkMessage, 'msg_id' | 'chat_id' | 'msg_type' | 'msg_type_name' | 'content_data'>
        | undefined;
      if (r?.content_data) found = { ...r, content_data: JSON.parse(r.content_data) as Dict };
      else if (msgId) {
        // 本地没有（或是 lark send 先落的、没有内容的记录）：向服务端按 id 取
        const c = await LarkClient.create(la);
        found = (await c.getMessages([msgId]))[0];
      }
      if (!found) {
        err(`未找到消息 ${msgId}(可用 --key/--chat 直接指定)`);
        return 1;
      }
      const key = extractResourceKey(found.msg_type, found.content_data);
      if (!key) {
        err(`消息 ${msgId} 类型为 ${found.msg_type_name},没有可下载资源`);
        return 1;
      }
      url = messageResourceUrl(found.msg_id, key, found.chat_id, fileHost);
    }
    const [path, contentType, n] = await download(la, url, String(a.out));
    out(`已下载: ${path} (${contentType}, ${n} 字节)`);
    return 0;
  },
};

async function askLoginChoice(): Promise<'qr' | 'cookie' | 'quit'> {
  out('  [1] 扫码登录(推荐)');
  out('  [2] 粘贴 cookie 登录');
  out('  [q] 退出');
  const c = (await readLine('选择: ')).trim().toLowerCase();
  return c === '1' ? 'qr' : c === '2' ? 'cookie' : 'quit';
}

/** 凭证有效直接用；失效时在终端里交互重登（扫码或粘贴 cookie），非交互环境直接抛 AuthExpired。 */
async function interactiveLogin(): Promise<LarkAuth> {
  const la = new LarkAuth();
  const [ok, msg] = await la.validate(true);
  if (ok) {
    la.save();
    return la;
  }
  if (!process.stdin.isTTY) throw new AuthExpired(msg);
  out(
    `凭证缺失或已失效(区域: ${la.region.name},切换区域用 lark auth qr --region <feishu|lark>): ${msg}`,
  );
  for (;;) {
    const choice = await askLoginChoice();
    if (choice === 'qr') {
      if ((await qrLogin(la, la.region)) === 0) {
        const fresh = new LarkAuth();
        if ((await fresh.validate())[0]) return fresh;
      }
    } else if (choice === 'cookie') {
      const cookieStr = (await readLine('粘贴完整 cookie 后回车: ')).trim();
      try {
        await la.importCookieString(cookieStr);
        return la;
      } catch (e) {
        out(`导入失败: ${(e as Error).message}`);
      }
    } else process.exit(1);
  }
}

async function listenOnce(agentEnabled: boolean, la: LarkAuth): Promise<never> {
  const c = await LarkClient.create(la);
  const st = new Storage();
  if (agentEnabled && !la.userId) {
    await la.fetchProfile();
    la.save();
  }
  if (agentEnabled && !la.userId) {
    err(
      '无法确定当前账号 user_id,--agent 存在自回环风险,已拒绝启动。请先 lark auth check 确认凭证有效。',
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  const line = '─'.repeat(56);
  out(line);
  out(
    `LarkAgentX 启动  region=${la.region.name}  user=${la.userId}  device=${head(la.deviceId, 12)}…`,
  );
  out(`  存储: ${cfg.storage_url}`);
  out(
    `  上下文边界: ${cfg.context_scope}  agent后端: ${cfg.agent_backend}${agentEnabled ? '  (已启用)' : '  (未启用,仅入库)'}`,
  );
  out(
    `  触发前缀: ${cfg.triggers.prefix || '(全部消息)'}  自定义提示词: ${cfg.system_prompt ? '有' : '无'}`,
  );
  out(line);
  const dispatcher = agentEnabled
    ? new AgentDispatcher(await getBackend(undefined, st), (chatId, text, rootId) =>
        c.sendMsg(text, chatId, { rootId }),
      )
    : null;
  const names = new Map<string, string | null>();
  /** 回复（引用或话题回复）所接的那条消息：先查本地库，没有再向服务端取；取不到时不带。 */
  const quoted = async (msg: LarkMessage): Promise<QuotedMessage | undefined> => {
    const pid = msg.parent_id;
    if (!pid || pid === '0' || pid === msg.msg_id) return undefined;
    const row = await st.getMessage(pid, msg.chat_id);
    if (row?.content)
      return {
        id: pid,
        sender_id: row.sender_id,
        sender_name: row.sender_name,
        content: row.content,
      };
    try {
      const [m] = await c.getMessages([pid]);
      if (!m) return undefined;
      const key = `${m.from_id}\u0000${msg.chat_id}`;
      if (!names.has(key)) names.set(key, await c.getUserName(m.from_id, msg.chat_id));
      return {
        id: pid,
        sender_id: m.from_id,
        sender_name: names.get(key) || '',
        content: m.content,
      };
    } catch (e) {
      logger.debug(`取被引用消息失败: ${errorText(e)}`);
      return undefined;
    }
  };
  const onMessage = async (msg: LarkMessage) => {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type ?? 0;
    const isOwn = String(msg.from_id) === String(la.userId);
    const senderKey = `${msg.from_id}\u0000${chatId}`;
    if (!names.has(senderKey)) names.set(senderKey, await c.getUserName(msg.from_id, chatId));
    const senderName = names.get(senderKey) || '';
    if (!names.has(chatId)) {
      if (chatType === 2 || chatType === 3) {
        const name = await c.getGroupName(chatId);
        names.set(chatId, name);
        if (name) await st.updateChatName(chatId, name, chatType);
      } else if (chatType === 1 && !isOwn && senderName) {
        names.set(chatId, senderName);
        await st.updateChatName(chatId, senderName, chatType);
      }
    }
    const chatName = names.get(chatId) || '';
    const who = `[${chatName || chatId}] ${senderName || msg.from_id}`;
    // 撤回与编辑以同一条消息重推：撤回的不再交给 agent；编辑过的更新库里的内容，并让 agent 看到新内容
    if (msg.recalled) {
      dispatcher?.withdraw(msg.msg_id);
      if (await st.markRecalled(msg.msg_id, chatId)) logger.info(`${who} 撤回了一条消息`);
      return;
    }
    if (msg.edited && (await st.reviseMessage(msg))) {
      logger.info(`${who} 编辑了消息: ${preview(msg.content || '', 80)}`);
      await dispatcher?.revise(msg, chatName, senderName, la.userId);
      return;
    }
    const saved = await st.saveMessage(msg, {
      senderName,
      chatName,
      direction: isOwn ? 'out' : 'in',
    });
    if (!saved) return;
    const shown = `${who}: ${preview(msg.content || '', 80)}`;
    logger.info(isOwn && process.stderr.isTTY ? `\x1b[36m${shown}\x1b[0m` : shown);
    if (cfg.mark_read && !isOwn && msg.position)
      await c.markRead(chatId, msg.position, [msg.msg_id]);
    if (dispatcher) {
      const quote = dispatcher.shouldHandle(msg, la.userId) ? await quoted(msg) : undefined;
      await dispatcher.submit(msg, chatName, senderName, la.userId, quote);
    }
  };
  await keepListening(c, onMessage, {
    missed: (since) =>
      c.missedMessages(since, {
        localPosition: (chatId) => st.lastPosition(chatId),
        knownThreads: (chatId) => st.recentAnchors(chatId),
      }),
  });
  throw new Error('长连接循环意外退出');
}

const listen: Command = {
  name: 'listen',
  help: '常驻接收消息',
  options: [{ name: 'agent', kind: 'flag', help: '接本地 coding agent 自动回复' }],
  async run(a) {
    process.on('SIGINT', () => {
      out('\n已停止');
      process.exit(0);
    });
    for (;;) {
      try {
        await listenOnce(Boolean(a.agent), await interactiveLogin());
      } catch (e) {
        if (!(e instanceof AuthExpired)) throw e;
        if (!process.stdin.isTTY) {
          err(e.message);
          return 1;
        }
        out(`运行中凭证失效: ${e.message}`);
      }
    }
  },
};

export const COMMANDS: Command[] = [
  auth,
  send,
  mediaCommand('image'),
  mediaCommand('file'),
  recall,
  edit,
  react,
  reactions,
  readStatus,
  messageLink,
  selfChat,
  read,
  config,
  chats,
  sessions,
  messages,
  search,
  searchMessages,
  unread,
  members,
  users,
  api,
  history,
  getCmd,
  thread,
  downloadCmd,
  listen,
];
