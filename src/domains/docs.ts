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
 * - Renaming goes to a different API per type, keyed by the object token (folders: the node
 *   token); `explorer/v2/rename/` only renames folders. Moving is `explorer/v2/move/` (form:
 *   src_token, dest_token, both node tokens, asynchronous like removing); copying is
 *   `explorer/v2/clone/` keyed by the object token. A folder removed right after its children may
 *   stay (the asynchronous removal fails), so remove it after they are gone.
 * - The trash lists with `explorer/v3/trash/list/` and restores with `explorer/v2/trash/restore/`
 *   (form: token, the node token).
 * - Uploading a file: up to 4 MB in one `box/stream/upload/all/` request on the upload host (mount
 *   point `explorer`, the folder's node token as the mount node); larger files `box/upload/prepare/`,
 *   then each block to `box/stream/upload/v3/block/` (Adler-32 per block), then
 *   `box/upload/finish/`. Passing an existing `file_token` to either path uploads a new version of
 *   that file (how Markdown files are overwritten). Downloading is
 *   `box/stream/download/all/<file token>/`.
 * - Exporting an online document: `POST export/create/` (JSON: token, type, file_extension), poll
 *   `export/result/<ticket>`, then download the result's file token. Sheets export to xlsx only
 *   (csv needs a sub-sheet).
 */
import type { WebRequest, WebSession } from '../web.js';
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

/** An online document or Drive item: its object token (node token for folders) and type. */
export interface DocRef {
  token: string;
  type: DocType;
}

/** Link path segment → type. */
const URL_TYPES: Record<string, DocType> = {
  docx: 'docx',
  docs: 'doc',
  doc: 'doc',
  sheets: 'sheet',
  base: 'base',
  mindnotes: 'mindnote',
  file: 'file',
  folder: 'folder',
};

/** A Docs / Drive link → what it names; a bare object token takes type (docx by default). */
export function docRef(urlOrToken: string, type: DocType = 'docx'): DocRef {
  const m = /\/(docx|docs|doc|sheets|base|mindnotes|file|folder)\/([A-Za-z0-9]+)/.exec(urlOrToken);
  return m
    ? { type: URL_TYPES[m[1] as string] as DocType, token: m[2] as string }
    : { type, token: urlOrToken.trim() };
}

/** Formats each type exports to, the first being the default. */
export const EXPORT_FORMATS: Partial<Record<DocType, string[]>> = {
  docx: ['docx', 'pdf', 'md'],
  doc: ['docx', 'pdf'],
  sheet: ['xlsx'],
};
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

export interface TrashedFile extends DriveFile {
  /** When it was removed (s). */
  deleteTime: number;
  /** Seconds left before it is deleted for good. */
  expiresIn: number;
}

/** A downloaded file: its name (from the server) and content. */
export interface FileData {
  name: string;
  data: Uint8Array;
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

/** The reply when its code is 0; otherwise throws `<what>失败: <reason>`. */
export function check(body: unknown, what: string): Dict {
  const b = (body ?? {}) as Dict;
  if (b.code !== 0) throw new Error(`${what}失败: ${String(b.msg || b.message || b.code)}`);
  return b;
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

/** Largest file sent in one upload request; larger ones go block by block. */
const DIRECT_UPLOAD_MAX = 4 * 1024 * 1024;

/** The file name in a Content-Disposition header (the UTF-8 form preferred). */
export function dispositionName(header: string | null): string {
  const h = header ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (utf8) return decodeURIComponent(utf8[1] as string);
  const plainName = /filename="?([^";]+)"?/i.exec(h);
  return plainName ? decodeURIComponent(plainName[1] as string) : '';
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
    const out = new Map<string, DriveFile>();
    for (const [path, query] of pages as [string, Record<string, string | number>][]) {
      const data = (((await this.web.json('GET', path, { query })) as Dict).data ?? {}) as Dict;
      const nodes = ((data.entities as Dict | undefined)?.nodes ?? {}) as Record<string, Dict>;
      for (const t of (data.node_list ?? []) as string[]) {
        const n = nodes[t];
        if (!n || Number(n.type) === TYPE_ROOT) continue;
        out.set(t, toFile(n));
      }
    }
    return [...out.values()];
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
    return this.each(tokens, (t) =>
      this.web.json('POST', '/space/api/explorer/v3/remove/', { json: { tokens: [t] } }),
    );
  }

  /** Rename a document, sheet, Base, mindnote, uploaded file or folder. */
  async rename(ref: DocRef, name: string): Promise<void> {
    const t = ref.token;
    const [path, body]: [string, Pick<WebRequest, 'json' | 'form' | 'headers'>] =
      ref.type === 'docx'
        ? ['/space/api/doc.v2/update_title', { json: { token: t, obj_type: 22, title: name } }]
        : ref.type === 'doc'
          ? ['/space/api/doc/update_meta/', { form: { token: t, type: 2, title: name } }]
          : ref.type === 'sheet'
            ? [
                '/space/api/sheet/update_meta/',
                {
                  form: { token: t, type: 3, title: name },
                  headers: { 'x-command': 'api.sheet.update_meta' },
                },
              ]
            : ref.type === 'base'
              ? ['/space/api/bitable/update_meta/', { form: { token: t, type: 8, title: name } }]
              : ref.type === 'file'
                ? ['/space/api/box/file/update_info/', { json: { file_token: t, name } }]
                : ref.type === 'folder'
                  ? ['/space/api/explorer/v2/rename/', { form: { token: t, name } }]
                  : [
                      '/space/api/meta/update/',
                      { form: { token: t, type: DOC_TYPES[ref.type], title: name, member_id: '' } },
                    ];
    check(await this.web.json('POST', path, body), '改名');
  }

  /**
   * Move files or folders (node tokens) into a folder (node token; My Space by default). Returns
   * the tokens that failed, with the reason.
   */
  async move(tokens: string[], folder?: string): Promise<Map<string, string>> {
    const dest = folder || (await this.rootFolder());
    return this.each(tokens, (t) =>
      this.web.json('POST', '/space/api/explorer/v2/move/', {
        form: { src_token: t, dest_token: dest },
      }),
    );
  }

  /** Copy a document into My Space or a folder (node token); returns the copy. */
  async copy(ref: DocRef, o: { name?: string; folder?: string } = {}): Promise<DriveFile> {
    const sheet = ref.type === 'sheet';
    const name = o.name ?? `${await this.title(ref)} 副本`;
    const body = check(
      await this.web.json('POST', '/space/api/explorer/v2/clone/', {
        form: {
          obj_token: ref.token,
          obj_type: DOC_TYPES[ref.type],
          parent_token: o.folder || (await this.rootFolder()),
          title: name,
          need_comment: 0,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ext_info: JSON.stringify({ only_schema: 'false', only_base_app: 'false' }),
          source: 0,
          ua_type: 'Web',
          scene: 'space_copy',
          copy_source: 7,
          ...(sheet ? { async: true } : {}),
        },
        ...(sheet ? { headers: { 'x-command': 'api.sheet.explorer.clone' } } : {}),
      }),
      '复制',
    );
    const data = (body.data ?? {}) as Dict;
    const token = ((data.node_list ?? []) as string[])[0];
    const node = token
      ? ((data.entities as Dict | undefined)?.nodes as Record<string, Dict>)?.[token]
      : undefined;
    return node ? toFile(node) : toFile({ token: token ?? '', name, type: DOC_TYPES[ref.type] });
  }

  /** A document's title. */
  async title(ref: DocRef): Promise<string> {
    const body = check(
      await this.web.json('GET', '/space/api/meta/', {
        query: { token: ref.token, type: DOC_TYPES[ref.type] },
      }),
      '读取文档信息',
    );
    return String((body.data as Dict | undefined)?.title ?? '');
  }

  /** What is in my trash, most recently removed first. */
  async trash(limit = 200): Promise<TrashedFile[]> {
    const data = ((
      (await this.web.json('GET', '/space/api/explorer/v3/trash/list/', {
        query: { length: limit },
      })) as Dict
    ).data ?? {}) as Dict;
    const nodes = ((data.entities as Dict | undefined)?.nodes ?? {}) as Record<string, Dict>;
    return ((data.node_list ?? []) as string[])
      .flatMap((t) => (nodes[t] ? [nodes[t]] : []))
      .map((n) => ({
        ...toFile(n),
        deleteTime: Number(n.delete_time ?? 0),
        expiresIn: Number(n.expire_time ?? 0),
      }))
      .sort((a, b) => b.deleteTime - a.deleteTime);
  }

  /** Restore files from the trash (node tokens); returns the tokens that failed. */
  async restore(tokens: string[]): Promise<Map<string, string>> {
    return this.each(tokens, (t) =>
      this.web.json('POST', '/space/api/explorer/v2/trash/restore/', { form: { token: t } }),
    );
  }

  /**
   * Upload a local file into My Space or a folder (node token); returns the new Drive file. With
   * replace (a file token) the content becomes a new version of that file instead (its node token
   * is not returned then).
   */
  async upload(
    data: Uint8Array,
    fileName: string,
    o: { folder?: string; replace?: string } = {},
  ): Promise<DriveFile> {
    const folder = o.folder || (await this.rootFolder());
    const version = o.replace ? { file_token: o.replace } : {};
    const host = uploadHost(await this.web.origin());
    let done: Dict;
    if (data.length <= DIRECT_UPLOAD_MAX) {
      const form = new FormData();
      form.append('file', new File([data.slice()], fileName));
      done = check(
        await this.web.json('POST', '/space/api/box/stream/upload/all/', {
          origin: host,
          multipart: form,
          query: {
            name: fileName,
            size: data.length,
            checksum: String(adler32(data)),
            mount_point: 'explorer',
            mount_node_token: folder,
            ...version,
          },
        }),
        '上传',
      );
    } else {
      const prep = (check(
        await this.web.json('POST', '/space/api/box/upload/prepare/', {
          json: {
            mount_point: 'explorer',
            mount_node_token: folder,
            name: fileName,
            size: data.length,
            ...version,
          },
        }),
        '上传',
      ).data ?? {}) as Dict;
      const uploadId = String(prep.upload_id ?? '');
      const blockSize = Number(prep.block_size ?? DIRECT_UPLOAD_MAX);
      const blocks = Number(prep.num_blocks ?? Math.ceil(data.length / blockSize));
      for (let seq = 0; seq < blocks; seq++) {
        const part = data.slice(seq * blockSize, (seq + 1) * blockSize);
        const sum = String(adler32(part));
        const form = new FormData();
        form.append('upload_id', uploadId);
        form.append('size', String(part.length));
        form.append('file', new Blob([part]));
        check(
          await this.web.json('POST', '/space/api/box/stream/upload/v3/block/', {
            origin: host,
            multipart: form,
            query: { upload_id: uploadId, seq, size: part.length, checksum: sum },
            headers: { 'x-block-seq': String(seq), 'x-block-checksum': sum },
          }),
          `上传第 ${seq + 1}/${blocks} 块`,
        );
      }
      done = check(
        await this.web.json('POST', '/space/api/box/upload/finish/', {
          json: {
            upload_id: uploadId,
            num_blocks: blocks,
            mount_point: 'explorer',
            push_open_history_record: 0,
          },
          headers: { 'biz-ua-type': 'Web', 'biz-scene': 'file_upload' },
        }),
        '上传',
      );
    }
    const d = (done.data ?? {}) as Dict;
    return toFile({
      token: (d.extra as Dict | undefined)?.node_token ?? '',
      obj_token: d.file_token ?? o.replace,
      name: fileName,
      type: DOC_TYPES.file,
    });
  }

  /** Download an uploaded Drive file by its file token (the object token). */
  async download(fileToken: string): Promise<FileData> {
    const res = await this.web.request('GET', `/space/api/box/stream/download/all/${fileToken}/`);
    return {
      name: dispositionName(res.headers.get('content-disposition')),
      data: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /** Export an online document to a file (format: see EXPORT_FORMATS, the first by default). */
  async export(ref: DocRef, o: { format?: string; timeoutMs?: number } = {}): Promise<FileData> {
    const formats = EXPORT_FORMATS[ref.type] ?? [];
    const format = o.format ?? formats[0];
    if (!format || !formats.includes(format))
      throw new Error(
        formats.length
          ? `${ref.type} 只能导出为 ${formats.join('/')}`
          : `${ref.type} 不支持导出(可导出 ${Object.keys(EXPORT_FORMATS).join('/')})`,
      );
    const job = check(
      await this.web.json('POST', '/space/api/export/create/', {
        json: {
          token: ref.token,
          type: ref.type,
          file_extension: format,
          event_source: 1,
          need_comment: false,
        },
      }),
      '导出',
    );
    const ticket = String((job.data as Dict | undefined)?.ticket ?? '');
    const r = await this.poll(`/space/api/export/result/${ticket}`, '导出', o.timeoutMs, {
      token: ref.token,
      type: ref.type,
    });
    const file = await this.download(String(r.file_token ?? ''));
    return { ...file, name: file.name || `${String(r.file_name ?? ref.token)}.${format}` };
  }

  /** Calls op for each token; returns the tokens whose reply was not code 0, with the reason. */
  private async each(
    tokens: string[],
    op: (token: string) => Promise<unknown>,
  ): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    for (const t of tokens) {
      const body = (await op(t).catch((e: Error & { reason?: string }) => ({
        code: -1,
        msg: e.reason || e.message,
      }))) as Dict;
      if (body.code !== 0) failed.set(t, String(body.msg ?? body.code));
    }
    return failed;
  }

  /**
   * Polls an import / export job result until it leaves the running states (1, 2); returns the
   * result when it succeeded (job_status 0), throws otherwise.
   */
  private async poll(
    path: string,
    what: string,
    timeoutMs = 120_000,
    query: Record<string, string> = {},
  ): Promise<Dict> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = (await this.web.json('GET', path, { query })) as Dict;
      const r = ((res.data as Dict | undefined)?.result ?? {}) as Dict;
      const status = Number(r.job_status ?? -1);
      if (status === 0) return r;
      if (status !== 1 && status !== 2)
        throw new Error(`${what}失败: ${String(r.job_error_msg ?? res.msg ?? status)}`);
      if (Date.now() > deadline) throw new Error(`${what}超时`);
      await new Promise((x) => setTimeout(x, 800));
    }
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
    const r = await this.poll(`/space/api/import/result/${String(ticket)}`, '导入', o.timeoutMs);
    return {
      objToken: String(r.token ?? ''),
      type: String(r.type ?? type),
      url: String(r.url ?? ''),
    };
  }

  /** A docx (link or object token; resolve wiki links with Wiki.resolve) as Markdown, paging through all blocks. */
  async fetch(urlOrToken: string): Promise<DocContent> {
    if (/\/wiki\//.test(urlOrToken)) throw new Error('知识库链接要先解析成文档(Wiki.resolve)再读');
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
