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

/** Resource download URL; host is the region's file host, taken from LARKX_REGION when omitted. */
export function messageResourceUrl(
  msgId: string,
  key: string,
  chatId: string,
  host?: string,
): string {
  const h = host ?? urls.fileHost(getRegion(loadConfig().region));
  return `${h}/download/messages/${msgId}/keys/${key}?chat_id=${chatId}`;
}

/** Resource key in message content: imageKey for images, key for files/videos/audio/stickers. */
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

/** Download to a file (streamed; errors past 200MB); returns [path, content-type, byte count]. */
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

/** File as recorded by the server after upload: resource key, file name, byte count and MIME. */
export interface UploadedFile {
  key: string;
  name: string;
  size: number;
  mime: string;
}

const UPLOAD_TIMEOUT_MS = 300_000;

/** The web client's form request for uploading resources (file host, cookie auth). */
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

/**
 * Upload an image and return its image key (img_v3_…); call this before sending an image message.
 */
export async function uploadImage(
  auth: LarkAuth,
  data: Uint8Array,
  name = 'image.png',
): Promise<string> {
  const res = await postForm(auth, `${urls.fileHost(auth.region)}/api/image`, 'image', data, name);
  // The response is plain text: a status prefix followed by the key (the web client takes
  // text.slice(2)); here the key is extracted by its shape
  const key = /img_[\w-]+/.exec(await res.text())?.[0];
  if (!key) throw new Error('图片上传失败: 响应里没有图片 key');
  logger.info(`图片已上传: ${key} (${data.length} 字节)`);
  return key;
}

/**
 * Upload a file to a chat (the file belongs to the chat) and return the file info recorded by the
 * server; call this before sending a file message.
 */
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

const ascii = (data: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...data.subarray(at, at + n));

/**
 * Duration (ms) of an MP4 / MOV file, read from its moov → mvhd box (no decoding); null when the
 * box cannot be found.
 */
export function mp4DurationMs(data: Uint8Array): number | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  /** Payload range [start, end) of the first box of this type inside [from, to). */
  const box = (from: number, to: number, type: string): [number, number] | null => {
    for (let p = from; p + 8 <= to; ) {
      let size = view.getUint32(p);
      let header = 8;
      if (size === 1) {
        if (p + 16 > to) return null;
        size = Number(view.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) size = to - p;
      if (size < header || p + size > to) return null;
      if (ascii(data, p + 4, 4) === type) return [p + header, p + size];
      p += size;
    }
    return null;
  };
  const moov = box(0, data.length, 'moov');
  const mvhd = moov && box(moov[0], moov[1], 'mvhd');
  if (!mvhd || mvhd[1] - mvhd[0] < 20) return null;
  const s = mvhd[0];
  // mvhd version 0: 32-bit creation/modification times; version 1: 64-bit
  const [timescale, duration] =
    data[s] === 1
      ? [view.getUint32(s + 20), Number(view.getBigUint64(s + 24))]
      : [view.getUint32(s + 12), view.getUint32(s + 16)];
  return timescale && duration ? Math.round((duration / timescale) * 1000) : null;
}

/**
 * Duration (ms) of an Ogg / Opus file: the last page's granule position (48 kHz samples) minus the
 * pre-skip in OpusHead; null when the data is not Ogg / Opus.
 */
export function oggOpusDurationMs(data: Uint8Array): number | null {
  if (data.length < 47 || ascii(data, 0, 4) !== 'OggS') return null;
  let head = -1;
  for (let p = 28; p + 12 <= Math.min(data.length, 512); p++)
    if (ascii(data, p, 8) === 'OpusHead') {
      head = p;
      break;
    }
  if (head < 0) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const preSkip = view.getUint16(head + 10, true);
  for (let p = data.length - 27; p >= 0; p--) {
    if (data[p] !== 0x4f || ascii(data, p, 4) !== 'OggS') continue;
    const granule = view.getBigUint64(p + 6, true);
    // -1 marks a page on which no packet ends
    if (granule === 0xffffffffffffffffn) continue;
    return Math.max(0, Math.round((Number(granule) - preSkip) / 48));
  }
  return null;
}
