import { describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseCells } from '../src/cli/sheet.js';
import { columnName, Sheets, tabsOf } from '../src/domains/sheet.js';
import { cellIndex, readXlsx } from '../src/domains/xlsx.js';
import type { WebRequest, WebSession } from '../src/web.js';

const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const varint = (n: number) => {
  const out: number[] = [];
  let x = n;
  do {
    out.push((x > 127 ? 0x80 : 0) | (x & 0x7f));
    x >>>= 7;
  } while (x);
  return out;
};
const msg = (f: number, body: number[]) => [...varint(f * 8 + 2), ...varint(body.length), ...body];
const num = (f: number, n: number) => [...varint(f * 8), ...varint(n)];

/** Decodes length-delimited and varint fields (test-side reader for the actions sent). */
function decode(b: Uint8Array): [number, number | Uint8Array][] {
  const out: [number, number | Uint8Array][] = [];
  let i = 0;
  const vi = () => {
    let r = 0;
    let s = 0;
    for (;;) {
      const x = b[i++] as number;
      r |= (x & 0x7f) << s;
      s += 7;
      if (x < 0x80) return r;
    }
  };
  while (i < b.length) {
    const k = vi();
    if ((k & 7) === 0) out.push([k >> 3, vi()]);
    else {
      const n = vi();
      out.push([k >> 3, b.subarray(i, i + n)]);
      i += n;
    }
  }
  return out;
}

/** A zip with stored (uncompressed) entries. */
function zip(files: Record<string, string>): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 255, n >> 8];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = utf8(name);
    const body = utf8(text);
    const offset = local.length;
    local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(0));
    local.push(
      ...u32(body.length),
      ...u32(body.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...body,
    );
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(0),
    );
    central.push(
      ...u32(body.length),
      ...u32(body.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
    );
    central.push(...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
  }
  const end = [
    ...u32(0x06054b50),
    0,
    0,
    0,
    0,
    ...u16(Object.keys(files).length),
    ...u16(Object.keys(files).length),
  ];
  end.push(...u32(central.length), ...u32(local.length), 0, 0);
  return new Uint8Array([...local, ...central, ...end]);
}

const XLSX = zip({
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="汇总" sheetId="2" r:id="rId2"/><sheet name="明细 &amp; 备注" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':
    '<sst><si><t>名称</t></si><si><r><t>苹果</t></r><r><t xml:space="preserve">, &#34;红&#34;</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>2.5</v></c></row><row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3"><f>A1*2</f></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="inlineStr"><is><t>行内</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="str"><f>CONCAT("合","计")</f><v>合计</v></c></row></sheetData></worksheet>',
});

describe('表格', () => {
  test('xlsx：按工作簿顺序取工作表；共享字符串拼接富文本并反转义；空行空格补 null；公式显示缓存值，没有时显示为 =公式；公式单元格不论有无缓存值都记下', () => {
    expect(readXlsx(XLSX)).toEqual([
      { name: '汇总', rows: [['合计']], formulas: new Set(['A1']) },
      {
        name: '明细 & 备注',
        rows: [['名称', null, 2.5], [], [null, '苹果, "红"', '=A1*2', true, '行内']],
        formulas: new Set(['C3']),
      },
    ]);
  });

  test('单元格引用和列名互转（含两位字母的列）', () => {
    expect(cellIndex('C12')).toEqual([11, 2]);
    expect(cellIndex('aa1')).toEqual([0, 26]);
    expect([columnName(0), columnName(25), columnName(26), columnName(701)]).toEqual([
      'A',
      'Z',
      'AA',
      'ZZ',
    ]);
    expect(() => cellIndex('第一格')).toThrow('A1');
  });

  test('从顶层快照里取工作表列表，按序号排序；其他段落忽略', () => {
    const tab = (id: string, index: number, name: string) =>
      msg(1, [
        ...msg(1, utf8(id)),
        ...num(2, index),
        ...msg(3, utf8(name)),
        ...num(4, 200),
        ...num(5, 20),
      ]);
    const snapshot = [
      ...msg(1, [...num(1, 1), ...msg(2, [...num(1, 2), ...msg(2, utf8('zh'))])]),
      ...msg(1, [
        ...num(1, 1),
        ...msg(2, [...num(1, 3), ...msg(3, [...tab('b2', 1, '明细'), ...tab('a1', 0, '汇总')])]),
      ]),
    ];
    expect(tabsOf(new Uint8Array(snapshot)).map((t) => [t.id, t.name, t.rows])).toEqual([
      ['a1', '汇总', 200],
      ['b2', '明细', 200],
    ]);
  });

  /** A fake server holding one tab "Sheet1" (id s1) at revision 7; records each commit sent. */
  function fakeSheets(xlsx?: Uint8Array) {
    const topSnapshot = gzipSync(
      Buffer.from(
        msg(1, [
          ...num(1, 1),
          ...msg(2, [
            ...num(1, 3),
            ...msg(3, msg(1, [...msg(1, utf8('s1')), ...msg(3, utf8('Sheet1'))])),
          ]),
        ]),
      ),
    ).toString('base64');
    const page = `<script>window.DATA={clientVars:{"code":0,"data":{"revision":7,"snapshot":{"gzipTopSnapshot":"${topSnapshot}"}}},ssr:true}</script>`;
    const sent: Record<string, unknown>[] = [];
    const web = {
      // The page for the sheet's state, or the exported .xlsx for downloads.
      request: async (_m: string, path: string) =>
        new Response(path.includes('download') ? xlsx : page),
      json: async (_m: string, path: string, o: WebRequest = {}) => {
        if (path.includes('export/create')) return { code: 0, data: { ticket: 'K' } };
        if (path.includes('export/result'))
          return { code: 0, data: { result: { job_status: 0, file_token: 'F' } } };
        sent.push(o.json as Record<string, unknown>);
        return { code: 0, data: { type: 'ACCEPT_COMMIT', new_rev: 8 } };
      },
    } as unknown as WebSession;
    /** The actions of the n-th commit: [type, tab, {position fields}, cell JSON]. */
    const actions = (n: number) =>
      decode(new Uint8Array(gunzipSync(Buffer.from(String(sent[n]?.content), 'base64')))).map(
        ([, a]) => {
          const f = Object.fromEntries(decode(a as Uint8Array));
          return [
            f[1],
            new TextDecoder().decode(f[2] as Uint8Array),
            Object.fromEntries(decode(f[4] as Uint8Array)),
            f[5] === undefined
              ? undefined
              : JSON.parse(new TextDecoder().decode(f[5] as Uint8Array)),
          ] as const;
        },
      );
    return { sheets: new Sheets(web), sent, actions };
  }

  test('写单元格：按工作表 id 和行列发设值动作，数字文本写成数字、空串清空', async () => {
    const { sheets, sent, actions } = fakeSheets();
    expect(await sheets.write('T', { B3: '42', A1: '名称', C1: '' })).toBe(8);
    expect(sent[0]?.base_rev).toBe(7);
    expect(
      actions(0).map(([type, tab, pos, cell]) => [type, tab, pos[1] ?? 0, pos[3] ?? 0, cell.value]),
    ).toEqual([
      [4, 's1', 2, 1, 42],
      [4, 's1', 0, 0, '名称'],
      [4, 's1', 0, 2, null],
    ]);
  });

  test('写公式：带上公式和解析结果、值留空由网页端计算；引用其他工作表时什么都不发', async () => {
    const { sheets, sent, actions } = fakeSheets();
    await sheets.write('T', { C1: '=SUM(A1:B1)' });
    expect(actions(0)[0]?.[3]).toMatchObject({
      formula: '=SUM(A1:B1)',
      value: null,
      formulaData: { refs: { R1: { col: 0, colCount: 2, row: 0, rowCount: 1 } } },
    });
    await expect(sheets.write('T', { A2: '=Sheet2!A1' })).rejects.toThrow('其他工作表');
    expect(sent).toHaveLength(1);
  });

  test('插入删除行列：行号从 1、列用字母，换成从 0 开始的位置和数量；位置或数量不合法时不发', async () => {
    const { sheets, sent, actions } = fakeSheets();
    await sheets.insertRows('T', 3, 2);
    await sheets.deleteRows('T', 1);
    await sheets.insertColumns('T', 'AB');
    await sheets.deleteColumns('T', 'C', 3);
    expect([0, 1, 2, 3].map((n) => actions(n)[0]?.slice(0, 3))).toEqual([
      [5, 's1', { 1: 2, 2: 2 }],
      [6, 's1', { 1: 0, 2: 1 }],
      [7, 's1', { 3: 27, 4: 1 }],
      [8, 's1', { 3: 2, 4: 3 }],
    ]);
    await expect(sheets.deleteRows('T', 0)).rejects.toThrow('行列位置');
    await expect(sheets.insertRows('T', 2, 0)).rejects.toThrow('行列位置');
    expect(sent).toHaveLength(4);
  });

  test('查找替换：按导出的单元格逐个替换、只写改到的格子；公式格子（含有缓存值的）不碰', async () => {
    const book = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>苹果园</t></is></c><c r="B1" t="str"><f>A1</f><v>苹果园</v></c><c r="C1"><v>10</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>苹果苹果</t></is></c></row></sheetData></worksheet>',
    });
    const { sheets, sent, actions } = fakeSheets(book);
    expect(await sheets.replace('T', '苹果', '梨')).toEqual({ cells: 2, replaced: 3 });
    expect(actions(0).map(([, , pos, cell]) => [pos[1] ?? 0, pos[3] ?? 0, cell.value])).toEqual([
      [0, 0, '梨园'],
      [1, 0, '梨梨'],
    ]);
    expect(await sheets.replace('T', '香蕉', '梨')).toEqual({ cells: 0, replaced: 0 });
    expect(sent).toHaveLength(1);
  });

  test('命令行的 单元格=值：引用转大写，值可含等号', () => {
    expect(parseCells(['b2=a=b', 'C3='])).toEqual({ B2: 'a=b', C3: '' });
    expect(() => parseCells(['B2'])).toThrow('单元格=值');
  });
});
