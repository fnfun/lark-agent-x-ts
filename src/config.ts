import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~` 开头的路径展开为用户主目录。 */
export function expandUser(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** 数据目录（凭证、消息库、二维码）：`LARKX_HOME`，默认 `~/.larkx`。每次读取环境变量，便于测试切换。 */
export function dataDir(): string {
  return expandUser(process.env.LARKX_HOME || join(homedir(), '.larkx'));
}

export const credentialsPath = (): string => join(dataDir(), 'credentials.json');
export const dbDefaultPath = (): string => join(dataDir(), 'messages.db');

export interface Triggers {
  prefix: string;
  chat_types: string[];
  include_chats: string[];
  exclude_chats: string[];
  include_senders: string[];
  /** 只处理这些会话标签（名字或 id）里的会话。 */
  include_tags: string[];
  keywords: string[];
  group_at_only: boolean;
}

export interface Config {
  region: string;
  storage_url: string;
  /** agent 上下文边界：anchor（会话+话题）| chat（会话）| global（全部共享）。 */
  context_scope: string;
  agent_backend: string;
  system_prompt: string;
  /** 收到消息即标已读。 */
  mark_read: boolean;
  /** 别人对我的消息加 / 取消表情时交给数字人（如把点赞当作同意执行），默认关。 */
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

/** 逗号分隔或 JSON 数组。 */
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
 * 生效配置：默认值被 `LARKX_*` 环境变量覆盖（空串视为未设置）。`.env` 由 Bun 在启动时从当前目录自动加载。
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
