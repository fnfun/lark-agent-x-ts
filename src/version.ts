import { dirname } from 'node:path';
import pkg from '../package.json';

declare const BUILD_COMMIT: string | undefined;

/** 构建时由 `--define BUILD_COMMIT=...` 写入；从源码运行时现场读 git，读不到为 unknown。 */
function commit(): string {
  if (typeof BUILD_COMMIT === 'string' && BUILD_COMMIT) return BUILD_COMMIT;
  const r = Bun.spawnSync(['git', '-C', dirname(import.meta.dir), 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return r.exitCode === 0 ? r.stdout.toString().trim() : 'unknown';
}

/** `lark --version` 的输出：调用方（如 niuma doctor）据 `commit=` 核对版本。 */
export const versionLine = (): string => `${pkg.name} ${pkg.version} commit=${commit()}`;
