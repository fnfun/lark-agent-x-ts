# 与 fork 版（Python）的兼容性

目标是**可直接替换**：命令、参数、标准输出、退出码、数据目录、`credentials.json`、`messages.db` 的表结构与内容格式都与 fork 版一致，调用方（如解析 `已发送 msg_id=…`、`OK …/EXPIRED …`、历史行首 position 的程序）不用改。

## 已逐字节核对

- `lark config`、`auth status`、`auth check`、`chats`、`sessions`、`messages`（含 `--json`、`--anchor`）、`history`（含 `--json`）、`api`（含原始字节的 `b'...'` 打印）、`search`、`self-chat`：同一份数据下两版输出相同（2026-10-13，读 Python 版写下的 `~/.larkx`）。
- 消息内容解码（18 种类型 + 解析失败文案）、推送帧解析、全部发送包构造与响应解码：`tests/parity.test.ts` 对照原版生成的样本。
- 入库格式：`content_data` 与 Python `json.dumps(ensure_ascii=False)` 一致（分隔符、转义、int64 不丢精度、浮点 `1.0`、字节换成 `<n bytes>`、截断到 2 万个字符）；时间列为 SQLAlchemy 的 `YYYY-MM-DD HH:MM:SS.ffffff`。
- 资源下载的文件、终端二维码字符画、agent 会话 id（uuid5）、协议资产与管线的全部中间产物。

## 有意保留的差异

| 方面 | fork 版 | 本仓库 | 原因 |
|---|---|---|---|
| protobuf map 字段的遍历顺序 | upb 哈希表槽位顺序（同一组键在各进程间固定，但与插入或线上顺序都无关） | 线上顺序 | 原顺序没有含义，复刻 upb 哈希表既脆弱又无收益。影响：`content_data` 里 map 字段的键顺序（JSON 语义不变）；系统消息摘要里多段文字的拼接顺序；同一推送包里多条消息的处理顺序；发送包里 map 条目的线上顺序（服务端不依赖） |
| 同一推送包里的多条消息 | 投递到另一个事件循环并发处理 | 按到达顺序串行处理 | 入库顺序确定，调用方按自增 id 读取时不会乱序 |
| 网络层错误文案 | requests 的异常文本（如 `HTTPSConnectionPool(...): Read timed out.`） | `网络请求失败(<host>): <原因>` | 运行时不同，文案无法一致；保留"网络"二字，调用方按"网络 / timed out"识别网络问题的规则仍然成立。HTTP 非 2xx 的文案（`400 Client Error: Bad Request for url: …`）与 requests 一致 |
| 网关报错的原因 | 只有 requests 的 `400 Client Error: …` | 文案不变，网关在响应里给了原因时在末尾附 ` (<原因>)`（`lark api` 与未捕获异常）；库里放在 `HttpError.reason` | 原因（如 `chat not in thread mode`）能直接说明是参数、权限还是会话类型的问题 |
| 未捕获的异常 | 打印 Python 调用栈，退出码 1 | 只打印一行 `<错误类型>: <消息>`，退出码 1 | 调用方通常取最后一行做提示，结果相同 |
| 日志行 | `时间 \| 级别 \| 模块:函数:行号 - 消息` | `时间 \| 级别 \| 模块 - 消息` | 只少了函数名与行号 |
| `.env` 的位置 | python-dotenv 从包所在目录向上找（可编辑安装时即仓库根） | 当前工作目录（Bun 自动加载） | 单文件可执行没有"包所在目录"；需要时在调用方的工作目录放 `.env` 或直接传环境变量 |
| 凭证失效时的交互菜单 | questionary 方向键选择（不可用时退回数字菜单） | 数字菜单 | 少一个交互依赖，选项与行为相同 |
| 库入口 | `larkx/__init__.py` 导出客户端、凭证、存储与 agent | 只导出 Node 与 Bun 都能运行的部分（凭证、客户端、长连接、资源下载、日志接口） | 存储与 agent 依赖 Bun，进程内嵌入（如 niuma）用不到它们；命令行照旧全部可用 |
| 长连接保活 | websockets 默认：握手 10 秒超时；协议层 ping 每 20 秒，20 秒无 pong 断开 | 握手 15 秒超时；应用层心跳每 30 秒，65 秒内收不到任何帧断开 | Node 的 WebSocket 没有协议层 ping；服务端对每次应用层心跳都回一帧，可据此判断连接是否还活着 |
| 断线重连 | 直接重连，断线期间的消息丢失 | 重连后按收件箱里有变动的会话补收断线期间的消息（会话消息与话题回复），按 msg_id 去重后入库并交给数字人 | 数字人不能漏掉有人找它的消息 |
| 新增 | — | `lark --version`（版本与构建 commit）；库的 `setLogSink`、`recentChats`（收件箱里某时刻之后有变动的会话）、`connectWebsocket` 的 `onOpen` | 单文件构建没有 git 仓库可查 commit；嵌入别的进程时日志由宿主接管，并在重连后据此补收断线期间的消息 |
