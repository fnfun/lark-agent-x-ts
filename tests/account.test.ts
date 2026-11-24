import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentAccount, dataDir, rememberAccount } from '../src/config.js';

const KEYS = ['LARKX_HOME', 'LARKX_ACCOUNT'];
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'larkx-account-'));
  process.env.LARKX_HOME = home;
  delete process.env.LARKX_ACCOUNT;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const login = (dir: string, userId: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ region: 'lark', user_id: userId, cookies: { session: 'x' }, saved_at: 1 }),
  );
};

describe('账号选择', () => {
  test('LARKX_ACCOUNT 优先于记住的账号，默认账号就是数据目录根', () => {
    expect(dataDir()).toBe(home);
    rememberAccount('work');
    expect(dataDir()).toBe(join(home, 'accounts', 'work'));
    process.env.LARKX_ACCOUNT = 'home';
    expect(dataDir()).toBe(join(home, 'accounts', 'home'));
    process.env.LARKX_ACCOUNT = 'default';
    expect(dataDir()).toBe(home);
    delete process.env.LARKX_ACCOUNT;
    rememberAccount('default');
    expect(currentAccount()).toBe('default');
  });

  test('账号名不能跳出数据目录', () => {
    for (const bad of ['../x', '..', '.hidden', 'a/b', 'a\\b', '']) {
      process.env.LARKX_ACCOUNT = bad || ' ';
      if (bad) expect(() => dataDir()).toThrow('账号名');
      else expect(dataDir()).toBe(home);
    }
  });
});

describe('命令行的多账号', () => {
  test('--account 指定账号执行；use 切换默认账号；rm 要确认且不删默认账号', () => {
    const main = join(import.meta.dir, '../src/cli/main.ts');
    const run = (argv: string[], extra: Record<string, string> = {}) => {
      const r = Bun.spawnSync(['bun', main, ...argv], {
        cwd: home,
        env: { PATH: process.env.PATH ?? '', HOME: home, LARKX_HOME: home, ...extra },
      });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const pathOf = (argv: string[], extra?: Record<string, string>) =>
      JSON.parse(run([...argv, 'auth', 'status'], extra).out).path;
    const work = join(home, 'accounts', 'work');
    login(home, '7000000000000000001');
    login(work, '7000000000000000002');

    expect(pathOf([])).toBe(join(home, 'credentials.json'));
    expect(pathOf(['--account', 'work'])).toBe(join(work, 'credentials.json'));
    expect(pathOf(['--account=work'])).toBe(join(work, 'credentials.json'));
    expect(pathOf([], { LARKX_ACCOUNT: 'work' })).toBe(join(work, 'credentials.json'));
    const bad = run(['--account', '../work', 'auth', 'status']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('账号名');

    expect(run(['account', 'use', 'nobody']).code).toBe(1);
    expect(run(['account', 'use', 'work']).code).toBe(0);
    expect(run(['account', 'current']).out.trim()).toBe('work');
    expect(pathOf([])).toBe(join(work, 'credentials.json'));
    expect(pathOf(['--account', 'default'])).toBe(join(home, 'credentials.json'));
    const listed = run(['account', 'list']).out.trimEnd().split('\n');
    expect(listed.map((l) => l.split('\t')[0])).toEqual(['  default', '* work']);
    expect(listed[1]).toContain('7000000000000000002');

    expect(run(['account', 'rm', 'default', '--yes']).code).toBe(1);
    expect(run(['account', 'rm', 'work']).code).toBe(1);
    expect(existsSync(work)).toBe(true);
    expect(run(['account', 'rm', 'work', '--yes']).code).toBe(0);
    expect(existsSync(work)).toBe(false);
    expect(existsSync(join(home, 'credentials.json'))).toBe(true);
    expect(run(['account', 'current']).out.trim()).toBe('default');
  });
});
