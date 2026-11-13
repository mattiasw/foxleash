import {
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_WAIT_FOR_MS,
  foundLinesOf,
  MAX_NETWORK_PATTERN,
  MAX_NETWORK_REQUESTS,
  MAX_WAIT_FOR_MS,
  MAX_WAIT_FOR_TEXT,
  MAX_WINDOW_SIZE,
  type MethodName,
  MIN_WAIT_FOR_MS,
  MIN_WINDOW_SIZE,
  type NavigateAction,
  type ProbeResult,
  type RequestMessage,
  type Result,
  type TabInfo,
} from "@foxleash/protocol";
import type {
  BrowserApi,
  CaptureArea,
  CssInjection,
  FrameDetails,
  InjectionResult,
  NavigationDetails,
  RequestDetails,
  Tab,
  TabUpdatedListener,
  Timers,
} from "./browser-api.ts";
import { parseConsoleResult } from "./console-messages.ts";
import type { ConsoleRecording } from "./console-recording.ts";
import { type Downloads, downloadNameProblem } from "./downloads.ts";
import { foreignFramePlan } from "./foreign-frames.ts";
import { watchFrameErrors } from "./frame-errors.ts";
import type { NetworkLog, NetworkReadOptions } from "./network-log.ts";
import {
  clickOptions,
  dragOptions,
  dragResultOf,
  hoverOptions,
  pointResultOf,
  scrollOptions,
  scrollResultOf,
} from "./page-actions.ts";
import { fillFormOptions, fillFormResultOf } from "./page-fill.ts";
import { pressKeyOptions, pressKeyResultOf, typeOptions, typeResultOf } from "./page-input.ts";
import { ownField } from "./page-messages.ts";
import type { PageScripts } from "./page-scripts.ts";
import { pageTextOf, pageTextOptions } from "./page-text.ts";
import { READ_PAGE_MAX_CHARS, readPageOptions } from "./page-tree.ts";
import type { RecipePrompts } from "./recipe-prompts.ts";
import { checkRecipe, findRecipe, readRecipes, recipeName } from "./recipes.ts";
import {
  captureRect,
  FIELD_MASK_CSS,
  FRAME_HIDE_CSS,
  INPUT_MASK_CSS,
  pngData,
  revealedReply,
  screenshotFailed,
} from "./screenshot.ts";
import type { SessionGroups } from "./session-groups.ts";
import { isRecord } from "./settings.ts";
import { siteOf, withoutFragment } from "./site.ts";
import {
  type Approval,
  approvalPending,
  type Decision,
  type OpenPrompt,
  PROMPT_PAGE,
  type SiteAccess,
  siteBlocked,
} from "./site-access.ts";
import type { TabNavigations } from "./tab-navigations.ts";
import type { Uploads } from "./uploads.ts";
import { waitForNavigation, waitForPage } from "./wait-for.ts";
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
  /** Requests to Foxleash's content script; `import type`, since page-scripts.ts imports this file. */
  pages: Pick<PageScripts, "request">;
  /** The navigations under way in each tab, which a screenshot and read_console wait for. */
  navigations: Pick<TabNavigations, "settled" | "underWay" | "begun">;
  /** The bytes upload_chunk stages; `import type`, since uploads.ts imports this file. */
  uploads: Pick<Uploads, "add" | "take">;
  /** Which tabs' console records may be read; `import type`, since it imports this file. */
  recordings: Pick<ConsoleRecording, "liveRecording">;
  /** The tabs' network requests; `import type`, since it imports this file. */
  network: Pick<NetworkLog, "read">;
  /** Saves files into the download folder; it imports this file too. */
  downloads: Pick<Downloads, "save">;
  /** The session's recipe pages; `import type`, since it imports this file. */
  recipes: Pick<RecipePrompts, "propose" | "run" | "openPrompt">;
}

type Params = Record<string, unknown>;

type Handlers = {
  [M in MethodName]: (session: string, params: Params) => Promise<Result<M>>;
};

type NavigationTarget = { kind: "url"; url: string } | { kind: "action"; action: NavigateAction };

/** What `navigate` watched while it went back or forward. */
interface HistoryLoad {
  /** Undefined while the request of the tab's last top-level commit has not been reported. */
  reloads(): boolean | undefined;
  /** Resolves once a request makes `reloads` defined, or after `ms`. */
  decided(ms: number): Promise<void>;
  stop(): void;
}

/** A top-level request `navigate` saw while it went back or forward. */
interface TopRequest {
  /** Without its fragment. */
  url: string;
  timeStamp: number;
  /** Whether no top-level or frame request that was not a GET was reported after it. */
  onlyGets: boolean;
}

type WaitCondition = { text: string } | { selector: string } | { navigation: true };

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

/** Bounds listing a tab's frames, hiding their field text and capturing the tab. */
export const CAPTURE_TIMEOUT_MS = 20_000;
/** Bounds a whole screenshot, its page requests included, below the host's 60 s request timeout. */
export const SCREENSHOT_TIMEOUT_MS = 50_000;
/** Bounds a whole read_console, its wait for a navigation included, as SCREENSHOT_TIMEOUT_MS does. */
export const READ_CONSOLE_TIMEOUT_MS = 50_000;
/** How long a page request or a screenshot waits for one navigation of the tab's top frame. */
export const NAVIGATION_WAIT_MS = 10_000;
/**
 * How long `navigate` waits, once going back or forward has loaded a page, for that page's own
 * request: Firefox can report it after the commit (ADR 0016 measured 211 ms). A page Firefox
 * takes from the back-forward cache commits but makes no request, so it waits this long.
 */
export const HISTORY_REQUEST_TIMEOUT_MS = 1000;
/**
 * Bounds the wait for the reload after going back or forward, so that with the step's own wait
 * (LOAD_GRACE_MS and LOAD_TIMEOUT_MS) and the wait for its request (HISTORY_REQUEST_TIMEOUT_MS),
 * `navigate` answers below the host's 60 s request timeout.
 */
export const HISTORY_RELOAD_TIMEOUT_MS = 20_000;
/**
 * Bounds loading the page in place of an about:blank that its reload landed on, so that with the
 * reload's own wait (LOAD_GRACE_MS and LOAD_TIMEOUT_MS), `navigate` answers below the host's 60 s
 * request timeout.
 */
export const BLANK_RELOAD_TIMEOUT_MS = 20_000;
/**
 * How long `tab_close` waits for Firefox to remove the tab: a page's beforeunload prompt holds the
 * removal until the user answers it.
 */
export const CLOSE_CONFIRM_TIMEOUT_MS = 5_000;

export function createHandlers<Handle>({
  browser,
  groups,
  timers,
  access,
  probe,
  pages,
  navigations,
  uploads,
  recordings,
  network,
  downloads,
  recipes,
}: HandlerDeps<Handle>): (request: RequestMessage) => Promise<Result<MethodName>> {
  const frameErrors = watchFrameErrors(browser);
  const handlers: Handlers = {
    tabs_list: tabsList,
    tab_open: tabOpen,
    navigate,
    tab_close: tabClose,
    tab_select: tabSelect,
    wait_for: waitFor,
    resize_window: resizeWindow,
    read_page: readPage,
    get_page_text: getPageText,
    screenshot,
    upload_chunk: uploadChunk,
    upload_file: uploadFile,
    click: (session, params) => pageAction(session, params, "click", clickOptions, pointResultOf),
    hover: (session, params) => pageAction(session, params, "hover", hoverOptions, pointResultOf),
    scroll: (session, params) =>
      pageAction(session, params, "scroll", scrollOptions, scrollResultOf),
    drag: (session, params) => pageAction(session, params, "drag", dragOptions, dragResultOf),
    type: (session, params) => pageAction(session, params, "type", typeOptions, typeResultOf),
    press_key: (session, params) =>
      pageAction(session, params, "press_key", pressKeyOptions, pressKeyResultOf),
    fill_form: (session, params) =>
      pageAction(session, params, "fill_form", fillFormOptions, fillFormResultOf),
    read_console: readConsole,
    read_network: readNetwork,
    download,
    recipe_propose: recipePropose,
    recipe_list: recipeList,
    recipe_get: recipeGet,
    recipe_run: recipeRun,
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
    if (url !== undefined && decision?.decision === "allowed") {
      return { tab: await openOnPage(session, url, group?.windowId) };
    }
    if (url !== undefined) return { tab: await openOnPrompt(session, url, group?.windowId) };
    const tab = await browser.tabs.create(
      group === undefined
        ? { url: "about:blank", active: true }
        : { url: "about:blank", active: true, windowId: group.windowId },
    );
    await groups.ensureGroup(session, tab);
    const current = await browser.tabs.get(tab.id);
    const view = await access.view(session);
    return { tab: view.tabInfo(current) };
  }

  /**
   * Created unloaded on its page: Firefox gives a tab that started on about:blank an about:blank
   * history entry after its page when it unloads and restores it. Grouped before its page loads,
   * so the page never loads outside the session's group. Loaded before it is selected: selecting
   * a tab Firefox has not loaded restores its page as a history load, which shows the cached copy
   * without asking the server unless the response was `no-store`.
   */
  async function openOnPage(
    session: string,
    url: string,
    windowId: number | undefined,
  ): Promise<TabInfo> {
    const tab = await browser.tabs.create(
      windowId === undefined
        ? { url, active: false, discarded: true }
        : { url, active: false, discarded: true, windowId },
    );
    try {
      await groups.ensureGroup(session, tab);
    } catch (error) {
      // Selected outside the group, it would load the page there.
      await removeNewTab(session, tab.id);
      throw error;
    }
    try {
      await waitForLoad(
        browser,
        timers,
        tab.id,
        url,
        () => browser.tabs.update(tab.id, { url, loadReplace: true }),
        { unloaded: true },
      );
    } catch (error) {
      // Never selected, it holds nothing the user saw.
      await removeNewTab(session, tab.id);
      throw error;
    }
    const selected = await browser.tabs.update(tab.id, { active: true });
    const view = await access.view(session);
    return view.tabInfo(selected);
  }

  /**
   * Created unloaded on its prompt page, as `openOnPage`'s tab is on its page, so Firefox's unload
   * and restore add no about:blank entry; grouped before the prompt loads. A tab the prompt was
   * not shown in (its site allowed meanwhile) loads the page and is then selected, as
   * `openOnPage`'s is.
   */
  async function openOnPrompt(
    session: string,
    url: string,
    windowId: number | undefined,
  ): Promise<TabInfo> {
    const promptUrl = access.newPromptUrl();
    const tab = await browser.tabs.create(
      windowId === undefined
        ? { url: promptUrl, active: false, discarded: true }
        : { url: promptUrl, active: false, discarded: true, windowId },
    );
    let approval: Approval;
    try {
      await groups.ensureGroup(session, tab);
      approval = await access.ask(session, url, tab.id, promptUrl);
    } catch (error) {
      // Nothing was shown in it; selected outside the group, it would load there.
      await removeNewTab(session, tab.id);
      throw error;
    }
    let loaded: TabInfo;
    try {
      await approval.answer;
      loaded = await loadAfterAnswer(session, tab.id, url, { kind: "url", url });
    } catch (error) {
      // A tab the prompt was never shown in holds nothing the user saw.
      if (!approval.promptInTab) await removeNewTab(session, tab.id);
      throw error;
    }
    if (approval.promptInTab) return loaded;
    const selected = await browser.tabs.update(tab.id, { active: true });
    const view = await access.view(session);
    return view.tabInfo(selected);
  }

  /**
   * Removes a tab tab_open created and gave up on, in turn with other closes, and leaves it when
   * it is its window's last tab or shows the session's open prompt, which a parallel request may
   * have shown in it. Never rejects: tab_open reports the error that made it give up.
   */
  async function removeNewTab(session: string, tabId: number): Promise<void> {
    const closed = await groups
      .closeTab(tabId, () => keepPrompt(session, tabId))
      .catch(() => undefined);
    if (closed) await closed.removed.catch(() => {});
  }

  async function navigate(session: string, params: Params): Promise<Result<"navigate">> {
    const tabId = tabIdParam(params, "navigate");
    const target = navigationTarget(params);
    const tab = await existingTab(tabId);
    const group = await groups.groupOf(session);
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    // A request on the prompt's own tab goes through the prompt, so Foxleash never leaves it.
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
    const history =
      target.kind === "action" && target.action !== "reload" ? watchHistoryLoad(tabId) : undefined;
    try {
      const loaded =
        isReload(target) && gated !== undefined
          ? await reloadPage(session, tab, gated.url)
          : await waitForLoad(
              browser,
              timers,
              tabId,
              target.kind === "url" ? target.url : undefined,
              () => startNavigation(tabId, target),
              { unloaded: tab.discarded === true },
            );
      const shown =
        history === undefined ? loaded : await reloadHistoryLoad(session, tabId, loaded, history);
      const view = await access.view(session);
      return { tab: view.tabInfo(shown) };
    } finally {
      history?.stop();
    }
  }

  /**
   * Notes a tab's top-level commits and its top-level and frame requests until `stop`, with
   * their start times: Firefox can report a document's own request after its commit (ADR 0016),
   * so they are matched by time, not by the order they arrive in. It `reloads` when the last
   * top-level request started by the tab's last top-level commit is for the commit's URL, and no
   * top-level or frame request that started from that request on, or was reported after it, was
   * not a GET.
   */
  function watchHistoryLoad(tabId: number): HistoryLoad {
    let commit: { url: string; timeStamp: number } | undefined;
    // The latest top-level request started by the commit, and the latest one reported before any
    // commit or started after the one it was reported after.
    let byCommit: TopRequest | undefined;
    let next: TopRequest | undefined;
    let nonGetStarted = Number.NEGATIVE_INFINITY;
    let wake: (() => void) | undefined;
    const onRequest = (details: RequestDetails) => {
      if (details.tabId !== tabId) return;
      const top = details.type === "main_frame";
      if (
        details.method !== "GET" &&
        // Firefox reports a load in an <object> element's frame as an object request.
        (top || details.type === "sub_frame" || details.type === "object")
      ) {
        nonGetStarted = Math.max(nonGetStarted, details.timeStamp);
        if (byCommit !== undefined) byCommit.onlyGets = false;
        if (next !== undefined) next.onlyGets = false;
      }
      if (!top) return;
      const request = {
        url: withoutFragment(details.url),
        timeStamp: details.timeStamp,
        onlyGets: true,
      };
      if (commit !== undefined && request.timeStamp <= commit.timeStamp) {
        byCommit = later(byCommit, request);
      } else {
        next = later(next, request);
      }
      wake?.();
    };
    // The commit's URL, not the tab's: the page can change its address with the History API.
    const onCommit = (details: NavigationDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      commit = { url: withoutFragment(details.url), timeStamp: details.timeStamp };
      if (next !== undefined && next.timeStamp <= commit.timeStamp) {
        byCommit = later(byCommit, next);
      }
    };
    browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] });
    browser.webNavigation.onCommitted.addListener(onCommit);
    return {
      reloads,
      decided: (ms) =>
        new Promise((resolve) => {
          const timer = timers.setTimeout(done, ms);
          wake = () => {
            if (reloads() !== undefined) done();
          };
          function done(): void {
            timers.clearTimeout(timer);
            resolve();
          }
        }),
      stop: () => {
        browser.webRequest.onBeforeRequest.removeListener(onRequest);
        browser.webNavigation.onCommitted.removeListener(onCommit);
      },
    };

    function reloads(): boolean | undefined {
      // No commit: the step loaded no document. webRequest sees no page off the web.
      if (commit === undefined || siteOf(commit.url) === undefined) return false;
      // Also for a page taken from the back-forward cache, which commits but makes no request.
      if (byCommit?.url !== commit.url) return undefined;
      return byCommit.onlyGets && nonGetStarted < byCommit.timeStamp;
    }
  }

  /**
   * Reloads without the cache a page that going back or forward loaded again instead of taking
   * it from the back-forward cache: Firefox puts field values back into such a page without its
   * autofill mark (ADR 0025). Only in the session's group, off its prompt, on a site it may act
   * on, and never after a request that was not a GET, so no form is sent again.
   */
  async function reloadHistoryLoad(
    session: string,
    tabId: number,
    loaded: Tab,
    history: HistoryLoad,
  ): Promise<Tab> {
    // A load cut off by its timeout may not have requested its frames yet, POSTs among them.
    if (loaded.status !== "complete") return loaded;
    if (history.reloads() === undefined) await history.decided(HISTORY_REQUEST_TIMEOUT_MS);
    if (history.reloads() !== true) return loaded;
    const group = await groups.groupOf(session);
    const view = await access.view(session);
    const tab = await existingTab(tabId);
    // No await from here to the reload, so a request the page sends meanwhile still counts.
    const url = tab.url ?? "";
    if (
      history.reloads() !== true ||
      group === undefined ||
      tab.groupId !== group.id ||
      access.openPrompt(session)?.tabId === tabId ||
      !view.allowed(url)
    ) {
      return loaded;
    }
    history.stop();
    return waitForLoad(
      browser,
      timers,
      tabId,
      undefined,
      () => browser.tabs.reload(tabId, { bypassCache: true }),
      { timeoutMs: HISTORY_RELOAD_TIMEOUT_MS },
    );
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
   * Closes a tab of the session's group, unless it is the last tab of its window or shows the
   * session's open prompt, and returns the tabs left in the group. When Firefox has not removed
   * the tab within CLOSE_CONFIRM_TIMEOUT_MS it refuses, saying the page asked the user to confirm
   * leaving it; when the user chose to stay on the page, it says so.
   */
  async function tabClose(session: string, params: Params): Promise<Result<"tab_close">> {
    const tabId = tabIdParam(params, "tab_close");
    const { groupId } = await groupTab(session, tabId);
    const closed = await groups.closeTab(tabId, (current) => {
      if (current.groupId !== groupId) throw notInGroup(tabId);
      keepPrompt(session, tabId);
    });
    if (!closed) {
      throw new ToolError(
        "last_tab",
        `Tab ${tabId} is the last tab in its window, and closing it would close the window.`,
      );
    }
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(
      () =>
        reject(
          new ToolError(
            "close_needs_confirm",
            `Tab ${tabId}'s page asked the user to confirm leaving it. Firefox closes the tab when the user chooses to leave the page, and keeps it open if they choose to stay.`,
          ),
        ),
      CLOSE_CONFIRM_TIMEOUT_MS,
    );
    try {
      await Promise.race([closed.removed, timedOut]);
    } finally {
      timers.clearTimeout(timer);
    }
    // Firefox also settles the removal when the user chooses to stay on the page.
    const kept = await browser.tabs.get(tabId).then(
      () => true,
      () => false,
    );
    if (kept) {
      throw new ToolError(
        "close_declined",
        `Tab ${tabId} is still open: its page asked the user to confirm leaving it, and the user chose to stay.`,
      );
    }
    const { tabs } = await tabsList(session);
    return { tabs: tabs.filter((listed) => listed.id !== tabId) };
  }

  /** Makes a tab of the session's group the active tab of its window, without focusing the window. */
  async function tabSelect(session: string, params: Params): Promise<Result<"tab_select">> {
    const tabId = tabIdParam(params, "tab_select");
    await groupTab(session, tabId);
    const updated = await browser.tabs.update(tabId, { active: true });
    const view = await access.view(session);
    return { tab: view.tabInfo(updated) };
  }

  /**
   * Waits until the page in a tab of the session's group shows a text or has an element matching
   * a selector, read through the content script after the site gate, or until a navigation in the
   * tab finishes. The tab must still be in the group when the wait ends.
   */
  async function waitFor(session: string, params: Params): Promise<Result<"wait_for">> {
    const tabId = tabIdParam(params, "wait_for");
    const condition = waitCondition(params);
    const timeoutMs = waitTimeoutMs(params);
    if ("navigation" in condition) {
      const outcome = await waitForNavigation({ browser, timers }, tabId, timeoutMs, () =>
        groupTab(session, tabId),
      );
      if (outcome === "closed") throw tabNotFound(tabId);
      if (outcome === "timeout") {
        throw new ToolError(
          "wait_timeout",
          `Tab ${tabId} did not finish a navigation within ${secondsText(timeoutMs)}.`,
        );
      }
    } else if (!(await waitForPage({ pages, timers }, session, tabId, condition, timeoutMs))) {
      const what = "text" in condition ? "that text" : "an element matching that selector";
      throw new ToolError(
        "wait_timeout",
        `Tab ${tabId} did not show ${what} within ${secondsText(timeoutMs)}.`,
      );
    }
    const tab = await groupTab(session, tabId);
    const view = await access.view(session);
    return { tab: view.tabInfo(tab) };
  }

  /**
   * Resizes the window that holds the session's group, out of a maximized, minimized or full-screen
   * state first, and returns the size Firefox reports for it.
   */
  async function resizeWindow(session: string, params: Params): Promise<Result<"resize_window">> {
    const width = windowSize(own(params, "width"));
    const height = windowSize(own(params, "height"));
    const group = await groups.groupOf(session);
    if (group === undefined) {
      throw new ToolError(
        "no_session_group",
        "This session has no tab group yet; open a tab with tab_open first.",
      );
    }
    // A maximized or full-screen window ignores a size; the normal state combines with one.
    await browser.windows.update(group.windowId, { state: "normal", width, height });
    const resized = await browser.windows.get(group.windowId);
    if (typeof resized.width !== "number" || typeof resized.height !== "number") {
      throw new ToolError("resize_failed", "Firefox did not report the window's new size.");
    }
    return { width: resized.width, height: resized.height };
  }

  /** The tab, when it exists and is in the session's group. */
  async function groupTab(session: string, tabId: number): Promise<Tab> {
    const tab = await existingTab(tabId);
    const group = await groups.groupOf(session);
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    return tab;
  }

  /** Reads the page in a tab through the content script, which runs only after the site gate. */
  async function readPage(session: string, params: Params): Promise<Result<"read_page">> {
    const tabId = tabIdParam(params, "read_page");
    const options = readPageOptions(params);
    if (typeof options === "string") throw new ToolError("invalid_params", options);
    const reply = await pages.request(session, tabId, "read_page", options);
    // The reply comes from the page's content process: own fields only, and the cap again.
    const tree = isRecord(reply) ? ownField(reply, "tree") : undefined;
    const truncated = isRecord(reply) ? ownField(reply, "truncated") : undefined;
    const unreadable = new ToolError(
      "page_error",
      `Foxleash could not complete the request in the page in tab ${tabId}.`,
    );
    if (
      typeof tree !== "string" ||
      tree.length > READ_PAGE_MAX_CHARS ||
      typeof truncated !== "boolean"
    ) {
      throw unreadable;
    }
    if (options.find === undefined) return { tree, truncated };
    const found = foundLinesOf(
      isRecord(reply) ? ownField(reply, "found") : undefined,
      tree,
      truncated,
    );
    if (found === undefined) throw unreadable;
    return { tree, truncated, found };
  }

  /** Reads a page's text through the content script, which runs only after the site gate. */
  async function getPageText(session: string, params: Params): Promise<Result<"get_page_text">> {
    const tabId = tabIdParam(params, "get_page_text");
    const options = pageTextOptions(params);
    if (typeof options === "string") throw new ToolError("invalid_params", options);
    const reply = await pages.request(session, tabId, "get_page_text", options);
    const text = pageTextOf(reply, options);
    if (text === undefined) {
      throw new ToolError(
        "page_error",
        `Foxleash could not complete the request in the page in tab ${tabId}.`,
      );
    }
    return text;
  }

  /**
   * Captures the tab's viewport, or with ref one element's box in it, in a tab on a site the
   * session may act on, with the text of protected fields hidden. Never asks, and never captures
   * whichever tab happens to be active.
   */
  async function screenshot(session: string, params: Params): Promise<Result<"screenshot">> {
    const tabId = tabIdParam(params, "screenshot");
    const ref = screenshotRef(params);
    const timeout = screenshotTimeout(tabId);
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    let expired = false;
    const timer = timers.setTimeout(() => {
      expired = true;
      reject(timeout);
    }, SCREENSHOT_TIMEOUT_MS);
    try {
      return await Promise.race([maskedScreenshot(session, tabId, ref, () => expired), timedOut]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function maskedScreenshot(
    session: string,
    tabId: number,
    ref: string | undefined,
    expired: () => boolean,
  ): Promise<Result<"screenshot">> {
    const { site, visits, frames } = await screenshotGate(session, tabId, true);
    try {
      const rect = ref === undefined ? undefined : await elementArea(session, tabId, ref);
      const revealed = await passwordRevealed(session, tabId);
      const dataUrl = await maskedCapture(tabId, rect, revealed, expired);
      // A field revealed after the check was captured without the input mask.
      if (!revealed && (await passwordRevealed(session, tabId))) throw pageChanged(tabId);
      // Nothing from the page reaches the agent once the user has withdrawn access.
      if (
        (await allowedPageSite({ browser, groups, access }, session, tabId)) !== site ||
        visits.left(site) ||
        frames.committed()
      ) {
        throw pageChanged(tabId);
      }
      const png = pngData(dataUrl, tabId);
      if ("code" in png) throw new ToolError(png.code, png.message);
      return png;
    } finally {
      visits.stop();
      frames.stop();
    }
  }

  /**
   * The screenshot's first gate, once a navigation under way in the tab has ended, and the
   * watchers of what the tab shows from then on. Started before the wait, the watchers would see
   * that navigation's own commit. With `retry`, a gate that meets the about:blank of a document
   * swap waits for its page and gates once more.
   */
  async function screenshotGate(
    session: string,
    tabId: number,
    retry: boolean,
  ): Promise<{
    site: string;
    visits: ReturnType<typeof watchSites>;
    frames: ReturnType<typeof watchFrames>;
  }> {
    await navigationSettled(session, tabId);
    // From before the first gate, so a tab that shows another site and comes back between the
    // two gates, which see only their own moments, is caught too.
    const visits = watchSites(tabId);
    // A frame that loads a new document has no sheet, and a same-site load can bring back a
    // revealed field the first check did not see.
    const frames = watchFrames(tabId);
    try {
      return {
        site: await allowedPageSite({ browser, groups, access }, session, tabId),
        visits,
        frames,
      };
    } catch (error: unknown) {
      visits.stop();
      frames.stop();
      const swapping =
        error instanceof ToolError && error.code === "page_not_web" && navigations.underWay(tabId);
      if (retry && swapping) return screenshotGate(session, tabId, false);
      throw error;
    }
  }

  /**
   * Waits for the navigation under way in the tab, when it is in the session's group, which it
   * checks first: the time a refusal takes, whether or not the tab is loading, tells nothing
   * about other tabs.
   */
  async function navigationSettled(session: string, tabId: number): Promise<void> {
    try {
      await groupTab(session, tabId);
    } catch {
      return;
    }
    if (!navigations.underWay(tabId)) return;
    if ((await navigations.settled(tabId, NAVIGATION_WAIT_MS)) === "timeout") {
      throw pageLoading(tabId);
    }
  }

  /** The element's box in the page, scrolled into view and cut to the viewport. */
  async function elementArea(session: string, tabId: number, ref: string): Promise<CaptureArea> {
    const area = captureRect(await pages.request(session, tabId, "element_rect", { ref }), tabId);
    if ("code" in area) throw new ToolError(area.code, area.message);
    return area.rect;
  }

  /** Whether the page turned a remembered password field into another kind. */
  async function passwordRevealed(session: string, tabId: number): Promise<boolean> {
    const reply = revealedReply(await pages.request(session, tabId, "password_fields", {}), tabId);
    if ("code" in reply) throw new ToolError(reply.code, reply.message);
    return reply.revealed;
  }

  /**
   * Captures the tab with the text of protected fields hidden in every frame, and of every input
   * of the top document when `revealed`. One insertion per frame, since Firefox skips a frame it
   * will not enter without an error when given all frames at once. A document holding another
   * add-on's frame, which no add-on can enter, also takes a sheet that keeps all its frames
   * unpainted (ADR 0031). A frame refusing the sheet refuses the screenshot, unless Firefox
   * reported the frame's current document as its error page, which shows nothing of the page, or
   * the frame is, or lies inside, another add-on's frame, so hidden.
   */
  async function maskedCapture(
    tabId: number,
    rect: CaptureArea | undefined,
    revealed: boolean,
    expired: () => boolean,
  ): Promise<string> {
    const timeout = new ToolError(
      "page_timeout",
      `Firefox did not take the screenshot of tab ${tabId} in time; try again.`,
    );
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => reject(timeout), CAPTURE_TIMEOUT_MS);
    // Firefox shares one sheet between insertions of the same text, so each screenshot marks its
    // own, also across restarts of the background page.
    const marker = `/* ${crypto.randomUUID()} */\n`;
    const inserted: {
      mask: CssInjection;
      excusable: FrameDetails | undefined;
      insert: Promise<void>;
    }[] = [];
    try {
      const frames = await Promise.race([browser.webNavigation.getAllFrames({ tabId }), timedOut]);
      // The screenshot answered already: nothing more goes into the page, nothing is captured.
      if (expired()) throw timeout;
      const top = frames?.find((frame) => frame.frameId === 0);
      if (frames === null || top === undefined) {
        throw screenshotFailedError(tabId);
      }
      const plan = foreignFramePlan(frames, browser.runtime.getURL(""));
      if (plan === undefined) throw screenshotFailedError(tabId);
      const sheets = masksFor(tabId, frames, revealed, plan.hideIn, marker);
      for (const { mask, excusable } of sheets) {
        inserted.push({ mask, excusable, insert: browser.scripting.insertCSS(mask) });
      }
      const taken = inserted.map(({ excusable, insert }) =>
        insert.catch((error: unknown) => {
          if (excusable === undefined) throw error;
          // Another add-on's frame, or one inside it: the hiding sheet keeps it unpainted.
          if (plan.hidden.has(excusable.frameId)) return;
          // Firefox's error page takes no sheet and holds no field of the page.
          if (frameErrors.showsErrorPage(tabId, excusable)) return;
          throw error;
        }),
      );
      await Promise.race([Promise.all(taken), timedOut]);
      if (expired()) throw timeout;
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
      throw screenshotFailedError(tabId);
    } finally {
      timers.clearTimeout(timer);
      // Not awaited: Firefox removes a sheet only once the frame is idle, which may take long.
      // Each once its own insertion settles: never before it, nor held by another frame's.
      for (const { mask, insert } of inserted) {
        const remove = () => browser.scripting.removeCSS(mask);
        void insert.then(remove, remove).catch(() => undefined);
      }
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
    const tabId = tabIdParam(params, "upload_file");
    const ref = own(params, "ref");
    if (typeof ref !== "string") {
      throw new ToolError("invalid_params", "upload_file needs ref to be a string.");
    }
    const files = uploadFiles(own(params, "files"));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total !== staged.length) {
      throw new ToolError(
        "invalid_params",
        `The files of upload_file add up to ${total} bytes, but Foxleash holds ${staged.length} for that upload.`,
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
        `Foxleash could not complete the request in the page in tab ${tabId}.`,
      );
    }
    return { target, files: files.map(({ name, size }) => ({ name, size })) };
  }

  /**
   * Acts in a page through the content script, which runs only after the site gate: the tool's
   * options parsed here and again in the page, and the page's reply checked.
   */
  async function pageAction<O extends Params, R>(
    session: string,
    params: Params,
    tool: "click" | "hover" | "scroll" | "drag" | "type" | "press_key" | "fill_form",
    parse: (params: Params) => O | string,
    check: (reply: unknown, options: O) => R | undefined,
  ): Promise<R> {
    const tabId = tabIdParam(params, tool);
    const options = parse(params);
    if (typeof options === "string") throw new ToolError("invalid_params", options);
    // The reply comes from the page's content process: own fields only, of exact types.
    const result = check(await pages.request(session, tabId, tool, options), options);
    if (result === undefined) {
      throw new ToolError(
        "page_error",
        `Foxleash could not complete the request in the page in tab ${tabId}.`,
      );
    }
    return result;
  }

  /** Reads what the page in a tab wrote to its console, through the content script. */
  async function readConsole(session: string, params: Params): Promise<Result<"read_console">> {
    const tabId = tabIdParam(params, "read_console");
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => reject(consoleTimeout(tabId)), READ_CONSOLE_TIMEOUT_MS);
    try {
      return await Promise.race([recordedConsole(session, tabId), timedOut]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function recordedConsole(session: string, tabId: number): Promise<Result<"read_console">> {
    // The recording of the page a navigation under way brings, not of the page it replaces.
    await navigationSettled(session, tabId);
    const begun = navigations.begun(tabId);
    const live = recordings.liveRecording(session, tabId);
    const reply = await pages.request(session, tabId, "read_console", {});
    // The reply comes from the page's content process: own fields only, and the caps again.
    const result = parseConsoleResult(reply);
    if (result === undefined) {
      throw new ToolError(
        "page_error",
        `Foxleash could not complete the request in the page in tab ${tabId}.`,
      );
    }
    // Records from a document whose access was interrupted since it loaded are never returned.
    if (live === undefined || recordings.liveRecording(session, tabId) !== live) {
      // The answer came from the page of a navigation that began during the read.
      if (navigations.begun(tabId) > begun) throw pageChanged(tabId);
      return { recording: false, messages: [], dropped: 0 };
    }
    return result;
  }

  /** Reads the network requests Foxleash recorded for the page in a tab. */
  async function readNetwork(session: string, params: Params): Promise<Result<"read_network">> {
    const tabId = tabIdParam(params, "read_network");
    const options = networkOptions(params);
    const site = await allowedPageSite({ browser, groups, access }, session, tabId);
    return network.read(session, tabId, site, options);
  }

  /**
   * Saves the file at a URL on a site the session may already act on into Firefox's download
   * folder. Never asks.
   */
  async function download(session: string, params: Params): Promise<Result<"download">> {
    const url = own(params, "url");
    if (typeof url !== "string") {
      throw new ToolError("invalid_params", "download needs url to be a string.");
    }
    const href = webUrl(url, "Foxleash downloads only http and https URLs.");
    const filename = own(params, "filename");
    const problem = downloadNameProblem(filename);
    if (problem !== undefined) throw new ToolError("invalid_params", problem);
    // A string: downloadNameProblem refuses anything else.
    return downloads.save(session, href, String(filename));
  }

  /**
   * Opens the user's page for a proposed recipe, normalized first, so a name with surrounding
   * spaces or a site given as a URL is shown and looked up as it would be stored.
   */
  async function recipePropose(session: string, params: Params): Promise<Result<"recipe_propose">> {
    const checked = checkRecipe({
      name: own(params, "name"),
      description: own(params, "description"),
      sites: own(params, "sites"),
      steps: own(params, "steps"),
    });
    if (!checked.ok) {
      const problems = checked.problems.map(({ field, text }) => `${field}: ${text}`);
      throw new ToolError("invalid_params", `propose_recipe was refused: ${problems.join(" ")}`);
    }
    return recipes.propose(session, checked.recipe);
  }

  /** The saved recipes, sorted by name, without their steps. */
  async function recipeList(): Promise<Result<"recipe_list">> {
    const saved = await readRecipes(browser);
    return {
      recipes: saved.map(({ name, description, sites, savedAt }) => ({
        name,
        description,
        sites,
        savedAt,
      })),
    };
  }

  /** The saved recipe named exactly `name`, or else named `name` normalized as a saved name is. */
  async function recipeGet(_session: string, params: Params): Promise<Result<"recipe_get">> {
    const name = own(params, "name");
    if (typeof name !== "string") {
      throw new ToolError("invalid_params", "get_recipe needs name to be a string.");
    }
    const recipe = await findRecipe(browser, name);
    if (recipe === undefined) throw recipeNotFound(name);
    return { recipe };
  }

  /** Asks the user to allow a saved recipe's sites for the session, on the run page. */
  async function recipeRun(session: string, params: Params): Promise<Result<"recipe_run">> {
    const name = own(params, "name");
    if (typeof name !== "string") {
      throw new ToolError("invalid_params", "start_recipe needs name to be a string.");
    }
    return recipes.run(session, name);
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

  /** Notes whether any frame of the tab, the top one included, commits a document until `stop`. */
  function watchFrames(tabId: number): { committed(): boolean; stop(): void } {
    let committed = false;
    const listener = (details: NavigationDetails) => {
      if (details.tabId === tabId) committed = true;
    };
    browser.webNavigation.onCommitted.addListener(listener);
    return {
      committed: () => committed,
      stop: () => browser.webNavigation.onCommitted.removeListener(listener),
    };
  }

  /**
   * Runs the bundled input probe in a tab on a site the session may act on. Never asks: the
   * site must already be allowed, through tab_open or navigate and the user's click.
   */
  async function probeInput(session: string, params: Params): Promise<Result<"probe_input">> {
    const tabId = tabIdParam(params, "probe_input");
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
    const view = await access.view(session);
    const group = await groups.groupOf(session);
    const tab = await existingTab(tabId);
    // No await from here to the load, so the tab cannot leave the group in between.
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    const site = siteOf(url);
    if (site !== undefined && view.blocked(url)) throw siteBlocked(site);
    const onPrompt = tab.url?.startsWith(browser.runtime.getURL(PROMPT_PAGE)) === true;
    keepPrompt(session, tabId);
    const loaded =
      target.kind === "action" && !onPrompt && tab.url === url
        ? await reloadPage(session, tab, url)
        : await waitForLoad(
            browser,
            timers,
            tabId,
            url,
            () => browser.tabs.update(tabId, { url, loadReplace: onPrompt }),
            { unloaded: tab.discarded === true },
          );
    const after = await access.view(session);
    return after.tabInfo(loaded);
  }

  /**
   * Reloads the web page `url` without the cache: a normal reload restores field values without
   * Firefox's autofill mark; this one restores none (ADR 0021). In a tab opened blank, Firefox can
   * keep an about:blank history entry after the page and reload that instead. Then the page is
   * loaded in its place, only while the tab still shows that blank, in the session's group, off
   * its prompt, on a site the session may act on: a new load, which restores no field value
   * either, but may come from the cache. A tab Firefox unloaded would reload about:blank, so its
   * page is loaded instead, which may also come from the cache.
   */
  async function reloadPage(session: string, tab: Tab, url: string): Promise<Tab> {
    const tabId = tab.id;
    if (tab.discarded === true) {
      return waitForLoad(
        browser,
        timers,
        tabId,
        url,
        () => browser.tabs.update(tabId, { url, loadReplace: true }),
        { unloaded: true },
      );
    }
    // No URL to wait for: the reload loads whichever entry Firefox reloads.
    const reloaded = await waitForLoad(browser, timers, tabId, undefined, () =>
      browser.tabs.reload(tabId, { bypassCache: true }),
    );
    // A reload cut off by its timeout gets no second wait.
    if (reloaded.url !== "about:blank" || reloaded.status !== "complete") return reloaded;
    const group = await groups.groupOf(session);
    const view = await access.view(session);
    const current = await existingTab(tabId);
    // No await from here to the load. Firefox changes a tab's url only when a load commits, so a
    // load started meanwhile still shows about:blank, but not complete.
    if (
      current.url !== "about:blank" ||
      current.status !== "complete" ||
      group === undefined ||
      current.groupId !== group.id ||
      access.openPrompt(session)?.tabId === tabId ||
      !view.allowed(url)
    ) {
      return current;
    }
    return waitForLoad(
      browser,
      timers,
      tabId,
      url,
      () => browser.tabs.update(tabId, { url, loadReplace: true }),
      { timeoutMs: BLANK_RELOAD_TIMEOUT_MS },
    );
  }

  /**
   * Refuses a load over the session's open prompt or recipe page, or closing its tab, which would
   * dismiss the user's question and count against the session's prompts; a parallel request may
   * have shown the prompt in the tab meanwhile. Called right before the load or the removal
   * starts, with no await in between.
   */
  function keepPrompt(session: string, tabId: number): void {
    const shown = access.openPrompt(session);
    if (shown?.tabId === tabId)
      throw approvalPending(shown.tabId, `whether to allow ${shown.site}`);
    if (recipes.openPrompt(session)?.tabId === tabId) {
      throw new ToolError(
        "recipe_prompt_open",
        `Foxleash is showing the user a recipe page in tab ${tabId}; leave that tab open.`,
      );
    }
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
        return browser.tabs.reload(tabId, { bypassCache: true });
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
  return allowedSiteFor(access, session, tabId, tab.url ?? "");
}

/**
 * The site of `url` in a tab of the session's group, when the session may read and act there:
 * not the session's open prompt, a web page, not blocked, approved. Never asks.
 */
export async function allowedSiteFor(
  access: Pick<SiteAccess, "view" | "openPrompt">,
  session: string,
  tabId: number,
  url: string,
): Promise<string> {
  const prompt = access.openPrompt(session);
  if (prompt?.tabId === tabId)
    throw approvalPending(prompt.tabId, `whether to allow ${prompt.site}`);
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
  return webUrl(url, "Foxleash opens only http and https URLs, or about:blank.");
}

function tabIdParam(params: Params, method: string): number {
  const tabId = own(params, "tabId");
  if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new ToolError(
      "invalid_params",
      `${method} needs a tab id that is a whole number of 0 or more.`,
    );
  }
  return tabId;
}

/** wait_for's one condition: a text, a selector the page may be asked about, or navigation. */
function waitCondition(params: Params): WaitCondition {
  const text = own(params, "text");
  const selector = own(params, "selector");
  const navigation = own(params, "navigation");
  if ([text, selector, navigation].filter((given) => given !== undefined).length !== 1) {
    throw new ToolError(
      "invalid_params",
      "wait_for needs exactly one of text, selector or navigation.",
    );
  }
  if (text !== undefined) return { text: waitText(text, "text") };
  if (selector !== undefined) {
    const checked = waitText(selector, "selector");
    const word = mirroredValueWord(checked);
    if (word === "value") {
      throw new ToolError(
        "invalid_params",
        'wait_for does not take a selector that contains both "[" and "value", since it could test what a password field holds.',
      );
    }
    if (word === "ng-reflect") {
      throw new ToolError(
        "invalid_params",
        'wait_for does not take a selector that contains both "[" and "ng-reflect", since Angular can copy field values into those attributes.',
      );
    }
    return { selector: checked };
  }
  if (navigation !== true) {
    throw new ToolError("invalid_params", "wait_for needs navigation to be true.");
  }
  return { navigation: true };
}

function waitText(value: unknown, name: "text" | "selector"): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_WAIT_FOR_TEXT) {
    throw new ToolError(
      "invalid_params",
      `wait_for needs ${name} to be 1 to ${MAX_WAIT_FOR_TEXT.toLocaleString("en-US")} characters.`,
    );
  }
  return value;
}

// ADR 0010 and 0026: wait_for answers no field values. A selector on the value attribute would,
// asked again and again ([value^="a"], [value^="b"], ...), read a password the page mirrors into
// it, and Angular development builds can mirror bound values into ng-reflect-* attributes.
function mirroredValueWord(selector: string): "value" | "ng-reflect" | undefined {
  if (!selector.includes("[")) return undefined;
  const decoded = selector
    .replace(CSS_ESCAPE, decodeEscape)
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (decoded.includes("value")) return "value";
  if (decoded.includes("ng-reflect")) return "ng-reflect";
  return undefined;
}

/**
 * A CSS escape (CSS Syntax 3, "consume an escaped code point"): 1 to 6 hex digits and at most
 * one whitespace after them, a newline, which the escape removes, any other character, or a
 * backslash at the end.
 */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\r\n|[\n\r\f]|([\s\S])|$)/g;

function decodeEscape(_escape: string, hex: string | undefined, char: string | undefined): string {
  if (hex !== undefined) {
    const code = Number.parseInt(hex, 16);
    // CSS also turns 0 and surrogates into U+FFFD; no character of "value" or "ng-reflect" can
    // come from either.
    return code > 0x10ffff ? "\uFFFD" : String.fromCodePoint(code);
  }
  return char ?? "";
}

function waitTimeoutMs(params: Params): number {
  const timeoutMs = own(params, "timeoutMs");
  if (timeoutMs === undefined) return DEFAULT_WAIT_FOR_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_WAIT_FOR_MS ||
    timeoutMs > MAX_WAIT_FOR_MS
  ) {
    throw new ToolError(
      "invalid_params",
      `wait_for needs timeoutMs to be a whole number from ${MIN_WAIT_FOR_MS} to ${MAX_WAIT_FOR_MS.toLocaleString("en-US")}.`,
    );
  }
  return timeoutMs;
}

/** "1 second", or "N seconds" with N in seconds, such as 0.1 or 10. */
export function secondsText(ms: number): string {
  return ms === 1000 ? "1 second" : `${ms / 1000} seconds`;
}

function windowSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_WINDOW_SIZE ||
    value > MAX_WINDOW_SIZE
  ) {
    throw new ToolError(
      "invalid_params",
      `resize_window needs width and height to be whole numbers from ${MIN_WINDOW_SIZE} to ${MAX_WINDOW_SIZE.toLocaleString("en-US")}.`,
    );
  }
  return value;
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

function consoleTimeout(tabId: number): ToolError {
  return new ToolError(
    "page_timeout",
    `Foxleash did not finish reading the console of tab ${tabId} in time; try again.`,
  );
}

function screenshotTimeout(tabId: number): ToolError {
  return new ToolError(
    "page_timeout",
    `Foxleash did not finish the screenshot of tab ${tabId} in time; try again.`,
  );
}

function screenshotFailedError(tabId: number): ToolError {
  const failed = screenshotFailed(tabId);
  return new ToolError(failed.code, failed.message);
}

/**
 * The sheets of one screenshot: the field mask in every frame, the input mask in the top one, and
 * the frame hiding sheet in each of `hideIn`. A subframe's field mask carries the listed frame,
 * whose refusal of it may be passed over; a refusal of any other sheet refuses the screenshot.
 */
function masksFor(
  tabId: number,
  frames: FrameDetails[],
  revealed: boolean,
  hideIn: number[],
  marker: string,
): { mask: CssInjection; excusable: FrameDetails | undefined }[] {
  const masks = frames.map((frame) => {
    const { frameId } = frame;
    const mask: CssInjection = {
      target: { tabId, frameIds: [frameId] },
      css: FIELD_MASK_CSS + marker,
      origin: "USER",
    };
    return { mask, excusable: frameId === 0 ? undefined : frame };
  });
  if (revealed) {
    const mask: CssInjection = {
      target: { tabId, frameIds: [0] },
      css: INPUT_MASK_CSS + marker,
      origin: "USER",
    };
    masks.push({ mask, excusable: undefined });
  }
  for (const frameId of hideIn) {
    const mask: CssInjection = {
      target: { tabId, frameIds: [frameId] },
      css: FRAME_HIDE_CSS + marker,
      origin: "USER",
    };
    masks.push({ mask, excusable: undefined });
  }
  return masks;
}

/** read_network's pattern and limit, the limit's default filled in. */
function networkOptions(params: Params): NetworkReadOptions {
  const pattern = own(params, "pattern");
  if (
    pattern !== undefined &&
    (typeof pattern !== "string" || pattern.length > MAX_NETWORK_PATTERN)
  ) {
    throw new ToolError(
      "invalid_params",
      `read_network needs pattern to be text of at most ${MAX_NETWORK_PATTERN.toLocaleString("en-US")} characters.`,
    );
  }
  const given = own(params, "limit");
  const limit = given === undefined ? DEFAULT_NETWORK_LIMIT : given;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_NETWORK_REQUESTS
  ) {
    throw new ToolError(
      "invalid_params",
      `read_network needs limit to be a whole number from 1 to ${MAX_NETWORK_REQUESTS}.`,
    );
  }
  return pattern === undefined ? { limit } : { pattern, limit };
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
    return { kind: "url", url: webUrl(url, "Foxleash navigates only to http and https URLs.") };
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
    `Foxleash is not allowed on ${site} in this session; call navigate with tab ${tabId} and action reload to ask the user.`,
  );
}

function pageNotWeb(tabId: number): ToolError {
  return new ToolError(
    "page_not_web",
    `Foxleash acts only on http and https pages, and tab ${tabId} shows another kind of page.`,
  );
}

function pageChanged(tabId: number): ToolError {
  return new ToolError(
    "page_changed",
    `The page in tab ${tabId} changed while Foxleash was working in it; try again.`,
  );
}

/** The refusal of a request that waited out a navigation of the tab; `ran` names an act sent. */
export function pageLoading(tabId: number, ran?: string): ToolError {
  return new ToolError(
    "page_loading",
    ran === undefined
      ? `Tab ${tabId} is still loading a page; try again.`
      : `Tab ${tabId} is still loading a page, and ${ran} may already have run; read the page before you repeat it.`,
  );
}

function probeFailed(tabId: number): ToolError {
  return new ToolError("probe_failed", `Foxleash could not run its input probe in tab ${tabId}.`);
}

function notInGroup(tabId: number): ToolError {
  return new ToolError(
    "tab_not_in_group",
    `Tab ${tabId} is not in this session's tab group; open a tab with tab_open first.`,
  );
}

/** The refusal of get_recipe and start_recipe for a name no saved recipe has. */
export function recipeNotFound(name: string): ToolError {
  return new ToolError(
    "recipe_not_found",
    `No recipe named ${JSON.stringify(recipeName(name) ?? name)} is saved. list_recipes names the saved ones.`,
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
  throw approvalPending(prompt.tabId, `whether to allow ${prompt.site}`);
}

function isReload(target: NavigationTarget): boolean {
  return target.kind === "action" && target.action === "reload";
}

/** The one that started later; of two that started together, the one reported later. */
function later(kept: TopRequest | undefined, request: TopRequest): TopRequest {
  return kept !== undefined && kept.timeStamp > request.timeStamp ? kept : request;
}
