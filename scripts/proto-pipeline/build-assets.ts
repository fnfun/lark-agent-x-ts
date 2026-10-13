import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearField, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  DescriptorProtoSchema,
  type EnumDescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  FileOptionsSchema,
} from '@bufbuild/protobuf/wkt';
import { ASSETS_DIR, OUT_DIR, PROTO_SRC } from './common.js';

/**
 * 第 6 步：编译协议资产到 assets/（用 buf，语义同 protoc）：
 * - proto.binpb    proto/proto.proto（手写的核心协议）
 * - lark_all.binpb out/lark_all.proto（全量网关定义）
 * - core.binpb     从全量定义裁出 CORE_REQUESTS 及其响应、CORE_TYPES 的传递闭包，常驻进程只加载它
 * 去掉 json_name（运行时按字段名推导，与原版资产逐字节一致）。
 */
const CORE_REQUESTS = [
  'messages.PutMessageLinkRequest',
  'messages.PutReadMessagesRequest',
  'messages.PullMessagesByIdsRequest',
  'messages.PullMessagesByPositionsRequest',
  'chats.PullChatsByIdsRequest',
];
const CORE_TYPES = [
  'entities.RichTextElement.AnchorProperty',
  'entities.RichTextElement.MarkdownProperty',
];

const BUF = join(import.meta.dir, '..', '..', 'node_modules', '.bin', 'buf');

async function compile(protoPath: string): Promise<FileDescriptorProto> {
  const dir = mkdtempSync(join(tmpdir(), 'larkx-buf-'));
  try {
    const name = protoPath.split('/').at(-1) as string;
    copyFileSync(protoPath, join(dir, name));
    const out = join(dir, 'out.binpb');
    const proc = Bun.spawn(
      [BUF, 'build', dir, '--as-file-descriptor-set', '--exclude-source-info', '-o', out],
      {
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await proc.exited) !== 0) throw new Error(`buf build ${protoPath} 失败`);
    const set = fromBinary(
      FileDescriptorSetSchema,
      new Uint8Array(await Bun.file(out).arrayBuffer()),
    );
    const file = set.file.find((f) => f.name === name);
    if (!file) throw new Error(`编译结果里没有 ${name}`);
    stripJsonNames(file.messageType);
    return file;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stripJsonNames(messages: DescriptorProto[]): void {
  for (const m of messages) {
    for (const f of m.field) clearField(f, FieldDescriptorProtoSchema.field.jsonName);
    stripJsonNames(m.nestedType);
  }
}

async function writeSet(name: string, file: FileDescriptorProto): Promise<void> {
  const data = toBinary(FileDescriptorSetSchema, create(FileDescriptorSetSchema, { file: [file] }));
  await Bun.write(join(ASSETS_DIR, `${name}.binpb`), data);
  console.log(`${name}.binpb ${data.length} bytes`);
}

/** 全名（带前导点）→ 类型描述。 */
function index(file: FileDescriptorProto): Map<string, DescriptorProto | EnumDescriptorProto> {
  const found = new Map<string, DescriptorProto | EnumDescriptorProto>();
  const walk = (prefix: string, messages: DescriptorProto[], enums: EnumDescriptorProto[]) => {
    for (const e of enums) found.set(`${prefix}.${e.name}`, e);
    for (const m of messages) {
      const full = `${prefix}.${m.name}`;
      found.set(full, m);
      walk(full, m.nestedType, m.enumType);
    }
  };
  walk(file.package ? `.${file.package}` : '', file.messageType, file.enumType);
  return found;
}

function closure(file: FileDescriptorProto, seeds: string[]): Set<string> {
  const types = index(file);
  const need = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const name = stack.pop() as string;
    if (need.has(name)) continue;
    const node = types.get(name);
    if (!node) throw new Error(`找不到类型 ${name}`);
    need.add(name);
    if ('field' in node) for (const f of node.field) if (f.typeName) stack.push(f.typeName);
  }
  return need;
}

/** 保留需要的类型；只作为命名空间的外层 message 去掉字段，只留路径。 */
function trim(file: FileDescriptorProto, need: Set<string>): FileDescriptorProto {
  const keep = (prefix: string, messages: DescriptorProto[], enums: EnumDescriptorProto[]) => {
    const outEnums = enums.filter((e) => need.has(`${prefix}.${e.name}`));
    const outMessages: DescriptorProto[] = [];
    for (const m of messages) {
      const full = `${prefix}.${m.name}`;
      if (![...need].some((n) => n === full || n.startsWith(`${full}.`))) continue;
      const nested = keep(full, m.nestedType, m.enumType);
      outMessages.push(
        need.has(full)
          ? { ...m, nestedType: nested.messages, enumType: nested.enums }
          : create(DescriptorProtoSchema, {
              name: m.name,
              nestedType: nested.messages,
              enumType: nested.enums,
            }),
      );
    }
    return { messages: outMessages, enums: outEnums };
  };
  const top = keep(`.${file.package}`, file.messageType, file.enumType);
  return create(FileDescriptorProtoSchema, {
    name: 'core.proto',
    package: file.package,
    syntax: file.syntax,
    // 原版以 CopyFrom 复制（空的）options，字段会显式出现
    options: file.options ?? create(FileOptionsSchema),
    messageType: top.messages,
    enumType: top.enums,
  });
}

const cmdMap = (await Bun.file(join(ASSETS_DIR, 'cmd_map.json')).json()) as {
  by_req: Record<string, { resp: string }>;
};
// 没有全量 .proto（只改了 proto/proto.proto 或 CORE_REQUESTS，没重跑前几步）时沿用现有的 lark_all.binpb，只重建 proto 与 core
const larkAllSrc = join(OUT_DIR, 'lark_all.proto');
const fromSource = existsSync(larkAllSrc);
const larkAll = fromSource
  ? await compile(larkAllSrc)
  : (fromBinary(
      FileDescriptorSetSchema,
      new Uint8Array(await Bun.file(join(ASSETS_DIR, 'lark_all.binpb')).arrayBuffer()),
    ).file[0] as FileDescriptorProto);
if (!fromSource) console.log(`没有 ${larkAllSrc},沿用 assets/lark_all.binpb`);
const seeds = CORE_TYPES.map((t) => `.lark.${t}`);
for (const req of CORE_REQUESTS) {
  const entry = cmdMap.by_req[req];
  if (!entry) throw new Error(`cmd_map 里没有 ${req}`);
  seeds.push(`.lark.${req}`, `.lark.${entry.resp}`);
}
await writeSet('proto', await compile(PROTO_SRC));
if (fromSource) await writeSet('lark_all', larkAll);
await writeSet('core', trim(larkAll, closure(larkAll, seeds)));
