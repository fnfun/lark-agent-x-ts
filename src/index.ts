// Library entry point: exports only what runs under both Node and Bun (login credentials, gateway
// client, message long-lived connection, resource download).
// The message database (Bun.SQL) and the local agent (Bun.spawn) depend on Bun and are used only by
// the CLI; see docs/compat.md.
export { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from './auth.js';
export {
  ATTACHMENT_TYPES,
  type AttachmentType,
  type BotHit,
  type BotSearchOptions,
  type ChatHit,
  type ChatInfo,
  type ChatMember,
  type ChatSearchOptions,
  type ChatSummary,
  type ClientOptions,
  chatterName,
  type FeedGroup,
  type FlagItem,
  type JoinRequest,
  LarkClient,
  type MessageContent,
  type MessageHandler,
  type MessageHit,
  type MessageReactions,
  type MessageSearchOptions,
  type PinnedMessage,
  type PostType,
  type ProfileField,
  type ReactionHandler,
  type ReadState,
  type RecentChat,
  type ScheduledMessage,
  type SenderType,
  type SendOptions,
  SendUnconfirmed,
  type UnreadChat,
  type UserHit,
  type UserProfile,
  type UserSearchOptions,
} from './client.js';
export {
  Base,
  type BaseField,
  type BaseRecord,
  type BaseTable,
  type BaseView,
  type CellInput,
  FIELD_TYPES,
  type FieldType,
  type SelectOption,
} from './domains/base.js';
export {
  Calendar,
  type CalendarEvent,
  type CalendarInfo,
  type EventUpdate,
  type NewEvent,
} from './domains/calendar.js';
export {
  type CommentReply,
  type DocComment,
  DocComments,
} from './domains/doc-comments.js';
export { type AppendOptions, DocEditor, type ImageFile } from './domains/doc-edit.js';
export { DocHistory, type DocVersion } from './domains/doc-history.js';
export {
  type Collaborator,
  DocPermissions,
  LINK_SHARE,
  type LinkShare,
  type Sharing,
} from './domains/doc-permissions.js';
export {
  DOC_TYPES,
  type DocContent,
  type DocHit,
  type DocRef,
  Docs,
  type DocType,
  type DriveFile,
  docRef,
  docToken,
  EXPORT_FORMATS,
  type FileData,
  IMPORTABLE,
  type TrashedFile,
} from './domains/docs.js';
export { attributedText, docxToMarkdown } from './domains/docx-markdown.js';
export { type BlockSpec, parseMarkdown } from './domains/markdown-docx.js';
export { MindnoteEditor } from './domains/mindnote.js';
export { columnName, Sheets, type SheetTab } from './domains/sheet.js';
export {
  type NewTask,
  type Task,
  type TaskComment,
  type TaskList,
  Tasks,
  type TaskUpdate,
} from './domains/task.js';
export { Wiki, type WikiNode, type WikiSpace, wikiToken } from './domains/wiki.js';
export { type CellValue, cellIndex, readXlsx, type XlsxSheet } from './domains/xlsx.js';
export { HttpError, NetworkError } from './http.js';
export { type Level, type LogSink, setLogLevel, setLogSink } from './log.js';
export {
  downloadMessageResource,
  extractResourceKey,
  mp4DurationMs,
  oggOpusDurationMs,
  type UploadedFile,
  uploadFile,
  uploadImage,
} from './media.js';
export {
  decide,
  type EffectiveRules,
  GROUPS,
  type Group,
  loadRules,
  PERMISSIONS,
  type Permission,
  PermissionDenied,
  type PermissionSource,
  permissionsPath,
  type Rules,
  saveAccountRules,
  type Verdict,
} from './permissions.js';
export type {
  EditableContent,
  MarkdownPart,
  RichBlock,
  RichRun,
  SearchHit,
} from './proto/builders.js';
export { contentDataJson, type LarkMessage, type ReactionEvent } from './proto/decoders.js';
export type { Dict } from './proto/dict.js';
export { getRegion, REGIONS, type Region } from './region.js';
export { type WebRequest, WebSession } from './web.js';
