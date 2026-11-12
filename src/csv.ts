/**
 * CSV as RFC 4180 describes it: fields separated by commas, rows by CRLF or LF; a field holding a
 * comma, quote or line break is quoted, with quotes doubled. Written here rather than taken from a
 * library because the project adds no dependencies on its own, and the format is this small.
 */

/** Rows of a CSV text; a trailing line break does not make an empty last row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A UTF-8 BOM (as spreadsheet apps write) is not part of the first field
  const s = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (s[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV 格式不对: 引号没有闭合');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Rows as CSV text, one line per row (LF), quoting only the fields that need it. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return rows.map((r) => r.map(quote).join(',')).join('\n');
}
