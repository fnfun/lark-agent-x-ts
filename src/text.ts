/** 按 Unicode 码点截取前 n 个字符（对应 Python 的 `s[:n]`，不会切断代理对）。 */
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

/** 码点长度（Python 的 `len(s)`）。 */
export const codeLength = (s: string): number => Array.from(s).length;

/** 超过 n 个字符时截断并加省略号，用于终端里的单行预览。 */
export const preview = (s: string, n: number): string =>
  head(s, n) + (codeLength(s) > n ? '…' : '');
