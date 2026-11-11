/**
 * A docx's block map (from `docx/pages/client_vars`) → Markdown. Block shapes were read from
 * documents created by importing Markdown on 2026-11-10:
 *
 * - Every block's `data` has a `type` and, for containers, `children` (block ids).
 * - Texts are Etherpad-style attributed strings: `text.initialAttributedTexts.text` holds the
 *   characters and `.attribs` the changeset (`*a*b+len` applies pool attributes a and b to the next
 *   `len` UTF-16 code units, numbers in base 36); `text.apool.numToAttrib` maps an attribute number to
 *   `[name, value]`, e.g. `["bold","true"]`, `["link","<url-encoded url>"]`, `["author", id]`.
 * - Kinds seen: page (the title), text, heading1..9, bullet, ordered (`seq`), todo (`done`), quote,
 *   code (`language`), divider, table (`rows_id`, `columns_id`, `cell_set` keyed by row id +
 *   column id → `{block_id}` of a table_cell whose children hold the cell's blocks); an
 *   image (`image.token`, `image.caption.text`) renders as `![caption](file token)`, an attachment
 *   (a `view` block holding a `file` block, `file.name` / `file.token`) as `[name](file token)`. Other kinds
 *   (callouts, grids, ...) render their text, or nothing when they have none.
 */

type Dict = Record<string, unknown>;
export type BlockMap = Record<string, { data?: Dict } | undefined>;

const INLINE: Record<string, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strikethrough: ['~~', '~~'],
  inlineCode: ['`', '`'],
};

/** A block's text with inline styles and links as Markdown. */
export function attributedText(text: Dict | undefined): string {
  const initial = (text?.initialAttributedTexts ?? {}) as Dict;
  const segs = (initial.text ?? {}) as Record<string, string>;
  const attribs = (initial.attribs ?? {}) as Record<string, string>;
  const pool = ((text?.apool as Dict | undefined)?.numToAttrib ?? {}) as Record<
    string,
    [string, string]
  >;
  let out = '';
  for (const key of Object.keys(segs).sort((a, b) => Number(a) - Number(b))) {
    const str = segs[key] ?? '';
    const ops = attribs[key];
    if (!ops) {
      out += str;
      continue;
    }
    let pos = 0;
    for (const m of ops.matchAll(/((?:\*[0-9a-z]+)*)(?:\|[0-9a-z]+)?\+([0-9a-z]+)/g)) {
      const len = Number.parseInt(m[2] as string, 36);
      let piece = str.slice(pos, pos + len);
      pos += len;
      const names = ((m[1] ?? '').match(/[0-9a-z]+/g) ?? []).map(
        (n) => pool[String(Number.parseInt(n, 36))],
      );
      let link = '';
      for (const attr of names) {
        if (!attr || attr[1] === 'false') continue;
        const style = INLINE[attr[0]];
        if (style && piece.trim()) piece = `${style[0]}${piece}${style[1]}`;
        if (attr[0] === 'link') link = decodeURIComponent(attr[1]);
      }
      out += link ? `[${piece}](${link})` : piece;
    }
    out += str.slice(pos);
  }
  return out;
}

const textOf = (blocks: BlockMap, id: string) =>
  attributedText(blocks[id]?.data?.text as Dict | undefined);

function table(blocks: BlockMap, data: Dict): string[] {
  const rows = (data.rows_id ?? []) as string[];
  const cols = (data.columns_id ?? []) as string[];
  const cells = (data.cell_set ?? {}) as Record<string, { block_id?: string }>;
  const cell = (r: string, c: string) => {
    const id = cells[`${r}${c}`]?.block_id;
    const children = (id ? (blocks[id]?.data?.children as string[] | undefined) : undefined) ?? [];
    return children
      .map((ch) => textOf(blocks, ch))
      .join(' ')
      .replace(/\|/g, '\\|');
  };
  const lines = rows.map((r) => `| ${cols.map((c) => cell(r, c)).join(' | ')} |`);
  if (lines.length) lines.splice(1, 0, `| ${cols.map(() => '---').join(' | ')} |`);
  return lines;
}

/** Markdown lines of one block and its children; depth indents nested list items. */
function render(blocks: BlockMap, id: string, depth: number): string[] {
  const data = blocks[id]?.data;
  if (!data) return [];
  const type = String(data.type ?? '');
  const text = attributedText(data.text as Dict | undefined);
  const children = (data.children ?? []) as string[];
  const indent = '  '.repeat(depth);
  const nested = (d: number) => children.flatMap((ch) => render(blocks, ch, d));
  const heading = /^heading([1-9])$/.exec(type);
  if (heading) return [`${'#'.repeat(Math.min(6, Number(heading[1])))} ${text}`, ...nested(depth)];
  switch (type) {
    case 'bullet':
      return [`${indent}- ${text}`, ...nested(depth + 1)];
    case 'ordered':
      return [`${indent}${String(data.seq ?? '1')}. ${text}`, ...nested(depth + 1)];
    case 'todo':
      return [`${indent}- [${data.done === true ? 'x' : ' '}] ${text}`, ...nested(depth + 1)];
    case 'quote':
      return [`> ${text}`, ...nested(depth).map((l) => `> ${l}`)];
    case 'code':
      return [`\`\`\`${String(data.language ?? '').toLowerCase()}`, text, '```'];
    case 'divider':
      return ['---'];
    case 'image': {
      // The Drive file token stands in for a URL: images are only reachable with the login.
      const image = (data.image ?? {}) as Dict;
      const caption = attributedText(
        ((image.caption as Dict | undefined)?.text ?? undefined) as Dict | undefined,
      );
      return [`![${caption}](${String(image.token ?? '')})`];
    }
    case 'whiteboard':
      // The token reads the board's nodes (Docs.whiteboard).
      return [`[画板](${String(data.token ?? '')})`];
    case 'file': {
      const file = (data.file ?? {}) as Dict;
      return [`[${String(file.name ?? '')}](${String(file.token ?? '')})`];
    }
    case 'table':
      return table(blocks, data);
    default:
      return [...(text ? [text] : []), ...nested(depth)];
  }
}

/** List kinds: consecutive items of the same kind stay together (no blank line between them). */
const LIST = new Set(['bullet', 'ordered', 'todo']);

/** The document as Markdown: the title as `# title`, then the page's blocks in order. */
export function docxToMarkdown(
  blocks: BlockMap,
  rootId: string,
): { title: string; markdown: string } {
  const page = blocks[rootId]?.data ?? {};
  const title = attributedText(page.text as Dict | undefined);
  const parts: string[] = [title ? `# ${title}` : ''];
  let prevKind = '';
  for (const id of (page.children ?? []) as string[]) {
    const lines = render(blocks, id, 0);
    if (!lines.length) continue;
    const kind = String(blocks[id]?.data?.type ?? '');
    parts.push(`${LIST.has(kind) && kind === prevKind ? '' : '\n'}${lines.join('\n')}`);
    prevKind = kind;
  }
  return { title, markdown: `${parts.join('\n').trim()}\n` };
}
