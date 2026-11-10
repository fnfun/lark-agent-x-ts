# 版本规划

[English](roadmap.md) | 简体中文

2026-11-10 制定。对照对象是官方 [larksuite/cli](https://github.com/larksuite/cli) v1.0.99（commit `1bfdcc2`，2026-11-04）的 shortcut 命令和 `internal/registry/catalog/services/*.json` 接口目录；本项目现状以 v0.1.0 的 `src/` 为准。

## 口径

- **只算 user 身份能用的**。纯 bot 的不做：IM 加急（`urgent_*`）、合并转发（`merge_forward`）、卡片更新（`messages patch`）、`event +subscribe`；会议的 `+meeting-join` / `+meeting-leave` / `+meeting-end` / `+meeting-invite`；任务智能体（`agent register_agent` 等 3 个）；`application` 的斜杠命令。官方 `+messages-edit` 只能用 bot 身份，本项目以个人身份已经能编辑。
- **需要音视频的不做**：会中操作（截图、倒计时、会中聊天与表情、会中事件），妙记音视频的上传与下载（`minutes +upload` / `+download`）。会议记录、纪要、逐字稿、妙记文字内容都要做。
- **不追求逐条对齐**。官方 user 身份可用的操作约 600 个，按 agent 常用程度挑；没封装的用透传命令兜底（`lark api` 调网关，v0.3 新增的 `lark web` 调网页接口）。
- 全部走网页登录态（扫码得到的 cookie），不建应用、不用 OpenAPI。

### 通道

本项目没有 OpenAPI，每个领域的协议来源不同，决定了难度：

| 通道 | 说明 | 风险 |
|---|---|---|
| 网关（已有） | `assets/cmd_map.json` 里已有请求类型，protobuf，和 IM 同一条路 | 低：只需实测字段 |
| 网关（待提取） | 同为网关 protobuf，但定义在日历、邮箱等网页应用自己的前端包里，现有协议管线只提取了 messenger 的包 | 中：先扩展 `scripts/proto-pipeline/` |
| 网页接口 | 各业务网页应用的 HTTP + JSON 接口（云文档、审批、OKR、妙记等），带登录 cookie 与 csrf | 中：从前端代码提取路径，再用只读请求实测 |
| 协同通道 | 文档、表格、多维表格、幻灯片在浏览器里的编辑走实时协同（changeset），不是普通 HTTP 写接口 | 高：可能只能做到只读 + 导入式新建 / 整体覆盖 |

## 对照总表

"官方规模"是 user 身份可用的 shortcut 数 + 目录接口数（两者有重叠）。本项目在 IM 以外除透传外都未实现。

| 领域 | 官方规模 | 本项目 | 通道 | 版本 |
|---|---|---|---|---|
| IM | 25 + 46 | 主链路齐，缺一批过滤维度与群设置，见下文 | 网关（已有） | v0.2 |
| 通讯录 | 3 + 1 | 只有名字解析 | 网关（已有）：`users.PullUserProfileRequest` 等 | v0.2 |
| 任务 | 17 + 36 | 无 | 网关（已有）：`todo.*` / `todo.v1.*` 约 150 个，含建、改、删、完成、评论、清单、分组、自定义字段、成员 | v0.3 |
| 云文档 / 云盘 / 知识库 / Markdown 文件 | 15 + 40 + 13 + 5，接口 35 | 无 | 网关（已有）只有文档列表、按 URL 取元信息、建文档、综合搜索（`usearch.UniversalSearchRequest`）；正文、云盘、知识库走网页接口；正文编辑走协同通道 | 读与非协同写 v0.4，编辑 v0.6 |
| 日历 | 14 + 18 | 无 | 网关（已有）只有日历、忙闲、会议室、RSVP 回复；日程增删改与参会人在日历应用的包里，需要先提取 | v0.5 |
| 电子表格 | 66 + 8 | 无 | 网页接口 + 协同通道 | v0.6 |
| 多维表格 | 117 | 无 | 网页接口 + 协同通道 | v0.6 |
| 邮箱 | 29 + 57 | 无 | 网关（已有）只有元数据和 feed 类；收发、草稿、文件夹在邮箱应用里，可能是网关（待提取）也可能是网页接口 | v0.7 |
| 审批 | 14 | 无 | 网页接口（网关里只有待办计数） | v0.7 |
| 会议记录 / 妙记 / 纪要 | 9 + 8 + 2（去掉 bot 与音视频后） | 无 | 网页接口 | v0.8 |
| OKR | 20 + 23 | 无 | 网页接口（独立站点） | v0.8 |
| 考勤 | 1 | 无 | 网页接口 | v0.8 |
| 幻灯片 / 画板 / 思维笔记 | 13 + 4 + 2，接口 13 | 无 | 网页接口 + 协同通道 | v0.9 |
| 妙搭 | 98 | 无 | 网页接口（独立站点，认证方式待确认） | v0.9 |

## 版本

每个版本独立可发布：做完一个版本就跑完验证、更新 README 与 `docs/compat.md` 的"新增"行，再开下一个。网页接口类的版本，第一步都是提取接口并实测只读调用，结论写进对应模块的文件头注释（接口来源、实测日期）。

### v0.2：IM 与通讯录补齐

全部是网关（已有）的请求，不需要新底座。

第一批（agent 收益最大）：

- 按用户发私聊：`send` / `send-image` / `send-file` / `history` 接受 `--user <user_id>`，经 `createChat` 换成私聊 chat_id。
- 搜消息补过滤：`search-messages` 加 `--at-me`、`--at <user_id>`、`--attachment <类型>`、`--chat-type`、`--sender-type`。
- 用户资料：`lark user <user_id>` 输出部门、邮箱、状态、签名；`lark search-users` 支持"聊过的人""外部用户""已离职"过滤；`lark search-bots` 搜机器人。
- 会话列表：`lark chat-list` 从服务端列群与私聊（按活跃排序、`--exclude-muted`）。`chats` 是 fork 版命令，保持只读本地库不变。
- 群搜索与群信息：`lark chat-search`（按群名、`--member`、`--managed`、`--mode`）；`lark group info <chat_id>`（群主、人数、描述、模式）。

第二批（群设置与发送细节）：

- 免打扰：`lark mute <chat_id...>`（`--remove`、`--at-all`）。
- 群昵称：`lark group nickname`。
- 群管理员：`lark group admin add/remove`。
- 发言权限：`lark group moderation`。
- 入群申请：`lark group requests`（`--approve` / `--reject`）。
- 群分享链接：`lark group link`。
- 标签管理：`tags` 加 create、rename、delete、add、remove。
- 发视频（带封面）和语音；`--md` 里的图片自动上传；富文本附件区。
- 整个话题转发（`forward --thread`，协议形态需抓包）；文件夹类消息列出子文件与下载。
- 体验项：`history` 的 `--order` 与 `--reactions`；`shortcut` 的插入位置。

验收：只读命令对真实账号实测；写操作只在 `lark self-chat` 和自建的测试群里做。

**进展（2026-11-10，已完成）。** 实际做法与上面有两处不同：私聊不用 `--user`，而是在 `<chat_id>` 的位置写 `user:<user_id>`（参数解析器做不到"有某个选项时省掉位置参数"）；`chat-search` 没有 `--managed`（服务端的群搜索过滤里没有这个字段）。

- 在真实账号上实测过（读操作；写操作只做在自聊会话、只有自己的测试群和测试标签上，随后还原）：第一批的全部命令；`send-video` / `send-audio`（下载回来逐字节一致，时长正确；服务端只保留语音的整秒，所以发送时四舍五入）；`send --md` 的内嵌图片与 `--attach`；`forward --thread`；`history --order/--reactions`；`mute`（含 `--at-all`）、`group nickname`（`members` 能显示，取自成员列表的 `metas`）、`group moderation`、`group link`、`tags` 的增删改。
- 按协议定义实现、用假服务端测试覆盖（请求按真实定义严格编码），但实测会涉及他人，所以**没有实测**：`group admin`（要有别的成员）、`group requests --approve/--reject`（要有人申请）。
- 顺延：文件夹消息的子文件列表需要 `media.v1.*` 的定义，现有协议管线没提取到（`cmd_map.json` 里有名字、没有定义），随 v0.3 的管线扩展一起做。放弃：`shortcut` 的插入位置，服务端怎么处理 `position` 只能靠在真实账号上写入才能确认。

### v0.3：多领域底座 + 任务

底座（后续每个版本都依赖它）：

- **网页登录态验证**：逐个确认扫码得到的 cookie 能否直接调用云文档、云盘、知识库、日历、邮箱、审批、OKR、妙记、考勤、妙搭的网页接口，各自需要什么 csrf 或二次换票。结论写成一张可用性表，放在 `src/web.ts` 的文件头注释里。用不了的领域在这里就调整后续版本。
- **`src/web.ts`**：网页接口客户端。处理租户域名、cookie、csrf、重定向换票；错误映射到 `AuthExpired`、`NetworkError`、`HttpError`；不用 `Bun.*`，保证能在 Node 下运行。
- **`lark web <METHOD> <路径> [json]`**：网页接口透传，归 `system` 分组。
- **协议管线扩展**：`scripts/proto-pipeline/` 支持提取日历、邮箱等应用的前端包，产物仍进 `lark_all.binpb`，核心子集按需加入。
- **代码组织**：新领域放 `src/domains/<领域>.ts`（库）和 `src/cli/<领域>.ts`（命令），`LarkClient` 只保留 IM。库入口按领域导出。
- **命令形态**：`lark <领域> <动作>`，领域名用 `task`、`doc`、`drive`、`wiki`、`md`、`sheet`、`base`、`cal`、`mail`、`approval`、`vc`、`minutes`、`okr`、`attendance`、`slides`、`board`、`apps`，都不与 fork 版的命令重名。所有命令支持 `--json`。
- **权限**：每个新命令（或"命令.动作"）都登记进 `src/permissions.ts`。现有分组的说明从 IM 措辞扩展到通用。另外新增 `destroy` 分组，收删除类操作（删文档、删记录、删日程、邮件进回收站），让"能写不能删"的规则一条就能配。

任务（第一个用网关做的新领域，用来验证底座）：

- 我的任务、与我相关、搜索。
- 建、改、完成、重开、删。
- 子任务与父任务、负责人与关注人、提醒、评论、附件。
- 清单：建、搜、成员、往清单加任务、分组。

验收：`bun test`（假服务端）；真实账号只读查询；写操作只在自建的测试清单里做。

**进展（2026-11-10，已完成）。**

- 底座：协议管线能提取以数组注册的命名空间，所有 `*.v1` 定义都有了（`cmd_map.json` 与核心资产不变）；网页登录态可用性表（`src/web.ts` 文件头）；`WebSession` 与 `lark web`；命令行入口的命令组；权限分组 `destroy`；命令文件共用的工具抽到 `src/cli/common.ts`。
- 任务：`lark task list/search/get/subtasks/create/update/complete/delete/comment/comments/lists/list-create/list-delete` 与库的 `Tasks`，全部在真实账号上用专为测试新建、测完删除的任务和清单实测过。协议的实际行为（哪些请求能用、修改的 commit 编码、截止时间以秒计）写在 `src/domains/task.ts` 文件头。
- 未做：列出清单里的任务（没找到能用的请求；任务所属的清单可以在 `task get` 里看到）、任务附件与提醒。
- 留给后续版本的发现：审批、考勤在测试租户上 404，妙搭在 Lark 国际版没有入口；测试账号里没有文档、日程数据，后续版本要先建测试资源再读写。

### v0.4：云文档、云盘、知识库（读 + 非协同写）

- 搜索：文档、知识库、表格，走综合搜索。
- 读正文：`lark doc fetch <url|token>` 输出 Markdown。docx 块结构转 Markdown 需要自己写，先确认网页接口的块格式能否套用现成转换库。
- 文档里的图片与附件下载、历史版本列表。
- 云盘：列目录、元信息、上传、下载、建文件夹、复制、移动、删除、改标题、导入（Markdown、Word、Excel 转在线文档）、导出。
- 评论：列出、发表、回复、解决。
- 权限：查看与增删协作者、公开设置、申请权限。
- 知识库：空间列表、节点树、按 URL 解析节点、建节点、移动、复制、删除、空间成员。
- Markdown 文件：建、取、覆盖、比对。
- 数字人：收到文档链接时，自动取正文放进提示词（大小有上限）。

新建文档先用"导入 Markdown"实现，不依赖协同通道。

**进展（2026-11-10，部分完成）。** 云文档网页接口的路径和请求格式取自云文档网页应用的 JS（预载和按需加载的代码块；路径是租户域名下的 `/space/api/...`）。已完成并在两个测试账号（Lark 与飞书）上用专为测试新建、测完移进回收站的文档和文件夹实测：`lark doc search/ls/create/import/rm/fetch` 与库的 `Docs`；`fetch` 把 docx 转成 Markdown（导入 Markdown 再读回来核对过）；`WebSession` 会带云文档的 csrf，并支持表单与 multipart 请求体。接口的实际行为写在 `src/domains/docs.ts` 文件头，块格式写在 `src/domains/docx-markdown.ts` 文件头。

- 2026-11-11 补上，同样在两个账号上实测：`rename`、`mv`、`cp`、`trash` / `restore`、`upload`（超过 4MB 分块）/ `download`、`export`（docx 导出 docx / pdf，表格导出 xlsx）、评论（`comments` / `comment` / `reply` / `resolve` / `comment-rm`，库的 `DocComments`）和分享（`sharing` / `set-link`，库的 `DocPermissions`）。把测试文档的链接范围放宽被会话的安全检查拦下，`set-link` 只用"设成当前值"验证过。评论和权限的细节写在 `src/domains/doc-comments.ts`、`src/domains/doc-permissions.ts` 文件头。
- 知识库，2026-11-11 补上：`lark wiki spaces/ls/get/create/rename/mv/cp/rm` 与库的 `Wiki`；`doc` 各命令接受知识库链接（先解析成对应文档）。在飞书账号的个人文档库里用专为测试新建、测完删除的页面实测；Lark 账号没有知识空间，新建空间回 920004103，所以个人库以外的空间列表只验证过空结果。细节写在 `src/domains/wiki.ts` 文件头。
- 未做：划词评论和历史版本（都在 docx 编辑器自己的代码包里，放到 v0.6 一起研究）、增删协作者和空间成员（涉及他人）、新建知识空间（见上），以及 Markdown 文件与本地草稿的比对（项目里没有 diff 库；`doc cat` 再用本地 diff 即可）。Markdown 文件本身是云空间文件：`doc upload` 新建、`doc cat` 读取、`doc upload --replace` 作为新版本覆盖。

### v0.5：日历

- 日程：今日或指定范围的议程、详情、搜索。
- 建、改（增减参会人）、删（重复日程按范围）、转让组织者、回复邀请、通过分享链接加入。
- 忙闲查询与多人共同空闲、推荐时间段、找会议室。
- 日程关联的会议与纪要。

先决：v0.3 的协议管线扩展要能提取日历应用里的日程增删改请求。

**进展（2026-11-10，大部分完成）。** `lark cal calendars/agenda/get/create/update/delete` 与库的 `Calendar`，在飞书测试账号上用专为测试新建、测完删除的日程实测。日程走日历网页应用的 `calendarweb` 命令（1002001 列出、1002003 新建、1002004 修改、1002005 删除、1002006 按 id 取），cmd 映射里没有这些号，由 `LarkClient.command` 按号调用；同一应用里的 `calendar.v1.*` 命令号回"command not found"。细节写在 `src/domains/calendar.ts` 文件头。

- 未做：参会人（邀请他人）、回复邀请、忙闲与推荐时间、会议室、日程搜索。老版忙闲请求回空包；参会人与回复邀请会涉及他人。

### v0.6：协同编辑：文档、表格、多维表格

开工前先做一次协同通道评估：编辑走什么帧、能否只发增量、冲突怎么处理。按结论二选一：

- **可行**：文档的局部更新、追加与插图，表格单元格读写，多维表格记录增删改，都走协同通道。
- **成本过高**：降级为只读 + 导入式新建 / 整体覆盖，或者改用官方 OpenAPI（需要建应用，会改变本项目的定位）。到这一步时再请你决定。

范围（按 agent 常用程度挑，其余用透传兜底）：

- 文档：局部更新、追加、插入图片附件、历史回滚。
- 表格：工作表列表与信息、读写区域、CSV 导入导出、查找替换、增删行列、新建表格。
- 多维表格：表、字段、记录的增删改查，视图列表与筛选，记录搜索、附件、数据查询。仪表盘、表单、自动化、角色、应用模式这几块面大、使用少，不在本版。

**进展（2026-11-11，多维表格、电子表格和文档完成）。** 协同通道走普通 HTTP 就能用：`POST /space/api/rce/messages` 承载的就是网页通过 WebSocket 发的 `USER_CHANGES` 消息，member id 由客户端自定，不需要 ticket，服务端回 `ACCEPT_COMMIT`。消息格式是在无头 Chrome（DevTools 协议）里打开专为测试新建的资源、记录网页自己的流量得到的，再用 HTTP 重放验证。

- 多维表格，两个账号都实测完成：`lark base tables/fields/records/add/set/rm/field-add` 与库的 `Base`（文本、数字、单选和多选（没有的选项自动新建）、日期、复选框、超链接）。细节写在 `src/domains/base.ts` 文件头。
- 多维表格未做：视图与筛选、记录搜索、附件、删除字段和数据表、其他字段类型（人员、关联、查找引用、公式按文本读出）。
- 电子表格，在 Lark 账号上实测完成（飞书账号的会话中途被注销，见下）：`lark sheet tabs/read/write/append` 与库的 `Sheets`。写入走 `v2/sheet/user_changes`（单元格动作的 protobuf）；读取导出 .xlsx 再解析，因为页面里的单元格块是未公开的编码。细节写在 `src/domains/sheet.ts` 文件头。
- 电子表格未做：写公式（网页发的是解析后的公式结构，服务端不会重算）、插入删除行列、样式、查找替换、新增工作表。
- 文档，在 Lark 账号上实测完成：`lark doc append/write` 与库的 `DocEditor`，可以往 docx 末尾追加 Markdown 或替换正文。提交走 `POST /space/api/docx/blocks/user_change`，按块的 json0 风格操作（新块 `oi`，父块 `children` 上 `li`/`ld`）；操作格式取自 docx 编辑器代码而非网页观察，用"Markdown 写进去再读回来"在服务端核对。细节写在 `src/domains/doc-edit.ts` 文件头。
- 文档还能原地查找替换（`lark doc replace`）：块的文本操作整段替换带属性的文字，每个字保留原有属性；多行文字按服务端校验的 Etherpad 换行规则编码。
- 文档未做：图片和附件、表格、划词评论、历史版本。
- 注意：用飞书测试账号的 cookie 在无头浏览器里观察网页，导致该会话被服务端注销，需要重新登录。

### v0.7：邮箱 + 审批

- 邮箱：列信、读信与会话、搜索、发信、回复、转发、草稿、文件夹与标签、移动与标记、回收站、收信规则、签名与模板、分享到会话、`mail watch` 监听新邮件（能否复用长连接推送待确认）。
- 审批：我的待办与已办、实例详情、可发起的审批定义、发起、同意、拒绝、转交、加签、退回、抄送、催办、撤回。

**进展（2026-11-10，卡住）。** 邮箱：两个测试账号都没有邮箱（`mails.ListConnectedEmailAccountsRequest`、`mails.GetTenantDomainsRequest` 都返回空），没有可读可发的邮件。审批：Lark 测试租户上不可用；飞书上能打开管理后台（`www.feishu.cn/approval/admin/`，接口在 `/approval/admin/api/` 下）和数据分析应用（`/approval/web/`，`/approval/web/api/...`：实例管理查询、代理审批、效率报表），但普通用户用的审批中心（待办、同意 / 拒绝、发起审批）在客户端内嵌的小程序里，入口和接口还没找到。

### v0.8：会议记录、妙记、纪要、OKR、考勤

- 会议：搜索会议记录、会议详情、进行中的会议列表、纪要与逐字稿（文字）、按会议或日程找妙记。
- 妙记：搜索、详情（摘要、待办、章节、逐字稿、关键词）、改标题、替换发言人、替换词、改摘要、待办增删改、申请权限。
- OKR：周期列表与详情、目标与关键结果的建、改、删、排序、权重、对齐、进展记录、评论、指标。
- 考勤：我的打卡记录。

**进展（2026-11-11，缺数据，受阻）。** 妙记的网页接口在 `/minutes/api` 下（`GET space/list` 带 `size`、`space_name`，`GET search` 带 `query`，单条妙记按 `objectToken` 取 `base_info_v2`、`subtitles_v2`、`summaries_v2`）；列表和搜索在 Lark 测试账号上返回 code 0，但两个测试账号都没有妙记，生成妙记要上传音视频（不在范围内），详情格式无法核对，所以没有实现。OKR 默认整个组织可见，建测试 OKR 会被别人看到；也没有 OKR 数据可读。考勤只在飞书测试租户上有（Lark 上 404），按"两个平台共有"的规则先跳过。

### v0.9：幻灯片、画板、思维笔记、妙搭

- 幻灯片：建、读、加删替换页面、历史、媒体。编辑同样依赖 v0.6 对协同通道的结论。
- 画板：导出图片、读节点、更新。
- 思维笔记：读、建节点。
- 妙搭：先按 v0.3 的可用性表确认认证方式。范围限于应用列表与详情、创建、HTML 发布与分享链接、云端生成会话、日志与指标、环境变量、协作者与角色、应用数据库与文件、自动化。git 凭据、OpenAPI 密钥这类面向开发者的部分不做。

**进展（2026-11-11，读取完成）。** 幻灯片在 Lark 账号上做了创建和读取：`doc import <文件.pptx>` 生成演示文稿，`doc fetch` 按页列出文字（`slide/pages/client_vars`，和 docx 同一种块结构）。画板是文档里的块，没有做到。幻灯片、画板、思维笔记的编辑走协同通道（见 v0.6）；它们和 docx（`POST /space/api/docx/blocks/user_change`，按块的 OT 操作）的消息格式都要在网页里观察，等飞书测试账号重新登录。思维笔记在 Lark 账号上做了创建和读取：`doc import <文件.mm>` 从 FreeMind 文件生成（根主题会变成标题），`doc fetch` 读成 Markdown 大纲（`mindnote/v2/client_vars`）；不能导出（`mm`、`png` 都回 extension mismatch），编辑暂不支持（同步代码在未追到的代码块里）。妙搭在 Lark 国际版没有入口，跳过。

## 风险

- **登录态覆盖不全**：部分网页应用可能需要二次换票或独立登录，v0.3 的可用性表出来前，v0.4 以后的范围都是暂定。
- **协同通道**：决定了 v0.6 和 v0.9 的编辑能力能做到哪一步。
- **维护面**：网页接口随时可能改，没有文档。缓解办法：模块文件头注明接口来源与实测日期；透传命令兜底；协议管线可重跑。
- **风控**：个人账号大量调用写接口有风控风险。批量操作要节流；实测写操作只在自建的测试资源上做。
- **与 fork 版兼容**：新功能都是新增命令；只有 v0.2 给 fork 版已有的 `send`、`history` 加参数，默认行为不变，记进 `docs/compat.md`。
