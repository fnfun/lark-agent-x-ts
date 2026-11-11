import { LarkAuth } from '../auth.js';
import { Sheets } from '../domains/sheet.js';
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
  help: '读工作表的单元格,每行一行、单元格用 Tab 分隔(公式有存下的计算结果时取结果,否则显示 =公式)',
  access: 'sheet.read',
  positionals: [SHEET_ARG],
  options: [
    TAB_OPTION,
    { name: 'range', kind: 'string', help: '只读这个范围,如 A1:C10' },
    JSON_OPTION,
  ],
  run: (a) =>
    guarded(async () => {
      const rows = await new Sheets(web()).read(await token(a), {
        ...tab(a),
        ...(a.range ? { range: String(a.range) } : {}),
      });
      if (a.json) printJson(rows);
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
  help: '在最后一行有内容的行下面追加行(每个参数一行,单元格用 --sep 分隔)',
  access: 'sheet.append',
  positionals: [SHEET_ARG, { name: 'rows', nargs: '+' }],
  options: [TAB_OPTION, { name: 'sep', kind: 'string', default: ',', help: '单元格分隔符' }],
  run: (a) =>
    guarded(async () => {
      const sep = String(a.sep);
      const rows = (a.rows as string[]).map((r) => r.split(sep) as CellValue[]);
      const at = await new Sheets(web()).append(await token(a), rows, tab(a));
      out(`已追加 ${rows.length} 行,从第 ${at} 行起`);
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
  help: '电子表格:列工作表、读单元格、写单元格(含公式)、追加行、插入删除行列',
  subcommands: [tabs, read, write, append, insertRows, deleteRows, insertCols, deleteCols],
};
