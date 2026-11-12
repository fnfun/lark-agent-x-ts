import { readFileSync } from 'node:fs';
import { LarkAuth } from '../auth.js';
import { parseCsv, toCsv } from '../csv.js';
import { type CellStyle, Sheets } from '../domains/sheet.js';
import { Wiki } from '../domains/wiki.js';
import type { CellValue } from '../domains/xlsx.js';
import { WebSession } from '../web.js';
import type { Option } from './args.js';
import { type Command, type CommandGroup, err, out } from './common.js';
import { errorText, printJson } from './format.js';

const web = () => new WebSession(new LarkAuth());
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };
const TAB_OPTION: Option = { name: 'tab', kind: 'string', help: '工作表名;不填为第一个' };
const SHEET_ARG = { name: 'sheet', help: '表格链接(含知识库链接)或 token' };

/** The spreadsheet token a command names: a /sheets/ link, a wiki link, or a token. */
async function token(a: Record<string, unknown>): Promise<string> {
  const input = String(a.sheet);
  if (/\/wiki\//.test(input)) {
    const ref = await new Wiki(web()).resolve(input);
    if (ref.type !== 'sheet') throw new Error('这个知识库页面不是表格');
    return ref.token;
  }
  return /\/sheets\/([A-Za-z0-9]+)/.exec(input)?.[1] ?? input.trim();
}

const tab = (a: Record<string, unknown>) => (a.tab ? { sheet: String(a.tab) } : {});

/** A cell for tab-separated output: tabs and newlines inside it become spaces. */
const show = (v: CellValue) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));

/** `A1=value` arguments → cells (the first `=` splits). */
export function parseCells(items: string[]): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {};
  for (const item of items) {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`要写成 单元格=值: ${item}`);
    cells[item.slice(0, i).trim().toUpperCase()] = item.slice(i + 1);
  }
  return cells;
}

/** Runs a command body, printing an error and returning 1 when it throws. */
async function guarded(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    err(errorText(e));
    return 1;
  }
}

const tabs: Command = {
  name: 'tabs',
  help: '列出表格里的工作表',
  access: 'sheet.tabs',
  positionals: [SHEET_ARG],
  options: [JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const list = await new Sheets(web()).tabs(await token(a));
      if (a.json) printJson(list);
      else for (const t of list) out(`${t.id}\t${t.name}\t${t.rows}x${t.columns}`);
      return 0;
    }),
};

const read: Command = {
  name: 'read',
  help: '读工作表的单元格,每行一行、单元格用 Tab 分隔(公式有存下的计算结果时取结果,否则显示 =公式);--csv 输出 CSV',
  access: 'sheet.read',
  positionals: [SHEET_ARG],
  options: [
    TAB_OPTION,
    { name: 'range', kind: 'string', help: '只读这个范围,如 A1:C10' },
    { name: 'csv', kind: 'flag', help: '输出 CSV(单元格里的换行、逗号、引号按 CSV 规则保留)' },
    JSON_OPTION,
  ],
  run: (a) =>
    guarded(async () => {
      const rows = await new Sheets(web()).read(await token(a), {
        ...tab(a),
        ...(a.range ? { range: String(a.range) } : {}),
      });
      if (a.json) printJson(rows);
      else if (a.csv) out(toCsv(rows.map((r) => r.map((v) => (v === null ? '' : String(v))))));
      else for (const row of rows) out(row.map(show).join('\t'));
      return 0;
    }),
};

const write: Command = {
  name: 'write',
  help: '写单元格(A1=值;数字按数字写,值以 = 开头为公式,如 C1==SUM(A1:B1);值留空为清空)',
  access: 'sheet.write',
  positionals: [SHEET_ARG, { name: 'cells', nargs: '+', help: '单元格=值' }],
  options: [TAB_OPTION],
  run: (a) =>
    guarded(async () => {
      await new Sheets(web()).write(await token(a), parseCells(a.cells as string[]), tab(a));
      out('已写入');
      return 0;
    }),
};

const append: Command = {
  name: 'append',
  help: '在最后一行有内容的行下面追加行(每个参数一行,单元格用 --sep 分隔;或 --csv 从 CSV 文件读)',
  access: 'sheet.append',
  positionals: [SHEET_ARG, { name: 'rows', nargs: '*' }],
  options: [
    TAB_OPTION,
    { name: 'sep', kind: 'string', default: ',', help: '单元格分隔符' },
    { name: 'csv', kind: 'string', help: '从这个 CSV 文件读要追加的行(- 为标准输入)' },
  ],
  run: (a) =>
    guarded(async () => {
      const sep = String(a.sep);
      const given = (a.rows as string[] | undefined) ?? [];
      if (a.csv !== undefined && given.length) throw new Error('--csv 和行参数只能给一种');
      const rows: CellValue[][] =
        a.csv !== undefined
          ? parseCsv(
              String(a.csv) === '-'
                ? await new Response(Bun.stdin.stream()).text()
                : readFileSync(String(a.csv), 'utf8'),
            )
          : given.map((r) => r.split(sep));
      if (!rows.length) throw new Error('没有要追加的行');
      const at = await new Sheets(web()).append(await token(a), rows, tab(a));
      out(`已追加 ${rows.length} 行,从第 ${at} 行起`);
      return 0;
    }),
};

const replace: Command = {
  name: 'replace',
  help: '在工作表里查找替换文字(跳过公式单元格)',
  access: 'sheet.replace',
  positionals: [SHEET_ARG, { name: 'find' }, { name: 'replacement' }],
  options: [TAB_OPTION],
  run: (a) =>
    guarded(async () => {
      const r = await new Sheets(web()).replace(
        await token(a),
        String(a.find),
        String(a.replacement),
        tab(a),
      );
      out(`已替换 ${r.replaced} 处(${r.cells} 个单元格)`);
      return r.replaced ? 0 : 1;
    }),
};

const ON_OFF = { kind: 'string' as const, choices: ['on', 'off'] };
/** The on/off options given, as CellStyle flags. */
const flags = (a: Record<string, unknown>): CellStyle => {
  const out: CellStyle = {};
  const names = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikethrough' };
  for (const [option, key] of Object.entries(names))
    if (a[option] !== undefined) out[key as 'bold'] = a[option] === 'on';
  return out;
};

const style: Command = {
  name: 'style',
  help: '设置单元格或区域的格式(加粗、斜体、下划线、删除线、颜色、填充色、对齐、字号、数字格式、边框)',
  access: 'sheet.style',
  positionals: [SHEET_ARG, { name: 'range', help: '单元格或区域,如 C3 或 A1:C10' }],
  options: [
    TAB_OPTION,
    { name: 'bold', ...ON_OFF },
    { name: 'italic', ...ON_OFF },
    { name: 'underline', ...ON_OFF },
    { name: 'strike', ...ON_OFF, help: '删除线' },
    { name: 'color', kind: 'string', help: '字体颜色,#rrggbb' },
    { name: 'background', kind: 'string', help: '填充色,#rrggbb' },
    { name: 'align', kind: 'string', choices: ['left', 'center', 'right'] },
    { name: 'size', kind: 'int', help: '字号(磅)' },
    { name: 'format', kind: 'string', help: '数字格式,Excel 写法,如 0.00% 或 #,##0' },
    {
      name: 'border',
      kind: 'string',
      choices: ['all', 'outer', 'none'],
      help: '边框:all 每个单元格四边,outer 区域外框,none 去掉区域内单元格的边框',
    },
    { name: 'border-color', kind: 'string', help: '边框颜色,#rrggbb(默认深灰)' },
  ],
  run: (a) =>
    guarded(async () => {
      const s: CellStyle = {
        ...flags(a),
        ...(a.color ? { color: String(a.color) } : {}),
        ...(a.background ? { background: String(a.background) } : {}),
        ...(a.align ? { align: String(a.align) as NonNullable<CellStyle['align']> } : {}),
        ...(a.size !== undefined ? { fontSize: Number(a.size) } : {}),
        ...(a.format !== undefined ? { format: String(a.format) } : {}),
        ...(a.border !== undefined
          ? { border: String(a.border) as NonNullable<CellStyle['border']> }
          : {}),
        ...(a.border_color !== undefined ? { borderColor: String(a.border_color) } : {}),
      };
      await new Sheets(web()).style(await token(a), String(a.range), s, tab(a));
      out('已设置');
      return 0;
    }),
};

const merge: Command = {
  name: 'merge',
  help: '合并单元格(保留左上角的内容);--undo 取消区域内的合并',
  access: 'sheet.merge',
  positionals: [SHEET_ARG, { name: 'range', help: '区域,如 A3:B4' }],
  options: [TAB_OPTION, { name: 'undo', kind: 'flag', help: '取消合并' }],
  run: (a) =>
    guarded(async () => {
      const s = new Sheets(web());
      if (a.undo) await s.unmerge(await token(a), String(a.range), tab(a));
      else await s.merge(await token(a), String(a.range), tab(a));
      out(a.undo ? '已取消合并' : '已合并');
      return 0;
    }),
};

const tabAdd: Command = {
  name: 'tab-add',
  help: '新增工作表',
  access: 'sheet.tab-add',
  positionals: [SHEET_ARG, { name: 'name', nargs: '+' }],
  options: [{ name: 'at', kind: 'int', help: '放到第几个(默认最后)' }],
  run: (a) =>
    guarded(async () => {
      const id = await new Sheets(web()).addTab(
        await token(a),
        (a.name as string[]).join(' '),
        a.at === undefined ? {} : { at: Number(a.at) },
      );
      out(`已新增 sheet_id=${id}`);
      return 0;
    }),
};

const tabRm: Command = {
  name: 'tab-rm',
  help: '删除工作表(按名字;至少留一个;tabs 要过约半分钟才不再列出它)',
  access: 'sheet.tab-rm',
  positionals: [SHEET_ARG, { name: 'name', nargs: '+' }],
  run: (a) =>
    guarded(async () => {
      await new Sheets(web()).removeTab(await token(a), (a.name as string[]).join(' '));
      out('已删除');
      return 0;
    }),
};

/** insert-rows / delete-rows / insert-cols / delete-cols. */
function dimension(
  name: string,
  help: string,
  access: Command['access'],
  at: { name: string; help: string },
  run: (
    s: Sheets,
    token: string,
    at: string,
    count: number,
    o: { sheet?: string },
  ) => Promise<number>,
): Command {
  return {
    name,
    help,
    access,
    positionals: [SHEET_ARG, at],
    options: [TAB_OPTION, { name: 'count', kind: 'int', default: 1, help: '几行 / 几列' }],
    run: (a) =>
      guarded(async () => {
        await run(new Sheets(web()), await token(a), String(a[at.name]), Number(a.count), tab(a));
        out('已完成');
        return 0;
      }),
  };
}

const ROW_AT = { name: 'row', help: '行号(从 1 开始)' };
const COL_AT = { name: 'column', help: '列(字母,如 C)' };
const insertRows = dimension(
  'insert-rows',
  '在这一行上面插入空行',
  'sheet.insert-rows',
  ROW_AT,
  (s, t, at, n, o) => s.insertRows(t, Number(at), n, o),
);
const deleteRows = dimension(
  'delete-rows',
  '从这一行起删除若干行',
  'sheet.delete-rows',
  ROW_AT,
  (s, t, at, n, o) => s.deleteRows(t, Number(at), n, o),
);
const insertCols = dimension(
  'insert-cols',
  '在这一列左边插入空列',
  'sheet.insert-cols',
  COL_AT,
  (s, t, at, n, o) => s.insertColumns(t, at, n, o),
);
const deleteCols = dimension(
  'delete-cols',
  '从这一列起删除若干列',
  'sheet.delete-cols',
  COL_AT,
  (s, t, at, n, o) => s.deleteColumns(t, at, n, o),
);

export const sheetGroup: CommandGroup = {
  name: 'sheet',
  help: '电子表格:列工作表、增删工作表、读单元格、写单元格(含公式)、追加行、查找替换、设置格式、合并单元格、插入删除行列',
  subcommands: [
    tabs,
    read,
    write,
    append,
    replace,
    style,
    merge,
    tabAdd,
    tabRm,
    insertRows,
    deleteRows,
    insertCols,
    deleteCols,
  ],
};
