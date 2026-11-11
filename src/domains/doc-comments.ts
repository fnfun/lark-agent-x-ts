/**
 * Comments on online documents, over the Docs web app's comment APIs (`/space/api/comment/...`).
 * Shapes come from the web app's comment SDK; tested on a real account on 2026-11-11 with a
 * document created for the test and removed afterwards:
 *
 * - Bodies are forms (JSON answers "Parameter Error"); every call names the document by
 *   `obj_type` + `token` (the object token).
 * - Listing is two steps: `commentid/all` (POST with the document in the query) returns the ids
 *   by kind (`wholeCommentIDs` for whole-document comments, `partCommentIDs` anchored to text,
 *   `finishCommentIDs` resolved), then `batch` (form: `comment_ids` repeated per id) returns them
 *   with their replies.
 * - A comment is a thread: adding one (`add/`, `is_whole: 1`) creates it with its first reply;
 *   `reply/add/` appends. `update/` resolves (`finish: 1`), reopens (`finish: 0`) or deletes
 *   (`is_deleted: 1`) a thread.
 * - Content is HTML-escaped text: a raw `<` answers "Parameter Error", so text is escaped on the
 *   way in and unescaped on the way out.
 * - A comment on a piece of a docx's text (read off the web app's traffic on 2026-11-11) is
 *   `add/` with `is_whole: 0`, the `quote`, and `comment_extra` `{visibility: 0,
 *   content_anchor_id: <block id>}`; then the block is edited (`docx/blocks/user_change`) to mark
 *   the text: a text op with `subType: {t: "easysync", o: {zone_changesets: {0: <changeset>},
 *   apool}}`, the changeset keeping the text before the quote and applying the attribute
 *   `["comment-id-<comment id>", "true"]` to the quote (`Z:<length>>0=<before>*0=<quote>$`, base
 *   36), and the comment id appended to the block's `comments`.
 */
import type { WebSession } from '../web.js';
import { commitChanges } from './doc-edit.js';
import { check, DOC_TYPES, type DocRef, Docs } from './docs.js';
import { ops } from './markdown-docx.js';

type Dict = Record<string, unknown>;

export interface CommentReply {
  id: string;
  userId: string;
  name: string;
  /** Plain text. */
  content: string;
  /** Creation time (s). */
  createTime: number;
}

export interface DocComment {
  id: string;
  /** On the whole document, rather than anchored to a piece of text. */
  whole: boolean;
  /** The anchored text, for comments on text. */
  quote: string;
  solved: boolean;
  /** The thread, the comment itself first. */
  replies: CommentReply[];
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
const unescapeHtml = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (e) => Object.keys(ENTITIES).find((c) => ENTITIES[c] === e) ?? e,
  );

const toReply = (r: Dict): CommentReply => ({
  id: String(r.reply_id ?? ''),
  userId: String(r.user_id ?? ''),
  name: String(r.name ?? ''),
  content: unescapeHtml(String(r.content ?? '')),
  createTime: Number(r.create_timestamp ?? 0),
});

const toComment = (c: Dict): DocComment => ({
  id: String(c.comment_id ?? ''),
  whole: Number(c.is_whole) === 1,
  quote: unescapeHtml(String(c.quote ?? '')),
  solved: Number(c.finish) === 1,
  replies: ((c.comment_list ?? []) as Dict[]).map(toReply),
});

/** The first block (in document order) whose text contains `quote`, and where. */
function findText(
  blocks: Record<string, Dict>,
  root: string,
  quote: string,
): { id: string; version: number; text: string; at: number; comments: string[] | null } | null {
  const visit = (id: string): ReturnType<typeof findText> => {
    const record = blocks[id];
    const data = (record?.data ?? {}) as Dict;
    const texts = ((data.text as Dict | undefined)?.initialAttributedTexts as Dict | undefined)
      ?.text as Record<string, string> | undefined;
    const text = texts?.['0'];
    const at = id !== root && text !== undefined ? text.indexOf(quote) : -1;
    if (at >= 0)
      return {
        id,
        version: Number(record?.version ?? 0),
        text: text as string,
        at,
        comments: (data.comments as string[] | null | undefined) ?? null,
      };
    for (const child of (data.children ?? []) as string[]) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root);
}

/** How many comments one batch request asks for. */
const BATCH = 50;

export class DocComments {
  constructor(readonly web: WebSession) {}

  /** All comment threads on a document: open ones first, then resolved ones. */
  async list(ref: DocRef): Promise<DocComment[]> {
    const ids = (check(
      await this.web.json('POST', '/space/api/comment/commentid/all', {
        query: { ...this.doc(ref), 'comment_type_list[]': 0 },
      }),
      '读取评论',
    ).data ?? {}) as Dict;
    const all = [
      ...new Set(
        ['wholeCommentIDs', 'partCommentIDs', 'finishCommentIDs'].flatMap(
          (k) => (ids[k] ?? []) as string[],
        ),
      ),
    ];
    const out: DocComment[] = [];
    for (let i = 0; i < all.length; i += BATCH) {
      const page = all.slice(i, i + BATCH);
      const data = (check(
        await this.web.json('POST', '/space/api/comment/batch', {
          form: { ...this.doc(ref), comment_ids: page, need_reply: true },
        }),
        '读取评论',
      ).data ?? {}) as Dict;
      const found = (data.comments ?? {}) as Record<string, Dict>;
      for (const id of page) if (found[id]) out.push(toComment(found[id]));
    }
    return out.sort((a, b) => Number(a.solved) - Number(b.solved));
  }

  /**
   * Comment on the whole document, or with `quote` on the first occurrence of that text in a docx
   * (in document order); returns the new thread.
   */
  async add(ref: DocRef, text: string, o: { quote?: string } = {}): Promise<DocComment> {
    if (o.quote === undefined) return this.create(ref, text, { is_whole: 1 });
    if (ref.type !== 'docx') throw new Error('划词评论只支持 docx');
    if (!o.quote) throw new Error('要评论的文字不能为空');
    const quote = o.quote;
    const { blocks, root } = await new Docs(this.web).blocks(
      '/space/api/docx/pages/client_vars',
      ref.token,
    );
    const found = findText(blocks, root, quote);
    if (!found) throw new Error(`文档里找不到要评论的文字: ${quote}`);
    const comment = await this.create(ref, text, {
      is_whole: 0,
      quote: escapeHtml(quote),
      extra: JSON.stringify({ image_list: [], image_extra_list: {} }),
      comment_extra: JSON.stringify({ visibility: 0, content_anchor_id: found.id }),
    });
    const changeset = `Z:${found.text.length.toString(36)}>0${
      found.at ? ops('', found.text.slice(0, found.at), '=') : ''
    }${ops('*0', quote, '=')}$`;
    try {
      await commitChanges(this.web, ref.token, {
        [found.id]: {
          id: found.id,
          version: found.version,
          payload: {
            ops: [
              {
                p: ['text'],
                subType: {
                  t: 'easysync',
                  o: {
                    zone_changesets: { 0: changeset },
                    apool: { numToAttrib: { 0: [`comment-id-${comment.id}`, 'true'] }, nextNum: 1 },
                  },
                },
              },
              {
                p: ['comments'],
                action: { od: found.comments, oi: [...(found.comments ?? []), comment.id] },
              },
            ],
          },
        },
      });
    } catch (e) {
      // A comment whose text was not marked would float unanchored; take it back.
      await this.remove(ref, comment.id).catch(() => undefined);
      throw e;
    }
    return comment;
  }

  private async create(ref: DocRef, text: string, fields: Dict): Promise<DocComment> {
    const body = check(
      await this.web.json('POST', '/space/api/comment/add/', {
        form: {
          ...this.doc(ref),
          ...fields,
          content: escapeHtml(text),
          comment_uuid: crypto.randomUUID(),
          reply_uuid: crypto.randomUUID(),
          notify: false,
        },
      }),
      '评论',
    );
    return toComment(((body.data as Dict | undefined)?.comment ?? {}) as Dict);
  }

  /** Reply in a comment thread; returns the reply. */
  async reply(ref: DocRef, commentId: string, text: string): Promise<CommentReply> {
    const body = check(
      await this.web.json('POST', '/space/api/comment/reply/add/', {
        form: {
          ...this.doc(ref),
          comment_id: commentId,
          content: escapeHtml(text),
          reply_uuid: crypto.randomUUID(),
          notify: false,
        },
      }),
      '回复评论',
    );
    return toReply(((body.data as Dict | undefined)?.reply ?? {}) as Dict);
  }

  /** Resolve a thread, or reopen it (solved false). */
  async resolve(ref: DocRef, commentId: string, solved = true): Promise<void> {
    check(
      await this.web.json('POST', '/space/api/comment/update/', {
        form: { ...this.doc(ref), comment_id: commentId, finish: solved ? 1 : 0 },
      }),
      solved ? '解决评论' : '重新打开评论',
    );
  }

  /** Delete a whole thread. */
  async remove(ref: DocRef, commentId: string): Promise<void> {
    check(
      await this.web.json('POST', '/space/api/comment/update/', {
        form: { ...this.doc(ref), comment_id: commentId, is_deleted: 1 },
      }),
      '删除评论',
    );
  }

  private doc(ref: DocRef) {
    return { obj_type: DOC_TYPES[ref.type], token: ref.token };
  }
}
