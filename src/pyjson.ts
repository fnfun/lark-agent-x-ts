/**
 * 与 Python `json.dumps(obj, ensure_ascii=False, ...)` 输出一致的序列化：
 * 消息库里的 `content_data`、`lark api` 等命令的输出都要与原项目逐字节一致，调用方（如 niuma）按原格式解析。
 *
 * - 无缩进时分隔符为 `, ` 与 `: `；有缩进时为 `,` 与 `: `
 * - bigint 按十进制整数输出（int64 不丢精度）
 * - 整数值的浮点数输出为 `1.0`（Python float 的 repr）
 * - 其他无法序列化的值交给 `fallback`（对应 Python 的 `default=`）
 */
export type Fallback = (value: unknown) => unknown;

export class PyFloat {
  constructor(readonly value: number) {}
}

/** Python float 的 repr：最短往返位数；指数 < -4 或 ≥ 16 时用科学计数法（两位以上指数），否则定点并保留 `.0`。 */
export function floatRepr(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (n === 0) return Object.is(n, -0) ? '-0.0' : '0.0';
  const [mant = '', expStr = '0'] = n.toExponential().split('e');
  const exp = Number(expStr);
  const neg = mant.startsWith('-');
  const digits = mant.replace('-', '').replace('.', '');
  const sign = neg ? '-' : '';
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp) < 10 ? `0${Math.abs(exp)}` : String(Math.abs(exp));
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${e}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
  const frac = digits.slice(exp + 1);
  return `${sign}${intPart}.${frac || '0'}`;
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** ensure_ascii=False 的字符串转义：只转义引号、反斜杠与控制字符。 */
export function pyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const esc = ESCAPES[ch];
    if (esc) out += esc;
    else {
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
    }
  }
  return `${out}"`;
}

export function pyDumps(
  value: unknown,
  opts: { indent?: number; fallback?: Fallback } = {},
): string {
  const { indent, fallback } = opts;
  const itemSep = indent === undefined ? ', ' : ',';
  const enc = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'string') return pyString(v);
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : floatRepr(v);
    if (v instanceof PyFloat) return floatRepr(v.value);
    const nl = indent === undefined ? '' : `\n${' '.repeat(indent * (depth + 1))}`;
    const close = indent === undefined ? '' : `\n${' '.repeat(indent * depth)}`;
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return `[${nl}${v.map((x) => enc(x, depth + 1)).join(itemSep + nl)}${close}]`;
    }
    if (isPlainObject(v) || v instanceof Map) {
      // Map 保留插入顺序（普通对象会把整数键提前），用于需要与 Python dict 顺序一致的场合
      const entries =
        v instanceof Map ? [...v].map(([k, x]) => [String(k), x] as const) : Object.entries(v);
      if (entries.length === 0) return '{}';
      return `{${nl}${entries.map(([k, x]) => `${pyString(k)}: ${enc(x, depth + 1)}`).join(itemSep + nl)}${close}}`;
    }
    if (!fallback) throw new TypeError(`Object of type ${typeName(v)} is not JSON serializable`);
    return enc(fallback(v), depth);
  };
  return enc(value, 0);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function typeName(v: unknown): string {
  return v instanceof Uint8Array ? 'bytes' : (v?.constructor?.name ?? typeof v);
}

/** Python `str(bytes)`：`b'...'` 形式的 repr，`lark api` 打印原始字节时用。 */
export function pyBytesRepr(b: Uint8Array): string {
  const hasSingle = b.includes(0x27);
  const hasDouble = b.includes(0x22);
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = '';
  for (const c of b) {
    if (c === 0x5c) out += '\\\\';
    else if (c === quote.charCodeAt(0)) out += `\\${quote}`;
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20 || c >= 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += String.fromCharCode(c);
  }
  return `b${quote}${out}${quote}`;
}
