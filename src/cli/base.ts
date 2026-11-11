import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { LarkAuth } from '../auth.js';
import {
  Base,
  type CellInput,
  FIELD_TYPES,
  type FieldType,
  type FilterCondition,
} from '../domains/base.js';
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
    { name: 'view', kind: 'string', help: '按这个视图的顺序和筛选(视图 id 或名字,见 views)' },
    {
      name: 'where',
      kind: 'string',
      help: '只要 字段=值 的记录,多个条件用 ; 分隔(读完整张表后本地筛选;多选字段为含有该选项)',
    },
    {
      name: 'search',
      kind: 'string',
      help: '只要任一字段含有这段文字的记录(不分大小写,本地查找)',
    },
    { name: 'limit', kind: 'int', default: 100 },
    JSON_OPTION,
  ],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const list = await new Base(web()).records(t.token, {
        limit: Number(a.limit),
        ...(a.search ? { search: String(a.search) } : {}),
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

const attach: Command = {
  name: 'attach',
  help: '把本地文件上传到记录的附件字段(加在已有附件后面)',
  access: 'base.attach',
  positionals: [
    BASE_ARG,
    { name: 'record_id' },
    { name: 'field', help: '附件字段(id 或名字)' },
    { name: 'paths', nargs: '+', help: '本地文件' },
  ],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const files = (a.paths as string[]).map((p) => {
        if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`不是文件: ${p}`);
        return { data: new Uint8Array(readFileSync(p)), name: basename(p) };
      });
      const tokens = await new Base(web()).attach(
        t.token,
        String(a.record_id),
        String(a.field),
        files,
        t.table ? { table: t.table } : {},
      );
      out(`已上传 ${tokens.length} 个附件`);
      return 0;
    }),
};

const viewAdd: Command = {
  name: 'view-add',
  help: '新建表格视图(显示全部字段)',
  access: 'base.view-add',
  positionals: [BASE_ARG, { name: 'name', nargs: '+' }],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const id = await new Base(web()).addView(
        t.token,
        (a.name as string[]).join(' '),
        t.table ? { table: t.table } : {},
      );
      out(`已新建 view_id=${id}`);
      return 0;
    }),
};

const VIEW_OPTION = { name: 'view', kind: 'string' as const, help: '视图 id 或名字(默认当前视图)' };
const viewOf = (a: Record<string, unknown>, t: { table?: string }) => ({
  ...(t.table ? { table: t.table } : {}),
  ...(a.view ? { view: String(a.view) } : {}),
});
/** "字段" or "字段:desc" → a sort / group key. */
const orderBy = (specs: string[]) =>
  specs.map((s) => {
    const m = /^(.*?)(?::(asc|desc))?$/.exec(s) as RegExpExecArray;
    return { field: m[1] as string, desc: m[2] === 'desc' };
  });

const viewSort: Command = {
  name: 'view-sort',
  help: '设置视图的排序(字段 或 字段:desc,按先后;不给字段为取消排序)',
  access: 'base.view-sort',
  positionals: [BASE_ARG, { name: 'fields', nargs: '*' }],
  options: [TABLE_OPTION, VIEW_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      await new Base(web()).setSort(t.token, orderBy(a.fields as string[]), viewOf(a, t));
      out('已设置');
      return 0;
    }),
};

const viewGroup: Command = {
  name: 'view-group',
  help: '设置视图的分组(字段 或 字段:desc;不给字段为取消分组)',
  access: 'base.view-group',
  positionals: [BASE_ARG, { name: 'fields', nargs: '*' }],
  options: [TABLE_OPTION, VIEW_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      await new Base(web()).setGroup(t.token, orderBy(a.fields as string[]), viewOf(a, t));
      out('已设置');
      return 0;
    }),
};

/** "字段=值" is, "字段!=值" is not, "字段~值" contains, "字段!~值" does not contain; an empty value with = / != is empty / not empty. */
export function parseCondition(spec: string): FilterCondition {
  const m = /^(.+?)(!=|!~|=|~|>|<)(.*)$/.exec(spec);
  if (!m) throw new Error(`看不懂的筛选条件: ${spec}(写成 字段=值、字段!=值、字段~值、字段!~值)`);
  const [, field, op, value] = m as unknown as [string, string, string, string];
  if (value === '' && (op === '=' || op === '!='))
    return { field, operator: op === '=' ? 'isEmpty' : 'isNotEmpty' };
  const operator = {
    '=': 'is',
    '!=': 'isNot',
    '~': 'contains',
    '!~': 'doesNotContain',
    '>': 'isGreater',
    '<': 'isLess',
  }[op] as string;
  return { field, operator, value: [value] };
}

const viewFilter: Command = {
  name: 'view-filter',
  help: '设置视图的筛选条件(字段=值、字段!=值、字段~值 包含、字段!~值 不含、字段> / 字段< 比较;值留空为 为空 / 不为空;不给条件为取消筛选)',
  access: 'base.view-filter',
  positionals: [BASE_ARG, { name: 'conditions', nargs: '*' }],
  options: [
    TABLE_OPTION,
    VIEW_OPTION,
    { name: 'or', kind: 'flag', help: '满足任一条件即可(默认全部满足)' },
  ],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      await new Base(web()).setFilter(t.token, (a.conditions as string[]).map(parseCondition), {
        ...viewOf(a, t),
        ...(a.or ? { or: true } : {}),
      });
      out('已设置');
      return 0;
    }),
};

const viewRm: Command = {
  name: 'view-rm',
  help: '删除视图(按 view_id 或名字;至少留一个)',
  access: 'base.view-rm',
  positionals: [BASE_ARG, { name: 'view' }],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      await new Base(web()).deleteView(t.token, String(a.view), t.table ? { table: t.table } : {});
      out('已删除');
      return 0;
    }),
};

const fieldRm: Command = {
  name: 'field-rm',
  help: '删除字段(按 field_id 或字段名;主字段不能删)',
  access: 'base.field-rm',
  positionals: [BASE_ARG, { name: 'field' }],
  options: [TABLE_OPTION],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      await new Base(web()).deleteField(
        t.token,
        String(a.field),
        t.table ? { table: t.table } : {},
      );
      out('已删除');
      return 0;
    }),
};

const tableAdd: Command = {
  name: 'table-add',
  help: '新建数据表(带一个文本主字段和一个表格视图)',
  access: 'base.table-add',
  positionals: [BASE_ARG, { name: 'name', nargs: '+' }],
  options: [{ name: 'primary', kind: 'string', help: '主字段名(默认 名称)' }],
  run: (a) =>
    guarded(async () => {
      const t = await target(a);
      const id = await new Base(web()).addTable(
        t.token,
        (a.name as string[]).join(' '),
        a.primary === undefined ? {} : { primary: String(a.primary) },
      );
      out(`已新建 table_id=${id}`);
      return 0;
    }),
};

const tableRm: Command = {
  name: 'table-rm',
  help: '删除数据表(移到多维表格的回收站;至少留一张)',
  access: 'base.table-rm',
  positionals: [BASE_ARG, { name: 'table_id' }],
  run: (a) =>
    guarded(async () => {
      await new Base(web()).deleteTable((await target(a)).token, String(a.table_id));
      out('已删除');
      return 0;
    }),
};

export const baseGroup: CommandGroup = {
  name: 'base',
  help: '多维表格:列数据表、字段、视图、记录(可按视图排序、筛选、搜索),增删改记录,上传附件,增删字段、视图和数据表,设置视图的排序、分组和筛选',
  subcommands: [
    tables,
    fields,
    views,
    records,
    add,
    set,
    attach,
    rm,
    fieldAdd,
    fieldRm,
    viewAdd,
    viewRm,
    viewSort,
    viewGroup,
    viewFilter,
    tableAdd,
    tableRm,
  ],
};
