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

/** The longest tree read_page returns, in UTF-16 units. */
export const READ_PAGE_MAX_CHARS = 50_000;
/** The most matching lines a read_page with find shows. */
export const READ_PAGE_MAX_MATCHES = 20;
/** The longest text a view of the page carries: its tree or changed lines, placeholders included. */
export const PAGE_VIEW_MAX_CHARS = 8_000;

/**
 * The view of the page an action's result ends with. `tree`, `lines` and `url` are page text;
 * `kind`, `omitted`, `truncated` and `reason` are Foxleash's own.
 */
export type PageView =
  /**
   * The tree: the whole read, or the lines the relevance cut kept with `omitted` lines left out
   * (0 when whole); `truncated` when the read itself stopped at READ_PAGE_MAX_CHARS.
   */
  | { kind: "tree"; tree: string; omitted: number; truncated: boolean }
  /**
   * The lines that changed since the last view of the same document: `+ ` added, `- ` removed, each
   * change after its unchanged ancestor lines, which start with two spaces; `truncated` when a
   * read stopped at READ_PAGE_MAX_CHARS, so the comparison covers only the start of the tree.
   */
  | { kind: "changes"; lines: string; truncated: boolean }
  /** Nothing changed since the last view of the same document, within the read. */
  | { kind: "unchanged"; truncated: boolean }
  /** The tab shows a site this session may not act on: its site, as tabs_list shows it. */
  | { kind: "site"; url: string }
  /** No tree: not an http(s) page, still loading another page, or not readable in time. */
  | { kind: "none"; reason: PageViewGap };

export type PageViewGap = "not_web" | "loading" | "unreadable";

const PAGE_VIEW_GAPS: readonly unknown[] = [
  "not_web",
  "loading",
  "unreadable",
] satisfies PageViewGap[];

/**
 * What a read_page with find counted: the matching lines in the tree, all matching lines, and all
 * lines searched.
 */
export interface FoundLines {
  shown: number;
  matches: number;
  searched: number;
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
  /** True when more text follows the returned part. */
  truncated: boolean;
  /**
   * The length, in UTF-16 units, of all of main plus rest after tidying, whatever the offset and
   * the cut.
   */
  totalChars: number;
  /** The offset to read on from, present only when truncated is true. */
  nextOffset?: number;
}

export const CONSOLE_LEVELS = ["debug", "log", "info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const CONSOLE_KINDS = ["console", "uncaught_error", "unhandled_rejection"] as const;
export type ConsoleKind = (typeof CONSOLE_KINDS)[number];

/** One message a page wrote; `time` is ms since the epoch, when Foxleash's recorder saw it. */
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

export interface NetworkHeader {
  name: string;
  value: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  /** webRequest's resource type: main_frame, xmlhttprequest (fetch too), script, image, ... */
  type: string;
  /** When the request started, in ms since the epoch. */
  startTime: number;
  /** Set once the request completed, failed or was redirected. */
  durationMs?: number;
  status?: number;
  redirectUrl?: string;
  /** Firefox's error for a failed request. */
  error?: string;
  fromCache?: boolean;
  requestHeaders: NetworkHeader[];
  responseHeaders: NetworkHeader[];
}

/** The most requests a page keeps, and the largest limit read_network takes. */
export const MAX_NETWORK_REQUESTS = 500;
/** How many requests read_network returns when the request gives no limit. */
export const DEFAULT_NETWORK_LIMIT = 100;
/** The longest pattern read_network takes. */
export const MAX_NETWORK_PATTERN = 1_000;
/** A request's URL and redirect target are cut to this many UTF-16 units. */
export const MAX_NETWORK_URL = 2_000;
/** Each header name and value, a request's method, type and error are cut to this many. */
export const MAX_NETWORK_HEADER = 1_000;
/** The most headers kept in each direction of a request. */
export const MAX_NETWORK_HEADERS = 100;

/** wait_for's wait when the request gives none. */
export const DEFAULT_WAIT_FOR_MS = 10_000;
/** The shortest wait wait_for takes. */
export const MIN_WAIT_FOR_MS = 100;
/** The longest wait wait_for takes: below the host's 60 s request timeout, which shuts the host down when it fires. */
export const MAX_WAIT_FOR_MS = 30_000;
/** The longest text or selector wait_for takes. */
export const MAX_WAIT_FOR_TEXT = 1_000;
/** The smallest and largest width and height resize_window takes, in pixels. */
export const MIN_WINDOW_SIZE = 100;
export const MAX_WINDOW_SIZE = 10_000;

/** wait_for's params besides its one condition. */
type WaitParams = { tabId: number; timeoutMs?: number; view?: boolean };

/** A recipe as the user keeps it: written steps for a task, with the sites it uses. */
export interface RecipeFields {
  name: string;
  description: string;
  /** Sites as siteOf gives them (ADR 0007), no duplicates. */
  sites: string[];
  steps: string;
}

export interface Recipe extends RecipeFields {
  /** ISO 8601, when the user saved it. */
  savedAt: string;
}

export type RecipeSummary = Omit<Recipe, "steps">;

// The recipe lengths count code points. A schema that bounds the same fields in UTF-16 units must
// allow twice these and leave the exact bound to the extension's checkRecipe.
/** A recipe name's most characters. */
export const MAX_RECIPE_NAME = 100;
/** A recipe description's most characters. */
export const MAX_RECIPE_DESCRIPTION = 200;
/** The most sites one recipe lists. */
export const MAX_RECIPE_SITES = 20;
/** A recipe's steps' most characters. */
export const MAX_RECIPE_STEPS = 20_000;
/** The most recipes storage keeps. */
export const MAX_RECIPES = 100;

/** type's longest text, in UTF-16 units. */
export const MAX_TYPE_CHARS = 50_000;

/** typed: the text was read back; sent_unconfirmed: inserted into an editor that cannot be read. */
export type TypeOutcome = "typed" | "sent_unconfirmed";

/** How type got the text in. */
export type TypeMethod = "exec_command" | "native_setter" | "beforeinput_dom";

/** fill_form's most fields in one call. */
export const MAX_FILL_FIELDS = 50;
/** fill_form's most characters across all values; each string counts at least one. */
export const MAX_FILL_CHARS = 100_000;
/** fill_form starts no field after this long, so its reply comes well inside the page reply timeout. */
export const FILL_START_LIMIT_MS = 4_000;

/** Text for a text field, the option or options of a select, a checkbox's or radio's state. */
export type FillValue = string | string[] | boolean;

/** typed: text went in; selected / clicked: a select or checkbox changed; unchanged: it already was so. */
export type FillOutcome = "typed" | "selected" | "clicked" | "unchanged";

/** One field's result, keyed by its ref; never carries a value. */
export type FillResult =
  | { ref: string; ok: true; outcome: FillOutcome }
  | { ref: string; ok: false; code: string; message: string };

/** The default action press_key performed after the key's events. */
export type KeyAction =
  | "none"
  | "submitted"
  | "clicked"
  | "focus_moved"
  | "selected_option"
  | "closed_dialog"
  | "hid_popover";

/** How long the page must show no change after an act, with no request it began open, to settle. */
export const ACT_QUIET_MS = 100;
/** The longest an act's result waits for the page to go quiet, from the act's reply. */
export const ACT_SETTLE_CAP_MS = 2_000;
/** After a fetch or XMLHttpRequest the page began after an act answers, the longest the settle waits for the page to change. */
export const ACT_RESPONSE_WAIT_MS = 1_200;

/** What followed an act, as the extension saw it once the page settled or the wait ended. */
export type ActPage =
  /** The tab loaded another page; `url` is its address. */
  | "loaded"
  /** The tab was still loading another page when Foxleash stopped waiting. */
  | "loading"
  /** The page changed, then went quiet. */
  | "changed"
  /** Nothing changed in the page within the wait. */
  | "unchanged"
  /** At the cap the page was still changing, or waiting for a request it began after the act. */
  | "unsettled"
  /** The tab closed. */
  | "closed"
  /** Foxleash could not tell: a check failed, another act ran in the tab, or time ran out. */
  | "unknown";

/** What an act's result says about the page after the act. */
export interface ActAfter {
  /** The element that took the act, as read_page shows it: page text. */
  element?: { role: string; name: string };
  page: ActPage;
  /** With loaded, and with loading once the new page committed: the tab's address as tabs_list shows it. */
  url?: string;
  /** Tabs that opened in the session's group during the act or the wait. */
  openedTabs?: number[];
  /**
   * How many requests the page began after the act (beacons, pings, CSP reports, websockets and
   * media left out); absent when none. Unchanged with requests can mean the page sent what the act
   * asked for without showing it.
   */
  requests?: number;
}

/** The most bytes upload_file takes in one call, across all its files. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** The most bytes one upload_chunk carries: its base64 and envelope stay under 1 MB. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
/** The largest file download saves. */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The acts' results carry `after` once the extension has watched the page after the act; the
 * page's own part of the result has none, and an extension older than the field sends none. The
 * acts, tab_open, navigate and wait_for end their results with `view`, unless their `view` param is
 * false; an extension older than the field sends none.
 */
export interface Methods {
  tabs_list: { params: Record<string, never>; result: { tabs: TabInfo[] } };
  tab_open: { params: { url?: string; view?: boolean }; result: { tab: TabInfo; view?: PageView } };
  navigate: {
    params:
      | { tabId: number; url: string; action?: never; view?: boolean }
      | { tabId: number; action: NavigateAction; url?: never; view?: boolean };
    result: { tab: TabInfo; view?: PageView };
  };
  tab_close: { params: { tabId: number }; result: { tabs: TabInfo[] } };
  tab_select: { params: { tabId: number }; result: { tab: TabInfo } };
  wait_for: {
    params:
      | (WaitParams & { text: string; selector?: never; navigation?: never })
      | (WaitParams & { selector: string; text?: never; navigation?: never })
      | (WaitParams & { navigation: true; text?: never; selector?: never });
    result: { tab: TabInfo; view?: PageView };
  };
  resize_window: {
    params: { width: number; height: number };
    result: { width: number; height: number };
  };
  read_page: {
    params: {
      tabId: number;
      filter?: "all" | "interactive";
      depth?: number;
      ref?: string;
      find?: string;
      role?: string;
    };
    /** `found` is there exactly when `find` was given. */
    result: { tree: string; truncated: boolean; found?: FoundLines };
  };
  get_page_text: {
    params: { tabId: number; maxChars?: number; offset?: number };
    result: PageText;
  };
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
      view?: boolean;
    };
    result: {
      target: "input" | "drop";
      files: { name: string; size: number }[];
      after?: ActAfter;
      view?: PageView;
    };
  };
  /** `ref` is the element the events went to, `x` and `y` the point in the viewport. */
  click: {
    params: { tabId: number; button?: ClickButton; doubleClick?: boolean; view?: boolean } & Target;
    result: { ref: string; x: number; y: number; after?: ActAfter; view?: PageView };
  };
  hover: {
    params: { tabId: number; view?: boolean } & Target;
    result: { ref: string; x: number; y: number; after?: ActAfter; view?: PageView };
  };
  /**
   * With a direction, at the target or the viewport's centre; without one, `ref` is scrolled
   * into view. `ref` in the result is absent when the page itself scrolled.
   */
  scroll: {
    params: { tabId: number; direction?: ScrollDirection; amount?: number; view?: boolean } & (
      | Target
      | { ref?: never; x?: never; y?: never }
    );
    result: {
      ref?: string;
      scrollLeft: number;
      scrollTop: number;
      moved: boolean;
      after?: ActAfter;
      view?: PageView;
    };
  };
  drag: {
    params: { tabId: number; view?: boolean } & Target & DragEnd;
    result: {
      ref: string;
      targetRef: string;
      mode: DragMode;
      dropped: boolean;
      after?: ActAfter;
      view?: PageView;
    };
  };
  type: {
    params: { tabId: number; ref: string; text: string; view?: boolean };
    result: { outcome: TypeOutcome; method: TypeMethod; after?: ActAfter; view?: PageView };
  };
  /** `prevented` is true when the page cancelled keydown or keypress. */
  press_key: {
    params: { tabId: number; key: string; ref?: string; view?: boolean };
    result: { action: KeyAction; prevented: boolean; after?: ActAfter; view?: PageView };
  };
  fill_form: {
    params: { tabId: number; fields: { ref: string; value: FillValue }[]; view?: boolean };
    result: { fields: FillResult[]; after?: ActAfter; view?: PageView };
  };
  /** `recording` is false when Foxleash has not recorded the page since it loaded. */
  read_console: {
    params: { tabId: number };
    result: { recording: boolean; messages: ConsoleMessage[]; dropped: number };
  };
  /** `recording` is false when Foxleash has not recorded the page since it loaded. */
  read_network: {
    params: { tabId: number; pattern?: string; limit?: number };
    result: { recording: boolean; requests: NetworkRequest[]; truncated: boolean };
  };
  /** `path` is the absolute path Firefox saved the file at, `bytes` its size. */
  download: { params: { url: string; filename: string }; result: { path: string; bytes: number } };
  /** Opens the propose page in the session's group; `tabId` is its tab. Never says whether the user saved. */
  recipe_propose: { params: RecipeFields; result: { tabId: number } };
  /** The saved recipes, sorted by name, without their steps. */
  recipe_list: { params: Record<string, never>; result: { recipes: RecipeSummary[] } };
  /** The saved recipe named exactly `name`, or else named `name` normalized as a saved name is. */
  recipe_get: { params: { name: string }; result: { recipe: Recipe } };
  /** Asks the user to allow a saved recipe's sites for the session; each list in the recipe's order. */
  recipe_run: {
    params: { name: string };
    result: { asked: boolean; allowed: string[]; blocked: string[]; refused: string[] };
  };
  /** Asks the user to allow the sites an agent named for the session; each list in the request's order. */
  sites_request: {
    params: { sites: string[] };
    result: { asked: boolean; allowed: string[]; blocked: string[]; refused: string[] };
  };
  /** Not an MCP tool: only `foxleash probe` calls it. */
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
  "tab_close",
  "tab_select",
  "wait_for",
  "resize_window",
  "read_page",
  "get_page_text",
  "screenshot",
  "upload_chunk",
  "upload_file",
  "click",
  "hover",
  "scroll",
  "drag",
  "type",
  "press_key",
  "fill_form",
  "read_console",
  "read_network",
  "download",
  "recipe_propose",
  "recipe_list",
  "recipe_get",
  "recipe_run",
  "sites_request",
  "probe_input",
] as const satisfies readonly MethodName[];

// Fails to compile when a key of `Methods` is missing from `METHOD_NAMES`.
type AssertTrue<T extends true> = T;
type _AllMethodsListed = AssertTrue<
  [Exclude<MethodName, (typeof METHOD_NAMES)[number]>] extends [never] ? true : false
>;

/** What a fill_form request counts against MAX_FILL_CHARS: each string's length, at least one. */
export function fillChars(fields: readonly { value: FillValue }[]): number {
  let total = 0;
  for (const { value } of fields) {
    if (typeof value === "string") total += stringChars(value);
    else if (Array.isArray(value)) for (const entry of value) total += stringChars(entry);
  }
  return total;
}

function stringChars(text: string): number {
  return Math.max(1, text.length);
}

/**
 * The counts of a read_page with find, checked against each other and against the tree they came
 * with, as a fresh object; undefined when the page could not have written them.
 */
export function foundLinesOf(
  value: unknown,
  tree: string,
  truncated: boolean,
): FoundLines | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const shown = countField(value, "shown");
  const matches = countField(value, "matches");
  const searched = countField(value, "searched");
  if (shown === undefined || matches === undefined || searched === undefined) return undefined;
  if (shown > matches || matches > searched || shown > READ_PAGE_MAX_MATCHES) return undefined;
  // The page writes nothing without a match, and every match up to the cap until the tree is full.
  if ((matches === 0) !== (tree === "")) return undefined;
  if (truncated ? matches === 0 : shown < Math.min(matches, READ_PAGE_MAX_MATCHES)) {
    return undefined;
  }
  // Each line written was searched, and each match shown is a line of its own.
  const lines = tree === "" ? 0 : tree.split("\n").length;
  if (shown > lines || lines > searched) return undefined;
  return { shown, matches, searched };
}

/**
 * A view of the page as the extension sent it, checked field by field, as a fresh object; undefined
 * for anything else. Its texts are at most PAGE_VIEW_MAX_CHARS long.
 */
export function pageViewOf(value: unknown): PageView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const kind = Object.hasOwn(value, "kind") ? Reflect.get(value, "kind") : undefined;
  switch (kind) {
    case "tree": {
      const tree = viewText(value, "tree");
      const omitted = countField(value, "omitted");
      const truncated = booleanField(value, "truncated");
      if (tree === undefined || omitted === undefined || truncated === undefined) return undefined;
      // A line left out holds at least its newline.
      if (omitted > READ_PAGE_MAX_CHARS) return undefined;
      return { kind, tree, omitted, truncated };
    }
    case "changes": {
      const lines = viewText(value, "lines");
      const truncated = booleanField(value, "truncated");
      if (lines === undefined || truncated === undefined) return undefined;
      return { kind, lines, truncated };
    }
    case "unchanged": {
      const truncated = booleanField(value, "truncated");
      return truncated === undefined ? undefined : { kind, truncated };
    }
    case "site": {
      const url = viewText(value, "url");
      return url === undefined ? undefined : { kind, url };
    }
    case "none": {
      const reason = Object.hasOwn(value, "reason") ? Reflect.get(value, "reason") : undefined;
      return isPageViewGap(reason) ? { kind, reason } : undefined;
    }
    default:
      return undefined;
  }
}

function viewText(value: object, key: string): string | undefined {
  const field = Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
  return typeof field === "string" && field.length <= PAGE_VIEW_MAX_CHARS ? field : undefined;
}

function booleanField(value: object, key: string): boolean | undefined {
  const field = Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
  return typeof field === "boolean" ? field : undefined;
}

function isPageViewGap(value: unknown): value is PageViewGap {
  return PAGE_VIEW_GAPS.includes(value);
}

function countField(value: object, key: string): number | undefined {
  const field = Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

/**
 * Whether an act that cannot safely be repeated aims at a point in the viewport or at the focused
 * element instead of at an element by ref: it lands on whatever page the tab shows.
 */
export function aimsWithoutRef(method: string, params: object): boolean {
  switch (method) {
    case "click":
    case "press_key":
      return !Object.hasOwn(params, "ref");
    case "drag":
      return !Object.hasOwn(params, "ref") || !Object.hasOwn(params, "targetRef");
    default:
      return false;
  }
}
