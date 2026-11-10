import { describe, expect, test } from 'bun:test';
import { DocEditor, newBlockId, operationId } from '../src/domains/doc-edit.js';
import { docxToMarkdown } from '../src/domains/docx-markdown.js';
import {
  attributedText,
  type BlockSpec,
  parseInline,
  parseMarkdown,
} from '../src/domains/markdown-docx.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;

/** Specs → a client_vars-like block map, built the way DocEditor builds block data. */
function toBlockMap(specs: BlockSpec[]) {
  const map: Record<string, { data: Dict }> = {};
  let n = 0;
  const add = (s: BlockSpec): string => {
    const id = `b${n++}`;
    const children = s.children.map(add);
    map[id] = {
      data: {
        type: s.type,
        children,
        ...(s.runs ? { text: attributedText(s.runs, 'u1') } : {}),
        ...(s.seq ? { seq: s.seq } : {}),
        ...(s.done !== undefined ? { done: s.done } : {}),
        ...(s.language ? { language: s.language } : {}),
      },
    };
    return id;
  };
  map.page = {
    data: {
      type: 'page',
      children: specs.map(add),
      text: attributedText([{ text: '标题' }], 'u1'),
    },
  };
  return map;
}

describe('Markdown 写入文档', () => {
  test('Markdown → 块 → Markdown 往返一致（标题、段落、嵌套列表、有序、待办、引用、代码、分割线、行内样式和链接）', () => {
    const body = [
      '# 一级',
      '',
      '## 二级',
      '',
      '正文 **粗** *斜* ~~删~~ `码` [链](https://example.com/a?b=1)',
      '',
      '- 甲',
      '  - 甲一',
      '- 乙',
      '',
      '1. 第一',
      '2. 第二',
      '',
      '- [ ] 未完成',
      '- [x] 已完成',
      '',
      '> 引用',
      '',
      '```python',
      'print(1)',
      '```',
      '',
      '---',
    ].join('\n');
    expect(docxToMarkdown(toBlockMap(parseMarkdown(body)), 'page').markdown).toBe(
      `# 标题\n\n${body}\n`,
    );
  });

  test('连续的行并成一段；代码块语言按显示名记录，未写语言为 PlainText', () => {
    const blocks = parseMarkdown('第一行\n第二行\n\n```ts\nlet a\n```\n\n```\nx\n```');
    expect(blocks.map((b) => [b.type, b.runs?.map((r) => r.text).join(''), b.language])).toEqual([
      ['text', '第一行 第二行', undefined],
      ['code', 'let a', 'TypeScript'],
      ['code', 'x', 'PlainText'],
    ]);
  });

  test('行内样式可嵌套（链接里的粗体同时带两种样式）', () => {
    expect(parseInline('前**[粗链](http://a.b)**后')).toEqual([
      { text: '前' },
      { text: '粗链', bold: true, link: 'http://a.b' },
      { text: '后' },
    ]);
  });

  test('属性池：0 号是作者，样式和链接按出现顺序编号；长度按 UTF-16 计、36 进制', () => {
    const t = attributedText(
      [
        { text: 'a'.repeat(40) },
        { text: '😀', bold: true },
        { text: 'x', bold: true, link: 'a b' },
      ],
      'u1',
    );
    expect(t.apool.numToAttrib).toEqual({
      0: ['author', 'u1'],
      1: ['bold', 'true'],
      2: ['link', 'a%20b'],
    });
    expect(t.initialAttributedTexts.attribs[0]).toBe('*0+14*0*1+2*0*1*2+1');
  });

  test('块 id：dox + 文档的两位操作码 + 随机字符，共 27 位；不以 dox 开头的文档 token 先还原再取', () => {
    expect(operationId('doxlgAAAAAAAAAAAAAAAAAAAAAA')).toBe('lg');
    const scrambled = 'ABCDdEFGHoIJKLxMNOPlQRSTgUV';
    expect(operationId(scrambled)).toBe('lg');
    expect(newBlockId(scrambled)).toMatch(/^doxlg[0-9A-Za-z]{22}$/);
  });

  test('追加：新块版本 0、子块挂在父块下；根块在原有子块之后依次插入。覆盖：先从后往前删光再追加', async () => {
    const commits: Dict[] = [];
    const web = {
      json: async (_m: string, path: string, o: WebRequest = {}) => {
        if (path.endsWith('client_vars'))
          return {
            code: 0,
            data: { block_map: { D: { version: 5, data: { children: ['x1', 'x2'] } } } },
          };
        if (path.endsWith('/user/')) return { code: 0, data: { suid: 'u1' } };
        commits.push((o.json as { change_map: Dict }).change_map);
        return { code: 0, data: { type: 'ACCEPT_COMMIT' } };
      },
    } as unknown as WebSession;
    const editor = new DocEditor(web);
    expect(await editor.append('D', '- 甲\n  - 甲一\n\n段落')).toBe(2);
    const changes = commits[0] as Record<
      string,
      { version: number; payload: { ops: { p: unknown[]; action: Dict }[] } }
    >;
    const root = changes.D;
    expect(root?.version).toBe(5);
    const added = root?.payload.ops.map((o) => [o.p, o.action.li]) ?? [];
    expect(added.map(([p]) => p)).toEqual([
      ['children', 2],
      ['children', 3],
    ]);
    const bullet = changes[added[0]?.[1] as string];
    const data = bullet?.payload.ops[0]?.action.oi as { parent_id: string; children: string[] };
    expect([bullet?.version, data.parent_id]).toEqual([0, 'D']);
    const child = changes[data.children[0] as string]?.payload.ops[0]?.action.oi as {
      parent_id: string;
    };
    expect(child.parent_id).toBe(String(added[0]?.[1]));

    commits.length = 0;
    await editor.overwrite('D', '新');
    const removal = (
      commits[0] as Record<string, { payload: { ops: { p: unknown[]; action: Dict }[] } }>
    ).D?.payload.ops;
    expect(removal?.map((o) => [o.p[1], o.action.ld])).toEqual([
      [1, 'x2'],
      [0, 'x1'],
    ]);
  });
});
