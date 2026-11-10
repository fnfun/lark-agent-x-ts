# Protocol asset regeneration pipeline (for maintainers)

English | [简体中文](README.zh-CN.md)

After Feishu updates its web protocol, follow the steps below to re-extract the full proto definitions and API mapping and rebuild `assets/`. Migrated from `dev/proto_pipeline` in the LarkAgentX fork; given the same inputs, its outputs are byte-for-byte identical to the original's (tested 2026-10-13). The original compiled with grpcio-tools; this one uses `buf` instead (a devDependency, with the same semantics as protoc), so Python is no longer needed.

## Prerequisite: file names of the base worklet bundles

The file names contain a hash and change after each Feishu release. To get them: open `open-dev.feishu.cn/next/messenger` in a browser, hook the `SharedWorker` constructor in the developer tools, and record the `importScripts` URLs in the blob loader passed to it. This gives the 4 base bundles: `1242.*.js` (js runtime), `1181.*.js` (shared worklet, long-lived connection), `9174.*.js` (messenger worklet), `9373.*.js` (feed worklet).

```bash
export LARK_BASE_BUNDLES=1242.<hash>,1181.<hash>,9174.<hash>,9373.<hash>   # if unset, the 2026-07-25 version is used
```

## Running

```bash
bun run proto:fetch   # 1. resolve the webpack chunk map (base bundles are downloaded from the CDN automatically if missing) → work/chunk_map.json
                      # 2. download all lazy-loaded chunks concurrently (360+, about 13MB) → work/chunks/
bun run proto:build   # 3. extract the schema registry and the cmd mapping → work/schemas_all.json, work/cmd_map.json
                      # 4. generate .proto files → out/<namespace>.proto and out/lark_all.proto, which compiles as a whole
                      # 5. generate the API quick-reference table out/cmd_table.md and assets/cmd_map.json
                      # 6. compile with buf → assets/proto.binpb, assets/lark_all.binpb, assets/core.binpb
bun test              # the decoding/building parity tests should all pass
```

Directories can be overridden with environment variables: `LARK_WORK_DIR` (inputs and intermediate outputs, defaults to `work/` in this directory), `LARK_PROTO_OUT` (.proto files and the quick-reference table, defaults to `out/` in this directory).

## Outputs

- `assets/proto.binpb`: `proto/proto.proto` (the hand-written core protocol: gateway packets, long-lived connection frames, message content, etc.). To change protocol details, edit this .proto and rerun step 6.
- `assets/lark_all.binpb`: the full gateway definitions (about 11,000 types), loaded only when `lark api` uses a type outside the core subset.
- `assets/core.binpb`: the core subset, the only thing long-running processes load; its scope is set by `CORE_REQUESTS` / `CORE_TYPES` in `build-assets.ts`. Add new gateway requests there when a new feature uses them.

If you only changed `proto/proto.proto` or the scope of the core subset, there's no need to rerun the earlier steps: just run `bun scripts/proto-pipeline/build-assets.ts`. Without `out/lark_all.proto` it keeps the existing `assets/lark_all.binpb` and rebuilds only `proto.binpb` and `core.binpb`.
- `assets/cmd_map.json`: request type name → cmd number and response type; both `lark api` and the client rely on it to find the cmd.
- `out/cmd_table.md`: the API quick-reference table (for reference, not committed).
