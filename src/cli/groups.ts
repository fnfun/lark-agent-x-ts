import type { CommandGroup } from './common.js';
import { doc } from './doc.js';
import { task } from './task.js';

/** Commands made of subcommands, one per domain beyond IM (`lark <domain> <action> ...`). */
export const COMMAND_GROUPS: CommandGroup[] = [task, doc];
