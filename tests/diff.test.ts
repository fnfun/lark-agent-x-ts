import { describe, expect, test } from 'bun:test';
import { diffLines, unifiedDiff } from '../src/diff.js';

/** Length of the longest common subsequence, by plain dynamic programming. */
function lcs(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      (t[i] as number[])[j] =
        a[i - 1] === b[j - 1]
          ? ((t[i - 1] as number[])[j - 1] as number) + 1
          : Math.max((t[i - 1] as number[])[j] as number, (t[i] as number[])[j - 1] as number);
  return (t[a.length] as number[])[b.length] as number;
}

describe('行 diff', () => {
  test('编辑脚本能还原两边，且改动最少（等于 n + m - 2·最长公共子序列）', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const lines = (len: number) => Array.from({ length: len }, () => 'abcd'[rand(4)] as string);
    for (let round = 0; round < 300; round++) {
      const a = lines(rand(12));
      const b = lines(rand(12));
      const ops = diffLines(a, b);
      expect(ops.filter((o) => o.kind !== '+').map((o) => o.line)).toEqual(a);
      expect(ops.filter((o) => o.kind !== '-').map((o) => o.line)).toEqual(b);
      expect(ops.filter((o) => o.kind !== ' ').length).toBe(a.length + b.length - 2 * lcs(a, b));
    }
  });

  test('unified 格式与 diff -u 一致：前后各 3 行上下文，相邻改动并成一段，1 行的范围不写行数；相同时为空', () => {
    const a = ['x', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y'].join('\n');
    const b = ['X', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'z'].join('\n');
    expect(unifiedDiff(`${a}\n`, b, { fromName: '云端', toName: '本地' })).toBe(
      [
        '--- 云端',
        '+++ 本地',
        '@@ -1,4 +1,4 @@',
        '-x',
        '+X',
        ' 1',
        ' 2',
        ' 3',
        '@@ -9,3 +9,4 @@',
        ' 8',
        ' 9',
        ' y',
        '+z',
      ].join('\n'),
    );
    expect(unifiedDiff('x', 'y')).toBe('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y');
    expect(unifiedDiff('a\r\nb\n', 'a\nb')).toBe('');
  });
});
