import { describe, expect, test } from 'bun:test';
import type { LarkAuth } from '../src/auth.js';
import { chatterName, profileText } from '../src/client.js';
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
    // Names found among the members are cached; no further requests
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

describe('群管理', () => {
  test('建群、拉人、移出、改名的请求字段', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      return type === 'chats.PutChatRequest' ? { chat: { id: '7200000000000000009' } } : {};
    };
    expect(
      await c.createGroup('项目协作群', ['u1', 'u2'], {
        description: '周报',
        topic: true,
        cid: 'g1cid',
      }),
    ).toBe('7200000000000000009');
    await c.createGroup('只有我', [], { cid: 'g2cid' });
    await c.addMembers('7200000000000000009', ['u3']);
    await c.removeMembers('7200000000000000009', ['u2']);
    await c.updateGroup('7200000000000000009', { name: '项目协作群（二期）' });
    await c.updateGroup('7200000000000000009', { description: '' });
    await c.updateGroup('7200000000000000009', {});
    expect(reqs).toEqual([
      [
        'chats.PutChatRequest',
        {
          type: 2,
          groupName: '项目协作群',
          groupDesc: '周报',
          chatterIds: ['u1', 'u2'],
          chatMode: 3,
          cid: 'g1cid',
        },
      ],
      ['chats.PutChatRequest', { type: 2, groupName: '只有我', chatterIds: [], cid: 'g2cid' }],
      ['chats.PutChatChatterRequest', { chatId: '7200000000000000009', chatterIds: ['u3'] }],
      ['chats.DeleteChatChatterRequest', { chatId: '7200000000000000009', chatterIds: ['u2'] }],
      [
        'chats.PatchGroupChatRequest',
        { chatId: '7200000000000000009', name: '项目协作群（二期）', updateFields: [1] },
      ],
      [
        'chats.PatchGroupChatRequest',
        { chatId: '7200000000000000009', description: '', updateFields: [3] },
      ],
    ]);
    c.api = async () => ({});
    await expect(c.createGroup('x')).rejects.toThrow('建群失败');
  });
});

describe('会话标签', () => {
  test('列出标签（翻页、按位置排序）与标签里的会话（只要会话、去掉排除项）', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    let groupPage = 0;
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type === 'feed.PullFeedGroupsRequest')
        return groupPage++ === 0
          ? {
              feedGroups: [{ id: 2n, name: '客户', type: 1, pos: 2n }],
              hasMore: true,
              nextCursor: 'c1',
            }
          : {
              feedGroups: [{ id: 1n, name: '待回复', type: 2, pos: 1n }],
              hasMore: false,
              nextCursor: 'c2',
            };
      return {
        data: {
          '2': {
            feedGroupItems: [
              { feedCardId: 71n, feedCardType: 1 },
              { feedCardId: 72n, feedCardType: 3 },
              { feedCardId: 73n, feedCardType: 1, exclude: true },
            ],
            hasMore: false,
          },
        },
      };
    };
    expect(await c.feedGroups()).toEqual([
      { id: '1', name: '待回复', type: 'keyword' },
      { id: '2', name: '客户', type: 'normal' },
    ]);
    expect(reqs.map(([, d]) => d)).toEqual([{ count: '20' }, { count: '20', cursor: 'c1' }]);
    expect(await c.feedGroupChats('2')).toEqual(['71']);
    expect(reqs.at(-1)?.[1]).toEqual({ args: { '2': { count: '20' } } });
  });
});

describe('搜人、搜机器人、搜群', () => {
  const search = (results: Dict[]) => {
    const c = newClient();
    withLocale(c);
    const filters: Dict[] = [];
    c.api = async (_type, data) => {
      const ctx = ((data as Dict).header as Dict).searchContext as Dict;
      filters.push((ctx.entityItems as Dict[])[0] as Dict);
      return { header: { hasMore: false }, results };
    };
    return { c, filters };
  };

  test('搜人：过滤开关进 userFilter，只取人的结果，名字去掉高亮', async () => {
    const { c, filters } = search([
      {
        id: 'u1',
        type: 1,
        titleHighlighted: '<h>同事</h>甲',
        summaryHighlighted: '研发部',
        resultMeta: { userMeta: { id: '7100000000000000001', chatId: '7200000000000000001' } },
      },
      { id: 'g1', type: 3, resultMeta: { groupChatMeta: { id: '7200000000000000002' } } },
    ]);
    expect(await c.searchUsers('同事', { chatted: true, excludeExternal: true })).toEqual([
      {
        userId: '7100000000000000001',
        name: '同事甲',
        description: '研发部',
        chatId: '7200000000000000001',
        email: '',
        crossTenant: false,
      },
    ]);
    expect(filters[0]).toEqual({
      type: 1,
      filter: { userFilter: { haveChatter: true, excludeOuterContact: true } },
    });
  });

  test('搜群按模式过滤在本地做：服务端不支持，只留下要的那一类', async () => {
    const group = (id: string, mode: number) => ({
      id,
      type: 3,
      titleHighlighted: '项目协作群',
      resultMeta: { groupChatMeta: { id, mode, userCount: 3, isMember: true } },
    });
    const { c, filters } = search([group('g1', 1), group('g2', 3), group('g3', 2)]);
    const got = await c.searchChats('', { mode: 'topic', memberIds: ['u1'], sort: 'members' });
    expect(got.map((h) => [h.chatId, h.mode])).toEqual([
      ['g2', 'topic'],
      ['g3', 'topic'],
    ]);
    expect(filters[0]?.filter).toEqual({
      groupChatFilter: { chatMemberIds: ['u1'], sortType: 4 },
    });
  });
});

describe('资料卡', () => {
  test('字段值：多语言文本按当前语言取，链接取文字或地址，列表合并，跳过标题和图标', () => {
    const text = { default_val: 'R&D', i18n_vals: { zh_cn: '研发部' } };
    expect(profileText({ text }, 'zh_CN')).toBe('研发部');
    expect(profileText({ text }, 'en_US')).toBe('R&D');
    expect(profileText([{ text }, { text: { default_val: '平台组' } }], 'zh_CN')).toBe(
      '研发部、平台组',
    );
    expect(
      profileText({ title: { default_val: '复制链接' }, link: 'https://example.com/u' }, 'zh_CN'),
    ).toBe('https://example.com/u');
    expect(profileText({ icon: 'x', title: { default_val: '仅标题' } }, 'zh_CN')).toBe('');
  });

  test('只留可见且有值的字段，标签按当前语言，带上名字', async () => {
    const c = newClient();
    withLocale(c);
    c.api = async (type) => {
      if (type === 'chatters.PullChattersByIdsRequest')
        return { chatters: { '7100000000000000001': { name: '同事甲' } } };
      expect(type).toBe('users.PullUserProfileV2Request');
      const label = (zh: string, en: string) => ({ defaultVal: en, i18nVals: { zh_cn: zh } });
      return {
        profile: {
          fields: [
            {
              key: 'B-DEPARTMENT',
              visible: true,
              i18nNames: label('部门', 'Department'),
              strFieldVal: JSON.stringify({ text: { default_val: '研发部' } }),
            },
            { key: 'B-DESCRIPTION', visible: true, i18nNames: label('状态', 'Status') },
            {
              key: 'B-PHONE',
              visible: false,
              i18nNames: label('电话', 'Phone'),
              strFieldVal: JSON.stringify({ text: { default_val: '000' } }),
            },
          ],
        },
      };
    };
    expect(await c.userProfile('7100000000000000001')).toEqual({
      userId: '7100000000000000001',
      name: '同事甲',
      fields: [{ key: 'B-DEPARTMENT', label: '部门', value: '研发部' }],
    });
  });
});
