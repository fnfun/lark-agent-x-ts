/**
 * Editing a docx: appending Markdown and replacing the whole body. Changes go to
 * `POST /space/api/docx/blocks/user_change` as JSON `{member_id (a string), uuid, page_id,
 * change_map}`, where change_map holds, per block, `{id, version, payload: {ops}}` with json0-style
 * ops (shapes from the docx editor's code, checked against the server on 2026-11-11 with documents
 * created for the test):
 *
 * - A new block: version 0 and `{p: [], action: {oi: <block data>}}`; data is what client_vars
 *   shows for that block type (markdown-docx.ts builds it).
 * - Adding it under a parent: on the parent, at its current version,
 *   `{p: ["children", index], action: {li: <block id>}}`; removing one: `{..., action: {ld: id}}`.
 * - A table is one block with `rows_id`, `columns_id`, `column_set` (widths) and `cell_set` (row id +
 *   column id → `{merge_info, block_id}`); each cell is a `table_cell` block holding a text block.
 * - Block ids are "dox" + the document's two-letter operation id + random letters and digits, 27
 *   characters long; the operation id comes from the document token (unscrambled when the token
 *   does not start with "dox").
 * - Changing a block's text: `{p: ["text"], action: {od: <old text>, oi: <new text>}}`; the text
 *   is the whole attributed text (pool + changeset), so replacing keeps each character's attributes.
 * - The reply's `data.type` is ACCEPT_COMMIT with the blocks' new versions.
 */
import type { WebSession } from '../web.js';
import { check, Docs } from './docs.js';
import {
  attributedText,
  type BlockSpec,
  parseMarkdown,
  type Run,
  replaceAttributed,
} from './markdown-docx.js';

type Dict = Record<string, unknown>;

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ID_LENGTH = 27;

/** The two-letter operation id new block ids of a document carry. */
export function operationId(docToken: string): string {
  const t = docToken;
  if (t.length !== ID_LENGTH || t.startsWith('dox')) return t.slice(3, 5);
  // Tokens not starting with "dox" carry the five characters at 4, 9, 14, 19, 24 up front.
  return [4, 9, 14, 19, 24]
    .map((i) => t.charAt(i))
    .join('')
    .slice(3, 5);
}

/** A new block id for a document. */
export function newBlockId(docToken: string): string {
  let id = `dox${operationId(docToken)}`;
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  for (let i = 0; id.length < ID_LENGTH; i++)
    id += ID_CHARS[(bytes[i] as number) % ID_CHARS.length];
  return id;
}

interface Page {
  version: number;
  children: string[];
}

/** Fields every block carries. */
const common = (type: string, parent: string, author: string): Dict => ({
  type,
  parent_id: parent,
  comments: null,
  revisions: null,
  locked: false,
  hidden: false,
  author,
});

/** Total column width a new table spreads over, as the server lays out imported tables. */
const TABLE_WIDTH = 730;

/**
 * A table's record data: row and column ids ("row"/"col" + a UUID), widths, and a cell per row and
 * column whose block (a table_cell holding one text block) `addCell` creates.
 */
function tableData(
  spec: BlockSpec,
  parent: string,
  author: string,
  addCell: (runs: Run[], cellId: string) => void,
  newId: () => string,
): Dict {
  const rows = spec.rows ?? [];
  const width = Math.max(1, ...rows.map((r) => r.length));
  const rowIds = rows.map(() => `row${crypto.randomUUID()}`);
  const colIds = Array.from({ length: width }, () => `col${crypto.randomUUID()}`);
  const cellSet: Dict = {};
  rows.forEach((row, r) => {
    colIds.forEach((col, c) => {
      const cellId = newId();
      addCell(row[c] ?? [], cellId);
      cellSet[`${rowIds[r]}${col}`] = {
        merge_info: { row_span: 1, col_span: 1 },
        block_id: cellId,
      };
    });
  });
  return {
    ...common('table', parent, author),
    rows_id: rowIds,
    columns_id: colIds,
    column_set: Object.fromEntries(
      colIds.map((c) => [c, { column_width: Math.floor(TABLE_WIDTH / width) }]),
    ),
    cell_set: cellSet,
  };
}

/** One block's record data, as client_vars shows it. */
function blockData(spec: BlockSpec, parent: string, children: string[], author: string): Dict {
  const base = common(spec.type, parent, author);
  if (spec.type === 'divider') return base;
  return {
    ...base,
    align: '',
    children,
    text: attributedText(spec.runs ?? [], author),
    ...(spec.seq !== undefined ? { seq: spec.seq } : {}),
    ...(spec.done !== undefined ? { done: spec.done } : {}),
    ...(spec.language !== undefined ? { language: spec.language } : {}),
  };
}

export class DocEditor {
  constructor(readonly web: WebSession) {}

  /** Append Markdown at the end of a docx; returns how many top-level blocks were added. */
  async append(docToken: string, markdown: string): Promise<number> {
    const page = await this.page(docToken);
    const specs = parseMarkdown(markdown);
    if (!specs.length) return 0;
    const author = await this.me();
    const changes: Record<string, Dict> = {};
    const put = (id: string, data: Dict) => {
      changes[id] = { id, version: 0, payload: { ops: [{ p: [], action: { oi: data } }] } };
    };
    const create = (spec: BlockSpec, parent: string): string => {
      const id = newBlockId(docToken);
      if (spec.type === 'table') {
        put(
          id,
          tableData(
            spec,
            parent,
            author,
            (cellRuns, cellId) => {
              const textId = newBlockId(docToken);
              put(
                textId,
                blockData({ type: 'text', runs: cellRuns, children: [] }, cellId, [], author),
              );
              put(cellId, { ...common('table_cell', id, author), children: [textId] });
            },
            () => newBlockId(docToken),
          ),
        );
        return id;
      }
      const kids = spec.children.map((c) => create(c, id));
      put(id, blockData(spec, parent, kids, author));
      return id;
    };
    const ids = specs.map((s) => create(s, docToken));
    changes[docToken] = {
      id: docToken,
      version: page.version,
      payload: {
        ops: ids.map((id, i) => ({
          p: ['children', page.children.length + i],
          action: { li: id },
        })),
      },
    };
    await this.commit(docToken, changes);
    return ids.length;
  }

  /** Replace the body of a docx (everything below the title) with Markdown. */
  async overwrite(docToken: string, markdown: string): Promise<number> {
    const page = await this.page(docToken);
    if (page.children.length)
      await this.commit(docToken, {
        [docToken]: {
          id: docToken,
          version: page.version,
          // Remove from the end so the remaining indexes stay valid.
          payload: {
            ops: page.children
              .map((id, i) => ({ p: ['children', i], action: { ld: id } }))
              .reverse(),
          },
        },
      });
    return this.append(docToken, markdown);
  }

  /**
   * Replace text throughout a docx, keeping the formatting of the replaced characters. Blocks whose
   * text has several zones (not seen in documents so far) are left alone and counted as skipped.
   */
  async replace(
    docToken: string,
    find: string,
    replacement: string,
  ): Promise<{ replaced: number; blocks: number; skipped: number }> {
    if (!find) throw new Error('要替换的文字不能为空');
    const { blocks } = await new Docs(this.web).blocks(
      '/space/api/docx/pages/client_vars',
      docToken,
    );
    const changes: Record<string, Dict> = {};
    let replaced = 0;
    let skipped = 0;
    for (const [id, record] of Object.entries(blocks)) {
      const data = (record.data ?? {}) as Dict;
      if (data.type === 'page') continue;
      const old = data.text as Dict | undefined;
      const initial = (old?.initialAttributedTexts ?? {}) as Dict;
      const texts = (initial.text ?? {}) as Record<string, string>;
      const text = texts['0'];
      if (text === undefined || !text.includes(find)) continue;
      if (Object.keys(texts).length !== 1) {
        skipped++;
        continue;
      }
      const r = replaceAttributed(
        text,
        ((initial.attribs ?? {}) as Record<string, string>)['0'] ?? '',
        find,
        replacement,
      );
      if (!r) continue;
      replaced += r.count;
      const neu = {
        ...old,
        initialAttributedTexts: { text: { 0: r.text }, attribs: { 0: r.attribs } },
      };
      changes[id] = {
        id,
        version: Number(record.version ?? 0),
        payload: { ops: [{ p: ['text'], action: { od: old, oi: neu } }] },
      };
    }
    if (Object.keys(changes).length) await this.commit(docToken, changes);
    return { replaced, blocks: Object.keys(changes).length, skipped };
  }

  private async commit(docToken: string, changeMap: Record<string, Dict>): Promise<void> {
    const reply = check(
      await this.web.json('POST', '/space/api/docx/blocks/user_change', {
        json: {
          member_id: String(Math.floor(Math.random() * 9e13) + 1e13),
          uuid: crypto.randomUUID(),
          page_id: docToken,
          change_map: changeMap,
        },
      }),
      '编辑文档',
    );
    const data = (reply.data ?? {}) as Dict;
    if (data.type !== 'ACCEPT_COMMIT') throw new Error(`编辑文档失败: ${String(data.type)}`);
  }

  /** The page (root) block's version and children. */
  private async page(docToken: string): Promise<Page> {
    const body = check(
      await this.web.json('GET', '/space/api/docx/pages/client_vars', {
        query: { id: docToken, mode: 7, limit: 1 },
      }),
      '读取文档',
    );
    const record = (((body.data as Dict | undefined)?.block_map ?? {}) as Record<string, Dict>)[
      docToken
    ];
    if (!record) throw new Error('读取文档失败: 找不到文档的根块');
    const data = (record.data ?? {}) as Dict;
    return {
      version: Number(record.version ?? 0),
      children: ((data.children ?? []) as string[]).slice(),
    };
  }

  /** The current user's id, which blocks record as their author. */
  private async me(): Promise<string> {
    const body = check(await this.web.json('GET', '/space/api/user/'), '读取用户信息');
    return String((body.data as Dict | undefined)?.suid ?? '');
  }
}
