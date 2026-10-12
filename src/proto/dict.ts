import {
  type DescField,
  type DescMessage,
  fromJson,
  isFieldSet,
  type JsonValue,
  type Message,
  ScalarType,
} from '@bufbuild/protobuf';
import { PyFloat } from '../pyjson.js';

/**
 * protobuf 消息 → 普通对象，语义对齐原项目用的 protobuf3-to-dict：
 * 只含设置过的字段（显式 presence 的字段设为 0 也算设置），按字段编号排序，键用 proto 字段名；
 * 枚举为数字，bytes 为 Uint8Array，int64 为 bigint，float/double 包成 PyFloat（序列化时保留 `.0`）。
 */
export type Dict = Record<string, unknown>;

function fieldValue(msg: Message, field: DescField): unknown {
  const m = msg as unknown as Record<string, unknown>;
  if (field.oneof) {
    const o = m[field.oneof.localName] as { case?: string; value?: unknown };
    return o.case === field.localName ? o.value : undefined;
  }
  return m[field.localName];
}

function scalar(type: ScalarType, v: unknown): unknown {
  if (type === ScalarType.FLOAT || type === ScalarType.DOUBLE) return new PyFloat(v as number);
  return v;
}

function convert(field: DescField, v: unknown): unknown {
  switch (field.fieldKind) {
    case 'scalar':
      return scalar(field.scalar, v);
    case 'enum':
      return v;
    case 'message':
      return toDict(field.message, v as Message);
    case 'list': {
      const arr = v as unknown[];
      if (field.listKind === 'message') return arr.map((x) => toDict(field.message, x as Message));
      if (field.listKind === 'scalar') return arr.map((x) => scalar(field.scalar, x));
      return [...arr];
    }
    case 'map': {
      const out: Dict = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] =
          field.mapKind === 'message'
            ? toDict(field.message, x as Message)
            : field.mapKind === 'scalar'
              ? scalar(field.scalar, x)
              : x;
      }
      return out;
    }
  }
}

export function toDict(desc: DescMessage, msg: Message): Dict {
  const out: Dict = {};
  for (const field of [...desc.fields].sort((a, b) => a.number - b.number)) {
    if (!isFieldSet(msg, field)) continue;
    out[field.name] = convert(field, fieldValue(msg, field));
  }
  return out;
}

/** 对象 → protobuf 消息（对应 json_format.ParseDict(ignore_unknown_fields=True)）：字段名可用 proto 名或 JSON 名。 */
export function fromDict(desc: DescMessage, data: Dict | null | undefined): Message {
  return fromJson(desc, (data ?? {}) as JsonValue, { ignoreUnknownFields: true });
}

/**
 * 解析 JSON 文本并保住大整数：超出安全整数范围的整数字面量改为字符串（protobuf 的 JSON 解析对整数字段同样接受字符串），
 * 避免 19 位会话/消息 id 在 JSON.parse 时丢精度。
 */
export function parseJsonKeepingBigInts(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    const prev = out.trimEnd().slice(-1);
    if (m && (prev === '' || ',:['.includes(prev))) {
      const tok = m[0];
      out += /^-?\d+$/.test(tok) && !Number.isSafeInteger(Number(tok)) ? `"${tok}"` : tok;
      i += tok.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}
