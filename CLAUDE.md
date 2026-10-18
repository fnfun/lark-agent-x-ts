# lark-agent-x-ts

[LarkAgentX](https://github.com/cv-cat/LarkAgentX) 的 TypeScript 移植：飞书 / Lark 网页版内部协议的个人账号消息通道（扫码登录、长连接收消息、以本人身份发消息、标已读、消息链接、任意网关接口），命令行用 Bun 打包成单文件，库入口可在 Node 进程内嵌入。

## 文档索引

| 想了解 | 读 |
|---|---|
| 功能、命令、配置、库用法、迁移对照表 | `README.md` |
| 与 fork 版（Python）的兼容承诺与有意差异 | `docs/compat.md` |
| 为什么用 Bun 打单文件 | `docs/adr/0001-bun-single-binary.md` |
| 协议资产（`assets/`）怎么重建 | `scripts/proto-pipeline/README.md` |

文档之间只引用不复制。

## 常用命令

```bash
bun install
bun test                       # 单测 + 与原版的对照测试
bun run test:node              # 编译库到 lib/，在 Node 下跑冒烟测试
bun run typecheck && bun run lint
bun run build                  # dist/lark（当前平台单文件）
bun src/cli/main.ts <命令>     # 从源码运行
```

每次改动至少跑 `bun test && bun run typecheck && bun run lint`；动了库入口能触达的代码（见下）再跑 `bun run test:node`。

## 目录

- `src/client.ts`：网关客户端（HTTP + protobuf）与消息长连接；`src/auth.ts`、`src/region.ts`：登录与凭证；`src/http.ts`：请求与错误类型。
- `src/proto/`：协议资产加载（`assets.ts`、`registry.ts`）、消息解码（`decoders.ts`）、请求构造（`builders.ts`）、protobuf ↔ dict（`dict.ts`）。
- `src/storage/`（`Bun.SQL`）、`src/agent/`（`Bun.spawn`）、`src/cli/`：只给命令行用。
- `src/index.ts`：库入口；`src/log.ts`：日志（loguru 行格式，可 `setLogSink` 接到宿主）。
- `assets/`：协议资产（`*.binpb`、`cmd_map.json`），由 `scripts/proto-pipeline/` 生成，不手改。
- `tests/`：`bun:test`；`tests/node/lib.smoke.mjs` 是 Node 下的冒烟测试；`tests/fixtures/parity.json` 是对照样本。

## 硬约束

- **与 fork 版兼容**：命令、参数、标准输出、退出码、数据目录、`credentials.json`、`messages.db` 格式保持一致，见 `docs/compat.md`。新增的有意差异要记进它的表里。
- **编解码以原版为准**：改 `src/proto/` 后必须过 `tests/parity.test.ts`；对照样本由 `scripts/gen-parity-fixtures.py` 在装有 fork 版的 Python 环境里生成，不手改 `parity.json`。
- **库入口必须能在 Node 下运行**：`src/index.ts` 能触达的模块不得用 `Bun.*` 或 `bun:*`；协议资产一律经 `readAsset()` 读取（单文件构建由 `src/bun-assets.ts` 注册内嵌路径，它也以 `lark-agent-x-ts/bun-assets` 导出给打单文件的 Bun 嵌入方）。导出或签名有变化时同步 README 的“作为库使用”，破坏性变更在 commit 里写 `BREAKING CHANGE`。嵌入方以 git 依赖按 commit 锁版本。
- **测试不碰真实账号**：用 `Bun.serve` 起假服务端或替换 `api` / `gatewayPost`；id 用 `7000000000000000001` 这类合成值，人名、群名用“同事甲”“项目协作群”这类占位。
- **实测真实账号时**：只做只读调用；需要验证发送时只发到自己的会话（`lark self-chat`）。凭证只在 `~/.larkx`，不打印、不提交。
- **发布边界**：原项目没有开源许可证。本仓库公开源码但不附带许可证、不发布到 npm（README 顶部声明），不要擅自加 LICENSE 或改 `package.json` 的发布字段。

## 代码约定

- TypeScript strict / ESM，Biome 格式化与 lint；文件名 kebab-case 或与原项目模块同名。
- 注释、日志、错误信息、测试描述用简体中文；注释写意图与约束，不复述代码。
- 错误类型：`AuthExpired`（凭证失效，需要重新登录）、`NetworkError`（联网失败，不一定是凭证问题）、`HttpError`（非 2xx）、`SendUnconfirmed`（服务端受理但拿不到消息 id）、`PermissionDenied`（权限规则不允许，见 `src/permissions.ts`）。调用方据此区分处理，不要把它们混成普通 `Error`。
- 日志经 `src/log.ts` 的 logger，不直接 `console.*`（命令行的标准输出除外）。
- commit message 用简短英文 Conventional Commits。
