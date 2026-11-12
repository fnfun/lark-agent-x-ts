import { describe, expect, test } from 'bun:test';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { Calendar, toEvent } from '../src/domains/calendar.js';
import type { Dict } from '../src/proto/dict.js';
import { larkType } from '../src/proto/registry.js';
import { newClient } from './helpers.js';

const CAL = '7300000000000000001';
const DAY = 86_400_000;

/** Fake client: answers calendar commands, encoding each request strictly against its type. */
function fake(listing: (since: number, until: number, token: string) => Dict) {
  const c = newClient();
  const calls: [number, Dict][] = [];
  c.api = async () => ({ calendar: { id: CAL } });
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
