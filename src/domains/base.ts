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
 *   `[{type: "url", text, link}]`. New select options are added in the same commit.
 * - A new record goes at the table's `rankInfo.nextRank`; the server moves nextRank on.
 * - Tables are added and removed with a `BITABLE_BASE` message (token: the Base token, no
 *   route_key, localRev: the schema's `base.rev`): AddTableV2 (`base.addTableV2` with the new
 *   table's snapshot: a primary text field and a grid view) and DeleteTable (`base.deleteTable`,
 *   which moves it to the Base's trash). Both name the table's position among `base.tables` and
 *   among the sidebar's `base.blocks` (tables, dashboards, workflows). Removing a field is
 *   DeleteFields (`data.deleteField` with its position in the view). Read off the web app's traffic
 *   on 2026-11-11.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import type { WebSession } from '../web.js';
import { check } from './docs.js';

type Dict = Record<string, unknown>;

/** Field types this module reads and writes as plain values, by the server's number. */
export const FIELD_TYPES = {
  text: 1,
  number: 2,
  select: 3,
  multiselect: 4,
  date: 5,
  checkbox: 7,
  url: 15,
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
const TYPE_NAMES = Object.fromEntries(
  Object.entries(FIELD_TYPES).map(([k, v]) => [v, k]),
) as Record<number, FieldType>;

/** Properties a new field of each type starts with, as the web app sends them. */
const FIELD_PROPERTY: Record<FieldType, Dict | undefined> = {
  text: undefined,
  number: { formatter: '0' },
  select: { options: [], optionsType: 0 },
  multiselect: { options: [], optionsType: 0 },
  date: { timeFormat: '', displayTimeZone: false, autoFill: false, dateFormat: 'yyyy/MM/dd' },
  checkbox: { styleId: '0' },
  url: { extractExternalUrl: false },
};
const UI_TYPES: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  select: 'SingleSelect',
  multiselect: 'MultiSelect',
  date: 'DateTime',
  checkbox: 'Checkbox',
  url: 'Url',
};

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
}

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
export function readCell(field: BaseField, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
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
  constructor(readonly web: WebSession) {}

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
          readCell(f, (cells[id]?.[f.id] as Dict | undefined)?.value),
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
    await this.commit(t, [add, ...this.setOps(t, recordId, values)]);
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
    await this.commit(t, this.setOps(t, recordId, values));
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

  /** Add a field at the end of the table; returns its id. */
  async addField(baseToken: string, name: string, type: FieldType, o: { table?: string } = {}) {
    const t = await this.load(baseToken, o.table, 1);
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
              type: FIELD_TYPES[type],
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
              type: FIELD_TYPES[type],
              defaultValueRule: null,
              fieldUIType: uiType,
              enumerable,
              ...(FIELD_PROPERTY[type] ? { property: FIELD_PROPERTY[type] } : {}),
              exInfo,
            },
          },
        ],
      },
    ]);
    return fieldId;
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
  private setOps(t: TableState, recordId: string, values: Record<string, CellInput>): Dict[] {
    const ops: Dict[] = [];
    const data: Dict = {};
    for (const [key, input] of Object.entries(values)) {
      const f = t.fields.find((x) => x.id === key) ?? t.fields.find((x) => x.name === key);
      if (!f) throw new Error(`没有这个字段: ${key}`);
      const { value, newOptions } = this.encode(f, input);
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
  private encode(f: BaseField, input: CellInput) {
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
    const viewId = view ?? String(t.currentView ?? ((t.views ?? []) as string[])[0] ?? '');
    if (view && !viewMap[view]) throw new Error(`没有这个视图: ${view}`);
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
    };
  }
}
