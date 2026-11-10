import { describe, expect, test } from 'bun:test';
import { Wiki, wikiToken } from '../src/domains/wiki.js';
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
  return { wiki: new Wiki(web), calls };
}

const node = (token: string, space: string, parent: string, objType = 22) => ({
  wiki_token: token,
  space_id: space,
  parent_wiki_token: parent,
  obj_token: `o${token}`,
  obj_type: objType,
  title: `页面${token}`,
});

describe('知识库', () => {
  test('列空间：个人文档库在前；其他空间按 last_label 翻页并去重；没有个人库时跳过', async () => {
    const pages = [
      { spaces: [{ space_id: 's2', space_name: '项目协作' }], has_more: true, last_label: 'p1' },
      { spaces: [{ space_id: 's1' }, { space_id: 's3', space_name: '手册' }], has_more: false },
    ];
    let n = 0;
    let library: unknown = { code: 0, data: { space_id: 's1', space_name: '我的文档库' } };
    const { wiki, calls } = fake((path) =>
      path.endsWith('my_library/get/') ? library : { code: 0, data: pages[n++ % 2] },
    );
    expect((await wiki.spaces()).map((sp) => [sp.id, sp.personal])).toEqual([
      ['s1', true],
      ['s2', false],
      ['s3', false],
    ]);
    expect(
      calls.filter(([, p]) => p.endsWith('space/get/')).map(([, , o]) => o.query?.last_label),
    ).toEqual(['', 'p1']);
    library = { code: 920004002, msg: 'SourceNotExist', data: '' };
    expect((await wiki.spaces()).map((sp) => sp.id)).toEqual(['s2', 's1', 's3']);
  });

  test('不给父页面时先查空间的根节点，再取它的子页面', async () => {
    const { wiki } = fake((path) =>
      path.endsWith('space/get_info/')
        ? { code: 0, data: { space_info: { s1: { root_token: 'root' } } } }
        : { code: 0, data: { root: [node('a', 's1', 'root'), node('b', 's1', 'root', 3)] } },
    );
    expect((await wiki.children('s1')).map((n) => [n.wikiToken, n.type, n.objToken])).toEqual([
      ['a', 'docx', 'oa'],
      ['b', 'sheet', 'ob'],
    ]);
  });

  test('移动：旧父页面和旧空间取自页面本身，新空间取自新父页面（可跨空间）', async () => {
    const nodes: Record<string, unknown> = { a: node('a', 's1', 'p0'), p9: node('p9', 's2', 'r2') };
    const { wiki, calls } = fake((path, o) =>
      path.endsWith('get_node/')
        ? { code: 0, data: nodes[String(o.query?.wiki_token)] }
        : { code: 0 },
    );
    await wiki.move('https://t.example.com/wiki/a', 'p9');
    expect(calls.at(-1)?.[2].json).toMatchObject({
      wiki_token: 'a',
      old_parent_wiki_token: 'p0',
      old_space_id: 's1',
      new_parent_wiki_token: 'p9',
      new_space_id: 's2',
    });
  });

  test('改名：文档页面走知识库的改标题接口，表格页面改它自己的表格标题', async () => {
    const nodes: Record<string, unknown> = { d: node('d', 's1', 'r'), t: node('t', 's1', 'r', 3) };
    const { wiki, calls } = fake((path, o) =>
      path.endsWith('get_node/')
        ? { code: 0, data: nodes[String(o.query?.wiki_token)] }
        : { code: 0 },
    );
    await wiki.rename('d', '新标题');
    await wiki.rename('t', '新表格');
    expect(calls.filter(([m]) => m === 'POST').map(([, p]) => p)).toEqual([
      '/space/api/wiki/v2/tree/update_title/',
      '/space/api/sheet/update_meta/',
    ]);
  });

  test('知识库链接里取 wiki_token；裸 token 原样返回', () => {
    expect(wikiToken('https://t.example.com/wiki/Wk1?from=x')).toBe('Wk1');
    expect(wikiToken(' Wk1 ')).toBe('Wk1');
  });
});
