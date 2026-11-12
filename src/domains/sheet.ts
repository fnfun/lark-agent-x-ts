/**
 * Sheets (spreadsheets) over the Sheets web app. Shapes were read off the web app's traffic in a
 * headless browser on a sheet created for the test, then replayed over HTTP on 2026-11-11 on both
 * test accounts with sheets created for the test and removed afterwards:
 *
 * - The sheet page (`/sheets/<token>`) embeds its client vars (`window.DATA = {clientVars: ...}`):
 *   `revision`, and `snapshot.gzipTopSnapshot`, a gzip'd protobuf whose entries 1 → 2 (kind 3) →
 *   3 → 1 list the tabs as {1: sheet id, 2: index, 3: name, 4: rows, 5: columns}.
 * - Writing is `POST /space/api/v2/sheet/user_changes?token&member_id` (JSON: base_rev, content,
 *   mode 0, msg_id, msg_timestamp); content is a gzip'd protobuf of actions, a cell set being
 *   {1: 4, 2: sheet id, 4: {1: row, 3: column}, 5: cell JSON {style, value, reminder,
 *   dataValidation}}. The reply's `data.type` is ACCEPT_COMMIT with `new_rev`; a stale base_rev
 *   was accepted.
 * - A formula cell carries the web app's parsed form (`formulaData`, built by sheet-formula.ts);
 *   values are computed by the web app, so exports hold the formula text without a value.
 * - Rows and columns: action 5 / 6 insert / delete rows ({1: start row, 2: count}), 7 / 8 insert /
 *   delete columns ({3: start column, 4: count}); the web app follows them with row heights (17)
 *   and column widths (18), which are optional.
 * - Tabs: action 22 adds one (its new id: 6 capital letters and digits; JSON {sheet_id,
 *   sheet_name, index}), 20 removes one (JSON {sheet_name, index}); neither has a position field.
 *   The page's tab list shows an added tab at once but keeps a removed one for about half a minute.
 * - Styles: action 61, one property per action, JSON {style, target: {type: 0, row, col, rowCount,
 *   colCount}}, no position field: `fontInfo.fontWeight` 700 / 400, `fontInfo.fontStyle` "italic" /
 *   "normal", `fontInfo.fontSize` "14pt", `textDecoration: {flag: 1 underline | 2 strikethrough,
 *   active}` where active false turns it on and true off, `foreColor` / `backColor` "#rrggbb",
 *   `hAlign` 0 left, 1 center, 2 right, `formatter.formatCached` a number format ("0%",
 *   "¥#,##0.00", Excel's syntax), `borderTop` / `borderRight` / `borderBottom` / `borderLeft`
 *   `{color, width: 1, lineStyle: 2}` for a thin line or null for none, applied to every cell in
 *   the target (so an outline sets each side on its outer row or column only).
 * - Merging: action 9 over the range with JSON `[{target: {row, col, row_count, col_count}}]`, after
 *   a cell set on its top-left cell with `{style: null, dataValidation: null}` (no value, which
 *   keeps the cell's value); unmerging sends `[]` over the range. (The web app sets borders with
 *   another action, 74, that rewrites whole cell styles; the style action above does it per side.)
 * - Reading exports the sheet as .xlsx (the Docs export API) and parses it (xlsx.ts); the cell
 *   blocks embedded in the page use an undocumented columnar encoding.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import type { WebSession } from '../web.js';
import { check, Docs } from './docs.js';
import { compileFormula } from './sheet-formula.js';
import { type CellValue, cellIndex, readXlsx } from './xlsx.js';

type Dict = Record<string, unknown>;

export interface SheetTab {
  id: string;
  name: string;
  index: number;
  rows: number;
  columns: number;
}

interface SheetState {
  revision: number;
  tabs: SheetTab[];
}

/** Protobuf fields of a message: field number → raw values (numbers or byte strings). */
function fields(b: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const out = new Map<number, (number | Uint8Array)[]>();
  let i = 0;
  const varint = () => {
    let r = 0;
    let shift = 1;
    for (;;) {
      const x = b[i++] as number;
      r += (x & 0x7f) * shift;
      shift *= 128;
      if (x < 0x80) return r;
    }
  };
  while (i < b.length) {
    const key = varint();
    const wire = key & 7;
    let v: number | Uint8Array;
    if (wire === 0) v = varint();
    else if (wire === 2) {
      const n = varint();
      v = b.subarray(i, i + n);
      i += n;
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      continue;
    } else throw new Error(`表格快照格式不对(wire ${wire})`);
    const f = Math.floor(key / 8);
    out.set(f, [...(out.get(f) ?? []), v]);
  }
  return out;
}
const bytes = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array());
const str = (v: unknown) => new TextDecoder().decode(bytes(v));

/** The tabs listed in a sheet's top snapshot. */
export function tabsOf(topSnapshot: Uint8Array): SheetTab[] {
  const tabs: SheetTab[] = [];
  for (const entry of fields(topSnapshot).get(1) ?? []) {
    const body = fields(bytes(entry)).get(2)?.[0];
    const section = fields(bytes(body));
    if (section.get(1)?.[0] !== 3) continue;
    for (const s of section.get(3) ?? [])
      for (const t of fields(bytes(s)).get(1) ?? []) {
        const f = fields(bytes(t));
        tabs.push({
          id: str(f.get(1)?.[0]),
          index: Number(f.get(2)?.[0] ?? 0),
          name: str(f.get(3)?.[0]),
          rows: Number(f.get(4)?.[0] ?? 0),
          columns: Number(f.get(5)?.[0] ?? 0),
        });
      }
  }
  return tabs.sort((a, b) => a.index - b.index);
}

const varint = (n: number): number[] => {
  const out: number[] = [];
  let x = n;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x) b |= 0x80;
    out.push(b);
  } while (x);
  return out;
};
const lenField = (f: number, body: number[]) => [
  ...varint(f * 8 + 2),
  ...varint(body.length),
  ...body,
];
const numField = (f: number, n: number) => [...varint(f * 8), ...varint(n)];
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

/** A position in an action: {1: row, 2: row count, 3: column, 4: column count}. */
const position = (p: { row?: number; rows?: number; col?: number; cols?: number }) =>
  lenField(4, [
    ...(p.row !== undefined ? numField(1, p.row) : []),
    ...(p.rows !== undefined ? numField(2, p.rows) : []),
    ...(p.col !== undefined ? numField(3, p.col) : []),
    ...(p.cols !== undefined ? numField(4, p.cols) : []),
  ]);

/** Action types of `v2/sheet/user_changes`. */
const ACTION = {
  setCell: 4,
  insertRows: 5,
  deleteRows: 6,
  insertColumns: 7,
  deleteColumns: 8,
  merge: 9,
  removeTab: 20,
  addTab: 22,
  style: 61,
};

/** Cell formatting `Sheets.style` applies; unset properties are left as they are. */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Text colour, "#rrggbb". */
  color?: string;
  /** Fill colour, "#rrggbb". */
  background?: string;
  align?: 'left' | 'center' | 'right';
  /** Font size in points. */
  fontSize?: number;
  /** Number format in Excel's syntax, e.g. "0.00%", "#,##0", "yyyy/MM/dd". */
  format?: string;
  /** Borders: every cell's four sides, the range's outline, or none. */
  border?: 'all' | 'outer' | 'none';
  /** Border colour, "#rrggbb" (the web app's default dark grey otherwise). */
  borderColor?: string;
}

/** A thin line, as the web app draws borders. */
const BORDER_LINE = { width: 1, lineStyle: 2 };
const DEFAULT_BORDER_COLOR = '#1f2329';

type Area = { row: number; col: number; rows: number; cols: number };

/**
 * The border actions' style and target for a range: each side is set on the cells it borders
 * (all cells for "all", the outer row or column for "outer"), null removes it.
 */
export function borderParts(
  border: NonNullable<CellStyle['border']>,
  color: string,
  r: Area,
): { style: Record<string, unknown>; target: Record<string, number> }[] {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`颜色要写成 #rrggbb: ${color}`);
  const line = border === 'none' ? null : { color: color.toLowerCase(), ...BORDER_LINE };
  const target = (row: number, col: number, rows: number, cols: number) => ({
    type: 0,
    row,
    col,
    rowCount: rows,
    colCount: cols,
  });
  const whole = target(r.row, r.col, r.rows, r.cols);
  if (border !== 'outer')
    return ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'].map((side) => ({
      style: { [side]: line },
      target: whole,
    }));
  return [
    { style: { borderTop: line }, target: target(r.row, r.col, 1, r.cols) },
    { style: { borderRight: line }, target: target(r.row, r.col + r.cols - 1, r.rows, 1) },
    { style: { borderBottom: line }, target: target(r.row + r.rows - 1, r.col, 1, r.cols) },
    { style: { borderLeft: line }, target: target(r.row, r.col, r.rows, 1) },
  ];
}

const ALIGN = { left: 0, center: 1, right: 2 } as const;

/** The style properties of a CellStyle, one object per action, as the web app sends them. */
export function styleParts(style: CellStyle): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  const color = (c: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`颜色要写成 #rrggbb: ${c}`);
    return c.toLowerCase();
  };
  if (style.bold !== undefined) parts.push({ fontInfo: { fontWeight: style.bold ? 700 : 400 } });
  if (style.italic !== undefined)
    parts.push({ fontInfo: { fontStyle: style.italic ? 'italic' : 'normal' } });
  if (style.fontSize !== undefined) {
    if (!(style.fontSize > 0)) throw new Error(`字号要是正数: ${style.fontSize}`);
    parts.push({ fontInfo: { fontSize: `${style.fontSize}pt` } });
  }
  if (style.underline !== undefined)
    parts.push({ textDecoration: { active: !style.underline, flag: 1 } });
  if (style.strikethrough !== undefined)
    parts.push({ textDecoration: { active: !style.strikethrough, flag: 2 } });
  if (style.color !== undefined) parts.push({ foreColor: color(style.color) });
  if (style.background !== undefined) parts.push({ backColor: color(style.background) });
  if (style.align !== undefined) parts.push({ hAlign: ALIGN[style.align] });
  if (style.format !== undefined) parts.push({ formatter: { formatCached: style.format } });
  return parts;
}

/** One action: its type, the tab, where (none for tab actions), and its JSON (a cell's, a tab's). */
function action(
  type: number,
  sheetId: string,
  where: Parameters<typeof position>[0] | null,
  json?: unknown,
) {
  return lenField(1, [
    ...numField(1, type),
    ...lenField(2, utf8(sheetId)),
    ...(where ? position(where) : []),
    ...(json === undefined ? [] : lenField(5, utf8(JSON.stringify(json)))),
  ]);
}

/** "C3" or "A1:C10" (either corner first) → top-left row and column (from 0) and size. */
function area(range: string) {
  const [from, to = from] = range.split(':') as [string, string?];
  const [r0, c0] = cellIndex(from);
  const [r1, c1] = cellIndex(to);
  return {
    row: Math.min(r0, r1),
    col: Math.min(c0, c1),
    rows: Math.abs(r1 - r0) + 1,
    cols: Math.abs(c1 - c0) + 1,
  };
}

const TAB_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * The protobuf action that sets one cell (a value, or a formula starting with "="); `sheets` maps
 * tab names to ids for formulas referring to other tabs.
 */
export function setCellAction(
  sheetId: string,
  row: number,
  col: number,
  value: CellValue,
  sheets: Record<string, string> = {},
): number[] {
  const cell =
    typeof value === 'string' && value.startsWith('=')
      ? {
          style: null,
          formula: value,
          formulaData: compileFormula(value, sheets),
          value: null,
          reminder: null,
          dataValidation: null,
        }
      : { style: null, value, reminder: null, dataValidation: null };
  return action(ACTION.setCell, sheetId, { row, col }, cell);
}

/** A value typed into a cell: numbers stay numbers, numeric text becomes a number, "" clears. */
function cellValue(input: CellValue): CellValue {
  if (typeof input !== 'string') return input;
  if (input === '') return null;
  if (input.startsWith('=')) return input;
  const n = Number(input);
  return input.trim() !== '' &&
    Number.isFinite(n) &&
    /^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(input.trim())
    ? n
    : input;
}

/** Column index (from 0) → letters. */
export function columnName(col: number): string {
  let s = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export class Sheets {
  constructor(readonly web: WebSession) {}

  /** The tabs of a spreadsheet, in order. */
  async tabs(token: string): Promise<SheetTab[]> {
    return (await this.state(token)).tabs;
  }

  /** A tab's cells (the first tab by default) as rows from A1; `range` like "A1:C10" trims them. */
  async read(token: string, o: { sheet?: string; range?: string } = {}): Promise<CellValue[][]> {
    const file = await new Docs(this.web).export({ token, type: 'sheet' }, { format: 'xlsx' });
    const sheets = readXlsx(file.data);
    const sheet = o.sheet ? sheets.find((s) => s.name === o.sheet) : sheets[0];
    if (!sheet) throw new Error(`没有这个工作表: ${o.sheet ?? ''}`);
    if (!o.range) return sheet.rows;
    const [from, to = from] = o.range.split(':') as [string, string?];
    const [r0, c0] = cellIndex(from);
    const [r1, c1] = cellIndex(to);
    return sheet.rows
      .slice(r0, r1 + 1)
      .map((row) => Array.from({ length: c1 - c0 + 1 }, (_, i) => row[c0 + i] ?? null));
  }

  /** Set cells by A1 reference (the first tab by default); returns the new revision. */
  async write(
    token: string,
    cells: Record<string, CellValue>,
    o: { sheet?: string } = {},
  ): Promise<number> {
    const state = await this.state(token);
    const tab = o.sheet ? state.tabs.find((t) => t.name === o.sheet) : state.tabs[0];
    if (!tab) throw new Error(`没有这个工作表: ${o.sheet ?? ''}`);
    const ids = Object.fromEntries(state.tabs.map((t) => [t.name, t.id]));
    const actions = Object.entries(cells).flatMap(([ref, v]) => {
      const [row, col] = cellIndex(ref);
      return setCellAction(tab.id, row, col, cellValue(v), ids);
    });
    return this.send(token, state.revision, actions);
  }

  /** Insert empty rows before row `at` (from 1); returns the new revision. */
  insertRows(token: string, at: number, count = 1, o: { sheet?: string } = {}) {
    return this.dimension(token, ACTION.insertRows, { row: at - 1, rows: count }, o);
  }

  /** Delete `count` rows starting at row `at` (from 1). */
  deleteRows(token: string, at: number, count = 1, o: { sheet?: string } = {}) {
    return this.dimension(token, ACTION.deleteRows, { row: at - 1, rows: count }, o);
  }

  /** Insert empty columns before column `at` (letters, e.g. "C"). */
  insertColumns(token: string, at: string, count = 1, o: { sheet?: string } = {}) {
    return this.dimension(
      token,
      ACTION.insertColumns,
      { col: cellIndex(`${at}1`)[1], cols: count },
      o,
    );
  }

  /** Delete `count` columns starting at column `at` (letters). */
  deleteColumns(token: string, at: string, count = 1, o: { sheet?: string } = {}) {
    return this.dimension(
      token,
      ACTION.deleteColumns,
      { col: cellIndex(`${at}1`)[1], cols: count },
      o,
    );
  }

  private async dimension(
    token: string,
    type: number,
    where: Parameters<typeof position>[0],
    o: { sheet?: string },
  ): Promise<number> {
    if ((where.rows ?? where.cols ?? 1) < 1 || (where.row ?? where.col ?? 0) < 0)
      throw new Error('行列位置从 1 / A 开始,数量至少为 1');
    const state = await this.state(token);
    const tab = o.sheet ? state.tabs.find((t) => t.name === o.sheet) : state.tabs[0];
    if (!tab) throw new Error(`没有这个工作表: ${o.sheet ?? ''}`);
    return this.send(token, state.revision, action(type, tab.id, where));
  }

  private async send(token: string, revision: number, actions: number[]): Promise<number> {
    const memberId = Math.floor(Math.random() * 9e13) + 1e13;
    const reply = check(
      await this.web.json('POST', '/space/api/v2/sheet/user_changes', {
        query: { token, member_id: memberId },
        json: {
          base_rev: revision,
          content: gzipSync(Buffer.from(actions)).toString('base64'),
          mode: 0,
          msg_timestamp: Date.now(),
          msg_id: crypto.randomUUID(),
          retryCount: 0,
        },
      }),
      '写入表格',
    );
    const data = (reply.data ?? {}) as Dict;
    if (data.type !== 'ACCEPT_COMMIT')
      throw new Error(`写入表格失败: ${String(data.msg || data.type)}`);
    return Number(data.new_rev ?? revision + 1);
  }

  /**
   * Replaces text in a tab's cells (the first tab by default), skipping formula cells; returns
   * how many cells changed and how many times the text was replaced.
   */
  async replace(
    token: string,
    find: string,
    replacement: string,
    o: { sheet?: string } = {},
  ): Promise<{ cells: number; replaced: number }> {
    if (!find) throw new Error('要替换的文字不能为空');
    const file = await new Docs(this.web).export({ token, type: 'sheet' }, { format: 'xlsx' });
    const sheets = readXlsx(file.data);
    const sheet = o.sheet ? sheets.find((s) => s.name === o.sheet) : sheets[0];
    if (!sheet) throw new Error(`没有这个工作表: ${o.sheet ?? ''}`);
    const cells: Record<string, CellValue> = {};
    let replaced = 0;
    sheet.rows.forEach((row, r) => {
      row.forEach((v, c) => {
        const ref = `${columnName(c)}${r + 1}`;
        if (v === null || sheet.formulas.has(ref)) return;
        const text = String(v);
        const count = text.split(find).length - 1;
        if (!count) return;
        // Written as typed text: numeric results become numbers again, as in the web app.
        cells[ref] = text.split(find).join(replacement);
        replaced += count;
      });
    });
    if (Object.keys(cells).length) await this.write(token, cells, o);
    return { cells: Object.keys(cells).length, replaced };
  }

  /** Format a cell or range ("C3", "A1:C10") of a tab (the first by default). */
  async style(
    token: string,
    range: string,
    style: CellStyle,
    o: { sheet?: string } = {},
  ): Promise<number> {
    const r = area(range);
    const target = { type: 0, row: r.row, col: r.col, rowCount: r.rows, colCount: r.cols };
    const parts = [
      ...styleParts(style).map((s) => ({ style: s, target })),
      ...(style.border === undefined
        ? []
        : borderParts(style.border, style.borderColor ?? DEFAULT_BORDER_COLOR, r)),
    ];
    if (!parts.length) throw new Error('没有要设置的样式');
    const { state, tab } = await this.tab(token, o.sheet);
    return this.send(
      token,
      state.revision,
      parts.flatMap((p) => action(ACTION.style, tab.id, null, p)),
    );
  }

  /** Merge a range ("A3:B4") into one cell, which keeps the top-left cell's value. */
  async merge(token: string, range: string, o: { sheet?: string } = {}): Promise<number> {
    const r = area(range);
    if (r.rows * r.cols < 2) throw new Error(`合并至少要两个单元格: ${range}`);
    const { state, tab } = await this.tab(token, o.sheet);
    const target = { row: r.row, col: r.col, row_count: r.rows, col_count: r.cols };
    return this.send(token, state.revision, [
      ...action(
        ACTION.setCell,
        tab.id,
        { row: r.row, col: r.col },
        { style: null, dataValidation: null },
      ),
      ...action(ACTION.merge, tab.id, r, [{ target }]),
    ]);
  }

  /** Split the merged cells within a range back into single cells. */
  async unmerge(token: string, range: string, o: { sheet?: string } = {}): Promise<number> {
    const r = area(range);
    const { state, tab } = await this.tab(token, o.sheet);
    return this.send(token, state.revision, action(ACTION.merge, tab.id, r, []));
  }

  /** The sheet's state and a tab by name (the first by default). */
  private async tab(token: string, name?: string) {
    const state = await this.state(token);
    const tab = name ? state.tabs.find((t) => t.name === name) : state.tabs[0];
    if (!tab) throw new Error(`没有这个工作表: ${name ?? ''}`);
    return { state, tab };
  }

  /** Add a tab named `name` at position `at` (from 1; last by default); returns its id. */
  async addTab(token: string, name: string, o: { at?: number } = {}): Promise<string> {
    const state = await this.state(token);
    if (state.tabs.some((t) => t.name === name)) throw new Error(`已有同名工作表: ${name}`);
    const index = (o.at ?? state.tabs.length + 1) - 1;
    if (!Number.isInteger(index) || index < 0 || index > state.tabs.length)
      throw new Error(`位置要在 1 到 ${state.tabs.length + 1} 之间`);
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = Array.from(bytes, (b) => TAB_ID_CHARS[b % TAB_ID_CHARS.length]).join('');
    await this.send(
      token,
      state.revision,
      action(ACTION.addTab, id, null, { sheet_id: id, sheet_name: name, index }),
    );
    return id;
  }

  /** Remove a tab by name; a spreadsheet keeps at least one. */
  async removeTab(token: string, name: string): Promise<void> {
    const state = await this.state(token);
    const index = state.tabs.findIndex((t) => t.name === name);
    const tab = state.tabs[index];
    if (!tab) throw new Error(`没有这个工作表: ${name}`);
    if (state.tabs.length === 1) throw new Error('电子表格至少要留一个工作表');
    await this.send(
      token,
      state.revision,
      action(ACTION.removeTab, tab.id, null, { sheet_name: name, index }),
    );
  }

  /** Append rows below the last non-empty row of a tab; returns the first appended row (from 1). */
  async append(token: string, rows: CellValue[][], o: { sheet?: string } = {}): Promise<number> {
    const existing = await this.read(token, o);
    let last = existing.length;
    while (last > 0 && (existing[last - 1] ?? []).every((v) => v === null || v === '')) last--;
    const cells: Record<string, CellValue> = {};
    rows.forEach((row, r) => {
      row.forEach((v, c) => {
        cells[`${columnName(c)}${last + r + 1}`] = v;
      });
    });
    await this.write(token, cells, o);
    return last + 1;
  }

  private async state(token: string): Promise<SheetState> {
    const res = await this.web.request('GET', `/sheets/${token}`, {
      headers: { accept: 'text/html' },
    });
    const html = await res.text();
    const m = /window\.DATA=\{clientVars:(\{.*?\}),ssr:/s.exec(html);
    if (!m) throw new Error('读取表格失败: 页面里没有表格数据');
    const cv = check(JSON.parse(m[1] as string), '读取表格');
    const data = (cv.data ?? {}) as Dict;
    const top = ((data.snapshot ?? {}) as Dict).gzipTopSnapshot;
    return {
      revision: Number(data.revision ?? 0),
      tabs: top ? tabsOf(new Uint8Array(gunzipSync(Buffer.from(String(top), 'base64')))) : [],
    };
  }
}
