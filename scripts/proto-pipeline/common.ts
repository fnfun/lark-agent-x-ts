import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 协议资产再生成管线的公共部分（迁移自 fork 版 dev/proto_pipeline，产物与原版逐字节一致）。
 * 工作目录 `LARK_WORK_DIR`（输入与中间产物，默认 scripts/proto-pipeline/work），
 * 输出目录 `LARK_PROTO_OUT`（.proto 与接口表，默认 scripts/proto-pipeline/out）。
 */
const here = import.meta.dir;
export const WORK_DIR = resolve(process.env.LARK_WORK_DIR || join(here, 'work'));
export const OUT_DIR = resolve(process.env.LARK_PROTO_OUT || join(here, 'out'));
export const ASSETS_DIR = resolve(here, '..', '..', 'assets');
export const PROTO_SRC = resolve(here, '..', '..', 'proto', 'proto.proto');

export const CDN_BASE =
  'https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client-next/p/static/js';

/**
 * 基础 worklet 包（文件名带 hash，飞书发版后会变）：1242 js runtime、1181 shared worklet（长连接）、
 * 9174 messenger worklet、9373 feed worklet。最新文件名的取法见 README。可用 `LARK_BASE_BUNDLES=1242.xxxx,1181.xxxx,...` 覆盖。
 */
export const BASE_BUNDLES = (
  process.env.LARK_BASE_BUNDLES || '1242.60b3a8cd,1181.aa6c8a55,9174.30e252dd,9373.e0426f59'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 下载时一并保留的包（chunk id → hash）：基础包本身与 8929，即使不在 chunk 映射里，也参与第 3 步的提取。 */
export const EXTRA_BUNDLES: Record<string, string> = {
  ...Object.fromEntries(BASE_BUNDLES.map((b) => b.split('.') as [string, string])),
  '8929': '4a638fa1',
};

export const ensureDir = (p: string): string => {
  mkdirSync(p, { recursive: true });
  return p;
};

/** 按 UTF-8 读文本，非法字节替换为 U+FFFD（对应 Python 的 errors='replace'）。 */
export const readText = async (path: string): Promise<string> =>
  new TextDecoder('utf-8').decode(await Bun.file(path).arrayBuffer());

/** Python 的 str.splitlines()：认全部换行符，末尾的换行不产生空行。 */
export function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts.at(-1) === '') parts.pop();
  return parts;
}
