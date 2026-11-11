import { HttpError } from '../http.js';
import { PyFloat, pyBytesRepr, pyDumps } from '../pyjson.js';
import { write } from './common.js';

/**
 * The original's `_print_json`: indent 2, Chinese not escaped, unserializable values output as
 * Python `str()` (bytes as b'...').
 */
export function printJson(obj: unknown): void {
  write(
    `${pyDumps(obj, {
      indent: 2,
      fallback: (o) =>
        o instanceof Uint8Array ? pyBytesRepr(o) : o instanceof PyFloat ? o.value : String(o),
    })}\n`,
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Timestamp in seconds → local time `MM-DD HH:MM`; empty values give an empty string. */
export function shortTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(Number(ts) * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Outputs a DateTime string from the database as Python `str(datetime)` does: no fractional part
 * when microseconds are 0.
 */
export const pyDatetime = (s: string | null | undefined): string =>
  s ? String(s).replace(/\.0{6}$/, '') : 'None';

/**
 * Error text: appends the gateway's error reason (in parentheses) when given, to help tell whether
 * the problem is the arguments, permissions or the chat type.
 */
export function errorText(e: unknown): string {
  const msg = (e as Error).message;
  return e instanceof HttpError && e.reason ? `${msg} (${e.reason})` : msg;
}
