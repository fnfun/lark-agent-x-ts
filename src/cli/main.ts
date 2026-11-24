#!/usr/bin/env bun
import '../bun-assets.js';
import { AuthExpired, LarkAuth } from '../auth.js';
import { checkAccountName, currentAccount } from '../config.js';
import { authorize, PermissionDenied } from '../permissions.js';
import { HelpRequested, parse, UsageError } from './args.js';
import { COMMANDS } from './commands.js';
import { type Command, type CommandGroup, write } from './common.js';
import { errorText } from './format.js';
import { COMMAND_GROUPS } from './groups.js';
import { versionLine } from './version.js';

const PROG = 'lark';

const ALL: (Command | CommandGroup)[] = [...COMMANDS, ...COMMAND_GROUPS];

function topUsage(): string {
  return `usage: ${PROG} [-h] [--account NAME]\n            {${ALL.map((c) => c.name).join(',')}}\n            ...`;
}

function topHelp(): string {
  const lines = [topUsage(), '', '飞书 / Lark 网页版消息通道 CLI', '', 'positional arguments:'];
  lines.push(`  {${ALL.map((c) => c.name).join(',')}}`);
  for (const c of ALL) lines.push(`    ${c.name.padEnd(20)}${c.help}`);
  lines.push('', 'options:', '  -h, --help            show this help message and exit');
  lines.push('  --version             print version and build commit, then exit');
  lines.push(
    '  --account NAME        用哪个账号执行(默认取 LARKX_ACCOUNT,再取 lark account use 选定的)',
  );
  return lines.join('\n');
}

/**
 * Takes the global `--account NAME` off the front of argv and pins the account in effect into
 * `LARKX_ACCOUNT`, so this run and every process it starts (the agent calling `lark`) stay on the
 * same account even if `lark account use` switches meanwhile.
 */
function selectAccount(argv: string[]): string[] {
  let rest = argv;
  for (;;) {
    const [first, second] = rest;
    if (first === '--account') {
      if (second === undefined) throw new UsageError('argument --account: expected one argument');
      process.env.LARKX_ACCOUNT = second;
      rest = rest.slice(2);
    } else if (first?.startsWith('--account=')) {
      process.env.LARKX_ACCOUNT = first.slice('--account='.length);
      rest = rest.slice(1);
    } else break;
  }
  const given = process.env.LARKX_ACCOUNT?.trim();
  if (given) {
    try {
      checkAccountName(given);
    } catch (e) {
      throw new UsageError(`argument --account: ${(e as Error).message}`);
    }
  }
  process.env.LARKX_ACCOUNT = currentAccount();
  return rest;
}

async function main(argv: string[]): Promise<number> {
  let args: string[];
  try {
    args = selectAccount(argv);
  } catch (e) {
    const usageError = e instanceof UsageError;
    process.stderr.write(
      `${usageError ? `${topUsage()}\n${PROG}: error: ` : ''}${(e as Error).message}\n`,
    );
    return usageError ? 2 : 1;
  }
  const [name, ...rest] = args;
  if (name === '-h' || name === '--help') {
    write(`${topHelp()}\n`);
    return 0;
  }
  if (name === '--version') {
    write(`${versionLine()}\n`);
    return 0;
  }
  const group = COMMAND_GROUPS.find((g) => g.name === name);
  if (group) return runGroup(group, rest);
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    const msg = name
      ? `argument cmd: invalid choice: '${name}' (choose from ${ALL.map((c) => `'${c.name}'`).join(', ')})`
      : 'the following arguments are required: cmd';
    process.stderr.write(`${topUsage()}\n${PROG}: error: ${msg}\n`);
    return 2;
  }
  return runCommand(PROG, cmd, rest);
}

function groupHelp(g: CommandGroup): string {
  const names = g.subcommands.map((c) => c.name);
  const lines = [`usage: ${PROG} ${g.name} [-h] {${names.join(',')}} ...`, '', g.help, ''];
  lines.push('subcommands:');
  for (const c of g.subcommands) lines.push(`    ${c.name.padEnd(20)}${c.help}`);
  return lines.join('\n');
}

async function runGroup(g: CommandGroup, argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '-h' || name === '--help') {
    write(`${groupHelp(g)}\n`);
    return name === undefined ? 2 : 0;
  }
  const cmd = g.subcommands.find((c) => c.name === name);
  if (!cmd) {
    const choices = g.subcommands.map((c) => `'${c.name}'`).join(', ');
    process.stderr.write(
      `${PROG} ${g.name}: error: argument subcommand: invalid choice: '${name}' (choose from ${choices})\n`,
    );
    return 2;
  }
  return runCommand(`${PROG} ${g.name}`, cmd, rest);
}

async function runCommand(prog: string, cmd: Command, rest: string[]): Promise<number> {
  try {
    const args = parse(prog, cmd, rest);
    authorize(new LarkAuth(), true, typeof cmd.access === 'string' ? cmd.access : cmd.access(args));
    return await cmd.run(args);
  } catch (e) {
    if (e instanceof HelpRequested) {
      write(`${e.message}\n`);
      return 0;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    if (e instanceof PermissionDenied) {
      process.stderr.write(`${prog} ${cmd.name}: ${e.message}\n`);
      return 126; // Same as the shell's "command found but not executable"
    }
    // Expired credentials, network errors, etc.: print only the reason (the last line of the
    // original's uncaught exception), no stack trace
    const name = e instanceof AuthExpired ? 'AuthExpired' : (e as Error).name || 'Error';
    process.stderr.write(`${name}: ${errorText(e)}\n`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
