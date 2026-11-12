/**
 * Documents linked from a message, fetched for the digital twin's prompt. Clients turn a pasted
 * link into an anchor element (tag A) whose href holds the URL, and the decoded message text
 * leaves anchors out (as the fork does), so links are read from the rich text as well as from the
 * plain text. Only Docs links on Lark / Feishu hosts count; each document is cut to a size cap,
 * and one that cannot be read (no access, unsupported type) is skipped.
 */
import { fromBinary } from '@bufbuild/protobuf';
import { Docs } from '../domains/docs.js';
import { Wiki } from '../domains/wiki.js';
import { getLogger } from '../log.js';
import { type Dict, toDict } from '../proto/dict.js';
import { larkType } from '../proto/registry.js';
import type { WebSession } from '../web.js';

const logger = getLogger('larkx.agent');

/** Characters of Markdown kept per document. */
export const DOC_MAX_CHARS = 8000;
/** Documents fetched per message. */
export const DOCS_PER_MESSAGE = 3;
// entities.RichTextElement.Tag.A
const TAG_ANCHOR = 6;
const LINK =
  /https?:\/\/[\w.-]+\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|wiki|mindnotes|slides)\/[A-Za-z0-9]+/g;

export interface LinkedDocument {
  url: string;
  title: string;
  /** Markdown, cut to DOC_MAX_CHARS. */
  content: string;
  truncated: boolean;
}

/** The Docs links in a message (its text and the anchors of its rich text), first seen first. */
export function documentLinks(content: string, contentData: Dict | null | undefined): string[] {
  const found = [...content.matchAll(LINK)].map((m) => m[0]);
  const dictionary = ((contentData?.richText as Dict | undefined)?.elements as Dict | undefined)
    ?.dictionary as Record<string, Dict> | undefined;
  const anchor = larkType('entities.RichTextElement.AnchorProperty');
  for (const e of Object.values(dictionary ?? {})) {
    if (e.tag !== TAG_ANCHOR || !(e.property instanceof Uint8Array)) continue;
    try {
      const href = String(toDict(anchor, fromBinary(anchor, e.property)).href ?? '');
      found.push(...[...href.matchAll(LINK)].map((m) => m[0]));
    } catch {}
  }
  return [...new Set(found)];
}

/** Fetches the documents a message links to (at most DOCS_PER_MESSAGE); unreadable ones are skipped. */
export async function linkedDocuments(
  web: WebSession,
  content: string,
  contentData: Dict | null | undefined,
): Promise<LinkedDocument[]> {
  const out: LinkedDocument[] = [];
  for (const url of documentLinks(content, contentData).slice(0, DOCS_PER_MESSAGE)) {
    try {
      const doc = await new Docs(web).read(await new Wiki(web).ref(url));
      const chars = Array.from(doc.markdown);
      out.push({
        url,
        title: doc.title,
        content: chars.slice(0, DOC_MAX_CHARS).join(''),
        truncated: chars.length > DOC_MAX_CHARS,
      });
    } catch (e) {
      logger.info(`读不了消息里的文档 ${url}: ${(e as Error).message}`);
    }
  }
  return out;
}
