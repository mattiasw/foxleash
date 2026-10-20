export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export type NavigateAction = "back" | "forward" | "reload";

export type ClickButton = "left" | "right";

export type ScrollDirection = "up" | "down" | "left" | "right";

/** How drag moved the element: HTML drag-and-drop events, or pointer and mouse events only. */
export type DragMode = "html5" | "pointer";

/** An element by ref from read_page, or a point in the viewport in CSS pixels. */
type Target = { ref: string; x?: never; y?: never } | { x: number; y: number; ref?: never };

/** Where drag ends: an element by ref, or a point in the viewport in CSS pixels. */
type DragEnd =
  | { targetRef: string; targetX?: never; targetY?: never }
  | { targetX: number; targetY: number; targetRef?: never };

export type ProbeCheckName =
  | "click_button"
  | "click_link"
  | "type_input"
  | "type_contenteditable"
  | "type_rich_editor"
  | "enter_in_form"
  | "tab_focus";

export type ProbeOutcome = "worked" | "no_effect" | "no_target" | "unknown" | "error";

export interface ProbeCheck {
  check: ProbeCheckName;
  target: "probe" | "site";
  /** Built from tag, type, role, editor kind and at most three class names; never page text. */
  element?: string;
  strategy: string;
  outcome: ProbeOutcome;
  /** A probe listener at window capture saw the event the strategy dispatched or caused. */
  delivered: boolean;
  /** Delivered, yet no effect: an effect only trusted input produces, or the page ignored it. */
  trustedOnly: boolean;
  detail: string;
}

export interface ProbeResult {
  userAgent: string;
  checks: ProbeCheck[];
}

/** get_page_text's cut when the request gives none. */
export const DEFAULT_PAGE_TEXT_CHARS = 50_000;
/**
 * The largest cut get_page_text accepts: the reply stays under the background's cap of 2,000,000
 * characters as JSON even when every character escapes to six.
 */
export const MAX_PAGE_TEXT_CHARS = 200_000;

/** Where get_page_text found the main content; `body` when the whole page is the main content. */
export type PageTextSource = "main" | "role_main" | "article" | "largest_block" | "body";

export interface PageText {
  source: PageTextSource;
  main: string;
  rest: string;
  /** True when main or rest was cut. */
  truncated: boolean;
  /** The length, in UTF-16 units, of main plus rest after tidying and before the cut. */
  totalChars: number;
}

export const CONSOLE_LEVELS = ["debug", "log", "info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const CONSOLE_KINDS = ["console", "uncaught_error", "unhandled_rejection"] as const;
export type ConsoleKind = (typeof CONSOLE_KINDS)[number];

/** One message a page wrote; `time` is ms since the epoch, when Foxhand's recorder saw it. */
export interface ConsoleMessage {
  level: ConsoleLevel;
  kind: ConsoleKind;
  text: string;
  time: number;
}

/** The most messages a page keeps; older ones are dropped and counted. */
export const MAX_CONSOLE_MESSAGES = 300;
/**
 * A message's text is cut to this many UTF-16 units. With MAX_CONSOLE_MESSAGES, the reply stays
 * under the background's cap of 2,000,000 characters as JSON even when every character escapes
 * to six.
 */
export const MAX_CONSOLE_TEXT = 1000;

/** The most bytes upload_file takes in one call, across all its files. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** The most bytes one upload_chunk carries: its base64 and envelope stay under 1 MB. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

export interface Methods {
  tabs_list: { params: Record<string, never>; result: { tabs: TabInfo[] } };
  tab_open: { params: { url?: string }; result: { tab: TabInfo } };
  navigate: {
    params:
      | { tabId: number; url: string; action?: never }
      | { tabId: number; action: NavigateAction; url?: never };
    result: { tab: TabInfo };
  };
  read_page: {
    params: { tabId: number; filter?: "all" | "interactive"; depth?: number; ref?: string };
    result: { tree: string; truncated: boolean };
  };
  get_page_text: { params: { tabId: number; maxChars?: number }; result: PageText };
  /** `data` is the base64 PNG, without a `data:` prefix. */
  screenshot: { params: { tabId: number; ref?: string }; result: { data: string } };
  /** Not an MCP tool: `upload_file` sends the files' bytes with it first. `data` is base64. */
  upload_chunk: {
    params: { upload: string; index: number; data: string };
    result: { received: number };
  };
  /** The files' sizes split the bytes staged for `upload`, in order, and add up to all of them. */
  upload_file: {
    params: {
      tabId: number;
      ref: string;
      upload: string;
      files: { name: string; type: string; size: number }[];
    };
    result: { target: "input" | "drop"; files: { name: string; size: number }[] };
  };
  /** `ref` is the element the events went to, `x` and `y` the point in the viewport. */
  click: {
    params: { tabId: number; button?: ClickButton; doubleClick?: boolean } & Target;
    result: { ref: string; x: number; y: number };
  };
  hover: { params: { tabId: number } & Target; result: { ref: string; x: number; y: number } };
  /**
   * With a direction, at the target or the viewport's centre; without one, `ref` is scrolled
   * into view. `ref` in the result is absent when the page itself scrolled.
   */
  scroll: {
    params: { tabId: number; direction?: ScrollDirection; amount?: number } & (
      | Target
      | { ref?: never; x?: never; y?: never }
    );
    result: { ref?: string; scrollLeft: number; scrollTop: number; moved: boolean };
  };
  drag: {
    params: { tabId: number } & Target & DragEnd;
    result: { ref: string; targetRef: string; mode: DragMode; dropped: boolean };
  };
  /** `recording` is false when Foxhand has not recorded the page since it loaded. */
  read_console: {
    params: { tabId: number };
    result: { recording: boolean; messages: ConsoleMessage[]; dropped: number };
  };
  /** Not an MCP tool: only `foxhand probe` calls it. */
  probe_input: { params: { tabId: number }; result: ProbeResult };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]["params"];
export type Result<M extends MethodName> = Methods[M]["result"];

/** A request as its sender builds it; `Request` alone is the union over every method. */
export type Request<M extends MethodName = MethodName> = {
  [K in M]: { type: "request"; id: string; session: string; method: K; params: Params<K> };
}[M];

export const METHOD_NAMES = [
  "tabs_list",
  "tab_open",
  "navigate",
  "read_page",
  "get_page_text",
  "screenshot",
  "upload_chunk",
  "upload_file",
  "click",
  "hover",
  "scroll",
  "drag",
  "read_console",
  "probe_input",
] as const satisfies readonly MethodName[];

// Fails to compile when a key of `Methods` is missing from `METHOD_NAMES`.
type AssertTrue<T extends true> = T;
type _AllMethodsListed = AssertTrue<
  [Exclude<MethodName, (typeof METHOD_NAMES)[number]>] extends [never] ? true : false
>;
