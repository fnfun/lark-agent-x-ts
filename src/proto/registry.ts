import {
  createFileRegistry,
  type DescEnum,
  type DescMessage,
  fromBinary,
  type Registry,
} from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { type AssetName, readAsset } from './assets.js';

// 协议资产由 scripts/proto-pipeline 生成（见其 README）：proto.binpb 来自手写的核心协议 proto/proto.proto；
// lark_all 是全量网关定义（约 1.1 万个类型，加载约 100ms、内存 +100MB），只有用到核心子集之外的类型时才加载。

const load = (name: AssetName): Registry =>
  createFileRegistry(fromBinary(FileDescriptorSetSchema, readAsset(name)));

let protoReg: Registry | undefined;
let coreReg: Registry | undefined;
let allReg: Registry | undefined;

/** proto.proto 里的类型（无 package），如 `Packet`、`entities.Message`。 */
export function protoType(name: string): DescMessage {
  protoReg ??= load('proto.binpb');
  const t = protoReg.getMessage(name);
  if (!t) throw new Error(`未知类型: ${name}`);
  return t;
}

export function protoEnum(name: string): DescEnum {
  protoReg ??= load('proto.binpb');
  const t = protoReg.getEnum(name);
  if (!t) throw new Error(`未知枚举: ${name}`);
  return t;
}

function fullRegistry(): Registry {
  allReg ??= load('lark_all.binpb');
  return allReg;
}

/** 网关类型（全量定义里的 `lark.` 包，名字不带包前缀），如 `messages.PutReadMessagesRequest`。 */
export function larkType(name: string): DescMessage {
  coreReg ??= load('core.binpb');
  const full = `lark.${name}`;
  const t = coreReg.getMessage(full) ?? fullRegistry().getMessage(full);
  if (!t) throw new Error(`未知类型: ${name}`);
  return t;
}

interface CmdEntry {
  cmd: number;
  resp?: string;
  push?: boolean;
}

interface CmdMap {
  by_req: Record<string, CmdEntry>;
  by_cmd: Record<string, Array<CmdEntry & { req?: string }>>;
}

let cmdMap: CmdMap | undefined;
const cmds = (): CmdMap =>
  (cmdMap ??= JSON.parse(new TextDecoder().decode(readAsset('cmd_map.json'))) as CmdMap);

export interface ResolvedCmd {
  cmd: number;
  req: DescMessage | null;
  resp: DescMessage | null;
}

/** 请求类型名或 cmd 数字 → cmd 号与请求/响应类型（对应原项目 gateway.resolve_cmd）。 */
export function resolveCmd(typeOrCmd: string | number): ResolvedCmd {
  if (typeof typeOrCmd === 'number' || /^\d+$/.test(typeOrCmd)) {
    const cmd = Number(typeOrCmd);
    let resp: DescMessage | null = null;
    for (const r of cmds().by_cmd[String(cmd)] ?? []) {
      if (!r.resp) continue;
      try {
        resp = larkType(r.resp);
        break;
      } catch {}
    }
    return { cmd, req: null, resp };
  }
  const entry = cmds().by_req[typeOrCmd];
  if (!entry) throw new Error(`cmd 映射里没有 ${typeOrCmd}(查 docs/cmd_table.md 确认名字)`);
  return {
    cmd: entry.cmd,
    req: entry.push ? null : larkType(typeOrCmd),
    resp: entry.resp ? larkType(entry.resp) : null,
  };
}
