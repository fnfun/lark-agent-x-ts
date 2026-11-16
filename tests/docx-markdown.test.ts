import { describe, expect, test } from 'bun:test';
import { attributedText, type BlockMap, docxToMarkdown } from '../src/domains/docx-markdown.js';

/** Attributed text as client_vars returns it; pool 0 is the author, as in real documents. */
const text = (
  s: string,
  attribs = `*0+${s.length.toString(36)}`,
  pool: Record<string, [string, string]> = {},
) => ({
  initialAttributedTexts: { text: { '0': s }, attribs: { '0': attribs } },
  apool: { numToAttrib: { '0': ['author', '7000000000000000001'], ...pool } },
});

describe('docx 转 Markdown', () => {
  test('行内样式：按 changeset 的 36 进制长度切分，属性号查属性表；链接解码', () => {
    // "第一段，" plain, "加粗" bold, "和" plain, "代码" inline code, "。" plain
    const t = text('第一段，加粗和代码。', '*0+4*0*1+2*0+1*0*2+2*0+1', {
      '1': ['bold', 'true'],
      '2': ['inlineCode', 'true'],
    });
    expect(attributedText(t)).toBe('第一段，**加粗**和`代码`。');
    const link = text('链接', '*0*1+2', { '1': ['link', 'https%3A%2F%2Fexample.com%2Fa%3Fb%3D1'] });
    expect(attributedText(link)).toBe('[链接](https://example.com/a?b=1)');
    // Lengths count UTF-16 code units: the emoji takes two
    const emoji = text('😀加粗', '*0+2*0*1+2', { '1': ['bold', 'true'] });
    expect(attributedText(emoji)).toBe('😀**加粗**');
  });

  test('块：标题、各级标题、列表（同类相邻不空行、嵌套缩进）、待办、引用、代码、分割线、表格', () => {
    const b = (data: Record<string, unknown>) => ({ data });
    const blocks: BlockMap = {
      page: b({
        type: 'page',
        text: text('周会纪要'),
        children: ['h', 'b1', 'b2', 'o1', 't1', 'q', 'c', 'd', 'tb'],
      }),
      h: b({ type: 'heading2', text: text('议题') }),
      b1: b({ type: 'bullet', text: text('外层'), children: ['b1a'] }),
      b1a: b({ type: 'bullet', text: text('内层') }),
      b2: b({ type: 'bullet', text: text('第二项') }),
      o1: b({ type: 'ordered', text: text('步骤'), seq: '1' }),
      t1: b({ type: 'todo', text: text('跟进'), done: true }),
      q: b({ type: 'quote', text: text('原话') }),
      c: b({ type: 'code', text: text('const a = 1;'), language: 'TypeScript' }),
      d: b({ type: 'divider' }),
      tb: b({
        type: 'table',
        rows_id: ['r1', 'r2'],
        columns_id: ['c1', 'c2'],
        cell_set: {
          r1c1: { block_id: 'x11' },
          r1c2: { block_id: 'x12' },
          r2c1: { block_id: 'x21' },
          r2c2: { block_id: 'x22' },
        },
      }),
      x11: b({ type: 'table_cell', children: ['y11'] }),
      x12: b({ type: 'table_cell', children: ['y12'] }),
      x21: b({ type: 'table_cell', children: ['y21'] }),
      x22: b({ type: 'table_cell', children: ['y22'] }),
      y11: b({ type: 'text', text: text('列一') }),
      y12: b({ type: 'text', text: text('列二') }),
      y21: b({ type: 'text', text: text('A|B') }),
      y22: b({ type: 'text', text: text('C') }),
    };
    expect(docxToMarkdown(blocks, 'page')).toEqual({
      title: '周会纪要',
      markdown: [
        '# 周会纪要',
        '',
        '## 议题',
        '',
        '- 外层',
        '  - 内层',
        '- 第二项',
        '',
        '1. 步骤',
        '',
        '- [x] 跟进',
        '',
        '> 原话',
        '',
        '```typescript',
        'const a = 1;',
        '```',
        '',
        '---',
        '',
        '| 列一 | 列二 |',
        '| --- | --- |',
        '| A\\|B | C |',
        '',
      ].join('\n'),
    });
  });

  test('自动续号的有序列表项（seq 为 auto）仍是 Markdown 有序列表', () => {
    const b = (data: Record<string, unknown>) => ({ data });
    const blocks: BlockMap = {
      page: b({ type: 'page', text: text('步骤'), children: ['o1', 'o2'] }),
      o1: b({ type: 'ordered', text: text('打开页面'), seq: '1' }),
      o2: b({ type: 'ordered', text: text('点导出'), seq: 'auto' }),
    };
    const lines = docxToMarkdown(blocks, 'page').markdown.split('\n');
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(2);
  });

  test('表格单元格里的图片、编号列表、附件都留下；带换行的图片说明、链接卡片与嵌入的链接不丢', () => {
    const b = (data: Record<string, unknown>) => ({ data });
    const blocks: BlockMap = {
      page: b({ type: 'page', text: text('需求'), children: ['bm', 'tb', 'ifr'] }),
      bm: b({
        type: 'bookmark',
        bookmark: { title: '设计稿 [PC]', url: 'https://design.example/f?node-id=1-2' },
      }),
      tb: b({
        type: 'table',
        rows_id: ['r1'],
        columns_id: ['c1', 'c2'],
        cell_set: { r1c1: { block_id: 'x1' }, r1c2: { block_id: 'x2' } },
      }),
      x1: b({ type: 'table_cell', children: ['o1', 'o2', 'v'] }),
      o1: b({ type: 'ordered', text: text('选链'), seq: '1' }),
      o2: b({ type: 'ordered', text: text('输入'), seq: 'auto' }),
      v: b({ type: 'view', children: ['f'] }),
      f: b({ type: 'file', file: { name: '演示.mp4', token: 'boxFileToken0000000001' } }),
      x2: b({ type: 'table_cell', children: ['img', 'empty'] }),
      img: b({
        type: 'image',
        image: { token: 'boxImageToken000000001', caption: { text: text('设计稿：BSC\n') } },
      }),
      empty: b({ type: 'text', text: text('') }),
      ifr: b({
        type: 'iframe',
        iframe: {
          component: {
            original_text: 'https%3A%2F%2Fdocs.example%2Fminutes%2Fabc',
            url: 'https://docs.example/minutes/embed/abc',
          },
        },
      }),
    };
    expect(docxToMarkdown(blocks, 'page').markdown.split('\n')).toEqual([
      '# 需求',
      '',
      '[设计稿 ［PC］](https://design.example/f?node-id=1-2)',
      '',
      '| 1. 选链<br>2. 输入<br>[演示.mp4](boxFileToken0000000001) | ![设计稿：BSC](boxImageToken000000001) |',
      '| --- | --- |',
      '',
      '[https://docs.example/minutes/abc](https://docs.example/minutes/abc)',
      '',
    ]);
  });
});
