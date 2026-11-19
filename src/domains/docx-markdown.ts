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
 *   column id → `{block_id}` of a table_cell whose children hold the cell's blocks, rendered as
 *   one Markdown cell with `<br>` between lines); an image (`image.token`, `image.caption.text`)
 *   renders as `![caption](file token)`, an attachment (a `view` block holding a `file` block,
 *   `file.name` / `file.token`) as `[name](file token)`, a link card (`bookmark.url` /
 *   `bookmark.title`) and an embed (`iframe.component.original_text`, url-encoded) as links. Other
 *   kinds (callouts, grids, ...) render their text, or nothing when they have none.
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

/** Single-line link text: the brackets would end the Markdown link early. */
const label = (s: string) =>
  s.replace(/\s+/g, ' ').trim().replace(/\[/g, '［').replace(/\]/g, '］');

function table(blocks: BlockMap, data: Dict): string[] {
  const rows = (data.rows_id ?? []) as string[];
  const cols = (data.columns_id ?? []) as string[];
  const cells = (data.cell_set ?? {}) as Record<string, { block_id?: string }>;
  // A Markdown cell holds one line: the cell's blocks (images, lists, attachments too) join with <br>
  const cell = (r: string, c: string) => {
    const id = cells[`${r}${c}`]?.block_id;
    const children = (id ? (blocks[id]?.data?.children as string[] | undefined) : undefined) ?? [];
    return renderAll(blocks, children, 0)
      .filter((l) => l.trim())
      .join('<br>')
      .replace(/\n/g, '<br>')
      .replace(/\|/g, '\\|');
  };
  const lines = rows.map((r) => `| ${cols.map((c) => cell(r, c)).join(' | ')} |`);
  if (lines.length) lines.splice(1, 0, `| ${cols.map(() => '---').join(' | ')} |`);
  return lines;
}

/**
 * Ordinals of sibling blocks: an ordered item's own number when Lark stores one, else the previous
 * item's plus one (Lark stores `auto` for items that continue the numbering); 0 for other kinds.
 */
function ordinals(blocks: BlockMap, ids: string[]): number[] {
  let n = 0;
  return ids.map((id) => {
    const data = blocks[id]?.data;
    const seq = String(data?.seq ?? '');
    if (data?.type !== 'ordered') n = 0;
    else n = /^\d+$/.test(seq) ? Number(seq) : n + 1;
    return n;
  });
}

/** Markdown lines of sibling blocks. */
function renderAll(blocks: BlockMap, ids: string[], depth: number): string[] {
  const nums = ordinals(blocks, ids);
  return ids.flatMap((id, i) => render(blocks, id, depth, nums[i] ?? 0));
}

/** Markdown lines of one block and its children; depth indents nested list items. */
function render(blocks: BlockMap, id: string, depth: number, ordinal = 0): string[] {
  const data = blocks[id]?.data;
  if (!data) return [];
  const type = String(data.type ?? '');
  const text = attributedText(data.text as Dict | undefined);
  const children = (data.children ?? []) as string[];
  const indent = '  '.repeat(depth);
  const nested = (d: number) => renderAll(blocks, children, d);
  const heading = /^heading([1-9])$/.exec(type);
  if (heading) return [`${'#'.repeat(Math.min(6, Number(heading[1])))} ${text}`, ...nested(depth)];
  switch (type) {
    case 'bullet':
      return [`${indent}- ${text}`, ...nested(depth + 1)];
    case 'ordered':
      return [`${indent}${ordinal || 1}. ${text}`, ...nested(depth + 1)];
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
      return [`![${label(caption)}](${String(image.token ?? '')})`];
    }
    case 'bookmark': {
      const bookmark = (data.bookmark ?? {}) as Dict;
      const url = String(bookmark.url ?? '');
      return url ? [`[${label(String(bookmark.title ?? '')) || url}](${url})`] : [];
    }
    case 'iframe': {
      // original_text is the link as pasted; component.url is the embed player's address
      const component = ((data.iframe as Dict | undefined)?.component ?? {}) as Dict;
      const encoded = String(component.original_text ?? '');
      let url = String(component.url ?? '');
      try {
        if (encoded) url = decodeURIComponent(encoded);
      } catch {}
      return url ? [`[${url}](${url})`] : [];
    }
    case 'whiteboard':
      // The token reads the board's nodes (Docs.whiteboard).
      return [`[画板](${String(data.token ?? '')})`];
    case 'file': {
      const file = (data.file ?? {}) as Dict;
      return [`[${label(String(file.name ?? ''))}](${String(file.token ?? '')})`];
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
  const ids = (page.children ?? []) as string[];
  const nums = ordinals(blocks, ids);
  for (const [i, id] of ids.entries()) {
    const lines = render(blocks, id, 0, nums[i] ?? 0);
    if (!lines.length) continue;
    const kind = String(blocks[id]?.data?.type ?? '');
    parts.push(`${LIST.has(kind) && kind === prevKind ? '' : '\n'}${lines.join('\n')}`);
    prevKind = kind;
  }
  return { title, markdown: `${parts.join('\n').trim()}\n` };
}
