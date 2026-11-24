import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LarkAuth } from '../auth.js';
import { unifiedDiff } from '../diff.js';
import { DocComments } from '../domains/doc-comments.js';
import { DocEditor } from '../domains/doc-edit.js';
import { DocHistory, type DocVersion } from '../domains/doc-history.js';
import { DocPermissions, LINK_SHARE, type LinkShare } from '../domains/doc-permissions.js';
import {
  DOC_TYPES,
  type DocInfo,
  type DocRef,
  Docs,
  type DocType,
  docRef,
  EXPORT_FORMATS,
  type FileData,
  IMPORTABLE,
} from '../domains/docs.js';
import { MindnoteEditor } from '../domains/mindnote.js';
import { SlidesEditor } from '../domains/slides.js';
import { WhiteboardEditor } from '../domains/whiteboard.js';
import { Wiki } from '../domains/wiki.js';
import { NotOwnDocument, ownDocsOnly, type Permission } from '../permissions.js';
import { WebSession } from '../web.js';
import type { Option, Parsed } from './args.js';
import { type Command, type CommandGroup, err, out, s, write } from './common.js';
import { errorText, printJson, shortTime } from './format.js';

const web = () => new WebSession(new LarkAuth());
const docs = () => new Docs(web());
const JSON_OPTION: Option = { name: 'json', kind: 'flag' };
const TYPES = Object.keys(DOC_TYPES) as DocType[];
const DOC_ARG = { name: 'doc', help: '文档链接(含知识库链接),或 obj_token(配合 --type)' };
const TYPE_OPTION: Option = {
  name: 'type',
  kind: 'string',
  choices: TYPES,
  default: 'docx',
  help: '给的是裸 token 时它的类型(链接自带类型)',
};
/** The document a command names: a link (wiki links are resolved to their document) or a token. */
const ref = (a: Record<string, unknown>): Promise<DocRef> =>
  new Wiki(web()).ref(String(a.doc), String(a.type ?? 'docx') as DocType);
const failures = (what: string, total: number, failed: Map<string, string>) => {
  for (const [t, why] of failed) err(`${what} ${t} 失败: ${why}`);
  out(`已${what} ${total - failed.size} 个`);
  return failed.size ? 1 : 0;
};

/** Under LARKX_OWN_DOCS_ONLY: throws unless the current account created the document. */
export function checkCreator(
  info: Pick<DocInfo, 'creatorId' | 'creatorName'>,
  selfId: string,
  permission: Permission,
): void {
  if (!selfId || info.creatorId !== selfId)
    throw new NotOwnDocument(
      permission,
      `这篇的创建者是 ${info.creatorName || info.creatorId || '未知'}`,
    );
}

const accessOf = (cmd: Command, a: Parsed): Permission =>
  typeof cmd.access === 'string' ? cmd.access : cmd.access(a);

/**
 * An edit command naming one existing document (`<doc>`): under LARKX_OWN_DOCS_ONLY the document's
 * creator is checked first. The check runs outside the command's own error handling so a refusal
 * exits 126 like any other permission refusal.
 */
function ownDocument(cmd: Command): Command {
  return {
    ...cmd,
    async run(a) {
      if (ownDocsOnly()) {
        const auth = new LarkAuth();
        checkCreator(await docs().info(await ref(a)), auth.userId, accessOf(cmd, a));
      }
      return cmd.run(a);
    },
  };
}

/**
 * An edit command whose targets can't be checked one document at a time (token lists,
 * whiteboards, a file version): refused outright under LARKX_OWN_DOCS_ONLY.
 */
function uncheckedEdit(cmd: Command, applies: (a: Parsed) => boolean = () => true): Command {
  return {
    ...cmd,
    async run(a) {
      if (ownDocsOnly() && applies(a))
        throw new NotOwnDocument(accessOf(cmd, a), '这个命令没法逐篇核对创建者');
      return cmd.run(a);
    },
  };
}

/** Runs a command body, printing an error and returning 1 when it throws. */
async function guarded(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    err(errorText(e));
    return 1;
  }
}

/** Saves a downloaded file to out (a file, or a directory to put it in; the current one by default). */
function save(file: FileData, outPath: string | undefined): string {
  const target = outPath;
  const dest =
    target && !(existsSync(target) && statSync(target).isDirectory())
      ? target
      : join(target || '.', basename(file.name) || 'download');
  writeFileSync(dest, file.data);
  return dest;
}

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
    return failures('移到回收站', tokens.length, await docs().remove(tokens));
  },
};

const rename: Command = {
  name: 'rename',
  help: '改名(文档、表格、多维表格、思维笔记、上传的文件、文件夹)',
  access: 'doc.rename',
  positionals: [DOC_ARG, { name: 'name', nargs: '+' }],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      await docs().rename(await ref(a), (a.name as string[]).join(' '));
      out('已改名');
      return 0;
    }),
};

const mv: Command = {
  name: 'mv',
  help: '把文件或文件夹(节点 token,见 ls 第一列)移进一个文件夹',
  access: 'doc.mv',
  positionals: [{ name: 'tokens', nargs: '+' }],
  options: [{ name: 'to', kind: 'string', help: '目标文件夹的节点 token;不填为我的空间' }],
  run: (a) =>
    guarded(async () => {
      const tokens = a.tokens as string[];
      return failures('移动', tokens.length, await docs().move(tokens, s(a.to)));
    }),
};

const cp: Command = {
  name: 'cp',
  help: '复制一份文档(默认放在我的空间,名字加"副本")',
  access: 'doc.cp',
  positionals: [DOC_ARG],
  options: [
    TYPE_OPTION,
    { name: 'name', kind: 'string', help: '副本的名字' },
    { name: 'folder', kind: 'string', help: '放进这个文件夹(节点 token)' },
  ],
  run: (a) =>
    guarded(async () => {
      const f = await docs().copy(await ref(a), {
        ...(a.name ? { name: String(a.name) } : {}),
        ...(a.folder ? { folder: String(a.folder) } : {}),
      });
      out(`已复制 token=${f.token} obj_token=${f.objToken}${f.url ? ` ${f.url}` : ''}`);
      return 0;
    }),
};

const trash: Command = {
  name: 'trash',
  help: '列出回收站',
  access: 'doc.trash',
  options: [JSON_OPTION],
  async run(a) {
    const files = await docs().trash();
    if (a.json) printJson(files);
    else
      for (const f of files)
        out(
          `${f.token}\t${f.type}\t${f.name}\t删于 ${shortTime(f.deleteTime)}\t${Math.floor(f.expiresIn / 86400)} 天后清除`,
        );
    return 0;
  },
};

const restore: Command = {
  name: 'restore',
  help: '从回收站恢复(节点 token,见 trash 第一列)',
  access: 'doc.restore',
  positionals: [{ name: 'tokens', nargs: '+' }],
  async run(a) {
    const tokens = a.tokens as string[];
    return failures('恢复', tokens.length, await docs().restore(tokens));
  },
};

const upload: Command = {
  name: 'upload',
  help: '上传本地文件到云空间',
  access: 'doc.upload',
  positionals: [{ name: 'path' }],
  options: [
    { name: 'folder', kind: 'string', help: '放进这个文件夹(节点 token)' },
    { name: 'name', kind: 'string', help: '云端文件名(默认用本地文件名)' },
    {
      name: 'replace',
      kind: 'string',
      help: '覆盖这个文件(链接或 file_token),作为它的新版本;Markdown 文件就这样改',
    },
  ],
  run: (a) =>
    guarded(async () => {
      const path = String(a.path);
      const f = await docs().upload(
        new Uint8Array(readFileSync(path)),
        a.name ? String(a.name) : basename(path),
        {
          ...(a.folder ? { folder: String(a.folder) } : {}),
          ...(a.replace ? { replace: docRef(String(a.replace), 'file').token } : {}),
        },
      );
      out(
        a.replace
          ? `已覆盖 file_token=${f.objToken}`
          : `已上传 token=${f.token} file_token=${f.objToken}`,
      );
      return 0;
    }),
};

const cat: Command = {
  name: 'cat',
  help: '把云空间里的文本文件(如 Markdown 文件)原样输出',
  access: 'doc.cat',
  positionals: [{ name: 'file', help: '文件链接或 file_token' }],
  run: (a) =>
    guarded(async () => {
      write((await docs().download(docRef(String(a.file), 'file').token)).data);
      return 0;
    }),
};

const diff: Command = {
  name: 'diff',
  help: '比较云空间里的文本文件(如 Markdown 文件)和本地文件,按 diff -u 的格式输出差异;有差异时退出码为 1',
  access: 'doc.diff',
  positionals: [
    { name: 'file', help: '文件链接或 file_token' },
    { name: 'local', help: '本地文件' },
  ],
  run: (a) =>
    guarded(async () => {
      const remote = await docs().download(docRef(String(a.file), 'file').token);
      const text = unifiedDiff(
        new TextDecoder().decode(remote.data),
        readFileSync(String(a.local), 'utf8'),
        { fromName: `云端 ${remote.name}`, toName: String(a.local) },
      );
      if (!text) return 0;
      out(text);
      return 1;
    }),
};

const OUT_OPTION: Option = {
  name: 'out',
  short: '-o',
  kind: 'string',
  help: '保存路径(文件或目录;默认当前目录,用云端的文件名)',
};

const download: Command = {
  name: 'download',
  help: '下载云空间里上传的文件(在线文档用 export)',
  access: 'doc.download',
  positionals: [{ name: 'file', help: '文件链接或 file_token' }],
  options: [OUT_OPTION],
  run: (a) =>
    guarded(async () => {
      out(`已保存 ${save(await docs().download(docRef(String(a.file), 'file').token), s(a.out))}`);
      return 0;
    }),
};

const exportCmd: Command = {
  name: 'export',
  help: `把在线文档导出成文件(${Object.entries(EXPORT_FORMATS)
    .map(([t, f]) => `${t}: ${f.join('/')}`)
    .join(';')})`,
  access: 'doc.export',
  positionals: [DOC_ARG],
  options: [
    TYPE_OPTION,
    { name: 'format', kind: 'string', help: '导出格式(默认每种类型的第一个)' },
    OUT_OPTION,
  ],
  run: (a) =>
    guarded(async () => {
      const file = await docs().export(await ref(a), a.format ? { format: String(a.format) } : {});
      out(`已保存 ${save(file, s(a.out))}`);
      return 0;
    }),
};

const comments: Command = {
  name: 'comments',
  help: '列出文档的评论(未解决的在前)',
  access: 'doc.comments',
  positionals: [DOC_ARG],
  options: [TYPE_OPTION, JSON_OPTION],
  async run(a) {
    const list = await new DocComments(web()).list(await ref(a));
    if (a.json) {
      printJson(list);
      return 0;
    }
    for (const c of list) {
      const tag = [c.whole ? '全文' : `「${c.quote}」`, c.solved ? '已解决' : ''].filter(Boolean);
      out(`${c.id}\t${tag.join(' ')}`);
      for (const r of c.replies) out(`  ${shortTime(r.createTime)} ${r.name}: ${r.content}`);
    }
    return 0;
  },
};

const comment: Command = {
  name: 'comment',
  help: '给文档加一条评论(默认是全文评论;--quote 评论 docx 里的一段文字)',
  access: 'doc.comment',
  positionals: [DOC_ARG, { name: 'text', nargs: '+' }],
  options: [
    TYPE_OPTION,
    { name: 'quote', kind: 'string', help: '评论这段文字(docx 里第一次出现的位置)' },
  ],
  run: (a) =>
    guarded(async () => {
      const c = await new DocComments(web()).add(
        await ref(a),
        (a.text as string[]).join(' '),
        a.quote === undefined ? {} : { quote: String(a.quote) },
      );
      out(`已评论 comment_id=${c.id}`);
      return 0;
    }),
};

const reply: Command = {
  name: 'reply',
  help: '回复一条评论',
  access: 'doc.reply',
  positionals: [DOC_ARG, { name: 'comment_id' }, { name: 'text', nargs: '+' }],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      const r = await new DocComments(web()).reply(
        await ref(a),
        String(a.comment_id),
        (a.text as string[]).join(' '),
      );
      out(`已回复 reply_id=${r.id}`);
      return 0;
    }),
};

const resolve: Command = {
  name: 'resolve',
  help: '把评论标为已解决(--reopen 重新打开)',
  access: 'doc.resolve',
  positionals: [DOC_ARG, { name: 'comment_id' }],
  options: [TYPE_OPTION, { name: 'reopen', kind: 'flag', help: '重新打开' }],
  run: (a) =>
    guarded(async () => {
      await new DocComments(web()).resolve(await ref(a), String(a.comment_id), !a.reopen);
      out(a.reopen ? '已重新打开' : '已解决');
      return 0;
    }),
};

const commentRm: Command = {
  name: 'comment-rm',
  help: '删除一条评论(连同回复)',
  access: 'doc.comment-rm',
  positionals: [DOC_ARG, { name: 'comment_id' }],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      await new DocComments(web()).remove(await ref(a), String(a.comment_id));
      out('已删除');
      return 0;
    }),
};

const sharing: Command = {
  name: 'sharing',
  help: '查看文档的链接分享范围和协作者',
  access: 'doc.sharing',
  positionals: [DOC_ARG],
  options: [TYPE_OPTION, JSON_OPTION],
  async run(a) {
    const perms = new DocPermissions(web());
    const r = await ref(a);
    const [settings, people] = [await perms.sharing(r), await perms.collaborators(r)];
    if (a.json) {
      printJson({ ...settings, collaborators: people });
      return 0;
    }
    out(`链接分享: ${settings.linkShare}${settings.externalAccess ? '(允许组织外)' : ''}`);
    for (const p of people) out(`${p.id}\t${p.kind}\t${p.name}${p.owner ? '\t所有者' : ''}`);
    return 0;
  },
};

const setLink: Command = {
  name: 'set-link',
  help: '修改谁能凭链接打开文档',
  access: 'doc.set-link',
  positionals: [DOC_ARG, { name: 'scope', choices: Object.keys(LINK_SHARE) }],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      await new DocPermissions(web()).setLinkShare(await ref(a), String(a.scope) as LinkShare);
      out(`链接分享已改为 ${String(a.scope)}`);
      return 0;
    }),
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

/** Markdown from --file, the text arguments, or stdin (in that order). */
async function markdownInput(a: Record<string, unknown>): Promise<string> {
  if (a.file) return readFileSync(String(a.file), 'utf8');
  const text = (a.text as string[] | undefined) ?? [];
  if (text.length) return text.join(' ');
  return await new Response(Bun.stdin.stream()).text();
}

/** Relative image paths start next to the --file Markdown (else in the current directory). */
const imageBase = (a: Record<string, unknown>) =>
  a.file ? { baseDir: dirname(String(a.file)) } : {};

const EDIT_INPUT = {
  positionals: [
    DOC_ARG,
    {
      name: 'text',
      nargs: '*' as const,
      help: 'Markdown 文本(以 - 开头时前面加 --);不给时读 --file 或标准输入',
    },
  ],
  options: [{ name: 'file', kind: 'string' as const, help: '从这个 Markdown 文件读' }],
};

const append: Command = {
  name: 'append',
  help: '在 docx 末尾追加 Markdown(标题、段落、列表、待办、引用、代码、分割线、表格、单独成行的图片、行内样式和链接);给思维笔记追加 Markdown 大纲作为主题',
  access: 'doc.append',
  ...EDIT_INPUT,
  options: [
    ...EDIT_INPUT.options,
    TYPE_OPTION,
    {
      name: 'under',
      kind: 'string',
      help: '思维笔记:加在文字为这个的主题下面(默认加在最外层末尾)',
    },
  ],
  run: (a) =>
    guarded(async () => {
      const r = await ref(a);
      if (r.type === 'mindnote') {
        const n = await new MindnoteEditor(web()).append(
          r.token,
          await markdownInput(a),
          a.under === undefined ? {} : { under: String(a.under) },
        );
        out(`已追加 ${n} 个主题`);
        return 0;
      }
      if (a.under !== undefined) throw new Error('--under 只用于思维笔记');
      const n = await new DocEditor(web()).append(r.token, await markdownInput(a), imageBase(a));
      out(`已追加 ${n} 块`);
      return 0;
    }),
};

const attach: Command = {
  name: 'attach',
  help: '把本地文件作为附件追加到 docx 末尾',
  access: 'doc.attach',
  positionals: [DOC_ARG, { name: 'paths', nargs: '+', help: '本地文件' }],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      const files = (a.paths as string[]).map((p) => {
        if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`不是文件: ${p}`);
        return { data: new Uint8Array(readFileSync(p)), name: basename(p) };
      });
      const n = await new DocEditor(web()).attach((await ref(a)).token, files);
      out(`已添加 ${n} 个附件`);
      return 0;
    }),
};

const SLIDES_ARG = {
  name: 'doc',
  help: '幻灯片链接(含知识库链接),或 obj_token(配合 --type slides)',
};

const slideCp: Command = {
  name: 'slide-cp',
  help: '复制幻灯片的一页(连同备注),默认放到最后',
  access: 'doc.slide-cp',
  positionals: [SLIDES_ARG, { name: 'page', help: '要复制的页(从 1 开始)' }],
  options: [TYPE_OPTION, { name: 'at', kind: 'int', help: '放到第几页(默认最后)' }],
  run: (a) =>
    guarded(async () => {
      const at = await new SlidesEditor(web()).copyPage(
        (await ref(a)).token,
        Number(a.page),
        a.at === undefined ? {} : { at: Number(a.at) },
      );
      out(`已复制到第 ${at} 页`);
      return 0;
    }),
};

const slideRm: Command = {
  name: 'slide-rm',
  help: '删除幻灯片的页(可在历史记录里找回)',
  access: 'doc.slide-rm',
  positionals: [SLIDES_ARG, { name: 'pages', nargs: '+', help: '页码(从 1 开始)' }],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      const n = await new SlidesEditor(web()).removePages(
        (await ref(a)).token,
        (a.pages as string[]).map(Number),
      );
      out(`已删除 ${n} 页`);
      return 0;
    }),
};

const whiteboard: Command = {
  name: 'whiteboard',
  help: '列出画板上的节点:id、文字、位置和大小(画板 token 见 fetch 输出里的 [画板](token))',
  access: 'doc.whiteboard',
  positionals: [{ name: 'token', help: '画板 token' }],
  options: [JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const nodes = await docs().whiteboard(String(a.token));
      if (a.json) {
        printJson(nodes);
        return 0;
      }
      for (const n of nodes) out(`${n.id}\t${n.text}\t(${n.x}, ${n.y}) ${n.width}×${n.height}`);
      return 0;
    }),
};

const whiteboardImage: Command = {
  name: 'whiteboard-image',
  help: '下载画板的预览图(服务端渲染,与文档里显示的一致)',
  access: 'doc.whiteboard-image',
  positionals: [{ name: 'token', help: '画板 token' }],
  options: [OUT_OPTION],
  run: (a) =>
    guarded(async () => {
      out(`已保存 ${save(await docs().whiteboardImage(String(a.token)), s(a.out))}`);
      return 0;
    }),
};

const WB_TOKEN = { name: 'token', help: '画板 token' };
const BOX_OPTIONS: Option[] = [
  { name: 'x', kind: 'int', help: '左上角 x' },
  { name: 'y', kind: 'int', help: '左上角 y' },
  { name: 'width', kind: 'int' },
  { name: 'height', kind: 'int' },
];
const boxOf = (a: Record<string, unknown>) =>
  Object.fromEntries(
    (['x', 'y', 'width', 'height'] as const)
      .filter((k) => a[k] !== undefined)
      .map((k) => [k, Number(a[k])]),
  );

const whiteboardAdd: Command = {
  name: 'whiteboard-add',
  help: '在画板上加一个带文字的矩形(默认 120×80,放在 0,0)',
  access: 'doc.whiteboard-add',
  positionals: [WB_TOKEN, { name: 'text', nargs: '+' }],
  options: BOX_OPTIONS,
  run: (a) =>
    guarded(async () => {
      const id = await new WhiteboardEditor(web()).addShape(
        String(a.token),
        (a.text as string[]).join(' '),
        boxOf(a),
      );
      out(`已添加 node_id=${id}`);
      return 0;
    }),
};

const whiteboardText: Command = {
  name: 'whiteboard-text',
  help: '改画板上一个节点的文字',
  access: 'doc.whiteboard-text',
  positionals: [WB_TOKEN, { name: 'node_id' }, { name: 'text', nargs: '+' }],
  run: (a) =>
    guarded(async () => {
      await new WhiteboardEditor(web()).setText(
        String(a.token),
        String(a.node_id),
        (a.text as string[]).join(' '),
      );
      out('已修改');
      return 0;
    }),
};

const whiteboardMove: Command = {
  name: 'whiteboard-move',
  help: '移动画板上的节点或改大小(没给的保持不变)',
  access: 'doc.whiteboard-move',
  positionals: [WB_TOKEN, { name: 'node_id' }],
  options: BOX_OPTIONS,
  run: (a) =>
    guarded(async () => {
      await new WhiteboardEditor(web()).move(String(a.token), String(a.node_id), boxOf(a));
      out('已修改');
      return 0;
    }),
};

const whiteboardRm: Command = {
  name: 'whiteboard-rm',
  help: '删除画板上的节点',
  access: 'doc.whiteboard-rm',
  positionals: [WB_TOKEN, { name: 'node_ids', nargs: '+' }],
  run: (a) =>
    guarded(async () => {
      const n = await new WhiteboardEditor(web()).remove(String(a.token), a.node_ids as string[]);
      out(`已删除 ${n} 个节点`);
      return 0;
    }),
};

const writeDoc: Command = {
  name: 'write',
  help: '用 Markdown 替换 docx 的正文(标题保留)',
  access: 'doc.write',
  ...EDIT_INPUT,
  run: (a) =>
    guarded(async () => {
      const r = await ref(a);
      const n = await new DocEditor(web()).overwrite(r.token, await markdownInput(a), imageBase(a));
      out(`已写入 ${n} 块`);
      return 0;
    }),
};

const replace: Command = {
  name: 'replace',
  help: '在 docx 或幻灯片里查找替换文字(保留原格式)',
  access: 'doc.replace',
  positionals: [DOC_ARG, { name: 'find' }, { name: 'replacement' }],
  options: [TYPE_OPTION, { name: 'page', kind: 'int', help: '幻灯片:只替换这一页(从 1 开始)' }],
  run: (a) =>
    guarded(async () => {
      const d = await ref(a);
      const find = String(a.find);
      const replacement = String(a.replacement);
      if (d.type !== 'slides' && a.page !== undefined) throw new Error('--page 只用于幻灯片');
      const r =
        d.type === 'slides'
          ? await new SlidesEditor(web()).replace(
              d.token,
              find,
              replacement,
              a.page === undefined ? {} : { page: Number(a.page) },
            )
          : await new DocEditor(web()).replace(d.token, find, replacement);
      out(
        `已替换 ${r.replaced} 处(${r.blocks} 个块)${r.skipped ? `,跳过 ${r.skipped} 个无法处理的块` : ''}`,
      );
      return r.replaced ? 0 : 1;
    }),
};

const fetch: Command = {
  name: 'fetch',
  help: '读文档,输出 Markdown(docx 全文;思维笔记为大纲列表;幻灯片按页列出文字)',
  access: 'doc.fetch',
  positionals: [DOC_ARG],
  options: [TYPE_OPTION, JSON_OPTION],
  async run(a) {
    const d = await docs().read(await ref(a));
    if (a.json) printJson(d);
    else write(d.markdown);
    return 0;
  },
};

/** The docx a history command names; other types have no history API here. */
const docxRef = async (a: Record<string, unknown>): Promise<string> => {
  const r = await ref(a);
  if (r.type !== 'docx') throw new Error(`历史记录只支持 docx,这是 ${r.type}`);
  return r.token;
};
const VERSION_ARG = { name: 'version', help: '历史记录的版本号(见 history)' };
const KIND_TEXT: Record<DocVersion['kind'], string> = {
  created: '新建',
  edited: '编辑',
  restored: '还原',
  other: '其他',
};

const history: Command = {
  name: 'history',
  help: '列出 docx 的历史记录(新的在前):版本号、时间、类型、编辑者',
  access: 'doc.history',
  positionals: [DOC_ARG],
  options: [TYPE_OPTION, { name: 'limit', kind: 'int', default: 50 }, JSON_OPTION],
  run: (a) =>
    guarded(async () => {
      const list = await new DocHistory(web()).list(await docxRef(a), Number(a.limit));
      if (a.json) {
        printJson(list);
        return 0;
      }
      for (const v of list) {
        const kind =
          v.restoredFrom === undefined
            ? KIND_TEXT[v.kind]
            : `${KIND_TEXT[v.kind]}到 ${shortTime(v.restoredFrom)} 的状态`;
        out([v.version, shortTime(v.time), kind, v.editors.join(','), v.name].join('\t').trimEnd());
      }
      return 0;
    }),
};

const historyFetch: Command = {
  name: 'history-fetch',
  help: '读 docx 在某条历史记录时的内容,输出 Markdown',
  access: 'doc.history-fetch',
  positionals: [DOC_ARG, VERSION_ARG],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      write(await new DocHistory(web()).markdown(await docxRef(a), Number(a.version)));
      return 0;
    }),
};

const revert: Command = {
  name: 'revert',
  help: '把 docx 还原到某条历史记录(还原本身也会记一条历史,可再还原回来)',
  access: 'doc.revert',
  positionals: [DOC_ARG, VERSION_ARG],
  options: [TYPE_OPTION],
  run: (a) =>
    guarded(async () => {
      await new DocHistory(web()).revert(await docxRef(a), Number(a.version));
      out('已还原');
      return 0;
    }),
};

export const doc: CommandGroup = {
  name: 'doc',
  help: '云文档与云盘:搜索、列目录、新建、导入导出、上传下载、改名移动复制、回收站、读正文(Markdown)、编辑、历史记录、评论、分享',
  subcommands: [
    search,
    ls,
    create,
    importCmd,
    uncheckedEdit(rm),
    fetch,
    whiteboard,
    whiteboardImage,
    uncheckedEdit(whiteboardAdd),
    uncheckedEdit(whiteboardText),
    uncheckedEdit(whiteboardMove),
    uncheckedEdit(whiteboardRm),
    ownDocument(append),
    ownDocument(attach),
    ownDocument(writeDoc),
    ownDocument(replace),
    ownDocument(slideCp),
    ownDocument(slideRm),
    history,
    historyFetch,
    ownDocument(revert),
    ownDocument(rename),
    uncheckedEdit(mv),
    cp,
    trash,
    restore,
    uncheckedEdit(upload, (a) => Boolean(a.replace)),
    download,
    cat,
    diff,
    exportCmd,
    comments,
    comment,
    reply,
    ownDocument(resolve),
    ownDocument(commentRm),
    sharing,
    ownDocument(setLink),
  ],
};
