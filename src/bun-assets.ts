/// <reference path="./assets.d.ts" />
// 单文件可执行：协议资产随 `with { type: 'file' }` 嵌进二进制，导入本模块即把库的资产路径换成嵌入后的路径。
// 本仓库的 CLI 入口导入它；把本库嵌进自己的 Bun 单文件可执行时，在入口处 `import 'lark-agent-x-ts/bun-assets'`。
// 库入口不经过这里，Node 下也就不会遇到 Bun 专有的导入属性。
import cmdMap from '../assets/cmd_map.json' with { type: 'file' };
import core from '../assets/core.binpb' with { type: 'file' };
import larkAll from '../assets/lark_all.binpb' with { type: 'file' };
import proto from '../assets/proto.binpb' with { type: 'file' };
import { setAssetPaths } from './proto/assets.js';

setAssetPaths({
  'proto.binpb': proto,
  'core.binpb': core,
  'lark_all.binpb': larkAll,
  // TS 按 JSON 推断这个导入的类型，`type: 'file'` 下它实际是路径
  'cmd_map.json': cmdMap as unknown as string,
});
