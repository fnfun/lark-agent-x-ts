/**
 * Markdown → docx blocks, the inverse of docx-markdown.ts. Block shapes and the attributed-text
 * encoding were copied from documents created by importing Markdown on 2026-11-11.
 *
 * Supported: headings (#..######), paragraphs (consecutive lines join with a space), bullet,
 * ordered (with its number as `seq`) and to-do items nested by indentation, quotes (one block per
 * line), fenced code with a language, dividers, and inline bold, italic, strikethrough, code and
 * links. Tables and images are kept as plain text.
 */

/** A run of text with its inline styles. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  inlineCode?: boolean;
  link?: string;
}

export interface BlockSpec {
  type: string;
  runs?: Run[];
  seq?: string;
  done?: boolean;
  language?: string;
  children: BlockSpec[];
}

type Style = Omit<Run, 'text'>;

/** Inline Markdown → runs. */
export function parseInline(text: string, style: Style = {}): Run[] {
  const runs: Run[] = [];
  const pattern =
    /\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), ...style });
    if (m[1] !== undefined || m[2] !== undefined)
      runs.push(...parseInline((m[1] ?? m[2]) as string, { ...style, bold: true }));
    else if (m[3] !== undefined) runs.push(...parseInline(m[3], { ...style, strikethrough: true }));
    else if (m[4] !== undefined) runs.push({ text: m[4], ...style, inlineCode: true });
    else if (m[5] !== undefined)
      runs.push(...parseInline(m[5], { ...style, link: m[6] as string }));
    else runs.push(...parseInline((m[7] ?? m[8]) as string, { ...style, italic: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), ...style });
  return runs.filter((r) => r.text);
}

/** Code fence languages whose display name is not just capitalised. */
const LANGUAGES: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  php: 'PHP',
  cpp: 'C++',
  'c++': 'C++',
  csharp: 'C#',
  'c#': 'C#',
  sh: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  py: 'Python',
  md: 'Markdown',
};
const language = (name: string) => {
  const n = name.trim().toLowerCase();
  if (!n) return 'PlainText';
  return LANGUAGES[n] ?? n[0]?.toUpperCase() + n.slice(1);
};

const LIST_ITEM = /^(\s*)(?:([-*+])\s+(?:\[([ xX])\]\s+)?|(\d+)[.)]\s+)(.*)$/;

/** Markdown → top-level blocks (list items carry their nested items as children). */
export function parseMarkdown(markdown: string): BlockSpec[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockSpec[] = [];
  /** Open list items by indentation, innermost last. */
  let stack: { indent: number; block: BlockSpec }[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ type: 'text', runs: parseInline(paragraph.join(' ')), children: [] });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flush();
      stack = [];
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i] as string); i++)
        body.push(lines[i] as string);
      blocks.push({
        type: 'code',
        language: language(fence[1] ?? ''),
        runs: [{ text: body.join('\n') }],
        children: [],
      });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const indent = (item[1] ?? '').replace(/\t/g, '    ').length;
      const block: BlockSpec =
        item[3] !== undefined
          ? { type: 'todo', done: item[3].toLowerCase() === 'x', children: [] }
          : item[4] !== undefined
            ? { type: 'ordered', seq: item[4], children: [] }
            : { type: 'bullet', children: [] };
      block.runs = parseInline(item[5] ?? '');
      while (stack.length && (stack[stack.length - 1] as { indent: number }).indent >= indent)
        stack.pop();
      const parent = stack[stack.length - 1];
      (parent ? parent.block.children : blocks).push(block);
      stack.push({ indent, block });
      continue;
    }
    stack = [];
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: `heading${(heading[1] as string).length}`,
        runs: parseInline((heading[2] as string).replace(/\s+#+\s*$/, '')),
        children: [],
      });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'divider', children: [] });
    } else if (/^\s*>/.test(line)) {
      flush();
      blocks.push({ type: 'quote', runs: parseInline(line.replace(/^\s*>\s?/, '')), children: [] });
    } else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

const STYLE_KEYS = ['bold', 'italic', 'strikethrough', 'inlineCode'] as const;

/**
 * Runs → a docx text value: attribute 0 is the author, then one pool entry per style or link
 * used; each run is `*0*a*b+len` with the length in UTF-16 units, base 36.
 */
export function attributedText(runs: Run[], author: string) {
  const pool: [string, string][] = [['author', author]];
  const index = (attr: [string, string]) => {
    const i = pool.findIndex(([k, v]) => k === attr[0] && v === attr[1]);
    if (i >= 0) return i;
    pool.push(attr);
    return pool.length - 1;
  };
  let text = '';
  let attribs = '';
  for (const r of runs) {
    const attrs = [0];
    for (const k of STYLE_KEYS) if (r[k]) attrs.push(index([k, 'true']));
    if (r.link) attrs.push(index(['link', encodeURIComponent(r.link)]));
    attribs += `${attrs
      .sort((a, b) => a - b)
      .map((a) => `*${a.toString(36)}`)
      .join('')}+${r.text.length.toString(36)}`;
    text += r.text;
  }
  return {
    apool: { nextNum: pool.length, numToAttrib: Object.fromEntries(pool.map((a, i) => [i, a])) },
    initialAttributedTexts: { text: { 0: text }, attribs: { 0: attribs } },
  };
}
