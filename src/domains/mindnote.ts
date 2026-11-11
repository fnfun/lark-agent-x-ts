/**
 * Adding topics to a mindnote, read off the mindnote web app's traffic on 2026-11-11 and replayed
 * over HTTP on both test accounts with mindnotes created for the test:
 *
 * - `POST mindnote/v2/user_changes` (query: member_id, token) with JSON `{member_id, type:
 *   "USER_CHANGES", token, version, operations}`; `version` is the mindnote's current version from
 *   `mindnote/v2/client_vars` (`data.data.version`), and the reply's `data.type` is ACCEPT_COMMIT.
 *   The web app also sends a `user_ticket`, which the server does not require.
 * - Operations are json0 on the topic tree `nodes`: inserting a topic is
 *   `{p: ["nodes", i], action: {li: <topic>}}`, under another topic
 *   `["nodes", i, "children", j, ...]`; a topic is `{id (32 hex digits), text: [{type: 1, text}],
 *   children: [<topics>], images: [], modified (ms)}`, plus `finish: true` for a done topic. A whole
 *   subtree goes in with one insert.
 */
import type { WebSession } from '../web.js';
import { check, docRef } from './docs.js';
import { type BlockSpec, parseMarkdown } from './markdown-docx.js';

type Dict = Record<string, unknown>;

interface Topic {
  id: string;
  text: { type: 1; text: string }[];
  children: Topic[];
  images: never[];
  modified: number;
  finish?: true;
}

const topicText = (n: Dict) => ((n.text ?? []) as Dict[]).map((t) => String(t.text ?? '')).join('');

/** A Markdown block as a topic: its plain text; struck-through or checked items are done. */
function toTopic(spec: BlockSpec, now: number): Topic {
  const runs = spec.runs ?? [];
  const done = spec.done === true || (runs.length > 0 && runs.every((r) => r.strikethrough));
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    id,
    text: [{ type: 1, text: runs.map((r) => r.text).join('') }],
    children: spec.children.map((c) => toTopic(c, now)),
    images: [],
    modified: now,
    ...(done ? { finish: true as const } : {}),
  };
}

export class MindnoteEditor {
  constructor(readonly web: WebSession) {}

  /**
   * Appends a Markdown outline as topics (list items nest as subtopics; headings and paragraphs
   * become topics too), at the end of the top level or of the first topic whose text is `under`;
   * returns how many top-level topics were added.
   */
  async append(urlOrToken: string, markdown: string, o: { under?: string } = {}): Promise<number> {
    const token = docRef(urlOrToken, 'mindnote').token;
    const now = Date.now();
    const topics = parseMarkdown(markdown)
      .filter((s) => s.runs !== undefined)
      .map((s) => toTopic(s, now));
    if (!topics.length) return 0;
    const memberId = Math.floor(Math.random() * 9e13) + 1e13;
    const data = (check(
      await this.web.json('GET', '/space/api/mindnote/v2/client_vars', {
        query: { token, member_id: memberId },
      }),
      '读取思维笔记',
    ).data ?? {}) as Dict;
    const state = (data.data ?? {}) as Dict;
    const nodes = (((state.collab_client_vars ?? {}) as Dict).nodes ?? []) as Dict[];
    const parent =
      o.under === undefined ? { path: ['nodes'], size: nodes.length } : find(nodes, o.under);
    if (!parent) throw new Error(`思维笔记里没有这个主题: ${o.under ?? ''}`);
    const reply = check(
      await this.web.json('POST', '/space/api/mindnote/v2/user_changes', {
        query: { member_id: memberId, token },
        json: {
          member_id: memberId,
          type: 'USER_CHANGES',
          token,
          version: Number(state.version ?? 0),
          operations: topics.map((t, i) => ({
            p: [...parent.path, parent.size + i],
            action: { li: t },
          })),
        },
      }),
      '编辑思维笔记',
    );
    const result = (reply.data ?? {}) as Dict;
    if (result.type !== 'ACCEPT_COMMIT')
      throw new Error(`编辑思维笔记失败: ${String(result.msg || result.type)}`);
    return topics.length;
  }
}

/** The children path and child count of the first topic (depth first) whose text is `text`. */
function find(
  nodes: Dict[],
  text: string,
  path: (string | number)[] = ['nodes'],
): { path: (string | number)[]; size: number } | null {
  for (const [i, n] of nodes.entries()) {
    const children = (n.children ?? []) as Dict[];
    if (topicText(n) === text) return { path: [...path, i, 'children'], size: children.length };
    const hit = find(children, text, [...path, i, 'children']);
    if (hit) return hit;
  }
  return null;
}
