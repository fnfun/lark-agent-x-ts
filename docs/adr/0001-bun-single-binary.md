# ADR-0001 · Use Bun as the runtime and bundle into a single-file executable

English | [简体中文](0001-bun-single-binary.zh-CN.md)

Date: 2026-10-13 · Status: Accepted

## Context

The fork is a Python package: users have to install Python and uv/pip, and install the fork repository in editable mode; callers (e.g. niuma) start a Python process for every `lark send`. Along with the migration to TypeScript, we want the distribution to become "download one file and it works".

## Decision

Use Bun as the runtime and bundle into a single-file executable with `bun build --compile`; the protocol assets (descriptor sets, API mapping) are embedded with `with { type: 'file' }`. Storage uses Bun's built-in `Bun.SQL`, one interface covering both SQLite and MySQL; tests use `bun test`.

## Measurements (2026-10-13, Bun 1.3.11, macOS arm64)

| Item | Result |
|---|---|
| Output size | macOS arm64 64MB, macOS x64 69MB, Linux arm64 102MB, Linux x64 102MB, Windows x64 118MB (including the runtime and all protocol assets) |
| Cross-compilation | One machine produces all platforms; Linux arm64 and x64-baseline were tested and run in a Debian container; the default x64 build requires AVX2 and fails with `Illegal instruction` in environments without it (e.g. Rosetta translation), so x64 always uses the `baseline` target |
| Startup time | `lark config` 0.05s (Python version 0.43s) |
| Memory while listening (long-running) | About 47–62MB (Python version about 24–37MB) |
| Protocol assets | Building the registry from the full definitions (11,000 types) takes 102ms and about +110MB of memory, so long-running processes load only the trimmed core subset (41KB, 7ms, process about 74MB); the full definitions are loaded on demand only when `lark api` needs them |
| Network latency | `lark read` about 3.3s, `auth check` about 8s, mostly network round trips to the Feishu gateway, unrelated to the language |

## Alternatives

- **Node.js + SEA (Single Executable Applications)**: needs extra steps such as postject, and cross-platform outputs have to be built on each platform separately; `node:sqlite` is still experimental in Node 22 and prints a warning, and MySQL needs an extra driver. Bun has everything this project commonly uses built in (SQL, WebSocket, fetch, spawn, bundling), with the fewest dependencies.
- **Stay on Python and bundle with PyInstaller**: solves installation, but for callers it's still a cross-language black box, and it gives up the possibility of sharing types and the library with TypeScript callers.

## Costs

- Large outputs (64–118MB), and resident memory about 25MB higher than the Python version.
- The core library uses `Bun.SQL`, `Bun.spawn`, and `Bun.file`, so it can't be imported directly in Node; the protocol and client parts use only Web standard APIs (fetch, WebSocket, TextDecoder) and `node:crypto`, so reusing them in Node later only requires replacing two pieces: storage and subprocesses.
