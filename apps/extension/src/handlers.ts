import type {
  MethodName,
  NavigateAction,
  RequestMessage,
  Result,
  TabInfo,
} from "@foxhand/protocol";
import type { BrowserApi, Tab, Timers } from "./browser-api.ts";
import type { SessionGroups } from "./session-groups.ts";
import { waitForLoad } from "./wait-for-load.ts";

/** A failure the caller should see: `code` is a protocol token, `message` one plain sentence. */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HandlerDeps<Handle> {
  browser: BrowserApi;
  groups: SessionGroups;
  timers: Timers<Handle>;
}

type Params = Record<string, unknown>;

type Handlers = {
  [M in MethodName]: (session: string, params: Params) => Promise<Result<M>>;
};

type NavigationTarget = { kind: "url"; url: string } | { kind: "action"; action: NavigateAction };

const NAVIGATE_ACTIONS: readonly unknown[] = [
  "back",
  "forward",
  "reload",
] satisfies NavigateAction[];

export function createHandlers<Handle>({
  browser,
  groups,
  timers,
}: HandlerDeps<Handle>): (request: RequestMessage) => Promise<Result<MethodName>> {
  const handlers: Handlers = { tabs_list: tabsList, tab_open: tabOpen, navigate };

  return async function handleRequest(request) {
    return handlers[request.method](request.session, request.params);
  };

  async function tabsList(session: string): Promise<Result<"tabs_list">> {
    const group = await groups.groupOf(session);
    // Firefox's tabs.query without a groupId returns every tab in the browser.
    if (group === undefined) return { tabs: [] };
    const tabs = await browser.tabs.query({ groupId: group.id });
    return { tabs: tabs.map(toTabInfo) };
  }

  async function tabOpen(session: string, params: Params): Promise<Result<"tab_open">> {
    const url = tabOpenUrl(params);
    const group = await groups.groupOf(session);
    // Opened blank and grouped first, so the page never loads outside the session's group.
    const tab = await browser.tabs.create(
      group === undefined
        ? { url: "about:blank", active: true }
        : { url: "about:blank", active: true, windowId: group.windowId },
    );
    await groups.ensureGroup(session, tab);
    if (url === undefined) return { tab: toTabInfo(await browser.tabs.get(tab.id)) };
    const loaded = await waitForLoad(browser, timers, tab.id, () =>
      browser.tabs.update(tab.id, { url }),
    );
    return { tab: toTabInfo(loaded) };
  }

  async function navigate(session: string, params: Params): Promise<Result<"navigate">> {
    const tabId = own(params, "tabId");
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new ToolError(
        "invalid_params",
        "navigate needs a tab id that is a whole number of 0 or more.",
      );
    }
    const target = navigationTarget(params);
    const tab = await existingTab(tabId);
    const group = await groups.groupOf(session);
    if (group === undefined || tab.groupId !== group.id) {
      throw new ToolError(
        "tab_not_in_group",
        `Tab ${tabId} is not in this session's tab group; open a tab with tab_open first.`,
      );
    }
    const loaded = await waitForLoad(browser, timers, tabId, () => startNavigation(tabId, target));
    return { tab: toTabInfo(loaded) };
  }

  async function existingTab(tabId: number): Promise<Tab> {
    try {
      return await browser.tabs.get(tabId);
    } catch {
      throw new ToolError("tab_not_found", `Tab ${tabId} does not exist.`);
    }
  }

  function startNavigation(tabId: number, target: NavigationTarget): Promise<unknown> {
    if (target.kind === "url") return browser.tabs.update(tabId, { url: target.url });
    switch (target.action) {
      case "back":
        return browser.tabs.goBack(tabId);
      case "forward":
        return browser.tabs.goForward(tabId);
      case "reload":
        return browser.tabs.reload(tabId);
    }
  }
}

/** The http(s) URL to load, or undefined for about:blank. */
function tabOpenUrl(params: Params): string | undefined {
  if (!Object.hasOwn(params, "url")) return undefined;
  const url = params.url;
  if (typeof url !== "string") {
    throw new ToolError("invalid_params", "tab_open needs url to be a string.");
  }
  if (url === "about:blank") return undefined;
  return webUrl(url, "Foxhand opens only http and https URLs, or about:blank.");
}

function navigationTarget(params: Params): NavigationTarget {
  const hasUrl = Object.hasOwn(params, "url");
  const hasAction = Object.hasOwn(params, "action");
  if (hasUrl && hasAction) {
    throw new ToolError("invalid_params", "navigate takes either url or action, not both.");
  }
  if (hasUrl) {
    const url = params.url;
    if (typeof url !== "string") {
      throw new ToolError("invalid_params", "navigate needs url to be a string.");
    }
    return { kind: "url", url: webUrl(url, "Foxhand navigates only to http and https URLs.") };
  }
  if (!hasAction) throw new ToolError("invalid_params", "navigate needs a url or an action.");
  const action = params.action;
  if (!isNavigateAction(action)) {
    throw new ToolError("invalid_params", "action must be back, forward or reload.");
  }
  return { kind: "action", action };
}

/** The parsed href, so the URL that was checked is the URL that is opened. */
function webUrl(url: string, refusal: string): string {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ToolError("invalid_url", refusal);
  }
  return parsed.href;
}

function isNavigateAction(value: unknown): value is NavigateAction {
  return NAVIGATE_ACTIONS.includes(value);
}

function own(params: Params, key: string): unknown {
  return Object.hasOwn(params, key) ? params[key] : undefined;
}

function toTabInfo(tab: Tab): TabInfo {
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "", active: tab.active };
}
