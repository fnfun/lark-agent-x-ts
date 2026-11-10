import { describe, expect, test } from 'bun:test';
import { Docs, docToken } from '../src/domains/docs.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Call = [string, string, WebRequest];

/** Fake WebSession: records calls and answers by path. */
function fake(reply: (method: string, path: string, o: WebRequest) => unknown) {
  const calls: Call[] = [];
  const web = {
    json: async (method: string, path: string, o: WebRequest = {}) => {
      calls.push([method, path, o]);
      return reply(method, path, o);
    },
  } as unknown as WebSession;
  return { docs: new Docs(web), calls };
}

const node = (token: string, type: number, name: string) => ({
  token,
  obj_token: `o${token}`,
  type,
  name,
});

describe('云文档', () => {
  test('列目录只认 node_list：跳过"我的空间"根节点和文件夹自己；根目录先列文件夹再列文档', async () => {
    const { docs } = fake((_m, path) => {
      if (path.endsWith('my_space/folder/'))
        return {
          code: 0,
          data: { node_list: ['f1'], entities: { nodes: { f1: node('f1', 0, '周报') } } },
        };
      if (path.endsWith('my_space/obj/'))
        return {
          code: 0,
          data: {
            node_list: ['root', 'd1'],
            entities: { nodes: { root: node('root', 4, '我的空间'), d1: node('d1', 22, '纪要') } },
          },
        };
      return {
        code: 0,
        data: { node_list: [], entities: { nodes: { f1: node('f1', 0, '周报') } } },
      };
    });
    expect((await docs.list()).map((f) => [f.token, f.type, f.objToken])).toEqual([
      ['f1', 'folder', 'of1'],
      ['d1', 'docx', 'od1'],
    ]);
    expect(await docs.list('f1')).toEqual([]);
  });

  test('搜索：按返回的 token 顺序取对象，去掉标题和摘要里的高亮标记', async () => {
    const { docs } = fake(() => ({
      code: 0,
      data: {
        tokens: ['b', 'a'],
        entities: {
          objs: {
            a: { token: 'a', type: 3, title: '<em>月报</em>数据' },
            b: { token: 'b', type: 22, title: '<em>月报</em>', preview: '本月<em>月报</em>' },
          },
        },
      },
    }));
    expect(
      (await docs.search('月报')).map((h) => [h.objToken, h.type, h.title, h.preview]),
    ).toEqual([
      ['b', 'docx', '月报', '本月月报'],
      ['a', 'sheet', '月报数据', ''],
    ]);
  });

  test('读正文：按游标翻页合并块，标题取页面块，正文按子块深度优先的顺序', async () => {
    const block = (text: string, children: string[] = []) => ({
      data: { text: { initialAttributedTexts: { text: { '0': text } } }, children },
    });
    const pages = [
      {
        code: 0,
        data: {
          block_sequence: ['p'],
          block_map: { p: block('周会纪要', ['a', 'b']), a: block('议题一', ['a1']) },
          has_more: true,
          cursor: 'c1',
        },
      },
      { code: 0, data: { block_map: { a1: block('结论'), b: block('议题二') }, has_more: false } },
    ];
    let n = 0;
    const { docs, calls } = fake(() => pages[n++]);
    expect(await docs.fetch('https://x.example.com/docx/AbC123?from=im')).toEqual({
      objToken: 'AbC123',
      title: '周会纪要',
      paragraphs: ['议题一', '结论', '议题二'],
    });
    expect(calls.map(([, , o]) => o.query?.cursor)).toEqual([undefined, 'c1']);
  });

  test('新建：文件夹和文档走不同的接口；删除逐个调用，一个失败不影响其他', async () => {
    const { docs, calls } = fake((_m, path, o) => {
      if (path.endsWith('remove/'))
        return (o.json as { tokens: string[] }).tokens[0] === 'bad'
          ? { code: 404, msg: 'Not Found' }
          : { code: 0 };
      return {
        code: 0,
        data: { node_list: ['n1'], entities: { nodes: { n1: node('n1', 22, '纪要') } } },
      };
    });
    await docs.create('周报', { type: 'folder', folder: 'f0' });
    await docs.create('纪要');
    expect(calls.map(([m, p, o]) => [m, p, o.form?.type, o.form?.parent_token])).toEqual([
      ['POST', '/space/api/explorer/v2/create/folder/', undefined, 'f0'],
      ['POST', '/space/api/explorer/v2/create/object/', 22, ''],
    ]);
    expect([...(await docs.remove(['a', 'bad', 'c']))]).toEqual([['bad', 'Not Found']]);
    expect(calls.filter(([, p]) => p.endsWith('remove/'))).toHaveLength(3);
  });

  test('文档链接里取 obj_token；裸 token 原样返回', () => {
    expect(docToken('https://t.example.com/docx/Ab12Cd?x=1')).toBe('Ab12Cd');
    expect(docToken('https://t.example.com/wiki/Zz9')).toBe('Zz9');
    expect(docToken(' Ab12Cd ')).toBe('Ab12Cd');
  });
});
