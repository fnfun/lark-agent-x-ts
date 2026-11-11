/**
 * Editing a slides deck's pages, over the same block channel as docx (`POST
 * slide/blocks/user_change`, see doc-edit.ts); read off the slides web app's traffic on 2026-11-11
 * and replayed over HTTP on both test accounts with decks created for the test:
 *
 * - The deck block (id = the deck token) lists its pages in `slides`; a page is a `slide` block
 *   whose `children` are its shapes, with `slide.note` naming its speaker-notes block and
 *   `slide.layout` the layout it follows. The block map also holds the layouts' and masters'
 *   shapes, which belong to no page.
 * - Removing a page: `{p: ["slides", i], action: {ld: <page id>}}` on the deck block.
 * - Adding one: the web app builds it from the layout's placeholders; here a page is copied
 *   instead: its blocks (page, notes, shapes) are created afresh (`{p: [], action: {oi}}`, version
 *   0) under new ids, every old id inside them mapped to its new one, and the page inserted into
 *   `slides` with `li`. New ids are "sld" + the deck's operation id + random characters.
 * - A shape's text is `shape.text.content`, attributed text like docx's, each line starting with a
 *   `*` carrying the `lmkr` line marker; replacing text swaps the whole value
 *   (`{p: ["shape", "text", "content"], action: {od, oi}}`), keeping each character's attributes.
 */
import type { WebSession } from '../web.js';
import { commitChanges, newBlockId } from './doc-edit.js';
import { Docs, docRef } from './docs.js';
import { replaceAttributed } from './markdown-docx.js';

type Dict = Record<string, unknown>;

const CLIENT_VARS = '/space/api/slide/pages/client_vars';
const USER_CHANGE = '/space/api/slide/blocks/user_change';

interface Deck {
  token: string;
  version: number;
  slides: string[];
  blocks: Record<string, Dict>;
}

const dataOf = (record: Dict | undefined) => (record?.data ?? {}) as Dict;

export class SlidesEditor {
  constructor(readonly web: WebSession) {}

  /**
   * Copies page `page` (from 1) to position `at` (from 1; after the last page by default);
   * returns the new page's number.
   */
  async copyPage(urlOrToken: string, page: number, o: { at?: number } = {}): Promise<number> {
    const deck = await this.load(urlOrToken);
    const source = pageId(deck, page);
    const at = o.at ?? deck.slides.length + 1;
    if (!Number.isInteger(at) || at < 1 || at > deck.slides.length + 1)
      throw new Error(`位置要在 1 到 ${deck.slides.length + 1} 之间`);
    // Every block of the page gets a new id first, so references between them can be rewritten.
    const ids = new Map<string, string>();
    const collect = (id: string) => {
      if (ids.has(id) || !deck.blocks[id]) return;
      ids.set(id, newBlockId(deck.token, 'sld'));
      const data = dataOf(deck.blocks[id]);
      const note = (data.slide as Dict | undefined)?.note;
      if (typeof note === 'string' && note) collect(note);
      for (const child of (data.children ?? []) as string[]) collect(child);
    };
    collect(source);
    const changes: Record<string, Dict> = {};
    for (const [oldId, newId] of ids) {
      let json = JSON.stringify(dataOf(deck.blocks[oldId]));
      for (const [from, to] of ids) json = json.split(from).join(to);
      const data = JSON.parse(json) as Dict;
      if (oldId === source) data.parent_id = deck.token;
      changes[newId] = {
        id: newId,
        version: 0,
        payload: { ops: [{ p: [], action: { oi: data } }] },
      };
    }
    changes[deck.token] = {
      id: deck.token,
      version: deck.version,
      payload: { ops: [{ p: ['slides', at - 1], action: { li: ids.get(source) } }] },
    };
    await commitChanges(this.web, deck.token, changes, USER_CHANGE);
    return at;
  }

  /** Removes pages (numbers from 1); returns how many were removed. */
  async removePages(urlOrToken: string, pages: number[]): Promise<number> {
    const deck = await this.load(urlOrToken);
    const unique = [...new Set(pages)].sort((a, b) => b - a);
    for (const p of unique) pageId(deck, p);
    if (unique.length >= deck.slides.length) throw new Error('不能删掉所有页');
    await commitChanges(
      this.web,
      deck.token,
      {
        [deck.token]: {
          id: deck.token,
          version: deck.version,
          // From the last page down, so the remaining indexes stay valid.
          payload: {
            ops: unique.map((p) => ({
              p: ['slides', p - 1],
              action: { ld: deck.slides[p - 1] },
            })),
          },
        },
      },
      USER_CHANGE,
    );
    return unique.length;
  }

  /** Replaces text in the pages' shapes (all pages, or just `page`), keeping the formatting. */
  async replace(
    urlOrToken: string,
    find: string,
    replacement: string,
    o: { page?: number } = {},
  ): Promise<{ replaced: number; blocks: number; skipped: number }> {
    if (!find) throw new Error('要替换的文字不能为空');
    const deck = await this.load(urlOrToken);
    const pages = o.page === undefined ? deck.slides : [pageId(deck, o.page)];
    const shapes: string[] = [];
    const walk = (id: string) => {
      for (const child of (dataOf(deck.blocks[id]).children ?? []) as string[]) {
        shapes.push(child);
        walk(child);
      }
    };
    for (const id of pages) walk(id);
    const changes: Record<string, Dict> = {};
    let replaced = 0;
    let skipped = 0;
    for (const id of shapes) {
      const record = deck.blocks[id];
      const text = ((dataOf(record).shape as Dict | undefined)?.text ?? {}) as Dict;
      const old = text.content as Dict | undefined;
      const initial = (old?.initialAttributedTexts ?? {}) as Dict;
      const texts = (initial.text ?? {}) as Record<string, string>;
      const value = texts['0'];
      if (value === undefined || !value.includes(find)) continue;
      if (Object.keys(texts).length !== 1) {
        skipped++;
        continue;
      }
      const r = replaceAttributed(
        value,
        ((initial.attribs ?? {}) as Record<string, string>)['0'] ?? '',
        find,
        replacement,
      );
      if (!r) continue;
      replaced += r.count;
      const neu = {
        ...old,
        initialAttributedTexts: { ...initial, text: { 0: r.text }, attribs: { 0: r.attribs } },
      };
      changes[id] = {
        id,
        version: Number(record?.version ?? 0),
        payload: { ops: [{ p: ['shape', 'text', 'content'], action: { od: old, oi: neu } }] },
      };
    }
    if (Object.keys(changes).length)
      await commitChanges(this.web, deck.token, changes, USER_CHANGE);
    return { replaced, blocks: Object.keys(changes).length, skipped };
  }

  private async load(urlOrToken: string): Promise<Deck> {
    const token = docRef(urlOrToken, 'slides').token;
    const { blocks } = await new Docs(this.web).blocks(CLIENT_VARS, token);
    const root = blocks[token];
    if (!root) throw new Error('读取幻灯片失败: 找不到演示文稿的根块');
    return {
      token,
      version: Number(root.version ?? 0),
      slides: ((dataOf(root).slides ?? []) as string[]).slice(),
      blocks,
    };
  }
}

function pageId(deck: Deck, page: number): string {
  const id = Number.isInteger(page) ? deck.slides[page - 1] : undefined;
  if (!id) throw new Error(`没有第 ${page} 页(共 ${deck.slides.length} 页)`);
  return id;
}
