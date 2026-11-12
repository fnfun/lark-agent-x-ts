import { describe, expect, spyOn, test } from 'bun:test';
import { fromBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient } from '../src/client.js';
import { Docs } from '../src/domains/docs.js';
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

  test('我的任务：先取根清单再拉其下的任务；按状态过滤，新的在前，已删除的不列', async () => {
    const todo = (guid: string, created: bigint, done: bigint) => ({
      category: 1,
      todo: { guid, summary: guid, createMilliTime: created, completedMilliTime: done },
    });
    // A deleted task comes back emptied except for its deletion time
    const gone = { category: 1, todo: { guid: 'd', deletedMilliTime: 1_794_289_499n } };
    const { t, calls } = recorder((_type, data) =>
      data.params
        ? { items: [todo('a', 1n, 0n), todo('b', 3n, 9n), gone, todo('c', 2n, 0n)] }
        : { items: [{ category: 2, todoList: { guid: 'root' } }] },
    );
    expect((await t.list()).map((x) => x.guid)).toEqual(['c', 'a']);
    expect((await t.list({ status: 'done' })).map((x) => x.guid)).toEqual(['b']);
    expect((await t.list({ status: 'all' })).map((x) => x.guid)).toEqual(['b', 'c', 'a']);
    const pull = calls[1] as [string, Dict];
    expect((pull[1].params as Dict[])[0]?.parentItemGuid).toBe('root');
  });

  test('按 guid 取任务：已删除的当作找不到', async () => {
    const { t } = recorder(() => ({
      uuidToResult: {
        todo: {
          guidToTodo: {
            a: { guid: 'a', summary: '周报' },
            d: { guid: 'd', deletedMilliTime: 5n },
          },
        },
      },
    }));
    expect((await t.get(['a', 'd'])).map((x) => x.guid)).toEqual(['a']);
  });

  test('清单里的任务：按分组与清单里的顺序，带分组名；按状态过滤；要异步加载的大清单报错', async () => {
    const section = (name: string) => ({
      group: { fieldKey: '__field_task_section' },
      resource: { type: 1, section: { guid: `s-${name}`, name } },
    });
    const sections = [
      { guid: 's-', name: '', isDefault: true },
      { guid: 's-本周', name: '本周' },
    ];
    let meta: Dict = { container: { guid: 'L1' }, sections };
    const { t } = recorder((type, data) => {
      if (type === 'todo.GetContainerMetaDataAndGroupInfoRequest')
        return {
          containerMetaData: meta,
          containerGroupInfo: {
            groupDataList: meta.asyncLoad
              ? []
              : [
                  { groupInfos: [section('')], taskSortedInfos: [{ guid: 'b' }, { guid: 'a' }] },
                  { groupInfos: [section('本周')], taskSortedInfos: [{ guid: 'c' }] },
                ],
          },
        };
      const todos: Record<string, Dict> = {
        a: { guid: 'a', summary: 'A' },
        b: { guid: 'b', summary: 'B', completedMilliTime: 9n },
        c: { guid: 'c', summary: 'C' },
      };
      const guids = data.guids as string[];
      return {
        uuidToResult: {
          todo: { guidToTodo: Object.fromEntries(guids.map((g) => [g, todos[g] as Dict])) },
        },
      };
    });
    expect((await t.listTasks('L1', { status: 'all' })).map((x) => [x.guid, x.section])).toEqual([
      ['b', ''],
      ['a', ''],
      ['c', '本周'],
    ]);
    expect((await t.listTasks('L1')).map((x) => x.guid)).toEqual(['a', 'c']);
    meta = { container: { guid: 'L1' }, sections, asyncLoad: true };
    await expect(t.listTasks('L1')).rejects.toThrow('异步加载');
  });

  test('清单与分组：放进清单要带分组（默认分组）；已在清单里的改到目标分组、带旧引用；移出是旧引用加删除时间；新分组由客户端给 guid', async () => {
    const meta = {
      container: { guid: 'L1' },
      sections: [
        { guid: 's-old', name: '旧分组', deleteMilliTime: 5n },
        { guid: 's-week', name: '本周' },
        { guid: 's-def', name: '', isDefault: true },
      ],
    };
    const groups = [
      {
        groupInfos: [{ resource: { section: { guid: 's-def' } } }],
        taskSortedInfos: [{ guid: 'in' }],
      },
      {
        groupInfos: [{ resource: { section: { guid: 's-week' } } }],
        taskSortedInfos: [{ guid: 'wk' }],
      },
    ];
    const { t, calls } = recorder((type) =>
      type === 'todo.GetContainerMetaDataAndGroupInfoRequest'
        ? { containerMetaData: meta, containerGroupInfo: { groupDataList: groups } }
        : type === 'todo.UpsertTaskSectionRequest'
          ? { section: { guid: 's-new', name: '下周' } }
          : {},
    );
    expect((await t.sections('L1')).map((x) => x.guid)).toEqual(['s-def', 's-week']);
    const refs = () =>
      calls.filter(([type]) => type === 'todo.UpdateTaskContainerRefRequest').map(([, d]) => d);

    await t.addToList('L1', ['out', 'in', 'wk']);
    expect(refs()).toEqual([
      { newTaskContainerRef: { containerGuid: 'L1', taskGuid: 'out', sectionGuid: 's-def' } },
      {
        oldTaskContainerRef: { containerGuid: 'L1', taskGuid: 'wk', sectionGuid: 's-week' },
        newTaskContainerRef: { containerGuid: 'L1', taskGuid: 'wk', sectionGuid: 's-def' },
      },
    ]);
    calls.length = 0;
    await t.removeFromList('L1', ['wk']);
    const [removal] = refs();
    expect(removal?.oldTaskContainerRef).toEqual({
      containerGuid: 'L1',
      taskGuid: 'wk',
      sectionGuid: 's-week',
    });
    const newRef = (removal?.newTaskContainerRef ?? {}) as Dict;
    expect(Number(newRef.deleteMilliTime)).toBeGreaterThan(0);
    await expect(t.removeFromList('L1', ['out'])).rejects.toThrow('out');
    await expect(t.addToList('L1', ['out'], '旧分组')).rejects.toThrow('没有这个分组');

    calls.length = 0;
    await t.addSection('L1', '下周');
    const added = (calls[0]?.[1].newSection ?? {}) as Dict;
    expect(added).toMatchObject({ name: '下周', containerId: 'L1' });
    expect(String(added.guid)).toMatch(/^[0-9a-f-]{36}$/);
    await expect(t.deleteSection('L1', 's-def')).rejects.toThrow('默认分组');
  });

  test('提醒：截止前的分钟数作为 RELATIVE 提醒整体替换；清除时只把当前提醒放进 deleted', async () => {
    const { t, calls } = recorder((type) =>
      type === 'todo.MGetTodoByGuidRequest'
        ? {
            uuidToResult: {
              todo: { guidToTodo: { [G]: { guid: G, reminders: [{ type: 2, time: 30n }] } } },
            },
          }
        : {},
    );
    expect(toTask({ guid: G, reminders: [{ type: 2, time: 30n }] }).reminders).toEqual([30]);
    await t.update(G, { reminder: 15 });
    const set = ((calls.at(-1) as [string, Dict])[1].commits as Dict[])[0] as Dict;
    expect([set.key, set.dataType, set.deleted]).toEqual([6, 8, undefined]);
    expect(value('todo_entities.Commit.DataTypeReminder', set.added).reminders).toEqual([
      { type: 2, time: 15n },
    ]);
    await t.update(G, { reminder: null });
    const clear = ((calls.at(-1) as [string, Dict])[1].commits as Dict[])[0] as Dict;
    expect(clear.added).toBeUndefined();
    expect(value('todo_entities.Commit.DataTypeReminder', clear.deleted).reminders).toEqual([
      { type: 2, time: 30n },
    ]);
  });

  test('附件：新文件传到 task 挂载点后只放进 added（各带 guid）；移除只把那一项原样放进 deleted', async () => {
    const existing = {
      guid: 'g-old',
      fileToken: 'tok-old',
      name: '旧.txt',
      fileSize: '3',
      type: 2,
    };
    const { t, calls } = recorder((type) =>
      type === 'todo.MGetTodoByGuidRequest'
        ? { uuidToResult: { todo: { guidToTodo: { [G]: { guid: G, attachments: [existing] } } } } }
        : { task: { guid: G } },
    );
    // Uploading opens a web session, which needs the account's region (no request is made)
    Object.assign(t.client.auth, { region: { name: 'feishu', domain: 'example.invalid' } });
    const mounts: unknown[] = [];
    const upload = spyOn(Docs.prototype, 'upload').mockImplementation(async (_d, name, o) => {
      mounts.push(o?.mount);
      return { objToken: `tok-${name}` } as Awaited<ReturnType<Docs['upload']>>;
    });
    try {
      await t.attach(G, [{ name: '新.txt', data: new Uint8Array(4) }]);
    } finally {
      upload.mockRestore();
    }
    expect(mounts).toEqual([{ point: 'task', node: G }]);
    const entries = (b64: unknown) =>
      (value('todo_entities.Commit.DataTypeVec', b64).values as Uint8Array[]).map((v) =>
        toDict(
          larkType('todo_entities.TodoAttachment'),
          fromBinary(larkType('todo_entities.TodoAttachment'), v),
        ),
      );
    const add = ((calls.at(-1) as [string, Dict])[1].commits as Dict[])[0] as Dict;
    expect([add.key, add.dataType, add.deleted]).toEqual([33, 6, undefined]);
    const [added] = entries(add.added);
    expect(added).toMatchObject({
      fileToken: 'tok-新.txt',
      name: '新.txt',
      fileSize: '4',
      type: 2,
    });
    expect(String(added?.guid)).toMatch(/^[0-9a-f-]{36}$/);

    await t.detach(G, ['tok-old']);
    const del = ((calls.at(-1) as [string, Dict])[1].commits as Dict[])[0] as Dict;
    expect(del.added).toBeUndefined();
    expect(entries(del.deleted)).toEqual([existing]);
    await expect(t.detach(G, ['tok-x'])).rejects.toThrow('tok-x');
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
