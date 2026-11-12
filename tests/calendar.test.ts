import { describe, expect, test } from 'bun:test';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { Calendar, toEvent } from '../src/domains/calendar.js';
import type { Dict } from '../src/proto/dict.js';
import { larkType } from '../src/proto/registry.js';
import { newClient } from './helpers.js';

const CAL = '7300000000000000001';
const DAY = 86_400_000;

/**
 * Fake client: answers calendar commands, encoding each request strictly against its type. The
 * server-expanded occurrences default to the listed events, each occurring once at its start.
 */
function fake(
  listing: (since: number, until: number, token: string) => Dict,
  instances?: (since: number, until: number) => Dict,
) {
  const c = newClient();
  const calls: [number, Dict][] = [];
  const listedAsInstances = (since: number, until: number) => {
    const events: Dict[] = [];
    for (let token = '', page = 0; page < 20; page++) {
      const r = listing(since, until, token);
      events.push(...((r.calendarEvents ?? []) as Dict[]));
      token = String(r.nextPageToken ?? '');
      if (!token) break;
    }
    return {
      calendarEventInstance: events.map((e, i) => ({
        eventRefId: `r${i}`,
        beginTime: e.startTime,
        endTime: e.endTime,
      })),
      events: Object.fromEntries(events.map((e, i) => [`r${i}`, { ...e, uniqueKey: e.key }])),
    };
  };
  c.api = async (type, data) => {
    if (type !== 'calendarevents.QueryInstanceRequest') return { calendar: { id: CAL } };
    const d = data as Dict;
    const [since, until] = [Number(d.startTime) * 1000, Number(d.endTime) * 1000];
    return (instances ?? listedAsInstances)(since, until);
  };
  c.command = async (cmd, reqType, data) => {
    fromJson(larkType(reqType), data as JsonValue);
    calls.push([cmd, data]);
    if (cmd === 1002001) {
      const p = (data.params as Dict[])[0] as Dict;
      return {
        results: {
          [CAL]: listing(
            Number(p.timeMin) * 1000,
            Number(p.timeMax) * 1000,
            String(p.pageToken ?? ''),
          ),
        },
      };
    }
    if (cmd === 1002006)
      return {
        events: {
          e1: {
            id: 'e1',
            key: 'k1',
            calendarId: CAL,
            summary: '周会',
            description: '议程',
            startTime: 1_800_000_000n,
            endTime: 1_800_003_600n,
          },
        },
      };
    return {};
  };
  return { cal: new Calendar(c), calls };
}

describe('日历', () => {
  test('时间按秒存，换成毫秒；地点取第一个', () => {
    expect(
      toEvent({
        key: 'k',
        startTime: 1_800_000_000n,
        endTime: 1_800_001_800n,
        locations: [{ name: '会议室A' }],
      }),
    ).toMatchObject({
      start: 1_800_000_000_000,
      end: 1_800_001_800_000,
      location: '会议室A',
    });
  });

  test('列日程按 90 天分段（范围太大会无限翻页），段内翻页，跨段去重，跳过已删除', async () => {
    const since = Date.UTC(2026, 0, 1);
    const ev = (key: string, start: number, extra: Dict = {}) => ({
      key,
      calendarId: CAL,
      startTime: BigInt(start / 1000),
      endTime: BigInt(start / 1000 + 1800),
      ...extra,
    });
    const { cal, calls } = fake((from, _to, token) => {
      if (from === since && !token)
        return { calendarEvents: [ev('a', since + DAY)], nextPageToken: 'p2' };
      if (from === since)
        return {
          calendarEvents: [
            ev('gone', since + 2 * DAY, { isDeleted: true }),
            ev('b', since + 89 * DAY),
          ],
        };
      // A long event shows up in both windows it overlaps
      return { calendarEvents: [ev('b', since + 89 * DAY), ev('c', since + 150 * DAY)] };
    });
    const got = await cal.events({ since, until: since + 200 * DAY });
    expect(got.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    const windows = calls
      .filter(([cmd]) => cmd === 1002001)
      .map(([, d]) => (d.params as Dict[])[0] as Dict);
    for (const w of windows)
      expect(Number(w.timeMax) - Number(w.timeMin)).toBeLessThanOrEqual((90 * DAY) / 1000);
    expect(windows.map((w) => w.pageToken ?? '')).toEqual(['', 'p2', '', '']);
  });

  test('新建：客户端给数字 id、不通知任何人、时间按秒；修改从按 id 取到的完整日程出发，描述不丢', async () => {
    const start = 1_800_000_000_000;
    const { cal, calls } = fake(() => ({
      calendarEvents: [
        {
          id: 'e1',
          key: 'k1',
          calendarId: CAL,
          summary: '周会',
          startTime: BigInt(start / 1000),
          endTime: BigInt(start / 1000 + 3600),
        },
      ],
    }));
    await cal.create({ summary: '周会', start, end: start + 3_600_000 });
    const created = (calls.find(([cmd]) => cmd === 1002003)?.[1] ?? {}) as Dict;
    const event = created.event as Dict;
    expect(String(event.id)).toMatch(/^\d+$/);
    expect([event.startTime, event.endTime, created.notificationType]).toEqual([
      '1800000000',
      '1800003600',
      2,
    ]);

    await cal.update('k1', { summary: '周会（改）' });
    const updated = (calls.find(([cmd]) => cmd === 1002004)?.[1] ?? {}) as Dict;
    expect(updated.event).toMatchObject({
      summary: '周会（改）',
      description: '议程',
      startTime: '1800000000',
    });
    expect(updated.span).toBe(1);

    // A single event is deleted whole with NONE_SPAN
    await cal.delete('k1');
    const deleted = (calls.find(([cmd]) => cmd === 1002005)?.[1] ?? {}) as Dict;
    expect([deleted.span, deleted.instanceStartTime]).toEqual([0, undefined]);
  });

  test('重复日程：按服务端展开的每一次列出（取消的那次不列），地点取自列表；删某一次 / 以后 / 整组按范围与那一次发', async () => {
    const t0 = 1_800_000_000;
    const series = {
      key: 'wk',
      calendarId: CAL,
      originalTime: 0n,
      summary: '周会',
      rrule: 'FREQ=WEEKLY;COUNT=4',
      startTime: BigInt(t0),
      endTime: BigInt(t0 + 3600),
      locations: [{ name: '会议室A' }],
    };
    const week = 7 * 86_400;
    const { cal, calls } = fake(
      () => ({ calendarEvents: [series] }),
      () => ({
        calendarEventInstance: [
          { eventRefId: 'm', beginTime: BigInt(t0), endTime: BigInt(t0 + 3600) },
          { eventRefId: 'x', beginTime: BigInt(t0 + week), endTime: BigInt(t0 + week + 3600) },
          {
            eventRefId: 'm',
            beginTime: BigInt(t0 + 2 * week),
            endTime: BigInt(t0 + 2 * week + 3600),
          },
          {
            eventRefId: 'c',
            beginTime: BigInt(t0 + 3 * week),
            endTime: BigInt(t0 + 3 * week + 3600),
          },
        ],
        events: {
          m: { uniqueKey: 'wk', originalTime: 0n, summary: '周会', rrule: 'FREQ=WEEKLY;COUNT=4' },
          // An occurrence moved by an hour: an exception with its original start
          x: { uniqueKey: 'wk', originalTime: BigInt(t0 + week - 3600), summary: '周会（改时间）' },
          c: { uniqueKey: 'wk', originalTime: BigInt(t0 + 3 * week), status: 3 },
        },
      }),
    );
    const got = await cal.events({ since: t0 * 1000, until: (t0 + 30 * 86_400) * 1000 });
    expect(got.map((e) => [e.start / 1000 - t0, e.originalTime, e.location])).toEqual([
      [0, 0, '会议室A'],
      [week, t0 + week - 3600, ''],
      [2 * week, 0, '会议室A'],
    ]);

    const deletes = () => calls.filter(([cmd]) => cmd === 1002005).map(([, d]) => d);
    await cal.delete('wk', { scope: 'this', occurrence: got[2] as (typeof got)[number] });
    await cal.delete('wk', { scope: 'future', occurrence: got[1] as (typeof got)[number] });
    await cal.delete('wk');
    expect(deletes().map((d) => [d.span, d.originalTime, d.instanceStartTime])).toEqual([
      [1, '0', String(t0 + 2 * week)],
      [2, String(t0 + week - 3600), String(t0 + week - 3600)],
      // The whole series: ALL_EVENTS from its first start (NONE_SPAN fails once it has exceptions)
      [3, '0', String(t0)],
    ]);
    await expect(cal.delete('wk', { scope: 'this' })).rejects.toThrow('哪一次');
  });

  test('搜索：高级场景、时间范围按秒过滤；结果按实例与内容对上，key 取 uid、时间换成毫秒', async () => {
    const c = newClient();
    const sent: Dict[] = [];
    c.command = async (cmd, reqType, data) => {
      fromJson(larkType(reqType), data as JsonValue);
      expect(cmd).toBe(1010036);
      sent.push(data);
      return {
        instances: [
          { eventRefId: 'r2', startTime: 1_800_007_200n, endTime: 1_800_010_800n },
          { eventRefId: 'r1', startTime: 1_800_000_000n, endTime: 1_800_003_600n },
        ],
        contents: {
          r1: { uid: 'k1', calendarId: CAL, summary: '周会', organizer: '同事甲' },
          r2: { uid: 'k2', calendarId: CAL, summary: '周会复盘', location: '会议室A' },
        },
      };
    };
    const hits = await new Calendar(c).search('周会', {
      since: 1_799_000_000_000,
      until: 1_801_000_000_500,
    });
    expect(sent[0]).toMatchObject({
      query: '周会',
      eventSearchScene: 2,
      eventFilter: { startTime: '1799000000', endTime: '1801000000' },
    });
    expect(hits.map((h) => [h.key, h.start, h.end, h.summary, h.location, h.organizer])).toEqual([
      ['k2', 1_800_007_200_000, 1_800_010_800_000, '周会复盘', '会议室A', ''],
      ['k1', 1_800_000_000_000, 1_800_003_600_000, '周会', '', '同事甲'],
    ]);
  });

  test('忙闲：先把人换成主日历，再按日历问忙闲并换回人；没有日历的人不列，空回复算空闲', async () => {
    const c = newClient();
    const asked: Dict[] = [];
    let busyReply: Dict = { calendarBusyMap: { 'cal-a': true } };
    c.command = async (cmd, reqType, data) => {
      fromJson(larkType(reqType), data as JsonValue);
      expect(cmd).toBe(1002008);
      return {
        userAttendees: {
          u1: { attendeeCalendarId: 'cal-a' },
          u2: { attendeeCalendarId: 'cal-b' },
        },
      };
    };
    c.api = async (type, data) => {
      expect(type).toBe('calendarevents.GetBusyUserRequest');
      asked.push(data as Dict);
      return busyReply;
    };
    const cal = new Calendar(c);
    expect(await cal.busy(['u1', 'u2', 'u3'], 1_800_000_000_000, 1_800_003_600_000)).toEqual({
      u1: true,
      u2: false,
    });
    expect(asked[0]).toEqual({
      calendarIds: ['cal-a', 'cal-b'],
      startTime: '1800000000',
      endTime: '1800003600',
    });
    busyReply = {};
    expect(await cal.busy(['u1'], 1_800_000_000_000, 1_800_003_600_000)).toEqual({ u1: false });
  });
});
