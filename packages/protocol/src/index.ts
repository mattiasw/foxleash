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
  MethodName,
  Methods,
  NavigateAction,
  Params,
  Request,
  Result,
  TabInfo,
} from "./methods.ts";
export { METHOD_NAMES } from "./methods.ts";
