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
 * - Block ids are "dox" + the document's two-letter operation id + random letters and digits, 27
 *   characters long; the operation id comes from the document token (unscrambled when the token
 *   does not start with "dox").
 * - The reply's `data.type` is ACCEPT_COMMIT with the blocks' new versions.
 */
import type { WebSession } from '../web.js';
import { check } from './docs.js';
import { attributedText, type BlockSpec, parseMarkdown } from './markdown-docx.js';

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

/** One block's record data, as client_vars shows it. */
function blockData(spec: BlockSpec, parent: string, children: string[], author: string): Dict {
  const base: Dict = {
    type: spec.type,
    parent_id: parent,
    comments: null,
    revisions: null,
    locked: false,
    hidden: false,
    author,
  };
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
    const create = (spec: BlockSpec, parent: string): string => {
      const id = newBlockId(docToken);
      const kids = spec.children.map((c) => create(c, id));
      changes[id] = {
        id,
        version: 0,
        payload: { ops: [{ p: [], action: { oi: blockData(spec, parent, kids, author) } }] },
      };
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
