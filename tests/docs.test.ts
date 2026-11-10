import { describe, expect, test } from 'bun:test';
import { adler32, Docs, dispositionName, docRef, docToken } from '../src/domains/docs.js';
import type { WebRequest, WebSession } from '../src/web.js';

type Call = [string, string, WebRequest];

/** Fake WebSession: records calls and answers by path; raw requests (downloads) get `raw`. */
function fake(reply: (method: string, path: string, o: WebRequest) => unknown, raw?: Response) {
  const calls: Call[] = [];
  const web = {
    json: async (method: string, path: string, o: WebRequest = {}) => {
      calls.push([method, path, o]);
      return reply(method, path, o);
    },
    request: async (method: string, path: string, o: WebRequest = {}) => {
      calls.push([method, path, o]);
      return raw ?? new Response('');
    },
    origin: async () => 'https://tenant.feishu.cn',
  } as unknown as WebSession;
  return { docs: new Docs(web), calls };
}

const node = (token: string, type: number, name: string) => ({
  token,
  obj_token: `o${token}`,
  type,
  name,
});

const ROOT_LISTING = {
  code: 0,
  data: { node_list: ['root'], entities: { nodes: { root: node('root', 4, '我的空间') } } },
};

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

  test('读正文：按游标翻页合并块，标题取页面块，正文按子块深度优先的顺序转成 Markdown', async () => {
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
      markdown: '# 周会纪要\n\n议题一\n结论\n\n议题二\n',
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

  test('链接按路径认类型，裸 token 用给定的类型（默认 docx）', () => {
    expect(docRef('https://t.example.com/sheets/Sh1?x=1')).toEqual({ type: 'sheet', token: 'Sh1' });
    expect(docRef('https://t.example.com/drive/folder/Fd1')).toEqual({
      type: 'folder',
      token: 'Fd1',
    });
    expect(docRef('https://t.example.com/file/Fl1', 'docx')).toEqual({
      type: 'file',
      token: 'Fl1',
    });
    expect(docRef('Ab1')).toEqual({ type: 'docx', token: 'Ab1' });
    expect(docRef('Ab1', 'base')).toEqual({ type: 'base', token: 'Ab1' });
  });

  test('改名按类型走各自的接口，新名字放进请求；服务端报错时抛出原因', async () => {
    const { docs, calls } = fake((_m, path) =>
      path.includes('bitable') ? { code: 4, msg: '无权限' } : { code: 0 },
    );
    for (const type of ['docx', 'sheet', 'file', 'folder', 'mindnote'] as const)
      await docs.rename({ type, token: 'T1' }, '新名字');
    expect(calls.map(([, p]) => p)).toEqual([
      '/space/api/doc.v2/update_title',
      '/space/api/sheet/update_meta/',
      '/space/api/box/file/update_info/',
      '/space/api/explorer/v2/rename/',
      '/space/api/meta/update/',
    ]);
    for (const [, , o] of calls) expect(JSON.stringify(o.json ?? o.form)).toContain('新名字');
    await expect(docs.rename({ type: 'base', token: 'T1' }, 'x')).rejects.toThrow('无权限');
  });

  test('移动不指定目标时放回"我的空间"根目录；逐个移动，失败的单独报', async () => {
    const { docs, calls } = fake((_m, path, o) => {
      if (path.endsWith('my_space/obj/')) return ROOT_LISTING;
      return o.form?.src_token === 'bad' ? { code: 3, msg: 'Not Found' } : { code: 0 };
    });
    expect([...(await docs.move(['a', 'bad']))]).toEqual([['bad', 'Not Found']]);
    const moves = calls.filter(([, p]) => p.endsWith('/move/')).map(([, , o]) => o.form);
    expect(moves).toEqual([
      { src_token: 'a', dest_token: 'root' },
      { src_token: 'bad', dest_token: 'root' },
    ]);
  });

  test('上传：不超过 4MB 一次传完；更大的先 prepare，再按服务端给的块大小逐块传（每块各自校验和），最后 finish', async () => {
    const blocks: [number, number, string][] = [];
    const { docs, calls } = fake((_m, path, o) => {
      if (path.endsWith('my_space/obj/')) return ROOT_LISTING;
      if (path.endsWith('upload/prepare/'))
        return { code: 0, data: { upload_id: 'u1', block_size: 3 * 1024 * 1024, num_blocks: 2 } };
      if (path.endsWith('v3/block/')) {
        const q = o.query as Record<string, string | number>;
        blocks.push([Number(q.seq), Number(q.size), String(q.checksum)]);
        return { code: 0 };
      }
      return { code: 0, data: { file_token: 'ft', extra: { node_token: 'nt' } } };
    });
    const small = await docs.upload(new Uint8Array(10), 'a.txt');
    expect([small.token, small.objToken, small.type]).toEqual(['nt', 'ft', 'file']);
    expect(calls.filter(([, p]) => p.includes('upload')).map(([, p]) => p)).toEqual([
      '/space/api/box/stream/upload/all/',
    ]);

    const size = 4 * 1024 * 1024 + 5;
    const big = new Uint8Array(size).map((_, i) => i % 251);
    expect((await docs.upload(big, 'b.bin')).objToken).toBe('ft');
    const second = big.slice(3 * 1024 * 1024);
    expect(blocks).toEqual([
      [0, 3 * 1024 * 1024, String(adler32(big.slice(0, 3 * 1024 * 1024)))],
      [1, second.length, String(adler32(second))],
    ]);
    const finish = calls.find(([, p]) => p.endsWith('upload/finish/'));
    expect(finish?.[2].json).toMatchObject({ num_blocks: 2 });
  });

  test('导出：不支持的格式直接报错；任务完成后按结果里的文件 token 下载，文件名取响应头', async () => {
    let polls = 0;
    const { docs, calls } = fake(
      (_m, path) => {
        if (path.endsWith('export/create/')) return { code: 0, data: { ticket: 'k1' } };
        polls++;
        return {
          code: 0,
          data: { result: polls < 2 ? { job_status: 2 } : { job_status: 0, file_token: 'ef' } },
        };
      },
      new Response('PDF', {
        headers: {
          'content-disposition':
            'attachment; filename="a.pdf"; filename*=UTF-8\'\'%E5%91%A8%E6%8A%A5.pdf',
        },
      }),
    );
    await expect(docs.export({ type: 'sheet', token: 'S' }, { format: 'pdf' })).rejects.toThrow(
      'xlsx',
    );
    await expect(docs.export({ type: 'base', token: 'B' })).rejects.toThrow('不支持导出');
    const file = await docs.export({ type: 'docx', token: 'D' }, { format: 'pdf' });
    expect([file.name, new TextDecoder().decode(file.data)]).toEqual(['周报.pdf', 'PDF']);
    expect(calls.at(-1)?.[1]).toBe('/space/api/box/stream/download/all/ef/');
  });

  test('下载文件名：优先取 UTF-8 编码的那份', () => {
    expect(dispositionName(`attachment; filename="x.txt"; filename*=UTF-8''%E6%96%87.txt`)).toBe(
      '文.txt',
    );
    expect(dispositionName('attachment; filename="plain.txt"')).toBe('plain.txt');
    expect(dispositionName(null)).toBe('');
  });

  test('覆盖已有文件：小文件在上传请求里、大文件在 prepare 里带上原文件的 file_token', async () => {
    const { docs, calls } = fake((_m, path) => {
      if (path.endsWith('my_space/obj/')) return ROOT_LISTING;
      if (path.endsWith('upload/prepare/'))
        return { code: 0, data: { upload_id: 'u1', block_size: 4 * 1024 * 1024, num_blocks: 2 } };
      return { code: 0, data: {} };
    });
    const small = await docs.upload(new Uint8Array(3), 'a.md', { replace: 'F1' });
    await docs.upload(new Uint8Array(4 * 1024 * 1024 + 1), 'b.bin', { replace: 'F2' });
    expect(small.objToken).toBe('F1');
    expect(calls.find(([, p]) => p.endsWith('upload/all/'))?.[2].query?.file_token).toBe('F1');
    expect(calls.find(([, p]) => p.endsWith('upload/prepare/'))?.[2].json).toMatchObject({
      file_token: 'F2',
    });
  });
});
