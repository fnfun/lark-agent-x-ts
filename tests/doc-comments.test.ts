import { describe, expect, test } from 'bun:test';
import { DocComments } from '../src/domains/doc-comments.js';
import { DocPermissions } from '../src/domains/doc-permissions.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Call = [string, string, WebRequest];

function fake(reply: (path: string, o: WebRequest) => unknown) {
  const calls: Call[] = [];
  const web = {
    json: async (method: string, path: string, o: WebRequest = {}) => {
      calls.push([method, path, o]);
      return reply(path, o);
    },
  } as unknown as WebSession;
  return { web, calls };
}

const DOC = { type: 'docx' as const, token: 'D1' };
const thread = (id: string, finish: number, ...texts: string[]) => ({
  comment_id: id,
  is_whole: 1,
  finish,
  quote: '',
  comment_list: texts.map((t, i) => ({ reply_id: `${id}-${i}`, content: t, name: '同事甲' })),
});

describe('文档评论', () => {
  test('列评论：先取各类评论 id，再按重复的 comment_ids 批量取详情；已解决的排在后面，内容反转义', async () => {
    const { web, calls } = fake((path) =>
      path.endsWith('commentid/all')
        ? {
            code: 0,
            data: { finishCommentIDs: ['c1'], wholeCommentIDs: ['c2'], partCommentIDs: ['c3'] },
          }
        : {
            code: 0,
            data: {
              comments: {
                c1: thread('c1', 1, '已处理'),
                c2: thread('c2', 0, 'a &lt;b&gt; &amp; c', '回复'),
                c3: { ...thread('c3', 0, '这句'), is_whole: 0, quote: '原文&amp;' },
              },
            },
          },
    );
    const list = await new DocComments(web).list(DOC);
    expect(
      list.map((c) => [c.id, c.whole, c.quote, c.solved, c.replies.map((r) => r.content)]),
    ).toEqual([
      ['c2', true, '', false, ['a <b> & c', '回复']],
      ['c3', false, '原文&', false, ['这句']],
      ['c1', true, '', true, ['已处理']],
    ]);
    const batch = calls.find(([, p]) => p.endsWith('comment/batch'))?.[2].form;
    expect(batch?.comment_ids).toEqual(['c2', 'c3', 'c1']);
  });

  test('加评论和回复时把 < > & 转义（服务端拒收原样的 <）', async () => {
    const { web, calls } = fake(() => ({ code: 0, data: { comment: thread('c9', 0, 'x') } }));
    const comments = new DocComments(web);
    await comments.add(DOC, '<b> & c');
    await comments.reply(DOC, 'c9', '1 < 2');
    expect(calls.map(([, , o]) => o.form?.content)).toEqual(['&lt;b&gt; &amp; c', '1 &lt; 2']);
  });

  test('解决、重新打开、删除都走 update，分别带 finish=1、finish=0、is_deleted=1', async () => {
    const { web, calls } = fake(() => ({ code: 0 }));
    const comments = new DocComments(web);
    await comments.resolve(DOC, 'c1');
    await comments.resolve(DOC, 'c1', false);
    await comments.remove(DOC, 'c1');
    expect(calls.map(([, , o]) => [o.form?.finish, o.form?.is_deleted])).toEqual([
      [1, undefined],
      [0, undefined],
      [undefined, 1],
    ]);
  });
});

describe('文档权限', () => {
  test('链接分享范围按服务端的数值翻成名字；认不出的给 unknown', async () => {
    let entity = 2;
    const { web } = fake(() => ({
      code: 0,
      data: { perm_public: { link_share_entity: entity, external_access_switch: false } },
    }));
    const perms = new DocPermissions(web);
    expect(await perms.sharing(DOC)).toEqual({ linkShare: 'tenant-view', externalAccess: false });
    entity = 9;
    expect((await perms.sharing(DOC)).linkShare).toBe('unknown');
  });
});
