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
 * - A docx's content is `GET docx/pages/client_vars` (paged by cursor), converted to Markdown by
 *   docx-markdown.ts.
 * - Removing is asynchronous (the reply carries a task id): a listing right after it may still show
 *   the file for a moment.
 * - Importing a file: upload it to Drive's upload host (`box/stream/upload/all`, mount point
 *   `ccm_import`, Adler-32 checksum, `ext[extra]` naming the target type), then `POST import/create/`
 *   as JSON with `event_source: 1` (a string there gives "invalid param"), then poll
 *   `import/result/<ticket>` until `job_status` leaves 1/2 (0 means done).
 */
import type { WebSession } from '../web.js';
import { type BlockMap, docxToMarkdown } from './docx-markdown.js';

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
  /** The whole document as Markdown, starting with `# title`. */
  markdown: string;
}

type Dict = Record<string, unknown>;
const typeOf = (t: unknown) => TYPE_NAMES[Number(t)] ?? 'unknown';
const plain = (s: unknown) => String(s ?? '').replace(/<\/?em>/g, '');

const toFile = (n: Dict): DriveFile => ({
  token: String(n.token ?? ''),
  objToken: String(n.obj_token ?? n.token ?? ''),
  name: String(n.name ?? ''),
  type: typeOf(n.type),
  url: String(n.url ?? ''),
  ownerId: String(n.owner_id ?? ''),
  editTime: Number(n.edit_time ?? 0),
});

/** Adler-32 of the data, as Drive's upload checksum. */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of data) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Online document type a file imports into, by extension. */
const IMPORT_TYPES: Record<string, string> = {
  md: 'docx',
  markdown: 'docx',
  txt: 'docx',
  docx: 'docx',
  doc: 'docx',
  xlsx: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
};
export const IMPORTABLE = Object.keys(IMPORT_TYPES);

/** Drive's upload host for a tenant origin (regional tenants have a regional upload host). */
export function uploadHost(tenantOrigin: string): string {
  const parts = new URL(tenantOrigin).hostname.split('.');
  // <tenant>.<region>.larksuite.com → -<region>; <tenant>.feishu.cn → none
  return parts.length > 3
    ? `https://internal-api-drive-stream-${parts[1]}.${parts.slice(2).join('.')}`
    : `https://internal-api-drive-stream.${parts.slice(1).join('.')}`;
}

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

  /** The node token of My Space's root folder. */
  private async rootFolder(): Promise<string> {
    const body = (await this.web.json('GET', '/space/api/explorer/v3/my_space/obj/', {
      query: { length: 1 },
    })) as Dict;
    const nodes = (((body.data as Dict | undefined)?.entities as Dict | undefined)?.nodes ??
      {}) as Record<string, Dict>;
    const root = Object.values(nodes).find((n) => Number(n.type) === TYPE_ROOT);
    if (!root?.token) throw new Error('找不到"我的空间"的根目录');
    return String(root.token);
  }

  /**
   * Import a local file as an online document (Markdown / text / Word → docx, Excel / CSV →
   * sheet) into My Space or a folder (node token); returns the new document.
   */
  async import(
    data: Uint8Array,
    fileName: string,
    o: { folder?: string; timeoutMs?: number } = {},
  ): Promise<{ objToken: string; type: string; url: string }> {
    const ext = fileName.includes('.') ? (fileName.split('.').pop() as string).toLowerCase() : '';
    const type = IMPORT_TYPES[ext];
    if (!type) throw new Error(`不支持导入这种文件: ${fileName}(可导入 ${IMPORTABLE.join('/')})`);
    const folder = o.folder || (await this.rootFolder());
    const form = new FormData();
    form.append('file', new File([data], fileName));
    const up = (await this.web.json('POST', '/space/api/box/stream/upload/all/', {
      origin: uploadHost(await this.web.origin()),
      multipart: form,
      query: {
        name: fileName,
        size: data.length,
        checksum: String(adler32(data)),
        mount_point: 'ccm_import',
        mount_node_token: folder,
        'ext[extra]': JSON.stringify({ obj_type: type, file_extension: ext }),
      },
    })) as Dict;
    const fileToken = (up.data as Dict | undefined)?.file_token;
    if (up.code !== 0 || !fileToken) throw new Error(`上传失败: ${String(up.msg ?? up.code)}`);
    const job = (await this.web.json('POST', '/space/api/import/create/', {
      json: {
        file_token: fileToken,
        type,
        file_extension: ext,
        point: { mount_type: 1, mount_key: folder },
        event_source: 1,
        client_token: crypto.randomUUID(),
        passback: JSON.stringify({ time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      },
    })) as Dict;
    const ticket = (job.data as Dict | undefined)?.ticket;
    if (job.code !== 0 || !ticket) throw new Error(`导入失败: ${String(job.msg ?? job.code)}`);
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      const res = (await this.web.json(
        'GET',
        `/space/api/import/result/${String(ticket)}`,
      )) as Dict;
      const r = ((res.data as Dict | undefined)?.result ?? {}) as Dict;
      const status = Number(r.job_status ?? -1);
      if (status === 0 && r.token)
        return {
          objToken: String(r.token),
          type: String(r.type ?? type),
          url: String(r.url ?? ''),
        };
      if (status !== 1 && status !== 2)
        throw new Error(`导入失败: ${String(r.job_error_msg ?? res.msg ?? status)}`);
      if (Date.now() > deadline) throw new Error('导入超时');
      await new Promise((x) => setTimeout(x, 800));
    }
  }

  /** A docx as Markdown, paging through all blocks. */
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
    return { objToken, ...docxToMarkdown(blocks as BlockMap, root) };
  }
}
