import { describe, expect, test } from 'bun:test';
import type { LarkAuth } from '../src/auth.js';
import { chatterName } from '../src/client.js';
import type { Dict } from '../src/proto/dict.js';
import { newClient } from './helpers.js';

const withLocale = (c: ReturnType<typeof newClient>) =>
  Object.assign(c.auth, { region: { locale: 'zh_CN' } } as Partial<LarkAuth>);

describe('人名与群成员', () => {
  test('显示名：备注名 > 当前语言显示名 > 默认显示名 > name', () => {
    const v: Dict = {
      name: 'tongshi',
      displayName: { defaultVal: '同事甲', i18nVals: { zh_cn: '同事甲（中文）', en_us: '' } },
    };
    expect(chatterName({ ...v, alias: '甲哥' })).toBe('甲哥');
    expect(chatterName(v)).toBe('同事甲（中文）');
    expect(chatterName(v, 'en_US')).toBe('同事甲');
    expect(chatterName({ name: 'tongshi' })).toBe('tongshi');
  });

  test('群成员：翻页参数原样带回，合并 updateChatters，服务端不再给游标就停', async () => {
    const c = newClient();
    withLocale(c);
    const reqs: Dict[] = [];
    const pages: Dict[] = [
      {
        chatters: { u1: { name: '同事甲', type: 1 }, b1: { name: '提醒机器人', type: 2 } },
        nextCursor: 5n,
        nextOffset: 'o2',
      },
      { chatters: {}, updateChatters: { u2: { name: '同事乙', type: 1 } }, nextOrderCursor: 9n },
      { chatters: { u3: { name: '同事丙', type: 1 } } },
    ];
    c.api = async (type, data) => {
      expect(type).toBe('chats.PullChatChattersRequest');
      reqs.push(data as Dict);
      return pages[reqs.length - 1] ?? {};
    };
    expect(await c.chatMembers('g1')).toEqual([
      { id: 'u1', name: '同事甲', type: 'user' },
      { id: 'b1', name: '提醒机器人', type: 'bot' },
      { id: 'u2', name: '同事乙', type: 'user' },
      { id: 'u3', name: '同事丙', type: 'user' },
    ]);
    expect(reqs).toEqual([
      { chatId: 'g1', limit: 100 },
      { chatId: 'g1', limit: 100, cursor: 5n, offset: 'o2' },
      { chatId: 'g1', limit: 100, orderCursor: 9n },
    ]);
    // 成员里查到的名字进了缓存，不再请求
    c.api = async () => {
      throw new Error('不应再请求');
    };
    expect(await c.userNames(['u2'])).toEqual(new Map([['u2', '同事乙']]));
  });

  test('批量查名字：去重、每批 100 个、结果缓存，查不到的不在结果里', async () => {
    const c = newClient();
    withLocale(c);
    const batches: string[][] = [];
    c.api = async (_type, data) => {
      const ids = (data as { chatterIds: string[] }).chatterIds;
      batches.push(ids);
      return {
        chatters: Object.fromEntries(
          ids.filter((i) => i !== 'ghost').map((i) => [i, { name: `名${i}` }]),
        ),
      };
    };
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const got = await c.userNames([...ids, 'u0', 'ghost']);
    expect(got.size).toBe(150);
    expect(got.get('u7')).toBe('名u7');
    expect(got.has('ghost')).toBe(false);
    expect(batches.map((b) => b.length)).toEqual([100, 51]);
    await c.userNames(['u1', 'u2']);
    expect(batches).toHaveLength(2);
  });
});
