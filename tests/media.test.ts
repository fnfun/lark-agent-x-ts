import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import {
  listFolder,
  mp4DurationMs,
  oggOpusDurationMs,
  unpackArchive,
  uploadFile,
  uploadImage,
} from '../src/media.js';
import { toDict } from '../src/proto/dict.js';
import { larkType, protoType } from '../src/proto/registry.js';
import { urls } from '../src/region.js';
import { newClient } from './helpers.js';

const auth = {
  region: { name: 'feishu', domain: 'example.invalid' },
  cookies: { session: 's1' },
  gatewayAppId: '1',
} as unknown as LarkAuth;

describe('上传图片与文件', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { path: string; cookie: string | null; field: string; name: string; size: number }[] =
    [];
  let fileReply: unknown;
  const origHost = urls.fileHost;
  beforeEach(() => {
    seen.length = 0;
    fileReply = undefined;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        const [field, value] = [...form.entries()][0] as [string, File];
        seen.push({
          path: new URL(req.url).pathname,
          cookie: req.headers.get('cookie'),
          field,
          name: value.name,
          size: value.size,
        });
        if (field === 'image') return new Response('\n1img_v3_0001_aa-bb');
        return Response.json(
          fileReply ?? {
            status: 'success',
            data: {
              key: 'file_v3_0001_cc',
              name: value.name,
              size: value.size,
              mimetype: 'text/plain',
            },
          },
        );
      },
    });
    urls.fileHost = () => `http://localhost:${server.port}`;
  });
  afterEach(() => {
    urls.fileHost = origHost;
    server.stop(true);
  });

  test('图片表单字段为 image，从纯文本响应里取 key；文件上传到会话并带回服务端记录', async () => {
    expect(await uploadImage(auth, new Uint8Array(5), 'a.png')).toBe('img_v3_0001_aa-bb');
    expect(await uploadFile(auth, '7200000000000000001', new Uint8Array(7), '周报.txt')).toEqual({
      key: 'file_v3_0001_cc',
      name: '周报.txt',
      size: 7,
      mime: 'text/plain',
    });
    expect(seen).toEqual([
      { path: '/api/image', cookie: 'session=s1', field: 'image', name: 'a.png', size: 5 },
      {
        path: '/api/chats/7200000000000000001/files',
        cookie: 'session=s1',
        field: 'file',
        name: '周报.txt',
        size: 7,
      },
    ]);
    fileReply = { status: 'fail', message: 'file too large' };
    await expect(uploadFile(auth, 'c1', new Uint8Array(1), 'x')).rejects.toThrow(
      '文件上传失败: file too large',
    );
  });

  test('sendMessage 发图片/文件：先上传，图片 key 放 cryptoToken，文件带名字、大小与类型', async () => {
    const c = newClient();
    Object.assign(c.auth, auth);
    c.isThreadChat = async () => false;
    const sent: Record<string, unknown>[] = [];
    const reply = toBinary(
      protoType('Packet'),
      create(protoType('Packet'), {
        payload: toBinary(
          protoType('PutMessageResponse'),
          create(protoType('PutMessageResponse'), { message: { id: '7000000000000000009' } }),
        ),
      } as Record<string, unknown>),
    );
    c.gatewayPost = async (pkt) => {
      const payload = (pkt as unknown as { payload: Uint8Array }).payload;
      sent.push(
        toDict(protoType('PutMessageRequest'), fromBinary(protoType('PutMessageRequest'), payload)),
      );
      return reply;
    };
    expect(await c.sendMessage('c1', { image: new Uint8Array(3), name: 'shot.png' })).toBe(
      '7000000000000000009',
    );
    expect(
      await c.sendMessage('c1', { file: new Uint8Array(4), name: 'log.txt' }, { rootId: 'r1' }),
    ).toBe('7000000000000000009');
    expect(sent.map((r) => [r.type, r.chatId, r.content, r.rootId])).toEqual([
      [5, 'c1', { cryptoToken: 'img_v3_0001_aa-bb' }, undefined],
      [
        3,
        'c1',
        { fileKey: 'file_v3_0001_cc', fileName: 'log.txt', fileMime: 'text/plain', fileSize: 4n },
        'r1',
      ],
    ]);
  });
});

describe('文件夹与压缩包浏览', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: string[] = [];
  let unpackPolls = 0;
  const origHost = urls.fileHost;
  const pb = (type: string, init: Record<string, unknown>) =>
    new Response(toBinary(larkType(type), create(larkType(type), init)));
  const info = (n: number, folder = false) => ({
    key: `file_v3_k${n}`,
    ownerId: 7000000000000000001n,
    ownerName: '同事甲',
    type: folder ? 9 : 1,
    name: folder ? `目录${n}` : `文件${n}.txt`,
    size: BigInt(n),
    createTime: 1_790_000_000n,
  });
  beforeEach(() => {
    seen.length = 0;
    unpackPolls = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const q = u.searchParams;
        seen.push(`${u.pathname} key=${q.get('key')} start=${q.get('start')}`);
        if (u.pathname === '/api/package/uncompress') {
          if (q.get('key') === 'file_v3_bad')
            return Response.json(
              { code: 900, message: '解压失败，暂不支持此文件格式' },
              { status: 400 },
            );
          // Still unpacking on the first poll
          if (++unpackPolls === 1)
            return pb('pan.UnCompressPackageResponse', { queryProgressIntervalMs: 1n });
          return pb('pan.UnCompressPackageResponse', {
            folderKey: 'file_v3_root',
            browseResult: { infos: [info(1)], allCount: 1n },
          });
        }
        // Two pages: the first says there is more
        const start = Number(q.get('start'));
        return pb('pan.BrowseFolderResponse', {
          infos: start === 0 ? [info(1), info(2, true)] : [info(3)],
          allCount: 3n,
          hasMore: start === 0,
        });
      },
    });
    urls.fileHost = () => `http://localhost:${server.port}`;
  });
  afterEach(() => {
    urls.fileHost = origHost;
    server.stop(true);
  });

  test('浏览文件夹按已取条数翻页直到没有更多；子文件夹标为 folder', async () => {
    const entries = await listFolder(auth, 'file_v3_root');
    expect(entries.map((e) => [e.name, e.folder, e.size])).toEqual([
      ['文件1.txt', false, 1],
      ['目录2', true, 2],
      ['文件3.txt', false, 3],
    ]);
    expect(entries[0]?.ownerName).toBe('同事甲');
    expect(seen).toEqual([
      '/api/folder/browse key=file_v3_root start=0',
      '/api/folder/browse key=file_v3_root start=2',
    ]);
  });

  test('解压压缩包：解压中就按服务端给的间隔再问，完成后返回解压出的文件夹 key；失败带服务端原因', async () => {
    expect(await unpackArchive(auth, 'file_v3_zip')).toBe('file_v3_root');
    expect(unpackPolls).toBe(2);
    await expect(unpackArchive(auth, 'file_v3_bad')).rejects.toMatchObject({
      status: 400,
      reason: '解压失败，暂不支持此文件格式',
    });
  });
});

describe('音视频时长（只读容器头，不解码）', () => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const box = (type: string, payload: number[]) => [
    ...be32(8 + payload.length),
    ...[...type].map((ch) => ch.charCodeAt(0)),
    ...payload,
  ];

  test('MP4：在 moov 里找 mvhd，按版本取 timescale 与 duration', () => {
    // version 0: flags, creation, modification, timescale=1000, duration=6038
    const v0 = [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1000), ...be32(6038)];
    // version 1: 64-bit times; timescale=600, duration=3000 (5 s)
    const v1 = [1, 0, 0, 0, ...Array(16).fill(0), ...be32(600), ...be32(0), ...be32(3000)];
    const file = (mvhd: number[]) =>
      new Uint8Array([...box('ftyp', [0, 0, 0, 0]), ...box('moov', box('mvhd', mvhd))]);
    expect(mp4DurationMs(file(v0))).toBe(6038);
    expect(mp4DurationMs(file(v1))).toBe(5000);
    expect(mp4DurationMs(new Uint8Array(box('ftyp', [0, 0, 0, 0])))).toBeNull();
  });

  test('Ogg/Opus：最后一页的 granule 减去 OpusHead 的 pre-skip，按 48kHz 换成毫秒', () => {
    const le = (n: bigint, bytes: number) =>
      Array.from({ length: bytes }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
    const page = (granule: bigint, body: number[]) => [
      ...[...'OggS'].map((ch) => ch.charCodeAt(0)),
      0,
      0,
      ...le(granule, 8),
      ...Array(12).fill(0),
      1,
      body.length,
      ...body,
    ];
    // OpusHead: version 1, 1 channel, pre-skip 312, 48 kHz
    const head = [...[...'OpusHead'].map((ch) => ch.charCodeAt(0)), 1, 1, ...le(312n, 2), 0, 0];
    const ogg = new Uint8Array([
      ...page(0n, head),
      ...page(48_000n + 312n, [0]),
      ...page(0xffffffffffffffffn, [0]),
    ]);
    expect(oggOpusDurationMs(ogg)).toBe(1000);
    expect(oggOpusDurationMs(new Uint8Array(64))).toBeNull();
  });
});
