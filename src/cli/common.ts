/** Helpers shared by the command files. */
import { writeSync } from 'node:fs';
import { LarkAuth } from '../auth.js';
import { LarkClient } from '../client.js';
import type { Permission } from '../permissions.js';
import type { CommandSpec, Parsed } from './args.js';

const PAUSE = new Int32Array(new SharedArrayBuffer(4));
let readerGone = false;

/**
 * Writes to stdout synchronously. Bun's process.stdout drops what it still buffers for a pipe when
 * the process exits (piped output was cut at 64 KB); a reader that went away (EPIPE, as with
 * `| head`) ends the output quietly.
 */
export function write(data: string | Uint8Array): void {
  let rest = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  while (rest.length && !readerGone) {
    try {
      rest = rest.subarray(writeSync(1, rest));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPIPE') readerGone = true;
      else if (code === 'EAGAIN') Atomics.wait(PAUSE, 0, 0, 1);
      else throw e;
    }
  }
}

export const out = (s: string) => write(`${s}\n`);
export const err = (s: string) => process.stderr.write(`${s}\n`);
/** An optional string argument. */
export const s = (v: Parsed[string]) => (v === undefined ? undefined : String(v));

/** A comma-separated argument as a list; undefined when not given. */
export const list = (v: Parsed[string]) =>
  v === undefined
    ? undefined
    : String(v)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

export interface Command extends CommandSpec {
  /**
   * The matching permission (see src/permissions.ts); commands that both read and write pick
   * `command.action` from their arguments.
   */
  access: Permission | ((args: Parsed) => Permission);
  run(args: Parsed): Promise<number>;
}

/**
 * A command made of subcommands (`lark task create ...`): each subcommand has its own arguments
 * and permission item, usually `<group>.<subcommand>`.
 */
export interface CommandGroup {
  name: string;
  help: string;
  subcommands: Command[];
}

export const client = async () => LarkClient.create(new LarkAuth());
