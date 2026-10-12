import { join } from 'node:path';
import { pyDumps } from '../../src/pyjson.js';
import { ASSETS_DIR, ensureDir, OUT_DIR, WORK_DIR } from './common.js';

/**
 * 第 5 步：原始 cmd 映射 → out/cmd_table.md（速查表）与 assets/cmd_map.json（`lark api` 用）。
 * 原始格式 A `cmd|请求|响应`，B `cmd||推送||推送名`，C `cmd|请求|响应|1|名称`。
 * cmd_map.json：by_cmd 按 cmd 分组全部行；by_req 以请求类型（推送则以推送类型，并标 push）为键，同名取先出现的。
 */
const raw = (await Bun.file(join(WORK_DIR, 'cmd_map.json')).json()) as Record<string, string>;
const VALID = /^-?\d+(\|[A-Za-z0-9_.]*)+$/;

type Row = { cmd: number; req: string; resp: string; name: string };
const rows: Row[] = [];
for (const r of Object.keys(raw)) {
  if (!VALID.test(r) || !/\|[A-Za-z_.]*[A-Za-z]/.test(r)) continue;
  const [head, ...rest] = r.split('|');
  const cmd = Number(head);
  let req = '';
  let resp = '';
  let name = '';
  if (rest.length === 2) [req, resp] = rest as [string, string];
  else if (rest.length === 4) [req, resp, , name] = rest as [string, string, string, string];
  else if (rest.length === 3) [req, resp, name] = rest as [string, string, string];
  else resp = rest.join('|');
  rows.push({ cmd, req, resp, name });
}
rows.sort((a, b) => a.cmd - b.cmd);

const lines = [
  '# 飞书网页客户端接口 (cmd) 映射表',
  '',
  '> 来源：web-client-next worklet bundles (2026-07-25, sdk 7.72.8)。',
  '> 格式 A: `cmd|请求proto|响应proto`；格式 B: `cmd||推送proto||推送名`；格式 C: `cmd|请求|响应|1|名称`。',
  '> 同名 cmd 在不同业务命名空间可能复用（推送类 cmd 与请求类 cmd 不冲突）。',
  '',
  '| cmd | 请求 | 响应/推送 | 名称 |',
  '|----:|------|-----------|------|',
  ...rows.map((r) => `| ${r.cmd} | ${r.req} | ${r.resp} | ${r.name} |`),
];
ensureDir(OUT_DIR);
await Bun.write(join(OUT_DIR, 'cmd_table.md'), lines.join('\n'));
console.log(`written ${join(OUT_DIR, 'cmd_table.md')}, ${rows.length} rows`);
console.log(
  'push-type cmds:',
  rows.filter((r) => r.resp.includes('Push') || r.name.includes('PUSH')).length,
);

const byReq = new Map<string, { cmd: number; resp: string; push?: true }>();
const byCmd = new Map<string, Row[]>();
for (const r of rows) {
  const key = r.req || r.resp;
  if (key && !byReq.has(key))
    byReq.set(key, { cmd: r.cmd, resp: r.resp, ...(r.req ? {} : { push: true }) });
  const k = String(r.cmd);
  if (!byCmd.has(k)) byCmd.set(k, []);
  byCmd.get(k)?.push(r);
}
// by_cmd 的键含负数与正数，用 Map 保住按 cmd 排好的顺序（普通对象会把非负整数键提前）
const cmdMap = new Map<string, unknown>([
  ['by_req', Object.fromEntries(byReq)],
  ['by_cmd', byCmd],
]);
await Bun.write(join(ASSETS_DIR, 'cmd_map.json'), pyDumps(cmdMap, { indent: 0 }));
console.log(
  `written ${join(ASSETS_DIR, 'cmd_map.json')}: by_req ${byReq.size}, by_cmd ${byCmd.size}`,
);
