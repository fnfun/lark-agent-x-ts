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
});
