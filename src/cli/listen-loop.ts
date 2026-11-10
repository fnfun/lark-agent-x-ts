import { AuthExpired } from '../auth.js';
import type { LarkClient, ReactionHandler } from '../client.js';
import { getLogger } from '../log.js';
import type { LarkMessage } from '../proto/decoders.js';
import { errorText } from './format.js';

const logger = getLogger('larkx.cli');

export interface ListenLoopOptions {
  /** Backfills messages after since (ms) that did not arrive over the long-lived connection. */
  missed: (since: number) => Promise<LarkMessage[]>;
  /** Reaction changes (optional). */
  onReaction?: ReactionHandler;
  /** Delay before reconnecting after a disconnect; defaults to 10 seconds. */
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
 * Long-running receive: reconnects after a disconnect and, once reconnected, backfills the messages
 * from the disconnected period.
 * Pushes and backfill share one queue that hands messages to onMessage serially: when the same
 * message arrives both ways, deduplication on save never runs into concurrent inserts.
 * Throws on expired credentials (AuthExpired); returns when signal aborts.
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
  // Back the disconnect time off by one heartbeat timeout: the connection may have dropped
  // before it was noticed
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
