import { parseArgs } from 'node:util';
import { type AgentBackend, getBackend } from '../src/agent/backend.js';
import { AgentDispatcher, type AgentMessage, buildXmlMessage } from '../src/agent/dispatcher.js';

/**
 * 数字人链路演示（迁移自 fork 版 dev/demo_agent_flow.py、demo_pipe_flow.py）：两条样例消息
 * （明确要求回复 / 纯寒暄）交给 agent，打印喂给它的完整提示词。
 * 默认只打印不调用；`--live` 时交给真实后端（Claude Code 会自己决定是否执行 `lark send` 回到 --chat 指定的会话）。
 *
 *   bun scripts/demo-agent.ts --chat <chat_id> [--live]
 */
const { values } = parseArgs({
  options: { chat: { type: 'string' }, live: { type: 'boolean', default: false } },
});
if (!values.chat) {
  console.error('用法: bun scripts/demo-agent.ts --chat <chat_id> [--live]');
  process.exit(2);
}

const base: AgentMessage = {
  msg_id: '7666600000000000001',
  msg_type: 4,
  msg_type_name: 'TEXT',
  from_id: '7314999000000000001',
  chat_id: values.chat,
  chat_type: 1,
  chat_type_name: 'P2P',
  scope: 'chat',
  anchor: '',
  at_me: false,
  root_id: '',
  parent_id: '',
  cid: '',
  position: 1,
  create_time: 1785003200,
  content: '在吗?帮我验证下数字人链路:收到这条后回我一句"链路正常"就行',
  content_data: null,
  _chat_name: '演示会话',
  _sender_name: '同事甲',
};
const cases: [string, AgentMessage][] = [
  ['案例 1: 明确要求回复', base],
  [
    '案例 2: 纯寒暄(不该回)',
    { ...base, msg_id: '7666600000000000002', content: '周末愉快呀~ 好好休息😄' },
  ],
];

/** 记下每次喂给 agent 的提示词；非 --live 时不调用真实后端。 */
class SpyBackend implements AgentBackend {
  readonly name = 'spy';
  readonly prompts: string[] = [];
  constructor(private readonly inner: AgentBackend | null) {}
  async run(key: string, prompt: string, chatId?: string, anchor?: string): Promise<string> {
    this.prompts.push(prompt);
    return this.inner ? this.inner.run(key, prompt, chatId, anchor) : '';
  }
  async resetSession(key: string): Promise<void> {
    await this.inner?.resetSession(key);
  }
}

const backend = new SpyBackend(values.live ? await getBackend() : null);
const dispatcher = new AgentDispatcher(backend, async (_chatId, text) => {
  console.log('>>> reply_fn 被调用(agent 应自己执行 lark send,不该走到这里):', text);
});
for (const [title, msg] of cases) {
  console.log(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
  console.log(buildXmlMessage(msg));
  console.log('-'.repeat(60));
  await dispatcher.handleMessage('demo:final', msg);
  console.log();
}
console.log(`${'='.repeat(20)} 喂给 agent 的完整提示词(案例 1) ${'='.repeat(20)}`);
console.log(backend.prompts[0]);
