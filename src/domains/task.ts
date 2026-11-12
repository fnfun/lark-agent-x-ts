/**
 * Tasks (Lark / Feishu Tasks) over the gateway's legacy `todo.*` requests, the ones the web client
 * uses; most `todo.v1.*` cmds answer "command not found" on the gateway. Tested on a real account
 * on 2026-11-10 with tasks and lists created for the test and deleted afterwards:
 *
 * - My tasks come from the sync API (`todo.PullSyncTodoItemsRequest`): the root reply names my
 *   task list, and pulling under it returns the tasks, done ones included.
 * - Creating takes no client guid (a client-generated one fails with error 120020).
 * - Edits go through `todo.UpdateTaskByCommitsRequest`, one commit per field, each value encoded
 *   as the matching `Commit.DataType*` message; `UpdateTodoRequest` rejects tasks created here
 *   ("source TODO is not allowed"), and the plain summary / due-time keys are not supported.
 * - Reopening is `UpdateTodoCompleteStatusRequest` without an operation type (INCOMPLETE fails).
 * - A task's due time is in seconds (`dueTime`), though creating takes `dueMilliTime` in ms.
 * - Task lists come from `todo.PullPagingManagerTaskContainersRequest`, which also returns
 *   deleted lists (filtered out here).
 * - Reminders are relative to the due time, in minutes (`TodoReminder.time` with type RELATIVE;
 *   the account setting `dueReminderOffset` defaults to 30, and the OpenAPI calls the same value
 *   `relative_fire_minute`). Creating with more than one answers error 121005 (the web app sets one),
 *   so one is set here. Their commit replaces the whole list; clearing sends only `deleted`.
 * - Attachments are Drive files uploaded to mount point `task` on the task's guid. Their commit
 *   adds the `added` entries and removes the `deleted` ones, matched by each entry's guid (entries
 *   sent without one end up as copies of one another).
 * - The tasks in a list (2026-11-13, both accounts) come from
 *   `todo.GetContainerMetaDataAndGroupInfoRequest`: every task's guid by section, in the list's
 *   order and done ones included, with the details read by guid. Very large lists are meant to be
 *   loaded asynchronously instead (`asyncLoad`; `QueryContainerTasksRequest` reports the query
 *   done, but `LoadContainerTasksRequest` answered an empty payload), which is reported as an error.
 */
import { create, fromJson, type JsonValue, toBinary } from '@bufbuild/protobuf';
import type { LarkClient } from '../client.js';
import { authorize, guardMethods, type Permission } from '../permissions.js';
import { extractRichText } from '../proto/decoders.js';
import { type Dict, fromDict } from '../proto/dict.js';
import { larkType, protoType } from '../proto/registry.js';
import { WebSession } from '../web.js';
import { Docs } from './docs.js';

export interface Task {
  guid: string;
  title: string;
  description: string;
  /** Due time (ms); null when there is none. */
  due: number | null;
  allDay: boolean;
  /** Completion time (ms); null while open. */
  completedAt: number | null;
  creatorId: string;
  assigneeIds: string[];
  followerIds: string[];
  /** Parent task of a subtask; empty otherwise. */
  parentGuid: string;
  /** Task lists the task is in. */
  listGuids: string[];
  createdAt: number;
  commentCount: number;
  /** Reminders, in minutes before the due time. */
  reminders: number[];
  attachments: TaskAttachment[];
}

/** A file attached to a task; it downloads as a Drive file by its token (`lark doc download`). */
export interface TaskAttachment {
  token: string;
  name: string;
  size: number;
  uploaderId: string;
  uploadedAt: number;
}

/** A task as listed in a task list: with the name of its section ('' for the default one). */
export type ListedTask = Task & { section: string };

export interface TaskComment {
  id: string;
  authorId: string;
  content: string;
  createdAt: number;
}

export interface TaskList {
  guid: string;
  name: string;
  ownerId: string;
  createdAt: number;
}

export interface NewTask {
  title: string;
  description?: string | undefined;
  /** Due time (ms). */
  due?: number | undefined;
  allDay?: boolean | undefined;
  assigneeIds?: string[] | undefined;
  followerIds?: string[] | undefined;
  /** Create as a subtask of this task. */
  parentGuid?: string | undefined;
  /** Put the task in this task list. */
  listGuid?: string | undefined;
  /** Reminder, in minutes before the due time (needs a due time). */
  reminder?: number | undefined;
}

/** Fields to change; assigneeIds / followerIds replace the whole list. */
export interface TaskUpdate {
  title?: string | undefined;
  description?: string | undefined;
  /** Due time (ms), or null to clear it. */
  due?: number | null | undefined;
  allDay?: boolean | undefined;
  assigneeIds?: string[] | undefined;
  followerIds?: string[] | undefined;
  /** Reminder in minutes before the due time, replacing the current ones; null clears them. */
  reminder?: number | null | undefined;
}

// todo_entities: TodoSource.TODO, TodoItemMemberType.USER, TaskContainer.Category.TASK_LIST
const SOURCE_TODO = 1;
const MEMBER_USER = 1;
const CATEGORY_TASK_LIST = 4;
// todo_entities.Commit: ObjType.TODO, Platform.WEB, OwnerType.USER, Key and DataType values
const OBJ_TODO = 1;
const PLATFORM_WEB = 6;
const OWNER_USER = 1;
const KEY = {
  assignees: 5,
  richSummary: 17,
  richDescription: 18,
  reminders: 6,
  followers: 20,
  attachments: 33,
  due: 34,
};
const DATA = { bytes: 5, vec: 6, reminder: 8, startAndDue: 9 };
// todo_entities.TodoReminder.Type.RELATIVE
const REMINDER_RELATIVE = 2;
// MGetTodoByGuidRequest.Param: Type.Todo, Field.ALL
// todo_entities.TodoAttachment.Type.FILE
const ATTACHMENT_FILE = 2;
const PARAM_TODO = 1;
const FIELD_ALL = 1;
// Tasks read by guid per request when listing a task list
const GET_BATCH = 100;

/** Permission item of each Tasks method (`task.<action>`). */
const TASK_PERMISSIONS: { [K in keyof Tasks]?: Permission } = {
  list: 'task.list',
  search: 'task.search',
  get: 'task.get',
  subtasks: 'task.get',
  listTasks: 'task.list',
  comments: 'task.comments',
  lists: 'task.lists',
  create: 'task.create',
  comment: 'task.comment',
  update: 'task.update',
  attach: 'task.update',
  detach: 'task.update',
  complete: 'task.complete',
  reopen: 'task.complete',
  delete: 'task.delete',
  createList: 'task.list-create',
  deleteList: 'task.list-delete',
};

const int = (v: unknown) => (v === undefined || v === null ? 0 : Number(v as number | bigint));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Plain text as todo_entities.RichContent in its JSON form (bytes as base64). */
export function richContent(text: string): Dict {
  const prop = toBinary(
    protoType('TextProperty'),
    create(protoType('TextProperty'), { content: text }),
  );
  return {
    richText: {
      elementIds: ['1'],
      innerText: text,
      elements: { dictionary: { '1': { tag: 1, property: b64(prop) } } },
    },
  };
}

/** A lark message encoded from its JSON form, as base64 (commit values are serialized messages). */
/** Deleted tasks still come back from sync and by guid, emptied except for the deletion time. */
const deleted = (t: Dict) => int(t.deletedMilliTime) > 0;

const reminderList = (minutes: number[]) =>
  minutes.map((m) => ({ type: REMINDER_RELATIVE, time: String(m) }));

const encode = (type: string, json: Dict) =>
  b64(toBinary(larkType(type), fromJson(larkType(type), json as JsonValue)));

const textOf = (rich: unknown, plain: unknown): string => {
  const rt = (rich as Dict | undefined)?.richText as Dict | undefined;
  return rt ? extractRichText(rt) : String(plain ?? '');
};

export function toTask(t: Dict): Task {
  // dueTime is in seconds
  const due = int(t.dueTime) * 1000;
  const done = int(t.completedMilliTime);
  return {
    guid: String(t.guid),
    title: textOf(t.richSummary, t.summary),
    description: textOf(t.richDescription, t.description),
    due: due > 0 ? due : null,
    allDay: t.isAllDay === true,
    completedAt: done > 0 ? done : null,
    creatorId: String(t.creatorId ?? ''),
    assigneeIds: ((t.assignees ?? []) as Dict[]).map((a) => String(a.assigneeId)),
    followerIds: ((t.followers ?? []) as Dict[]).map((f) => String(f.followerId)),
    parentGuid: String(t.ancestorGuid ?? ''),
    listGuids: ((t.relatedTaskListGuids ?? []) as unknown[]).map(String),
    createdAt: int(t.createMilliTime),
    commentCount: int(t.commentCount),
    reminders: ((t.reminders ?? []) as Dict[])
      .filter((r) => int(r.type) === REMINDER_RELATIVE)
      .map((r) => int(r.time)),
    attachments: ((t.attachments ?? []) as Dict[]).map((a) => ({
      token: String(a.fileToken ?? ''),
      name: String(a.name ?? ''),
      size: int(a.fileSize),
      uploaderId: String(a.uploaderUserId ?? ''),
      uploadedAt: int(a.uploadMilliTime),
    })),
  };
}

/**
 * Tasks of the logged-in account. Permission checks follow the client's: with
 * `LarkClient.create(auth, { permissions })`, each method is checked as `task.<action>`.
 */
export class Tasks {
  constructor(readonly client: LarkClient) {
    const source = client.permissionSource;
    if (source) guardMethods(this, TASK_PERMISSIONS, (p) => authorize(client.auth, source, p));
  }

  /** My tasks, open ones by default; newest first. */
  async list(o: { status?: 'open' | 'done' | 'all' } = {}): Promise<Task[]> {
    const root = await this.client.api('todo.PullSyncTodoItemsRequest', {});
    const listGuid = String(
      (((root.items ?? []) as Dict[]).find((i) => i.todoList)?.todoList as Dict | undefined)
        ?.guid ?? '',
    );
    if (!listGuid) return [];
    const resp = await this.client.api('todo.PullSyncTodoItemsRequest', {
      params: [{ parentItemGuid: listGuid, includeCompleted: true }],
    });
    const status = o.status ?? 'open';
    return ((resp.items ?? []) as Dict[])
      .filter((i) => i.todo && !deleted(i.todo as Dict))
      .map((i) => toTask(i.todo as Dict))
      .filter((t) => status === 'all' || (status === 'done') === (t.completedAt !== null))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Tasks in a task list, in the list's order (by section); open ones by default, like list. Only
   * lists the server returns in one piece: one it wants loaded asynchronously throws.
   */
  async listTasks(
    listGuid: string,
    o: { status?: 'open' | 'done' | 'all' } = {},
  ): Promise<ListedTask[]> {
    const resp = await this.client.api('todo.GetContainerMetaDataAndGroupInfoRequest', {
      containerGuid: listGuid,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const meta = (resp.containerMetaData ?? {}) as Dict;
    if (!meta.container) throw new Error(`找不到任务清单: ${listGuid}`);
    const groups = ((resp.containerGroupInfo as Dict | undefined)?.groupDataList ?? []) as Dict[];
    if (meta.asyncLoad && !groups.length)
      throw new Error('这个清单的任务太多,服务端要求异步加载,暂不支持列出');
    const sectionOf = new Map<string, string>();
    for (const g of groups) {
      const section = ((g.groupInfos as Dict[] | undefined) ?? [])
        .map((i) => (i.resource as Dict | undefined)?.section as Dict | undefined)
        .find(Boolean);
      for (const t of (g.taskSortedInfos ?? []) as Dict[])
        sectionOf.set(String(t.guid), String(section?.name ?? ''));
    }
    const guids = [...sectionOf.keys()];
    const found: Task[] = [];
    for (let i = 0; i < guids.length; i += GET_BATCH)
      found.push(...(await this.get(guids.slice(i, i + GET_BATCH))));
    const status = o.status ?? 'open';
    return found
      .filter((t) => status === 'all' || (status === 'done') === (t.completedAt !== null))
      .map((t) => ({ ...t, section: sectionOf.get(t.guid) ?? '' }));
  }

  /** Tasks I can read whose title matches query. */
  async search(query: string, limit = 20): Promise<Task[]> {
    const resp = await this.client.api('todo.SearchTaskRequest', { query, count: limit });
    return ((resp.todos ?? []) as Dict[]).map(toTask);
  }

  /** Tasks by guid (all fields, including the lists each is in); missing guids are left out. */
  async get(guids: string[]): Promise<Task[]> {
    if (!guids.length) return [];
    const resp = await this.client.api('todo.MGetTodoByGuidRequest', {
      guids,
      uuidToParams: { todo: { type: PARAM_TODO, fields: [FIELD_ALL] } },
    });
    const found = (((resp.uuidToResult ?? {}) as Record<string, Dict>).todo?.guidToTodo ??
      {}) as Record<string, Dict>;
    return guids.flatMap((g) => {
      const t = found[g];
      return t && !deleted(t) ? [toTask(t)] : [];
    });
  }

  async subtasks(guid: string, limit = 100): Promise<Task[]> {
    const resp = await this.client.api('todo.GetPagingSubTaskRequest', { guid, count: limit });
    return ((resp.subTasks ?? []) as Dict[]).map(toTask);
  }

  async create(t: NewTask): Promise<Task> {
    const members = (ids: string[] | undefined) =>
      (ids ?? []).map((memberId) => ({ memberId, type: MEMBER_USER }));
    const resp = await this.client.api('todo.CreateTaskRequest', {
      tasks: [
        {
          richSummary: richContent(t.title),
          ...(t.description ? { richDescription: richContent(t.description) } : {}),
          ...(t.due !== undefined
            ? { dueMilliTime: String(t.due), isAllDay: t.allDay === true }
            : {}),
          assignees: members(t.assigneeIds),
          followers: members(t.followerIds),
          ...(t.parentGuid ? { ancestorGuid: t.parentGuid } : {}),
          ...(t.listGuid ? { taskListContainerRefs: [{ containerGuid: t.listGuid }] } : {}),
          ...(t.reminder !== undefined ? { reminders: reminderList([t.reminder]) } : {}),
          source: SOURCE_TODO,
        },
      ],
    });
    const task = ((resp.tasks ?? []) as Dict[])[0];
    if (!resp.success || !task) {
      const codes = ((resp.failReasons ?? []) as Dict[]).map((r) => r.errorCode).join(', ');
      throw new Error(`建任务失败${codes ? `(错误码 ${codes})` : ''}`);
    }
    return toTask(task);
  }

  /** Changes the given fields; one commit per field, sent together. */
  async update(guid: string, u: TaskUpdate): Promise<void> {
    const commit = (key: number, dataType: number, added: string, deleted?: string) =>
      this.commit(guid, key, dataType, added, deleted);
    const vec = (type: string, idField: string, ids: string[]) =>
      encode('todo_entities.Commit.DataTypeVec', {
        values: ids.map((id) => encode(type, { [idField]: id, type: MEMBER_USER })),
      });
    const commits: Dict[] = [];
    if (u.title !== undefined)
      commits.push(
        commit(
          KEY.richSummary,
          DATA.bytes,
          encode('todo_entities.RichContent', richContent(u.title)),
        ),
      );
    if (u.description !== undefined)
      commits.push(
        commit(
          KEY.richDescription,
          DATA.bytes,
          encode('todo_entities.RichContent', richContent(u.description)),
        ),
      );
    const dueValue = (ms: number, allDay: boolean) =>
      encode('todo_entities.Commit.DataTypeStartAndDueTime', {
        startTime: '0',
        dueTime: String(Math.floor(ms / 1000)),
        isAllDay: allDay,
      });
    if (u.due === null) {
      // A due time of 0 is ignored; clearing removes the current value instead
      const [current] = await this.get([guid]);
      if (current?.due)
        commits.push(commit(KEY.due, DATA.startAndDue, '', dueValue(current.due, current.allDay)));
    } else if (u.due !== undefined)
      commits.push(commit(KEY.due, DATA.startAndDue, dueValue(u.due, u.allDay === true)));
    if (u.reminder !== undefined) {
      const value = (minutes: number[], allDay: boolean) =>
        encode('todo_entities.Commit.DataTypeReminder', {
          reminders: reminderList(minutes),
          isAllDay: allDay,
        });
      if (u.reminder !== null)
        commits.push(commit(KEY.reminders, DATA.reminder, value([u.reminder], false)));
      else {
        const [current] = await this.get([guid]);
        if (current?.reminders.length)
          commits.push(
            commit(KEY.reminders, DATA.reminder, '', value(current.reminders, current.allDay)),
          );
      }
    }
    if (u.assigneeIds !== undefined)
      commits.push(
        commit(
          KEY.assignees,
          DATA.vec,
          vec('todo_entities.TodoAssignee', 'assigneeId', u.assigneeIds),
        ),
      );
    if (u.followerIds !== undefined)
      commits.push(
        commit(
          KEY.followers,
          DATA.vec,
          vec('todo_entities.TodoFollower', 'followerId', u.followerIds),
        ),
      );
    if (!commits.length) return;
    await this.client.api('todo.UpdateTaskByCommitsRequest', { taskGuid: guid, commits });
  }

  /**
   * Upload files and attach them to a task, after the ones it has (uploaded to Drive mount point
   * `task` on the task's guid); returns the task's attachments.
   */
  async attach(
    guid: string,
    files: { name: string; data: Uint8Array }[],
  ): Promise<TaskAttachment[]> {
    const docs = new Docs(new WebSession(this.client.auth));
    const added: Dict[] = [];
    for (const f of files) {
      const up = await docs.upload(f.data, f.name, { mount: { point: 'task', node: guid } });
      added.push({
        guid: crypto.randomUUID(),
        fileToken: up.objToken,
        fileSize: String(f.data.length),
        name: f.name,
        type: ATTACHMENT_FILE,
      });
    }
    return this.changeAttachments(guid, added, []);
  }

  /** Remove attachments from a task by token; returns the ones left. */
  async detach(guid: string, tokens: string[]): Promise<TaskAttachment[]> {
    const resp = await this.client.api('todo.MGetTodoByGuidRequest', {
      guids: [guid],
      uuidToParams: { todo: { type: PARAM_TODO, fields: [FIELD_ALL] } },
    });
    const t = (
      ((resp.uuidToResult ?? {}) as Record<string, Dict>).todo?.guidToTodo as
        | Record<string, Dict>
        | undefined
    )?.[guid];
    if (!t) throw new Error(`找不到任务: ${guid}`);
    // Sent back as the server returned them: it matches removals by their guid
    const current = (t.attachments ?? []) as Dict[];
    const missing = tokens.filter((x) => !current.some((a) => a.fileToken === x));
    if (missing.length) throw new Error(`任务里没有这些附件: ${missing.join(', ')}`);
    return this.changeAttachments(
      guid,
      [],
      current.filter((a) => tokens.includes(String(a.fileToken))),
    );
  }

  /**
   * One attachments commit: the server adds the `added` entries and removes the `deleted` ones,
   * both matched by the attachment's guid (the list is not replaced as a whole).
   */
  private async changeAttachments(
    guid: string,
    added: Dict[],
    deleted: Dict[],
  ): Promise<TaskAttachment[]> {
    const type = larkType('todo_entities.TodoAttachment');
    const vec = (list: Dict[]) =>
      list.length
        ? encode('todo_entities.Commit.DataTypeVec', {
            values: list.map((a) => b64(toBinary(type, fromDict(type, a)))),
          })
        : '';
    const resp = await this.client.api('todo.UpdateTaskByCommitsRequest', {
      taskGuid: guid,
      commits: [this.commit(guid, KEY.attachments, DATA.vec, vec(added), vec(deleted))],
    });
    return toTask((resp.task ?? {}) as Dict).attachments;
  }

  /** A field change: added is the new value, deleted the old one (clearing sends only that). */
  private commit(guid: string, key: number, dataType: number, added: string, deleted?: string) {
    return {
      guid: crypto.randomUUID(),
      objType: OBJ_TODO,
      objGuid: guid,
      key,
      dataType,
      ...(added ? { added } : {}),
      ...(deleted ? { deleted } : {}),
      clientMilliTime: String(Date.now()),
      platform: PLATFORM_WEB,
      ownerType: OWNER_USER,
      ownerId: this.client.auth.userId,
      source: SOURCE_TODO,
    };
  }

  async complete(guid: string): Promise<void> {
    // TodoOperationType.COMPLETE
    await this.client.api('todo.UpdateTodoCompleteStatusRequest', {
      todoGuid: guid,
      isCompleted: true,
      todoOperationType: 3,
    });
  }

  async reopen(guid: string): Promise<void> {
    await this.client.api('todo.UpdateTodoCompleteStatusRequest', {
      todoGuid: guid,
      isCompleted: false,
    });
  }

  /** Delete tasks (they go away for everyone involved). */
  async delete(guids: string[]): Promise<void> {
    await this.client.api('todo.DeleteTodosRequest', { todoGuids: guids });
  }

  async comment(guid: string, text: string): Promise<void> {
    await this.client.api('todo_comments.CreateCommentRequest', {
      todoGuid: guid,
      // TodoComment.Type.RICH_TEXT
      comment: { richContent: richContent(text), type: 1, cid: crypto.randomUUID() },
    });
  }

  /** Comments on a task, oldest first. */
  async comments(guid: string, limit = 100): Promise<TaskComment[]> {
    // ListCommentsRequest.Direction.DOWN
    const resp = await this.client.api('todo_comments.ListCommentsRequest', {
      todoGuid: guid,
      count: limit,
      direction: 1,
    });
    return ((resp.comments ?? []) as Dict[])
      .filter((c) => int(c.status) !== 3)
      .map((c) => ({
        id: String(c.id),
        authorId: String(c.fromId ?? ''),
        content: textOf(c.richContent, ''),
        createdAt: int(c.createMilliTime),
      }));
  }

  /** Task lists I own or have joined (deleted ones left out). */
  async lists(limit = 200): Promise<TaskList[]> {
    const resp = await this.client.api('todo.PullPagingManagerTaskContainersRequest', {
      pageParam: { pageCount: Math.min(limit, 200) },
    });
    return ((resp.items ?? []) as Dict[])
      .map((i) => i.container as Dict | undefined)
      .filter((x): x is Dict => Boolean(x) && !int(x?.deleteMilliTime))
      .map((x) => ({
        guid: String(x.guid),
        name: String(x.name ?? ''),
        ownerId: String(x.ownerId ?? ''),
        createdAt: int(x.createMilliTime),
      }));
  }

  async createList(name: string): Promise<TaskList> {
    const resp = await this.client.api('todo.UpsertTaskContainerRequest', {
      newContainer: { guid: crypto.randomUUID(), category: CATEGORY_TASK_LIST, name },
    });
    const x = ((resp.containerMetaData as Dict | undefined)?.container ?? {}) as Dict;
    if (!x.guid) throw new Error('建清单失败: 响应里没有清单 guid');
    return {
      guid: String(x.guid),
      name: String(x.name ?? name),
      ownerId: String(x.ownerId ?? ''),
      createdAt: int(x.createMilliTime),
    };
  }

  /** Delete a task list; tasks in it that nobody else owns are removed with it. */
  async deleteList(guid: string): Promise<void> {
    await this.client.api('todo.DeleteContainerRequest', {
      containerGuid: guid,
      removeNoOwnerTask: true,
    });
  }
}
