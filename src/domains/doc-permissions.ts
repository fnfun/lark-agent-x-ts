/**
 * Who can open an online document, over the Docs web app's permission APIs
 * (`/space/api/suite/permission/...`). Tested on a real account on 2026-11-11 with a document
 * created for the test: reading both views, and setting the link scope to the value it already
 * had (widening it was not tried on the real account, since that exposes the document).
 *
 * - `public.v4/` (GET: token, type) holds the document-wide settings; `link_share_entity` is who
 *   can open it by link: 1 closed (collaborators only), 2 / 3 anyone in the organization can
 *   view / edit, 4 / 5 anyone on the internet can view / edit.
 * - `members.v2/` (GET: token, type) lists the collaborators; `owner_type` 0 is a user, 2 a group
 *   chat, 18 a department.
 * - `public/update.v5/` (JSON: token, type, link_share_entity) changes the link scope.
 */
import type { WebSession } from '../web.js';
import { check, DOC_TYPES, type DocRef } from './docs.js';

type Dict = Record<string, unknown>;

/** Who can open a document by its link. */
export const LINK_SHARE = {
  closed: 1,
  'tenant-view': 2,
  'tenant-edit': 3,
  'anyone-view': 4,
  'anyone-edit': 5,
} as const;
export type LinkShare = keyof typeof LINK_SHARE;
const LINK_NAMES = Object.fromEntries(Object.entries(LINK_SHARE).map(([k, v]) => [v, k])) as Record<
  number,
  LinkShare
>;

const MEMBER_KINDS: Record<number, string> = { 0: 'user', 2: 'chat', 18: 'department' };

export interface Sharing {
  linkShare: LinkShare | 'unknown';
  /** Whether people outside the organization may be given access. */
  externalAccess: boolean;
}

export interface Collaborator {
  id: string;
  name: string;
  /** user, chat, department, or the server's number for other kinds. */
  kind: string;
  owner: boolean;
}

export class DocPermissions {
  constructor(readonly web: WebSession) {}

  /** The document's sharing settings. */
  async sharing(ref: DocRef): Promise<Sharing> {
    const data = (check(
      await this.web.json('GET', '/space/api/suite/permission/public.v4/', {
        query: this.doc(ref),
      }),
      '读取分享设置',
    ).data ?? {}) as Dict;
    const p = (data.perm_public ?? {}) as Dict;
    return {
      linkShare: LINK_NAMES[Number(p.link_share_entity)] ?? 'unknown',
      externalAccess: p.external_access_switch === true,
    };
  }

  /** Who has been given access, the owner included. */
  async collaborators(ref: DocRef): Promise<Collaborator[]> {
    const data = (check(
      await this.web.json('GET', '/space/api/suite/permission/members.v2/', {
        query: this.doc(ref),
      }),
      '读取协作者',
    ).data ?? {}) as Dict;
    return ((data.members ?? []) as Dict[]).map((m) => ({
      id: String(m.owner_id ?? ''),
      name: String(m.owner_name ?? ''),
      kind: MEMBER_KINDS[Number(m.owner_type)] ?? String(m.owner_type ?? ''),
      owner: m.is_owner === true,
    }));
  }

  /** Change who can open the document by its link. */
  async setLinkShare(ref: DocRef, scope: LinkShare): Promise<void> {
    check(
      await this.web.json('POST', '/space/api/suite/permission/public/update.v5/', {
        json: { ...this.doc(ref), link_share_entity: LINK_SHARE[scope] },
      }),
      '修改链接分享',
    );
  }

  private doc(ref: DocRef) {
    return { token: ref.token, type: DOC_TYPES[ref.type] };
  }
}
