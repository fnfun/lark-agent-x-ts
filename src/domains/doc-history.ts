/**
 * A docx's edit history, over the docx web app's history APIs; read off the web app's own traffic
 * on 2026-11-11 (history panel and "restore this record") and replayed over HTTP on both test
 * accounts with documents created for the test:
 *
 * - `GET docx/history/page/list/` (page_id = the docx object token, count, cursor) returns
 *   `major_history` newest first, each grouping `minor_history` records; `has_more` and
 *   `next_cursor` page through them. A record has `version` (the history version, used to restore
 *   it), `type` (1 created, 2 edited, 3 restored), `edit_time` (s), `editor_ids` (names in the
 *   reply's `user` map) and `page_info.from_ver` / `to_ver`, the page versions it spans.
 * - The document as of a record is `docx/pages/client_vars` with `version` = that `to_ver`.
 * - Restoring is `POST docx/history/page/revert/` (JSON: page_id, minor_version) → `task_id` and
 *   `query_duration` (s); `GET docx/history/page/revert_status/` (task_id, page_id) answers
 *   `status` 0 while running, 1 when done, anything else on failure, with `block_status` per block.
 *   A restore is itself recorded (type 3), so it can be undone by restoring the record before it.
 * - Records show up with a delay: the latest edits and restores are listed some minutes later.
 * - The older `/space/api/doc/history/` is for legacy docs and answers "Not Found" for a docx.
 */
import type { WebSession } from '../web.js';
import { check, Docs, docToken } from './docs.js';
import { type BlockMap, docxToMarkdown } from './docx-markdown.js';

type Dict = Record<string, unknown>;

export interface DocVersion {
  /** The history version: what `version` and `revert` take. */
  version: number;
  kind: 'created' | 'edited' | 'restored' | 'other';
  /** Edit time (s). */
  time: number;
  editors: string[];
  /** The page version after this record. */
  pageVersion: number;
  /** For a restore, the time (s) of the state it went back to. */
  restoredFrom?: number;
  /** A name given to the record (versions saved by name). */
  name: string;
}

const KINDS: Record<number, DocVersion['kind']> = { 1: 'created', 2: 'edited', 3: 'restored' };
// The server rejects more than 20 per page.
const PAGE_SIZE = 20;
const REVERT_POLL_MS = 1000;

export class DocHistory {
  constructor(readonly web: WebSession) {}

  /** A docx's history records (link or object token), newest first, up to `limit`. */
  async list(urlOrToken: string, limit = 100): Promise<DocVersion[]> {
    const pageId = docToken(urlOrToken);
    const out: DocVersion[] = [];
    let cursor = '';
    while (out.length < limit) {
      const data = check(
        await this.web.json('GET', '/space/api/docx/history/page/list/', {
          query: { page_id: pageId, count: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        }),
        '读取历史记录',
      ).data as Dict;
      const users = (data.user ?? {}) as Record<string, Dict>;
      const name = (id: string) => {
        const u = users[id] ?? {};
        return String(((u.display_name ?? {}) as Dict).value || u.cn_name || u.en_name || id);
      };
      for (const major of (data.major_history ?? []) as Dict[])
        for (const minor of (major.minor_history ?? []) as Dict[]) {
          const page = (minor.page_info ?? {}) as Dict;
          const revert = page.revert_info as Dict | undefined;
          out.push({
            version: Number(minor.version),
            kind: KINDS[Number(minor.type)] ?? 'other',
            time: Number(minor.edit_time ?? 0),
            editors: ((minor.editor_ids ?? []) as string[]).map(name),
            pageVersion: Number(page.to_ver ?? 0),
            ...(revert ? { restoredFrom: Number(revert.time) } : {}),
            name: String(minor.name ?? ''),
          });
        }
      cursor = String(data.next_cursor ?? '');
      if (!data.has_more || !cursor) break;
    }
    return out.slice(0, limit);
  }

  /** The document as of a history record, as Markdown. */
  async markdown(urlOrToken: string, version: number): Promise<string> {
    const pageId = docToken(urlOrToken);
    const record = await this.find(pageId, version);
    const { blocks, root } = await new Docs(this.web).blocks(
      '/space/api/docx/pages/client_vars',
      pageId,
      { version: record.pageVersion },
    );
    return docxToMarkdown(blocks as BlockMap, root).markdown;
  }

  /** Restores the document to a history record and waits until the server has done it. */
  async revert(urlOrToken: string, version: number): Promise<void> {
    const pageId = docToken(urlOrToken);
    await this.find(pageId, version);
    const started = check(
      await this.web.json('POST', '/space/api/docx/history/page/revert/', {
        json: { page_id: pageId, minor_version: version },
      }),
      '还原历史记录',
    ).data as Dict;
    const deadline = Date.now() + Math.max(Number(started.query_duration ?? 0), 20) * 1000;
    for (;;) {
      await new Promise((x) => setTimeout(x, REVERT_POLL_MS));
      const data = check(
        await this.web.json('GET', '/space/api/docx/history/page/revert_status/', {
          query: { task_id: String(started.task_id ?? ''), page_id: pageId },
        }),
        '查询还原进度',
      ).data as Dict;
      const status = Number(data.status);
      if (status === 1) return;
      if (status !== 0) {
        const blocks = Object.values((data.block_status ?? {}) as Record<string, Dict>);
        throw new Error(
          blocks.some((b) => Number(b.status) === 1)
            ? '还原历史记录只完成了一部分'
            : `还原历史记录失败(状态 ${status})`,
        );
      }
      if (Date.now() > deadline) throw new Error('还原历史记录超时,服务端仍在处理,稍后再看');
    }
  }

  private async find(pageId: string, version: number): Promise<DocVersion> {
    const record = (await this.list(pageId, Number.POSITIVE_INFINITY)).find(
      (v) => v.version === version,
    );
    if (!record) throw new Error(`没有这条历史记录: ${version}`);
    return record;
  }
}
