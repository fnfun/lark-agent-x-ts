import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type AssetName = 'proto.binpb' | 'core.binpb' | 'lark_all.binpb' | 'cmd_map.json';

// 源码（src/proto/）与库构建产物（lib/proto/）都在仓库根下两层，同一个相对路径指向根目录的 assets/
let locate = (name: AssetName): string =>
  fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));

/** 单文件可执行把资产嵌进二进制，启动时用这里换成嵌入后的路径；Node / Bun 直接运行时无需调用。 */
export function setAssetPaths(paths: Record<AssetName, string>): void {
  locate = (name) => paths[name];
}

export function readAsset(name: AssetName): Uint8Array {
  return readFileSync(locate(name));
}
