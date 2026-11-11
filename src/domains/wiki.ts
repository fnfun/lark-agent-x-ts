/**
 * Wiki over the Docs web app's wiki APIs (`/space/api/wiki/v2/...`). Shapes come from the web app's
 * JavaScript; tested on a real Feishu account on 2026-11-11 with nodes created for the test in the
 * account's personal library and deleted afterwards:
 *
 * - A wiki page is a node (`wiki_token`) in a space (`space_id`) that points at an ordinary
 *   document (`obj_token` + `obj_type`); a space's root node has no document (obj_type 23).
 * - `space/my_library/get/` (`init_if_none=false`) is the personal library ("我的文档库"), when the
 *   account has one; `space/get/` pages through the other spaces the user can see.
 * - `tree/get_node/` (wiki_token) resolves a node; `tree/get_node_child/` (space_id, wiki_token)
 *   lists a node's children, keyed by the parent's token.
 * - Writes are JSON: `tree/create_node/`, `tree/update_title/` (docx and doc; other types rename
 *   their document), `tree/move_node/` (old and new parent + space), `tree/node/copy/` (copies one
 *   node, not its children) and `tree/del_node/` (the node and its subtree go to the space's trash;
 *   `auto_delete_mode` 0 is the web app's default of clearing after 180 days).
 * - Creating a space (`POST space/create/`, form: name, introduction, space_type 1, plus uniq_id,
 *   or InvalidParam) answered 920004103 on both test accounts; the web app's own request, which
 *   also sends wiki_scope, cover_token and i18n_id, could not be captured. Not offered.
 */
import type { WebSession } from '../web.js';
import { check, DOC_TYPES, type DocRef, Docs, type DocType } from './docs.js';

type Dict = Record<string, unknown>;

const TYPE_NAMES = Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [v, k])) as Record<
  number,
  DocType
>;

export interface WikiSpace {
  id: string;
  name: string;
  description: string;
  /** The space's root node; its children are the top-level pages. */
  rootToken: string;
  /** The account's personal library. */
  personal: boolean;
}

export interface WikiNode {
  wikiToken: string;
  spaceId: string;
  /** The parent node ('' for a space's root). */
  parent: string;
  title: string;
  /** The document the node shows. */
  objToken: string;
  type: DocType | 'unknown';
  hasChildren: boolean;
  url: string;
}

const toNode = (n: Dict): WikiNode => ({
  wikiToken: String(n.wiki_token ?? ''),
  spaceId: String(n.space_id ?? ''),
  parent: String(n.parent_wiki_token ?? ''),
  title: String(n.title ?? ''),
  objToken: String(n.obj_token ?? ''),
  type: TYPE_NAMES[Number(n.obj_type)] ?? 'unknown',
  hasChildren: n.has_child === true,
  url: String(n.url ?? ''),
});

const toSpace = (s: Dict, personal: boolean): WikiSpace => ({
  id: String(s.space_id ?? ''),
  name: String(s.space_name ?? ''),
  description: String(s.description ?? ''),
  rootToken: String(s.root_token ?? ''),
  personal,
});

/** A wiki link or a bare wiki token → the wiki token. */
export function wikiToken(urlOrToken: string): string {
  const m = /\/wiki\/([A-Za-z0-9]+)/.exec(urlOrToken);
  return m ? (m[1] as string) : urlOrToken.trim();
}

/** Spaces asked for per page. */
const PAGE = 50;

export class Wiki {
  constructor(readonly web: WebSession) {}

  /** Spaces I can see, the personal library first. */
  async spaces(): Promise<WikiSpace[]> {
    const out = new Map<string, WikiSpace>();
    const lib = (await this.web.json('GET', '/space/api/wiki/v2/space/my_library/get/', {
      query: { init_if_none: false },
    })) as Dict;
    if (lib.code === 0 && lib.data && typeof lib.data === 'object') {
      const s = toSpace(lib.data as Dict, true);
      out.set(s.id, s);
    }
    let label = '';
    for (let page = 0; page < 20; page++) {
      const data = (check(
        await this.web.json('GET', '/space/api/wiki/v2/space/get/', {
          query: { size: PAGE, last_label: label, pin_first: true },
        }),
        '列出知识空间',
      ).data ?? {}) as Dict;
      for (const s of (data.spaces ?? []) as Dict[]) {
        const space = toSpace(s, false);
        if (!out.has(space.id)) out.set(space.id, space);
      }
      label = String(data.last_label ?? '');
      if (!data.has_more || !label) break;
    }
    return [...out.values()];
  }

  /** A node, by its link or wiki token. */
  async node(urlOrToken: string): Promise<WikiNode> {
    const body = check(
      await this.web.json('GET', '/space/api/wiki/v2/tree/get_node/', {
        query: { wiki_token: wikiToken(urlOrToken), expand_shortcut: true },
      }),
      '读取知识库节点',
    );
    return toNode((body.data ?? {}) as Dict);
  }

  /** The document a wiki link points at, for the Docs APIs. */
  async resolve(urlOrToken: string): Promise<DocRef> {
    const n = await this.node(urlOrToken);
    if (n.type === 'unknown') throw new Error('这个知识库节点没有对应的文档');
    return { token: n.objToken, type: n.type };
  }

  /** A node's children (a space's top-level pages when parent is omitted). */
  async children(spaceId: string, parent?: string): Promise<WikiNode[]> {
    const parentToken = parent ? wikiToken(parent) : await this.rootToken(spaceId);
    const data = (check(
      await this.web.json('GET', '/space/api/wiki/v2/tree/get_node_child/', {
        query: { space_id: spaceId, wiki_token: parentToken, expand_shortcut: true },
      }),
      '列出知识库节点',
    ).data ?? {}) as Record<string, Dict[]>;
    return (data[parentToken] ?? []).map(toNode);
  }

  /** Create a page (an empty document of the type) under parent, or at the top of the space. */
  async create(
    spaceId: string,
    title: string,
    o: { parent?: string; type?: DocType } = {},
  ): Promise<WikiNode> {
    const body = check(
      await this.web.json('POST', '/space/api/wiki/v2/tree/create_node/', {
        json: {
          space_id: spaceId,
          parent_wiki_token: o.parent ? wikiToken(o.parent) : await this.rootToken(spaceId),
          ua_type: 'Web',
          scene: 'wiki_create',
          title,
          obj_type: DOC_TYPES[o.type ?? 'docx'],
          node_type: 0,
        },
      }),
      '新建知识库页面',
    );
    return toNode((body.data ?? {}) as Dict);
  }

  /** Rename a page. */
  async rename(urlOrToken: string, title: string): Promise<void> {
    const n = await this.node(urlOrToken);
    if (n.type !== 'docx' && n.type !== 'doc') {
      if (n.type === 'unknown') throw new Error('这个知识库节点没有对应的文档');
      await new Docs(this.web).rename({ token: n.objToken, type: n.type }, title);
      return;
    }
    check(
      await this.web.json('POST', '/space/api/wiki/v2/tree/update_title/', {
        json: { wiki_token: n.wikiToken, obj_token: n.objToken, name: title },
      }),
      '改名',
    );
  }

  /** Move a page (with its subtree) under another node, possibly in another space. */
  async move(urlOrToken: string, newParent: string): Promise<void> {
    const [n, p] = [await this.node(urlOrToken), await this.node(newParent)];
    check(
      await this.web.json('POST', '/space/api/wiki/v2/tree/move_node/', {
        json: {
          wiki_token: n.wikiToken,
          old_parent_wiki_token: n.parent,
          old_space_id: n.spaceId,
          new_parent_wiki_token: p.wikiToken,
          new_space_id: p.spaceId,
          to_last: true,
        },
      }),
      '移动',
    );
  }

  /** Copy a page (not its children) under a node (its own parent by default); returns the copy. */
  async copy(urlOrToken: string, o: { parent?: string; title?: string } = {}): Promise<WikiNode> {
    const n = await this.node(urlOrToken);
    const target = o.parent ? await this.node(o.parent) : undefined;
    const body = check(
      await this.web.json('POST', '/space/api/wiki/v2/tree/node/copy/', {
        json: {
          wiki_token: n.wikiToken,
          space_id: n.spaceId,
          ua_type: 'Web',
          scene: 'wiki_copy',
          target_wiki_token: target?.wikiToken ?? n.parent,
          target_space_id: target?.spaceId ?? n.spaceId,
          title: o.title ?? `${n.title} 副本`,
          ext_info: { only_schema: 'false', only_base_app: 'false' },
        },
      }),
      '复制',
    );
    return toNode((body.data ?? {}) as Dict);
  }

  /** Delete a page and its subtree (to the space's trash). */
  async remove(urlOrToken: string): Promise<void> {
    const n = await this.node(urlOrToken);
    check(
      await this.web.json('POST', '/space/api/wiki/v2/tree/del_node/', {
        json: { space_id: n.spaceId, wiki_token: n.wikiToken, auto_delete_mode: 0, apply: 0 },
      }),
      '删除',
    );
  }

  private async rootToken(spaceId: string): Promise<string> {
    const data = (check(
      await this.web.json('GET', '/space/api/wiki/v2/space/get_info/', {
        query: { space_id: spaceId },
      }),
      '读取知识空间',
    ).data ?? {}) as Dict;
    const info = ((data.space_info ?? {}) as Record<string, Dict>)[spaceId];
    const root = info?.root_token;
    if (!root) throw new Error(`找不到知识空间 ${spaceId}`);
    return String(root);
  }
}
