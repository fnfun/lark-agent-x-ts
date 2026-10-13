import { describe, expect, test } from 'bun:test';
import { parseTimeArg } from '../src/cli/time.js';
import type { Dict } from '../src/proto/dict.js';
import { newClient } from './helpers.js';

const hit = (id: string, over: Dict = {}) => ({
  id,
  type: 5,
  titleHighlighted: '项目协作群',
  summaryHighlighted: `同事甲: <h>月报</h>导出 ${id}`,
  resultMeta: {
    messageMeta: {
      id,
      type: 4,
      chatId: '7200000000000000001',
      fromId: '7100000000000000001',
      createTime: 1_790_000_000n,
      position: 7,
      ...over,
    },
  },
});

describe('跨会话搜消息', () => {
  test('过滤条件进 messageFilter，按会话内同一 session 翻页，直到够数或没有更多', async () => {
    const c = newClient();
    Object.assign(c.auth, { region: { locale: 'zh_CN' } });
    const reqs: Dict[] = [];
    const pages: Dict[] = [
      {
        header: { hasMore: true, paginationToken: 't1' },
        results: [hit('m1'), { id: 'u1', type: 1 }],
      },
      {
        header: { hasMore: true, paginationToken: 't2' },
        results: [hit('m2', { isP2pChat: true })],
      },
      { header: { hasMore: false }, results: [hit('m3')] },
    ];
    c.api = async (type, data) => {
      expect(type).toBe('usearch.UniversalSearchRequest');
      reqs.push((data as Dict).header as Dict);
      return pages[reqs.length - 1] ?? {};
    };
    const got = await c.searchMessages('月报', {
      chatIds: ['7200000000000000001'],
      fromIds: ['7100000000000000001'],
      since: 1_790_000_000_500,
      limit: 2,
    });
    expect(got).toEqual([
      {
        msgId: 'm1',
        chatId: '7200000000000000001',
        chatTitle: '项目协作群',
        fromId: '7100000000000000001',
        createTime: 1_790_000_000,
        position: 7,
        msgType: 4,
        p2p: false,
        summary: '同事甲: 月报导出 m1',
      },
      expect.objectContaining({ msgId: 'm2', p2p: true }),
    ]);
    expect(reqs).toHaveLength(2);
    const ctx = reqs[0]?.searchContext as Dict;
    expect(ctx.tagName).toBe('MESSAGE');
    expect(ctx.entityItems).toEqual([
      {
        type: 5,
        filter: {
          messageFilter: {
            chatIds: ['7200000000000000001'],
            creatorIds: ['7100000000000000001'],
            timeRange: { startTime: '1790000000' },
          },
        },
      },
    ]);
    expect([reqs[0]?.searchSession, reqs[0]?.sessionSeqId, reqs[0]?.paginationToken]).toEqual([
      reqs[1]?.searchSession,
      1,
      undefined,
    ]);
    expect([reqs[1]?.sessionSeqId, reqs[1]?.paginationToken]).toEqual([2, 't1']);
  });

  test('时间参数：相对时长、日期、日期时间与时间戳', () => {
    const now = new Date(2026, 9, 14, 12, 0, 0).getTime();
    expect(parseTimeArg('30m', now)).toBe(now - 30 * 60_000);
    expect(parseTimeArg('3d', now)).toBe(now - 3 * 86_400_000);
    expect(parseTimeArg('2026-10-01', now)).toBe(new Date(2026, 9, 1).getTime());
    expect(parseTimeArg('2026-10-01 09:30', now)).toBe(new Date(2026, 9, 1, 9, 30).getTime());
    expect(parseTimeArg('1790000000', now)).toBe(1_790_000_000_000);
    expect(parseTimeArg('1790000000123', now)).toBe(1_790_000_000_123);
    expect(() => parseTimeArg('昨天', now)).toThrow('无法识别的时间');
  });
});
