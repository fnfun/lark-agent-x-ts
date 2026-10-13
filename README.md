# lark-agent-x-ts

飞书 / Lark 网页版消息通道的 TypeScript 实现：以个人账号扫码登录，长连接接收全部消息并入库，以本人身份发消息、标已读、生成消息链接、调任意网关接口，可选接入本地 Claude Code 做"数字人"自动回复。用 Bun 打包成**单文件可执行**，不需要 Python 环境。

> [!IMPORTANT]
> **本项目迁移自 [cv-cat/LarkAgentX](https://github.com/cv-cat/LarkAgentX)（作者 CVCat）。**
>
> - 协议逆向、消息编解码、登录流程与 protobuf 定义均来自原项目，本仓库只是把它们用 TypeScript 重写，功能与思路的原创归原作者所有。
> - 迁移基线是 fork [Thxzzzzz/LarkAgentX](https://github.com/Thxzzzzz/LarkAgentX) 的 `feat/message-link` 分支，commit [`3e406cd`](https://github.com/Thxzzzzz/LarkAgentX/commit/3e406cd57aed7c94b058b25676522a07b2eb9818)（2026-10-13）。该 fork 在上游 `97ad48e` 之上增加了引用回复、结构化富文本、消息链接、自聊会话、标记已读等命令。
> - 原项目未附带开源许可证，版权归原作者。本仓库公开源码仅供学习与交流，**不附带许可证、不发布到 npm**；原作者如有异议，本仓库会随即下线。

## 状态

fork 版的全部功能已迁移，命令行用法、数据目录、`credentials.json` 与 `messages.db` 格式都与 fork 版一致，可直接替换 `lark` 命令（Python 版写下的凭证和消息库原样沿用）。

| 模块 | 原文件（fork 版） | 本仓库 | 验证 |
|---|---|---|---|
| 协议资产：网关包、长连接帧、全量网关定义、接口映射 | `larkx/proto/*.proto`、`lark_all_pb2.py`、`cmd_map.json` | `assets/`、`proto/proto.proto` | 由下面的管线重建；全量定义与接口映射与原版逐字节一致，`proto.proto` 在原版基础上补了编辑版本与 Markdown 字段（见 docs/compat.md） |
| 登录与凭证：扫码、cookie 导入、凭证校验 | `larkx/auth.py`、`region.py` | `src/auth.ts`、`src/region.ts` | 实测导入/校验/扫码初始化，凭证字段与原版一致 |
| 网关客户端与消息长连接 | `larkx/client.py` | `src/client.ts` | 实测发送 5 种消息、标已读、消息链接、搜索、拉历史、长连接收回显 |
| 消息解码（25 种类型）/ 请求构造 | `larkx/proto/decoders.py`、`builders.py` | `src/proto/` | 用原版 Python 生成的对照样本逐项比对 |
| 本地存储（SQLite / MySQL） | `larkx/storage/` | `src/storage/` | 同一套测试跑 SQLite 与 MySQL 8.4；读 Python 版的库输出逐字节一致 |
| 数字人（触发规则、会话队列、Claude Code 后端） | `larkx/agent/` | `src/agent/` | 单测（假的 claude 命令）；未用真实 Claude 端到端跑 |
| 命令行（14 个子命令） | `larkx/cli.py`、`main.py` | `src/cli/` | 只读命令与原版输出逐字节对比 |
| 资源下载 | `larkx/media.py` | `src/media.ts` | 实测下载的图片与原版逐字节一致 |
| 协议资产再生成管线 | `dev/proto_pipeline/` | `scripts/proto-pipeline/` | 同一批输入，全部中间产物与资产与原版逐字节一致 |
| 数字人链路演示 | `dev/demo_*.py` | `scripts/demo-agent.ts` | 默认只打印提示词，`--live` 才调真实后端 |

与原版的少量有意差异（map 字段的遍历顺序、网络错误文案等）见 [docs/compat.md](docs/compat.md)。

## 安装与构建

需要 [Bun](https://bun.sh) ≥ 1.3。

```bash
bun install
bun run build                 # → dist/lark（当前平台的单文件可执行，约 64MB）
bun run build:all             # → dist/lark-bun-<平台>：macOS arm64/x64、Linux arm64/x64、Windows x64
bun src/cli/main.ts <命令>    # 或直接从源码运行
```

x64 目标用的是 Bun 的 `baseline` 构建（不要求 AVX2，老 CPU 与转译环境也能跑）。为什么选 Bun 见 [docs/adr/0001-bun-single-binary.md](docs/adr/0001-bun-single-binary.md)。

把 `dist/lark` 放进 PATH 即可。`lark --version` 打印版本与构建 commit。

## 命令

| 命令 | 说明 |
|-------|------|
| `lark auth qr` | 扫码登录（推荐；`--region lark` 登录 Lark 国际版） |
| `lark auth import` | 粘贴 cookie 登录 |
| `lark auth check` / `status` | 校验凭证是否过期 / 查看凭证概况 |
| `lark send <chat_id> <text>` | 发送消息（`--root` 回复进话题，`--reply <msg_id>` 引用回复，`--links` 把 `[文字](url)` 发成超链接，`--md [--title]` 发 Markdown（客户端按 Markdown 渲染），`--post [--title]` 发 HTML 富文本，`--rich <json\|@file>` 发结构化富文本；`--cid` 指定幂等键，同一个 cid 重发不会发重） |
| `lark send-image <chat_id> <路径>` / `lark send-file <chat_id> <路径>` | 发送图片 / 文件（本地文件自动上传；同样支持 `--root`、`--reply`） |
| `lark forward <msg_id> <chat_id...>` | 把一条消息转发到一个或多个会话 |
| `lark group create <群名>` / `add` / `remove` / `rename` | 建群（`--members`、`--desc`、`--topic` 建话题群）、拉人、移出、改群名或描述 |
| `lark pin <chat_id> <msg_id>` / `lark pins <chat_id>` | Pin 消息（`--remove` 取消） / 列出会话里被 Pin 的消息 |
| `lark shortcut [chat_id,...]` | 在会话列表里置顶会话（`--remove` 取消，不带参数列出已置顶的） |
| `lark tags [标签]` | 会话标签（分组）：列出标签，或列出某标签里的会话 |
| `lark flag <msg_id...>` / `lark flags` | 标记消息（`--chat` 标记会话，`--remove` 取消） / 列出我的标记 |
| `lark recall <msg_id...>` / `lark edit <msg_id> <text>` | 撤回消息 / 编辑自己发的文本或富文本消息（`--links`、`--rich`） |
| `lark react <msg_id> <表情>` / `lark reactions <msg_id...>` | 加表情回复（如 `THUMBSUP`、`DONE`，`--remove` 去掉） / 查看消息上的表情 |
| `lark read-status <chat_id> <msg_id...>` | 消息的已读情况：已读/未读人数与未读名单（发送方视角，`--names`）；`--me` 看我自己是否读过 |
| `lark read <chat_id> <msg_id...>` | 把消息标为已读（同客户端看过；话题回复按话题标记） |
| `lark message-link <chat_id> <msg_id...>` | 生成官方消息链接（单条定位到该消息；多条为合并链接） |
| `lark self-chat` | 打印与自己的会话 chat_id |
| `lark listen` | 常驻：长连接收消息入库；断线重连后自动补收断线期间的消息（含话题回复）；对方撤回或编辑消息时同步更新本地库；表情变化记日志 |
| `lark listen --agent`（或 `bun run agent`） | 常驻：收消息并接本地 coding agent 自动回复（对应原项目的 `python main.py`） |
| `lark messages <chat_id>` | 读本地消息记录（`--anchor` 只看话题，空串只看主会话） |
| `lark history <chat_id>` | 拉历史消息（`--save` 入库；`--since` / `--until` 按时间范围取最新的 `--count` 条，如 `--since 2h`、`--since 2026-10-01`） |
| `lark get <msg_id...>` | 按 id 取消息（可跨会话；`--save` 入库，`--json`） |
| `lark thread <root_id>` | 拉取一个话题：根消息加最近的回复（`--count`、`--save`、`--json`） |
| `lark download <msg_id> -o <路径>` | 下载消息里的图片/文件（本地没有该消息时向服务端取） |
| `lark api <类型名> '<json>'` | 调任意网关接口（类型名见 `assets/cmd_map.json`） |
| `lark chats` / `lark sessions` | 会话列表 / agent 会话表 |
| `lark search <关键词>` | 搜索用户/群 |
| `lark search-messages <关键词>` | 跨会话搜消息（`--chat`、`--from`、`--since`/`--until`：`3d`、`2026-10-01` 或时间戳，`--limit`、`--json`） |
| `lark unread` | 有未读的会话；`--chat <id>` 看某会话的未读消息，`--at` 只看各会话里 @我 的未读消息（`--since`、`--names`、`--json`） |
| `lark members <chat_id>` / `lark users <user_id...>` | 会话成员（id、名字、user/bot） / 批量查用户名字；`history`、`get`、`thread` 加 `--names` 时发送者显示为名字 |
| `lark config` | 查看生效配置 |

## 配置

全部有默认值，用环境变量或当前目录的 `.env` 覆盖（Bun 启动时自动加载）：

```bash
LARKX_REGION=feishu          # feishu(飞书国内版) | lark(Lark 国际版)；只影响还没有凭证时的首次登录
LARKX_HOME=~/.larkx          # 数据目录：credentials.json、messages.db、login_qr.png
LARKX_STORAGE_URL=           # 留空=SQLite(LARKX_HOME/messages.db)；MySQL 填 mysql+pymysql://<user>:<password>@<host>:3306/<db>
LARKX_CONTEXT_SCOPE=anchor   # agent 上下文边界: anchor(会话+话题) | chat(会话) | global(全部共享)
LARKX_AGENT_BACKEND=claude   # claude | none
LARKX_SYSTEM_PROMPT=         # 数字人系统提示词，留空用内置默认
LARKX_MARK_READ=true         # 收到消息自动标已读；false 时由调用方在需要时 `lark read`
LARKX_AGENT_REACTIONS=false  # 别人对我的消息加/取消表情时交给数字人（如把点赞当作同意执行）
LARKX_TRIGGER_PREFIX=        # 只把以此前缀开头的消息交给 agent；另有 LARKX_TRIGGER_CHAT_TYPES / _INCLUDE_CHATS / _EXCLUDE_CHATS / _INCLUDE_SENDERS / _INCLUDE_TAGS（会话标签名或 id）/ _KEYWORDS / _GROUP_AT_ONLY
```

凭证不放 `.env`，用 `lark auth qr` / `lark auth import` 管理。

## 作为库使用

库入口在 Node（≥ 22.19）与 Bun 下都能用，导出登录凭证、网关客户端、消息长连接与资源下载；消息库（`Bun.SQL`）与本地 agent（`Bun.spawn`）依赖 Bun，只在命令行里用。作为 git 依赖安装时，Node 加载 `prepare` 编译出的 `lib/`，Bun 直接加载 `src/`（TypeScript 项目在 tsconfig 里设 `customConditions: ["bun"]` 即可直接用源码做类型检查，不依赖 `lib/`）。把本库打进自己的 Bun 单文件可执行时，在入口处 `import 'lark-agent-x-ts/bun-assets'`，协议资产随之嵌入。

```ts
import { LarkAuth, LarkClient, setLogSink } from 'lark-agent-x-ts';

setLogSink((level, module, msg) => myLogger.log(level, `${module} - ${msg}`)); // 可选：接到宿主日志，默认写 stderr
const client = await LarkClient.create(new LarkAuth('/path/to/credentials.json')); // 默认 ~/.larkx/credentials.json；联网校验
await client.sendMsg('你好', '<chat_id>');
await client.sendMessage('<chat_id>', { markdown: '## 结论\n- 周五上线' }); // Markdown 富文本
await client.sendMessage('<chat_id>', { image: readFileSync('shot.png'), name: 'shot.png' }); // 图片/文件自动上传；file: 字节 + name 发文件
await client.api('chats.PullChatsByIdsRequest', { chatIds: ['<chat_id>'] });
await client.connectWebsocket(async (msg) => console.log(msg.chat_id, msg.from_id, msg.content), undefined, undefined, async (ev) => console.log(ev.message_id, ev.reaction_type)); // 第 4 个参数收表情变化
const groupId = await client.createGroup('项目协作群', ['<user_id>']); // 另有 addMembers、removeMembers、updateGroup
await client.forwardMessage('<msg_id>', ['<chat_id>']); // 转发，返回会话 → 新消息 id
await client.readStates('<chat_id>', ['<msg_id>']); // 谁读了、谁没读；myReadStates 看自己是否读过
await client.addReaction('<msg_id>', 'DONE'); // 另有 editMessage、recallMessage、removeReaction、reactions
const names = await client.userNames(['<user_id>']); // id → 名字（批量、缓存）；chatMembers(chatId) 列群成员
const today = await client.historyRange('<chat_id>', { since: Date.now() - 3_600_000 }); // 按时间范围拉会话历史
const mentions = await client.unreadMentions(); // 未读的 @我；unreadChats() / unreadMessages(chatId)
const hits = await client.searchMessages('月报', { since: Date.now() - 7 * 86_400_000 }); // 跨会话搜消息
const [quoted] = await client.getMessages(['<msg_id>']); // 按 id 取消息；threadMessages(rootId) 取整个话题
const missed = await client.missedMessages(Date.now() - 10 * 60_000); // 断线重连后补收：某时刻之后到达的消息（含话题回复）
```

## 开发

```bash
bun test                    # 单测 + 与原版的对照测试
bun run test:node           # 编译库到 lib/，在 Node 下跑冒烟测试（协议资产、编解码、凭证读写）
bun run typecheck && bun run lint
LARKX_TEST_MYSQL_URL=mysql+pymysql://root:test@127.0.0.1:33306/larkx bun test   # 存储测试同时跑 MySQL
```

- **对照样本**：`tests/fixtures/parity.json` 由 `scripts/gen-parity-fixtures.py` 用 fork 版的 Python 实现生成（合成数据，不含真实消息），改了编解码逻辑时在装有 fork 版的 Python 环境里重新生成。
- **协议更新**：飞书改协议后按 [scripts/proto-pipeline/README.md](scripts/proto-pipeline/README.md) 重建 `assets/`。

## 风险提示

- 这是对飞书网页版内部协议的非官方实现，与字节跳动 / 飞书 / Lark 无任何关联。协议随时可能变化导致失效。
- 以个人账号经非官方客户端收发消息存在账号风控风险，请只在自己的账号上、以自己能承担后果的方式使用；不要用于批量发送或骚扰他人。
- 凭证（cookie）等同于账号登录态，只保存在本机数据目录，请勿提交或分享。

## 致谢

感谢 [CVCat](https://github.com/cv-cat) 的 [LarkAgentX](https://github.com/cv-cat/LarkAgentX) 完成了协议逆向这项最难的工作。
