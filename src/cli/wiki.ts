import { LarkAuth } from '../auth.js';
import type { DocType } from '../domains/docs.js';
import { Wiki, type WikiNode } from '../domains/wiki.js';
import { WebSession } from '../web.js';
import type { Option } from './args.js';
import { type Command, type CommandGroup, err, out, s } from './common.js';
import { errorText, printJson } from './format.js';

const wiki = () => new Wiki(new WebSession(new LarkAuth()));
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };
const NODE_ARG = { name: 'node', help: '知识库链接或 wiki_token' };
const PAGE_TYPES: DocType[] = ['docx', 'sheet', 'base', 'mindnote'];

const line = (n: WikiNode) =>
  `${n.wikiToken}\t${n.type}\t${n.title}${n.hasChildren ? '\t+' : '\t'}\t${n.url}`;

/** Runs a command body, printing an error and returning 1 when it throws. */
async function guarded(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    err(errorText(e));
    return 1;
  }
}

const spaces: Command = {
  name: 'spaces',
  help: '列出能看到的知识空间(个人文档库在前)',
  access: 'wiki.spaces',
  options: [JSON_OPTION],
  async run(a) {
    const list = await wiki().spaces();
    if (a.json) printJson(list);
    else for (const sp of list) out(`${sp.id}\t${sp.name}${sp.personal ? '\t个人' : ''}`);
    return 0;
  },
};

const ls: Command = {
  name: 'ls',
  help: '列出知识空间的一级页面,或某个页面的子页面(第四列 + 表示还有子页面)',
  access: 'wiki.ls',
  positionals: [
    { name: 'space_id' },
    { name: 'parent', nargs: '?', help: '父页面的链接或 wiki_token' },
  ],
  options: [JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const nodes = await wiki().children(String(a.space_id), s(a.parent));
      if (a.json) printJson(nodes);
      else for (const n of nodes) out(line(n));
      return 0;
    }),
};

const get: Command = {
  name: 'get',
  help: '查看一个知识库页面(所在空间、父页面、对应文档的 obj_token 和类型)',
  access: 'wiki.get',
  positionals: [NODE_ARG],
  options: [JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const n = await wiki().node(String(a.node));
      if (a.json) printJson(n);
      else
        for (const [k, v] of [
          ['标题', n.title],
          ['wiki_token', n.wikiToken],
          ['空间', n.spaceId],
          ['父页面', n.parent || '-'],
          ['类型', n.type],
          ['obj_token', n.objToken],
          ['链接', n.url],
        ])
          out(`${k}: ${v}`);
      return 0;
    }),
};

const create: Command = {
  name: 'create',
  help: '在知识空间里新建页面(默认文档,放在一级)',
  access: 'wiki.create',
  positionals: [{ name: 'space_id' }, { name: 'title', nargs: '+' }],
  options: [
    { name: 'parent', kind: 'string', help: '放在这个页面下面(链接或 wiki_token)' },
    { name: 'type', kind: 'string', choices: PAGE_TYPES, default: 'docx', help: '页面类型' },
  ],
  run: (a) =>
    guarded(async () => {
      const n = await wiki().create(String(a.space_id), (a.title as string[]).join(' '), {
        type: String(a.type) as DocType,
        ...(a.parent ? { parent: String(a.parent) } : {}),
      });
      out(`已新建 wiki_token=${n.wikiToken} obj_token=${n.objToken} ${n.url}`);
      return 0;
    }),
};

const rename: Command = {
  name: 'rename',
  help: '页面改名',
  access: 'wiki.rename',
  positionals: [NODE_ARG, { name: 'title', nargs: '+' }],
  run: (a) =>
    guarded(async () => {
      await wiki().rename(String(a.node), (a.title as string[]).join(' '));
      out('已改名');
      return 0;
    }),
};

const mv: Command = {
  name: 'mv',
  help: '把页面(连同子页面)移到另一个页面下面,可以跨空间',
  access: 'wiki.mv',
  positionals: [NODE_ARG, { name: 'parent', help: '新的父页面(链接或 wiki_token)' }],
  run: (a) =>
    guarded(async () => {
      await wiki().move(String(a.node), String(a.parent));
      out('已移动');
      return 0;
    }),
};

const cp: Command = {
  name: 'cp',
  help: '复制页面(不含子页面;默认放在原页面旁边,名字加"副本")',
  access: 'wiki.cp',
  positionals: [NODE_ARG],
  options: [
    { name: 'parent', kind: 'string', help: '放在这个页面下面' },
    { name: 'title', kind: 'string', help: '副本的标题' },
  ],
  run: (a) =>
    guarded(async () => {
      const n = await wiki().copy(String(a.node), {
        ...(a.parent ? { parent: String(a.parent) } : {}),
        ...(a.title ? { title: String(a.title) } : {}),
      });
      out(`已复制 wiki_token=${n.wikiToken} ${n.url}`);
      return 0;
    }),
};

const rm: Command = {
  name: 'rm',
  help: '删除页面(连同子页面,进空间的回收站)',
  access: 'wiki.rm',
  positionals: [NODE_ARG],
  run: (a) =>
    guarded(async () => {
      await wiki().remove(String(a.node));
      out('已删除');
      return 0;
    }),
};

export const wikiGroup: CommandGroup = {
  name: 'wiki',
  help: '知识库:列空间、列页面、查看、新建、改名、移动、复制、删除(读正文用 doc fetch <知识库链接>)',
  subcommands: [spaces, ls, get, create, rename, mv, cp, rm],
};
