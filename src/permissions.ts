/**
 * Permissions: allow / deny execution by group or by item (a command; commands mixing reads and
 * writes are split down to `command.action`); the CLI and the library share the same catalog and
 * rules.
 *
 * Rules are two name lists, allow and deny; a name can be `*`, a group, a command or
 * `command.action`. Matching walks from specific to broad (`command.action` → command → group →
 * `*`); the first level with a matching rule wins, and deny takes precedence within a level; if
 * nothing matches, the operation is allowed.
 * Global rules come from `LARKX_ALLOW` / `LARKX_DENY`; when an account has its own rules in the
 * `permissions.json` next to its credentials, they replace the global rules entirely.
 *
 * This is a guardrail against mistakes, not a security boundary: any caller that can change the
 * environment variables or the data directory can bypass it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LarkAuth } from './auth.js';
import { asList } from './config.js';

/**
 * Groups are divided by their effect on the outside world; the order is the listing order of
 * `lark permissions`.
 */
export const GROUPS = {
  local: '只读本机数据(凭证状态、配置、本地消息库),不联网',
  query: '只读飞书数据(消息、会话、成员、已读情况、翻译等),不留下别人看得见的变化',
  outbound: '以本人身份发出新消息(发送、定时、转发)',
  modify: '改动已有消息或别人看得见的状态(撤回、编辑、表情、Pin、标已读)',
  organize: '只影响自己的整理(标记、会话置顶、免打扰、会话标签)',
  manage:
    '群管理(建群、拉人、移出、改群名、管理员、发言权限、入群审批、分享链接)和文档的链接分享范围',
  destroy: '删除(任务、任务清单、云文档等),删了别人也看不到',
  system: '账号与进程级操作(登录、常驻接收、调任意网关或网页接口、改权限)',
} as const;

export type Group = keyof typeof GROUPS;

/**
 * All permission items and their groups: one item per CLI command (or `command.action`); library
 * methods map onto the same set of items.
 */
export const PERMISSIONS = {
  'auth.status': 'local',
  config: 'local',
  chats: 'local',
  sessions: 'local',
  messages: 'local',
  'permissions.show': 'local',

  'auth.check': 'query',
  history: 'query',
  get: 'query',
  thread: 'query',
  search: 'query',
  'search-messages': 'query',
  'search-users': 'query',
  'search-bots': 'query',
  'chat-search': 'query',
  'chat-list': 'query',
  user: 'query',
  'group.info': 'query',
  'group.admins': 'query',
  'group.requests': 'query',
  'task.list': 'query',
  'task.search': 'query',
  'task.get': 'query',
  'task.comments': 'query',
  'task.lists': 'query',
  'doc.search': 'query',
  'doc.ls': 'query',
  'doc.fetch': 'query',
  'doc.trash': 'query',
  'doc.download': 'query',
  'doc.cat': 'query',
  'doc.export': 'query',
  'doc.comments': 'query',
  'doc.sharing': 'query',
  'doc.history': 'query',
  'doc.whiteboard': 'query',
  'doc.history-fetch': 'query',
  'wiki.spaces': 'query',
  'wiki.ls': 'query',
  'wiki.get': 'query',
  'base.tables': 'query',
  'base.fields': 'query',
  'base.views': 'query',
  'base.records': 'query',
  'sheet.tabs': 'query',
  'sheet.read': 'query',
  'cal.calendars': 'query',
  'cal.agenda': 'query',
  unread: 'query',
  members: 'query',
  users: 'query',
  reactions: 'query',
  'read-status': 'query',
  pins: 'query',
  flags: 'query',
  'tags.list': 'query',
  translate: 'query',
  'message-link': 'query',
  'self-chat': 'query',
  download: 'query',
  'scheduled.list': 'query',
  'shortcut.list': 'query',

  send: 'outbound',
  'send-image': 'outbound',
  'send-file': 'outbound',
  'send-video': 'outbound',
  'send-audio': 'outbound',
  'task.create': 'outbound',
  'task.comment': 'outbound',
  'doc.comment': 'outbound',
  'doc.reply': 'outbound',
  schedule: 'outbound',
  forward: 'outbound',
  'scheduled.cancel': 'outbound',
  'scheduled.reschedule': 'outbound',

  recall: 'modify',
  edit: 'modify',
  react: 'modify',
  pin: 'modify',
  'group.nickname': 'modify',
  'task.update': 'modify',
  'task.complete': 'modify',
  'doc.rename': 'modify',
  'doc.append': 'modify',
  'doc.attach': 'modify',
  'doc.slide-cp': 'modify',
  'doc.write': 'modify',
  'doc.replace': 'modify',
  'doc.revert': 'modify',
  'doc.resolve': 'modify',
  'wiki.rename': 'modify',
  'base.add': 'modify',
  'base.set': 'modify',
  'base.field-add': 'modify',
  'sheet.write': 'modify',
  'sheet.append': 'modify',
  'sheet.insert-rows': 'modify',
  'sheet.insert-cols': 'modify',
  read: 'modify',

  flag: 'organize',
  mute: 'organize',
  'tags.edit': 'organize',
  'task.list-create': 'organize',
  'doc.create': 'organize',
  'doc.import': 'organize',
  'doc.mv': 'organize',
  'doc.cp': 'organize',
  'doc.restore': 'organize',
  'doc.upload': 'organize',
  'wiki.create': 'organize',
  'wiki.mv': 'organize',
  'wiki.cp': 'organize',
  'cal.create': 'organize',
  'cal.update': 'organize',
  'shortcut.add': 'organize',
  'shortcut.remove': 'organize',

  'group.create': 'manage',
  'group.add': 'manage',
  'group.remove': 'manage',
  'group.rename': 'manage',
  'group.admin': 'manage',
  'group.moderation': 'manage',
  'group.approve': 'manage',
  'group.link': 'manage',
  'doc.set-link': 'manage',

  'task.delete': 'destroy',
  'task.list-delete': 'destroy',
  'doc.rm': 'destroy',
  'doc.comment-rm': 'destroy',
  'doc.slide-rm': 'destroy',
  'wiki.rm': 'destroy',
  'base.rm': 'destroy',
  'sheet.delete-rows': 'destroy',
  'sheet.delete-cols': 'destroy',
  'cal.delete': 'destroy',

  'auth.qr': 'system',
  'auth.import': 'system',
  listen: 'system',
  api: 'system',
  web: 'system',
  'permissions.edit': 'system',
  'permissions.clear': 'system',
} as const satisfies Record<string, Group>;

export type Permission = keyof typeof PERMISSIONS;

export const isPermission = (name: string): name is Permission => Object.hasOwn(PERMISSIONS, name);

export interface Rules {
  allow: string[];
  deny: string[];
}

export interface Verdict {
  allowed: boolean;
  /** The rule that took effect, e.g. `deny outbound`; empty when no rule matched. */
  rule?: string;
}

/** The command part of `command.action`; empty string for items not split by action. */
const commandOf = (p: string) => (p.includes('.') ? p.slice(0, p.indexOf('.')) : '');

/**
 * Walks the given names from specific to broad; the first level with a matching rule wins, deny
 * takes precedence within a level; if nothing matches, allow.
 */
export function match(rules: Rules, levels: string[]): Verdict {
  for (const name of levels) {
    if (rules.deny.includes(name)) return { allowed: false, rule: `deny ${name}` };
    if (rules.allow.includes(name)) return { allowed: true, rule: `allow ${name}` };
  }
  return { allowed: true };
}

export const decide = (rules: Rules, p: Permission): Verdict =>
  match(rules, [p, commandOf(p), PERMISSIONS[p], '*'].filter(Boolean));

/**
 * A misspelled name in the rules would let an operation that should be denied run anyway, so any
 * unknown name is an error.
 */
function validate(rules: Rules, where: string): void {
  const known = new Set<string>(['*', ...Object.keys(GROUPS)]);
  for (const p of Object.keys(PERMISSIONS)) known.add(p).add(commandOf(p));
  const unknown = [...rules.allow, ...rules.deny].filter((n) => !n || !known.has(n));
  if (unknown.length)
    throw new Error(
      `${where}里有不认识的名字: ${unknown.join(', ')}(可用: *、分组 ${Object.keys(GROUPS).join('/')}、命令名或 命令.动作,见 README 的"命令权限")`,
    );
}

/** Not allowed by permissions; `permission` is the denied item, `rule` the rule in effect. */
export class PermissionDenied extends Error {
  readonly group: Group;

  constructor(
    readonly permission: Permission,
    readonly rule: string,
    readonly source: string,
  ) {
    super(`权限不允许执行 ${permission}(分组 ${PERMISSIONS[permission]}): ${source}里的 ${rule}`);
    this.name = 'PermissionDenied';
    this.group = PERMISSIONS[permission];
  }
}

/** Per-account rules live next to the credentials file: user_id → {allow, deny}. */
export const permissionsPath = (auth: LarkAuth): string =>
  join(dirname(auth.path), 'permissions.json');

type AccountRules = Record<string, Rules>;

function readAccounts(path: string): AccountRules {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`读取权限文件 ${path} 失败: ${(e as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`权限文件 ${path} 应是 user_id → {allow, deny} 的对象`);
  const out: AccountRules = {};
  for (const [userId, r] of Object.entries(data as Record<string, Partial<Rules>>))
    out[userId] = { allow: (r?.allow ?? []).map(String), deny: (r?.deny ?? []).map(String) };
  return out;
}

export interface EffectiveRules {
  rules: Rules;
  /** Where the rules come from, for errors and display. */
  source: string;
  /** Whether these are the account's own rules (otherwise the global rules). */
  own: boolean;
}

/**
 * Effective rules for the account (the user_id in the credentials); the global rules when the
 * account has none of its own.
 */
export function loadRules(auth: LarkAuth): EffectiveRules {
  const path = permissionsPath(auth);
  const own = auth.userId ? readAccounts(path)[auth.userId] : undefined;
  const eff: EffectiveRules = own
    ? { rules: own, source: `账号 ${auth.userId} 的规则(${path})`, own: true }
    : {
        rules: {
          allow: asList(process.env.LARKX_ALLOW ?? ''),
          deny: asList(process.env.LARKX_DENY ?? ''),
        },
        source: '全局规则(LARKX_ALLOW / LARKX_DENY)',
        own: false,
      };
  validate(eff.rules, eff.source);
  return eff;
}

/** Sets the account's own rules (clears them when `rules` is null). */
export function saveAccountRules(auth: LarkAuth, rules: Rules | null): void {
  if (!auth.userId) throw new Error('凭证里没有 user_id,跟随账号的规则需要先登录');
  if (rules) validate(rules, '要保存的规则');
  const path = permissionsPath(auth);
  const accounts = readAccounts(path);
  if (rules) accounts[auth.userId] = rules;
  else delete accounts[auth.userId];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

/**
 * Where the rules come from: `true` works like the CLI (the account's own rules, otherwise
 * `LARKX_ALLOW` / `LARKX_DENY`), re-read on every check so rule changes need no restart; or pass a
 * fixed set of rules directly.
 */
export type PermissionSource = true | Rules;

/** Throws PermissionDenied when not allowed. */
export function authorize(auth: LarkAuth, source: PermissionSource, p: Permission): void {
  const eff: Pick<EffectiveRules, 'rules' | 'source'> =
    source === true ? loadRules(auth) : { rules: source, source: '传入的规则' };
  const v = decide(eff.rules, p);
  if (!v.allowed) throw new PermissionDenied(p, v.rule as string, eff.source);
}

/** Validates the rules once when enabled, so misconfiguration fails early. */
export function checkSource(auth: LarkAuth, source: PermissionSource): void {
  if (source === true) loadRules(auth);
  else validate(source, '传入的规则');
}

const guarding = new AsyncLocalStorage<true>();

/**
 * Adds permission checks to an object's methods: only the outermost call is checked, and methods
 * called from inside a method (e.g. the gateway call made while sending) are not checked again;
 * callbacks passed in (e.g. onMessage of the long-lived connection) run outside the checked scope,
 * so calls made inside them are checked as usual.
 */
export function guardMethods<T extends object>(
  target: T,
  table: { [K in keyof T]?: Permission | ((...args: never) => Permission) },
  check: (p: Permission) => void,
): void {
  const methods = target as Record<string, unknown>;
  for (const [name, entry] of Object.entries(table) as [
    string,
    Permission | ((...a: unknown[]) => Permission),
  ][]) {
    const original = methods[name] as (...a: unknown[]) => unknown;
    methods[name] = async function (this: unknown, ...args: unknown[]) {
      if (guarding.getStore()) return original.apply(this, args);
      check(typeof entry === 'function' ? entry(...args) : entry);
      const outside = args.map((a) =>
        typeof a === 'function' ? (...x: unknown[]) => guarding.exit(() => a(...x)) : a,
      );
      return guarding.run(true, () => original.apply(this, outside));
    };
  }
}
