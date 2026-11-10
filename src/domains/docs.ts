/**
 * Docs and Drive over the Docs web app's APIs (`/space/api/...` on the tenant, see src/web.ts).
 * Paths and request shapes come from the web app's JavaScript; tested on a real account on
 * 2026-11-10 with documents and folders created for the test and removed afterwards:
 *
 * - Creating is `POST explorer/v2/create/object/` (form: type, name, parent_token, source=0,
 *   ua_type, scene), folders `POST explorer/v2/create/folder/`; the older `explorer/create/` cannot
 *   create inside such folders. Removing is `POST explorer/v3/remove/` (JSON: tokens, an array of
 *   node tokens), which moves to the trash; one bad token fails the whole call.
 * - My Space lists documents (`my_space/obj`) and folders (`my_space/folder`) separately; a
 *   folder's listing (`children/list`) also returns the folder itself among its entities, so only
 *   `node_list` counts.
 * - Files have two tokens: the node token (`token`, used by Drive operations) and the object token
 *   (`obj_token`, used to open the content, e.g. the docx id).
 * - A docx's content is `GET docx/pages/client_vars`: a block map whose texts are Etherpad-style
 *   attributed strings. Only the page title and plain texts are read here; how other block kinds
 *   (headings, lists, tables) are marked up could not be checked, because importing Markdown to
 *   create a document with content was refused by the server ("invalid param") in every encoding
 *   tried.
 */
import type { WebSession } from '../web.js';

/** Drive object types (the `type` of explorer nodes). */
export const DOC_TYPES = {
  folder: 0,
  doc: 2,
  sheet: 3,
  base: 8,
  mindnote: 11,
  file: 12,
  docx: 22,
} as const;
export type DocType = keyof typeof DOC_TYPES;
const TYPE_NAMES = Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [v, k])) as Record<
  number,
  DocType
>;
/** The "My Space" root node in listings. */
const TYPE_ROOT = 4;

export interface DriveFile {
  /** Node token: what Drive operations (remove, list children) take. */
  token: string;
  /** Object token: what opens the content (e.g. a docx id). */
  objToken: string;
  name: string;
  type: DocType | 'unknown';
  url: string;
  ownerId: string;
  /** Last edit time (s). */
  editTime: number;
}

export interface DocHit {
  objToken: string;
  title: string;
  type: DocType | 'unknown';
  url: string;
  ownerId: string;
  /** Last edit time (s). */
  editTime: number;
  preview: string;
}

export interface DocContent {
  objToken: string;
  title: string;
  /** Texts of the blocks under the page, in document order. */
  paragraphs: string[];
}

type Dict = Record<string, unknown>;
const typeOf = (t: unknown) => TYPE_NAMES[Number(t)] ?? 'unknown';
const plain = (s: unknown) => String(s ?? '').replace(/<\/?em>/g, '');

/** Block text: the attributed text's segments joined in order. */
function blockText(data: Dict | undefined): string {
  const segs = ((data?.text as Dict | undefined)?.initialAttributedTexts as Dict | undefined)
    ?.text as Record<string, string> | undefined;
  if (!segs) return '';
  return Object.keys(segs)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => segs[k])
    .join('');
}

const toFile = (n: Dict): DriveFile => ({
  token: String(n.token ?? ''),
  objToken: String(n.obj_token ?? n.token ?? ''),
  name: String(n.name ?? ''),
  type: typeOf(n.type),
  url: String(n.url ?? ''),
  ownerId: String(n.owner_id ?? ''),
  editTime: Number(n.edit_time ?? 0),
});

/** A docx URL or a bare object token → the object token. */
export function docToken(urlOrToken: string): string {
  const m = /\/(?:docx|docs|doc|sheets|base|wiki|file|mindnotes)\/([A-Za-z0-9]+)/.exec(urlOrToken);
  return m ? (m[1] as string) : urlOrToken.trim();
}

export class Docs {
  constructor(readonly web: WebSession) {}

  /** Documents I can read whose title or content matches query, most relevant first. */
  async search(query: string, limit = 20): Promise<DocHit[]> {
    const body = (await this.web.json('GET', '/space/api/search/refine_search/', {
      query: { query, count: limit },
    })) as Dict;
    const data = (body.data ?? {}) as Dict;
    const objs = ((data.entities as Dict | undefined)?.objs ?? {}) as Record<string, Dict>;
    return ((data.tokens ?? []) as string[]).flatMap((t) => {
      const o = objs[t];
      return o
        ? [
            {
              objToken: String(o.token ?? t),
              title: plain(o.title),
              type: typeOf(o.type),
              url: String(o.url ?? ''),
              ownerId: String(o.owner_id ?? ''),
              editTime: Number(o.edit_time ?? 0),
              preview: plain(o.preview),
            },
          ]
        : [];
    });
  }

  /** Files in My Space (folder omitted) or in a folder (its node token), folders first. */
  async list(folder?: string, limit = 200): Promise<DriveFile[]> {
    const pages = folder
      ? [['/space/api/explorer/v3/children/list/', { token: folder, length: limit }]]
      : [
          ['/space/api/explorer/v3/my_space/folder/', { length: limit }],
          ['/space/api/explorer/v3/my_space/obj/', { length: limit }],
        ];
    const out: DriveFile[] = [];
    for (const [path, query] of pages as [string, Record<string, string | number>][]) {
      const data = (((await this.web.json('GET', path, { query })) as Dict).data ?? {}) as Dict;
      const nodes = ((data.entities as Dict | undefined)?.nodes ?? {}) as Record<string, Dict>;
      for (const t of (data.node_list ?? []) as string[]) {
        const n = nodes[t];
        if (!n || Number(n.type) === TYPE_ROOT) continue;
        out.push(toFile(n));
      }
    }
    return out;
  }

  /** Create an empty document (or folder) in My Space or a folder (node token). */
  async create(name: string, o: { type?: DocType; folder?: string } = {}): Promise<DriveFile> {
    const type = o.type ?? 'docx';
    const body = (await (type === 'folder'
      ? this.web.json('POST', '/space/api/explorer/v2/create/folder/', {
          form: { parent_token: o.folder ?? '', name, source: 0 },
        })
      : this.web.json('POST', '/space/api/explorer/v2/create/object/', {
          form: {
            type: DOC_TYPES[type],
            name,
            parent_token: o.folder ?? '',
            source: 0,
            ua_type: 'Web',
            scene: 'space_create',
          },
        }))) as Dict;
    const data = (body.data ?? {}) as Dict;
    const token = ((data.node_list ?? []) as string[])[0];
    const node = token
      ? ((data.entities as Dict | undefined)?.nodes as Record<string, Dict>)?.[token]
      : undefined;
    if (body.code !== 0 || !token) throw new Error(`新建失败: ${String(body.msg ?? body.code)}`);
    return node ? toFile(node) : { ...toFile({ token, name, type: DOC_TYPES[type] }) };
  }

  /**
   * Move files (node tokens) to the trash, one call each so one bad token does not block the rest;
   * the owner can restore them from there. Returns the tokens that failed, with the reason.
   */
  async remove(tokens: string[]): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    for (const t of tokens) {
      const body = (await this.web
        .json('POST', '/space/api/explorer/v3/remove/', { json: { tokens: [t] } })
        .catch((e: Error & { reason?: string }) => ({
          code: -1,
          msg: e.reason || e.message,
        }))) as Dict;
      if (body.code !== 0) failed.set(t, String(body.msg ?? body.code));
    }
    return failed;
  }

  /** A docx's title and the plain texts of its blocks, paging through all blocks. */
  async fetch(urlOrToken: string): Promise<DocContent> {
    const objToken = docToken(urlOrToken);
    const blocks: Record<string, Dict> = {};
    let root = '';
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const body = (await this.web.json('GET', '/space/api/docx/pages/client_vars', {
        query: { id: objToken, mode: 7, limit: 239, ...(cursor ? { cursor } : {}) },
      })) as Dict;
      if (body.code !== 0) throw new Error(`读取文档失败: ${String(body.msg ?? body.code)}`);
      const data = (body.data ?? {}) as Dict;
      Object.assign(blocks, (data.block_map ?? {}) as Record<string, Dict>);
      root ||= String(((data.block_sequence ?? []) as string[])[0] ?? '');
      cursor = String(data.cursor ?? '');
      if (!data.has_more || !cursor) break;
    }
    const page = (blocks[root]?.data ?? {}) as Dict;
    const paragraphs: string[] = [];
    const walk = (id: string) => {
      const data = blocks[id]?.data as Dict | undefined;
      if (!data) return;
      const text = blockText(data);
      if (text) paragraphs.push(text);
      for (const child of (data.children ?? []) as string[]) walk(child);
    };
    for (const child of (page.children ?? []) as string[]) walk(child);
    return { objToken, title: blockText(page), paragraphs };
  }
}
