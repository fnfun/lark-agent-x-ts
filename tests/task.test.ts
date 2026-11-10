import { describe, expect, spyOn, test } from 'bun:test';
import { fromBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient } from '../src/client.js';
import { Tasks, toTask } from '../src/domains/task.js';
import { PermissionDenied } from '../src/permissions.js';
import { type Dict, toDict } from '../src/proto/dict.js';
import { larkType } from '../src/proto/registry.js';
import { newClient, strictRequest } from './helpers.js';

const G = '00000000-0000-4000-8000-000000000001';

/** Records gateway requests (strictly encoded against the protocol) and answers per type. */
function recorder(reply: (type: string, data: Dict) => Dict = () => ({})) {
  const c = newClient();
  const calls: [string, Dict][] = [];
  c.api = async (type, data) => {
    strictRequest(String(type), data as Dict);
    calls.push([String(type), data as Dict]);
    return reply(String(type), data as Dict);
  };
  return { c, t: new Tasks(c), calls };
}

/** Decodes a commit value (base64 of a Commit.DataType* message). */
const value = (type: string, b64: unknown) =>
  toDict(larkType(type), fromBinary(larkType(type), Buffer.from(String(b64), 'base64')));

describe('任务', () => {
  test('截止时间按秒存，换成毫秒；没完成的完成时间为 null', () => {
    const t = toTask({
      guid: G,
      summary: '周报',
      dueTime: 1_796_119_200n,
      completedMilliTime: 0n,
      assignees: [{ assigneeId: '7100000000000000001' }],
      relatedTaskListGuids: ['L1'],
    });
    expect([t.due, t.completedAt, t.title, t.assigneeIds, t.listGuids]).toEqual([
      1_796_119_200_000,
      null,
      '周报',
      ['7100000000000000001'],
      ['L1'],
    ]);
  });

  test('修改：每个字段一个 commit，截止时间按秒提交，负责人带 USER 类型', async () => {
    const { t, calls } = recorder();
    await t.update(G, {
      title: '新标题',
      due: 1_796_119_200_000,
      assigneeIds: ['7100000000000000001'],
    });
    const [type, req] = calls[0] as [string, Dict];
    expect(type).toBe('todo.UpdateTaskByCommitsRequest');
    const commits = req.commits as Dict[];
    expect(commits.map((x) => [x.key, x.dataType])).toEqual([
      [17, 5],
      [34, 9],
      [5, 6],
    ]);
    expect(value('todo_entities.Commit.DataTypeStartAndDueTime', commits[1]?.added)).toMatchObject({
      dueTime: 1_796_119_200n,
    });
    const vec = value('todo_entities.Commit.DataTypeVec', commits[2]?.added).values as Uint8Array[];
    expect(
      toDict(
        larkType('todo_entities.TodoAssignee'),
        fromBinary(larkType('todo_entities.TodoAssignee'), vec[0] as Uint8Array),
      ),
    ).toEqual({ assigneeId: '7100000000000000001', type: 1 });
  });

  test('清除截止时间：把当前值放进 deleted、不带 added（0 会被服务端忽略）', async () => {
    const { t, calls } = recorder((type) =>
      type === 'todo.MGetTodoByGuidRequest'
        ? { uuidToResult: { todo: { guidToTodo: { [G]: { guid: G, dueTime: 1_796_119_200n } } } } }
        : {},
    );
    await t.update(G, { due: null });
    const last = calls.at(-1) as [string, Dict];
    const commit = (last[1].commits as Dict[])[0] as Dict;
    expect(commit.added).toBeUndefined();
    expect(value('todo_entities.Commit.DataTypeStartAndDueTime', commit.deleted)).toMatchObject({
      dueTime: 1_796_119_200n,
    });
  });

  test('我的任务：先取根清单再拉其下的任务；按状态过滤，新的在前', async () => {
    const todo = (guid: string, created: bigint, done: bigint) => ({
      category: 1,
      todo: { guid, summary: guid, createMilliTime: created, completedMilliTime: done },
    });
    const { t, calls } = recorder((_type, data) =>
      data.params
        ? { items: [todo('a', 1n, 0n), todo('b', 3n, 9n), todo('c', 2n, 0n)] }
        : { items: [{ category: 2, todoList: { guid: 'root' } }] },
    );
    expect((await t.list()).map((x) => x.guid)).toEqual(['c', 'a']);
    expect((await t.list({ status: 'done' })).map((x) => x.guid)).toEqual(['b']);
    expect((await t.list({ status: 'all' })).map((x) => x.guid)).toEqual(['b', 'c', 'a']);
    const pull = calls[1] as [string, Dict];
    expect((pull[1].params as Dict[])[0]?.parentItemGuid).toBe('root');
  });

  test('任务清单：服务端连已删除的也返回，这里滤掉', async () => {
    const { t } = recorder(() => ({
      items: [
        { container: { guid: 'L1', name: '周会', deleteMilliTime: 0n } },
        { container: { guid: 'L2', name: '旧清单', deleteMilliTime: 5n } },
      ],
    }));
    expect((await t.lists()).map((l) => l.guid)).toEqual(['L1']);
  });

  test('权限：方法按 task.<动作> 检查，内部的网关调用不再按 api 检查', async () => {
    const api = spyOn(LarkClient.prototype, 'api').mockImplementation(async () => ({}));
    try {
      const auth = {
        userId: 'me',
        appKey: 'a',
        requireValid: async () => {},
      } as unknown as LarkAuth;
      const c = await LarkClient.create(auth, {
        permissions: { allow: ['query'], deny: ['*'] },
      });
      const t = new Tasks(c);
      expect(await t.list()).toEqual([]);
      const e = await t.delete([G]).catch((x) => x);
      expect(e).toBeInstanceOf(PermissionDenied);
      expect(e).toMatchObject({ permission: 'task.delete', group: 'destroy' });
    } finally {
      api.mockRestore();
    }
  });
});
