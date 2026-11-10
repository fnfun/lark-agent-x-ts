import { describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseAssignments } from '../src/cli/base.js';
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

/** Fake web: serves table snapshots in turn and accepts commits, recording their operations. */
function fake(snapshots: Dict[] = [TABLE], reply: Dict = { type: 'ACCEPT_COMMIT', rev: 6 }) {
  const commits: { data: Dict; ops: Dict[] }[] = [];
  let n = 0;
  const web = {
    json: async (_m: string, path: string, o: WebRequest = {}) => {
      if (path.endsWith('/clientvars'))
        return { code: 0, data: { table: zip(snapshots[Math.min(n++, snapshots.length - 1)]) } };
      const data = (o.json as { data: Dict }).data;
      commits.push({ data, ops: unzip(data.operations) });
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
});
