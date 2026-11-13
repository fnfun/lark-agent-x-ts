/**
 * Base (bitable) tables, fields and records over the Base web app. Request shapes were taken from
 * the web app's own traffic, observed in a headless browser on a Base created for the test, then
 * replayed over HTTP on 2026-11-11 (the test Base was removed afterwards):
 *
 * - Reading: `GET /space/api/bitable/<token>/client_vars/` holds the schema (`gzipSchema`: tables
 *   and their names); `GET /space/api/v1/bitable/<token>/clientvars` (tableID, recordLimit) holds a
 *   table (`table`: fields, views, rank info, the first records); `GET .../records` (tableID,
 *   viewID, offset, limit) pages through the rest. Payloads are gzip + base64 JSON.
 * - Writing goes through the collaborative channel over plain HTTP: `POST /space/api/rce/messages`
 *   (query member_id, any client-chosen number) with `{type: "BITABLE_TABLE", version: 2, data:
 *   {type: "USER_CHANGES", token: <table id>, route_key: <base token>, localRev, operations,
 *   content_type: "gzip/base64"}}` and header `x-command: api.bitable.rce.message`; operations are
 *   gzip + base64 JSON. The reply's `data.type` is ACCEPT_COMMIT with the new table revision. A
 *   stale localRev was accepted for record edits, so the revision from the last read is enough.
 * - Right after a commit the table snapshot lags for about a second: its `meta.rev` is below
 *   `latestCSRev`; reading again shortly after gives the merged state.
 * - Operations seen: SetRecord (`data.setRecord`), AddRecordsV2 (`data.addRecordV2`, with the
 *   record's `tableRank`), DeleteRecordsV2 (`data.deleteRecordV2`), AddOptions
 *   (`data.addOptions`), AddField (`data.addField` + `data.setFieldAttr`).
 * - Cell values by field type: text `[{type: "text", text}]`, number a number, single select an
 *   option id, multi select option ids, date ms, checkbox a boolean, URL
 *   `[{type: "url", text, link}]`. New select options are added in the same commit. A person
 *   cell is `{users: [{userId, name, enName}]}` (2026-11-13, read off what the server stores in a
 *   created-by field; the server keeps the names as sent, so they are looked up first; the array
 *   forms are refused as `type_mismatch`). A link cell is the linked record ids, `[recordId]`;
 *   the server adds `displayValue` (record id → that record's primary text) and keeps it current.
 *   A link field's property names the linked table: `{tableId, multiple: true}`.
 * - A new record goes at the table's `rankInfo.nextRank`; the server moves nextRank on.
 * - An attachment cell holds `[{id, attachmentToken, name, size, mimeType, timeStamp}]`, `id` being
 *   the file token too (the server rejects a cell without it); files are uploaded with mount
 *   point `bitable_file` on the Base token.
 * - Tables are added and removed with a `BITABLE_BASE` message (token: the Base token, no
 *   route_key, localRev: the schema's `base.rev`): AddTableV2 (`base.addTableV2` with the new
 *   table's snapshot: a primary text field and a grid view) and DeleteTable (`base.deleteTable`,
 *   which moves it to the Base's trash). Both name the table's position among `base.tables` and
 *   among the sidebar's `base.blocks` (tables, dashboards, workflows). Removing a field is
 *   DeleteFields (`data.deleteField` with its position in the view); views are added and removed
 *   with AddViewV2 (`data.addViewV2`: type 1 for a grid, its fields, the owner's user id) and
 *   DeleteView (`data.deleteView`). Read off the web app's traffic on 2026-11-11.
 * - Formula (type 20) and lookup (type 19) fields are worked out by the server (2026-11-13, read
 *   off the Base app's code and checked on a test Base on both accounts). Their values are not in
 *   the record cells but in the snapshot's and each page's `formulaInfo`: `fieldMap` (field id →
 *   record id → `{value: JSON of {bus_type: [type per item], data: [items]}}`; 202 a number, 201
 *   text, 1 a text run, 3 / 4 option ids, 5 `{value: ms}`) and `proxyField` (base64 JSON: field id
 *   → the field a result comes from, with its select options). A formula field's property is
 *   `{formula, formatter, currencyCode}`, fields referred to as `bitable::$table[t].$field[f]`. A
 *   lookup searches a table: `{formula, formatter, rollup, targetField, filterInfo: {targetTable,
 *   conditions: {conjunction, conditions: [], children}}}`, each child matching a field of that
 *   table with a field of this record (`matchValue: {valueType: 0, value: <field id>}`); its
 *   formula is `bitable::$table[t].FILTER(CurrentValue.$column[f]=bitable::$table[this].$field[g]
 *   && ...).$column[target].LISTCOMBINE()` followed by the rollup's functions (`.SUM()` ...).
 * - Filtering and searching on the server (`POST /space/api/v1/bitable/<token>/ondemand/records`
 *   with a `localViewConfig`, `.../search-records`) only serve tables the server loads on demand
 *   (`loadingType` "rank_page"); others are refused as "table is not ondemand table". The test
 *   tenants cap a table at 2,000 and 20,000 rows, which still load in full ("rank_full"), so
 *   records() filters locally, as the web app does for such tables.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import type { WebSession } from '../web.js';
import { mimeOf } from './doc-edit.js';
import { check, Docs } from './docs.js';

type Dict = Record<string, unknown>;

/** Field types this module reads and writes as plain values, by the server's number. */
export const FIELD_TYPES = {
  text: 1,
  number: 2,
  select: 3,
  multiselect: 4,
  date: 5,
  checkbox: 7,
  person: 11,
  url: 15,
  link: 18,
} as const;
/** Attachment fields: read as file names, written with Base.attach. */
const ATTACHMENT = 17;
/** Computed fields: their values come from the server, not from cells. */
const LOOKUP = 19;
const FORMULA = 20;
/** Field types addField creates: the plain ones, attachments and computed fields. */
export const NEW_FIELD_TYPES = {
  ...FIELD_TYPES,
  attachment: ATTACHMENT,
  lookup: LOOKUP,
  formula: FORMULA,
} as const;
export type FieldType = keyof typeof NEW_FIELD_TYPES;
const TYPE_NAMES = Object.fromEntries(
  Object.entries(NEW_FIELD_TYPES).map(([k, v]) => [v, k]),
) as Record<number, string>;

/** Properties a new field of each type starts with, as the web app sends them. */
const FIELD_PROPERTY: Record<FieldType, Dict | undefined> = {
  text: undefined,
  number: { formatter: '0' },
  select: { options: [], optionsType: 0 },
  multiselect: { options: [], optionsType: 0 },
  date: { timeFormat: '', displayTimeZone: false, autoFill: false, dateFormat: 'yyyy/MM/dd' },
  checkbox: { styleId: '0' },
  person: { multiple: true },
  url: { extractExternalUrl: false },
  // The linked table is filled in by addField
  link: { multiple: true },
  attachment: undefined,
  // Built by addField from the formula or the lookup asked for
  lookup: undefined,
  formula: undefined,
};
const UI_TYPES: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  select: 'SingleSelect',
  multiselect: 'MultiSelect',
  date: 'DateTime',
  checkbox: 'Checkbox',
  person: 'User',
  url: 'Url',
  link: 'SingleLink',
  attachment: 'Attachment',
  lookup: 'Lookup',
  formula: 'Formula',
};

/** How a lookup combines the values it finds, by the server's number. */
export const ROLLUPS = {
  values: 0,
  sum: 1,
  count: 2,
  average: 3,
  max: 4,
  min: 5,
  unique: 6,
  'unique-count': 7,
} as const;
export type Rollup = keyof typeof ROLLUPS;
/** Functions a rollup appends to a lookup's formula. */
const ROLLUP_FUNCTIONS: Record<Rollup, string[]> = {
  values: [],
  sum: ['SUM'],
  count: ['COUNTA'],
  average: ['AVERAGE'],
  max: ['MAX'],
  min: ['MIN'],
  unique: ['UNIQUE'],
  'unique-count': ['UNIQUE', 'COUNTA'],
};

/** A lookup field: values of a field in the records of a table that match the current record. */
export interface LookupSpec {
  /** The table searched (id or name; may be this table). */
  table: string;
  /** Its field whose values are taken (id or name). */
  field: string;
  /** Conditions, all to be met: a field of that table equals (or, with `not`, differs from) a field of this record. */
  match: { field: string; equals: string; not?: boolean }[];
  /** How the values are combined (all of them by default). */
  rollup?: Rollup;
}

export interface BaseTable {
  id: string;
  name: string;
}

export interface SelectOption {
  id: string;
  name: string;
}

export interface BaseField {
  id: string;
  name: string;
  /** The server's type number. */
  type: number;
  /** The type's name for the types this module writes; otherwise "type <n>". */
  typeName: string;
  primary: boolean;
  options: SelectOption[];
}

export interface BaseView {
  id: string;
  name: string;
  /** The server's view type (1 is the grid). */
  type: number;
}

export interface BaseRecord {
  id: string;
  /** Cell values by field name, readable (option names, dates as text, links as URLs). */
  fields: Record<string, string | number | boolean | null>;
}

/** A value given for a cell: text is parsed by the field's type; null or "" clears it. */
export type CellInput = string | number | boolean | string[] | null;

interface TableState {
  baseToken: string;
  id: string;
  viewId: string;
  rev: number;
  fields: BaseField[];
  nextRank: string;
  recordCount: number;
  firstIds: string[];
  records: Record<string, Dict>;
  views: BaseView[];
  computed: Computed;
}

/** Values of formula and lookup fields, from a snapshot's or a page's formulaInfo. */
interface Computed {
  /** Field id → record id → the value as the server encodes it (`{bus_type, data}`). */
  values: Record<string, Record<string, Dict>>;
  /** Field id → options of the select field its results come from. */
  options: Record<string, SelectOption[]>;
}

function computedOf(info: unknown): Computed {
  const i = (info ?? {}) as Dict;
  const values: Computed['values'] = {};
  for (const [fieldId, cells] of Object.entries((i.fieldMap ?? {}) as Record<string, Dict>)) {
    const parsed: Record<string, Dict> = {};
    for (const [recordId, cell] of Object.entries(cells as Record<string, Dict>)) {
      if (typeof cell?.value === 'string') parsed[recordId] = JSON.parse(cell.value) as Dict;
    }
    values[fieldId] = parsed;
  }
  const proxy = (
    typeof i.proxyField === 'string'
      ? JSON.parse(Buffer.from(i.proxyField, 'base64').toString())
      : (i.proxyField ?? {})
  ) as Record<string, Dict>;
  const options = Object.fromEntries(
    Object.entries(proxy).map(([fieldId, f]) => [
      fieldId,
      (((f.property as Dict | undefined)?.options ?? []) as Dict[]).map((o) => ({
        id: String(o.id ?? ''),
        name: String(o.name ?? ''),
      })),
    ]),
  );
  return { values, options };
}

/** Adds a page's computed values to those read so far. */
function mergeComputed(into: Computed, more: Computed): void {
  for (const [fieldId, cells] of Object.entries(more.values))
    into.values[fieldId] = { ...into.values[fieldId], ...cells };
  Object.assign(into.options, more.options);
}

/** Result types that are dates (`{value: ms}`): date, created and modified time. */
const DATE_RESULTS = new Set([5, 205, 1001, 1002]);

/**
 * A formula or lookup value (`{bus_type, data}`) → a readable value: a lone number or boolean as
 * is; otherwise the items as text, option ids as names, dates as local dates, joined like cells
 * (text runs directly, other items with ", ").
 */
export function readComputed(
  value: Dict | undefined,
  options: SelectOption[] = [],
): string | number | boolean | null {
  const types = (value?.bus_type ?? []) as number[];
  const items = ((value?.data ?? []) as unknown[])
    .map((d, i) => ({ type: types[i] ?? types[0] ?? 0, d }))
    .filter((x) => x.d !== null && x.d !== undefined);
  const only = items.length === 1 ? items[0]?.d : undefined;
  if (typeof only === 'number' || typeof only === 'boolean') return only;
  if (!items.length) return null;
  const textRuns = items.every((x) => typeof x.d === 'object' && (x.d as Dict).type === 'text');
  return items
    .map(({ type, d }) => {
      if (type === FIELD_TYPES.select || type === FIELD_TYPES.multiselect)
        return options.find((o) => o.id === d)?.name ?? String(d);
      if (DATE_RESULTS.has(type))
        return showDate(Number(typeof d === 'object' ? (d as Dict).value : d));
      return typeof d === 'object' ? segmentsText([d]) : String(d);
    })
    .join(textRuns ? '' : ', ');
}

/**
 * A formula as typed, fields of the table written as [name], → the server's form, where a field
 * is `bitable::$table[<table>].$field[<field>]`. Text in double quotes and references already in
 * the server's form (a `[` right after a name, as in `$field[...]`) are kept as they are.
 */
export function formulaExpression(text: string, tableId: string, fields: BaseField[]): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const next = end < 0 ? text.length : end + 1;
      out += text.slice(i, next);
      i = next;
      continue;
    }
    const end = text.indexOf(']', i);
    if (c === '[' && end > i && !/[\w$\]]/.test(text[i - 1] ?? '')) {
      const name = text.slice(i + 1, end);
      const f = fields.find((x) => x.name === name) ?? fields.find((x) => x.id === name);
      if (!f) throw new Error(`公式里没有这个字段: ${name}`);
      out += `bitable::$table[${tableId}].$field[${f.id}]`;
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** View types this module creates, by the server's number. */
export const VIEW_TYPES = {
  grid: 1,
  kanban: 2,
  form: 3,
  gallery: 4,
  gantt: 5,
  calendar: 7,
} as const;
export type ViewType = keyof typeof VIEW_TYPES;

/** View filter operators, as the web app names them. */
export const FILTER_OPERATORS = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
  'isGreater',
  'isLess',
];

export interface FilterCondition {
  /** Field id or name. */
  field: string;
  /** One of FILTER_OPERATORS. */
  operator: string;
  /** The values compared with (none for isEmpty / isNotEmpty). */
  value?: string[];
}

/** A field of the table by id or name. */
function fieldOf(t: TableState, field: string): BaseField {
  const f = t.fields.find((x) => x.id === field || x.name === field);
  if (!f) throw new Error(`没有这个字段: ${field}`);
  return f;
}

/** An operation on the table state's view (`extra` joins the action, e.g. a viewType). */
const viewOp = (
  t: TableState,
  command: string,
  action: string,
  data: Dict,
  extra: Dict = {},
): Dict => ({
  command,
  type: 2,
  syncFlag: 1,
  actions: [{ action, type: 2, tableId: t.id, viewId: t.viewId, ...extra, data }],
});

/** Record ids of a (possibly grouped) view, groups in order. */
const groupIds = (groups: unknown) =>
  ((groups ?? []) as Dict[]).flatMap((g) => (g.recordIDList ?? []) as string[]);

/** How long reads wait for a lagging snapshot: up to RETRIES × WAIT_MS. */
const SNAPSHOT_RETRIES = 12;
const SNAPSHOT_WAIT_MS = 500;

const unzip = (s: unknown) => JSON.parse(gunzipSync(Buffer.from(String(s), 'base64')).toString());
const zip = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v))).toString('base64');

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A new field or option id the way the web app makes them: a prefix and random letters and digits. */
export function newId(prefix: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return prefix + Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

const RECORD_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/**
 * A new record id: "reczz" + 11 base-62 digits of (ms × 10^6 + a random part); the server rejects
 * other shapes ("invalid RecordID format").
 */
export function newRecordId(now = Date.now(), random = Math.floor(Math.random() * 1e6)): string {
  let n = BigInt(now) * 1_000_000n + BigInt(random);
  let digits = '';
  while (n > 0n) {
    digits = RECORD_DIGITS[Number(n % 62n)] + digits;
    n /= 62n;
  }
  return `reczz${digits.padStart(11, '0').slice(-11)}`;
}

/** "2026-11-20", "2026/11/20 18:30" (local time), or a timestamp (s or ms) → ms. */
export function parseDate(text: string): number {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t) < 1e11 ? Number(t) * 1000 : Number(t);
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`看不懂的日期: ${text}(用 2026-11-20 或 2026-11-20 18:30)`);
  const [y, mo, d, h, mi] = m.slice(1).map((x) => Number(x ?? 0)) as number[];
  return new Date(y as number, (mo as number) - 1, d, h, mi).getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');
function showDate(ms: number): string {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() || d.getMinutes()
    ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : day;
}

/** A list given as an array or a comma-separated string, trimmed, empty items dropped. */
const listInput = (input: CellInput): string[] =>
  (Array.isArray(input) ? input : String(input ?? '').split(/[,，]/))
    .map((x) => x.trim())
    .filter(Boolean);

/** A segment list (text runs, URLs, people ...) → its visible text; text runs join directly. */
function segmentsText(v: unknown[]): string {
  const textRuns = v.every(
    (s) => typeof s === 'object' && s !== null && (s as Dict).type === 'text',
  );
  return v
    .map((s) => {
      if (typeof s !== 'object' || s === null) return String(s);
      const o = s as Dict;
      return String(o.link ?? o.text ?? o.name ?? o.enName ?? JSON.stringify(o));
    })
    .join(textRuns ? '' : ', ');
}

/** A stored cell → a readable value. */
/** A stored cell → a readable value; display is the cell's displayValue (link cells have one). */
export function readCell(
  field: BaseField,
  value: unknown,
  display?: Dict,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (field.type === FIELD_TYPES.link && Array.isArray(value))
    return value.map((id) => String(display?.[String(id)] || id)).join(', ');
  const option = (id: unknown) => field.options.find((o) => o.id === id)?.name ?? String(id);
  switch (field.type) {
    case FIELD_TYPES.number:
    case FIELD_TYPES.checkbox:
      return value as number | boolean;
    case FIELD_TYPES.select:
      return option(value);
    case FIELD_TYPES.multiselect:
      return (value as unknown[]).map(option).join(', ');
    case FIELD_TYPES.date:
      return showDate(Number(value));
    default:
      if (Array.isArray(value)) return segmentsText(value);
      // People, created-by and modified-by cells
      if (Array.isArray((value as Dict).users))
        return ((value as Dict).users as Dict[])
          .map((u) => String(u.name || u.enName || u.userId || ''))
          .join(', ');
      return typeof value === 'object'
        ? JSON.stringify(value)
        : (value as string | number | boolean);
  }
}

const toField = (id: string, f: Dict, primary: string): BaseField => {
  const type = Number(f.type);
  const options = (((f.property as Dict | undefined)?.options ?? []) as Dict[]).map((o) => ({
    id: String(o.id ?? ''),
    name: String(o.name ?? ''),
  }));
  return {
    id,
    name: String(f.name ?? ''),
    type,
    typeName: TYPE_NAMES[type] ?? `type ${type}`,
    primary: id === primary,
    options,
  };
};

export class Base {
  /**
   * userNames looks up people's display names for person cells (the server stores the names it is
   * sent); without it, person cells are written with ids only.
   */
  constructor(
    readonly web: WebSession,
    readonly o: { userNames?: (userIds: string[]) => Promise<Map<string, string>> } = {},
  ) {}

  /** The tables of a Base, in their order. */
  async tables(baseToken: string): Promise<BaseTable[]> {
    const schema = await this.schema(baseToken);
    const infos = (schema.tableInfos ?? {}) as Record<string, Dict>;
    return ((schema.tables ?? []) as string[]).map((id) => ({
      id,
      name: String(infos[id]?.name ?? ''),
    }));
  }

  /**
   * Add a table at the end, with a primary text field (`primary`, "名称" by default) and a grid
   * view; returns its id.
   */
  async addTable(baseToken: string, name: string, o: { primary?: string } = {}): Promise<string> {
    const schema = await this.schema(baseToken);
    const tableId = newId('tbl', 13);
    const fieldId = newId('fld', 7);
    const viewId = newId('vew', 7);
    const blocks = (schema.blocks ?? []) as string[];
    const view = {
      id: viewId,
      name: '表格',
      publicLevel: 0,
      type: 1,
      isPrivate: false,
      property: {
        rowHeightLevel: 1,
        records: [],
        fields: [fieldId],
        colInfos: {},
        filterInfo: null,
        sortInfo: [],
        frozenColCount: 1,
        group: [],
        autoSort: false,
        cardViewSetting: null,
        colorInfo: null,
      },
      index: 0,
    };
    const field = {
      id: fieldId,
      name: o.primary ?? '名称',
      type: FIELD_TYPES.text,
      property: null,
      fieldUIType: UI_TYPES.text,
      allowedEditModes: { manual: true, scan: false },
    };
    await this.send('BITABLE_BASE', baseToken, undefined, Number(schema.rev ?? 0), [
      {
        command: 'AddTableV2',
        type: 1,
        actions: [
          {
            action: 'base.addTableV2',
            type: 1,
            tableId,
            isRecover: false,
            contentCreation: false,
            sourceTableId: null,
            renewRecord: true,
            data: {
              index: ((schema.tables ?? []) as string[]).length,
              blockIndex: blocks.length,
              name,
              exInfo: { contentCreation: false },
              parentId: null,
              snapshot: {
                recordMap: {},
                fieldMap: { [fieldId]: field },
                primaryKey: fieldId,
                viewMap: { [viewId]: view },
                recordMeta: {},
                commentMap: {},
                resourceMap: {},
                milestoneMap: {},
                recordsNum: 0,
                rankInfo: {
                  rankStep: 1048576,
                  nextRank: 'i00000000',
                  rankMap: {},
                  viewRankMap: { [viewId]: { rankMap: {} } },
                },
              },
              total: blocks.length,
            },
          },
        ],
        authInfo: { src_prod_type: 'BITABLE_TABLE_IND' },
      },
    ]);
    return tableId;
  }

  /** Remove a table (to the Base's trash); a Base keeps at least one table. */
  async deleteTable(baseToken: string, tableId: string): Promise<void> {
    const schema = await this.schema(baseToken);
    const tables = (schema.tables ?? []) as string[];
    const index = tables.indexOf(tableId);
    if (index < 0) throw new Error(`找不到数据表 ${tableId}`);
    if (tables.length === 1) throw new Error('多维表格至少要留一张数据表');
    const blocks = (schema.blocks ?? []) as string[];
    const infos = (schema.tableInfos ?? {}) as Record<string, Dict>;
    await this.send('BITABLE_BASE', baseToken, undefined, Number(schema.rev ?? 0), [
      {
        command: 'DeleteTable',
        type: 1,
        actions: [
          {
            action: 'base.deleteTable',
            type: 1,
            tableId,
            name: String(infos[tableId]?.name ?? ''),
            data: {
              index,
              blockIndex: blocks.indexOf(tableId),
              parentId: null,
              total: blocks.length,
            },
          },
        ],
      },
    ]);
  }

  /** A table's fields (the first table when tableId is omitted). */
  async fields(baseToken: string, tableId?: string): Promise<BaseField[]> {
    return (await this.load(baseToken, tableId, 1)).fields;
  }

  /** A table's views, in order. */
  async views(baseToken: string, tableId?: string): Promise<BaseView[]> {
    return (await this.load(baseToken, tableId, 1)).views;
  }

  /**
   * A table's records in a view's order (the table's current view by default), up to limit.
   * `where` keeps records whose readable value equals the given text (for multi select: has that
   * option), `search` those with the text in any field; both filter locally, over the whole
   * table, before the limit applies.
   */
  async records(
    baseToken: string,
    o: {
      table?: string;
      view?: string;
      limit?: number;
      where?: Record<string, string>;
      search?: string;
    } = {},
  ): Promise<BaseRecord[]> {
    const limit = o.limit ?? 500;
    const where = Object.entries(o.where ?? {});
    const filtering = where.length > 0 || Boolean(o.search);
    const t = await this.load(baseToken, o.table, Math.min(limit, 200), o.view);
    const wanted = filtering ? t.recordCount : Math.min(limit, t.recordCount);
    const ids = [...t.firstIds];
    const cells = { ...t.records };
    const computed = t.computed;
    while (ids.length < wanted) {
      const page = check(
        await this.web.json('GET', `/space/api/v1/bitable/${baseToken}/records`, {
          query: {
            tableID: t.id,
            viewID: t.viewId,
            offset: ids.length,
            limit: Math.min(200, wanted - ids.length),
          },
        }),
        '读取记录',
      );
      const data = unzip((page.data as Dict).records) as Dict;
      const more = groupIds(data.groupList);
      if (!more.length) break;
      ids.push(...more);
      Object.assign(cells, (data.recordMap ?? {}) as Record<string, Dict>);
      mergeComputed(computed, computedOf(data.formulaInfo));
    }
    // Field names can repeat; later ones are keyed "name (field id)".
    const seen = new Set<string>();
    const keys = t.fields.map((f) => {
      const key = seen.has(f.name) ? `${f.name} (${f.id})` : f.name;
      seen.add(f.name);
      return key;
    });
    const records = ids.slice(0, filtering ? ids.length : limit).map((id) => ({
      id,
      fields: Object.fromEntries(
        t.fields.map((f, i) => [
          keys[i] as string,
          f.type === FORMULA || f.type === LOOKUP
            ? readComputed(computed.values[f.id]?.[id], computed.options[f.id])
            : readCell(
                f,
                (cells[id]?.[f.id] as Dict | undefined)?.value,
                (cells[id]?.[f.id] as Dict | undefined)?.displayValue as Dict | undefined,
              ),
        ]),
      ),
    }));
    for (const [name] of where) if (!keys.includes(name)) throw new Error(`没有这个字段: ${name}`);
    const search = o.search?.toLowerCase();
    return records
      .filter(
        (r) =>
          where.every(([name, want]) => {
            const v = r.fields[name];
            const field = t.fields[keys.indexOf(name)];
            return field?.type === FIELD_TYPES.multiselect
              ? String(v ?? '')
                  .split(', ')
                  .includes(want)
              : String(v ?? '') === want;
          }) &&
          (!search ||
            Object.values(r.fields).some((v) =>
              String(v ?? '')
                .toLowerCase()
                .includes(search),
            )),
      )
      .slice(0, limit);
  }

  /** Add a record with these cell values (by field name or id); returns its id. */
  async addRecord(
    baseToken: string,
    values: Record<string, CellInput>,
    o: { table?: string } = {},
  ) {
    const t = await this.load(baseToken, o.table, 1);
    const recordId = newRecordId();
    const add = {
      command: 'AddRecordsV2',
      type: 2,
      syncFlag: 0,
      actions: [
        {
          action: 'data.addRecordV2',
          type: 2,
          tableId: t.id,
          viewId: t.viewId,
          recordId,
          data: { tableRank: t.nextRank },
        },
      ],
    };
    await this.commit(t, [add, ...this.setOps(t, recordId, values, await this.names(t, values))]);
    return recordId;
  }

  /** Change cells of a record (by field name or id). */
  async setRecord(
    baseToken: string,
    recordId: string,
    values: Record<string, CellInput>,
    o: { table?: string } = {},
  ): Promise<void> {
    const t = await this.load(baseToken, o.table, 1);
    await this.commit(t, this.setOps(t, recordId, values, await this.names(t, values)));
  }

  /** Display names of the people the values put into person fields (empty without a resolver). */
  private async names(t: TableState, values: Record<string, CellInput>) {
    const ids = Object.entries(values).flatMap(([key, input]) => {
      const f = t.fields.find((x) => x.id === key) ?? t.fields.find((x) => x.name === key);
      return f?.type === FIELD_TYPES.person ? listInput(input) : [];
    });
    if (!ids.length || !this.o.userNames) return new Map<string, string>();
    return this.o.userNames([...new Set(ids)]);
  }

  /**
   * Upload files into an attachment field of a record, after the attachments it already has
   * (the field by id or name); returns the files' tokens.
   */
  async attach(
    baseToken: string,
    recordId: string,
    field: string,
    files: { data: Uint8Array; name: string; mimeType?: string }[],
    o: { table?: string } = {},
  ): Promise<string[]> {
    const t = await this.load(baseToken, o.table, 200);
    const f = t.fields.find((x) => x.id === field || x.name === field);
    if (!f) throw new Error(`没有这个字段: ${field}`);
    if (f.type !== ATTACHMENT) throw new Error(`不是附件字段: ${f.name}`);
    const record = await this.rawRecord(t, recordId);
    const existing = ((record[f.id] as Dict | undefined)?.value ?? []) as Dict[];
    const docs = new Docs(this.web);
    const added: Dict[] = [];
    for (const file of files) {
      const { objToken } = await docs.upload(file.data, file.name, {
        mount: { point: 'bitable_file', node: baseToken },
      });
      // The server checks `id`; the web app's cells carry the file token there too.
      added.push({
        id: objToken,
        attachmentToken: objToken,
        name: file.name,
        size: file.data.length,
        mimeType: file.mimeType ?? mimeOf(file.name),
        timeStamp: Date.now(),
      });
    }
    await this.commit(t, [
      {
        command: 'SetRecord',
        type: 2,
        syncFlag: 0,
        actions: [
          {
            action: 'data.setRecord',
            type: 2,
            tableId: t.id,
            viewId: t.viewId,
            recordId,
            viewType: 1,
            data: { [f.id]: { type: ATTACHMENT, value: [...existing, ...added] } },
          },
        ],
      },
    ]);
    return added.map((a) => String(a.id));
  }

  /** A record's stored cells, from the first records loaded or the pages after them. */
  private async rawRecord(t: TableState, recordId: string): Promise<Dict> {
    if (t.records[recordId]) return t.records[recordId] as Dict;
    for (let offset = t.firstIds.length; offset < t.recordCount; offset += 200) {
      const page = check(
        await this.web.json('GET', `/space/api/v1/bitable/${t.baseToken}/records`, {
          query: { tableID: t.id, viewID: t.viewId, offset, limit: 200 },
        }),
        '读取记录',
      );
      const data = unzip((page.data as Dict).records) as Dict;
      const found = ((data.recordMap ?? {}) as Record<string, Dict>)[recordId];
      if (found) return found;
      if (!groupIds(data.groupList).length) break;
    }
    throw new Error(`找不到记录 ${recordId}`);
  }

  /** Delete records. */
  async deleteRecords(baseToken: string, recordIds: string[], o: { table?: string } = {}) {
    const t = await this.load(baseToken, o.table, 1);
    await this.commit(t, [
      {
        command: 'DeleteRecordsV2',
        type: 2,
        syncFlag: 0,
        actions: recordIds.map((recordId) => ({
          action: 'data.deleteRecordV2',
          type: 2,
          tableId: t.id,
          viewId: t.viewId,
          recordId,
        })),
      },
    ]);
  }

  /**
   * Add a field at the end of the table; returns its id. A link field links to linkTable (this
   * table when omitted); a formula field needs `formula` (fields as [name]), a lookup `lookup`.
   */
  async addField(
    baseToken: string,
    name: string,
    type: FieldType,
    o: { table?: string; linkTable?: string; formula?: string; lookup?: LookupSpec } = {},
  ) {
    const t = await this.load(baseToken, o.table, 1);
    let property: Dict | undefined = FIELD_PROPERTY[type];
    if (type === 'link') property = { ...FIELD_PROPERTY.link, tableId: o.linkTable ?? t.id };
    if (type === 'formula') {
      if (!o.formula?.trim()) throw new Error('公式字段要给出公式');
      property = {
        formula: formulaExpression(o.formula, t.id, t.fields),
        formatter: '',
        currencyCode: '',
      };
    }
    if (type === 'lookup') {
      if (!o.lookup) throw new Error('查找引用字段要给出查找的数据表、取值字段和匹配条件');
      property = await this.lookupProperty(baseToken, t, o.lookup);
    }
    const fieldId = newId('fld', 7);
    const uiType = UI_TYPES[type];
    const enumerable = type === 'select' || type === 'multiselect' || type === 'checkbox';
    const exInfo = {
      disableCredential: true,
      colOrCustomRowType: 'custom',
      customRows: 5,
      fieldUIType: uiType,
    };
    const common = { type: 2, tableId: t.id, viewId: t.viewId, fieldId };
    await this.commit(t, [
      {
        command: 'AddField',
        type: 2,
        syncFlag: 0,
        actions: [
          {
            action: 'data.addField',
            ...common,
            data: {
              name,
              type: NEW_FIELD_TYPES[type],
              fieldUIType: uiType,
              enumerable,
              exInfo,
              indexes: { [t.viewId]: t.fields.length },
              total: t.fields.length,
            },
          },
          {
            action: 'data.setFieldAttr',
            ...common,
            data: {
              id: fieldId,
              name,
              type: NEW_FIELD_TYPES[type],
              defaultValueRule: null,
              fieldUIType: uiType,
              enumerable,
              ...(property ? { property } : {}),
              exInfo,
            },
          },
        ],
      },
    ]);
    return fieldId;
  }

  /** A lookup field's property: its search conditions and the formula the server evaluates. */
  private async lookupProperty(baseToken: string, t: TableState, spec: LookupSpec): Promise<Dict> {
    if (!spec.match.length) throw new Error('查找引用至少要一个匹配条件');
    const tables = await this.tables(baseToken);
    const target =
      tables.find((x) => x.id === spec.table) ?? tables.find((x) => x.name === spec.table);
    if (!target) throw new Error(`没有这个数据表: ${spec.table}`);
    const other = target.id === t.id ? t : await this.load(baseToken, target.id, 1);
    const take = fieldOf(other, spec.field);
    const children = spec.match.map((m) => ({
      fieldType: fieldOf(other, m.field).type,
      matchValue: { valueType: 0, value: fieldOf(t, m.equals).id },
      operator: m.not ? 'isNot' : 'is',
      conditionId: newId('con', 7),
      fieldId: fieldOf(other, m.field).id,
    }));
    const filter = children
      .map(
        (c) =>
          `CurrentValue.$column[${c.fieldId}]${c.operator === 'is' ? '=' : '!='}bitable::$table[${t.id}].$field[${c.matchValue.value}]`,
      )
      .join('&&');
    const rollup = spec.rollup ?? 'values';
    if (!(rollup in ROLLUPS)) throw new Error(`不认识的汇总方式: ${rollup}`);
    return {
      formula: [
        `bitable::$table[${other.id}].FILTER(${filter}).$column[${take.id}].LISTCOMBINE()`,
        ...ROLLUP_FUNCTIONS[rollup].map((f) => `${f}()`),
      ].join('.'),
      formatter: '',
      rollup: ROLLUPS[rollup],
      targetField: take.id,
      filterInfo: {
        targetTable: other.id,
        conditions: { conjunction: 'and', conditions: [], children },
      },
    };
  }

  /**
   * Add a view at the end, showing all fields: a grid (default), a kanban grouped by a single
   * select field (`group`, the first one by default), a form asking for every field, a gallery
   * (cover: the first attachment field), or a calendar / gantt over date fields (`start` / `end`,
   * the first date field by default); returns its id.
   */
  async addView(
    baseToken: string,
    name: string,
    o: { table?: string; type?: ViewType; group?: string; start?: string; end?: string } = {},
  ): Promise<string> {
    const t = await this.load(baseToken, o.table, 1);
    const type = o.type ?? 'grid';
    const viewId = newId('vew', 7);
    const fields = t.fields.map((f) => f.id);
    const visible = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { hidden: false }]));
    const firstOf = (kind: number, given: string | undefined, what: string) => {
      const f = given === undefined ? t.fields.find((x) => x.type === kind) : fieldOf(t, given);
      if (!f) throw new Error(`${what}需要一个${kind === FIELD_TYPES.date ? '日期' : '单选'}字段`);
      if (f.type !== kind)
        throw new Error(`${f.name} 不是${kind === FIELD_TYPES.date ? '日期' : '单选'}字段`);
      return f.id;
    };
    const timing = () => {
      const start = firstOf(FIELD_TYPES.date, o.start, '日历和甘特视图');
      const end = o.end === undefined ? start : firstOf(FIELD_TYPES.date, o.end, '日历和甘特视图');
      return {
        timeBarColor: { type: 1, specificColor: 0 },
        timeBarValue: { type: 1, timingValue: { startDateFieldId: start, endDateFieldId: end } },
      };
    };
    const common = { filterInfo: null, sortInfo: [], autoSort: false, fields };
    let property: Dict;
    switch (type) {
      case 'kanban': {
        const group = firstOf(FIELD_TYPES.select, o.group, '看板视图');
        property = {
          ...common,
          group: [{ fieldId: group, desc: false }],
          colInfos: {},
          groupOrder: [],
          cardConfig: {
            coverFieldId: null,
            coverFitType: 'crop',
            showCover: false,
            showMode: 'normal',
            showFieldName: false,
          },
          sectionInfos: { [group]: { hidden: true } },
        };
        break;
      }
      case 'gallery': {
        const cover = t.fields.find((f) => f.type === ATTACHMENT)?.id ?? null;
        property = {
          ...common,
          galleryConfig: {
            showFieldName: false,
            coverFitType: 'crop',
            coverPosition: 2,
            layoutColumn: 0,
            showCover: cover !== null,
            coverFieldId: cover,
          },
          sectionInfos: visible(fields),
        };
        break;
      }
      case 'calendar': {
        const bar = timing();
        const { startDateFieldId, endDateFieldId } = bar.timeBarValue.timingValue;
        const primary = t.fields.find((f) => f.primary)?.id ?? '';
        property = {
          ...common,
          calendarConfig: {
            timeScale: 3,
            timeAxisSize: 1,
            defaultDuration: 2,
            fieldStyleMap: {},
            ...bar,
          },
          sectionInfos: visible([...new Set([primary, startDateFieldId, endDateFieldId])]),
        };
        break;
      }
      case 'form':
        // A form asks for every field; submissions become records.
        property = {
          fields,
          fieldInfos: Object.fromEntries(
            fields.map((id) => [id, { visible: true, description: {} }]),
          ),
          formBanner: '',
          filterInfo: null,
          sortInfo: null,
          formBannerInfo: null,
          primaryKey: t.fields.find((f) => f.primary)?.id ?? '',
        };
        break;
      case 'gantt': {
        const primary = t.fields.find((f) => f.primary)?.id ?? '';
        property = {
          ...common,
          rowHeightLevel: 1,
          colInfos: { [primary]: { hidden: false } },
          frozenColCount: 1,
          group: [],
          ganttConfig: { ...timing(), officialHoliday: false, titleField: primary },
        };
        break;
      }
      default:
        property = {
          ...common,
          rowHeightLevel: 1,
          colInfos: {},
          frozenColCount: 1,
          group: [],
          cardViewSetting: null,
          colorInfo: null,
        };
    }
    const me = check(await this.web.json('GET', '/space/api/user/'), '读取用户信息');
    await this.commit(t, [
      {
        command: 'AddViewV2',
        type: 2,
        syncFlag: 0,
        actions: [
          {
            action: 'data.addViewV2',
            type: 2,
            tableId: t.id,
            viewId,
            data: {
              type: VIEW_TYPES[type],
              index: t.views.length,
              name,
              isPrivate: false,
              property,
              owner: String((me.data as Dict | undefined)?.suid ?? ''),
              bizType: 0,
              total: t.views.length,
            },
          },
        ],
      },
    ]);
    return viewId;
  }

  /** Sort a view (by id or name; the table's current view by default) by fields, in order. */
  async setSort(
    baseToken: string,
    by: { field: string; desc?: boolean }[],
    o: { table?: string; view?: string } = {},
  ): Promise<void> {
    const t = await this.viewState(baseToken, o);
    await this.commit(t, [
      viewOp(t, 'SortRecordV2', 'view.sortRecordsV2', {
        sortInfo: by.map((s) => ({ fieldId: fieldOf(t, s.field).id, desc: s.desc === true })),
        autoSort: by.length > 0,
      }),
    ]);
  }

  /** Group a view's records by fields, in order (none ungroups). */
  async setGroup(
    baseToken: string,
    by: { field: string; desc?: boolean }[],
    o: { table?: string; view?: string } = {},
  ): Promise<void> {
    const t = await this.viewState(baseToken, o);
    await this.commit(t, [
      viewOp(
        t,
        'SetGroup',
        'view.setGroup',
        { group: by.map((s) => ({ fieldId: fieldOf(t, s.field).id, desc: s.desc === true })) },
        { viewType: 1 },
      ),
    ]);
  }

  /**
   * Filter a view (none clears it): records must meet all conditions, or any with `or`. Values are
   * readable text: option names for select fields, which become their ids.
   */
  async setFilter(
    baseToken: string,
    conditions: FilterCondition[],
    o: { table?: string; view?: string; or?: boolean } = {},
  ): Promise<void> {
    const t = await this.viewState(baseToken, o);
    await this.commit(t, [
      viewOp(t, 'SetFilter', 'view.setFilter', {
        conjunction: o.or ? 'or' : 'and',
        conditions: conditions.map((c) => {
          const f = fieldOf(t, c.field);
          if (!FILTER_OPERATORS.includes(c.operator))
            throw new Error(`不认识的筛选条件: ${c.operator}`);
          const empty = c.operator === 'isEmpty' || c.operator === 'isNotEmpty';
          const value = empty
            ? []
            : (c.value ?? []).map((v) => {
                if (f.type !== FIELD_TYPES.select && f.type !== FIELD_TYPES.multiselect) return v;
                const option = f.options.find((x) => x.name === v || x.id === v);
                if (!option) throw new Error(`${f.name} 没有这个选项: ${v}`);
                return option.id;
              });
          return {
            fieldId: f.id,
            fieldType: f.type,
            operator: c.operator,
            value,
            conditionId: newId('con', 7),
          };
        }),
      }),
    ]);
  }

  /** A table's state for a view given by id or name (the current view by default). */
  private async viewState(baseToken: string, o: { table?: string; view?: string }) {
    const t = await this.load(baseToken, o.table, 1);
    if (o.view === undefined) return t;
    const view = t.views.find((v) => v.id === o.view || v.name === o.view);
    if (!view) throw new Error(`没有这个视图: ${o.view}`);
    return { ...t, viewId: view.id };
  }

  /** Remove a view (by id or name); a table keeps at least one. */
  async deleteView(baseToken: string, view: string, o: { table?: string } = {}) {
    const t = await this.load(baseToken, o.table, 1);
    const index = t.views.findIndex((v) => v.id === view || v.name === view);
    const target = t.views[index];
    if (!target) throw new Error(`没有这个视图: ${view}`);
    if (t.views.length === 1) throw new Error('数据表至少要留一个视图');
    await this.commit(t, [
      {
        command: 'DeleteView',
        type: 2,
        syncFlag: 0,
        actions: [
          {
            action: 'data.deleteView',
            type: 2,
            tableId: t.id,
            viewId: target.id,
            name: target.name,
            data: { index, total: t.views.length, bizType: 0 },
          },
        ],
      },
    ]);
  }

  /** Remove a field (by id or name); the primary field cannot be removed. */
  async deleteField(baseToken: string, field: string, o: { table?: string } = {}) {
    const t = await this.load(baseToken, o.table, 1);
    const index = t.fields.findIndex((f) => f.id === field || f.name === field);
    const target = t.fields[index];
    if (!target) throw new Error(`没有这个字段: ${field}`);
    if (target.primary) throw new Error(`主字段不能删除: ${target.name}`);
    await this.commit(t, [
      {
        command: 'DeleteFields',
        type: 2,
        syncFlag: 0,
        actions: [
          {
            action: 'data.deleteField',
            type: 2,
            tableId: t.id,
            fieldId: target.id,
            viewId: t.viewId,
            name: target.name,
            data: { indexes: { [t.viewId]: index }, total: t.fields.length },
          },
        ],
      },
    ]);
  }

  /** SetRecord (and AddOptions for select names the field lacks) for a record's new values. */
  private setOps(
    t: TableState,
    recordId: string,
    values: Record<string, CellInput>,
    names: Map<string, string>,
  ): Dict[] {
    const ops: Dict[] = [];
    const data: Dict = {};
    for (const [key, input] of Object.entries(values)) {
      const f = t.fields.find((x) => x.id === key) ?? t.fields.find((x) => x.name === key);
      if (!f) throw new Error(`没有这个字段: ${key}`);
      const { value, newOptions } = this.encode(f, input, names);
      if (newOptions.length) {
        ops.push({
          command: 'AddOptions',
          type: 2,
          syncFlag: 0,
          actions: [
            {
              action: 'data.addOptions',
              type: 2,
              tableId: t.id,
              viewId: t.viewId,
              fieldId: f.id,
              data: { options: newOptions },
              originData: { fieldName: f.name },
            },
          ],
        });
        f.options.push(...newOptions);
      }
      data[f.id] = { type: f.type, value };
    }
    if (Object.keys(data).length)
      ops.push({
        command: 'SetRecord',
        type: 2,
        syncFlag: 0,
        actions: [
          {
            action: 'data.setRecord',
            type: 2,
            tableId: t.id,
            viewId: t.viewId,
            recordId,
            viewType: 1,
            data,
          },
        ],
      });
    return ops;
  }

  /** A given value → the stored form for the field, plus select options to create. */
  private encode(f: BaseField, input: CellInput, names: Map<string, string>) {
    const newOptions: (SelectOption & { color: number })[] = [];
    if (input === null || input === '') return { value: null, newOptions };
    const text = Array.isArray(input) ? input.join(',') : String(input);
    const optionId = (name: string) => {
      const known = [...f.options, ...newOptions].find((o) => o.name === name);
      if (known) return known.id;
      const created = {
        id: newId('opt', 7),
        name,
        color: (f.options.length + newOptions.length) % 54,
      };
      newOptions.push(created);
      return created.id;
    };
    switch (f.type) {
      case FIELD_TYPES.text:
        return { value: [{ type: 'text', text }], newOptions };
      case FIELD_TYPES.number: {
        const n = typeof input === 'number' ? input : Number(text);
        if (!Number.isFinite(n)) throw new Error(`${f.name} 要填数字: ${text}`);
        return { value: n, newOptions };
      }
      case FIELD_TYPES.select:
        return { value: optionId(text.trim()), newOptions };
      case FIELD_TYPES.multiselect: {
        const names = (Array.isArray(input) ? input : text.split(/[,，]/)).map((x) => x.trim());
        return { value: names.filter(Boolean).map(optionId), newOptions };
      }
      case FIELD_TYPES.date:
        return { value: typeof input === 'number' ? input : parseDate(text), newOptions };
      case FIELD_TYPES.checkbox: {
        if (typeof input === 'boolean') return { value: input, newOptions };
        if (/^(true|1|yes|是|y)$/i.test(text.trim())) return { value: true, newOptions };
        if (/^(false|0|no|否|n)$/i.test(text.trim())) return { value: false, newOptions };
        throw new Error(`${f.name} 要填 true 或 false: ${text}`);
      }
      case FIELD_TYPES.url:
        return { value: [{ type: 'url', text, link: text }], newOptions };
      case FIELD_TYPES.link: {
        const ids = listInput(input);
        return { value: ids.length ? ids : null, newOptions };
      }
      case FIELD_TYPES.person: {
        const users = listInput(input).map((userId) => {
          const name = names.get(userId);
          return { userId, ...(name ? { name, enName: name } : {}) };
        });
        return { value: users.length ? { users } : null, newOptions };
      }
      default:
        throw new Error(`不支持写入 ${f.name}(字段类型 ${f.type})`);
    }
  }

  /** Sends operations to a table; throws unless the server accepts the commit. */
  private async commit(t: TableState, operations: Dict[]): Promise<number> {
    t.rev = await this.send('BITABLE_TABLE', t.id, t.baseToken, t.rev, operations);
    return t.rev;
  }

  /** Sends USER_CHANGES to a table (BITABLE_TABLE) or the Base (BITABLE_BASE); returns the new rev. */
  private async send(
    kind: 'BITABLE_TABLE' | 'BITABLE_BASE',
    token: string,
    routeKey: string | undefined,
    localRev: number,
    operations: Dict[],
  ): Promise<number> {
    const memberId = Math.floor(Math.random() * 9e13) + 1e13;
    const reply = check(
      await this.web.json('POST', '/space/api/rce/messages', {
        query: { member_id: memberId },
        headers: { 'x-command': 'api.bitable.rce.message' },
        json: {
          type: kind,
          version: 2,
          req_id: 1,
          data: {
            member_id: memberId,
            user_ticket: '',
            type: 'USER_CHANGES',
            token,
            ...(routeKey ? { route_key: routeKey } : {}),
            lang: 'zh',
            suiteLang: 'zh',
            localRev,
            operations: zip(operations),
            signature: crypto.randomUUID(),
            content_type: 'gzip/base64',
          },
        },
      }),
      '写入多维表格',
    );
    const data = (reply.data ?? {}) as Dict;
    if (data.type !== 'ACCEPT_COMMIT')
      throw new Error(
        `写入多维表格失败: ${String(data.msg ?? data.type)}(${String(data.code ?? '')})`,
      );
    return Number(data.rev ?? localRev + 1);
  }

  /** The Base's schema (`base`: tables, blocks, rev, ...). */
  private async schema(baseToken: string): Promise<Dict> {
    const body = check(
      await this.web.json('GET', `/space/api/bitable/${baseToken}/client_vars/`),
      '读取多维表格',
    );
    return unzip((body.data as Dict | undefined)?.gzipSchema).base as Dict;
  }

  /** A table's state from clientvars, with the first `recordLimit` records. */
  private async load(
    baseToken: string,
    tableId: string | undefined,
    recordLimit: number,
    view?: string,
  ): Promise<TableState> {
    let t: Dict = {};
    let meta: Dict = {};
    // The snapshot lags recent commits for a moment (meta.rev < latestCSRev); wait for it.
    for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt++) {
      const body = check(
        await this.web.json('GET', `/space/api/v1/bitable/${baseToken}/clientvars`, {
          query: { tableID: tableId ?? '', recordLimit, ...(view ? { viewID: view } : {}) },
        }),
        '读取多维表格',
      );
      const data = (body.data ?? {}) as Dict;
      if (!data.table) throw new Error(`找不到数据表 ${tableId ?? ''}`);
      t = unzip(data.table) as Dict;
      meta = (t.meta ?? {}) as Dict;
      if (Number(meta.rev ?? 0) >= Number(t.latestCSRev ?? 0)) break;
      await new Promise((r) => setTimeout(r, SNAPSHOT_WAIT_MS));
    }
    const fieldMap = (t.fieldMap ?? {}) as Record<string, Dict>;
    const viewMap = (t.viewMap ?? {}) as Record<string, Dict>;
    if (view && !viewMap[view]) {
      // A view given by name: load again by its id.
      const byName = Object.entries(viewMap).find(([, v]) => v.name === view)?.[0];
      if (!byName) throw new Error(`没有这个视图: ${view}`);
      return this.load(baseToken, tableId, recordLimit, byName);
    }
    const viewId = view ?? String(t.currentView ?? ((t.views ?? []) as string[])[0] ?? '');
    const order = ((
      ((t.viewMap as Dict | undefined)?.[viewId] as Dict | undefined)?.property as Dict | undefined
    )?.fields ?? Object.keys(fieldMap)) as string[];
    const primary = String(t.primaryKey ?? '');
    return {
      baseToken,
      id: String(meta.id ?? tableId ?? ''),
      viewId,
      rev: Number(meta.rev ?? 0),
      fields: [...new Set([...order, ...Object.keys(fieldMap)])]
        .filter((id) => fieldMap[id])
        .map((id) => toField(id, fieldMap[id] as Dict, primary)),
      nextRank: String((t.rankInfo as Dict | undefined)?.nextRank ?? 'i00000000'),
      recordCount: Number(t.recordCount ?? 0),
      firstIds: groupIds(t.groupList),
      views: ((t.views ?? []) as string[]).map((id) => ({
        id,
        name: String(viewMap[id]?.name ?? ''),
        type: Number(viewMap[id]?.type ?? 0),
      })),
      records: (t.recordMap ?? {}) as Record<string, Dict>,
      computed: computedOf(t.formulaInfo),
    };
  }
}
