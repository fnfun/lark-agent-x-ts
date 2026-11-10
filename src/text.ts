/**
 * Take the first n characters by Unicode code point (Python's `s[:n]`; never splits surrogate
 * pairs).
 */
export function head(s: string, n: number): string {
  let count = 0;
  let end = 0;
  for (const ch of s) {
    if (count === n) break;
    count += 1;
    end += ch.length;
  }
  return s.slice(0, end);
}

/** Length in code points (Python's `len(s)`). */
export const codeLength = (s: string): number => Array.from(s).length;

/** Truncate with an ellipsis past n characters; for single-line previews in the terminal. */
export const preview = (s: string, n: number): string =>
  head(s, n) + (codeLength(s) > n ? '…' : '');
