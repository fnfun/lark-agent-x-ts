import { LarkAuth } from '../auth.js';
import { Base, type CellInput, FIELD_TYPES, type FieldType } from '../domains/base.js';
import { Wiki } from '../domains/wiki.js';
import { WebSession } from '../web.js';
import type { Option } from './args.js';
import { type Command, type CommandGroup, err, out } from './common.js';
import { errorText, printJson } from './format.js';

const web = () => new WebSession(new LarkAuth());
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };
const TABLE_OPTION: Option = {
  name: 'table',
  kind: 'string',
  help: '数据表 id(tbl 开头,见 tables);不填为链接里的表或第一张表',
};
const BASE_ARG = { name: 'base', help: '多维表格链接(含知识库链接)或 token' };

/** The Base token and table a command names: a /base/ link (its ?table= too), a wiki link, or a token. */
async function target(a: Record<string, unknown>): Promise<{ token: string; table?: string }> {
  const input = String(a.base);
  const table = a.table
    ? String(a.table)
    : (/[?&]table=(tbl[A-Za-z0-9]+)/.exec(input)?.[1] ?? undefined);
  let token = /\/base\/([A-Za-z0-9]+)/.exec(input)?.[1] ?? input.trim();
  if (/\/wiki\//.test(input)) {
    const ref = await new Wiki(web()).resolve(input);
    if (ref.type !== 'base') throw new Error('这个知识库页面不是多维表格');
    token = ref.token;
  }
  return table ? { token, table } : { token };
}

/** `field=value` arguments → cell values (the first `=` splits; an empty value clears the cell). */
export function parseAssignments(items: string[]): Record<string, CellInput> {
  const values: Record<string, CellInput> = {};
  for (const item of items) {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`要写成 字段=值: ${item}`);
    values[item.slice(0, i)] = item.slice(i + 1);
  }
  return values;
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

const tables: Command = {
  name: 'tables',
  help: '列出多维表格里的数据表',
  access: 'base.tables',
  positionals: [BASE_ARG],
  options: [JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const list = await new Base(web()).tables((await target(a)).token);
      if (a.json) printJson(list);
      else for (const t of list) out(`${t.id}\t${t.name}`);
      return 0;
    }),
};

const fields: Command = {
  name: 'fields',
  help: '列出数据表的字段(* 为主字段)',
  access: 'base.fields',
  positionals: [BASE_ARG],
  options: [TABLE_OPTION, JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const list = await new Base(web()).fields(t.token, t.table);
      if (a.json) printJson(list);
      else
        for (const f of list)
          out(
            `${f.id}\t${f.typeName}\t${f.name}${f.primary ? ' *' : ''}${f.options.length ? `\t${f.options.map((o) => o.name).join(', ')}` : ''}`,
          );
      return 0;
    }),
};

const views: Command = {
  name: 'views',
  help: '列出数据表的视图',
  access: 'base.views',
  positionals: [BASE_ARG],
  options: [TABLE_OPTION, JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const list = await new Base(web()).views(t.token, t.table);
      if (a.json) printJson(list);
      else for (const v of list) out(`${v.id}\t${v.name}`);
      return 0;
    }),
};

const records: Command = {
  name: 'records',
  help: '列出记录(按第一个视图的顺序)',
  access: 'base.records',
  positionals: [BASE_ARG],
  options: [
    TABLE_OPTION,
    { name: 'view', kind: 'string', help: '按这个视图的顺序(视图 id,见 views)' },
    {
      name: 'where',
      kind: 'string',
      help: '只要 字段=值 的记录,多个条件用 ; 分隔(在读到的记录里本地筛选;多选字段为含有该选项)',
    },
    { name: 'limit', kind: 'int', default: 100 },
    JSON_OPTION,
  ],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const list = await new Base(web()).records(t.token, {
        limit: Number(a.limit),
        ...(t.table ? { table: t.table } : {}),
        ...(a.view ? { view: String(a.view) } : {}),
        ...(a.where
          ? {
              where: Object.fromEntries(
                Object.entries(parseAssignments(String(a.where).split(';').filter(Boolean))).map(
                  ([k, v]) => [k, String(v ?? '')],
                ),
              ),
            }
          : {}),
      });
      if (a.json) printJson(list);
      else
        for (const r of list)
          out(
            `${r.id}\t${Object.entries(r.fields)
              .filter(([, v]) => v !== null && v !== '')
              .map(([k, v]) => `${k}=${String(v)}`)
              .join('\t')}`,
          );
      return 0;
    }),
};

const add: Command = {
  name: 'add',
  help: '新增一条记录(字段=值;单选、多选填选项名,没有的选项会新建,多选用逗号分隔;日期填 2026-11-20 或 2026-11-20 18:30)',
  access: 'base.add',
  positionals: [BASE_ARG, { name: 'values', nargs: '*', help: '字段=值' }],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const id = await new Base(web()).addRecord(
        t.token,
        parseAssignments(a.values as string[]),
        t.table ? { table: t.table } : {},
      );
      out(`已新增 record_id=${id}`);
      return 0;
    }),
};

const set: Command = {
  name: 'set',
  help: '修改一条记录的字段(字段=值,值留空为清空)',
  access: 'base.set',
  positionals: [BASE_ARG, { name: 'record_id' }, { name: 'values', nargs: '+', help: '字段=值' }],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      await new Base(web()).setRecord(
        t.token,
        String(a.record_id),
        parseAssignments(a.values as string[]),
        t.table ? { table: t.table } : {},
      );
      out('已修改');
      return 0;
    }),
};

const rm: Command = {
  name: 'rm',
  help: '删除记录',
  access: 'base.rm',
  positionals: [BASE_ARG, { name: 'record_ids', nargs: '+' }],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const ids = a.record_ids as string[];
      await new Base(web()).deleteRecords(t.token, ids, t.table ? { table: t.table } : {});
      out(`已删除 ${ids.length} 条`);
      return 0;
    }),
};

const fieldAdd: Command = {
  name: 'field-add',
  help: '在数据表末尾加一个字段',
  access: 'base.field-add',
  positionals: [BASE_ARG, { name: 'name', nargs: '+' }],
  options: [
    TABLE_OPTION,
    {
      name: 'type',
      kind: 'string',
      choices: Object.keys(FIELD_TYPES),
      default: 'text',
      help: '字段类型',
    },
  ],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const id = await new Base(web()).addField(
        t.token,
        (a.name as string[]).join(' '),
        String(a.type) as FieldType,
        t.table ? { table: t.table } : {},
      );
      out(`已添加 field_id=${id}`);
      return 0;
    }),
};

export const baseGroup: CommandGroup = {
  name: 'base',
  help: '多维表格:列数据表、字段、视图、记录(可按视图排序、按字段筛选),增删改记录,加字段',
  subcommands: [tables, fields, views, records, add, set, rm, fieldAdd],
};
