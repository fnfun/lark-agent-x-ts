import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { LarkAuth } from '../auth.js';
import { DOC_TYPES, Docs, type DocType, IMPORTABLE } from '../domains/docs.js';
import { WebSession } from '../web.js';
import type { Option } from './args.js';
import { type Command, type CommandGroup, err, out, s } from './common.js';
import { errorText, printJson, shortTime } from './format.js';

const docs = () => new Docs(new WebSession(new LarkAuth()));
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };
const TYPES = Object.keys(DOC_TYPES) as DocType[];

const search: Command = {
  name: 'search',
  help: '搜云文档(标题或内容匹配,含文档、表格、多维表格、知识库页面)',
  access: 'doc.search',
  positionals: [{ name: 'query', nargs: '+' }],
  options: [{ name: 'limit', kind: 'int', default: 20 }, JSON_OPTION],
  async run(a) {
    const hits = await docs().search((a.query as string[]).join(' '), Number(a.limit));
    if (a.json) printJson(hits);
    else for (const h of hits) out(`${h.objToken}\t${h.type}\t${h.title}\t${h.url}`);
    return 0;
  },
};

const ls: Command = {
  name: 'ls',
  help: '列出我的空间(或某个文件夹)里的文件',
  access: 'doc.ls',
  positionals: [{ name: 'folder', nargs: '?', help: '文件夹的节点 token;不填为我的空间' }],
  options: [JSON_OPTION],
  async run(a) {
    const files = await docs().list(s(a.folder));
    if (a.json) printJson(files);
    else
      for (const f of files)
        out(
          `${f.token}\t${f.type}\t${f.name}\t${f.editTime ? shortTime(f.editTime) : '-'}\t${f.url}`,
        );
    return 0;
  },
};

const create: Command = {
  name: 'create',
  help: '新建空白文档(默认 docx)或文件夹',
  access: 'doc.create',
  positionals: [{ name: 'name', nargs: '+' }],
  options: [
    { name: 'type', kind: 'string', choices: TYPES, default: 'docx', help: '类型' },
    { name: 'folder', kind: 'string', help: '放进这个文件夹(节点 token)' },
  ],
  async run(a) {
    try {
      const d = await docs().create((a.name as string[]).join(' '), {
        type: String(a.type) as DocType,
        ...(a.folder ? { folder: String(a.folder) } : {}),
      });
      out(`已新建 token=${d.token} obj_token=${d.objToken}${d.url ? ` ${d.url}` : ''}`);
      return 0;
    } catch (e) {
      err(errorText(e));
      return 1;
    }
  },
};

const rm: Command = {
  name: 'rm',
  help: '把文件移到回收站(节点 token,见 ls 的第一列)',
  access: 'doc.rm',
  positionals: [{ name: 'tokens', nargs: '+' }],
  async run(a) {
    const tokens = a.tokens as string[];
    const failed = await docs().remove(tokens);
    for (const [t, why] of failed) err(`删除 ${t} 失败: ${why}`);
    out(`已移到回收站 ${tokens.length - failed.size} 个`);
    return failed.size ? 1 : 0;
  },
};

const importCmd: Command = {
  name: 'import',
  help: `把本地文件导入成在线文档(${IMPORTABLE.join('/')};Markdown/Word 成文档,Excel/CSV 成表格)`,
  access: 'doc.import',
  positionals: [{ name: 'path' }],
  options: [
    { name: 'folder', kind: 'string', help: '放进这个文件夹(节点 token)' },
    { name: 'name', kind: 'string', help: '文档名(默认用文件名)' },
  ],
  async run(a) {
    const path = String(a.path);
    let data: Uint8Array;
    try {
      data = new Uint8Array(readFileSync(path));
    } catch (e) {
      err(`读取文件失败: ${(e as Error).message}`);
      return 1;
    }
    try {
      const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
      const name = a.name ? `${String(a.name)}${ext}` : basename(path);
      const d = await docs().import(data, name, a.folder ? { folder: String(a.folder) } : {});
      out(`已导入 obj_token=${d.objToken} ${d.type} ${d.url}`);
      return 0;
    } catch (e) {
      err(errorText(e));
      return 1;
    }
  },
};

const fetch: Command = {
  name: 'fetch',
  help: '读文档(docx),输出 Markdown',
  access: 'doc.fetch',
  positionals: [{ name: 'doc', help: '文档链接或 obj_token' }],
  options: [JSON_OPTION],
  async run(a) {
    const d = await docs().fetch(String(a.doc));
    if (a.json) printJson(d);
    else process.stdout.write(d.markdown);
    return 0;
  },
};

export const doc: CommandGroup = {
  name: 'doc',
  help: '云文档与云盘:搜索、列目录、新建、导入、移到回收站、读正文(Markdown)',
  subcommands: [search, ls, create, importCmd, rm, fetch],
};
