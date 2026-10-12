# ADR-0001 · 运行时选 Bun，并打包为单文件可执行

日期：2026-10-13 · 状态：已采纳

## 背景

fork 版是 Python 包，使用方要装 Python、uv/pip，并以可编辑方式安装 fork 仓库；调用方（如 niuma）每次 `lark send` 都要起一个 Python 进程。迁移到 TypeScript 的同时，希望分发形态变成"下载一个文件就能用"。

## 决策

用 Bun 作为运行时，`bun build --compile` 打包成单文件可执行；协议资产（描述符集、接口映射）以 `with { type: 'file' }` 嵌入。存储用 Bun 内置的 `Bun.SQL`，一套接口覆盖 SQLite 与 MySQL；测试用 `bun test`。

## 实测（2026-10-13，Bun 1.3.11，macOS arm64）

| 项目 | 结果 |
|---|---|
| 产物大小 | macOS arm64 64MB、macOS x64 69MB、Linux arm64 102MB、Linux x64 102MB、Windows x64 118MB（含运行时与全部协议资产） |
| 交叉编译 | 一台机器产出全部平台；Linux arm64 与 x64-baseline 在 Debian 容器里实测可运行；x64 的默认构建要求 AVX2，在不支持的环境（如 Rosetta 转译）会 `Illegal instruction`，所以 x64 一律用 `baseline` 目标 |
| 启动时间 | `lark config` 0.05s（Python 版 0.43s） |
| 常驻监听内存 | 约 47–62MB（Python 版约 24–37MB） |
| 协议资产 | 全量定义（1.1 万个类型）建注册表 102ms、内存约 +110MB，所以常驻进程只加载裁剪出的核心子集（41KB，7ms，进程约 74MB），全量定义只在 `lark api` 用到时按需加载 |
| 网络耗时 | `lark read` 约 3.3s、`auth check` 约 8s，主要是到飞书网关的网络往返，与语言无关 |

## 备选方案

- **Node.js + SEA（单文件应用）**：需要 postject 等额外步骤，跨平台产物要在各平台分别构建；`node:sqlite` 在 Node 22 仍是实验特性且会打警告，MySQL 要另加驱动。本项目常用的操作 Bun 都内置（SQL、WebSocket、fetch、spawn、打包），依赖最少。
- **保持 Python，用 PyInstaller 打包**：能解决安装问题，但调用方仍是跨语言黑盒，也失去了与 TypeScript 调用方共用类型与库的可能。

## 代价

- 产物较大（64–118MB），常驻内存比 Python 版高约 25MB。
- 核心库用了 `Bun.SQL`、`Bun.spawn`、`Bun.file`，不能直接在 Node 里 import；协议与客户端部分只用了 Web 标准 API（fetch、WebSocket、TextDecoder）和 `node:crypto`，将来要在 Node 里复用时，只需替换存储与子进程这两处。
