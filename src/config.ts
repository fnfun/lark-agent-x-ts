import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` in a path to the user's home directory. */
export function expandUser(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Root of all accounts: `LARKX_HOME`, default `~/.larkx`. The default account keeps its data in the
 * root itself (the fork's layout, so a single-account setup is unchanged); named accounts live in
 * `<root>/accounts/<name>/`. Reads the environment on every call so tests can switch it.
 */
export function dataRoot(): string {
  return expandUser(process.env.LARKX_HOME || join(homedir(), '.larkx'));
}

/** The account whose data is the root directory itself. */
export const DEFAULT_ACCOUNT = 'default';

/** Remembers the account chosen with `lark account use`; absent means the default account. */
const currentFile = () => join(dataRoot(), 'current-account');

/** Account names become directory names, so path separators and leading dots are refused. */
export function checkAccountName(name: string): string {
  if (!/^[\w-][\w.-]*$/.test(name))
    throw new Error(`账号名只能用字母、数字、下划线、点和连字符,且不能以点开头: ${name}`);
  return name;
}

/**
 * The account in effect: `LARKX_ACCOUNT` (the CLI sets it from `--account`) > the one remembered
 * by `lark account use` > the default account.
 */
export function currentAccount(): string {
  const fromEnv = process.env.LARKX_ACCOUNT?.trim();
  return fromEnv ? checkAccountName(fromEnv) : rememberedAccount();
}

/** The account remembered by `lark account use`, ignoring `LARKX_ACCOUNT`. */
export function rememberedAccount(): string {
  let saved = '';
  try {
    saved = readFileSync(currentFile(), 'utf8').trim();
  } catch {
    // No account chosen yet
  }
  return saved ? checkAccountName(saved) : DEFAULT_ACCOUNT;
}

/** Remembers the account for later runs; the default account clears the choice. */
export function rememberAccount(name: string): void {
  if (checkAccountName(name) === DEFAULT_ACCOUNT) {
    rmSync(currentFile(), { force: true });
    return;
  }
  mkdirSync(dataRoot(), { recursive: true });
  writeFileSync(currentFile(), `${name}\n`, 'utf8');
}

export const accountDir = (name: string): string =>
  checkAccountName(name) === DEFAULT_ACCOUNT ? dataRoot() : join(dataRoot(), 'accounts', name);

/** Data directory of the account in effect (credentials, message database, QR code, rules). */
export const dataDir = (): string => accountDir(currentAccount());

export const credentialsPath = (): string => join(dataDir(), 'credentials.json');
export const dbDefaultPath = (): string => join(dataDir(), 'messages.db');

export interface Triggers {
  prefix: string;
  chat_types: string[];
  include_chats: string[];
  exclude_chats: string[];
  include_senders: string[];
  /** Only handle chats in these feed tags (name or id). */
  include_tags: string[];
  keywords: string[];
  group_at_only: boolean;
}

export interface Config {
  region: string;
  storage_url: string;
  /** Agent context boundary: anchor (chat + thread) | chat (chat) | global (all shared). */
  context_scope: string;
  agent_backend: string;
  system_prompt: string;
  /** Mark messages as read as soon as they arrive. */
  mark_read: boolean;
  /**
   * Hand reactions others add to / remove from my messages to the digital twin (e.g. treat a
   * thumbs-up as approval to proceed); off by default.
   */
  agent_reactions: boolean;
  triggers: Triggers;
}

const TRIGGER_ENV: Record<keyof Triggers, string> = {
  prefix: 'LARKX_TRIGGER_PREFIX',
  chat_types: 'LARKX_TRIGGER_CHAT_TYPES',
  include_chats: 'LARKX_TRIGGER_INCLUDE_CHATS',
  exclude_chats: 'LARKX_TRIGGER_EXCLUDE_CHATS',
  include_senders: 'LARKX_TRIGGER_INCLUDE_SENDERS',
  include_tags: 'LARKX_TRIGGER_INCLUDE_TAGS',
  keywords: 'LARKX_TRIGGER_KEYWORDS',
  group_at_only: 'LARKX_TRIGGER_GROUP_AT_ONLY',
};

/** Comma-separated or a JSON array. */
export function asList(v: string): string[] {
  const s = v.trim();
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export const asBool = (v: string): boolean =>
  ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

/**
 * Effective config: defaults overridden by `LARKX_*` environment variables (an empty string counts
 * as unset). Bun loads `.env` from the current directory automatically at startup.
 */
export function loadConfig(): Config {
  const env = (key: string) => process.env[`LARKX_${key.toUpperCase()}`] || undefined;
  const markRead = env('mark_read');
  const triggers: Triggers = {
    prefix: '',
    chat_types: [],
    include_chats: [],
    exclude_chats: [],
    include_senders: [],
    include_tags: [],
    keywords: [],
    group_at_only: false,
  };
  for (const [key, name] of Object.entries(TRIGGER_ENV) as [keyof Triggers, string][]) {
    const v = process.env[name];
    if (v === undefined) continue;
    if (key === 'group_at_only') triggers.group_at_only = asBool(v);
    else if (key === 'prefix') triggers.prefix = v;
    else triggers[key] = asList(v);
  }
  return {
    region: env('region') ?? 'feishu',
    storage_url: env('storage_url') ?? `sqlite:///${dbDefaultPath()}`,
    context_scope: env('context_scope') ?? 'anchor',
    agent_backend: env('agent_backend') ?? 'claude',
    system_prompt: env('system_prompt') ?? '',
    mark_read: markRead === undefined ? true : asBool(markRead),
    agent_reactions: asBool(env('agent_reactions') ?? ''),
    triggers,
  };
}
