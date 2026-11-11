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
 * - An image block is created with an empty `image.token`; the file is then uploaded mounted on that
 *   block (point `docx_image`, node = block id, extra `drive_route_token` = the doc) and the token
 *   set with `{p: ["image", "token"], action: {od: "", oi: <file token>}}`. Uploading before the
 *   block exists answers "mount node not exist", mounting on the document "relation mismatch".
 * - An attachment is a `view` block (`view_type: "Preview"`) holding a `file` block
 *   (`file: {token, mimeType, size, name}`), uploaded the same way with point `docx_file` on the
 *   file block and its token set with `{p: ["file", "token"], ...}` (read off the web app's traffic
 *   on 2026-11-11).
 * - Block ids are "dox" + the document's two-letter operation id + random letters and digits, 27
 *   characters long; the operation id comes from the document token (unscrambled when the token
 *   does not start with "dox").
 * - Changing a block's text: `{p: ["text"], action: {od: <old text>, oi: <new text>}}`; the text
 *   is the whole attributed text (pool + changeset), so replacing keeps each character's attributes.
 * - The reply's `data.type` is ACCEPT_COMMIT with the blocks' new versions.
 */
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { imageInfo } from '../media.js';
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

/** A file to put in a document: an image for an image block, or any file as an attachment. */
export interface ImageFile {
  data: Uint8Array;
  name: string;
}

export interface AppendOptions {
  /** Where relative image paths start (the current directory by default). */
  baseDir?: string;
  /** Loads an image by its Markdown source; by default URLs are fetched and paths read. */
  loadImage?: (src: string) => Promise<ImageFile>;
}

async function defaultLoadImage(src: string, baseDir: string): Promise<ImageFile> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`下载图片失败(${res.status}): ${src}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      name: basename(new URL(src).pathname) || 'image',
    };
  }
  const path = resolve(baseDir, decodeURI(src));
  try {
    return { data: new Uint8Array(await readFile(path)), name: basename(path) };
  } catch (e) {
    throw new Error(
      `读取图片失败: ${path}(${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
    );
  }
}

/** MIME types the web app records for common attachments; others are octet-stream. */
const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};
const mimeOf = (name: string) =>
  MIME_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

interface Prepared {
  specs: BlockSpec[];
  images: Map<BlockSpec, ImageFile>;
}

export class DocEditor {
  constructor(readonly web: WebSession) {}

  /** Append Markdown at the end of a docx; returns how many top-level blocks were added. */
  async append(docToken: string, markdown: string, o: AppendOptions = {}): Promise<number> {
    return this.insert(docToken, await this.prepare(markdown, o));
  }

  /** Parses Markdown and loads its images, so a missing image fails before anything is written. */
  private async prepare(markdown: string, o: AppendOptions): Promise<Prepared> {
    const specs = parseMarkdown(markdown);
    const load =
      o.loadImage ?? ((src: string) => defaultLoadImage(src, o.baseDir ?? process.cwd()));
    const images = new Map<BlockSpec, ImageFile>();
    const collect = async (list: BlockSpec[]) => {
      for (const spec of list) {
        if (spec.type === 'image') images.set(spec, await load(spec.src ?? ''));
        await collect(spec.children);
      }
    };
    await collect(specs);
    return { specs, images };
  }

  private async insert(docToken: string, { specs, images }: Prepared): Promise<number> {
    if (!specs.length) return 0;
    const page = await this.page(docToken);
    const author = await this.me();
    const pending: { id: string; file: ImageFile }[] = [];
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
      if (spec.type === 'image') {
        const file = images.get(spec) as ImageFile;
        const info = imageInfo(file.data);
        if (!info)
          throw new Error(`不认识的图片格式: ${spec.src ?? ''}(支持 PNG、JPEG、GIF、WebP)`);
        pending.push({ id, file });
        put(id, {
          ...common('image', parent, author),
          area_comments: null,
          align: 'center',
          image: {
            token: '',
            mimeType: info.mimeType,
            size: file.data.length,
            width: info.width,
            height: info.height,
            name: file.name,
            crop: [0, 0, 0, 0],
            rotation: 0,
            scale: 1,
            caption: { text: attributedText(spec.runs ?? [], author) },
          },
        });
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
    if (pending.length) {
      const docs = new Docs(this.web);
      const tokens: Record<string, Dict> = {};
      for (const { id, file } of pending) {
        const uploaded = await docs.upload(file.data, file.name, {
          mount: { point: 'docx_image', node: id, extra: { drive_route_token: docToken } },
        });
        tokens[id] = {
          id,
          version: 1,
          payload: { ops: [{ p: ['image', 'token'], action: { od: '', oi: uploaded.objToken } }] },
        };
      }
      await this.commit(docToken, tokens);
    }
    return ids.length;
  }

  /** Append files as attachments at the end of a docx; returns how many were added. */
  async attach(docToken: string, files: ImageFile[]): Promise<number> {
    if (!files.length) return 0;
    const page = await this.page(docToken);
    const author = await this.me();
    const changes: Record<string, Dict> = {};
    const put = (id: string, data: Dict) => {
      changes[id] = { id, version: 0, payload: { ops: [{ p: [], action: { oi: data } }] } };
    };
    const blocks = files.map((file) => {
      const view = newBlockId(docToken);
      const id = newBlockId(docToken);
      put(view, { ...common('view', docToken, author), children: [id], view_type: 'Preview' });
      put(id, {
        ...common('file', view, author),
        children: [],
        file: { token: '', mimeType: mimeOf(file.name), size: file.data.length, name: file.name },
      });
      return { view, id, file };
    });
    changes[docToken] = {
      id: docToken,
      version: page.version,
      payload: {
        ops: blocks.map(({ view }, i) => ({
          p: ['children', page.children.length + i],
          action: { li: view },
        })),
      },
    };
    await this.commit(docToken, changes);
    const docs = new Docs(this.web);
    const tokens: Record<string, Dict> = {};
    for (const { id, file } of blocks) {
      const uploaded = await docs.upload(file.data, file.name, {
        mount: { point: 'docx_file', node: id, extra: { drive_route_token: docToken } },
      });
      tokens[id] = {
        id,
        version: 1,
        payload: { ops: [{ p: ['file', 'token'], action: { od: '', oi: uploaded.objToken } }] },
      };
    }
    await this.commit(docToken, tokens);
    return blocks.length;
  }

  /** Replace the body of a docx (everything below the title) with Markdown. */
  async overwrite(docToken: string, markdown: string, o: AppendOptions = {}): Promise<number> {
    const prepared = await this.prepare(markdown, o);
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
    return this.insert(docToken, prepared);
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
