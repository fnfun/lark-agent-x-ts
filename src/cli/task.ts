import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { type Task, type TaskAttachment, Tasks } from '../domains/task.js';
import type { Option, Parsed } from './args.js';
import { type Command, type CommandGroup, client, err, list, out, s } from './common.js';
import { errorText, printJson, shortTime } from './format.js';
import { parseTimeArg } from './time.js';

const tasks = async () => new Tasks(await client());
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };

const when = (ms: number | null) => (ms ? shortTime(Math.floor(ms / 1000)) : '-');

function printTasks(list: (Task & { section?: string })[], json: boolean): void {
  if (json) {
    printJson(list);
    return;
  }
  for (const t of list)
    out(
      `${t.guid}\t${t.completedAt ? '已完成' : '进行中'}\t${t.title}\t截止 ${when(t.due)}${t.assigneeIds.length ? `\t负责人 ${t.assigneeIds.join(',')}` : ''}${t.section ? `\t分组 ${t.section}` : ''}`,
    );
}

/** --due: a time like `2026-11-20 18:00`, `3d` from now or a timestamp; `none` clears it. */
function dueArg(a: Parsed): number | null | undefined {
  if (a.due === undefined) return undefined;
  const v = String(a.due);
  return v === 'none' ? null : parseTimeArg(v, Date.now(), true);
}

/** Runs a write action and prints its error as the command's failure. */
async function attempt(label: string, f: () => Promise<number>): Promise<number> {
  try {
    return await f();
  } catch (e) {
    err(`${label}失败: ${errorText(e)}`);
    return 1;
  }
}

const EDIT_OPTIONS: Option[] = [
  { name: 'desc', kind: 'string', help: '描述' },
  {
    name: 'due',
    kind: 'string',
    help: '截止时间:2026-11-20 18:00、3d 后或时间戳(update 时 none 表示清除)',
  },
  { name: 'all-day', kind: 'flag', help: '截止时间按全天' },
  { name: 'assignees', kind: 'string', help: '负责人 user_id(逗号分隔;update 时整体替换)' },
  { name: 'followers', kind: 'string', help: '关注人 user_id(逗号分隔;update 时整体替换)' },
  {
    name: 'remind',
    kind: 'string',
    help: '截止前多少分钟提醒(如 30;update 时 none 表示清除)',
  },
];

/** --remind: minutes before the due time; `none` clears it. */
function remindArg(a: Parsed): number | null | undefined {
  if (a.remind === undefined) return undefined;
  const v = String(a.remind);
  if (v === 'none') return null;
  const minutes = Number(v);
  if (!Number.isInteger(minutes) || minutes < 0)
    throw new Error(`--remind 应为非负整数分钟或 none: ${v}`);
  return minutes;
}

const listCmd: Command = {
  name: 'list',
  help: '我的任务(默认只列进行中的,新的在前);--list 列某个清单里的任务(按清单里的顺序)',
  access: 'task.list',
  options: [
    { name: 'list', kind: 'string', help: '列这个任务清单里的任务(清单 guid)' },
    { name: 'done', kind: 'flag', help: '只列已完成的' },
    { name: 'all', kind: 'flag', help: '全部' },
    JSON_OPTION,
  ],
  async run(a) {
    const status = a.all ? 'all' : a.done ? 'done' : 'open';
    const t = await tasks();
    printTasks(
      a.list ? await t.listTasks(String(a.list), { status }) : await t.list({ status }),
      Boolean(a.json),
    );
    return 0;
  },
};

const search: Command = {
  name: 'search',
  help: '按标题搜任务',
  access: 'task.search',
  positionals: [{ name: 'query', nargs: '+' }],
  options: [{ name: 'limit', kind: 'int', default: 20 }, JSON_OPTION],
  async run(a) {
    const query = (a.query as string[]).join(' ');
    printTasks(await (await tasks()).search(query, Number(a.limit)), Boolean(a.json));
    return 0;
  },
};

const get: Command = {
  name: 'get',
  help: '任务详情(描述、截止时间、负责人、关注人、所属清单、父任务)',
  access: 'task.get',
  positionals: [{ name: 'guids', nargs: '+' }],
  options: [JSON_OPTION],
  async run(a) {
    const guids = a.guids as string[];
    const found = await (await tasks()).get(guids);
    if (a.json) printJson(found);
    else
      for (const t of found) {
        out(`${t.guid}\t${t.title}`);
        for (const [k, v] of [
          ['状态', t.completedAt ? `已完成(${when(t.completedAt)})` : '进行中'],
          ['截止', t.due ? `${when(t.due)}${t.allDay ? '(全天)' : ''}` : '-'],
          ['提醒', t.reminders.map((m) => `截止前 ${m} 分钟`).join(',') || '-'],
          ['描述', t.description || '-'],
          ['创建人', t.creatorId || '-'],
          ['负责人', t.assigneeIds.join(',') || '-'],
          ['关注人', t.followerIds.join(',') || '-'],
          ['父任务', t.parentGuid || '-'],
          ['所属清单', t.listGuids.join(',') || '-'],
          ['评论数', String(t.commentCount)],
        ])
          out(`  ${k}\t${v}`);
        for (const x of t.attachments) out(`  附件\t${attachmentLine(x)}`);
      }
    const missing = guids.filter((g) => !found.some((t) => t.guid === g));
    if (missing.length) err(`找不到任务: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
  },
};

const subtasks: Command = {
  name: 'subtasks',
  help: '列出子任务',
  access: 'task.get',
  positionals: [{ name: 'guid' }],
  options: [JSON_OPTION],
  async run(a) {
    printTasks(await (await tasks()).subtasks(String(a.guid)), Boolean(a.json));
    return 0;
  },
};

const createCmd: Command = {
  name: 'create',
  help: '建任务(负责人会收到通知)',
  access: 'task.create',
  positionals: [{ name: 'title', nargs: '+' }],
  options: [
    ...EDIT_OPTIONS,
    { name: 'parent', kind: 'string', help: '建成这个任务的子任务' },
    { name: 'list', kind: 'string', help: '放进这个任务清单(清单 guid)' },
  ],
  async run(a) {
    return attempt('建任务', async () => {
      const t = await (await tasks()).create({
        title: (a.title as string[]).join(' '),
        description: s(a.desc),
        due: dueArg(a) ?? undefined,
        allDay: Boolean(a.all_day),
        assigneeIds: list(a.assignees),
        followerIds: list(a.followers),
        parentGuid: s(a.parent),
        listGuid: s(a.list),
        reminder: remindArg(a) ?? undefined,
      });
      out(`已建任务 guid=${t.guid}`);
      return 0;
    });
  },
};

const update: Command = {
  name: 'update',
  help: '改任务:标题、描述、截止时间、提醒、负责人、关注人(只改给出的)',
  access: 'task.update',
  positionals: [{ name: 'guid' }],
  options: [{ name: 'title', kind: 'string', help: '新标题' }, ...EDIT_OPTIONS],
  async run(a) {
    return attempt('改任务', async () => {
      await (await tasks()).update(String(a.guid), {
        title: s(a.title),
        description: s(a.desc),
        due: dueArg(a),
        ...(a.all_day ? { allDay: true } : {}),
        assigneeIds: list(a.assignees),
        followerIds: list(a.followers),
        reminder: remindArg(a),
      });
      out(`已更新任务 guid=${a.guid}`);
      return 0;
    });
  },
};

const attachmentLine = (x: TaskAttachment) => `${x.token}\t${x.name}\t${x.size}字节`;

const attach: Command = {
  name: 'attach',
  help: '上传本地文件作为任务附件(加在已有附件之后;附件用 lark doc download <token> 下载)',
  access: 'task.update',
  positionals: [{ name: 'guid' }, { name: 'paths', nargs: '+', help: '本地文件' }],
  async run(a) {
    return attempt('加附件', async () => {
      const files = (a.paths as string[]).map((p) => {
        if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`不是文件: ${p}`);
        return { data: new Uint8Array(readFileSync(p)), name: basename(p) };
      });
      for (const x of await (await tasks()).attach(String(a.guid), files)) out(attachmentLine(x));
      return 0;
    });
  },
};

const detach: Command = {
  name: 'detach',
  help: '按 token 移除任务附件',
  access: 'task.update',
  positionals: [{ name: 'guid' }, { name: 'tokens', nargs: '+', help: '附件 token(见 task get)' }],
  async run(a) {
    return attempt('移除附件', async () => {
      const left = await (await tasks()).detach(String(a.guid), a.tokens as string[]);
      out(`已移除 ${(a.tokens as string[]).length} 个附件,还剩 ${left.length} 个`);
      return 0;
    });
  },
};

const complete: Command = {
  name: 'complete',
  help: '完成任务;--reopen 改回进行中',
  access: 'task.complete',
  positionals: [{ name: 'guids', nargs: '+' }],
  options: [{ name: 'reopen', kind: 'flag', help: '改回进行中' }],
  async run(a) {
    return attempt('改任务状态', async () => {
      const t = await tasks();
      for (const g of a.guids as string[]) await (a.reopen ? t.reopen(g) : t.complete(g));
      out(`已${a.reopen ? '重开' : '完成'} ${(a.guids as string[]).length} 个任务`);
      return 0;
    });
  },
};

const del: Command = {
  name: 'delete',
  help: '删除任务(所有相关的人都看不到了)',
  access: 'task.delete',
  positionals: [{ name: 'guids', nargs: '+' }],
  async run(a) {
    return attempt('删任务', async () => {
      await (await tasks()).delete(a.guids as string[]);
      out(`已删除 ${(a.guids as string[]).length} 个任务`);
      return 0;
    });
  },
};

const comment: Command = {
  name: 'comment',
  help: '给任务发评论',
  access: 'task.comment',
  positionals: [{ name: 'guid' }, { name: 'text', nargs: '+' }],
  async run(a) {
    return attempt('发评论', async () => {
      await (await tasks()).comment(String(a.guid), (a.text as string[]).join(' '));
      out(`已评论 guid=${a.guid}`);
      return 0;
    });
  },
};

const comments: Command = {
  name: 'comments',
  help: '任务的评论(旧的在前)',
  access: 'task.comments',
  positionals: [{ name: 'guid' }],
  options: [JSON_OPTION],
  async run(a) {
    const list = await (await tasks()).comments(String(a.guid));
    if (a.json) printJson(list);
    else for (const c of list) out(`${c.id}\t[${when(c.createdAt)}] ${c.authorId}: ${c.content}`);
    return 0;
  },
};

const lists: Command = {
  name: 'lists',
  help: '我的任务清单',
  access: 'task.lists',
  options: [JSON_OPTION],
  async run(a) {
    const all = await (await tasks()).lists();
    if (a.json) printJson(all);
    else for (const l of all) out(`${l.guid}\t${l.name}\t创建于 ${when(l.createdAt)}`);
    return 0;
  },
};

const listCreate: Command = {
  name: 'list-create',
  help: '新建任务清单',
  access: 'task.list-create',
  positionals: [{ name: 'name', nargs: '+' }],
  async run(a) {
    return attempt('建清单', async () => {
      const l = await (await tasks()).createList((a.name as string[]).join(' '));
      out(`已建清单 guid=${l.guid}`);
      return 0;
    });
  },
};

const listDelete: Command = {
  name: 'list-delete',
  help: '删除任务清单(清单里没有其他负责人的任务一并删除)',
  access: 'task.list-delete',
  positionals: [{ name: 'guid' }],
  async run(a) {
    return attempt('删清单', async () => {
      await (await tasks()).deleteList(String(a.guid));
      out(`已删除清单 guid=${a.guid}`);
      return 0;
    });
  },
};

export const task: CommandGroup = {
  name: 'task',
  help: '飞书任务:列出、搜索、新建、修改、完成、删除、评论、附件、子任务、任务清单',
  subcommands: [
    listCmd,
    search,
    get,
    subtasks,
    createCmd,
    update,
    attach,
    detach,
    complete,
    del,
    comment,
    comments,
    lists,
    listCreate,
    listDelete,
  ],
};
