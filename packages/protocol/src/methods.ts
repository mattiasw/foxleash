export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export type NavigateAction = "back" | "forward" | "reload";

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
  "probe_input",
] as const satisfies readonly MethodName[];

// Fails to compile when a key of `Methods` is missing from `METHOD_NAMES`.
type AssertTrue<T extends true> = T;
type _AllMethodsListed = AssertTrue<
  [Exclude<MethodName, (typeof METHOD_NAMES)[number]>] extends [never] ? true : false
>;
