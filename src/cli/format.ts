import { PyFloat, pyBytesRepr, pyDumps } from '../pyjson.js';

/** 对应原项目 `_print_json`：缩进 2、不转义中文，无法序列化的值按 Python `str()` 输出（字节为 b'...'）。 */
export function printJson(obj: unknown): void {
  process.stdout.write(
    `${pyDumps(obj, {
      indent: 2,
      fallback: (o) =>
        o instanceof Uint8Array ? pyBytesRepr(o) : o instanceof PyFloat ? o.value : String(o),
    })}\n`,
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 秒级时间戳 → 本地时间 `MM-DD HH:MM`；空值为空串。 */
export function shortTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(Number(ts) * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 库里的 DateTime 字符串按 Python `str(datetime)` 输出：微秒为 0 时不带小数部分。 */
export const pyDatetime = (s: string | null | undefined): string =>
  s ? String(s).replace(/\.0{6}$/, '') : 'None';
