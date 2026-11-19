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

  test('挂在文档块上的大文件：prepare 的 extra 是对象（字符串会被服务端拒成 400），小文件的上传参数里是字符串', async () => {
    const { docs, calls } = fake((_m, path) => {
      if (path.endsWith('upload/prepare/'))
        return { code: 0, data: { upload_id: 'u1', block_size: 4 * 1024 * 1024, num_blocks: 2 } };
      return { code: 0, data: { file_token: 'ft' } };
    });
    const mount = { point: 'docx_file', node: 'blk', extra: { drive_route_token: 'D' } };
    await docs.upload(new Uint8Array(3), 'a.txt', { mount });
    await docs.upload(new Uint8Array(4 * 1024 * 1024 + 1), 'b.mp4', { mount });
    expect(calls.find(([, p]) => p.endsWith('upload/all/'))?.[2].query?.['ext[extra]']).toBe(
      JSON.stringify({ drive_route_token: 'D' }),
    );
    expect(calls.find(([, p]) => p.endsWith('upload/prepare/'))?.[2].json).toMatchObject({
      mount_point: 'docx_file',
      mount_node_token: 'blk',
      extra: { drive_route_token: 'D' },
    });
  });

  test('思维笔记读成大纲：标题作一级标题，主题按层级缩进成列表，已完成的划掉', async () => {
    const node = (text: string, children: unknown[] = [], finish = false) => ({
      text: [{ text, type: 1 }],
      children,
      finish,
    });
    const { docs } = fake(() => ({
      code: 0,
      data: {
        data: {
          title: '季度计划',
          collab_client_vars: {
            nodes: [node('目标', [node('增长'), node('留存', [], true)]), node('风险')],
          },
        },
      },
    }));
    expect((await docs.fetchMindnote('https://t.example.com/mindnotes/Mn1')).markdown).toBe(
      '# 季度计划\n\n- 目标\n  - 增长\n  - ~~留存~~\n- 风险\n',
    );
  });

  test('幻灯片按页读出文本框里的文字：去掉行标记字符，每行一段，页按 slides 的顺序', async () => {
    const box = (text: string, marked: boolean) => ({
      data: {
        type: 'shape',
        shape: {
          text: {
            content: {
              apool: {
                numToAttrib: marked
                  ? { 0: ['author', 'u'], 1: ['lmkr', '1'] }
                  : { 0: ['author', 'u'] },
              },
              initialAttributedTexts: { text: { 0: text } },
            },
          },
        },
      },
    });
    const { docs } = fake(() => ({
      code: 0,
      data: {
        block_sequence: ['D'],
        block_map: {
          D: { data: { type: 'presentation', title: '季度回顾', slides: ['s2', 's1'] } },
          s1: { data: { type: 'slide', children: ['a', 'b'] } },
          s2: { data: { type: 'slide', children: ['c'] } },
          a: box('*要点', true),
          b: box('*增长\n*留存', true),
          c: box('*开头', false),
        },
      },
    }));
    expect((await docs.fetchSlides('https://t.example.com/slides/D')).markdown).toBe(
      '# 季度回顾\n\n## 第 1 页\n\n*开头\n\n## 第 2 页\n\n要点\n\n增长\n\n留存\n',
    );
  });

  test('画板节点：取文字、左上角坐标和大小、形状类型；docx 里的画板块读成 [画板](token)', async () => {
    const { docs, calls } = fake((_m, path) =>
      path.endsWith('whiteboard/block')
        ? {
            code: 0,
            data: {
              nodes: [
                {
                  id: 'o1:1',
                  info: {
                    baseV2: { x: 10, y: 20, width: 170, height: 80 },
                    textV2: { text: '流程开始' },
                    compositeShape: { shapeType: 8 },
                  },
                },
                { id: 'o1:2', info: { baseV2: { x: 0, y: 0, width: 5, height: 5 } } },
              ],
            },
          }
        : {
            code: 0,
            data: {
              block_sequence: ['D'],
              block_map: {
                D: { data: { type: 'page', children: ['w'] } },
                w: { data: { type: 'whiteboard', token: 'WB1' } },
              },
            },
          },
    );
    expect(await docs.whiteboard('WB1')).toEqual([
      { id: 'o1:1', text: '流程开始', x: 10, y: 20, width: 170, height: 80, shapeType: 8 },
      { id: 'o1:2', text: '', x: 0, y: 0, width: 5, height: 5 },
    ]);
    expect(calls[0]?.[2].query).toMatchObject({ blockToken: 'WB1' });
    expect((await docs.fetch('D')).markdown).toContain('[画板](WB1)');
  });

  test('画板图片：取服务端渲染的预览图，扩展名按文件头而不是 content-type；不是图片时报错', async () => {
    // A JPEG header (SOI + APP0 + SOF0 with a 4x3 size) is enough for imageInfo.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 4, 3, 1, 0x22, 0,
    ]);
    const { docs, calls } = fake(
      () => ({}),
      new Response(jpeg, { headers: { 'content-type': 'image/png' } }),
    );
    const file = await docs.whiteboardImage('WB1');
    expect(file.name).toBe('WB1.jpg');
    expect(calls[0]?.[1]).toBe('/space/api/file/f/cdp-whiteboard-WB1~noop/');
    const html = fake(() => ({}), new Response('<html></html>'));
    await expect(html.docs.whiteboardImage('WB1')).rejects.toThrow('不是图片');
  });

  test('删除要等服务端的异步任务：任务完成才算成功，任务失败如实报出', async () => {
    const polls: string[] = [];
    const { docs } = fake((_m, path, o) => {
      if (path.endsWith('remove/'))
        return { code: 0, data: { task_id: `t-${(o.json as { tokens: string[] }).tokens[0]}` } };
      const task = String(o.query?.task_id);
      polls.push(task);
      if (task === 't-a' && polls.filter((p) => p === 't-a').length < 2)
        return { code: 0, data: { is_finish: false } };
      return { code: 0, data: { is_finish: true, is_fail: task === 't-bad' } };
    });
    expect([...(await docs.remove(['a', 'bad']))]).toEqual([['bad', '服务端任务失败']]);
    expect(polls.filter((p) => p === 't-a')).toHaveLength(2);
  });
});
