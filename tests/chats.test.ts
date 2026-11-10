import { describe, expect, test } from 'bun:test';
import type { Dict } from '../src/proto/dict.js';
import { newClient } from './helpers.js';

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
