/** Bump when a message shape or method contract changes incompatibly. */
export const PROTOCOL_VERSION = 2;

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
  ConsoleKind,
  ConsoleLevel,
  ConsoleMessage,
  DragMode,
  FillOutcome,
  FillResult,
  FillValue,
  KeyAction,
  MethodName,
  Methods,
  NavigateAction,
  NetworkHeader,
  NetworkRequest,
  PageText,
  PageTextSource,
  Params,
  ProbeCheck,
  ProbeCheckName,
  ProbeOutcome,
  ProbeResult,
  Recipe,
  RecipeFields,
  RecipeSummary,
  Request,
  Result,
  ScrollDirection,
  TabInfo,
  TypeMethod,
  TypeOutcome,
} from "./methods.ts";
export {
  CONSOLE_KINDS,
  CONSOLE_LEVELS,
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_PAGE_TEXT_CHARS,
  DEFAULT_WAIT_FOR_MS,
  DOWNLOAD_MAX_BYTES,
  FILL_START_LIMIT_MS,
  fillChars,
  MAX_CONSOLE_MESSAGES,
  MAX_CONSOLE_TEXT,
  MAX_FILL_CHARS,
  MAX_FILL_FIELDS,
  MAX_NETWORK_HEADER,
  MAX_NETWORK_HEADERS,
  MAX_NETWORK_PATTERN,
  MAX_NETWORK_REQUESTS,
  MAX_NETWORK_URL,
  MAX_PAGE_TEXT_CHARS,
  MAX_RECIPE_DESCRIPTION,
  MAX_RECIPE_NAME,
  MAX_RECIPE_SITES,
  MAX_RECIPE_STEPS,
  MAX_RECIPES,
  MAX_TYPE_CHARS,
  MAX_WAIT_FOR_MS,
  MAX_WAIT_FOR_TEXT,
  MAX_WINDOW_SIZE,
  METHOD_NAMES,
  MIN_WAIT_FOR_MS,
  MIN_WINDOW_SIZE,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
} from "./methods.ts";
