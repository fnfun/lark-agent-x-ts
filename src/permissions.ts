/**
 * 权限：按分组或单项（命令，读写混用的命令细到 `命令.动作`）允许 / 拒绝执行；命令行与库共用同一份目录和规则。
 *
 * 规则是 allow / deny 两个名字列表，名字可以是 `*`、分组、命令或 `命令.动作`。判定时从具体到宽泛逐级找
 * （`命令.动作` → 命令 → 分组 → `*`），第一级命中的规则生效，同一级上 deny 优先；都没命中则允许。
 * 全局规则来自 `LARKX_ALLOW` / `LARKX_DENY`；账号在凭证旁边的 `permissions.json` 里有自己的规则时整体替代全局规则。
 *
 * 这是防误操作的护栏，不是安全边界：能改环境变量或数据目录的调用方都能绕过。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LarkAuth } from './auth.js';
import { asList } from './config.js';

/** 分组按对外界的影响划分；顺序即 `lark permissions` 的列出顺序。 */
export const GROUPS = {
  local: '只读本机数据(凭证状态、配置、本地消息库),不联网',
  query: '只读飞书数据(消息、会话、成员、已读情况、翻译等),不留下别人看得见的变化',
  outbound: '以本人身份发出新消息(发送、定时、转发)',
  modify: '改动已有消息或别人看得见的状态(撤回、编辑、表情、Pin、标已读)',
  organize: '只影响自己的整理(标记、会话置顶)',
  manage: '群管理(建群、拉人、移出、改群名)',
  system: '账号与进程级操作(登录、常驻接收、调任意网关接口、改权限)',
} as const;

export type Group = keyof typeof GROUPS;

/** 全部权限项与所属分组：命令行的每个命令（或 `命令.动作`）一项，库的方法归到同一批项上。 */
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
  unread: 'query',
  members: 'query',
  users: 'query',
  reactions: 'query',
  'read-status': 'query',
  pins: 'query',
  flags: 'query',
  tags: 'query',
  translate: 'query',
  'message-link': 'query',
  'self-chat': 'query',
  download: 'query',
  'scheduled.list': 'query',
  'shortcut.list': 'query',

  send: 'outbound',
  'send-image': 'outbound',
  'send-file': 'outbound',
  schedule: 'outbound',
  forward: 'outbound',
  'scheduled.cancel': 'outbound',
  'scheduled.reschedule': 'outbound',

  recall: 'modify',
  edit: 'modify',
  react: 'modify',
  pin: 'modify',
  read: 'modify',

  flag: 'organize',
  'shortcut.add': 'organize',
  'shortcut.remove': 'organize',

  'group.create': 'manage',
  'group.add': 'manage',
  'group.remove': 'manage',
  'group.rename': 'manage',

  'auth.qr': 'system',
  'auth.import': 'system',
  listen: 'system',
  api: 'system',
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
  /** 起作用的规则，如 `deny outbound`；没有规则命中时为空。 */
  rule?: string;
}

/** `命令.动作` 的命令部分；不细分动作的项为空串。 */
const commandOf = (p: string) => (p.includes('.') ? p.slice(0, p.indexOf('.')) : '');

/** 按给定的名字从具体到宽泛逐级找，第一级命中的规则生效，同一级 deny 优先；都没命中则允许。 */
export function match(rules: Rules, levels: string[]): Verdict {
  for (const name of levels) {
    if (rules.deny.includes(name)) return { allowed: false, rule: `deny ${name}` };
    if (rules.allow.includes(name)) return { allowed: true, rule: `allow ${name}` };
  }
  return { allowed: true };
}

export const decide = (rules: Rules, p: Permission): Verdict =>
  match(rules, [p, commandOf(p), PERMISSIONS[p], '*'].filter(Boolean));

/** 规则里写错的名字会让本该拒绝的操作照常执行，所以不认识的名字一律报错。 */
function validate(rules: Rules, where: string): void {
  const known = new Set<string>(['*', ...Object.keys(GROUPS)]);
  for (const p of Object.keys(PERMISSIONS)) known.add(p).add(commandOf(p));
  const unknown = [...rules.allow, ...rules.deny].filter((n) => !n || !known.has(n));
  if (unknown.length)
    throw new Error(
      `${where}里有不认识的名字: ${unknown.join(', ')}(可用: *、分组 ${Object.keys(GROUPS).join('/')}、命令名或 命令.动作,见 README 的"命令权限")`,
    );
}

/** 权限不允许执行；`permission` 是被拒绝的项，`rule` 是起作用的规则。 */
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

/** 跟随账号的规则放在凭证文件旁边：user_id → {allow, deny}。 */
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
  /** 规则从哪来，用于报错与展示。 */
  source: string;
  /** 是否是账号自己的规则（否则是全局规则）。 */
  own: boolean;
}

/** 账号（凭证里的 user_id）的生效规则；账号没有自己的规则时用全局规则。 */
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

/** 设置（`rules` 为 null 时清除）账号自己的规则。 */
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
 * 规则从哪来：`true` 与命令行相同（账号自己的规则，没有则 `LARKX_ALLOW` / `LARKX_DENY`），每次检查时重新读取，
 * 改了规则不用重启；或直接给一份固定的规则。
 */
export type PermissionSource = true | Rules;

/** 不允许时抛 PermissionDenied。 */
export function authorize(auth: LarkAuth, source: PermissionSource, p: Permission): void {
  const eff: Pick<EffectiveRules, 'rules' | 'source'> =
    source === true ? loadRules(auth) : { rules: source, source: '传入的规则' };
  const v = decide(eff.rules, p);
  if (!v.allowed) throw new PermissionDenied(p, v.rule as string, eff.source);
}

/** 启用时先校验一次规则，配置有误时尽早报错。 */
export function checkSource(auth: LarkAuth, source: PermissionSource): void {
  if (source === true) loadRules(auth);
  else validate(source, '传入的规则');
}

const guarding = new AsyncLocalStorage<true>();

/**
 * 给对象的方法加上权限检查：只检查最外层调用，方法内部再调其他方法（如发送时内部调网关）不再检查；
 * 传入的回调（如长连接的 onMessage）在检查范围之外执行，回调里的调用照常检查。
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
