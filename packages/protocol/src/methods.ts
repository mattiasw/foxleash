export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export type NavigateAction = "back" | "forward" | "reload";

export interface Methods {
  tabs_list: { params: Record<string, never>; result: { tabs: TabInfo[] } };
  tab_open: { params: { url?: string }; result: { tab: TabInfo } };
  navigate: {
    params:
      | { tabId: number; url: string; action?: never }
      | { tabId: number; action: NavigateAction; url?: never };
    result: { tab: TabInfo };
  };
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
] as const satisfies readonly MethodName[];

// Fails to compile when a key of `Methods` is missing from `METHOD_NAMES`.
type AssertTrue<T extends true> = T;
type _AllMethodsListed = AssertTrue<
  [Exclude<MethodName, (typeof METHOD_NAMES)[number]>] extends [never] ? true : false
>;
