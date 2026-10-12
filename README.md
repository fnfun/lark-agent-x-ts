# lark-agent-x-ts

飞书 / Lark 网页版消息通道的 TypeScript 实现：以个人账号扫码登录，长连接接收全部消息，并以本人身份发送消息、标记已读。

> [!IMPORTANT]
> **本项目迁移自 [cv-cat/LarkAgentX](https://github.com/cv-cat/LarkAgentX)（作者 CVCat）。**
>
> - 协议逆向、消息编解码、登录流程与 protobuf 定义均来自原项目，本仓库只是把它们用 TypeScript 重写，功能与思路的原创归原作者所有。
> - 迁移基线是 fork [Thxzzzzz/LarkAgentX](https://github.com/Thxzzzzz/LarkAgentX) 的 `feat/message-link` 分支，commit [`3e406cd`](https://github.com/Thxzzzzz/LarkAgentX/commit/3e406cd57aed7c94b058b25676522a07b2eb9818)（2026-10-13）。该 fork 在上游 `97ad48e` 之上增加了引用回复、结构化富文本、消息链接、自聊会话、标记已读等命令。
> - 原项目未附带开源许可证，默认保留全部权利。因此本仓库目前**保持私有、不对外分发**，也暂不附带许可证；在取得原作者授权之前不会公开或发布到 npm。

## 定位

与原项目的 Python 版相比，本项目只做"消息通道"本身：

- **保留**：扫码登录与凭证管理、网关接口调用、WebSocket 长连接收消息、消息解码与入库、发送（文本 / 话题回复 / 引用回复 / 富文本）、标记已读、消息链接、自聊会话、历史回填、资源下载。
- **不迁移**：原项目里把消息交给本地 coding agent 的数字人部分（agent backend / dispatcher），以及 MySQL 存储。

迁移完成前的兼容目标：命令行用法、`LARKX_HOME` 数据目录、`credentials.json` 与 `messages.db` 的格式都与 fork 版一致，现有调用方可以直接切换可执行文件，无需改动。

## 迁移计划

| 模块 | 原文件（fork 版） | 状态 |
|---|---|---|
| 协议定义：网关包、长连接帧、接口类型映射 | `larkx/proto/proto.proto`、`lark_all_pb2.py`、`cmd_map.json`、`gateway.py` | 未开始 |
| 登录与凭证：扫码、cookie 导入、凭证校验 | `larkx/auth.py`、`larkx/region.py` | 未开始 |
| 网关客户端与长连接 | `larkx/client.py` | 未开始 |
| 消息解码 / 构造 | `larkx/proto/decoders.py`、`larkx/proto/builders.py` | 未开始 |
| 本地存储 | `larkx/storage/` | 未开始 |
| 命令行 | `larkx/cli.py` | 未开始 |
| 资源下载 | `larkx/media.py` | 未开始 |

protobuf 定义不重新逆向：原项目从飞书网页版提取的定义（约 1.1 万个消息类型）直接导出为描述符复用；提取工具链仍以原项目 `dev/proto_pipeline` 为准。

## 风险提示

- 这是对飞书网页版内部协议的非官方实现，与字节跳动 / 飞书 / Lark 无任何关联。协议随时可能变化导致失效。
- 以个人账号经非官方客户端收发消息存在账号风控风险，请只在自己的账号上、以自己能承担后果的方式使用；不要用于批量发送或骚扰他人。
- 凭证（cookie）等同于账号登录态，只保存在本机数据目录，请勿提交或分享。

## 致谢

感谢 [CVCat](https://github.com/cv-cat) 的 [LarkAgentX](https://github.com/cv-cat/LarkAgentX) 完成了协议逆向这项最难的工作。
