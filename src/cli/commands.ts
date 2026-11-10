import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getBackend } from '../agent/backend.js';
import { AgentDispatcher, type QuotedMessage } from '../agent/dispatcher.js';
import { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from '../auth.js';
import {
  ATTACHMENT_TYPES,
  type AttachmentType,
  type ChatInfo,
  type ChatSummary,
  LarkClient,
  type MessageReactions,
  type SenderType,
  type SendOptions,
  type UserProfile,
} from '../client.js';
import { dataDir, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import { download, extractResourceKey, messageResourceUrl } from '../media.js';
import {
  decide,
  GROUPS,
  type Group,
  loadRules,
  PERMISSIONS,
  type Permission,
  permissionsPath,
  saveAccountRules,
} from '../permissions.js';
import type { RichBlock } from '../proto/builders.js';
import {
  CHAT_TYPE_NAMES,
  type LarkMessage,
  MSG_TYPE_NAMES,
  type ReactionEvent,
} from '../proto/decoders.js';
import { type Dict, parseJsonKeepingBigInts } from '../proto/dict.js';
import { getRegion, REGIONS, type Region, urls } from '../region.js';
import { Storage } from '../storage/index.js';
import { head, preview } from '../text.js';
import type { CommandSpec, Option, Parsed } from './args.js';
import { errorText, printJson, pyDatetime, shortTime } from './format.js';
import { keepListening } from './listen-loop.js';
import { editInTerminal, PermissionEditor } from './permissions-editor.js';
import { qrAscii, saveQrPng } from './qr.js';
import { parseTimeArg } from './time.js';

const logger = getLogger('larkx.cli');

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const s = (v: Parsed[string]) => (v === undefined ? undefined : String(v));

export interface Command extends CommandSpec {
  /**
   * The matching permission (see src/permissions.ts); commands that both read and write pick
   * `command.action` from their arguments.
   */
  access: Permission | ((args: Parsed) => Permission);
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

/** QR-code login: refreshes the QR code up to 6 times, waiting 45 seconds each. */
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
  access: (a) => `auth.${a.action as 'status' | 'import' | 'check' | 'qr'}`,
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
    // Region for the new login: --region > the existing credentials' region > LARKX_REGION
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

/** The chat_id positional of commands that also take `user:<user_id>`. */
const CHAT_TARGET = {
  name: 'chat_id',
  help: '会话 id;写成 user:<user_id> 表示与该用户的私聊(没有时自动创建)',
};

/**
 * chat_id arguments also take `user:<user_id>`, meaning the direct chat with that user; prints the
 * error and returns null when it cannot be resolved.
 */
async function chatTarget(c: LarkClient, raw: Parsed[string]): Promise<string | null> {
  const v = String(raw);
  if (!v.startsWith('user:')) return v;
  try {
    return await c.directChat(v.slice('user:'.length));
  } catch (e) {
    err(`找不到私聊: ${errorText(e)}`);
    return null;
  }
}

const send: Command = {
  name: 'send',
  help: '发送文本消息',
  access: 'send',
  positionals: [CHAT_TARGET, { name: 'text', nargs: '+' }],
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
      name: 'attach',
      kind: 'string',
      metavar: 'PATHS',
      help: '配合 --md:把这些本地文件放进消息的附件区(逗号分隔)',
    },
    {
      name: 'rich',
      kind: 'string',
      help: '结构化富文本 JSON(或 @文件路径),text 作为纯文本摘要;blocks: p/ul/quote/blank,run: text|link|at',
    },
  ],
  async run(a) {
    if (a.attach && !a.md) {
      err('--attach 需要配合 --md');
      return 2;
    }
    const c = await client();
    const chatId = await chatTarget(c, a.chat_id);
    if (chatId === null) return 1;
    const st = new Storage();
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
        const attachments = (list(a.attach) ?? []).map((path) => ({
          data: new Uint8Array(readFileSync(path)),
          name: basename(path),
        }));
        msgId = await c.sendMessage(
          chatId,
          { markdown: text, title: s(a.title) ?? '', imageDir: process.cwd(), attachments },
          o,
        );
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

/**
 * --root / --reply → send options; if the quoted message is in a thread, the quote must carry the
 * thread root, otherwise it lands back in the main chat.
 */
async function replyTarget(st: Storage, chatId: string, a: Parsed): Promise<SendOptions> {
  const reply = s(a.reply);
  let rootId = s(a.root);
  if (reply && !rootId) {
    const quoted = await st.getMessage(reply, chatId);
    if (quoted?.scope === 'topic' && quoted.anchor) rootId = quoted.anchor;
  }
  return { rootId, replyTo: reply, cid: s(a.cid) };
}

/**
 * Send result: on success, saves to the local database under the server id (when the listener
 * receives the echo it completes this row instead of inserting another) and prints msg_id.
 */
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

/** Sends an image or file: reads the local file, uploads it, then sends it. */
const MEDIA_KINDS = {
  image: { label: '图片', msgType: 5, help: '发送图片(本地文件,自动上传)' },
  file: { label: '文件', msgType: 3, help: '发送文件(本地文件,自动上传)' },
  video: {
    label: '视频',
    msgType: 15,
    help: '发送视频(本地 MP4,自动上传;时长从文件读取,--cover 指定封面图)',
  },
  audio: {
    label: '语音',
    msgType: 7,
    help: '发送语音(本地 Ogg/Opus 文件,即客户端录音的格式;时长从文件读取)',
  },
} as const;

/** Sends an image, file, video or voice message: reads the local file, uploads it, then sends it. */
function mediaCommand(kind: keyof typeof MEDIA_KINDS): Command {
  const { label, msgType, help } = MEDIA_KINDS[kind];
  return {
    name: `send-${kind}`,
    help,
    access: `send-${kind}`,
    positionals: [CHAT_TARGET, { name: 'path' }],
    options:
      kind === 'video'
        ? [...REPLY_OPTIONS, { name: 'cover', kind: 'string', help: '封面图片路径' }]
        : REPLY_OPTIONS,
    async run(a) {
      const c = await client();
      const chatId = await chatTarget(c, a.chat_id);
      if (chatId === null) return 1;
      const path = String(a.path);
      const name = basename(path);
      let data: Uint8Array;
      let cover: Uint8Array | undefined;
      try {
        data = new Uint8Array(readFileSync(path));
        if (a.cover) cover = new Uint8Array(readFileSync(String(a.cover)));
      } catch (e) {
        err(`读取文件失败: ${(e as Error).message}`);
        return 1;
      }
      const st = new Storage();
      const o = await replyTarget(st, chatId, a);
      let msgId: string | null = null;
      try {
        msgId = await c.sendMessage(
          chatId,
          kind === 'image'
            ? { image: data, name }
            : kind === 'file'
              ? { file: data, name }
              : kind === 'video'
                ? { video: data, name, ...(cover ? { cover } : {}) }
                : { audio: data },
          o,
        );
      } catch (e) {
        logger.error(`发送${label}失败: ${errorText(e)}`);
      }
      return finishSend(st, c, chatId, msgId, o, msgType, `[${label}] ${name}`);
    },
  };
}

const schedule: Command = {
  name: 'schedule',
  help: '定时发送消息(到点由服务端发出)',
  access: 'schedule',
  positionals: [CHAT_TARGET, { name: 'text', nargs: '+' }],
  options: [
    {
      name: 'at',
      kind: 'string',
      required: true,
      help: '发送时间:10m/2h/1d 后、2026-10-15 09:30 或时间戳',
    },
    ...REPLY_OPTIONS,
    { name: 'md', kind: 'flag', help: '按 Markdown 发送' },
  ],
  async run(a) {
    let at: number;
    try {
      at = parseTimeArg(String(a.at), Date.now(), true);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    if (at <= Date.now()) {
      err('发送时间要晚于现在');
      return 1;
    }
    const c = await client();
    const chatId = await chatTarget(c, a.chat_id);
    if (chatId === null) return 1;
    const st = new Storage();
    const text = (a.text as string[]).join(' ');
    const o = await replyTarget(st, chatId, a);
    await st.close();
    try {
      const id = await c.scheduleMessage(chatId, a.md ? { markdown: text } : { text }, at, o);
      out(`已定时 msg_id=${id} 发送时间 ${shortTime(Math.floor(at / 1000))}`);
      return 0;
    } catch (e) {
      err(`定时发送失败: ${errorText(e)}`);
      return 1;
    }
  },
};

const scheduled: Command = {
  name: 'scheduled',
  help: '会话里还没发出的定时消息;--cancel 取消,--reschedule 配合 --at 改时间',
  access: (a) =>
    a.cancel ? 'scheduled.cancel' : a.reschedule ? 'scheduled.reschedule' : 'scheduled.list',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'cancel', kind: 'string', metavar: 'MSG_ID', help: '取消这条定时消息' },
    { name: 'reschedule', kind: 'string', metavar: 'MSG_ID', help: '改这条定时消息的发送时间' },
    { name: 'at', kind: 'string', help: '新的发送时间(配合 --reschedule)' },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    try {
      if (a.cancel) {
        await c.cancelScheduledMessage(chatId, String(a.cancel));
        out(`已取消定时消息 msg_id=${a.cancel}`);
        return 0;
      }
      if (a.reschedule) {
        if (!a.at) {
          err('--reschedule 需要配合 --at');
          return 2;
        }
        const at = parseTimeArg(String(a.at), Date.now(), true);
        await c.rescheduleMessage(chatId, String(a.reschedule), at);
        out(`已改为 ${shortTime(Math.floor(at / 1000))} 发送 msg_id=${a.reschedule}`);
        return 0;
      }
    } catch (e) {
      err(`操作失败: ${errorText(e)}`);
      return 1;
    }
    const list = await c.scheduledMessages(chatId);
    if (a.json)
      printJson(list.map(({ message, ...m }) => ({ ...m, content: message?.content ?? '' })));
    else
      for (const m of list)
        out(
          `${m.messageId} [${shortTime(Math.floor(m.at / 1000))}]${m.status === 'suspended' ? '(已暂停)' : ''} ${preview(m.message?.content || '', 100)}`,
        );
    return 0;
  },
};

const translate: Command = {
  name: 'translate',
  help: '翻译文本;--msg 时参数是消息 id,翻译这些消息',
  access: 'translate',
  positionals: [{ name: 'args', nargs: '+', help: '要翻译的文本(--msg 时为消息 id)' }],
  options: [
    { name: 'to', kind: 'string', default: 'zh', help: '目标语言(zh、en、ja 等,默认 zh)' },
    { name: 'msg', kind: 'flag', help: '参数是消息 id' },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const args = a.args as string[];
    const to = String(a.to);
    try {
      if (a.msg) {
        const list = await c.translateMessages(args, to);
        if (a.json) printJson(list);
        else for (const t of list) out(`${t.msgId}\t${t.translated}`);
        const missing = args.filter((id) => !list.some((t) => t.msgId === id));
        if (missing.length) err(`没有可翻译的内容: ${missing.join(', ')}`);
        return 0;
      }
      const [translated] = await c.translateText([args.join(' ')], to);
      out(String(translated));
      return 0;
    } catch (e) {
      err(`翻译失败: ${errorText(e)}`);
      return 1;
    }
  },
};

const forward: Command = {
  name: 'forward',
  help: '把一条消息转发到一个或多个会话;--thread 时 msg_id 是话题根消息,转发整个话题',
  access: 'forward',
  positionals: [{ name: 'msg_id' }, { name: 'chat_ids', nargs: '+' }],
  options: [{ name: 'thread', kind: 'flag', help: '转发整个话题(根消息加全部回复)' }],
  async run(a) {
    const targets = a.chat_ids as string[];
    let sent: Map<string, string>;
    try {
      const c = await client();
      sent = a.thread
        ? await c.forwardThread(String(a.msg_id), targets)
        : await c.forwardMessage(String(a.msg_id), targets);
    } catch (e) {
      err(`转发失败: ${errorText(e)}`);
      return 1;
    }
    for (const chatId of targets)
      if (sent.has(chatId)) out(`已转发 chat_id=${chatId} msg_id=${sent.get(chatId)}`);
      else err(`转发到 ${chatId} 失败`);
    return sent.size === targets.length ? 0 : 1;
  },
};

const GROUP_ACTIONS = [
  'info',
  'create',
  'add',
  'remove',
  'rename',
  'nickname',
  'admins',
  'admin',
  'moderation',
  'requests',
  'link',
] as const;

const group: Command = {
  name: 'group',
  help: '群管理:info <chat_id> 群信息、create <群名> 建群、add/remove <chat_id> <user_id...> 拉人/移出、rename <chat_id> <新群名>、nickname <chat_id> [昵称] 我的群昵称、admins <chat_id> 列出管理员、admin <chat_id> <user_id...> 设管理员(--remove 取消)、moderation <chat_id> anyone|admins|whitelist 发言权限、requests <chat_id> 入群申请(--approve/--reject)、link <chat_id> 分享链接',
  access: (a) => {
    const action = String(a.action);
    if (action === 'requests' && (a.approve || a.reject)) return 'group.approve';
    return `group.${action}` as Permission;
  },
  positionals: [
    { name: 'action', choices: GROUP_ACTIONS },
    { name: 'args', nargs: '+' },
  ],
  options: [
    { name: 'members', kind: 'string', help: 'create 时一起拉进群的人(user_id,逗号分隔)' },
    { name: 'desc', kind: 'string', help: '群描述(create / rename)' },
    { name: 'topic', kind: 'flag', help: 'create 时建话题群' },
    {
      name: 'remove',
      kind: 'string',
      metavar: 'USER_IDS',
      help: 'admin:取消这些人的管理员;moderation:移出发言白名单(逗号分隔)',
    },
    {
      name: 'add',
      kind: 'string',
      metavar: 'USER_IDS',
      help: 'moderation whitelist:加入发言白名单(逗号分隔)',
    },
    {
      name: 'approve',
      kind: 'string',
      metavar: 'USER_IDS',
      help: 'requests:同意这些人入群(逗号分隔)',
    },
    {
      name: 'reject',
      kind: 'string',
      metavar: 'USER_IDS',
      help: 'requests:拒绝这些人入群(逗号分隔)',
    },
    { name: 'days', kind: 'int', default: 7, help: 'link:有效天数(客户端可选 7、30、365)' },
    { name: 'forever', kind: 'flag', help: 'link:永久有效' },
    { name: 'json', kind: 'flag', help: 'info / admins / requests 输出 JSON' },
  ],
  async run(a) {
    const c = await client();
    const [first, ...rest] = a.args as string[];
    const target = String(first);
    try {
      switch (a.action) {
        case 'info': {
          const info = await c.chatInfo(target);
          if (!info) {
            err(`找不到会话: ${target}`);
            return 1;
          }
          printChatInfo(info, Boolean(a.json), await c.userNames([info.ownerId]));
          return 0;
        }
        case 'nickname':
          await c.setGroupNickname(target, rest.join(' '));
          out(rest.length ? `已设置群昵称 chat_id=${target}` : `已清除群昵称 chat_id=${target}`);
          return 0;
        case 'admins': {
          const ids = await c.chatAdmins(target);
          const names = await c.userNames(ids);
          if (a.json) printJson(ids.map((id) => ({ id, name: names.get(id) ?? '' })));
          else for (const id of ids) out(`${id}\t${names.get(id) ?? ''}`);
          return 0;
        }
        case 'admin': {
          const remove = list(a.remove) ?? [];
          if (!rest.length && !remove.length) {
            err('需要 user_id(或 --remove)');
            return 2;
          }
          await c.updateAdmins(target, rest, remove);
          out(`已更新管理员 chat_id=${target}`);
          return 0;
        }
        case 'moderation': {
          const type = rest[0];
          if (type !== 'anyone' && type !== 'admins' && type !== 'whitelist') {
            err('需要发言权限: anyone / admins / whitelist');
            return 2;
          }
          await c.setPostPermission(target, type, {
            add: list(a.add) ?? [],
            remove: list(a.remove) ?? [],
          });
          out(`已设置发言权限 ${POST_TYPE_LABELS[type]} chat_id=${target}`);
          return 0;
        }
        case 'requests': {
          const approve = list(a.approve) ?? [];
          const reject = list(a.reject) ?? [];
          if (approve.length || reject.length) {
            for (const id of approve) await c.handleJoinRequest(target, id, true);
            for (const id of reject) await c.handleJoinRequest(target, id, false);
            out(`已处理入群申请:同意 ${approve.length} 人,拒绝 ${reject.length} 人`);
            return 0;
          }
          const reqs = await c.joinRequests(target);
          if (a.json) printJson(reqs);
          else
            for (const r of reqs)
              out(
                `${r.userId}\t${JOIN_STATUS_LABELS[r.status]}\t${shortTime(r.time)}\t${r.via}${r.inviterId ? `\t邀请人 ${r.inviterId}` : ''}${r.reason ? `\t${r.reason}` : ''}`,
              );
          return 0;
        }
        case 'link': {
          const link = await c.chatShareLink(target, {
            days: Number(a.days),
            forever: Boolean(a.forever),
          });
          out(
            link.expireTime
              ? `${link.url}\t有效期至 ${shortTime(link.expireTime)}`
              : `${link.url}\t永久有效`,
          );
          return 0;
        }
        case 'create': {
          const id = await c.createGroup([target, ...rest].join(' '), list(a.members) ?? [], {
            ...(a.desc ? { description: String(a.desc) } : {}),
            topic: Boolean(a.topic),
          });
          out(`已建群 chat_id=${id}`);
          return 0;
        }
        case 'add':
        case 'remove':
          if (!rest.length) {
            err('需要 user_id');
            return 2;
          }
          if (a.action === 'add') await c.addMembers(target, rest);
          else await c.removeMembers(target, rest);
          out(`已${a.action === 'add' ? '拉进' : '移出'} ${rest.length} 人 chat_id=${target}`);
          return 0;
        default:
          if (!rest.length && !a.desc) {
            err('需要新群名或 --desc');
            return 2;
          }
          await c.updateGroup(target, {
            ...(rest.length ? { name: rest.join(' ') } : {}),
            ...(a.desc ? { description: String(a.desc) } : {}),
          });
          out(`已更新 chat_id=${target}`);
          return 0;
      }
    } catch (e) {
      err(`群操作失败: ${errorText(e)}`);
      return 1;
    }
  },
};

const JOIN_STATUS_LABELS = {
  pending: '待审批',
  approved: '已同意',
  rejected: '已拒绝',
  unknown: '未知',
} as const;

const POST_TYPE_LABELS = {
  anyone: '所有人',
  admins: '仅群主和管理员',
  whitelist: '指定成员',
  unknown: '未知',
} as const;

function printChatInfo(info: ChatInfo, json: boolean, names: Map<string, string>): void {
  if (json) {
    printJson(info);
    return;
  }
  const role = info.owner ? '群主' : info.admin ? '管理员' : '成员';
  const owner = info.ownerId ? `${info.ownerId}(${names.get(info.ownerId) ?? '?'})` : '-';
  for (const [k, v] of [
    ['chat_id', info.chatId],
    ['名称', info.name || '(未命名)'],
    ['类型', CHAT_KIND_LABELS[info.type]],
    ['描述', info.description || '-'],
    ['群主', owner],
    ['人数', String(info.memberCount)],
    ['创建于', info.createTime ? shortTime(info.createTime) : '-'],
    ['我的身份', role],
    ['发言权限', POST_TYPE_LABELS[info.postType]],
    ['免打扰', info.muted ? (info.muteAtAll ? '是(含 @所有人)' : '是') : '否'],
    ['公开群', info.public ? '是' : '否'],
    ['外部群', info.crossTenant ? '是' : '否'],
  ])
    out(`${k}\t${v}`);
}

const pin: Command = {
  name: 'pin',
  help: 'Pin 一条消息到会话(会话成员都看得到);--remove 取消 Pin',
  access: 'pin',
  positionals: [{ name: 'chat_id' }, { name: 'msg_id' }],
  options: [{ name: 'remove', kind: 'flag', help: '取消 Pin' }],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    const msgId = String(a.msg_id);
    try {
      if (a.remove) {
        if (!(await c.unpinMessage(chatId, msgId))) {
          err(`消息 ${msgId} 没有被 Pin`);
          return 1;
        }
        out(`已取消 Pin msg_id=${msgId}`);
      } else out(`已 Pin msg_id=${msgId} pin_id=${await c.pinMessage(chatId, msgId)}`);
      return 0;
    } catch (e) {
      err(`Pin 操作失败: ${errorText(e)}`);
      return 1;
    }
  },
};

const pins: Command = {
  name: 'pins',
  help: '列出会话里被 Pin 的消息',
  access: 'pins',
  positionals: [{ name: 'chat_id' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const list = await (await client()).chatPins(String(a.chat_id));
    if (a.json)
      printJson(
        list.map(({ message, ...p }) => {
          if (!message) return { ...p, message: null };
          const { content_data: _, ...rest } = message;
          return { ...p, message: rest };
        }),
      );
    else
      for (const p of list)
        out(
          `${p.messageId} [${shortTime(Math.floor(p.pinnedAt / 1000))}] ${p.message ? `${p.message.from_id}: ${preview(p.message.content || '', 100)}` : ''}`,
        );
    return 0;
  },
};

const mute: Command = {
  name: 'mute',
  help: '会话免打扰(只影响自己);--remove 恢复提醒;--at-all 连 @所有人 也一起处理',
  access: 'mute',
  positionals: [{ name: 'chat_ids', nargs: '+' }],
  options: [
    { name: 'remove', kind: 'flag', help: '恢复提醒' },
    { name: 'at-all', kind: 'flag', help: '同时屏蔽(或恢复) @所有人 的提醒' },
  ],
  async run(a) {
    const ids = (a.chat_ids as string[]).flatMap((x) => list(x) ?? []);
    try {
      await (await client()).setMuted(ids, !a.remove, { atAll: Boolean(a.at_all) });
    } catch (e) {
      err(`免打扰设置失败: ${errorText(e)}`);
      return 1;
    }
    out(`已${a.remove ? '恢复提醒' : '设为免打扰'} ${ids.length} 个会话`);
    return 0;
  },
};

const shortcut: Command = {
  name: 'shortcut',
  help: '在会话列表里置顶会话(只影响自己);--remove 取消置顶;不带参数列出已置顶的',
  access: (a) =>
    !list(a.chat_ids)?.length ? 'shortcut.list' : a.remove ? 'shortcut.remove' : 'shortcut.add',
  positionals: [{ name: 'chat_ids', nargs: '?', help: '会话 id(逗号分隔)' }],
  options: [{ name: 'remove', kind: 'flag', help: '取消置顶' }],
  async run(a) {
    const c = await client();
    const ids = list(a.chat_ids);
    if (!ids?.length) {
      for (const id of await c.shortcuts()) out(id);
      return 0;
    }
    try {
      if (a.remove) await c.removeShortcuts(ids);
      else await c.addShortcuts(ids);
    } catch (e) {
      err(`置顶操作失败: ${errorText(e)}`);
      return 1;
    }
    out(`已${a.remove ? '取消置顶' : '置顶'} ${ids.length} 个会话`);
    return 0;
  },
};

const flag: Command = {
  name: 'flag',
  help: '标记消息(留给自己稍后处理);--chat 标记会话,--remove 取消标记',
  access: 'flag',
  positionals: [{ name: 'ids', nargs: '+', help: '消息 id(--chat 时为 chat_id)' }],
  options: [
    { name: 'chat', kind: 'flag', help: '标记的是会话' },
    { name: 'remove', kind: 'flag', help: '取消标记' },
  ],
  async run(a) {
    const c = await client();
    const ids = a.ids as string[];
    try {
      if (a.chat) await c.flagChats(ids, Boolean(a.remove));
      else await c.flagMessages(ids, Boolean(a.remove));
    } catch (e) {
      err(`标记失败: ${errorText(e)}`);
      return 1;
    }
    out(`已${a.remove ? '取消标记' : '标记'} ${ids.length} 个${a.chat ? '会话' : '消息'}`);
    return 0;
  },
};

const flags: Command = {
  name: 'flags',
  help: '列出我的标记(消息与会话)',
  access: 'flags',
  options: [
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const list = await (await client()).flags(Number(a.limit));
    if (a.json)
      printJson(
        list.map(({ message, ...f }) => {
          if (!message) return { ...f, message: null };
          const { content_data: _, ...rest } = message;
          return { ...f, message: rest };
        }),
      );
    else
      for (const f of list) {
        const m = f.message;
        out(
          f.type === 'chat'
            ? `会话 ${f.id}`
            : `消息 ${f.id} ${m ? `${m.chat_id} [${shortTime(m.create_time)}] ${m.from_id}: ${preview(m.content || '', 100)}` : ''}`,
        );
      }
    return 0;
  },
};

const recall: Command = {
  name: 'recall',
  help: '撤回消息(自己发的;群管理员可撤回群里别人的)',
  access: 'recall',
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
  access: 'edit',
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
  access: 'react',
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
  access: 'reactions',
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
  access: 'read-status',
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
  access: 'message-link',
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
  access: 'self-chat',
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
  access: 'read',
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
  access: 'config',
  async run() {
    printJson(loadConfig());
    return 0;
  },
};

const CHAT_TYPE_LABELS: Record<number, string> = { 1: '私聊', 2: '群聊', 3: '话题群' };

const chats: Command = {
  name: 'chats',
  help: '列出本地会话',
  access: 'chats',
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
  access: 'sessions',
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
  access: 'messages',
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
  access: 'search',
  positionals: [{ name: 'query', nargs: '+' }],
  async run(a) {
    printJson(await (await client()).search((a.query as string[]).join(' ')));
    return 0;
  },
};

const api: Command = {
  name: 'api',
  help: '调任意网关接口(类型名见 docs/cmd_table.md)',
  access: 'api',
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
 * Prints fetched messages (shared by history / get / thread): one per line, or with --json all
 * fields except content_data.
 * When names is given (--names), senders are shown by name, and --json adds a from_name.
 */
type ReactionsById = Map<string, MessageReactions['reactions']>;

function printMessages(
  msgs: LarkMessage[],
  json: boolean,
  names?: Map<string, string>,
  reactions?: ReactionsById,
): void {
  if (json) {
    printJson(
      msgs.map(({ content_data: _, ...rest }) => ({
        ...rest,
        ...(names ? { from_name: names.get(rest.from_id) ?? '' } : {}),
        ...(reactions ? { reactions: reactions.get(rest.msg_id) ?? [] } : {}),
      })),
    );
    return;
  }
  for (const m of msgs) {
    const scope = m.anchor ? `[${m.scope}:${head(m.anchor, 8)}]` : '';
    const sender = names?.get(m.from_id) || m.from_id;
    const rs = reactions?.get(m.msg_id) ?? [];
    const tail = rs.length ? ` {${rs.map((r) => `${r.type}×${r.count}`).join(' ')}}` : '';
    out(
      `${String(m.position).padStart(6)} [${shortTime(m.create_time)}]${scope} ${sender}: ${preview(m.content || '', 120)}${tail}`,
    );
  }
}

/** With --reactions, looks up the reactions on these messages (in batches of 50). */
async function messageReactions(
  c: LarkClient,
  msgs: LarkMessage[],
  want: boolean,
): Promise<ReactionsById | undefined> {
  if (!want) return undefined;
  const out: ReactionsById = new Map();
  const ids = msgs.map((m) => m.msg_id);
  for (let i = 0; i < ids.length; i += 50)
    for (const r of await c.reactions(ids.slice(i, i + 50))) out.set(r.messageId, r.reactions);
  return out;
}

/** With --names, looks up sender names; senders not found are still shown by id. */
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
  help: '跨会话搜消息(同客户端搜索框的"消息");关键词可省略,只按过滤条件搜',
  access: 'search-messages',
  positionals: [{ name: 'query', nargs: '*' }],
  options: [
    { name: 'chat', kind: 'string', help: '只搜这些会话(chat_id,逗号分隔)' },
    { name: 'from', kind: 'string', help: '只搜这些人发的(user_id,逗号分隔)' },
    { name: 'at-me', kind: 'flag', help: '只搜 @我 的消息(含 @所有人)' },
    { name: 'at', kind: 'string', help: '只搜 @ 了这些人的消息(user_id,逗号分隔)' },
    {
      name: 'attachment',
      kind: 'string',
      help: `只搜带这类附件的消息(逗号分隔:${Object.keys(ATTACHMENT_TYPES).join('/')})`,
    },
    { name: 'chat-type', kind: 'string', choices: ['group', 'p2p'], help: '只搜群聊或私聊' },
    { name: 'sender-type', kind: 'string', choices: ['user', 'bot'], help: '只搜人或机器人发的' },
    {
      name: 'exclude-sender-type',
      kind: 'string',
      choices: ['user', 'bot'],
      help: '排除人或机器人发的',
    },
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
    const attachments = list(a.attachment) ?? [];
    const bad = attachments.filter((t) => !(t in ATTACHMENT_TYPES));
    if (bad.length) {
      err(`不认识的附件类型: ${bad.join(', ')}(可用: ${Object.keys(ATTACHMENT_TYPES).join('/')})`);
      return 2;
    }
    const query = (a.query as string[]).join(' ');
    const filtered = [a.chat, a.from, a.since, a.until, a.at, a.attachment, a.chat_type].some(
      (v) => v !== undefined,
    );
    if (!query && !filtered && !a.at_me && !a.sender_type && !a.exclude_sender_type) {
      err('需要关键词或至少一个过滤条件');
      return 2;
    }
    const c = await client();
    const hits = await c.searchMessages(query, {
      chatIds: list(a.chat),
      fromIds: list(a.from),
      since,
      until,
      atIds: a.at_me ? [c.auth.userId, ...(list(a.at) ?? [])] : list(a.at),
      attachmentTypes: attachments as AttachmentType[],
      chatType: s(a.chat_type) as 'group' | 'p2p' | undefined,
      senderTypes: a.sender_type ? [String(a.sender_type) as SenderType] : undefined,
      excludeSenderTypes: a.exclude_sender_type
        ? [String(a.exclude_sender_type) as SenderType]
        : undefined,
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
  access: 'unread',
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
  access: 'members',
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
  access: 'users',
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

const user: Command = {
  name: 'user',
  help: '查看一个人的资料卡(名字、部门、邮箱、状态等,取决于租户设置与可见范围)',
  access: 'user',
  positionals: [{ name: 'user_id' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    let profile: UserProfile;
    try {
      profile = await (await client()).userProfile(String(a.user_id));
    } catch (e) {
      err(`查询资料失败: ${errorText(e)}`);
      return 1;
    }
    if (a.json) printJson(profile);
    else {
      out(`${profile.userId}\t${profile.name}`);
      for (const f of profile.fields) out(`${f.label}\t${f.value}`);
    }
    return 0;
  },
};

const LIMIT_OPTION: Option = { name: 'limit', kind: 'int', default: 20 };

const searchUsers: Command = {
  name: 'search-users',
  help: '搜人(同客户端搜索框的"联系人");关键词可省略,只按过滤条件列出',
  access: 'search-users',
  positionals: [{ name: 'query', nargs: '*' }],
  options: [
    { name: 'chatted', kind: 'flag', help: '只要聊过天的人' },
    { name: 'exclude-external', kind: 'flag', help: '排除外部(其他租户)用户' },
    { name: 'resigned', kind: 'flag', help: '只要已离职的人' },
    { name: 'enterprise-email', kind: 'flag', help: '只要有企业邮箱的人' },
    { name: 'ids', kind: 'string', help: '只在这些 user_id 里找(逗号分隔)' },
    LIMIT_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const hits = await (await client()).searchUsers((a.query as string[]).join(' '), {
      chatted: Boolean(a.chatted),
      excludeExternal: Boolean(a.exclude_external),
      resigned: Boolean(a.resigned),
      enterpriseEmail: Boolean(a.enterprise_email),
      userIds: list(a.ids),
      limit: Number(a.limit),
    });
    if (a.json) printJson(hits);
    else
      for (const h of hits)
        out(`${h.userId}\t${h.name}${h.crossTenant ? '(外部)' : ''}\t${h.description}`);
    return 0;
  },
};

const searchBots: Command = {
  name: 'search-bots',
  help: '搜机器人和智能体',
  access: 'search-bots',
  positionals: [{ name: 'query', nargs: '*' }],
  options: [
    { name: 'chat', kind: 'string', help: '只在这些会话里找(chat_id,逗号分隔)' },
    { name: 'chatted', kind: 'flag', help: '只要聊过天的' },
    LIMIT_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const hits = await (await client()).searchBots((a.query as string[]).join(' '), {
      chatIds: list(a.chat),
      chatted: Boolean(a.chatted),
      limit: Number(a.limit),
    });
    if (a.json) printJson(hits);
    else
      for (const h of hits)
        out(`${h.botId}\t${h.name}${h.agent ? '(智能体)' : ''}\t${h.description}`);
    return 0;
  },
};

const chatSearch: Command = {
  name: 'chat-search',
  help: '搜群(按群名,也匹配成员名);关键词可省略,只按过滤条件列出',
  access: 'chat-search',
  positionals: [{ name: 'query', nargs: '*' }],
  options: [
    { name: 'member', kind: 'string', help: '只要包含这些人的群(user_id,逗号分隔)' },
    { name: 'mode', kind: 'string', choices: ['group', 'topic'], help: '只要普通群或话题群' },
    {
      name: 'sort',
      kind: 'string',
      choices: ['active', 'created', 'members'],
      help: '排序:最近活跃、创建时间、人数(默认按相关度)',
    },
    LIMIT_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const hits = await (await client()).searchChats((a.query as string[]).join(' '), {
      memberIds: list(a.member),
      mode: s(a.mode) as 'group' | 'topic' | undefined,
      sort: s(a.sort) as 'active' | 'created' | 'members' | undefined,
      limit: Number(a.limit),
    });
    if (a.json) printJson(hits);
    else
      for (const h of hits)
        out(
          `${h.chatId}\t${h.mode === 'topic' ? '话题群' : '群聊'}\t${h.name}\t${h.memberCount} 人${h.member ? '' : '(未加入)'}`,
        );
    return 0;
  },
};

const CHAT_KIND_LABELS = { p2p: '私聊', group: '群聊', topic: '话题群' } as const;

const chatList: Command = {
  name: 'chat-list',
  help: '从服务端列出会话列表(最近活跃在前);本地记录见 chats',
  access: 'chat-list',
  options: [
    { name: 'type', kind: 'string', choices: ['p2p', 'group', 'topic'], help: '只列这类会话' },
    { name: 'exclude-muted', kind: 'flag', help: '排除免打扰的会话' },
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const list = await (await client()).chatList({
      types: a.type ? [String(a.type) as ChatSummary['type']] : undefined,
      excludeMuted: Boolean(a.exclude_muted),
      limit: Number(a.limit),
    });
    if (a.json) printJson(list);
    else
      for (const c of list)
        out(
          `${c.chatId}\t${CHAT_KIND_LABELS[c.type]}\t${c.name || '(未命名)'}\t${c.muted ? '免打扰\t' : ''}${c.unread ? `未读 ${c.unread}\t` : ''}活跃于 ${shortTime(Math.floor(c.updatedAt / 1000))}`,
        );
    return 0;
  },
};

const getCmd: Command = {
  name: 'get',
  help: '按消息 id 取消息(可跨会话;引用回复的原文、链接里的消息都能取)',
  access: 'get',
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
  access: 'thread',
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
  access: 'history',
  positionals: [CHAT_TARGET],
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
    {
      name: 'order',
      kind: 'string',
      choices: ['asc', 'desc'],
      default: 'asc',
      help: '输出顺序:asc 旧的在前(默认),desc 新的在前',
    },
    { name: 'reactions', kind: 'flag', help: '同时列出每条消息上的表情回复' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const chatId = await chatTarget(c, a.chat_id);
    const show = async (msgs: LarkMessage[]) =>
      printMessages(
        a.order === 'desc' ? [...msgs].reverse() : msgs,
        Boolean(a.json),
        await senderNames(c, msgs, Boolean(a.names)),
        await messageReactions(c, msgs, Boolean(a.reactions)),
      );
    if (chatId === null) return 1;
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
      await show(msgs);
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
    await show(msgs);
    if (a.save) out(`已入库 ${msgs.length} 条`);
    return 0;
  },
};

const downloadCmd: Command = {
  name: 'download',
  help: '下载消息里的图片/文件等资源',
  access: 'download',
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
        // Not in the local database (or only the content-less row lark send saved first): fetch
        // it from the server by id
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

/**
 * Uses valid credentials as-is; when they have expired, logs in again interactively in the terminal
 * (QR code or pasted cookie); in a non-interactive environment, throws AuthExpired.
 */
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

/**
 * The chats in a feed tag change, so a digital twin filtering by tag re-resolves them periodically.
 */
const TAG_REFRESH_MS = 5 * 60_000;

/**
 * Finds feed tags by name or id and returns all chats in them; tags not found are logged as
 * warnings.
 */
async function tagChats(c: LarkClient, wanted: string[]): Promise<Set<string>> {
  const groups = await c.feedGroups();
  const chats = new Set<string>();
  for (const w of wanted) {
    const g = groups.find((x) => x.id === w || x.name === w);
    if (!g) {
      logger.warning(`找不到会话标签: ${w}`);
      continue;
    }
    for (const id of await c.feedGroupChats(g.id)) chats.add(id);
  }
  return chats;
}

const TAG_EDITS = ['create', 'rename', 'delete', 'add', 'remove'] as const;

const tags: Command = {
  name: 'tags',
  help: '会话标签(分组):不带参数列出标签;带标签名或 id 列出其中的会话;--create/--rename/--delete/--add/--remove 管理标签(只影响自己)',
  access: (a) =>
    TAG_EDITS.some((k) => a[k] !== undefined && a[k] !== false) ? 'tags.edit' : 'tags.list',
  positionals: [{ name: 'tag', nargs: '?' }],
  options: [
    {
      name: 'create',
      kind: 'string',
      metavar: 'NAME',
      help: '新建标签(可配合 --add 一起放入会话)',
    },
    { name: 'rename', kind: 'string', metavar: 'NAME', help: '把标签改名' },
    { name: 'delete', kind: 'flag', help: '删除标签(其中的会话不受影响)' },
    { name: 'add', kind: 'string', metavar: 'CHAT_IDS', help: '把这些会话放进标签(逗号分隔)' },
    { name: 'remove', kind: 'string', metavar: 'CHAT_IDS', help: '把这些会话移出标签(逗号分隔)' },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    if (TAG_EDITS.some((k) => a[k] !== undefined && a[k] !== false)) return editTag(c, a);
    if (a.tag === undefined) {
      const groups = await c.feedGroups();
      if (a.json) printJson(groups);
      else for (const g of groups) out(`${g.id}\t${g.name}\t${g.type}`);
      return 0;
    }
    const groups = await c.feedGroups();
    const g = groups.find((x) => x.id === a.tag || x.name === a.tag);
    if (!g) {
      err(`找不到会话标签: ${a.tag}`);
      return 1;
    }
    const ids = await c.feedGroupChats(g.id);
    if (a.json) printJson(ids);
    else for (const id of ids) out(id);
    return 0;
  },
};

async function editTag(c: LarkClient, a: Parsed): Promise<number> {
  try {
    if (a.create !== undefined) {
      const id = await c.createFeedGroup(String(a.create), list(a.add) ?? []);
      out(`已建标签 id=${id}`);
      return 0;
    }
    if (a.tag === undefined) {
      err('需要标签名或 id');
      return 2;
    }
    const g = (await c.feedGroups()).find((x) => x.id === a.tag || x.name === a.tag);
    if (!g) {
      err(`找不到会话标签: ${a.tag}`);
      return 1;
    }
    if (a.delete) {
      await c.deleteFeedGroup(g.id);
      out(`已删除标签 ${g.name}`);
      return 0;
    }
    if (a.rename !== undefined) await c.renameFeedGroup(g.id, String(a.rename));
    const add = list(a.add) ?? [];
    const remove = list(a.remove) ?? [];
    if (add.length) await c.addToFeedGroup(g.id, add);
    if (remove.length) await c.removeFromFeedGroup(g.id, remove);
    out(`已更新标签 ${a.rename ?? g.name}`);
    return 0;
  } catch (e) {
    err(`标签操作失败: ${errorText(e)}`);
    return 1;
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
  if (dispatcher && cfg.triggers.include_tags.length) {
    const refresh = async () => {
      try {
        dispatcher.setTagChats(await tagChats(c, cfg.triggers.include_tags));
      } catch (e) {
        logger.warning(`解析会话标签失败: ${errorText(e)}`);
      }
    };
    await refresh();
    setInterval(refresh, TAG_REFRESH_MS);
  }
  const names = new Map<string, string | null>();
  /**
   * The message a reply (quote reply or thread reply) responds to: checks the local database
   * first, then the server; omitted if it cannot be fetched.
   */
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
    // Recalls and edits arrive as a re-push of the same message: recalled ones are no longer
    // handed to the agent; edited ones update the stored content and let the agent see the new
    // content
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
  /**
   * Reaction changes: logged; with LARKX_AGENT_REACTIONS on, others adding / removing reactions on
   * my messages are handed to the digital twin.
   */
  const onReaction = async (ev: ReactionEvent) => {
    if (ev.user_id === la.userId) return;
    const row = await st.findMessages(ev.message_id);
    let target: LarkMessage | undefined;
    if (row[0]) {
      const r = row[0];
      target = {
        msg_id: r.msg_id,
        msg_type: r.msg_type,
        msg_type_name: r.msg_type_name,
        from_id: r.sender_id,
        chat_id: r.chat_id,
        chat_type: r.chat_type,
        chat_type_name: CHAT_TYPE_NAMES[r.chat_type] ?? '',
        scope: r.scope as 'chat' | 'topic',
        anchor: r.anchor,
        at_me: false,
        root_id: r.root_id,
        parent_id: r.parent_id,
        cid: '',
        position: r.position,
        create_time: r.create_time,
        content: r.content,
        content_data: null,
      };
    } else [target] = await c.getMessages([ev.message_id]).catch(() => []);
    if (!target) return;
    const chatId = target.chat_id;
    const key = `${ev.user_id}\u0000${chatId}`;
    if (!names.has(key)) names.set(key, await c.getUserName(ev.user_id, chatId));
    const senderName = names.get(key) || '';
    const chatName = names.get(chatId) || (await st.getChatName(chatId));
    logger.info(
      `[${chatName || chatId}] ${senderName || ev.user_id} ${ev.cancelled ? '取消了' : '加了'}表情 ${ev.reaction_type}: ${preview(target.content || '', 40)}`,
    );
    if (dispatcher && cfg.agent_reactions && target.from_id === la.userId)
      await dispatcher.submitReaction(
        ev,
        target,
        {
          id: target.msg_id,
          sender_id: target.from_id,
          sender_name: '我',
          content: target.content,
        },
        chatName,
        senderName,
        la.userId,
      );
  };
  await keepListening(c, onMessage, {
    onReaction,
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
  access: 'listen',
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

const permissions: Command = {
  name: 'permissions',
  help: '命令权限:不带参数列出每个命令能否执行;edit 在终端里交互编辑当前账号的规则(替代全局规则),clear 清除',
  access: (a) => `permissions.${(a.action ?? 'show') as 'show' | 'edit' | 'clear'}`,
  positionals: [{ name: 'action', nargs: '?', choices: ['show', 'edit', 'clear'] }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const action = String(a.action ?? 'show');
    const auth = new LarkAuth();
    if (action === 'show') {
      const { rules, source } = loadRules(auth);
      const items = (Object.keys(PERMISSIONS) as Permission[]).map((p) => ({
        name: p,
        group: PERMISSIONS[p],
        ...decide(rules, p),
      }));
      if (a.json) {
        printJson({ source, ...rules, commands: items });
        return 0;
      }
      out(`生效规则: ${source}`);
      out(`allow: ${rules.allow.join(', ') || '-'}`);
      out(`deny: ${rules.deny.join(', ') || '-'}`);
      const width = Math.max(...items.map((i) => i.name.length)) + 2;
      for (const [group, desc] of Object.entries(GROUPS) as [Group, string][]) {
        out(`\n[${group}] ${desc}`);
        for (const i of items.filter((x) => x.group === group))
          out(
            `  ${i.name.padEnd(width)}${i.allowed ? '允许' : '拒绝'}${i.rule ? `  ${i.rule}` : ''}`,
          );
      }
      return 0;
    }
    if (!auth.userId) {
      err('没有已登录的账号,跟随账号的规则需要先登录(lark auth qr)');
      return 1;
    }
    if (action === 'clear') {
      saveAccountRules(auth, null);
      out(`已清除账号 ${auth.userId} 的规则,改用全局规则(LARKX_ALLOW / LARKX_DENY)`);
      return 0;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      err(
        'permissions edit 需要在终端里运行;脚本里可改 LARKX_ALLOW / LARKX_DENY 或数据目录的 permissions.json',
      );
      return 2;
    }
    const current = loadRules(auth);
    const editor = new PermissionEditor(
      current.rules,
      `命令权限 · 账号 ${auth.userId}`,
      current.own
        ? '编辑这个账号自己的规则'
        : '这个账号还没有自己的规则,下面从全局规则复制;保存后整体替代全局规则',
    );
    const rules = await editInTerminal(editor);
    if (!rules || !editor.dirty) {
      out('未保存,规则没有变化');
      return 0;
    }
    saveAccountRules(auth, rules);
    out(`已保存账号 ${auth.userId} 的规则(${permissionsPath(auth)})`);
    out(`allow: ${rules.allow.join(', ') || '-'}`);
    out(`deny: ${rules.deny.join(', ') || '-'}`);
    return 0;
  },
};

export const COMMANDS: Command[] = [
  auth,
  send,
  mediaCommand('image'),
  mediaCommand('file'),
  mediaCommand('video'),
  mediaCommand('audio'),
  schedule,
  scheduled,
  translate,
  forward,
  group,
  pin,
  pins,
  mute,
  shortcut,
  tags,
  flag,
  flags,
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
  searchUsers,
  searchBots,
  chatSearch,
  chatList,
  unread,
  members,
  users,
  user,
  api,
  history,
  getCmd,
  thread,
  downloadCmd,
  listen,
  permissions,
];
