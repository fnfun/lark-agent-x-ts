# lark-agent-x-ts

English | [简体中文](README.zh-CN.md)

A TypeScript implementation of a messaging channel over the Feishu / Lark web client's internal protocol: log in to a personal account by QR code, receive all messages over a long-lived connection and save them to a local database, send messages as yourself, mark messages as read, generate message links, call any gateway API, and optionally hook up a local Claude Code as a "digital twin" that replies automatically. Bundled with Bun into a **single-file executable**; the library entry point can be embedded in a Node process.

## Installation and build

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun run build                 # → dist/lark (single-file executable for the current platform, about 64MB)
bun run build:all             # → dist/lark-bun-<platform>: macOS arm64/x64, Linux arm64/x64, Windows x64
bun src/cli/main.ts <command> # or run straight from source
```

The x64 targets use Bun's `baseline` build (no AVX2 required, so it also runs on older CPUs and under translation layers). For why Bun was chosen, see [docs/adr/0001-bun-single-binary.md](docs/adr/0001-bun-single-binary.md).

Put `dist/lark` on your PATH and you're done. `lark --version` prints the version and the build commit.

## Commands

| Command | Description |
|-------|------|
| `lark auth qr` | Log in by QR code (recommended; `--region lark` logs in to Lark, the international version) |
| `lark auth import` | Log in by pasting a cookie |
| `lark auth check` / `status` | Check whether the credentials have expired / show a credentials overview |
| `lark send <chat_id> <text>` | Send a message (`--root` replies into a thread, `--reply <msg_id>` sends a quote reply, `--links` sends `[text](url)` as hyperlinks, `--md [--title]` sends Markdown (rendered as Markdown by the client; `![alt](src)` images given as an image key, an http(s) URL or a path relative to the current directory are uploaded and shown inline; `--attach <path,...>` puts files in the message's attachment zone), `--post [--title]` sends HTML rich text, `--rich <json\|@file>` sends structured rich text; `--cid` sets the idempotency key, so resending with the same cid never sends a duplicate). Wherever a command takes `<chat_id>` to send to or read from (`send`, `send-image`, `send-file`, `schedule`, `history`), `user:<user_id>` means the direct chat with that user (created if there is none yet) |
| `lark send-image <chat_id> <path>` / `send-file` / `send-video` / `send-audio` | Send an image / file / MP4 video (`--cover <image>`) / voice message (Ogg/Opus, the format the client records); local files are uploaded automatically and durations are read from the file; `--root` and `--reply` are supported too |
| `lark schedule <chat_id> <text> --at <time>` / `lark scheduled <chat_id>` | Schedule a message (`--at 10m`, `--at "2026-10-15 09:30"`, `--md`; each chat can have only one pending scheduled message at a time) / list pending scheduled messages (`--cancel`, `--reschedule` together with `--at`) |
| `lark translate <text>` | Translate text (`--to en`, default zh); with `--msg` the arguments are message ids and those messages are translated |
| `lark forward <msg_id> <chat_id...>` | Forward a message to one or more chats (`--thread`: `msg_id` is a thread's root message and the whole thread is forwarded) |
| `lark group info <chat_id>` / `create <name>` / `add` / `remove` / `rename` | Show group details (owner, member count, description, my role, who may post, `--json`), create a group chat (`--members`, `--desc`, `--topic` creates a topic group), add members, remove members, rename the group or change its description; `nickname <chat_id> [name]` sets or clears my nickname in the group, `admins` / `admin <chat_id> <user_id...>` (`--remove <ids>`) list and change admins, `moderation <chat_id> anyone\|admins\|whitelist` (`--add` / `--remove`) sets who may post, `requests <chat_id>` lists join requests (`--approve` / `--reject <ids>`), `link <chat_id>` (`--days`, `--forever`) gets a share link to join |
| `lark pin <chat_id> <msg_id>` / `lark pins <chat_id>` | Pin a message (`--remove` unpins) / list pinned messages in a chat |
| `lark shortcut [chat_id,...]` | Pin chats to the top of the chat list (`--remove` unpins; with no arguments, lists pinned chats) |
| `lark tags [tag]` | Feed tags (feed groups): list tags, or list the chats under a tag; `--create <name>`, `--rename <name>`, `--delete`, `--add` / `--remove <chat_id,...>` manage tags (only affects me) |
| `lark mute <chat_id...>` | Mute chats (do not disturb; only affects me); `--remove` turns notifications back on, `--at-all` also mutes / unmutes @all |
| `lark flag <msg_id...>` / `lark flags` | Flag messages (`--chat` flags chats, `--remove` unflags) / list my flags |
| `lark recall <msg_id...>` / `lark edit <msg_id> <text>` | Recall messages / edit a text or rich-text message you sent (`--links`, `--rich`) |
| `lark react <msg_id> <emoji>` / `lark reactions <msg_id...>` | Add a reaction (e.g. `THUMBSUP`, `DONE`; `--remove` removes it) / show the reactions on messages |
| `lark read-status <chat_id> <msg_id...>` | Read status of messages: read/unread counts and the list of who hasn't read (sender's view, `--names`); `--me` shows whether I have read them |
| `lark read <chat_id> <msg_id...>` | Mark messages as read (same as viewing them in the client; thread replies are marked per thread) |
| `lark message-link <chat_id> <msg_id...>` | Generate official message links (one message links to that message; several produce a combined link) |
| `lark self-chat` | Print the chat_id of your self chat |
| `lark listen` | Long-running: receive messages over the long-lived connection and save them to the local database; after reconnecting, automatically backfills messages missed while disconnected (including thread replies); updates the local database when the other side recalls or edits a message; logs reaction changes |
| `lark listen --agent` (or `bun run agent`) | Long-running: receive messages and hand them to a local coding agent for automatic replies |
| `lark messages <chat_id>` | Read message records from the local database (`--anchor` shows only a thread; an empty string shows only the main chat) |
| `lark history <chat_id>` | Fetch message history (`--save` saves to the local database; `--since` / `--until` fetch the latest `--count` messages in a time range, e.g. `--since 2h`, `--since 2026-10-01`; `--order desc` lists newest first, `--reactions` adds each message's reactions) |
| `lark get <msg_id...>` | Fetch messages by id (across chats; `--save` saves to the local database, `--json`) |
| `lark thread <root_id>` | Fetch a thread: the root message plus the latest replies (`--count`, `--save`, `--json`) |
| `lark download <msg_id> -o <path>` | Download the image/file in a message (fetched from the server if the message isn't in the local database) |
| `lark api <type_name> '<json>'` | Call any gateway API (type names are listed in `assets/cmd_map.json`) |
| `lark task <action>` | Tasks: `list` (`--done`, `--all`), `search <keyword>`, `get <guid...>` (description, due, assignees, followers, lists, parent), `subtasks <guid>`, `create <title>` (`--desc`, `--due`, `--all-day`, `--assignees`, `--followers`, `--parent`, `--list`), `update <guid>` (`--title`, `--desc`, `--due` (`none` clears it), `--assignees` / `--followers` replace the list), `complete <guid...>` (`--reopen`), `delete <guid...>`, `comment <guid> <text>`, `comments <guid>`, task lists `lists` / `list-create <name>` / `list-delete <guid>`; `--json` where it lists. `lark task -h` lists them all |
| `lark doc <action>` | Docs and Drive: `search <keyword>`, `ls [folder]` (My Space or a folder; the first column is the node token), `create <name>` (`--type docx\|doc\|sheet\|base\|mindnote\|folder`, `--folder`), `import <path>` (Markdown / text / Word → docx, Excel / CSV → sheet, FreeMind `.mm` → mindnote; `--name`, `--folder`), `rm <token...>` (to the trash), `fetch <url\|obj_token>` (a docx as Markdown: headings, lists, to-dos, quotes, code, tables, inline styles and links; a mindnote as an outline), `append <doc> [markdown]` / `write <doc> [markdown]` (add Markdown at the end, or replace the body below the title; `--file` or stdin, put `--` before text starting with `-`), `rename <doc> <name>`, `mv <token...> [--to folder]`, `cp <doc>` (`--name`, `--folder`), `trash` / `restore <token...>`, `upload <path>` (any size; `--replace <file>` uploads it as a new version of that file, which is how Markdown files are edited) / `download <file>` (`-o`) / `cat <file>` (a text or Markdown file to stdout), `export <doc>` (docx → docx / pdf / md, sheet → xlsx; `--format`, `-o`), `comments <doc>` / `comment <doc> <text>` (on the whole document) / `reply <doc> <comment_id> <text>` / `resolve <doc> <comment_id>` (`--reopen`) / `comment-rm`, `sharing <doc>` (link scope and collaborators) / `set-link <doc> closed\|tenant-view\|tenant-edit\|anyone-view\|anyone-edit`. `<doc>` is a link (wiki links included), or an obj_token with `--type` (docx by default); `--json` where it lists |
| `lark base <action>` | Base: `tables <base>`, `fields <base>`, `records <base>` (`--limit`), `add <base> <field=value...>`, `set <base> <record_id> <field=value...>` (an empty value clears the cell), `rm <base> <record_id...>`, `field-add <base> <name>` (`--type text\|number\|select\|multiselect\|date\|checkbox\|url`). Select cells take option names (missing ones are created), multi select comma-separated, dates `2026-11-20` or `2026-11-20 18:30`. `<base>` is a link (its `?table=` is used), a wiki link or a token; `--table` picks a table; `--json` where it lists |
| `lark sheet <action>` | Sheets: `tabs <sheet>`, `read <sheet>` (tab-separated rows, formulas as their results; `--range A1:C10`), `write <sheet> <A1=value...>` (numeric text becomes a number, an empty value clears; formulas are not supported yet), `append <sheet> <row...>` (below the last non-empty row; cells split by `--sep`, `,` by default). `<sheet>` is a link, a wiki link or a token; `--tab` picks a tab by name |
| `lark wiki <action>` | Wiki: `spaces` (the personal library first), `ls <space_id> [parent]` (top-level pages or a page's children), `get <node>`, `create <space_id> <title>` (`--parent`, `--type docx\|sheet\|base\|mindnote`), `rename <node> <title>`, `mv <node> <parent>` (with its subtree, across spaces too), `cp <node>` (`--parent`, `--title`), `rm <node>` (with its subtree, to the space's trash). `<node>` is a wiki link or wiki_token; read a page with `doc fetch <wiki link>` |
| `lark cal <action>` | Calendar: `calendars`, `agenda` (today by default; `--days`, `--since` / `--until`, `--calendar`), `get <key>` (with the description), `create <title> --start <time>` (`--end`, default one hour; `--desc`, `--location`, `--all-day`; no attendees, nobody is notified), `update <key>` (`--title`, `--start`, `--end`, `--desc`, `--location`), `delete <key...>`; `--json` where it lists |
| `lark web <METHOD> <path> ['<json>']` | Call a web app's API on the tenant domain with the login cookies (e.g. `lark web GET /space/api/user/`; `--query '<json>'`); the app's entry page is opened first so its cookies are set. Which apps work is listed at the top of `src/web.ts` |
| `lark chats` / `lark sessions` | Chat list / agent session table |
| `lark search <keyword>` | Search users/group chats |
| `lark search-messages [keyword]` | Search messages across chats (`--chat`, `--from`, `--since`/`--until`: `3d`, `2026-10-01` or a timestamp; `--at-me` (also matches @all), `--at <user_id,...>`, `--attachment image,video,file,link,folder`, `--chat-type group\|p2p`, `--sender-type` / `--exclude-sender-type user\|bot`; `--limit`, `--json`). The keyword may be left out when a filter is given |
| `lark unread` | Chats with unread messages; `--chat <id>` shows a chat's unread messages, `--at` shows only unread messages that @mention me in each chat (`--since`, `--names`, `--json`) |
| `lark user <user_id>` | A person's profile card: name plus the visible fields such as department, email and status (`--json`; which fields appear depends on the tenant and what you may see) |
| `lark search-users [keyword]` / `lark search-bots [keyword]` | Search people (`--chatted`, `--exclude-external`, `--resigned`, `--enterprise-email`, `--ids`) / bots and AI agents (`--chat`, `--chatted`); `--limit`, `--json` |
| `lark chat-search [keyword]` / `lark chat-list` | Search group chats by name or members (`--member <user_id,...>`, `--mode group\|topic`, `--sort active\|created\|members`) / list chats from the server, most recently active first (`--type p2p\|group\|topic`, `--exclude-muted`; direct chats show the other person's name); `--limit`, `--json` |
| `lark members <chat_id>` / `lark users <user_id...>` | Chat members (id, name, user/bot) / look up user names in bulk; with `--names`, `history`, `get` and `thread` show senders by name |
| `lark config` | Show the effective configuration |
| `lark permissions` | Which permission group each command belongs to and whether it can run now (`--json`); `edit` edits the current account's rules interactively in the terminal, `clear` clears them; see [Command permissions](#command-permissions) |

## Configuration

Everything has a default; override with environment variables or a `.env` in the current directory (loaded automatically by Bun at startup):

```bash
LARKX_REGION=feishu          # feishu (Feishu, China) | lark (Lark, international); only affects the first login when there are no credentials yet
LARKX_HOME=~/.larkx          # data directory: credentials.json, messages.db, permissions.json, login_qr.png
LARKX_STORAGE_URL=           # empty = SQLite (LARKX_HOME/messages.db); for MySQL use mysql+pymysql://<user>:<password>@<host>:3306/<db>
LARKX_CONTEXT_SCOPE=anchor   # agent context boundary: anchor (chat + thread) | chat (chat) | global (shared by all)
LARKX_AGENT_BACKEND=claude   # claude | none
LARKX_SYSTEM_PROMPT=         # digital twin system prompt; empty uses the built-in default
LARKX_MARK_READ=true         # automatically mark received messages as read; when false, the caller runs `lark read` when needed
LARKX_AGENT_REACTIONS=false  # hand reactions others add to/remove from my messages to the digital twin (e.g. treat a thumbs-up as approval to proceed)
LARKX_DENY=                  # commands and groups denied; LARKX_ALLOW lists the allowed ones; see Command permissions below
LARKX_TRIGGER_PREFIX=        # only hand messages starting with this prefix to the agent; there are also LARKX_TRIGGER_CHAT_TYPES / _INCLUDE_CHATS / _EXCLUDE_CHATS / _INCLUDE_SENDERS / _INCLUDE_TAGS (feed tag names or ids) / _KEYWORDS / _GROUP_AT_ONLY
```

Credentials don't go in `.env`; manage them with `lark auth qr` / `lark auth import`.

### Command permissions

Every command can be allowed or denied individually or by group, to limit what the digital twin can do (the agent started by `listen --agent` also calls `lark`, and shares the same rules with you). With no configuration, everything is allowed. The same rules can also be enabled when used as a library; see [Using as a library](#using-as-a-library).

| Group | Contains |
|---|---|
| `local` | Read-only local data: `auth status`, `config`, `chats`, `sessions`, `messages`, `permissions` (view) |
| `query` | Read-only Feishu data: `auth check`, `history`, `get`, `thread`, `search`, `search-messages`, `search-users`, `search-bots`, `chat-search`, `chat-list`, `unread`, `members`, `users`, `user`, `group info` / `admins` / `requests` (listing), `task` listing and reading (`list`, `search`, `get`, `subtasks`, `comments`, `lists`), `doc search` / `ls` / `fetch` / `trash` / `download` / `export` / `comments` / `sharing`, `wiki spaces` / `ls` / `get`, `base tables` / `fields` / `records`, `sheet tabs` / `read`, `cal calendars` / `agenda` / `get`, `reactions`, `read-status`, `pins`, `flags`, `tags` (listing), `translate`, `message-link`, `self-chat`, `download`, plus listing with `scheduled` and `shortcut` |
| `outbound` | Sending new messages: `send`, `send-image`, `send-file`, `send-video`, `send-audio`, `schedule`, `forward`, `task create` / `comment` (assignees and followers are notified), `doc comment` / `reply`, plus cancelling and rescheduling with `scheduled` |
| `modify` | Changing existing messages or state that others can see: `recall`, `edit`, `react`, `pin`, `read`, `group nickname`, `task update` / `complete`, `doc rename` / `resolve` / `append` / `write`, `wiki rename`, `base add` / `set` / `field-add`, `sheet write` / `append` |
| `organize` | Organizing that only affects yourself: `flag`, `mute`, `task list-create`, `doc create` / `import` / `mv` / `cp` / `restore` / `upload`, `wiki create` / `mv` / `cp`, `cal create` / `update`, plus pinning and unpinning with `shortcut` and editing with `tags` |
| `manage` | Group chat management: `group`'s `create` / `add` / `remove` / `rename` / `admin` / `moderation` / `link`, and approving or rejecting with `requests`; who can open a document by link (`doc set-link`) |
| `destroy` | Deleting: `task delete`, `task list-delete` (gone for everyone involved), `doc rm` (to the trash), `doc comment-rm`, `wiki rm`, `base rm`, `cal delete` |
| `system` | Account and process level: `auth`'s `qr` / `import`, `listen`, `api`, `web`, `permissions`'s `edit` / `clear` |

Commands that mix reads and writes are split by action, named `command.action` (e.g. `group.add`, `scheduled.cancel`, `auth.qr`); `lark permissions` lists all names and the groups they belong to.

Rules are two name lists, allow and deny (comma-separated or a JSON array); a name can be `*`, a group, a command, or `command.action`. Matching goes from most specific to broadest (`command.action` → command → group → `*`); the first level with a matching rule decides, and at the same level deny wins; if nothing matches, the command is allowed.

```bash
# Read-only, plus sending text messages; everything else denied
LARKX_DENY='*'
LARKX_ALLOW=local,query,send

# Deny only group management and recall
LARKX_DENY=manage,recall

# Deny group management, but allow renaming groups (the more specific rule wins)
LARKX_DENY=manage
LARKX_ALLOW=group.rename
```

- **Per account**: `lark permissions edit` opens the group tree in the terminal and sets rules for the currently logged-in account: arrow keys move, left/right collapse and expand, and each item toggles between inherit / allow / deny (space cycles, or `a` / `d` / `i`); every line shows live whether it can finally run and which rule decides it; `s` saves, `q` quits (asking for confirmation first if there are unsaved changes). Rules are stored next to the credentials (i.e. in the data directory) in `permissions.json` (keyed by user_id), and when this account is logged in they replace the global rules above entirely; if the account has no rules of its own yet, editing starts from a copy of the global rules. `lark permissions clear` clears them and falls back to the global rules. To change rules from a script, write the environment variables or `permissions.json` directly.
- **When denied**: exit code 126, and stderr explains which rule denied it; `-h` is never restricted. If the rules contain an unknown name, or `permissions.json` is corrupt, every command exits with an error (exit code 1) rather than being let through.
- If the rules deny `system`, `lark permissions edit` / `clear` are denied too; to change them back, edit `permissions.json` or the environment variables directly.
- This is a guardrail against mistakes, not a security boundary: the agent runs with `--dangerously-skip-permissions`, and anything that can change the environment variables or the data directory can get around it.

## Using as a library

The library entry point works under both Node (≥ 22.19) and Bun, and exports login credentials, the gateway client, the message long-lived connection, and resource download; the message database (`Bun.SQL`) and the local agent (`Bun.spawn`) depend on Bun and are only used in the CLI. When installed as a git dependency, Node loads the `lib/` compiled by `prepare`, and Bun loads `src/` directly (a TypeScript project can set `customConditions: ["bun"]` in its tsconfig to type-check directly against the source without depending on `lib/`). When bundling this library into your own Bun single-file executable, `import 'lark-agent-x-ts/bun-assets'` at your entry point, and the protocol assets are embedded along with it.

```ts
import { LarkAuth, LarkClient, PermissionDenied, setLogSink } from 'lark-agent-x-ts';

setLogSink((level, module, msg) => myLogger.log(level, `${module} - ${msg}`)); // optional: route to the host's logger; writes to stderr by default
const client = await LarkClient.create(new LarkAuth('/path/to/credentials.json')); // defaults to ~/.larkx/credentials.json; validates online
await client.sendMsg('你好', '<chat_id>');
await client.sendMessage('<chat_id>', { markdown: '## 结论\n- 周五上线' }); // Markdown rich text
await client.sendMessage('<chat_id>', { image: readFileSync('shot.png'), name: 'shot.png' }); // images/files are uploaded automatically; file: bytes + name sends a file
await client.api('chats.PullChatsByIdsRequest', { chatIds: ['<chat_id>'] });
await client.connectWebsocket(async (msg) => console.log(msg.chat_id, msg.from_id, msg.content), undefined, undefined, async (ev) => console.log(ev.message_id, ev.reaction_type)); // the 4th argument receives reaction changes
const groupId = await client.createGroup('项目协作群', ['<user_id>']); // also addMembers, removeMembers, updateGroup
await client.scheduleMessage('<chat_id>', { text: '周会提醒' }, Date.now() + 3_600_000); // scheduled send; scheduledMessages / rescheduleMessage / cancelScheduledMessage
const [en] = await client.translateText(['周五上线'], 'en'); // translateMessages(ids, 'zh') translates messages
await client.forwardMessage('<msg_id>', ['<chat_id>']); // forward; returns chat → new message id
await client.readStates('<chat_id>', ['<msg_id>']); // who has read it and who hasn't; myReadStates shows whether I have read it
await client.addReaction('<msg_id>', 'DONE'); // also editMessage, recallMessage, removeReaction, reactions
const names = await client.userNames(['<user_id>']); // id → name (batched, cached); chatMembers(chatId) lists group members
const today = await client.historyRange('<chat_id>', { since: Date.now() - 3_600_000 }); // fetch chat history by time range
const mentions = await client.unreadMentions(); // unread @mentions of me; unreadChats() / unreadMessages(chatId)
const hits = await client.searchMessages('月报', { since: Date.now() - 7 * 86_400_000, atIds: [client.auth.userId] }); // search messages across chats; also attachmentTypes, chatType, senderTypes
const people = await client.searchUsers('同事', { chatted: true }); // also searchBots, searchChats, userProfile(userId), chatList(), chatInfo(chatId)
const dm = await client.directChat('<user_id>'); // the direct chat with a user (created if missing)
const tasks = new Tasks(client); // import { Tasks } from 'lark-agent-x-ts'; list, search, get, create, update, complete, reopen, delete, comment, comments, subtasks, lists, createList, deleteList
const t = await tasks.create({ title: '周报', due: Date.now() + 86_400_000, assigneeIds: ['<user_id>'] });
const cal = new Calendar(client); // events({ since, until }), get, create({ summary, start, end }), update, delete, calendars
await client.command(1002001, 'calendarweb.ListCalendarEventsRequest', { params: [] }, 'calendarweb.ListCalendarEventsResponse'); // gateway commands missing from the cmd map
await client.sendMessage('<chat_id>', { markdown: '图 ![a](img_v3_xxx)', attachments: [{ data: readFileSync('a.pdf'), name: 'a.pdf' }] }); // also { video, name, cover? } and { audio } (Ogg/Opus)
await client.setMuted(['<chat_id>'], true); // also setGroupNickname, chatAdmins / updateAdmins, setPostPermission, joinRequests / handleJoinRequest, chatShareLink, forwardThread, createFeedGroup / renameFeedGroup / deleteFeedGroup / addToFeedGroup / removeFromFeedGroup
const [quoted] = await client.getMessages(['<msg_id>']); // fetch messages by id; threadMessages(rootId) fetches a whole thread
const missed = await client.missedMessages(Date.now() - 10 * 60_000); // backfill after reconnecting: messages that arrived after a given time (including thread replies)

// Permissions: not checked by default (everything allowed). permissions: true uses the same rules as the CLI, or pass a rule set directly
const guarded = await LarkClient.create(new LarkAuth(), { permissions: { allow: ['query', 'send'], deny: ['*'] } });
await guarded.recallMessage('<msg_id>').catch((e) => e instanceof PermissionDenied && e.permission); // 'recall'
```

**Permissions**: the `permissions` option of `LarkClient.create` enables the same [command permissions](#command-permissions) as the CLI; when it isn't passed, nothing is checked, same as before.

- `true`: uses this account's rules from `permissions.json` next to the credentials, or `LARKX_ALLOW` / `LARKX_DENY` if there are none; they are re-read on every call, so rule changes don't need a restart. You can also pass `{ allow, deny }` directly.
- Every public method maps to a permission item of the same name (classified under the closest command, e.g. `addMembers` → `group.add`, `sendMessage` → `send` / `send-image` / `send-file` / `send-video` / `send-audio` depending on the content, `api` and `gatewayPost` → `api`); when not allowed, it throws `PermissionDenied` (with `permission`, `group`, `rule`).
- Only the layer the caller calls directly is checked: other methods called internally by a method (e.g. the gateway call made while sending) aren't checked again; callbacks passed to a method (e.g. the long-lived connection's `onMessage`) don't count, and calls made inside a callback are checked as usual.
- The standalone functions `uploadImage`, `uploadFile`, and `downloadMessageResource`, and `WebSession` (web app APIs: `new WebSession(auth).json('GET', '/space/api/user/')`) with `Docs`, `DocComments`, `DocPermissions`, `Wiki`, `Base` and `Sheets` built on it (`new Docs(new WebSession(auth))`), don't go through the client and aren't subject to permission control.
- Domain clients built on a client (`new Tasks(client)`, `new Calendar(client)`) follow its permission setting: each method is checked as `task.<action>` / `cal.<action>`, and the gateway calls they make inside are not checked again as `api`.
- `PERMISSIONS`, `GROUPS`, `decide`, `loadRules`, and `saveAccountRules` are exported as well, so you can build your own permissions UI.

## Development

```bash
bun test                    # unit tests + parity tests against the Python version
bun run test:node           # compile the library to lib/ and run the smoke test under Node (protocol assets, encoding/decoding, credentials read/write)
bun run typecheck && bun run lint
LARKX_TEST_MYSQL_URL=mysql+pymysql://root:test@127.0.0.1:33306/larkx bun test   # also run the storage tests against MySQL
```

- **Parity fixtures**: `tests/fixtures/parity.json` is generated by `scripts/gen-parity-fixtures.py` using the fork's Python implementation (synthetic data, no real messages); when you change the encoding/decoding logic, regenerate it in a Python environment with the fork installed.
- **Protocol updates**: when Feishu changes the protocol, rebuild `assets/` by following [scripts/proto-pipeline/README.md](scripts/proto-pipeline/README.md).
- **Language**: code comments are in English; logs, error messages, test descriptions and CLI output stay in Simplified Chinese (the output must stay compatible with the fork). Docs are bilingual: `X.md` is English, `X.zh-CN.md` is Chinese, and a change to one goes into the other in the same commit.

## Risk notice and disclaimer

- This is an unofficial implementation of the Feishu web client's internal protocol and has no affiliation whatsoever with ByteDance / Feishu / Lark. The protocol may change at any time and stop it from working.
- The full gateway definitions and API mapping under `assets/` (`lark_all.binpb`, `core.binpb`, `cmd_map.json`) are extracted and generated automatically by the pipeline from scripts served by the Feishu web client. All related rights belong to ByteDance; they are included solely for interoperability and are not the work of this repository or of the original author.
- Sending and receiving messages with a personal account through an unofficial client carries the risk of triggering the platform's risk controls on the account. Use it only on your own account, and only in ways whose consequences you can bear; do not use it for bulk sending or to harass others. When using it, comply with the Feishu / Lark terms of service and the laws and regulations where you are.
- This project is provided as is, without any warranty, express or implied; any account suspension, data loss, or other loss caused by using this project is borne by the user.
- Credentials (cookies) are equivalent to the account's login session and are stored only in the local data directory; do not commit or share them.
- If a rights holder believes that content in this repository infringes their rights, please get in touch by opening an issue; this repository will promptly deal with it or be taken down.

## Sources and acknowledgements

- This project is a TypeScript rewrite of [cv-cat/LarkAgentX](https://github.com/cv-cat/LarkAgentX) (author: CVCat): the protocol reverse engineering, message encoding/decoding, login flow, and protobuf definitions come from the original project, and the original authorship of its features and ideas belongs to the original author.
- The rewrite is based on the `feat/message-link` branch of the fork [Thxzzzzz/LarkAgentX](https://github.com/Thxzzzzz/LarkAgentX), commit [`3e406cd`](https://github.com/Thxzzzzz/LarkAgentX/commit/3e406cd57aed7c94b058b25676522a07b2eb9818) (2026-10-13). CLI usage, the data directory, and the `credentials.json` and `messages.db` formats match it, so this can directly replace the `lark` command, and credentials and message databases written by the Python version keep working as is; for the module-by-module mapping and intentional differences, see [docs/compat.md](docs/compat.md).
- The original project comes with no open-source license, and its copyright belongs to the original author. This repository makes its source code public solely for learning and exchange; it **comes with no license and is not published to npm**. If the original author objects, this repository will promptly be taken down.

Thanks to [CVCat](https://github.com/cv-cat) for [LarkAgentX](https://github.com/cv-cat/LarkAgentX), which did the hardest part of the work: reverse engineering the protocol.
