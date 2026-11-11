import { describe, expect, test } from 'bun:test';
import { MindnoteEditor } from '../src/domains/mindnote.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Dict = Record<string, unknown>;
const topic = (text: string, ...children: Dict[]) => ({
  id: text,
  text: [{ type: 1, text }],
  children,
});

/** A mindnote at version 5: 甲 (甲一 (甲一一), 甲二), 乙. */
function fakeMindnote() {
  const posts: WebRequest[] = [];
  const web = {
    json: async (method: string, _path: string, o: WebRequest = {}) => {
      if (method === 'GET')
        return {
          code: 0,
          data: {
            data: {
              version: 5,
              collab_client_vars: {
                nodes: [topic('甲', topic('甲一', topic('甲一一')), topic('甲二')), topic('乙')],
              },
            },
          },
        };
      posts.push(o);
      return { code: 0, data: { type: 'ACCEPT_COMMIT' } };
    },
  } as unknown as WebSession;
  return { editor: new MindnoteEditor(web), posts };
}

type Op = { p: (string | number)[]; action: { li: Dict & { children: Dict[] } } };
const opsOf = (o: WebRequest | undefined) =>
  ((o as WebRequest).json as { operations: Op[] }).operations;

describe('思维笔记加主题', () => {
  test('大纲按层级成为一棵子树，追加在最外层末尾；带删除线或勾选的记为已完成；按当前版本提交', async () => {
    const { editor, posts } = fakeMindnote();
    expect(await editor.append('T', '- 丙\n  - 丙一\n  - ~~丙二~~\n- [x] 丁')).toBe(2);
    const json = posts[0]?.json as Dict;
    expect(json.version).toBe(5);
    const ops = opsOf(posts[0]);
    expect(ops.map((o) => o.p)).toEqual([
      ['nodes', 2],
      ['nodes', 3],
    ]);
    const [c, d] = ops.map((o) => o.action.li);
    expect(c?.text).toEqual([{ type: 1, text: '丙' }]);
    expect(c?.children.map((x) => [x.text, x.finish])).toEqual([
      [[{ type: 1, text: '丙一' }], undefined],
      [[{ type: 1, text: '丙二' }], true],
    ]);
    expect(d?.finish).toBe(true);
    expect(String(c?.id)).toMatch(/^[0-9a-f]{32}$/);
  });

  test('--under：加在第一个文字相同的主题（含深层）的子主题末尾；没有这个主题时什么都不提交', async () => {
    const { editor, posts } = fakeMindnote();
    await editor.append('T', '新', { under: '甲一' });
    expect(opsOf(posts[0])[0]?.p).toEqual(['nodes', 0, 'children', 0, 'children', 1]);
    await expect(editor.append('T', '新', { under: '没有' })).rejects.toThrow('没有这个主题');
    expect(posts).toHaveLength(1);
  });
});
