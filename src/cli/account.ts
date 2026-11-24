import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LarkAuth } from '../auth.js';
import {
  accountDir,
  currentAccount,
  DEFAULT_ACCOUNT,
  dataRoot,
  rememberAccount,
  rememberedAccount,
} from '../config.js';
import type { Command, CommandGroup } from './common.js';
import { err, out } from './common.js';
import { printJson, shortTime } from './format.js';

const NAME_ARG = { name: 'name', help: `账号名(${DEFAULT_ACCOUNT} 为数据目录根上的默认账号)` };

const credentialsOf = (name: string) => new LarkAuth(join(accountDir(name), 'credentials.json'));

/**
 * Accounts on this machine: the default account when it has credentials or is in effect, then every
 * directory under `<root>/accounts/`.
 */
function accountNames(): string[] {
  const named = join(dataRoot(), 'accounts');
  const names = existsSync(named)
    ? readdirSync(named)
        // stat follows links, so an existing data directory linked in here counts as an account
        .filter((n) => statSync(join(named, n), { throwIfNoEntry: false })?.isDirectory())
        .sort()
    : [];
  const showDefault =
    currentAccount() === DEFAULT_ACCOUNT || credentialsOf(DEFAULT_ACCOUNT).hasCredentials;
  return showDefault ? [DEFAULT_ACCOUNT, ...names] : names;
}

const list: Command = {
  name: 'list',
  help: '列出本机的账号(* 为本次生效的账号)',
  access: 'account.list',
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const current = currentAccount();
    const rows = accountNames().map((name) => {
      const auth = credentialsOf(name);
      return {
        name,
        current: name === current,
        region: auth.region.name,
        user_id: auth.userId,
        has_credentials: auth.hasCredentials,
        saved_at: auth.savedAt,
        path: accountDir(name),
      };
    });
    if (a.json) printJson(rows);
    else
      for (const r of rows)
        out(
          [
            `${r.current ? '*' : ' '} ${r.name}`,
            r.region,
            r.user_id || '-',
            r.has_credentials ? `凭证保存于 ${shortTime(r.saved_at)}` : '无凭证',
            r.path,
          ].join('\t'),
        );
    return 0;
  },
};

const current: Command = {
  name: 'current',
  help: '打印本次生效的账号名',
  access: 'account.current',
  async run() {
    out(currentAccount());
    return 0;
  },
};

const use: Command = {
  name: 'use',
  help: '切换之后命令默认使用的账号(--account 与 LARKX_ACCOUNT 仍优先)',
  access: 'account.use',
  positionals: [NAME_ARG],
  async run(a) {
    const name = String(a.name);
    if (!credentialsOf(name).hasCredentials) {
      err(`账号 ${name} 还没有凭证,先运行 lark --account ${name} auth qr`);
      return 1;
    }
    rememberAccount(name);
    out(`已切换到账号 ${name}: ${accountDir(name)}`);
    return 0;
  },
};

const rm: Command = {
  name: 'rm',
  help: '删除账号的数据目录(凭证、消息库、权限规则等),不可恢复;链接进来的目录只删链接',
  access: 'account.rm',
  positionals: [NAME_ARG],
  options: [{ name: 'yes', kind: 'flag', help: '确认删除' }],
  async run(a) {
    const name = String(a.name);
    if (name === DEFAULT_ACCOUNT) {
      err('默认账号的数据就是数据目录根,其他账号也在里面,不能用 rm 删除');
      return 1;
    }
    const dir = accountDir(name);
    if (!existsSync(dir)) {
      err(`没有这个账号: ${name}`);
      return 1;
    }
    if (!a.yes) {
      err(`会删除 ${dir} 下的全部数据,确认请加 --yes`);
      return 1;
    }
    rmSync(dir, { recursive: true, force: true });
    if (rememberedAccount() === name) rememberAccount(DEFAULT_ACCOUNT);
    out(`已删除账号 ${name}`);
    return 0;
  },
};

/**
 * Accounts: each one has its own data directory; pick one per command with `lark --account <name>`
 * (or `LARKX_ACCOUNT`), and log a new one in with `lark --account <name> auth qr`.
 */
export const accountGroup: CommandGroup = {
  name: 'account',
  help: '多账号:列出、切换、删除',
  subcommands: [list, current, use, rm],
};
