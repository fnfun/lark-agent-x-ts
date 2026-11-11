/**
 * Formulas in the form the Sheets web app sends with them (`formulaData`), read off formulas typed
 * in the web app on 2026-11-11:
 *
 * - `refs`: every cell, range, whole-column or whole-row reference in order of appearance, named
 *   R1, R2, ...; `{type, row, rowCount, col, colCount}` with type's low bits 0 (cells), 1 (whole
 *   rows, no col fields), 2 (whole columns, no row fields) and flags 16 / 32 for an absolute
 *   start / end column, 64 / 128 for an absolute start / end row.
 * - `tree`: the formula in reverse Polish notation: `R<n>` a reference, `D<number as written>`,
 *   `S<string>`, `OB<op>` binary operators, `OP<op>` prefix and `OS%` postfix operators, `OG1`
 *   after a parenthesised expression, `F:<NAME>:<argument count>` after a function's arguments.
 * - `tokens`: the formula text without "=", cut at the references: `C<text>` pieces and `R<n>`.
 *
 * Operator precedence follows Excel: comparisons < & < + - < * / < ^ < % < unary + -. References to
 * other sheets are not supported.
 */

export interface FormulaRef {
  type: number;
  row?: number;
  rowCount?: number;
  col?: number;
  colCount?: number;
}

export interface FormulaData {
  v: 1;
  refs: Record<string, FormulaRef>;
  tree: string[];
  tokens: string[];
}

type Token =
  | { kind: 'num'; text: string }
  | { kind: 'str'; text: string }
  | { kind: 'ref'; name: string }
  | { kind: 'func'; name: string }
  | { kind: 'op'; text: string }
  | { kind: '('; text: '(' }
  | { kind: ')'; text: ')' }
  | { kind: ','; text: ',' };

const colIndex = (letters: string) =>
  [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** A reference's text (A1, $A$1:B2, A:B, 1:3) → its ref entry; null when it is not one. */
function parseRef(text: string): FormulaRef | null {
  const cell = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
  const [a, b = a] = text.split(':') as [string, string?];
  const ca = cell.exec(a);
  const cb = cell.exec(b);
  if (ca && cb) {
    const [c1, c2] = [colIndex(ca[2] as string), colIndex(cb[2] as string)];
    const [r1, r2] = [Number(ca[4]) - 1, Number(cb[4]) - 1];
    const type = (ca[1] ? 16 : 0) | (cb[1] ? 32 : 0) | (ca[3] ? 64 : 0) | (cb[3] ? 128 : 0);
    return {
      type,
      col: Math.min(c1, c2),
      colCount: Math.abs(c2 - c1) + 1,
      row: Math.min(r1, r2),
      rowCount: Math.abs(r2 - r1) + 1,
    };
  }
  if (!text.includes(':')) return null;
  const col = /^(\$?)([A-Za-z]{1,3})$/;
  const ka = col.exec(a);
  const kb = col.exec(b);
  if (ka && kb) {
    const [c1, c2] = [colIndex(ka[2] as string), colIndex(kb[2] as string)];
    return {
      type: 2 | (ka[1] ? 16 : 0) | (kb[1] ? 32 : 0),
      col: Math.min(c1, c2),
      colCount: Math.abs(c2 - c1) + 1,
    };
  }
  const row = /^(\$?)(\d+)$/;
  const ra = row.exec(a);
  const rb = row.exec(b);
  if (ra && rb) {
    const [r1, r2] = [Number(ra[2]) - 1, Number(rb[2]) - 1];
    return {
      type: 1 | (ra[1] ? 64 : 0) | (rb[1] ? 128 : 0),
      row: Math.min(r1, r2),
      rowCount: Math.abs(r2 - r1) + 1,
    };
  }
  return null;
}

const REF =
  /\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+/y;
const NUMBER = /\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?/y;
const FUNC = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/y;
const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%'];

/** Compiles a formula ("=..." ) into its formulaData; throws on what it cannot represent. */
export function compileFormula(formula: string): FormulaData {
  const body = formula.replace(/^=/, '');
  if (body.replace(/"(?:[^"]|"")*"/g, '').includes('!'))
    throw new Error(`暂不支持引用其他工作表: ${formula}`);
  const refs: Record<string, FormulaRef> = {};
  const tokens: string[] = [];
  const lexed: Token[] = [];
  let text = '';
  let i = 0;
  const at = (re: RegExp) => {
    re.lastIndex = i;
    return re.exec(body);
  };
  while (i < body.length) {
    const ch = body[i] as string;
    if (/\s/.test(ch)) {
      text += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      for (; j < body.length; j++) {
        if (body[j] === '"' && body[j + 1] === '"') {
          s += '"';
          j++;
        } else if (body[j] === '"') break;
        else s += body[j];
      }
      if (j >= body.length) throw new Error(`公式里的字符串没有结束: ${formula}`);
      lexed.push({ kind: 'str', text: s });
      text += body.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const func = at(FUNC);
    if (func) {
      lexed.push(
        { kind: 'func', name: (func[1] as string).toUpperCase() },
        { kind: '(', text: '(' },
      );
      text += func[0];
      i += func[0].length;
      continue;
    }
    const ref = at(REF);
    if (ref) {
      const after = body[i + ref[0].length];
      const parsed = after && /[A-Za-z0-9_(]/.test(after) ? null : parseRef(ref[0]);
      if (parsed) {
        const name = `R${Object.keys(refs).length + 1}`;
        refs[name] = parsed;
        if (text) tokens.push(`C${text}`);
        tokens.push(name);
        text = '';
        lexed.push({ kind: 'ref', name });
        i += ref[0].length;
        continue;
      }
    }
    const num = at(NUMBER);
    if (num) {
      lexed.push({ kind: 'num', text: num[0] });
      text += num[0];
      i += num[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => body.startsWith(o, i));
    if (op) {
      lexed.push({ kind: 'op', text: op });
      text += op;
      i += op.length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      lexed.push({ kind: ch, text: ch } as Token);
      text += ch;
      i++;
      continue;
    }
    throw new Error(`看不懂的公式: ${formula}(第 ${i + 1} 个字符)`);
  }
  if (text) tokens.push(`C${text}`);
  return { v: 1, refs, tree: toRpn(lexed, formula), tokens };
}

const BINARY: Record<string, number> = {
  '=': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '<>': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
};
const PERCENT = 6;
const PREFIX = 7;

type StackItem =
  | { kind: 'op'; out: string; prec: number; right: boolean }
  | { kind: '(' }
  | { kind: 'func'; name: string; args: number; empty: boolean };

/** Shunting-yard into the web app's postfix notation. */
function toRpn(tokens: Token[], formula: string): string[] {
  const out: string[] = [];
  const stack: StackItem[] = [];
  let expectOperand = true;
  const popOps = (prec: number, right: boolean) => {
    for (;;) {
      const top = stack[stack.length - 1];
      if (top?.kind !== 'op') return;
      if (top.prec > prec || (top.prec === prec && !right))
        out.push((stack.pop() as { out: string }).out);
      else return;
    }
  };
  for (const t of tokens) {
    if (t.kind === 'num' || t.kind === 'str' || t.kind === 'ref') {
      if (!expectOperand) throw new Error(`看不懂的公式: ${formula}`);
      out.push(t.kind === 'num' ? `D${t.text}` : t.kind === 'str' ? `S${t.text}` : t.name);
      const fn = [...stack].reverse().find((s) => s.kind !== 'op');
      if (fn?.kind === 'func') fn.empty = false;
      expectOperand = false;
    } else if (t.kind === 'func') {
      stack.push({ kind: 'func', name: t.name, args: 1, empty: true });
    } else if (t.kind === '(') {
      if (
        stack[stack.length - 1]?.kind === 'func' &&
        (stack[stack.length - 1] as { empty: boolean }).empty
      )
        continue;
      stack.push({ kind: '(' });
      expectOperand = true;
    } else if (t.kind === ',') {
      while (stack.length && stack[stack.length - 1]?.kind === 'op')
        out.push((stack.pop() as { out: string }).out);
      const fn = stack[stack.length - 1];
      if (fn?.kind !== 'func') throw new Error(`公式里的逗号不在函数里: ${formula}`);
      fn.args++;
      expectOperand = true;
    } else if (t.kind === ')') {
      while (stack.length && stack[stack.length - 1]?.kind === 'op')
        out.push((stack.pop() as { out: string }).out);
      const top = stack.pop();
      if (!top) throw new Error(`公式括号不配对: ${formula}`);
      if (top.kind === 'func') out.push(`F:${top.name}:${top.empty ? 0 : top.args}`);
      else out.push('OG1');
      const fn = [...stack].reverse().find((s) => s.kind !== 'op');
      if (fn?.kind === 'func') fn.empty = false;
      expectOperand = false;
    } else if (t.text === '%' && !expectOperand) {
      popOps(PERCENT, false);
      out.push('OS%');
    } else if (expectOperand && (t.text === '-' || t.text === '+')) {
      stack.push({ kind: 'op', out: `OP${t.text}`, prec: PREFIX, right: true });
    } else {
      const prec = BINARY[t.text];
      if (prec === undefined || expectOperand) throw new Error(`看不懂的公式: ${formula}`);
      popOps(prec, false);
      stack.push({ kind: 'op', out: `OB${t.text}`, prec, right: false });
      expectOperand = true;
    }
  }
  while (stack.length) {
    const top = stack.pop() as StackItem;
    if (top.kind !== 'op') throw new Error(`公式括号不配对: ${formula}`);
    out.push(top.out);
  }
  return out;
}
