import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LarkAuth } from './auth.js';
import { loadConfig } from './config.js';
import { raiseForStatus, request, USER_AGENT } from './http.js';
import { getLogger } from './log.js';
import type { Dict } from './proto/dict.js';
import { getRegion, urls, webOrigin } from './region.js';

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
  let n = 0;
  const body = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
  await pipeline(
    body,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        n += chunk.length;
        if (n > MAX_BYTES) throw new Error('文件过大');
        yield chunk;
      }
    },
    createWriteStream(path),
  );
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

/** 上传后服务端记下的文件：资源 key、文件名、字节数与 MIME。 */
export interface UploadedFile {
  key: string;
  name: string;
  size: number;
  mime: string;
}

const UPLOAD_TIMEOUT_MS = 300_000;

/** 网页客户端上传资源的表单请求（文件主机，cookie 鉴权）。 */
async function postForm(
  auth: LarkAuth,
  url: string,
  field: string,
  data: Uint8Array,
  name: string,
) {
  const form = new FormData();
  form.append(field, new File([data], name));
  return raiseForStatus(
    await request(url, {
      method: 'POST',
      headers: {
        origin: webOrigin(auth.region),
        referer: `${webOrigin(auth.region)}/`,
        'user-agent': USER_AGENT,
        'x-source': 'web',
        'x-appid': auth.gatewayAppId,
      },
      cookies: auth.cookies,
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),
  );
}

/** 上传一张图片，返回图片 key（img_v3_…）；发图片消息前先调它。 */
export async function uploadImage(
  auth: LarkAuth,
  data: Uint8Array,
  name = 'image.png',
): Promise<string> {
  const res = await postForm(auth, `${urls.fileHost(auth.region)}/api/image`, 'image', data, name);
  // 响应是纯文本：一个状态前缀后跟 key（网页客户端取 text.slice(2)），这里直接按 key 的形态取
  const key = /img_[\w-]+/.exec(await res.text())?.[0];
  if (!key) throw new Error('图片上传失败: 响应里没有图片 key');
  logger.info(`图片已上传: ${key} (${data.length} 字节)`);
  return key;
}

/** 上传一个文件到某会话（文件归属于会话），返回服务端记下的文件信息；发文件消息前先调它。 */
export async function uploadFile(
  auth: LarkAuth,
  chatId: string,
  data: Uint8Array,
  name: string,
): Promise<UploadedFile> {
  const url = `${urls.fileHost(auth.region)}/api/chats/${chatId}/files`;
  const res = await postForm(auth, url, 'file', data, name);
  const body = (await res.json()) as {
    status?: string;
    message?: string;
    data?: { key?: string; name?: string; size?: number; mimetype?: string };
  };
  if (body.status !== 'success' || !body.data?.key)
    throw new Error(`文件上传失败: ${body.message || body.status || '响应里没有文件 key'}`);
  const d = body.data;
  logger.info(`文件已上传: ${d.key} (${d.size ?? data.length} 字节)`);
  return {
    key: String(d.key),
    name: d.name || name,
    size: Number(d.size ?? data.length),
    mime: d.mimetype || 'application/octet-stream',
  };
}
