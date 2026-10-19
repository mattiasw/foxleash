import type {
  MethodName,
  NavigateAction,
  ProbeResult,
  RequestMessage,
  Result,
  TabInfo,
} from "@foxhand/protocol";
import type { BrowserApi, InjectionResult, Tab, Timers } from "./browser-api.ts";
import type { SessionGroups } from "./session-groups.ts";
import { siteOf } from "./site.ts";
import {
  type Approval,
  approvalPending,
  type Decision,
  type OpenPrompt,
  PROMPT_PAGE,
  type SiteAccess,
  siteBlocked,
} from "./site-access.ts";
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
  access: SiteAccess;
  /**
   * The bundled page function `probe_input` runs, given the approved site and the time (ms since
   * the epoch) after which it must not act.
   */
  probe: (site: string, cutoff: number) => Promise<ProbeResult | null>;
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

/** Below the host's request timeout, which shuts the host down when it fires. */
export const PROBE_TIMEOUT_MS = 30_000;
/**
 * When the probe must stop acting, counted from the request: before PROBE_TIMEOUT_MS by more than
 * its longest check, since Firefox may start it late, once the page is idle.
 */
export const PROBE_CUTOFF_MS = 25_000;

export function createHandlers<Handle>({
  browser,
  groups,
  timers,
  access,
  probe,
}: HandlerDeps<Handle>): (request: RequestMessage) => Promise<Result<MethodName>> {
  const handlers: Handlers = {
    tabs_list: tabsList,
    tab_open: tabOpen,
    navigate,
    probe_input: probeInput,
  };

  return async function handleRequest(request) {
    return handlers[request.method](request.session, request.params);
  };

  async function tabsList(session: string): Promise<Result<"tabs_list">> {
    const group = await groups.groupOf(session);
    // Firefox's tabs.query without a groupId returns every tab in the browser.
    if (group === undefined) return { tabs: [] };
    const tabs = await browser.tabs.query({ groupId: group.id });
    const view = await access.view(session);
    return { tabs: tabs.map(view.tabInfo) };
  }

  async function tabOpen(session: string, params: Params): Promise<Result<"tab_open">> {
    const url = tabOpenUrl(params);
    const decision = url === undefined ? undefined : await access.check(session, url);
    if (url !== undefined && decision?.decision === "join") {
      // Waits on the session's open prompt for this site, in its tab, instead of a new tab.
      return { tab: await approveAndLoad(session, decision.tabId, url, { kind: "url", url }) };
    }
    const group = await groups.groupOf(session);
    // Opened blank and grouped first, so the page never loads outside the session's group.
    const tab = await browser.tabs.create(
      group === undefined
        ? { url: "about:blank", active: true }
        : { url: "about:blank", active: true, windowId: group.windowId },
    );
    await groups.ensureGroup(session, tab);
    if (url === undefined) {
      const current = await browser.tabs.get(tab.id);
      const view = await access.view(session);
      return { tab: view.tabInfo(current) };
    }
    if (decision?.decision === "ask") {
      let approval: Approval;
      try {
        approval = await access.ask(session, url, tab.id);
      } catch (error) {
        // Nothing was shown in the tab, so it would only be left blank.
        await browser.tabs.remove([tab.id]).catch(() => {});
        throw error;
      }
      await approval.answer;
      return { tab: await loadAfterAnswer(session, tab.id, url, { kind: "url", url }) };
    }
    const loaded = await waitForLoad(browser, timers, tab.id, () =>
      browser.tabs.update(tab.id, { url }),
    );
    const view = await access.view(session);
    return { tab: view.tabInfo(loaded) };
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
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    // A request on the prompt's own tab goes through the prompt, so Foxhand never leaves it.
    const prompt = access.openPrompt(session);
    if (prompt?.tabId === tabId) {
      const url = retryUrl(prompt, target);
      return { tab: await approveAndLoad(session, tabId, url, { kind: "url", url }) };
    }
    // A reload of a prompt the user has answered loads the page it asked about.
    const asked = isReload(target) ? access.askedUrl(session, tab) : undefined;
    if (asked !== undefined) {
      return { tab: await approveAndLoad(session, tabId, asked, { kind: "url", url: asked }) };
    }
    const gated = await gate(session, tab, target);
    if (gated !== undefined && gated.decision.decision !== "allowed") {
      return { tab: await approveAndLoad(session, tabId, gated.url, target) };
    }
    keepPrompt(session, tabId);
    const loaded = await waitForLoad(browser, timers, tabId, () => startNavigation(tabId, target));
    const view = await access.view(session);
    return { tab: view.tabInfo(loaded) };
  }

  /**
   * The gate's decision for the URL a load would open, or undefined for a load that is not
   * gated: going back and forward, and reloading about:blank.
   */
  async function gate(
    session: string,
    tab: Tab,
    target: NavigationTarget,
  ): Promise<{ decision: Decision; url: string } | undefined> {
    if (target.kind === "url") {
      return { decision: await access.check(session, target.url), url: target.url };
    }
    if (target.action !== "reload" || tab.url === "about:blank") return undefined;
    const url = tab.url ?? "";
    if (siteOf(url) === undefined) throw pageNotWeb(tab.id);
    return { decision: await access.check(session, url), url };
  }

  /**
   * Runs the bundled input probe in a tab on a site the session may act on. Never asks: the
   * site must already be allowed, through tab_open or navigate and the user's click.
   */
  async function probeInput(session: string, params: Params): Promise<Result<"probe_input">> {
    const tabId = own(params, "tabId");
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new ToolError(
        "invalid_params",
        "probe_input needs a tab id that is a whole number of 0 or more.",
      );
    }
    const tab = await existingTab(tabId);
    const group = await groups.groupOf(session);
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    const prompt = access.openPrompt(session);
    if (prompt?.tabId === tabId) throw approvalPending(prompt.tabId, prompt.site);
    const url = tab.url ?? "";
    const site = siteOf(url);
    if (site === undefined) throw pageNotWeb(tabId);
    const view = await access.view(session);
    if (view.blocked(url)) throw siteBlocked(site);
    if (!view.allowed(url)) {
      throw new ToolError(
        "site_not_approved",
        `Foxhand acts on ${site} only after the user allowed it; open it with tab_open or navigate to ask.`,
      );
    }
    const frames = await injectProbe(tabId, site);
    const top = frames.find((frame) => frame.frameId === 0);
    if (top === undefined || top.error !== undefined || top.result === undefined) {
      throw probeFailed(tabId);
    }
    // The probe found the tab on another site than the one checked here.
    if (top.result === null) {
      throw new ToolError("site_not_approved", `Tab ${tabId} no longer shows ${site}.`);
    }
    return top.result;
  }

  async function injectProbe(
    tabId: number,
    site: string,
  ): Promise<InjectionResult<ProbeResult | null>[]> {
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => reject(probeFailed(tabId)), PROBE_TIMEOUT_MS);
    try {
      return await Promise.race([
        browser.scripting.executeScript({
          target: { tabId },
          func: probe,
          args: [site, Date.now() + PROBE_CUTOFF_MS],
          world: "ISOLATED",
        }),
        timedOut,
      ]);
    } catch {
      // Firefox's own error text can repeat the page's URL.
      throw probeFailed(tabId);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function approveAndLoad(
    session: string,
    tabId: number,
    url: string,
    target: NavigationTarget,
  ): Promise<TabInfo> {
    const { answer } = await access.ask(session, url, tabId);
    await answer;
    return loadAfterAnswer(session, tabId, url, target);
  }

  /** Loads the approved URL; on the prompt page it replaces the prompt in the tab's history. */
  async function loadAfterAnswer(
    session: string,
    tabId: number,
    url: string,
    target: NavigationTarget,
  ): Promise<TabInfo> {
    const group = await groups.groupOf(session);
    const tab = await existingTab(tabId);
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    const view = await access.view(session);
    const site = siteOf(url);
    if (site !== undefined && view.blocked(url)) throw siteBlocked(site);
    const onPrompt = tab.url?.startsWith(browser.runtime.getURL(PROMPT_PAGE)) === true;
    keepPrompt(session, tabId);
    const loaded = await waitForLoad(browser, timers, tabId, () =>
      target.kind === "action" && !onPrompt && tab.url === url
        ? browser.tabs.reload(tabId)
        : browser.tabs.update(tabId, { url, loadReplace: onPrompt }),
    );
    const after = await access.view(session);
    return after.tabInfo(loaded);
  }

  /**
   * Refuses a load over the session's open prompt, which a parallel request may have shown in
   * the tab meanwhile. Called right before the load starts, with no await in between.
   */
  function keepPrompt(session: string, tabId: number): void {
    const shown = access.openPrompt(session);
    if (shown?.tabId === tabId) throw approvalPending(shown.tabId, shown.site);
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
  if (siteOf(parsed.href) === undefined) throw new ToolError("invalid_url", refusal);
  return parsed.href;
}

function isNavigateAction(value: unknown): value is NavigateAction {
  return NAVIGATE_ACTIONS.includes(value);
}

function own(params: Params, key: string): unknown {
  return Object.hasOwn(params, key) ? params[key] : undefined;
}

function pageNotWeb(tabId: number): ToolError {
  return new ToolError(
    "page_not_web",
    `Foxhand acts only on http and https pages, and tab ${tabId} shows another kind of page.`,
  );
}

function probeFailed(tabId: number): ToolError {
  return new ToolError("probe_failed", `Foxhand could not run its input probe in tab ${tabId}.`);
}

function notInGroup(tabId: number): ToolError {
  return new ToolError(
    "tab_not_in_group",
    `Tab ${tabId} is not in this session's tab group; open a tab with tab_open first.`,
  );
}

/**
 * The URL a request on the prompt's tab waits for: a URL on the prompt's site, or the prompt's
 * own URL for a reload. Anything else, or anything while a request already waits, is refused.
 */
function retryUrl(prompt: OpenPrompt, target: NavigationTarget): string {
  if (!prompt.waiting) {
    if (target.kind === "url" && siteOf(target.url) === prompt.site) return target.url;
    if (isReload(target)) return prompt.url;
  }
  throw approvalPending(prompt.tabId, prompt.site);
}

function isReload(target: NavigationTarget): boolean {
  return target.kind === "action" && target.action === "reload";
}
