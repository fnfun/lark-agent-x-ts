import { accountGroup } from './account.js';
import { baseGroup } from './base.js';
import { cal } from './cal.js';
import type { CommandGroup } from './common.js';
import { doc } from './doc.js';
import { sheetGroup } from './sheet.js';
import { task } from './task.js';
import { wikiGroup } from './wiki.js';

/** Commands made of subcommands (`lark <group> <action> ...`): the domains beyond IM, and accounts. */
export const COMMAND_GROUPS: CommandGroup[] = [
  task,
  doc,
  cal,
  wikiGroup,
  baseGroup,
  sheetGroup,
  accountGroup,
];
