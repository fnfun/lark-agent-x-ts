# Release plan

English | [简体中文](roadmap.zh-CN.md)

Drawn up 2026-11-10. The reference for comparison is the shortcut commands and the `internal/registry/catalog/services/*.json` API catalog of the official [larksuite/cli](https://github.com/larksuite/cli) v1.0.99 (commit `1bfdcc2`, 2026-11-04); this project's current state is taken from `src/` as of v0.1.0.

## Scope rules

- **Only what the user identity can use counts.** Bot-only features are out: IM urgent notifications (`urgent_*`), merged forwarding (`merge_forward`), card updates (`messages patch`), `event +subscribe`; meetings' `+meeting-join` / `+meeting-leave` / `+meeting-end` / `+meeting-invite`; task agents (the 3 such as `agent register_agent`); `application` slash commands. The official `+messages-edit` works only with the bot identity; this project can already edit as the user.
- **Anything that needs audio/video is out**: in-meeting operations (screenshots, countdowns, in-meeting chat and reactions, in-meeting events), uploading and downloading Minutes audio/video (`minutes +upload` / `+download`). Meeting records, meeting notes, transcripts, and the text content of Minutes are all in.
- **No goal of one-to-one parity.** The official CLI has about 600 operations available to the user identity; pick by how often agents use them, and fall back to the passthrough commands for whatever isn't wrapped (`lark api` calls the gateway, and `lark web`, new in v0.3, calls web APIs).
- Everything uses the web login session (the cookie obtained by QR-code login); no app is created and OpenAPI isn't used.

### Channels

This project has no OpenAPI, and each domain's protocol comes from a different source, which determines the difficulty:

| Channel | Description | Risk |
|---|---|---|
| Gateway (existing) | Request types already in `assets/cmd_map.json`, protobuf, the same path as IM | Low: only the fields need testing for real |
| Gateway (to be extracted) | Also gateway protobuf, but defined in the frontend bundles of web apps such as Calendar and Mail; the current protocol pipeline only extracts the messenger bundles | Medium: extend `scripts/proto-pipeline/` first |
| Web API | The HTTP + JSON APIs of each business web app (Docs, Approval, OKR, Minutes, etc.), with the login cookie and csrf | Medium: extract paths from the frontend code, then test with read-only requests |
| Collaborative-editing channel | Editing docs, sheets, Base, and slides in the browser goes through real-time collaboration (changesets), not ordinary HTTP write APIs | High: possibly only read-only + import-style creation / whole-document overwrite |

## Overview

"Official scale" is the number of shortcuts available to the user identity + the number of catalog APIs (the two overlap). Apart from passthrough, nothing outside IM is implemented in this project.

| Domain | Official scale | This project | Channel | Version |
|---|---|---|---|---|
| IM | 25 + 46 | Main flows complete; missing a set of filter dimensions and group settings, see below | Gateway (existing) | v0.2 |
| Contacts | 3 + 1 | Name resolution only | Gateway (existing): `users.PullUserProfileRequest` etc. | v0.2 |
| Tasks | 17 + 36 | None | Gateway (existing): about 150 `todo.*` / `todo.v1.*`, covering create, update, delete, complete, comments, tasklists, sections, custom fields, members | v0.3 |
| Docs / Drive / Wiki / Markdown files | 15 + 40 + 13 + 5, 35 APIs | None | Gateway (existing) has only the document list, metadata by URL, document creation, and universal search (`usearch.UniversalSearchRequest`); content, Drive, and Wiki go through web APIs; content editing goes through the collaborative-editing channel | Reading and non-collaborative writes v0.4, editing v0.6 |
| Calendar | 14 + 18 | None | Gateway (existing) has only calendars, free/busy, meeting rooms, and RSVP replies; event create/update/delete and attendees are in the Calendar app's bundles and need extracting first | v0.5 |
| Sheets | 66 + 8 | None | Web API + collaborative-editing channel | v0.6 |
| Base | 117 | None | Web API + collaborative-editing channel | v0.6 |
| Mail | 29 + 57 | None | Gateway (existing) has only metadata and feed-related requests; sending/receiving, drafts, and folders are in the Mail app, possibly gateway (to be extracted) or possibly web API | v0.7 |
| Approval | 14 | None | Web API (the gateway only has the to-do count) | v0.7 |
| Meeting records / Minutes / meeting notes | 9 + 8 + 2 (excluding bot and audio/video) | None | Web API | v0.8 |
| OKR | 20 + 23 | None | Web API (separate site) | v0.8 |
| Attendance | 1 | None | Web API | v0.8 |
| Slides / Whiteboard / Mindnotes | 13 + 4 + 2, 13 APIs | None | Web API + collaborative-editing channel | v0.9 |
| Miaoda | 98 | None | Web API (separate site, authentication method to be confirmed) | v0.9 |

## Versions

Each version can be released on its own: when a version is done, run the full verification and update the README and the "New" row of `docs/compat.md` before starting the next. For web API versions, the first step is always to extract the APIs and test read-only calls for real, recording the findings in the header comment of the corresponding module (API source, test date).

### v0.2: Completing IM and contacts

All of these are gateway (existing) requests; no new foundation is needed.

First batch (biggest payoff for the agent):

- Direct messages by user: `send` / `send-image` / `send-file` / `history` accept `--user <user_id>`, which is turned into a direct (p2p) chat_id via `createChat`.
- More message search filters: `search-messages` gains `--at-me`, `--at <user_id>`, `--attachment <type>`, `--chat-type`, `--sender-type`.
- User profiles: `lark user <user_id>` prints department, email, status, and signature; `lark search-users` supports filters for "people I've chatted with", "external users", and "departed"; `lark search-bots` searches bots.
- Chat list: `lark chat-list` lists group chats and direct chats from the server (sorted by activity, `--exclude-muted`). `chats` is a fork command and stays unchanged, reading only the local database.
- Group search and group info: `lark chat-search` (by group name, `--member`, `--managed`, `--mode`); `lark group info <chat_id>` (owner, member count, description, mode).

Second batch (group settings and sending details):

- Mute: `lark mute <chat_id...>` (`--remove`, `--at-all`).
- Group nickname: `lark group nickname`.
- Group admins: `lark group admin add/remove`.
- Who can speak: `lark group moderation`.
- Join requests: `lark group requests` (`--approve` / `--reject`).
- Group share link: `lark group link`.
- Tag management: `tags` gains create, rename, delete, add, remove.
- Sending videos (with a cover) and voice messages; images in `--md` uploaded automatically; the attachment area of rich text.
- Forwarding a whole thread (`forward --thread`; the protocol shape needs packet capture); listing and downloading the files inside folder messages.
- Experience items: `history`'s `--order` and `--reactions`; the insert position for `shortcut`.

Acceptance: read-only commands tested for real on a real account; write operations only in `lark self-chat` and a self-created test group.

**Status (2026-11-10, done).** As built, a direct chat is addressed as `user:<user_id>` in the `<chat_id>` position rather than with `--user` (the argument parser cannot drop a positional when an option is present), and `chat-search` has no `--managed` (the server's group filter has no such field).

- Tested on the real account (reads; writes only to the self chat and to a group and a tag created for testing that only include me, undone afterwards): every first-batch command; `send-video` / `send-audio` (bytes downloaded back identical, durations as expected; the server keeps voice durations in whole seconds, so they are rounded); `send --md` inline images and `--attach`; `forward --thread`; `history --order/--reactions`; `mute` (with `--at-all`), `group nickname` (shown by `members`, read from the member list's `metas`), `group moderation`, `group link`, `tags` editing.
- Implemented from the protocol definitions and covered by fake-server tests that encode requests strictly against the real definitions, but **not tested for real**, because testing them would involve other people: `group admin` (needs another member) and `group requests --approve/--reject` (needs someone applying).
- Moved: listing folder messages needs `media.v1.*` definitions that the current pipeline does not extract (the names are in `cmd_map.json`, the definitions are not), so it moves to v0.3 together with the pipeline extension. Dropped: `shortcut` insert position, because how the server treats `position` can only be learned by writing on the real account.

### v0.3: Multi-domain foundation + tasks

Foundation (every later version depends on it):

- **Web login session verification**: confirm one by one whether the cookie from QR-code login can directly call the web APIs of Docs, Drive, Wiki, Calendar, Mail, Approval, OKR, Minutes, Attendance, and Miaoda, and what csrf or secondary ticket exchange each needs. Record the findings as an availability table in the header comment of `src/web.ts`. Domains that turn out to be unusable get their later versions adjusted at this point.
- **`src/web.ts`**: the web API client. Handles tenant domains, cookies, csrf, and redirect-based ticket exchange; maps errors to `AuthExpired`, `NetworkError`, `HttpError`; doesn't use `Bun.*`, so it runs under Node.
- **`lark web <METHOD> <path> [json]`**: web API passthrough, in the `system` group.
- **Protocol pipeline extension**: `scripts/proto-pipeline/` supports extracting the frontend bundles of apps such as Calendar and Mail; outputs still go into `lark_all.binpb`, with additions to the core subset as needed.
- **Code organization**: new domains go in `src/domains/<domain>.ts` (library) and `src/cli/<domain>.ts` (commands); `LarkClient` keeps only IM. The library entry point exports by domain.
- **Command shape**: `lark <domain> <action>`, with domain names `task`, `doc`, `drive`, `wiki`, `md`, `sheet`, `base`, `cal`, `mail`, `approval`, `vc`, `minutes`, `okr`, `attendance`, `slides`, `board`, `apps`, none of which clash with fork commands. All commands support `--json`.
- **Permissions**: every new command (or "command.action") is registered in `src/permissions.ts`. The descriptions of the existing groups are broadened from IM wording to general wording. Also add a `destroy` group for delete operations (deleting documents, deleting records, deleting events, moving mail to the trash), so that a "can write but can't delete" rule takes a single line.

Tasks (the first new domain done over the gateway, used to validate the foundation):

- My tasks, tasks related to me, search.
- Create, update, complete, reopen, delete.
- Subtasks and parent tasks, assignees and followers, reminders, comments, attachments.
- Tasklists: create, search, members, add tasks to a tasklist, sections.

Acceptance: `bun test` (fake server); read-only queries on a real account; write operations only in a self-created test tasklist.

**Status (2026-11-10, done).**

- Foundation: the pipeline extracts namespaces registered as arrays, so every `*.v1` definition is available (`cmd_map.json` and the core assets are unchanged); the web login availability table (top of `src/web.ts`); `WebSession` and `lark web`; command groups in the CLI entry; the `destroy` permission group; helpers shared by command files in `src/cli/common.ts`.
- Tasks: `lark task list/search/get/subtasks/create/update/complete/delete/comment/comments/lists/list-create/list-delete` and the library's `Tasks`, all tested on the real account with tasks and lists created for the test and deleted afterwards. How the protocol behaves (which requests work, the commit encoding of edits, due times in seconds) is at the top of `src/domains/task.ts`.
- Not done: listing the tasks inside a task list (no working request found; a task's lists show in `task get`), task attachments and reminders.
- Findings for later versions: Approval and Attendance return 404 on the test tenant, and Miaoda has no entry on Lark (international); the test account has no docs or calendar data, so those versions create test resources to read and write.

### v0.4: Docs, Drive, Wiki (read + non-collaborative writes)

- Search: documents, wikis, sheets, via universal search.
- Reading content: `lark doc fetch <url|token>` outputs Markdown. Converting the docx block structure to Markdown has to be written by hand; first check whether the web API's block format can be fed to an existing conversion library.
- Downloading images and attachments in documents, listing version history.
- Drive: list folders, metadata, upload, download, create folders, copy, move, delete, rename, import (Markdown, Word, Excel into online documents), export.
- Comments: list, post, reply, resolve.
- Permissions: view and add/remove collaborators, public sharing settings, request access.
- Wiki: space list, node tree, resolve a node by URL, create nodes, move, copy, delete, space members.
- Markdown files: create, fetch, overwrite, diff.
- Digital twin: when it receives a document link, automatically fetch the content into the prompt (with a size cap).

New documents are created via "import Markdown" first, without depending on the collaborative-editing channel.

**Status (2026-11-10, partly done).** Docs' web API paths and request shapes come from the Docs web app's JavaScript (preloaded and lazily loaded chunks; paths are `/space/api/...` on the tenant). Done and tested on both test accounts (Lark and Feishu) with documents and folders created for the test and moved to the trash afterwards: `lark doc search/ls/create/import/rm/fetch` and the library's `Docs`; `fetch` converts a docx to Markdown (checked by importing Markdown and reading it back); `WebSession` sends Docs' CSRF token and form / multipart bodies. How the API behaves is at the top of `src/domains/docs.ts`, the block format at the top of `src/domains/docx-markdown.ts`.

- Not done: rename / move / copy, comments, permissions, file upload and download, version history, Wiki (spaces, node tree) and Markdown files.

### v0.5: Calendar

- Events: agenda for today or a given range, details, search.
- Create, update (add/remove attendees), delete (recurring events by scope), transfer the organizer, reply to invitations, join via a share link.
- Free/busy lookup and common free time for multiple people, suggested time slots, finding meeting rooms.
- Meetings and meeting notes linked to events.

Prerequisite: v0.3's protocol pipeline extension must be able to extract the event create/update/delete requests from the Calendar app.

**Status (2026-11-10, mostly done).** `lark cal calendars/agenda/get/create/update/delete` and the library's `Calendar`, tested on the Feishu test account with events created for the test and deleted afterwards. Events go through the calendar web app's `calendarweb` commands (1002001 list, 1002003 create, 1002004 update, 1002005 delete, 1002006 fetch by id), which the cmd map lacks and `LarkClient.command` calls by number; the `calendar.v1.*` numbers in the same app answer "command not found". Details at the top of `src/domains/calendar.ts`.

- Not done: attendees (inviting others), RSVP, free/busy and suggested times, meeting rooms, event search. The legacy free/busy request answered with an empty packet; attendees and RSVP would involve other people.

### v0.6: Collaborative editing: docs, sheets, Base

Before starting, evaluate the collaborative-editing channel: which frames editing uses, whether only deltas can be sent, how conflicts are handled. Depending on the findings, choose one:

- **Feasible**: partial updates, appends, and image insertion for docs, cell reads/writes for sheets, and record create/update/delete for Base all go through the collaborative-editing channel.
- **Too costly**: fall back to read-only + import-style creation / whole-document overwrite, or switch to the official OpenAPI (which requires creating an app and would change this project's positioning). At that point, you'll be asked to decide.

Scope (picked by how often agents use them; everything else falls back to passthrough):

- Docs: partial updates, appends, inserting image attachments, rolling back history.
- Sheets: sheet list and info, reading/writing ranges, CSV import/export, find and replace, inserting/deleting rows and columns, creating spreadsheets.
- Base: create/read/update/delete for tables, fields, and records, view list and filters, record search, attachments, data queries. Dashboards, forms, automations, roles, and app mode are large and little used, and are not in this version.

**Status (2026-11-10, not started).** Needs documents with content to study the collaborative-editing channel; Markdown import, the way to create them, is refused by the server (see v0.4).

### v0.7: Mail + Approval

- Mail: list mail, read messages and threads, search, send, reply, forward, drafts, folders and labels, move and mark, trash, inbox rules, signatures and templates, share to a chat, `mail watch` to listen for new mail (whether it can reuse long-lived connection pushes is to be confirmed).
- Approval: my pending and completed items, instance details, approval definitions I can start, start, approve, reject, transfer, add approvers, return, CC, remind, withdraw.

**Status (2026-11-10, blocked).** Mail: neither test account has a mailbox (`mails.ListConnectedEmailAccountsRequest` and `mails.GetTenantDomainsRequest` return nothing), so there is nothing to read or send. Approval: unavailable on the Lark test tenant; on Feishu, the admin console (`www.feishu.cn/approval/admin/`, APIs under `/approval/admin/api/`) and the analytics app (`/approval/web/`, `/approval/web/api/...`: instance admin queries, delegation, efficiency reports) open, but the user-facing approval center (pending tasks, approve / reject, starting an instance) lives in the client's embedded mini-app, whose entry and APIs have not been found yet.

### v0.8: Meeting records, Minutes, meeting notes, OKR, Attendance

- Meetings: search meeting records, meeting details, list of ongoing meetings, meeting notes and transcripts (text), find Minutes by meeting or event.
- Minutes: search, details (summary, to-dos, chapters, transcript, keywords), rename, replace speakers, replace words, edit the summary, create/update/delete to-dos, request access.
- OKR: cycle list and details, create, update, delete, reorder, weights, and alignment for objectives and key results, progress records, comments, metrics.
- Attendance: my clock-in records.

**Status (2026-11-10, not started).** The Minutes and OKR pages open on the test tenant, but the account has no meetings, minutes or OKRs to read, and their APIs have not been traced. Attendance returns 404 on the test tenant.

### v0.9: Slides, Whiteboard, Mindnotes, Miaoda

- Slides: create, read, add/delete/replace pages, history, media. Editing likewise depends on v0.6's findings on the collaborative-editing channel.
- Whiteboard: export as image, read nodes, update.
- Mindnotes: read, create nodes.
- Miaoda: first confirm the authentication method from v0.3's availability table. Scope is limited to app list and details, creation, HTML publishing and share links, cloud generation sessions, logs and metrics, environment variables, collaborators and roles, app database and files, automations. Developer-facing parts such as git credentials and OpenAPI keys are out.

**Status (2026-11-10, not started).** Slides, Whiteboard and Mindnotes edit through the collaborative-editing channel (see v0.6). Miaoda has no entry on Lark (international).

## Risks

- **Incomplete login session coverage**: some web apps may need secondary ticket exchange or a separate login; until v0.3's availability table is out, the scope of everything from v0.4 on is provisional.
- **Collaborative-editing channel**: determines how far the editing capabilities of v0.6 and v0.9 can go.
- **Maintenance surface**: web APIs can change at any time and are undocumented. Mitigations: module header comments record the API source and test date; passthrough commands as a fallback; the protocol pipeline can be rerun.
- **Risk control**: heavy use of write APIs from a personal account risks triggering risk control. Batch operations must be throttled; real-world tests of write operations happen only on self-created test resources.
- **Compatibility with the fork**: new features are all new commands; only v0.2 adds arguments to the fork's existing `send` and `history`, with default behavior unchanged, recorded in `docs/compat.md`.
