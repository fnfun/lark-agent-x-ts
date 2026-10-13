// 库入口：只导出 Node 与 Bun 都能运行的部分（登录凭证、网关客户端、消息长连接、资源下载）。
// 消息库（Bun.SQL）与本地 agent（Bun.spawn）依赖 Bun，只在 CLI 里用，见 docs/compat.md。
export { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from './auth.js';
export {
  type ChatMember,
  chatterName,
  type FlagItem,
  LarkClient,
  type MessageContent,
  type MessageHandler,
  type MessageHit,
  type MessageReactions,
  type MessageSearchOptions,
  type ReactionHandler,
  type ReadState,
  type RecentChat,
  type SendOptions,
  SendUnconfirmed,
  type UnreadChat,
} from './client.js';
export { HttpError, NetworkError } from './http.js';
export { type Level, type LogSink, setLogLevel, setLogSink } from './log.js';
export {
  downloadMessageResource,
  extractResourceKey,
  type UploadedFile,
  uploadFile,
  uploadImage,
} from './media.js';
export type { EditableContent, RichBlock, RichRun, SearchHit } from './proto/builders.js';
export { contentDataJson, type LarkMessage, type ReactionEvent } from './proto/decoders.js';
export type { Dict } from './proto/dict.js';
export { getRegion, REGIONS, type Region } from './region.js';
