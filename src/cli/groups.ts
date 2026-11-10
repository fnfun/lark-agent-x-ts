import { baseGroup } from './base.js';
import { cal } from './cal.js';
import type { CommandGroup } from './common.js';
import { doc } from './doc.js';
import { sheetGroup } from './sheet.js';
import { task } from './task.js';
import { wikiGroup } from './wiki.js';

/** Commands made of subcommands, one per domain beyond IM (`lark <domain> <action> ...`). */
export const COMMAND_GROUPS: CommandGroup[] = [task, doc, cal, wikiGroup, baseGroup, sheetGroup];
