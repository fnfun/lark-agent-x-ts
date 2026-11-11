import { describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseAssignments, parseCondition } from '../src/cli/base.js';
import { Base, newRecordId, parseDate } from '../src/domains/base.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;
const zip = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v))).toString('base64');
const unzip = (s: unknown) => JSON.parse(gunzipSync(Buffer.from(String(s), 'base64')).toString());

const TABLE = {
  meta: { id: 'tbl1', rev: 5 },
  latestCSRev: 5,
  currentView: 'vew1',
  primaryKey: 'fldText',
  views: ['vew1'],
  viewMap: {
    vew1: {
      property: {
        fields: ['fldText', 'fldNum', 'fldSel', 'fldTags', 'fldDate', 'fldDone', 'fldUrl'],
      },
    },
  },
  fieldMap: {
    fldText: { name: '标题', type: 1 },
    fldNum: { name: '金额', type: 2 },
    fldSel: { name: '状态', type: 3, property: { options: [{ id: 'optA', name: '进行中' }] } },
    fldTags: { name: '标签', type: 4, property: { options: [{ id: 'optT', name: '紧急' }] } },
    fldDate: { name: '截止', type: 5 },
    fldDone: { name: '完成', type: 7 },
    fldUrl: { name: '链接', type: 15 },
  },
  rankInfo: { nextRank: 'i00068qv4' },
  recordCount: 1,
  groupList: [{ recordIDList: ['rec1'] }],
  recordMap: {
    rec1: {
      fldText: {
        value: [
          { type: 'text', text: '周' },
          { type: 'text', text: '报' },
        ],
      },
      fldSel: { value: 'optA' },
      fldTags: { value: ['optT', 'optX'] },
      fldDate: { value: new Date(2026, 10, 20).getTime() },
      fldUrl: { value: [{ type: 'url', text: '官网', link: 'https://example.com' }] },
    },
  },
};

/** The first action of an operation. */
const firstAction = (op: Dict | undefined) => (((op?.actions ?? []) as Dict[])[0] ?? {}) as Dict;

/** The Base's schema: tables tbl1, tbl2 among the sidebar blocks (a dashboard in between). */
const SCHEMA = {
  base: {
    rev: 9,
    tables: ['tbl1', 'tbl2'],
    blocks: ['tbl1', 'blkDash', 'tbl2'],
    tableInfos: { tbl1: { name: '任务' }, tbl2: { name: '归档' } },
  },
};

/** Fake web: serves table snapshots in turn and accepts commits, recording their operations. */
function fake(
  snapshots: Dict[] = [TABLE],
  reply: Dict = { type: 'ACCEPT_COMMIT', rev: 6 },
  schema: Dict = SCHEMA,
) {
  const commits: { kind: unknown; data: Dict; ops: Dict[] }[] = [];
  let n = 0;
  const web = {
    json: async (_m: string, path: string, o: WebRequest = {}) => {
      if (path.endsWith('/clientvars'))
        return { code: 0, data: { table: zip(snapshots[Math.min(n++, snapshots.length - 1)]) } };
      if (path.endsWith('/client_vars/')) return { code: 0, data: { gzipSchema: zip(schema) } };
      if (path.endsWith('/user/')) return { code: 0, data: { suid: 'u1' } };
      const data = (o.json as { data: Dict }).data;
      commits.push({ kind: (o.json as Dict).type, data, ops: unzip(data.operations) });
      return { code: 0, data: reply };
    },
  } as unknown as WebSession;
  return { base: new Base(web), commits };
}

describe('多维表格', () => {
  test('读记录：选项 id 换成名字，文本片段直接拼接，日期显示为本地日期，链接取地址', async () => {
    const { base } = fake();
    const [r] = await base.records('B1');
    expect(r?.fields).toEqual({
      标题: '周报',
      金额: null,
      状态: '进行中',
      标签: '紧急, optX',
      截止: '2026-11-20',
      完成: null,
      链接: 'https://example.com',
    });
  });

  test('快照落后于最新提交（rev < latestCSRev）时等它追上再读', async () => {
    const stale = { ...TABLE, meta: { id: 'tbl1', rev: 4 }, recordMap: {} };
    const { base } = fake([stale, TABLE]);
    expect((await base.records('B1'))[0]?.fields.状态).toBe('进行中');
  });

  test('写记录按字段类型编码；没有的选项先在同一次提交里新建，已有的复用 id', async () => {
    const { base, commits } = fake();
    await base.setRecord('B1', 'rec1', {
      标题: '新标题',
      金额: '12.5',
      状态: '完成',
      标签: '紧急,新标签',
      截止: '2026-12-01 09:30',
      完成: 'true',
      链接: 'https://example.org',
    });
    const [commit] = commits;
    expect(commit?.data).toMatchObject({
      token: 'tbl1',
      route_key: 'B1',
      localRev: 5,
      type: 'USER_CHANGES',
    });
    const ops = commit?.ops ?? [];
    expect(ops.map((o) => o.command)).toEqual(['AddOptions', 'AddOptions', 'SetRecord']);
    const created = ops
      .slice(0, 2)
      .map((o) => (firstAction(o).data as { options: { id: string; name: string }[] }).options[0]);
    const data = firstAction(ops[2]).data as Record<string, { value: unknown }>;
    expect(data.fldText?.value).toEqual([{ type: 'text', text: '新标题' }]);
    expect(data.fldNum?.value).toBe(12.5);
    expect(data.fldSel?.value).toBe(created[0]?.id);
    expect(data.fldTags?.value).toEqual(['optT', created[1]?.id]);
    expect(data.fldDate?.value).toBe(new Date(2026, 11, 1, 9, 30).getTime());
    expect(data.fldDone?.value).toBe(true);
    expect(data.fldUrl?.value).toEqual([
      { type: 'url', text: 'https://example.org', link: 'https://example.org' },
    ]);
    expect(created.map((o) => o?.name)).toEqual(['完成', '新标签']);
  });

  test('填不了的值、没有的字段直接报错，不提交', async () => {
    const { base, commits } = fake();
    await expect(base.setRecord('B1', 'rec1', { 金额: '很多' })).rejects.toThrow('数字');
    await expect(base.setRecord('B1', 'rec1', { 完成: '也许' })).rejects.toThrow('true');
    await expect(base.setRecord('B1', 'rec1', { 不存在: 'x' })).rejects.toThrow('没有这个字段');
    expect(commits).toHaveLength(0);
  });

  test('新增记录放在 nextRank，记录 id 按服务端要求的格式生成；服务端不接受提交时报错', async () => {
    const { base, commits } = fake();
    await base.addRecord('B1', {});
    const action = firstAction(commits[0]?.ops[0]) as { recordId: string; data: Dict };
    expect(action.data.tableRank).toBe('i00068qv4');
    expect(action.recordId).toMatch(/^reczz[0-9A-Za-z]{11}$/);
    const rejected = fake([TABLE], { type: 'ERROR', code: 4199, msg: 'invalid' });
    await expect(rejected.base.deleteRecords('B1', ['rec1'])).rejects.toThrow('invalid');
  });

  test('记录 id 随时间递增（62 进制，数字、大写、小写的顺序）', () => {
    const a = newRecordId(1794332804000, 5);
    const b = newRecordId(1794332804001, 0);
    expect(a < b).toBe(true);
    expect(newRecordId(1794332804000, 5)).toBe(a);
  });

  test('日期：本地日期或日期时间，纯数字按秒或毫秒', () => {
    expect(parseDate('2026/11/20')).toBe(new Date(2026, 10, 20).getTime());
    expect(parseDate('2026-11-20 18:30')).toBe(new Date(2026, 10, 20, 18, 30).getTime());
    expect(parseDate('1794332804')).toBe(1794332804000);
    expect(() => parseDate('下周')).toThrow('日期');
  });

  test('命令行的 字段=值：按第一个等号切开，值可以为空或含等号', () => {
    expect(parseAssignments(['标题=a=b', '金额='])).toEqual({ 标题: 'a=b', 金额: '' });
    expect(() => parseAssignments(['标题'])).toThrow('字段=值');
  });

  test('按字段筛选：单选等于选项名，多选为含有该选项；分组视图的各组记录按顺序合并；没有的字段报错', async () => {
    const grouped = {
      ...TABLE,
      recordCount: 3,
      groupList: [{ recordIDList: ['rec1'] }, { recordIDList: ['rec2', 'rec3'] }],
      recordMap: {
        rec1: { fldSel: { value: 'optA' }, fldTags: { value: ['optT'] } },
        rec2: { fldSel: { value: 'optA' } },
        rec3: { fldTags: { value: ['optT'] } },
      },
    };
    const { base } = fake([grouped]);
    expect((await base.records('B1')).map((r) => r.id)).toEqual(['rec1', 'rec2', 'rec3']);
    expect((await base.records('B1', { where: { 状态: '进行中' } })).map((r) => r.id)).toEqual([
      'rec1',
      'rec2',
    ]);
    expect(
      (await base.records('B1', { where: { 标签: '紧急', 状态: '进行中' } })).map((r) => r.id),
    ).toEqual(['rec1']);
    await expect(base.records('B1', { where: { 不存在: 'x' } })).rejects.toThrow('没有这个字段');
  });

  test('建表：发给整个多维表格（BITABLE_BASE、不带 route_key、按 schema 的 rev），排在数据表和侧栏块的最后，带主字段和表格视图', async () => {
    const { base, commits } = fake();
    const id = await base.addTable('B1', '新表', { primary: '任务名' });
    const [c] = commits;
    expect([c?.kind, c?.data.token, c?.data.route_key, c?.data.localRev]).toEqual([
      'BITABLE_BASE',
      'B1',
      undefined,
      9,
    ]);
    const action = firstAction(c?.ops[0]);
    expect(action).toMatchObject({ action: 'base.addTableV2', tableId: id });
    const data = action.data as Dict & { snapshot: Dict & { fieldMap: Dict; viewMap: Dict } };
    expect([data.index, data.blockIndex, data.total, data.name]).toEqual([2, 3, 3, '新表']);
    const primary = data.snapshot.fieldMap[String(data.snapshot.primaryKey)] as Dict;
    expect(primary).toMatchObject({ name: '任务名', type: 1 });
    const [view] = Object.values(data.snapshot.viewMap) as { property: { fields: string[] } }[];
    expect(view?.property.fields).toEqual([String(data.snapshot.primaryKey)]);
  });

  test('删表：带上它在数据表和侧栏块里的位置；不存在或只剩一张时什么都不发', async () => {
    const { base, commits } = fake();
    await base.deleteTable('B1', 'tbl2');
    expect(commits[0]?.kind).toBe('BITABLE_BASE');
    expect(firstAction(commits[0]?.ops[0])).toMatchObject({
      action: 'base.deleteTable',
      tableId: 'tbl2',
      name: '归档',
      data: { index: 1, blockIndex: 2, total: 3 },
    });
    await expect(base.deleteTable('B1', 'tblX')).rejects.toThrow('找不到数据表');
    const single = fake([TABLE], undefined, { base: { ...SCHEMA.base, tables: ['tbl1'] } });
    await expect(single.base.deleteTable('B1', 'tbl1')).rejects.toThrow('至少要留一张');
    expect(commits).toHaveLength(1);
    expect(single.commits).toHaveLength(0);
  });

  test('删字段：按名字或 id 找，带上它在当前视图里的位置；主字段不能删', async () => {
    const { base, commits } = fake();
    await base.deleteField('B1', '截止');
    expect(commits[0]?.kind).toBe('BITABLE_TABLE');
    expect(firstAction(commits[0]?.ops[0])).toMatchObject({
      action: 'data.deleteField',
      fieldId: 'fldDate',
      viewId: 'vew1',
      data: { indexes: { vew1: 4 }, total: 7 },
    });
    await expect(base.deleteField('B1', 'fldText')).rejects.toThrow('主字段不能删除');
    await expect(base.deleteField('B1', '不存在')).rejects.toThrow('没有这个字段');
    expect(commits).toHaveLength(1);
  });

  test('搜索和筛选在整张表里找、找完再按 limit 截断；搜索不分大小写、任一字段含有即可', async () => {
    const queries: Dict[] = [];
    const web = {
      json: async (_m: string, path: string, o: WebRequest = {}) => {
        if (path.endsWith('/clientvars'))
          return { code: 0, data: { table: zip({ ...TABLE, recordCount: 3 }) } };
        queries.push(o.query as Dict);
        return {
          code: 0,
          data: {
            records: zip({
              groupList: [{ recordIDList: ['rec2', 'rec3'] }],
              recordMap: {
                rec2: { fldText: { value: [{ type: 'text', text: '月报' }] } },
                rec3: { fldText: { value: [{ type: 'text', text: 'Q3 Review' }] } },
              },
            }),
          },
        };
      },
    } as unknown as WebSession;
    const base = new Base(web);
    expect((await base.records('B1', { search: 'review', limit: 1 })).map((r) => r.id)).toEqual([
      'rec3',
    ]);
    expect(queries[0]).toMatchObject({ offset: 1, limit: 2 });
    expect((await base.records('B1', { search: '报', limit: 1 })).map((r) => r.id)).toEqual([
      'rec1',
    ]);
  });

  test('附件：挂在多维表格上上传，单元格里 id 和 attachmentToken 都是文件 token，加在已有附件后面；记录不在第一页也能找到；非附件字段报错', async () => {
    const table = {
      ...TABLE,
      recordCount: 2,
      fieldMap: { ...TABLE.fieldMap, fldFile: { name: '附件', type: 17 } },
    };
    const uploads: WebRequest[] = [];
    const commits: Dict[][] = [];
    const web = {
      origin: async () => 'https://tenant.feishu.cn',
      json: async (_m: string, path: string, o: WebRequest = {}) => {
        if (path.endsWith('/clientvars')) return { code: 0, data: { table: zip(table) } };
        if (path.endsWith('/records'))
          return {
            code: 0,
            data: {
              records: zip({
                groupList: [{ recordIDList: ['rec2'] }],
                recordMap: { rec2: { fldFile: { value: [{ id: 'F0', name: '旧.pdf' }] } } },
              }),
            },
          };
        if (path.includes('upload')) {
          uploads.push(o);
          return { code: 0, data: { file_token: 'F1' } };
        }
        commits.push(unzip((o.json as { data: Dict }).data.operations));
        return { code: 0, data: { type: 'ACCEPT_COMMIT', rev: 6 } };
      },
    } as unknown as WebSession;
    const base = new Base(web);
    const file = { data: new TextEncoder().encode('hi'), name: '新.txt' };
    expect(await base.attach('B1', 'rec2', '附件', [file])).toEqual(['F1']);
    expect(uploads[0]?.query).toMatchObject({
      mount_point: 'bitable_file',
      mount_node_token: 'B1',
    });
    const action = firstAction(commits[0]?.[0]);
    expect(action).toMatchObject({ action: 'data.setRecord', recordId: 'rec2' });
    expect((action.data as Dict).fldFile).toMatchObject({
      type: 17,
      value: [
        { id: 'F0', name: '旧.pdf' },
        { id: 'F1', attachmentToken: 'F1', name: '新.txt', size: 2, mimeType: 'text/plain' },
      ],
    });
    await expect(base.attach('B1', 'rec2', '标题', [file])).rejects.toThrow('不是附件字段');
    await expect(base.attach('B1', 'recX', '附件', [file])).rejects.toThrow('找不到记录');
    expect(commits).toHaveLength(1);
  });

  test('视图：新建的表格视图排在最后、按表的字段顺序显示全部字段、owner 是自己；按名字删视图带上它的位置；只剩一个时不删', async () => {
    const { base, commits } = fake();
    const id = await base.addView('B1', '周报视图');
    expect(firstAction(commits[0]?.ops[0])).toMatchObject({
      action: 'data.addViewV2',
      viewId: id,
      data: {
        type: 1,
        index: 1,
        total: 1,
        name: '周报视图',
        owner: 'u1',
        property: { fields: TABLE.viewMap.vew1.property.fields },
      },
    });
    await expect(base.deleteView('B1', 'vew1')).rejects.toThrow('至少要留一个视图');
    const two = fake([
      {
        ...TABLE,
        views: ['vew1', 'vew2'],
        viewMap: { ...TABLE.viewMap, vew2: { name: '归档', property: { fields: [] } } },
      },
    ]);
    await two.base.deleteView('B1', '归档');
    expect(firstAction(two.commits[0]?.ops[0])).toMatchObject({
      action: 'data.deleteView',
      viewId: 'vew2',
      data: { index: 1, total: 2 },
    });
    await expect(two.base.deleteView('B1', '没有')).rejects.toThrow('没有这个视图');
    expect([commits.length, two.commits.length]).toEqual([1, 1]);
  });

  test('视图设置：排序和分组按字段 id 和方向；筛选把单选的选项名换成 id、为空类条件不带值，可选“任一满足”；视图可按名字指定', async () => {
    const two = {
      ...TABLE,
      views: ['vew1', 'vew2'],
      viewMap: { ...TABLE.viewMap, vew2: { name: '周报', property: { fields: [] } } },
    };
    const { base, commits } = fake([two]);
    await base.setSort('B1', [{ field: '金额', desc: true }, { field: '标题' }], { view: '周报' });
    expect(firstAction(commits[0]?.ops[0])).toMatchObject({
      action: 'view.sortRecordsV2',
      viewId: 'vew2',
      data: {
        sortInfo: [
          { fieldId: 'fldNum', desc: true },
          { fieldId: 'fldText', desc: false },
        ],
        autoSort: true,
      },
    });
    await base.setGroup('B1', [{ field: '状态' }]);
    expect(firstAction(commits[1]?.ops[0])).toMatchObject({
      action: 'view.setGroup',
      viewId: 'vew1',
      viewType: 1,
      data: { group: [{ fieldId: 'fldSel', desc: false }] },
    });
    await base.setFilter(
      'B1',
      [
        { field: '状态', operator: 'is', value: ['进行中'] },
        { field: '标题', operator: 'isNotEmpty', value: ['忽略'] },
      ],
      { or: true },
    );
    const data = firstAction(commits[2]?.ops[0]).data as {
      conjunction: string;
      conditions: Dict[];
    };
    expect(data.conjunction).toBe('or');
    expect(data.conditions).toMatchObject([
      { fieldId: 'fldSel', fieldType: 3, operator: 'is', value: ['optA'] },
      { fieldId: 'fldText', operator: 'isNotEmpty', value: [] },
    ]);
    await expect(
      base.setFilter('B1', [{ field: '状态', operator: 'is', value: ['没有'] }]),
    ).rejects.toThrow('没有这个选项');
    await expect(base.setFilter('B1', [{ field: '标题', operator: 'like' }])).rejects.toThrow(
      '不认识的筛选条件',
    );
    await expect(base.setSort('B1', [], { view: '不存在' })).rejects.toThrow('没有这个视图');
    expect(commits).toHaveLength(3);
  });

  test('命令行筛选条件：= != ~ !~ > <；= 和 != 后面留空为 为空 / 不为空；字段名里可以有空格', () => {
    expect(
      ['状态=完成', '状态!=完成', '标题~周报', '标题!~草稿', '金额>10', '备注=', '备注!='].map(
        parseCondition,
      ),
    ).toEqual([
      { field: '状态', operator: 'is', value: ['完成'] },
      { field: '状态', operator: 'isNot', value: ['完成'] },
      { field: '标题', operator: 'contains', value: ['周报'] },
      { field: '标题', operator: 'doesNotContain', value: ['草稿'] },
      { field: '金额', operator: 'isGreater', value: ['10'] },
      { field: '备注', operator: 'isEmpty' },
      { field: '备注', operator: 'isNotEmpty' },
    ]);
    expect(parseCondition('任务 名称=a b')).toEqual({
      field: '任务 名称',
      operator: 'is',
      value: ['a b'],
    });
    expect(() => parseCondition('没有运算符')).toThrow('看不懂');
  });
});
