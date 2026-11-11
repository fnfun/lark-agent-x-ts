import { describe, expect, test } from 'bun:test';
import { DocHistory } from '../src/domains/doc-history.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;

const text = (t: string) => ({
  apool: { nextNum: 1, numToAttrib: { 0: ['author', 'u1'] } },
  initialAttributedTexts: { text: { 0: t }, attribs: { 0: `*0+${t.length}` } },
});
const minor = (version: number, type: number, toVer: number, extra: Dict = {}) => ({
  version,
  type,
  edit_time: version,
  editor_ids: ['7000000000000000001'],
  page_info: { from_ver: 1, to_ver: toVer, ...extra },
  name: '',
});
const USERS = { '7000000000000000001': { display_name: { value: '同事甲' }, cn_name: '甲' } };

/** Two pages of history (cursor "B" for the second), a document per page version, and a revert task. */
function fakeHistory(revertStatuses: Dict[] = []) {
  const calls: { method: string; path: string; o: WebRequest }[] = [];
  const web = {
    json: async (method: string, path: string, o: WebRequest = {}) => {
      calls.push({ method, path, o });
      const q = (o.query ?? {}) as Dict;
      if (path.endsWith('page/list/'))
        return q.cursor === 'B'
          ? {
              code: 0,
              data: {
                user: USERS,
                has_more: false,
                major_history: [{ minor_history: [minor(1024, 1, 1)] }],
              },
            }
          : {
              code: 0,
              data: {
                user: USERS,
                has_more: true,
                next_cursor: 'B',
                major_history: [
                  { minor_history: [minor(3072, 3, 4, { revert_info: { time: 1024 } })] },
                  { minor_history: [minor(2048, 2, 3)] },
                ],
              },
            };
      if (path.endsWith('client_vars'))
        return {
          code: 0,
          data: {
            block_sequence: ['D'],
            block_map: {
              D: { data: { type: 'page', text: text('标题'), children: ['a'] } },
              a: { data: { type: 'text', text: text(`第 ${String(q.version)} 版`) } },
            },
          },
        };
      if (path.endsWith('page/revert/'))
        return { code: 0, data: { task_id: 'T1', query_duration: 20 } };
      return { code: 0, data: revertStatuses.shift() ?? { status: 0 } };
    },
  } as unknown as WebSession;
  return { history: new DocHistory(web), calls };
}

describe('文档历史记录', () => {
  test('列表：按 next_cursor 翻页，把各组里的记录摊平，编辑者取名字，还原记录带还原到的时间', async () => {
    const { history } = fakeHistory();
    expect(await history.list('D')).toEqual([
      {
        version: 3072,
        kind: 'restored',
        time: 3072,
        editors: ['同事甲'],
        pageVersion: 4,
        restoredFrom: 1024,
        name: '',
      },
      { version: 2048, kind: 'edited', time: 2048, editors: ['同事甲'], pageVersion: 3, name: '' },
      { version: 1024, kind: 'created', time: 1024, editors: ['同事甲'], pageVersion: 1, name: '' },
    ]);
    expect((await history.list('D', 1)).map((v) => v.version)).toEqual([3072]);
  });

  test('读某条记录时的内容：按这条记录的页面版本取文档', async () => {
    const { history } = fakeHistory();
    expect(await history.markdown('D', 2048)).toBe('# 标题\n\n第 3 版\n');
  });

  test('还原：提交后轮询到完成为止；部分完成和失败都报错；没有这条记录时什么都不提交', async () => {
    const done = fakeHistory([{ status: 0 }, { status: 1 }]);
    await done.history.revert('D', 2048);
    const posted = done.calls.find((c) => c.path.endsWith('page/revert/'));
    expect(posted?.o.json).toEqual({ page_id: 'D', minor_version: 2048 });
    expect(done.calls.filter((c) => c.path.endsWith('revert_status/'))).toHaveLength(2);

    const partial = fakeHistory([
      { status: 2, block_status: { D: { status: 1 }, x: { status: 2 } } },
    ]);
    await expect(partial.history.revert('D', 2048)).rejects.toThrow('一部分');
    const failed = fakeHistory([{ status: 2, block_status: { D: { status: 2 } } }]);
    await expect(failed.history.revert('D', 2048)).rejects.toThrow('还原历史记录失败');

    const missing = fakeHistory();
    await expect(missing.history.revert('D', 99)).rejects.toThrow('没有这条历史记录');
    expect(missing.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
