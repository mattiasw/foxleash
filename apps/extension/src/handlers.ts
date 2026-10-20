import type {
  MethodName,
  NavigateAction,
  ProbeResult,
  RequestMessage,
  Result,
  TabInfo,
} from "@foxhand/protocol";
import type {
  BrowserApi,
  CaptureArea,
  InjectionResult,
  Tab,
  TabUpdatedListener,
  Timers,
} from "./browser-api.ts";
import { ownField } from "./page-messages.ts";
import type { PageScripts } from "./page-scripts.ts";
import { pageTextOf, pageTextOptions } from "./page-text.ts";
import { READ_PAGE_MAX_CHARS, readPageOptions } from "./page-tree.ts";
import { captureRect, pngData, screenshotFailed } from "./screenshot.ts";
import type { SessionGroups } from "./session-groups.ts";
import { isRecord } from "./settings.ts";
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
import type { Uploads } from "./uploads.ts";
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
  /** Requests to Foxhand's content script; `import type`, since page-scripts.ts imports this file. */
  pages: Pick<PageScripts, "request">;
  /** The bytes upload_chunk stages; `import type`, since uploads.ts imports this file. */
  uploads: Pick<Uploads, "add" | "take">;
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
/** The longest file name upload_file hands to a page. */
const MAX_UPLOAD_NAME = 255;

/** With page-scripts' 20 s injection and 10 s reply, below the host's 60 s request timeout. */
export const CAPTURE_TIMEOUT_MS = 20_000;

export function createHandlers<Handle>({
  browser,
  groups,
  timers,
  access,
  probe,
  pages,
  uploads,
}: HandlerDeps<Handle>): (request: RequestMessage) => Promise<Result<MethodName>> {
  const handlers: Handlers = {
    tabs_list: tabsList,
    tab_open: tabOpen,
    navigate,
    read_page: readPage,
    get_page_text: getPageText,
    screenshot,
    upload_chunk: uploadChunk,
    upload_file: uploadFile,
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

  /** Reads the page in a tab through the content script, which runs only after the site gate. */
  async function readPage(session: string, params: Params): Promise<Result<"read_page">> {
    const tabId = own(params, "tabId");
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new ToolError(
        "invalid_params",
        "read_page needs a tab id that is a whole number of 0 or more.",
      );
    }
    const options = readPageOptions(params);
    if (typeof options === "string") throw new ToolError("invalid_params", options);
    const reply = await pages.request(session, tabId, "read_page", options);
    // The reply comes from the page's content process: own fields only, and the cap again.
    const tree = isRecord(reply) ? ownField(reply, "tree") : undefined;
    const truncated = isRecord(reply) ? ownField(reply, "truncated") : undefined;
    if (
      typeof tree !== "string" ||
      tree.length > READ_PAGE_MAX_CHARS ||
      typeof truncated !== "boolean"
    ) {
      throw new ToolError(
        "page_error",
        `Foxhand could not complete the request in the page in tab ${tabId}.`,
      );
    }
    return { tree, truncated };
  }

  /** Reads a page's text through the content script, which runs only after the site gate. */
  async function getPageText(session: string, params: Params): Promise<Result<"get_page_text">> {
    const tabId = own(params, "tabId");
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new ToolError(
        "invalid_params",
        "get_page_text needs a tab id that is a whole number of 0 or more.",
      );
    }
    const options = pageTextOptions(params);
    if (typeof options === "string") throw new ToolError("invalid_params", options);
    const reply = await pages.request(session, tabId, "get_page_text", options);
    const text = pageTextOf(reply, options.maxChars);
    if (text === undefined) {
      throw new ToolError(
        "page_error",
        `Foxhand could not complete the request in the page in tab ${tabId}.`,
      );
    }
    return text;
  }

  /**
   * Captures the tab's viewport, or with ref one element's box in it, in a tab on a site the
   * session may act on. Never asks, and never captures whichever tab happens to be active.
   */
  async function screenshot(session: string, params: Params): Promise<Result<"screenshot">> {
    const tabId = own(params, "tabId");
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new ToolError(
        "invalid_params",
        "screenshot needs a tab id that is a whole number of 0 or more.",
      );
    }
    const ref = screenshotRef(params);
    // From before the first gate, so a tab that shows another site and comes back between the
    // two gates, which see only their own moments, is caught too.
    const visits = watchSites(tabId);
    try {
      const gateDeps = { browser, groups, access };
      const site = await allowedPageSite(gateDeps, session, tabId);
      const rect = ref === undefined ? undefined : await elementArea(session, tabId, ref);
      const dataUrl = await capture(tabId, rect);
      // Nothing from the page reaches the agent once the user has withdrawn access.
      if ((await allowedPageSite(gateDeps, session, tabId)) !== site || visits.left(site)) {
        throw pageChanged(tabId);
      }
      const png = pngData(dataUrl, tabId);
      if ("code" in png) throw new ToolError(png.code, png.message);
      return png;
    } finally {
      visits.stop();
    }
  }

  /** The element's box in the page, scrolled into view and cut to the viewport. */
  async function elementArea(session: string, tabId: number, ref: string): Promise<CaptureArea> {
    const area = captureRect(await pages.request(session, tabId, "element_rect", { ref }), tabId);
    if ("code" in area) throw new ToolError(area.code, area.message);
    return area.rect;
  }

  async function capture(tabId: number, rect: CaptureArea | undefined): Promise<string> {
    const timeout = new ToolError(
      "page_timeout",
      `Firefox did not take the screenshot of tab ${tabId} in time; try again.`,
    );
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => reject(timeout), CAPTURE_TIMEOUT_MS);
    try {
      return await Promise.race([
        browser.tabs.captureTab(
          tabId,
          rect === undefined ? { format: "png", scale: 1 } : { format: "png", scale: 1, rect },
        ),
        timedOut,
      ]);
    } catch (error: unknown) {
      if (error === timeout) throw timeout;
      // Firefox's own error text can repeat the page's URL.
      const failed = screenshotFailed(tabId);
      throw new ToolError(failed.code, failed.message);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function uploadChunk(session: string, params: Params): Promise<Result<"upload_chunk">> {
    return {
      received: uploads.add(
        session,
        own(params, "upload"),
        own(params, "index"),
        own(params, "data"),
      ),
    };
  }

  /**
   * Hands the bytes staged for the upload to the element `ref` names, through the content
   * script, which runs only after the site gate. The bytes are taken first, so any failure
   * leaves nothing staged.
   */
  async function uploadFile(session: string, params: Params): Promise<Result<"upload_file">> {
    const upload = own(params, "upload");
    if (typeof upload !== "string") {
      throw new ToolError("invalid_params", "upload_file needs upload to be a string.");
    }
    const staged = uploads.take(session, upload) ?? new Uint8Array(0);
    const tabId = own(params, "tabId");
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new ToolError(
        "invalid_params",
        "upload_file needs a tab id that is a whole number of 0 or more.",
      );
    }
    const ref = own(params, "ref");
    if (typeof ref !== "string") {
      throw new ToolError("invalid_params", "upload_file needs ref to be a string.");
    }
    const files = uploadFiles(own(params, "files"));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total !== staged.length) {
      throw new ToolError(
        "invalid_params",
        `The files of upload_file add up to ${total} bytes, but Foxhand holds ${staged.length} for that upload.`,
      );
    }
    let offset = 0;
    const handed = files.map(({ name, type, size }) => {
      const bytes = staged.subarray(offset, offset + size);
      offset += size;
      return { name, type, bytes };
    });
    const reply = await pages.request(session, tabId, "upload_file", { ref, files: handed });
    // The reply comes from the page's content process: only its own target is read.
    const target = isRecord(reply) ? ownField(reply, "target") : undefined;
    if (target !== "input" && target !== "drop") {
      throw new ToolError(
        "page_error",
        `Foxhand could not complete the request in the page in tab ${tabId}.`,
      );
    }
    return { target, files: files.map(({ name, size }) => ({ name, size })) };
  }

  /** Records the site of every URL the tab moves to until `stop`. */
  function watchSites(tabId: number): { left(site: string): boolean; stop(): void } {
    const sites = new Set<string | undefined>();
    const listener: TabUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.url !== undefined) sites.add(siteOf(changeInfo.url));
    };
    browser.tabs.onUpdated.addListener(listener);
    return {
      left: (site) => [...sites].some((shown) => shown !== site),
      stop: () => browser.tabs.onUpdated.removeListener(listener),
    };
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
    const site = await allowedPageSite({ browser, groups, access }, session, tabId);
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
      throw tabNotFound(tabId);
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

export interface PageGateDeps {
  browser: Pick<BrowserApi, "tabs">;
  groups: Pick<SessionGroups, "groupOf">;
  access: Pick<SiteAccess, "view" | "openPrompt">;
}

/**
 * The site of the web page in a tab of the session's group that the session may read and act
 * in. Never asks: the site must already be allowed, through tab_open or navigate.
 */
export async function allowedPageSite(
  { browser, groups, access }: PageGateDeps,
  session: string,
  tabId: number,
): Promise<string> {
  let tab: Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    throw tabNotFound(tabId);
  }
  const group = await groups.groupOf(session);
  if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
  const prompt = access.openPrompt(session);
  if (prompt?.tabId === tabId) throw approvalPending(prompt.tabId, prompt.site);
  const url = tab.url ?? "";
  const site = siteOf(url);
  if (site === undefined) throw pageNotWeb(tabId);
  const view = await access.view(session);
  if (view.blocked(url)) throw siteBlocked(site);
  if (!view.allowed(url)) throw siteNotApproved(site, tabId);
  return site;
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

/** upload_file's file list, read own field by own field. */
function uploadFiles(value: unknown): { name: string; type: string; size: number }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError(
      "invalid_params",
      "upload_file needs files to be a list of one or more files.",
    );
  }
  return value.map((file: unknown) => {
    const name = isRecord(file) ? ownField(file, "name") : undefined;
    const type = isRecord(file) ? ownField(file, "type") : undefined;
    const size = isRecord(file) ? ownField(file, "size") : undefined;
    if (
      typeof name !== "string" ||
      name === "" ||
      name.length > MAX_UPLOAD_NAME ||
      name.includes("/")
    ) {
      throw new ToolError(
        "invalid_params",
        `upload_file needs each file name to be 1 to ${MAX_UPLOAD_NAME} characters without a slash.`,
      );
    }
    if (typeof type !== "string" || type.length > MAX_UPLOAD_NAME) {
      throw new ToolError(
        "invalid_params",
        `upload_file needs each file type to be a string of at most ${MAX_UPLOAD_NAME} characters.`,
      );
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new ToolError(
        "invalid_params",
        "upload_file needs each file size to be a whole number of 0 or more.",
      );
    }
    return { name, type, size };
  });
}

function screenshotRef(params: Params): string | undefined {
  if (!Object.hasOwn(params, "ref")) return undefined;
  const ref = params.ref;
  if (typeof ref !== "string") {
    throw new ToolError("invalid_params", "screenshot needs ref to be a string.");
  }
  return ref;
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

function tabNotFound(tabId: number): ToolError {
  return new ToolError("tab_not_found", `Tab ${tabId} does not exist.`);
}

function siteNotApproved(site: string, tabId: number): ToolError {
  return new ToolError(
    "site_not_approved",
    `Foxhand is not allowed on ${site} in this session; call navigate with tab ${tabId} and action reload to ask the user.`,
  );
}

function pageNotWeb(tabId: number): ToolError {
  return new ToolError(
    "page_not_web",
    `Foxhand acts only on http and https pages, and tab ${tabId} shows another kind of page.`,
  );
}

function pageChanged(tabId: number): ToolError {
  return new ToolError(
    "page_changed",
    `The page in tab ${tabId} changed while Foxhand was working in it; try again.`,
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
