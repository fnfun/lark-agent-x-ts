import {
  Calendar,
  type CalendarEvent,
  type DeleteScope,
  type EventHit,
} from '../domains/calendar.js';
import type { Option, Parsed } from './args.js';
import { type Command, type CommandGroup, client, err, out, s } from './common.js';
import { errorText, printJson, shortTime } from './format.js';
import { parseTimeArg } from './time.js';

const calendar = async () => new Calendar(await client());
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };
const when = (ms: number) => shortTime(Math.floor(ms / 1000));

/** --start / --end and friends: `2026-11-20 18:00`, a timestamp, or relative like `2h` (from now). */
const at = (v: Parsed[string]) =>
  v === undefined ? undefined : parseTimeArg(String(v), Date.now(), true);

function printEvents(list: CalendarEvent[], json: boolean): void {
  if (json) {
    printJson(list);
    return;
  }
  for (const e of list)
    out(
      `${e.key}\t${e.allDay ? '全天' : `${when(e.start)} - ${shortTime(Math.floor(e.end / 1000)).slice(-5)}`}\t${e.summary}${e.location ? `\t@${e.location}` : ''}${e.rrule || e.originalTime ? '\t(重复)' : ''}`,
    );
}

async function attempt(label: string, f: () => Promise<number>): Promise<number> {
  try {
    return await f();
  } catch (e) {
    err(`${label}失败: ${errorText(e)}`);
    return 1;
  }
}

const EVENT_OPTIONS: Option[] = [
  { name: 'desc', kind: 'string', help: '描述' },
  { name: 'location', kind: 'string', help: '地点' },
  { name: 'all-day', kind: 'flag', help: '全天' },
];

const calendars: Command = {
  name: 'calendars',
  help: '我的日历(自己的和订阅的)',
  access: 'cal.calendars',
  options: [JSON_OPTION],
  async run(a) {
    const list = await (await calendar()).calendars();
    if (a.json) printJson(list);
    else for (const c of list) out(`${c.id}\t${c.name}${c.primary ? '\t主日历' : ''}`);
    return 0;
  },
};

const agenda: Command = {
  name: 'agenda',
  help: '日程:默认今天,--days 看之后几天,--since/--until 指定范围',
  access: 'cal.agenda',
  options: [
    { name: 'days', kind: 'int', default: 1, help: '从今天 0 点起看几天' },
    { name: 'since', kind: 'string', help: '起始时间(2026-11-20、2026-11-20 09:00 或时间戳)' },
    { name: 'until', kind: 'string', help: '截止时间(格式同 --since)' },
    { name: 'calendar', kind: 'string', help: '日历 id(逗号分隔;默认主日历)' },
    JSON_OPTION,
  ],
  async run(a) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const since = a.since ? parseTimeArg(String(a.since)) : today.getTime();
    const until = a.until ? parseTimeArg(String(a.until)) : since + Number(a.days) * 86_400_000;
    const list = await (await calendar()).events({
      since,
      until,
      calendarIds: a.calendar ? String(a.calendar).split(',') : undefined,
    });
    printEvents(list, Boolean(a.json));
    return 0;
  },
};

const search: Command = {
  name: 'search',
  help: '按关键词搜日程(标题、描述、地点、参与人),--since/--until 限定时间范围',
  access: 'cal.search',
  positionals: [{ name: 'query', nargs: '+' }],
  options: [
    { name: 'since', kind: 'string', help: '起始时间(2026-11-20、2026-11-20 09:00 或时间戳)' },
    { name: 'until', kind: 'string', help: '截止时间(格式同 --since)' },
    JSON_OPTION,
  ],
  async run(a) {
    const hits = await (await calendar()).search((a.query as string[]).join(' '), {
      ...(a.since ? { since: parseTimeArg(String(a.since)) } : {}),
      ...(a.until ? { until: parseTimeArg(String(a.until)) } : {}),
    });
    if (a.json) printJson(hits);
    else
      for (const e of hits as EventHit[])
        out(
          `${e.key}\t${e.allDay ? `全天 ${when(e.start).slice(0, 5)}` : `${when(e.start)} - ${when(e.end).slice(-5)}`}\t${e.summary}${e.location ? `\t@${e.location}` : ''}${e.organizer ? `\t组织者 ${e.organizer}` : ''}`,
        );
    return 0;
  },
};

const busy: Command = {
  name: 'busy',
  help: '查这些人在一段时间内是否有日程(只看忙闲,不看内容)',
  access: 'cal.busy',
  positionals: [{ name: 'user_ids', nargs: '+' }],
  options: [
    {
      name: 'start',
      kind: 'string',
      required: true,
      help: '开始时间:2026-11-20 15:00、2h 后或时间戳',
    },
    { name: 'end', kind: 'string', help: '结束时间(默认开始后 1 小时)' },
    JSON_OPTION,
  ],
  async run(a) {
    const start = at(a.start) as number;
    const end = at(a.end) ?? start + 3_600_000;
    const ids = a.user_ids as string[];
    const result = await (await calendar()).busy(ids, start, end);
    if (a.json) printJson(result);
    else for (const [id, b] of Object.entries(result)) out(`${id}\t${b ? '忙' : '空闲'}`);
    const missing = ids.filter((id) => !(id in result));
    if (missing.length) err(`找不到这些人的日历: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
  },
};

const create: Command = {
  name: 'create',
  help: '新建日程(不邀请他人,不发通知)',
  access: 'cal.create',
  positionals: [{ name: 'summary', nargs: '+' }],
  options: [
    {
      name: 'start',
      kind: 'string',
      required: true,
      help: '开始时间:2026-11-20 15:00、2h 后或时间戳',
    },
    { name: 'end', kind: 'string', help: '结束时间(默认开始后 1 小时)' },
    ...EVENT_OPTIONS,
    {
      name: 'rrule',
      kind: 'string',
      help: '重复规则(RFC 5545 RRULE),如 FREQ=WEEKLY;COUNT=4、FREQ=DAILY;UNTIL=20261231',
    },
    { name: 'calendar', kind: 'string', help: '日历 id(默认主日历)' },
  ],
  async run(a) {
    return attempt('新建日程', async () => {
      const start = at(a.start) as number;
      const e = await (await calendar()).create({
        summary: (a.summary as string[]).join(' '),
        start,
        end: at(a.end) ?? start + 3_600_000,
        description: s(a.desc),
        location: s(a.location),
        allDay: Boolean(a.all_day),
        calendarId: s(a.calendar),
        rrule: s(a.rrule),
      });
      out(`已新建日程 key=${e.key} ${when(e.start)}`);
      return 0;
    });
  },
};

const update: Command = {
  name: 'update',
  help: '改日程:标题、时间、描述、地点(只改给出的)',
  access: 'cal.update',
  positionals: [{ name: 'key' }],
  options: [
    { name: 'title', kind: 'string', help: '新标题' },
    { name: 'start', kind: 'string', help: '新开始时间' },
    { name: 'end', kind: 'string', help: '新结束时间' },
    ...EVENT_OPTIONS,
    { name: 'calendar', kind: 'string', help: '日历 id(默认主日历)' },
  ],
  async run(a) {
    return attempt('改日程', async () => {
      await (await calendar()).update(
        String(a.key),
        {
          summary: s(a.title),
          start: at(a.start),
          end: at(a.end),
          description: s(a.desc),
          location: s(a.location),
          ...(a.all_day ? { allDay: true } : {}),
        },
        a.calendar ? { calendarId: String(a.calendar) } : {},
      );
      out(`已更新日程 key=${a.key}`);
      return 0;
    });
  },
};

const get: Command = {
  name: 'get',
  help: '日程详情(含描述)',
  access: 'cal.agenda',
  positionals: [{ name: 'key' }],
  options: [{ name: 'calendar', kind: 'string', help: '日历 id(默认主日历)' }, JSON_OPTION],
  async run(a) {
    const e = await (await calendar()).get(
      String(a.key),
      a.calendar ? { calendarId: String(a.calendar) } : {},
    );
    if (!e) {
      err(`找不到日程: ${a.key}`);
      return 1;
    }
    if (a.json) printJson(e);
    else
      for (const [k, v] of [
        ['标题', e.summary],
        ['时间', e.allDay ? `${when(e.start)} 全天` : `${when(e.start)} - ${when(e.end)}`],
        ['地点', e.location || '-'],
        ['描述', e.description || '-'],
        ['重复', e.rrule || '-'],
      ])
        out(`${k}\t${v}`);
    return 0;
  },
};

const del: Command = {
  name: 'delete',
  help: '删除日程;重复日程默认整组删除,--at 指定某一次后用 --scope 只删这一次或这一次及以后',
  access: 'cal.delete',
  positionals: [{ name: 'keys', nargs: '+' }],
  options: [
    { name: 'calendar', kind: 'string', help: '日历 id(默认主日历)' },
    { name: 'at', kind: 'string', help: '重复日程的某一次:它的开始时间(见 agenda)' },
    {
      name: 'scope',
      kind: 'string',
      choices: ['this', 'future', 'all'],
      help: '配合 --at:this 只删这一次(默认),future 删这一次及以后,all 整组',
    },
  ],
  async run(a) {
    return attempt('删日程', async () => {
      const c = await calendar();
      const keys = a.keys as string[];
      const calendarId = s(a.calendar);
      if (a.at === undefined) {
        if (a.scope && a.scope !== 'all') throw new Error('--scope this/future 要配合 --at');
        for (const key of keys) await c.delete(key, calendarId ? { calendarId } : {});
        out(`已删除 ${keys.length} 个日程`);
        return 0;
      }
      if (keys.length !== 1) throw new Error('--at 只能配一个日程');
      const start = at(a.at) as number;
      const occurrence = (
        await c.events({
          since: start - 86_400_000,
          until: start + 86_400_000,
          calendarIds: calendarId ? [calendarId] : undefined,
        })
      ).find((e) => e.key === keys[0] && e.start === Math.floor(start / 60_000) * 60_000);
      if (!occurrence) throw new Error(`找不到这个日程在 ${when(start)} 开始的那一次`);
      const scope = (s(a.scope) ?? 'this') as DeleteScope;
      await c.delete(keys[0] as string, {
        ...(calendarId ? { calendarId } : {}),
        scope,
        occurrence,
      });
      out(
        scope === 'all'
          ? '已删除整组日程'
          : `已删除 ${when(start)} 的那一次${scope === 'future' ? '及以后' : ''}`,
      );
      return 0;
    });
  },
};

export const cal: CommandGroup = {
  name: 'cal',
  help: '日历:日历列表、日程、详情、搜索、忙闲、新建、修改、删除',
  subcommands: [calendars, agenda, get, search, busy, create, update, del],
};
