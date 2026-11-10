import { describe, expect, test } from 'bun:test';
import type { Dict } from '../src/proto/dict.js';
import { newClient, strictRequest } from './helpers.js';

describe('会话列表与群信息', () => {
  const card = (id: string, t: number) => ({ id, type: 1, updateTimeMs: BigInt(t), rankTime: 1n });

  test('isRemind=false 才算免打扰；按类型过滤；私聊用对方的名字和 id 补齐，自聊是自己', async () => {
    const c = newClient();
    c.api = async (type) => {
      expect(type).toBe('feed.PullFeedCardsRequest');
      return {
        cards: [card('p1', 5000), card('g1', 4000), card('p2', 3000), card('g2', 2000)],
        chats: {
          p1: { type: 1, newMessageCount: 2 },
          g1: { type: 2, name: '项目协作群', isRemind: false, userCount: 8 },
          p2: { type: 1 },
          g2: { type: 2, name: '周会群', isRemind: true, chatMode: 3 },
        },
      };
    };
    c.chatMembers = async (chatId) =>
      chatId === 'p1'
        ? [
            { id: 'me', name: '我', type: 'user' },
            { id: '7100000000000000001', name: '同事甲', type: 'user' },
          ]
        : [{ id: 'me', name: '我', type: 'user' }];

    const all = await c.chatList();
    expect(all.map((x) => [x.chatId, x.type, x.name, x.peerId, x.muted])).toEqual([
      ['p1', 'p2p', '同事甲', '7100000000000000001', false],
      ['g1', 'group', '项目协作群', '', true],
      ['p2', 'p2p', '我', 'me', false],
      ['g2', 'topic', '周会群', '', false],
    ]);
    expect(
      (await c.chatList({ excludeMuted: true, types: ['group', 'topic'] })).map((x) => x.chatId),
    ).toEqual(['g2']);
    expect((await c.chatList({ limit: 1 })).map((x) => x.chatId)).toEqual(['p1']);
  });

  test('群信息：我是群主时也算管理员；发言权限换成可读的取值', async () => {
    const c = newClient();
    const chat = (over: Dict) => ({
      type: 2,
      name: '项目协作群',
      ownerId: 'u9',
      postType: 2,
      ...over,
    });
    let current: Dict = chat({});
    c.getChatInfo = async () => current;
    expect(await c.chatInfo('g1')).toMatchObject({
      owner: false,
      admin: false,
      postType: 'admins',
    });
    current = chat({ ownerId: 'me', postType: 1 });
    expect(await c.chatInfo('g1')).toMatchObject({ owner: true, admin: true, postType: 'anyone' });
    current = chat({ isAdmin: true, isRemind: false });
    expect(await c.chatInfo('g1')).toMatchObject({ owner: false, admin: true, muted: true });
  });
});

describe('群设置与会话标签', () => {
  const recorder = (reply: (type: string, data: Dict) => Dict = () => ({})) => {
    const c = newClient();
    const calls: [string, Dict][] = [];
    c.api = async (type, data) => {
      strictRequest(String(type), data as Dict);
      calls.push([String(type), data as Dict]);
      return reply(String(type), data as Dict);
    };
    return { c, calls };
  };

  test('免打扰：muted 对应 isRemind=false，带 atAll 时一并改 @所有人，并声明改了哪些字段', async () => {
    const { c, calls } = recorder();
    await c.setMuted(['7200000000000000001', '7200000000000000002'], true);
    await c.setMuted(['7200000000000000001'], false, { atAll: true });
    expect(calls.map(([, d]) => [d.chatId, d.chatSetting, d.updateChatSettingField])).toEqual([
      ['7200000000000000001', { isRemind: false }, [1]],
      ['7200000000000000002', { isRemind: false }, [1]],
      ['7200000000000000001', { isRemind: true, isMuteAtAll: false }, [1, 6]],
    ]);
  });

  test('入群申请：从游标 0 翻到没有更多，状态与来源换成可读值，新的在前', async () => {
    const pages: Dict[] = [
      {
        applies: [{ inviteeId: 'u1', status: 3, time: 100n, applyWays: 6, reason: '想加入' }],
        nextCursor: '1790000000',
      },
      { applies: [{ inviteeId: 'u2', inviterId: 'u9', status: 1, time: 200n, applyWays: 2 }] },
    ];
    let i = 0;
    const { c, calls } = recorder(() => pages[i++] ?? {});
    expect(await c.joinRequests('7200000000000000001')).toEqual([
      {
        userId: 'u2',
        inviterId: 'u9',
        reason: '',
        status: 'approved',
        time: 200,
        via: 'invitation',
      },
      { userId: 'u1', inviterId: '', reason: '想加入', status: 'pending', time: 100, via: 'link' },
    ]);
    expect(calls.map(([, d]) => d.cursor)).toEqual(['0', '1790000000']);
    await c.handleJoinRequest('7200000000000000001', 'u1', false);
    expect(calls.at(-1)).toEqual([
      'chats.PatchAddChatChatterApplyRequest',
      { chatId: '7200000000000000001', inviteeId: 'u1', status: 2 },
    ]);
  });

  test('分享链接：永久链接的过期时间记为 0；没有链接时报错', async () => {
    let resp: Dict = { sharedUrl: 'https://example.com/join', isUnlimited: true, expireTime: 99n };
    const { c } = recorder(() => resp);
    expect(await c.chatShareLink('7200000000000000001', { forever: true })).toEqual({
      url: 'https://example.com/join',
      expireTime: 0,
    });
    resp = {};
    await expect(c.chatShareLink('7200000000000000001')).rejects.toThrow('拿不到群分享链接');
  });

  test('会话标签：改名只声明基础字段，增删会话带上所属标签', async () => {
    const { c, calls } = recorder(() => ({ feedGroup: { id: 4200000000000000042n } }));
    expect(await c.createFeedGroup('周会', ['7200000000000000001'])).toBe('4200000000000000042');
    await c.renameFeedGroup('4200000000000000042', '例会');
    await c.addToFeedGroup('4200000000000000042', ['7200000000000000002']);
    await c.removeFromFeedGroup('4200000000000000042', ['7200000000000000001']);
    await c.deleteFeedGroup('4200000000000000042');
    expect(calls.map(([, d]) => d)).toEqual([
      {
        feedGroup: { name: '周会', type: 1 },
        feedGroupItems: [{ feedCardId: '7200000000000000001', feedCardType: 1 }],
      },
      {
        feedGroups: [{ id: '4200000000000000042', name: '例会', type: 1 }],
        feedGroupsUpdateFields: { '4200000000000000042': { fields: [1] } },
      },
      {
        feedGroupItems: [
          { feedCardId: '7200000000000000002', feedCardType: 1, groupId: '4200000000000000042' },
        ],
      },
      {
        deletedFeedGroupItems: [
          { feedCardId: '7200000000000000001', feedCardType: 1, groupId: '4200000000000000042' },
        ],
      },
      { deletedGroups: [{ id: '4200000000000000042' }] },
    ]);
  });
});

describe('转发整个话题', () => {
  test('来源会话取根消息所在的会话，返回目标会话 → 新消息；根消息不存在时报错', async () => {
    const c = newClient();
    const calls: Dict[] = [];
    c.getMessages = async (ids) =>
      ids[0] === '7000000000000000009'
        ? []
        : [{ msg_id: ids[0], chat_id: '7200000000000000001' } as never];
    c.api = async (type, data) => {
      strictRequest(String(type), data as Dict);
      calls.push(data as Dict);
      return { messages: { '7200000000000000002': { id: '7000000000000000002' } } };
    };
    const sent = await c.forwardThread('7000000000000000001', ['7200000000000000002']);
    expect([...sent]).toEqual([['7200000000000000002', '7000000000000000002']]);
    expect(calls[0]).toEqual({
      channelId: '7200000000000000001',
      threadId: '7000000000000000001',
      targets: [{ toChat: { chatId: '7200000000000000002' } }],
    });
    await expect(c.forwardThread('7000000000000000009', ['7200000000000000002'])).rejects.toThrow(
      '找不到话题根消息',
    );
  });
});
