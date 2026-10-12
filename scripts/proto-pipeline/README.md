# 协议资产再生成管线（维护者用）

飞书更新网页协议后，按下面的流程重新提取全量 proto 定义与接口映射，重建 `assets/`。迁移自 fork 版 LarkAgentX 的 `dev/proto_pipeline`，对同一批输入的产物与原版逐字节一致（2026-10-13 实测）；原版用 grpcio-tools 编译，这里改用 `buf`（devDependency，语义同 protoc），不再需要 Python。

## 前提：基础 worklet 包的文件名

文件名带 hash，飞书发版后会变。取法：用浏览器打开 `open-dev.feishu.cn/next/messenger`，在开发者工具里给 `SharedWorker` 构造器挂钩子，记录传入的 blob loader 里 `importScripts` 的 URL，得到 4 个基础包：`1242.*.js`（js runtime）、`1181.*.js`（shared worklet，长连接）、`9174.*.js`（messenger worklet）、`9373.*.js`（feed worklet）。

```bash
export LARK_BASE_BUNDLES=1242.<hash>,1181.<hash>,9174.<hash>,9373.<hash>   # 不设则用 2026-07-25 版
```

## 执行

```bash
bun run proto:fetch   # 1. 解 webpack chunk 映射（基础包缺失时自动从 CDN 下载）→ work/chunk_map.json
                      # 2. 并发下载全部懒加载 chunk（360+ 个，约 13MB）→ work/chunks/
bun run proto:build   # 3. 提取 schema 注册表与 cmd 映射 → work/schemas_all.json、work/cmd_map.json
                      # 4. 生成 .proto → out/<命名空间>.proto 与可整体编译的 out/lark_all.proto
                      # 5. 生成接口速查表 out/cmd_table.md 与 assets/cmd_map.json
                      # 6. buf 编译 → assets/proto.binpb、assets/lark_all.binpb、assets/core.binpb
bun test              # 解码/构造的对照测试应全部通过
```

目录可用环境变量覆盖：`LARK_WORK_DIR`（输入与中间产物，默认本目录 `work/`）、`LARK_PROTO_OUT`（.proto 与速查表，默认本目录 `out/`）。

## 产物

- `assets/proto.binpb`：`proto/proto.proto`（手写的核心协议：网关包、长连接帧、消息内容等）。改协议细节时改这个 .proto 再跑第 6 步。
- `assets/lark_all.binpb`：全量网关定义（约 1.1 万个类型），只有 `lark api` 用到核心子集之外的类型时才加载。
- `assets/core.binpb`：常驻进程只加载的核心子集，范围由 `build-assets.ts` 的 `CORE_REQUESTS` / `CORE_TYPES` 决定；新功能用到新的网关请求时加进去。
- `assets/cmd_map.json`：请求类型名 → cmd 号与响应类型，`lark api` 与客户端都靠它找 cmd。
- `out/cmd_table.md`：接口速查表（参考，不入库）。
