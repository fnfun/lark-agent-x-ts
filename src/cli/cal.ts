import { Calendar, type CalendarEvent } from '../domains/calendar.js';
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
      `${e.key}\t${e.allDay ? '全天' : `${when(e.start)} - ${shortTime(Math.floor(e.end / 1000)).slice(-5)}`}\t${e.summary}${e.location ? `\t@${e.location}` : ''}`,
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
  help: '删除日程(重复日程整组删除)',
  access: 'cal.delete',
  positionals: [{ name: 'keys', nargs: '+' }],
  options: [{ name: 'calendar', kind: 'string', help: '日历 id(默认主日历)' }],
  async run(a) {
    return attempt('删日程', async () => {
      const c = await calendar();
      for (const key of a.keys as string[])
        await c.delete(key, a.calendar ? { calendarId: String(a.calendar) } : {});
      out(`已删除 ${(a.keys as string[]).length} 个日程`);
      return 0;
    });
  },
};

export const cal: CommandGroup = {
  name: 'cal',
  help: '日历:日历列表、日程、详情、新建、修改、删除',
  subcommands: [calendars, agenda, get, create, update, del],
};
