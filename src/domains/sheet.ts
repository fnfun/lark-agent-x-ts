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
const ACTION = { setCell: 4, insertRows: 5, deleteRows: 6, insertColumns: 7, deleteColumns: 8 };

/** One action: its type, the tab, where, and for cell sets the cell's JSON. */
function action(
  type: number,
  sheetId: string,
  where: Parameters<typeof position>[0],
  cell?: unknown,
) {
  return lenField(1, [
    ...numField(1, type),
    ...lenField(2, utf8(sheetId)),
    ...position(where),
    ...(cell === undefined ? [] : lenField(5, utf8(JSON.stringify(cell)))),
  ]);
}

/** The protobuf action that sets one cell (a value, or a formula starting with "="). */
export function setCellAction(
  sheetId: string,
  row: number,
  col: number,
  value: CellValue,
): number[] {
  const cell =
    typeof value === 'string' && value.startsWith('=')
      ? {
          style: null,
          formula: value,
          formulaData: compileFormula(value),
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
    const actions = Object.entries(cells).flatMap(([ref, v]) => {
      const [row, col] = cellIndex(ref);
      return setCellAction(tab.id, row, col, cellValue(v));
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
