/**
 * Just enough of .xlsx (Office Open XML) to read cell values back from a sheet export: the zip
 * container (stored or deflated entries, found through the central directory) and the workbook,
 * relationships, shared strings and worksheet parts. Styles, merged cells and dates' number
 * formats are ignored; a formula cell yields its cached value, or "=formula" when it has none.
 */
import { inflateRawSync } from 'node:zlib';

export type CellValue = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  /** Rows from row 1; each row from column A; missing cells are null. */
  rows: CellValue[][];
}

/** The entries of a zip archive by name. */
export function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = data.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('不是 zip 文件');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目录损坏');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = data.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(body)) : body);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (ENTITIES[e] ?? m),
  );
/** The text of all <t> elements inside a fragment (rich text runs joined). */
const texts = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1] as string)).join('');

/** "C12" → [row index, column index], both from 0. */
export function cellIndex(ref: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) throw new Error(`看不懂的单元格: ${ref}(用 A1 这样的写法)`);
  let col = 0;
  for (const ch of (m[1] as string).toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

function parseSheet(xml: string, shared: string[]): CellValue[][] {
  const rows: CellValue[][] = [];
  for (const c of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = c[1] as string;
    const inner = c[2] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="(\w+)"/.exec(attrs)?.[1] ?? 'n';
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
    const f = /<f(?:\s[^>]*)?>([^<]*)<\/f>/.exec(inner)?.[1];
    let value: CellValue = null;
    if (type === 'inlineStr') value = texts(inner);
    else if (v === undefined) value = f !== undefined ? `=${decode(f)}` : null;
    else if (type === 's') value = shared[Number(v)] ?? '';
    else if (type === 'b') value = v === '1';
    else if (type === 'str' || type === 'e') value = decode(v);
    else value = Number(v);
    const [r, col] = cellIndex(ref);
    const row = rows[r] ?? [];
    rows[r] = row;
    while (row.length < col) row.push(null);
    row[col] = value;
  }
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}

/** The sheets of an .xlsx file, in workbook order. */
export function readXlsx(data: Uint8Array): XlsxSheet[] {
  const files = unzip(data);
  const text = (name: string) => {
    const f = files.get(name);
    return f ? new TextDecoder().decode(f) : '';
  };
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    texts(m[1] as string),
  );
  const targets = new Map(
    [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1] ?? '',
      /Target="([^"]+)"/.exec(m[0])?.[1] ?? '',
    ]),
  );
  return [...text('xl/workbook.xml').matchAll(/<sheet\s[^>]*>/g)].map((m) => {
    const name = decode(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const target = targets.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name, rows: parseSheet(text(path), shared) };
  });
}
