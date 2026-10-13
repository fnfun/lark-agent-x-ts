import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getBackend } from '../agent/backend.js';
import { AgentDispatcher } from '../agent/dispatcher.js';
import { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from '../auth.js';
import { LarkClient } from '../client.js';
import { dataDir, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import { download, extractResourceKey, messageResourceUrl } from '../media.js';
import type { RichBlock } from '../proto/builders.js';
import type { LarkMessage } from '../proto/decoders.js';
import { type Dict, parseJsonKeepingBigInts } from '../proto/dict.js';
import { getRegion, REGIONS, type Region, urls } from '../region.js';
import { Storage } from '../storage/index.js';
import { head, preview } from '../text.js';
import type { CommandSpec, Parsed } from './args.js';
import { errorText, printJson, pyDatetime, shortTime } from './format.js';
import { qrAscii, saveQrPng } from './qr.js';

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

const send: Command = {
  name: 'send',
  help: '发送文本消息',
  positionals: [{ name: 'chat_id' }, { name: 'text', nargs: '+' }],
  options: [
    { name: 'root', kind: 'string', help: '话题/线程根消息 id,回复进话题' },
    { name: 'reply', kind: 'string', help: '引用回复某条消息 id(被引用消息在话题里时自动进话题)' },
    { name: 'links', kind: 'flag', help: '把文本里的 [文字](url) 发成带文字的超链接' },
    {
      name: 'post',
      kind: 'flag',
      help: '按富文本发送:text 是 HTML 片段(<p><b><a href><ul><li><blockquote><at user_id>)',
    },
    { name: 'title', kind: 'string', help: '富文本标题(配合 --post)' },
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
    const reply = s(a.reply);
    let rootId = s(a.root);
    if (reply && !rootId) {
      // 被引用的消息若在话题里，引用要带上话题根，否则会落回主会话
      const quoted = await st.getMessage(reply, chatId);
      if (quoted?.scope === 'topic' && quoted.anchor) rootId = quoted.anchor;
    }
    const o = { rootId, replyTo: reply };
    let msgId: string | null;
    if (a.rich) {
      const raw = String(a.rich);
      const spec = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as {
        blocks?: RichBlock[];
      };
      msgId = await c.sendRich(spec.blocks ?? [], text, chatId, o);
    } else if (a.post) {
      msgId = await c.sendPost(text, chatId, s(a.title) ?? '', o);
    } else {
      msgId = await c.sendMsg(text, chatId, o, Boolean(a.links));
    }
    if (msgId) {
      const inTopic = Boolean(rootId) && rootId !== reply;
      const rich = Boolean(a.post || a.rich);
      // 用服务端 id 落库，监听收到回显时会补全这条而不是再插一条
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
          msg_type: rich ? 2 : 4,
          msg_type_name: rich ? 'POST' : 'TEXT',
          at_me: false,
          cid: '',
          position: null,
          content: text,
          content_data: null,
          create_time: Math.floor(Date.now() / 1000),
        },
        { senderName: '我', direction: 'out' },
      );
      await st.close();
      out(`已发送 msg_id=${msgId}`);
      return 0;
    }
    await st.close();
    err('发送失败');
    return 1;
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

const history: Command = {
  name: 'history',
  help: '拉取会话历史消息',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'start', kind: 'int', help: '起始 position(默认从最新往前)' },
    { name: 'count', kind: 'int', default: 20 },
    { name: 'save', kind: 'flag', help: '同时写入本地库' },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    const count = Number(a.count);
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
    if (!a.json) {
      for (const m of msgs) {
        const scope = m.anchor ? `[${m.scope}:${head(m.anchor, 8)}]` : '';
        out(
          `${String(m.position).padStart(6)} [${shortTime(m.create_time)}]${scope} ${m.from_id}: ${preview(m.content || '', 120)}`,
        );
      }
    } else {
      printJson(msgs.map(({ content_data: _, ...rest }) => rest));
    }
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
      if (!r) {
        err(`本地未找到消息 ${msgId}(可用 --key/--chat 直接指定)`);
        return 1;
      }
      const contentData = r.content_data ? (JSON.parse(r.content_data) as Dict) : null;
      const key = extractResourceKey(r.msg_type, contentData);
      if (!key) {
        err(`消息 ${msgId} 类型为 ${r.msg_type_name},没有可下载资源`);
        return 1;
      }
      url = messageResourceUrl(r.msg_id, key, r.chat_id, fileHost);
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
    const saved = await st.saveMessage(msg, {
      senderName,
      chatName,
      direction: isOwn ? 'out' : 'in',
    });
    if (!saved) return;
    const shown = `[${chatName || chatId}] ${senderName || msg.from_id}: ${preview(msg.content || '', 80)}`;
    logger.info(isOwn && process.stderr.isTTY ? `\x1b[36m${shown}\x1b[0m` : shown);
    if (cfg.mark_read && !isOwn && msg.position)
      await c.markRead(chatId, msg.position, [msg.msg_id]);
    if (dispatcher) await dispatcher.submit(msg, chatName, senderName, la.userId);
  };
  for (;;) {
    try {
      await c.connectWebsocket(onMessage);
    } catch (e) {
      if (e instanceof AuthExpired) throw e;
      logger.warning(`WS 断开,10s 后重连: ${(e as Error).message}`);
      await Bun.sleep(10_000);
    }
  }
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
  messageLink,
  selfChat,
  read,
  config,
  chats,
  sessions,
  messages,
  search,
  api,
  history,
  downloadCmd,
  listen,
];
