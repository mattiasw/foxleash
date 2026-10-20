/** Bump when a message shape or method contract changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** The native messaging host name, as registered with Firefox. */
export const NATIVE_HOST_NAME = "foxhand";

/** The extension's add-on ID; the native host manifest allows only this one. */
export const EXTENSION_ID = "foxhand@mattiasw.com";

export type { Part, PartInfo } from "./handshake.ts";
export { protocolMismatch } from "./handshake.ts";
export type {
  ExtensionStatus,
  HelloMessage,
  Message,
  ParseResult,
  RequestMessage,
  ResponseError,
  ResponseMessage,
  Role,
  SessionEndMessage,
  WelcomeMessage,
} from "./messages.ts";
export { parseMessage } from "./messages.ts";
export type {
  ClickButton,
  DragMode,
  MethodName,
  Methods,
  NavigateAction,
  PageText,
  PageTextSource,
  Params,
  ProbeCheck,
  ProbeCheckName,
  ProbeOutcome,
  ProbeResult,
  Request,
  Result,
  ScrollDirection,
  TabInfo,
} from "./methods.ts";
export {
  DEFAULT_PAGE_TEXT_CHARS,
  MAX_PAGE_TEXT_CHARS,
  METHOD_NAMES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
} from "./methods.ts";
