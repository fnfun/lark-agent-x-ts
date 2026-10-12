import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LarkAuth } from './auth.js';
import { loadConfig } from './config.js';
import { raiseForStatus, request } from './http.js';
import { getLogger } from './log.js';
import type { Dict } from './proto/dict.js';
import { getRegion, urls } from './region.js';

const logger = getLogger('larkx.media');
const MAX_BYTES = 200 * 1024 * 1024;

/** 资源下载地址；host 为所属区域的文件主机，不传时取 LARKX_REGION。 */
export function messageResourceUrl(
  msgId: string,
  key: string,
  chatId: string,
  host?: string,
): string {
  const h = host ?? urls.fileHost(getRegion(loadConfig().region));
  return `${h}/download/messages/${msgId}/keys/${key}?chat_id=${chatId}`;
}

/** 消息内容里的资源 key：图片取 imageKey，文件/视频/语音/表情包取 key。 */
export function extractResourceKey(msgType: number, contentData: Dict | null | undefined): string {
  if (!contentData) return '';
  if (msgType === 5) {
    const v2 = (contentData.imageV2 as Dict | undefined) ?? {};
    if (v2.imageKey) return String(v2.imageKey);
    const image = (contentData.image as Dict | undefined) ?? {};
    const img = (image.origin as Dict | undefined) ?? {};
    return String(img.key || image.imageKey || '');
  }
  if ([3, 15, 7, 10].includes(msgType)) return String(contentData.key ?? '');
  return '';
}

/** 下载到文件（流式写入，超过 200MB 报错）；返回 [路径, content-type, 字节数]。 */
export async function download(
  auth: LarkAuth,
  url: string,
  outPath: string,
): Promise<[string, string, number]> {
  const res = raiseForStatus(await request(url, { cookies: auth.cookies, timeoutMs: 60_000 }));
  const contentType = res.headers.get('content-type') ?? '';
  const path = resolve(outPath);
  mkdirSync(dirname(path), { recursive: true });
  const writer = Bun.file(path).writer();
  let n = 0;
  try {
    for await (const chunk of res.body ?? []) {
      n += chunk.length;
      if (n > MAX_BYTES) throw new Error('文件过大');
      writer.write(chunk);
    }
  } finally {
    await writer.end();
  }
  return [outPath, contentType, n];
}

export async function downloadMessageResource(
  auth: LarkAuth,
  msg: { msg_id: string; chat_id: string; msg_type: number; content_data: Dict | null },
  outPath: string,
): Promise<[string, string, number]> {
  const key = extractResourceKey(msg.msg_type, msg.content_data);
  if (!key) throw new Error('该消息没有可下载的资源');
  const url = messageResourceUrl(msg.msg_id, key, msg.chat_id, urls.fileHost(auth.region));
  logger.info(`下载资源: ${url}`);
  return download(auth, url, outPath);
}
