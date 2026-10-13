import { AuthExpired } from '../auth.js';
import type { LarkClient, ReactionHandler } from '../client.js';
import { getLogger } from '../log.js';
import type { LarkMessage } from '../proto/decoders.js';
import { errorText } from './format.js';

const logger = getLogger('larkx.cli');

export interface ListenLoopOptions {
  /** 补收 since（毫秒）之后、没经长连接收到的消息。 */
  missed: (since: number) => Promise<LarkMessage[]>;
  /** 表情变化（可选）。 */
  onReaction?: ReactionHandler;
  /** 断线后多久重连，默认 10 秒。 */
  retryMs?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * 常驻接收：断线后重连，重新连上时补收断线期间的消息。
 * 推送与补收共用一条队列串行交给 onMessage：同一条消息两边都到时，入库去重不会撞上并发插入。
 * 凭证失效（AuthExpired）抛出；signal 中止时返回。
 */
export async function keepListening(
  c: LarkClient,
  onMessage: (msg: LarkMessage) => Promise<void>,
  o: ListenLoopOptions,
): Promise<void> {
  let queue = Promise.resolve();
  const enqueue = (msg: LarkMessage) => {
    queue = queue
      .then(() => onMessage(msg))
      .catch((e) => logger.error(`处理消息异常: ${errorText(e)}`));
    return queue;
  };
  const backfill = async (since: number) => {
    try {
      const missed = await o.missed(since);
      for (const msg of missed) await enqueue(msg);
      if (missed.length) logger.info(`补收断线期间的消息 ${missed.length} 条(已收到的会去重)`);
    } catch (e) {
      logger.warning(`补收断线期间的消息失败: ${errorText(e)}`);
    }
  };
  // 断线时刻往前留一个心跳超时：连接可能在被发现之前就已经断了
  let disconnectedAt: number | undefined;
  let pending = Promise.resolve();
  const onOpen = () => {
    if (disconnectedAt === undefined) return;
    const since = disconnectedAt;
    disconnectedAt = undefined;
    pending = backfill(since);
  };
  while (!o.signal?.aborted) {
    try {
      await c.connectWebsocket(enqueue, o.signal, onOpen, o.onReaction);
      if (o.signal?.aborted) break;
      logger.warning('WS 连接被关闭,重连');
    } catch (e) {
      if (e instanceof AuthExpired) throw e;
      logger.warning(`WS 断开,${(o.retryMs ?? 10_000) / 1000}s 后重连: ${(e as Error).message}`);
    }
    disconnectedAt ??= Date.now() - c.wsTiming.idleTimeoutMs;
    await sleep(o.retryMs ?? 10_000, o.signal);
  }
  await pending;
  await queue;
}
