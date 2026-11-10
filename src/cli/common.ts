/** Helpers shared by the command files. */
import { LarkAuth } from '../auth.js';
import { LarkClient } from '../client.js';
import type { Permission } from '../permissions.js';
import type { CommandSpec, Parsed } from './args.js';

export const out = (s: string) => process.stdout.write(`${s}\n`);
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
