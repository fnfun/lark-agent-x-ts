"""从 fork 版 LarkAgentX 导出协议资产到 assets/：

- proto.binpb      proto.proto（网关包、长连接帧、消息内容等）的 FileDescriptorSet
- lark_all.binpb   全量网关定义（约 1.1 万个类型），只有 `lark api` 按需加载
- core.binpb       从全量定义里裁出的核心子集：CORE_REQUESTS 及其响应、CORE_TYPES 的传递闭包，常驻进程只加载它
- cmd_map.json     请求类型名 → cmd 号 / 响应类型名

用法（在装有 larkx 的 Python 环境里）：
    python scripts/export-descriptors.py <LarkAgentX 仓库路径>
"""
import json
import shutil
import sys
from pathlib import Path

repo = Path(sys.argv[1]).expanduser().resolve()
sys.path.insert(0, str(repo))

from google.protobuf import descriptor_pb2  # noqa: E402
from larkx.proto import lark_all_pb2, proto_pb2  # noqa: E402

CORE_REQUESTS = [
    'messages.PutMessageLinkRequest',
    'messages.PutReadMessagesRequest',
    'messages.PullMessagesByIdsRequest',
    'messages.PullMessagesByPositionsRequest',
    'chats.PullChatsByIdsRequest',
]
CORE_TYPES = ['entities.RichTextElement.AnchorProperty']

out = Path(__file__).resolve().parent.parent / 'assets'
out.mkdir(exist_ok=True)
cmd_map = json.loads((repo / 'larkx' / 'proto' / 'cmd_map.json').read_text(encoding='utf-8'))


def file_proto(module) -> descriptor_pb2.FileDescriptorProto:
    fd = descriptor_pb2.FileDescriptorProto()
    module.DESCRIPTOR.CopyToProto(fd)
    return fd


def write_set(name: str, fd: descriptor_pb2.FileDescriptorProto) -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    fds.file.append(fd)
    data = fds.SerializeToString()
    (out / f'{name}.binpb').write_bytes(data)
    print(f'{name}.binpb {len(data)} bytes')


def index(fd):
    """全名（带前导点）→ DescriptorProto / EnumDescriptorProto。"""
    found = {}

    def walk(prefix, messages, enums):
        for e in enums:
            found[f'{prefix}.{e.name}'] = e
        for m in messages:
            full = f'{prefix}.{m.name}'
            found[full] = m
            walk(full, m.nested_type, m.enum_type)

    walk(f'.{fd.package}' if fd.package else '', fd.message_type, fd.enum_type)
    return found


def closure(fd, seeds):
    types = index(fd)
    need, stack = set(), list(seeds)
    while stack:
        name = stack.pop()
        if name in need:
            continue
        if name not in types:
            raise SystemExit(f'找不到类型 {name}')
        need.add(name)
        node = types[name]
        if isinstance(node, descriptor_pb2.DescriptorProto):
            stack.extend(f.type_name for f in node.field if f.type_name)
    return need


def trim(fd, need):
    """保留需要的类型；只作为命名空间的外层 message 去掉字段，只留路径。"""
    def keep(prefix, messages, enums, dst_messages, dst_enums):
        for e in enums:
            if f'{prefix}.{e.name}' in need:
                dst_enums.add().CopyFrom(e)
        for m in messages:
            full = f'{prefix}.{m.name}'
            if not any(n == full or n.startswith(full + '.') for n in need):
                continue
            dst = dst_messages.add()
            if full in need:
                dst.CopyFrom(m)
                del dst.nested_type[:]
                del dst.enum_type[:]
            else:
                dst.name = m.name
            keep(full, m.nested_type, m.enum_type, dst.nested_type, dst.enum_type)

    core = descriptor_pb2.FileDescriptorProto()
    core.name = 'core.proto'
    core.package = fd.package
    core.syntax = fd.syntax
    core.options.CopyFrom(fd.options)
    keep(f'.{fd.package}', fd.message_type, fd.enum_type, core.message_type, core.enum_type)
    return core


lark_all = file_proto(lark_all_pb2)
seeds = [f'.lark.{t}' for t in CORE_TYPES]
for req in CORE_REQUESTS:
    entry = cmd_map['by_req'][req]
    seeds += [f'.lark.{req}', f'.lark.{entry["resp"]}']
write_set('proto', file_proto(proto_pb2))
write_set('lark_all', lark_all)
write_set('core', trim(lark_all, closure(lark_all, seeds)))
shutil.copyfile(repo / 'larkx' / 'proto' / 'cmd_map.json', out / 'cmd_map.json')
print('cmd_map.json copied')
