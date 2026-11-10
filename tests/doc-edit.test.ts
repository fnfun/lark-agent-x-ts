import { describe, expect, test } from 'bun:test';
import { DocEditor, newBlockId, operationId } from '../src/domains/doc-edit.js';
import { docxToMarkdown } from '../src/domains/docx-markdown.js';
import {
  attributedText,
  parseInline,
  parseMarkdown,
  replaceAttributed,
} from '../src/domains/markdown-docx.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;

/**
 * Runs DocEditor.append against a fake server and rebuilds the document the server would hold
 * from the committed change map (new blocks' `oi` data, the root's `li` inserts).
 */
async function appendAndRebuild(markdown: string) {
  let changeMap: Record<string, { payload: { ops: { p: unknown[]; action: Dict }[] } }> = {};
  const web = {
    json: async (_m: string, path: string, o: WebRequest = {}) => {
      if (path.endsWith('client_vars'))
        return { code: 0, data: { block_map: { D: { version: 1, data: { children: [] } } } } };
      if (path.endsWith('/user/')) return { code: 0, data: { suid: 'u1' } };
      changeMap = (o.json as { change_map: typeof changeMap }).change_map;
      return { code: 0, data: { type: 'ACCEPT_COMMIT' } };
    },
  } as unknown as WebSession;
  await new DocEditor(web).append('D', markdown);
  const map: Record<string, { data: Dict }> = {};
  for (const [id, change] of Object.entries(changeMap))
    if (id !== 'D') map[id] = { data: change.payload.ops[0]?.action.oi as Dict };
  const children = (changeMap.D?.payload.ops ?? []).map((o) => o.action.li);
  map.D = { data: { type: 'page', children, text: attributedText([{ text: '标题' }], 'u1') } };
  return docxToMarkdown(map, 'D').markdown;
}

describe('Markdown 写入文档', () => {
  test('Markdown 经编辑器写进去再读回来一致（标题、段落、嵌套列表、有序、待办、引用、代码、分割线、表格、行内样式和链接）', async () => {
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
      'print(2)',
      '```',
      '',
      '| 城市 | 人口 |',
      '| --- | --- |',
      '| 北京 \\| 首都 | **2184** |',
      '',
      '---',
    ].join('\n');
    expect(await appendAndRebuild(body)).toBe(`# 标题\n\n${body}\n`);
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

  test('多行文字按服务端规则编码：同属性的一段在最后一个换行处切开，前半带 |换行数', () => {
    expect(attributedText([{ text: 'a\nbb\nc' }], 'u').initialAttributedTexts.attribs[0]).toBe(
      '*0|2+5*0+1',
    );
    expect(
      attributedText([{ text: 'x\n' }, { text: 'y', bold: true }], 'u').initialAttributedTexts
        .attribs[0],
    ).toBe('*0|1+2*0*1+1');
  });

  test('替换保留每个字原有的属性（含不认识的属性编号），新字沿用被替换的第一个字的属性', () => {
    // 0 author, 1 bold, 7 an attribute this project does not know (say a colour).
    expect(replaceAttributed('今天很好', '*0+2*0*1*7+2', '很好', '晴朗无云')).toEqual({
      text: '今天晴朗无云',
      attribs: '*0+2*0*1*7+4',
      count: 1,
    });
    expect(replaceAttributed('a\nab', '*0|1+2*0+2', 'a', 'XY')?.text).toBe('XY\nXYb');
    expect(replaceAttributed('abc', '*0+3', 'z', 'y')).toBeNull();
  });

  test('查找替换：只改命中的块，按块的当前版本提交 od/oi', async () => {
    const text = (t: string, attribs: string) => ({
      apool: { nextNum: 1, numToAttrib: { 0: ['author', 'u1'] } },
      initialAttributedTexts: { text: { 0: t }, attribs: { 0: attribs } },
    });
    const commits: Dict[] = [];
    const web = {
      json: async (_m: string, path: string, o: WebRequest = {}) => {
        if (path.endsWith('client_vars'))
          return {
            code: 0,
            data: {
              block_sequence: ['D'],
              block_map: {
                D: {
                  version: 3,
                  data: { type: 'page', text: text('测试标题', '*0+4'), children: ['a', 'b'] },
                },
                a: { version: 2, data: { type: 'text', text: text('要测试', '*0+3') } },
                b: { version: 9, data: { type: 'text', text: text('无关', '*0+2') } },
              },
            },
          };
        commits.push((o.json as { change_map: Dict }).change_map);
        return { code: 0, data: { type: 'ACCEPT_COMMIT' } };
      },
    } as unknown as WebSession;
    expect(await new DocEditor(web).replace('D', '测试', '核对')).toEqual({
      replaced: 1,
      blocks: 1,
      skipped: 0,
    });
    const change = (
      commits[0] as Record<
        string,
        { version: number; payload: { ops: { p: string[]; action: Dict }[] } }
      >
    ).a;
    expect(change?.version).toBe(2);
    const op = change?.payload.ops[0];
    expect(op?.p).toEqual(['text']);
    expect(op?.action.oi).toMatchObject({ initialAttributedTexts: { text: { 0: '要核对' } } });
    expect(Object.keys(commits[0] as Dict)).toEqual(['a']);
  });

  test('单独成行的图片：先建空 token 的图片块（尺寸取自文件头），再挂在该块上传，最后写回 token；读不到图片时什么都不写', async () => {
    // A 3×2 PNG header is enough for the size; the body is never decoded.
    const png = new Uint8Array(33);
    png.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      3, 0, 0, 0, 2,
    ]);
    const commits: Record<
      string,
      { version: number; payload: { ops: { p: unknown[]; action: Dict }[] } }
    >[] = [];
    const uploads: WebRequest[] = [];
    const web = {
      origin: async () => 'https://tenant.feishu.cn',
      json: async (_m: string, path: string, o: WebRequest = {}) => {
        if (path.endsWith('client_vars'))
          return {
            code: 0,
            data: { block_map: { D: { version: 1, data: { children: ['old'] } } } },
          };
        if (path.endsWith('/user/')) return { code: 0, data: { suid: 'u1' } };
        if (path.includes('upload')) {
          uploads.push(o);
          return { code: 0, data: { file_token: 'F1' } };
        }
        commits.push((o.json as { change_map: (typeof commits)[number] }).change_map);
        return { code: 0, data: { type: 'ACCEPT_COMMIT' } };
      },
    } as unknown as WebSession;
    const editor = new DocEditor(web);
    await editor.append('D', '![红色 **方块**](a/red.png)', {
      loadImage: async (src) => ({ data: png, name: src.split('/').pop() as string }),
    });
    const [created, token] = commits;
    const imageId = created?.D?.payload.ops[0]?.action.li as string;
    expect(created?.[imageId]?.payload.ops[0]?.action.oi).toMatchObject({
      image: { token: '', width: 3, height: 2, mimeType: 'image/png', name: 'red.png' },
    });
    expect(uploads[0]?.query).toMatchObject({
      mount_point: 'docx_image',
      mount_node_token: imageId,
    });
    expect(JSON.parse(String(uploads[0]?.query?.['ext[extra]']))).toEqual({
      drive_route_token: 'D',
    });
    expect(token?.[imageId]).toMatchObject({
      version: 1,
      payload: { ops: [{ p: ['image', 'token'], action: { od: '', oi: 'F1' } }] },
    });

    commits.length = 0;
    await expect(
      editor.overwrite('D', '![x](missing.png)', {
        loadImage: async () => {
          throw new Error('读取图片失败');
        },
      }),
    ).rejects.toThrow('读取图片失败');
    expect(commits).toHaveLength(0);
  });
});
