/**
 * Line diff in unified format (as `diff -u` prints it), for comparing a Drive text file with a
 * local draft. Myers' algorithm (O((N+M)·D)): written here rather than taken from a library because
 * the project adds no dependencies on its own, and this is the only diff it needs.
 */

type Op = { kind: ' ' | '-' | '+'; line: string };

/** The shortest edit script turning a into b, as kept / removed / added lines in order. */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const at = (v: Int32Array, k: number) => v[offset + k] as number;
  // trace[d]: the furthest x reached on each diagonal k before step d
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * offset + 1);
  search: for (let d = 0; d <= n + m; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && at(v, k - 1) < at(v, k + 1)) ? at(v, k + 1) : at(v, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break search;
    }
    v = v.slice();
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(vd, k - 1) < at(vd, k + 1)) ? k + 1 : k - 1;
    const prevX = at(vd, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: ' ', line: a[x] as string });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', line: b[prevY] as string });
      else ops.push({ kind: '-', line: a[prevX] as string });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** A hunk range as diff -u writes it: the count is left out when it is 1. */
const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

const splitLines = (s: string) => {
  const lines = s.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/**
 * Unified diff of two texts, with `context` lines around each change; empty when they have the
 * same lines (a trailing newline and CRLF vs LF do not count).
 */
export function unifiedDiff(
  from: string,
  to: string,
  o: { fromName?: string; toName?: string; context?: number } = {},
): string {
  const ops = diffLines(splitLines(from), splitLines(to));
  const context = o.context ?? 3;
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  if (!changed.length) return '';
  // Group changes whose context overlaps into hunks of op indexes [start, end)
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, i + context + 1);
    const last = hunks.at(-1);
    if (last && start <= last[1]) last[1] = end;
    else hunks.push([start, end]);
  }
  const out = [`--- ${o.fromName ?? 'a'}`, `+++ ${o.toName ?? 'b'}`];
  // Line numbers before each op, in the old and the new text
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let ol = 0;
  let nl = 0;
  for (const op of ops) {
    oldAt.push(ol);
    newAt.push(nl);
    if (op.kind !== '+') ol++;
    if (op.kind !== '-') nl++;
  }
  for (const [start, end] of hunks) {
    const slice = ops.slice(start, end);
    const oldLen = slice.filter((op) => op.kind !== '+').length;
    const newLen = slice.filter((op) => op.kind !== '-').length;
    // diff -u numbers an empty side by the line before it
    const oldStart = oldLen ? (oldAt[start] as number) + 1 : (oldAt[start] as number);
    const newStart = newLen ? (newAt[start] as number) + 1 : (newAt[start] as number);
    out.push(`@@ -${range(oldStart, oldLen)} +${range(newStart, newLen)} @@`);
    for (const op of slice) out.push(`${op.kind}${op.line}`);
  }
  return out.join('\n');
}
