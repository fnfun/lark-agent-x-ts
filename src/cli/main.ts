#!/usr/bin/env bun
import '../bun-assets.js';
import { AuthExpired } from '../auth.js';
import { HelpRequested, parse, UsageError } from './args.js';
import { COMMANDS } from './commands.js';
import { versionLine } from './version.js';

const PROG = 'lark';

function topUsage(): string {
  return `usage: ${PROG} [-h]\n            {${COMMANDS.map((c) => c.name).join(',')}}\n            ...`;
}

function topHelp(): string {
  const lines = [topUsage(), '', '飞书 / Lark 网页版消息通道 CLI', '', 'positional arguments:'];
  lines.push(`  {${COMMANDS.map((c) => c.name).join(',')}}`);
  for (const c of COMMANDS) lines.push(`    ${c.name.padEnd(20)}${c.help}`);
  lines.push('', 'options:', '  -h, --help            show this help message and exit');
  lines.push('  --version             print version and build commit, then exit');
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === '-h' || name === '--help') {
    process.stdout.write(`${topHelp()}\n`);
    return 0;
  }
  if (name === '--version') {
    process.stdout.write(`${versionLine()}\n`);
    return 0;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    const msg = name
      ? `argument cmd: invalid choice: '${name}' (choose from ${COMMANDS.map((c) => `'${c.name}'`).join(', ')})`
      : 'the following arguments are required: cmd';
    process.stderr.write(`${topUsage()}\n${PROG}: error: ${msg}\n`);
    return 2;
  }
  try {
    return await cmd.run(parse(PROG, cmd, rest));
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(`${e.message}\n`);
      return 0;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    // 凭证失效、网络错误等：只打印原因（对应原项目未捕获异常的最后一行），不打印调用栈
    const name = e instanceof AuthExpired ? 'AuthExpired' : (e as Error).name || 'Error';
    process.stderr.write(`${name}: ${(e as Error).message}\n`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
