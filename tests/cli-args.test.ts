import { describe, expect, test } from 'bun:test';
import { type CommandSpec, HelpRequested, parse, UsageError } from '../src/cli/args.js';

const send: CommandSpec = {
  name: 'send',
  help: '',
  positionals: [{ name: 'chat_id' }, { name: 'text', nargs: '+' }],
  options: [
    { name: 'root', kind: 'string' },
    { name: 'links', kind: 'flag' },
  ],
};
const download: CommandSpec = {
  name: 'download',
  help: '',
  positionals: [{ name: 'msg_id', nargs: '?' }],
  options: [
    { name: 'out', short: '-o', kind: 'string', required: true },
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'region', kind: 'string', choices: ['feishu', 'lark'] },
  ],
};

describe('参数解析（对齐 argparse）', () => {
  test('一个以上的位置参数、开关、选项取值（含 = 写法）', () => {
    expect(parse('lark', send, ['c1', '你好', '世界', '--links', '--root=r1'])).toEqual({
      chat_id: 'c1',
      text: ['你好', '世界'],
      links: true,
      root: 'r1',
    });
    expect(parse('lark', send, ['c1', '-1'])).toMatchObject({ text: ['-1'] });
  });

  test('任意个数的位置参数（*）可以为空，也可以吃掉剩下的全部', () => {
    const spec = { name: 'find', help: '', positionals: [{ name: 'query', nargs: '*' as const }] };
    expect(parse('lark', spec, [])).toEqual({ query: [] });
    expect(parse('lark', spec, ['月报', '导出'])).toEqual({ query: ['月报', '导出'] });
    const tail = {
      ...spec,
      positionals: [{ name: 'query', nargs: '*' as const }, { name: 'chat_id' }],
    };
    expect(parse('lark', tail, ['c1'])).toEqual({ query: [], chat_id: 'c1' });
    expect(parse('lark', tail, ['月报', 'c1'])).toEqual({ query: ['月报'], chat_id: 'c1' });
  });

  test('可选位置参数、短别名、整数、默认值', () => {
    expect(parse('lark', download, ['-o', 'x.png'])).toEqual({
      out: 'x.png',
      limit: 50,
      region: undefined,
    });
    expect(parse('lark', download, ['m1', '--out', 'x', '--limit', '3'])).toMatchObject({
      msg_id: 'm1',
      limit: 3,
    });
  });

  test('出错：缺必填、非法取值、非整数、多余参数、未知选项', () => {
    const err = (spec: CommandSpec, argv: string[]) => {
      try {
        parse('lark', spec, argv);
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        return (e as Error).message.split('\n').at(-1);
      }
      throw new Error('应当报错');
    };
    expect(err(send, [])).toBe(
      'lark send: error: the following arguments are required: chat_id, text',
    );
    expect(err(download, ['m1'])).toBe(
      'lark download: error: the following arguments are required: -o/--out',
    );
    expect(err(download, ['-o', 'x', '--region', 'xx'])).toBe(
      "lark download: error: argument --region: invalid choice: 'xx' (choose from 'feishu', 'lark')",
    );
    expect(err(download, ['-o', 'x', '--limit', 'a'])).toBe(
      "lark download: error: argument --limit: invalid int value: 'a'",
    );
    expect(err(download, ['-o', 'x', 'm1', 'm2'])).toBe(
      'lark download: error: unrecognized arguments: m2',
    );
    expect(err(send, ['c1', 't', '--nope'])).toBe(
      'lark send: error: unrecognized arguments: --nope',
    );
  });

  test('-h 打印帮助', () => {
    expect(() => parse('lark', send, ['-h'])).toThrow(HelpRequested);
  });
});

describe('命令行输出', () => {
  test('输出接到 shell 管道时紧接着 process.exit 也不丢内容（Bun 的 process.stdout 会在 64KB 处截断）', () => {
    const common = new URL('../src/cli/common.ts', import.meta.url).pathname;
    const script = `import { write } from ${JSON.stringify(common)}; write('y'.repeat(400000)); write('尾'); process.exit(0);`;
    const child = Bun.spawnSync(['sh', '-c', 'bun -e "$0" | wc -c', script]);
    // 400000 ASCII bytes plus the three UTF-8 bytes of "尾".
    expect(Number(child.stdout.toString().trim())).toBe(400003);
  });
});
