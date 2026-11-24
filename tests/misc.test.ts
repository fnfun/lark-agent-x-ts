import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { create, toBinary } from '@bufbuild/protobuf';
import { loadConfig } from '../src/config.js';
import { extractResourceKey, messageResourceUrl } from '../src/media.js';
import { enumToInt, isThreadChat, resolveScope, richTextImageKeys } from '../src/proto/decoders.js';
import { larkType } from '../src/proto/registry.js';
import { getRegion, urls } from '../src/region.js';

const KEYS = [
  'LARKX_REGION',
  'LARKX_MARK_READ',
  'LARKX_STORAGE_URL',
  'LARKX_TRIGGER_KEYWORDS',
  'LARKX_HOME',
  'LARKX_ACCOUNT',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  // An account exported in the shell would move the data directory away from LARKX_HOME
  delete process.env.LARKX_ACCOUNT;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('配置', () => {
  test('默认值与环境变量覆盖；空串视为未设置', () => {
    process.env.LARKX_HOME = '/data/larkx';
    process.env.LARKX_REGION = 'lark';
    process.env.LARKX_MARK_READ = 'false';
    process.env.LARKX_STORAGE_URL = '';
    process.env.LARKX_TRIGGER_KEYWORDS = '导出, 月报';
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      region: 'lark',
      mark_read: false,
      storage_url: 'sqlite:////data/larkx/messages.db',
      context_scope: 'anchor',
      agent_backend: 'claude',
    });
    expect(cfg.triggers.keywords).toEqual(['导出', '月报']);
    delete process.env.LARKX_MARK_READ;
    expect(loadConfig().mark_read).toBe(true);
  });

  test('区域决定各接口的域名', () => {
    const lark = getRegion('Lark');
    expect(urls.gateway(lark)).toBe('https://internal-api-lark-api.larksuite.com/im/gateway/');
    expect(urls.ws(getRegion('feishu'))).toBe('wss://msg-frontier.feishu.cn/ws/v2');
    expect(() => getRegion('x')).toThrow("未知区域: 'x'");
  });
});

describe('会话归属与资源', () => {
  test('scope/anchor：私聊不分话题；回复归到话题；话题群的根消息自成话题（系统消息除外）', () => {
    expect(resolveScope('m1', 4, 1, 'r1', 't1')).toEqual(['chat', '']);
    expect(resolveScope('m1', 4, 2, 'r1', 't1')).toEqual(['topic', 't1']);
    expect(resolveScope('m1', 4, 2, 'r1', '')).toEqual(['topic', 'r1']);
    expect(resolveScope('m1', 4, 2, '0', 'm1')).toEqual(['chat', '']);
    expect(resolveScope('m1', 4, 2, '', '', true)).toEqual(['topic', 'm1']);
    expect(resolveScope('m1', 6, 3, '', '')).toEqual(['chat', '']);
    expect(isThreadChat({ chatMode: 3, type: 2 })).toBe(true);
    expect(isThreadChat({ type: 3 })).toBe(true);
    expect(isThreadChat({ chatMode: 1, type: 2 })).toBe(false);
    expect(enumToInt('IMAGE')).toBe(5);
    expect(enumToInt('12')).toBe(12);
  });

  test('资源 key 与下载地址', () => {
    expect(extractResourceKey(5, { imageV2: { imageKey: 'img_v3_a' } })).toBe('img_v3_a');
    expect(extractResourceKey(5, { image: { origin: { key: 'img_o' } } })).toBe('img_o');
    expect(extractResourceKey(3, { key: 'file_v3_x' })).toBe('file_v3_x');
    expect(extractResourceKey(4, { key: 'x' })).toBe('');
    expect(messageResourceUrl('m1', 'k1', 'c1', 'https://h')).toBe(
      'https://h/download/messages/m1/keys/k1?chat_id=c1',
    );
  });

  test('富文本里的图片 key：按 imageIds 顺序、去重；本地库的 <n bytes> 占位取不出', () => {
    // Guards lark download on rich-text messages: images there have no top-level key
    const t = larkType('entities.RichTextElement.ImageProperty');
    const img = (token: string) => toBinary(t, create(t, { token }));
    const dictionary = {
      '1': { tag: 1, property: new Uint8Array() },
      '2': { tag: 2, property: img('img_v3_b') },
      '3': { tag: 2, property: img('img_v3_a') },
      '4': { tag: 2, property: img('img_v3_b') },
    };
    const richText = { imageIds: ['3', '2', '4'], elements: { dictionary } };
    expect(richTextImageKeys({ richText })).toEqual(['img_v3_a', 'img_v3_b']);
    // Without imageIds every image element counts, in dictionary order
    expect(richTextImageKeys({ richText: { elements: { dictionary } } })).toEqual([
      'img_v3_b',
      'img_v3_a',
    ]);
    const stored = {
      richText: {
        imageIds: ['2'],
        elements: { dictionary: { '2': { tag: 2, property: '<12 bytes>' } } },
      },
    };
    expect(richTextImageKeys(stored)).toEqual([]);
    expect(richTextImageKeys(null)).toEqual([]);
  });
});
