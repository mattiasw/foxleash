import {
  type ActAfter,
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_WAIT_FOR_MS,
  type FoundTree,
  foundLinesOf,
  MAX_NETWORK_HEADER,
  MAX_NETWORK_PATTERN,
  MAX_NETWORK_REQUESTS,
  MAX_NETWORK_TYPES,
  MAX_RECIPE_SITES,
  MAX_WAIT_FOR_MS,
  MAX_WAIT_FOR_TEXT,
  MAX_WINDOW_SIZE,
  type MethodName,
  MIN_WAIT_FOR_MS,
  MIN_WINDOW_SIZE,
  type NavigateAction,
  type PageView,
  type ProbeResult,
  type RequestMessage,
  type Result,
  type TabInfo,
} from "@foxleash/protocol";
import type { ActSettle } from "./act-settle.ts";
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
import { READ_PAGE_MAX_CHARS, type ReadPageOptions, readPageOptions } from "./page-tree.ts";
import { type PageViews, type TreeRead, VIEW_FILTER } from "./page-view.ts";
import type { RecipePrompts } from "./recipe-prompts.ts";
import { checkRecipe, findRecipe, readRecipes, recipeName, siteOfEntry } from "./recipes.ts";
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
  /**
   * The navigations under way in each tab, which a screenshot and read_console wait for, and each
   * session's mark of its last action in a tab, which wait_for navigation reads.
   */
  navigations: Pick<TabNavigations, "settled" | "underWay" | "begun" | "acted" | "takeFinished">;
  /** The bytes upload_chunk stages; `import type`, since uploads.ts imports this file. */
  uploads: Pick<Uploads, "add" | "take">;
  /** Which tabs' console records may be read; `import type`, since it imports this file. */
  recordings: Pick<ConsoleRecording, "liveRecording">;
  /** The tabs' network requests; `import type`, since it imports this file. */
  network: Pick<NetworkLog, "read">;
  /** Saves files into the download folder; it imports this file too. */
  downloads: Pick<Downloads, "save">;
  /** The session's recipe pages; `import type`, since it imports this file. */
  recipes: Pick<RecipePrompts, "propose" | "run" | "openPrompt" | "request">;
  /** Watches the page after an act; `import type`, since it imports this file. */
  settle: Pick<ActSettle, "begin">;
  /** The views of the page that results end with, and each session's last one per tab. */
  views: Pick<PageViews, "document" | "view" | "record" | "forget">;
  /** The time in ms since the epoch, which bounds the view's read. */
  now: () => number;
}

type Params = Record<string, unknown>;

type Handlers = {
  [M in MethodName]: (session: string, params: Params, generation: number) => Promise<Result<M>>;
};

type NavigationTarget = { kind: "url"; url: string } | { kind: "action"; action: NavigateAction };

/** A navigate request as read from its params: a path is resolved once the tab is known. */
type NavigationRequest = NavigationTarget | { kind: "path"; path: string };

/** What `navigate` watched while it went back or forward. */
interface HistoryLoad {
  /**
   * False for a last top-level commit of a document the tab committed before the step, kept in
   * memory, once its grace passed with no navigation begun after it; else undefined until then,
   * or while the request of that commit has not been reported.
   */
  reloads(): boolean | undefined;
  /**
   * Whether a frame request that was not a GET started from the request of the last top-level
   * commit on, or was reported after it; true while that request is unknown.
   */
  framePosted(): boolean;
  /**
   * Whether a top-level request that was not a GET started after the last top-level commit; true
   * while no top-level commit is known.
   */
  topPosted(): boolean;
  /**
   * Starts the grace of a commit kept in memory, and resolves once a request or a grace makes
   * `reloads` defined, or after `ms`.
   */
  decided(ms: number): Promise<void>;
  /**
   * False only when `documentId` is a document the tab committed before the step that no top-level
   * commit during the step named.
   */
  shows(documentId: string | undefined): boolean;
  stop(): void;
}

/** A top-level request `navigate` saw while it went back or forward. */
interface TopRequest {
  /** Without its fragment. */
  url: string;
  timeStamp: number;
  /**
   * The earliest start time of a top-level request that was not a GET and was reported after it;
   * `Infinity` while none was.
   */
  nonGetAfter: number;
  /** Whether no frame request that was not a GET was reported after it. */
  framesOnlyGets: boolean;
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
 * request: Firefox can report it after the commit (ADR 0016 measured 211 ms). A page Firefox kept
 * in memory is told by its commit's `documentId` and waits only KEPT_GRACE_MS, within this wait
 * (ADR 0049); one Foxleash cannot tell makes no request and waits this long.
 */
export const HISTORY_REQUEST_TIMEOUT_MS = 1000;
/**
 * How long a step to a page Firefox kept in memory waits for a navigation the page begins on its
 * own, such as a reload on `pageshow`: measured 0 to 5 ms after the tab's load completed. It
 * starts when `navigate` decides, or at a later commit of such a page.
 */
export const KEPT_GRACE_MS = 200;
/**
 * The top-level documents remembered per tab to tell a page kept in memory, the least recently
 * committed dropped first. A page whose document was dropped waits HISTORY_REQUEST_TIMEOUT_MS, and
 * is not reloaded.
 */
export const KNOWN_DOCUMENTS_PER_TAB = 50;
/**
 * Bounds the wait for the load after going back or forward, so that with the step's own wait
 * (LOAD_GRACE_MS and LOAD_TIMEOUT_MS) and the waits for its request (HISTORY_REQUEST_TIMEOUT_MS,
 * twice at most), `navigate` answers below the host's 60 s request timeout.
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
/**
 * A result starts no read of its view after this long into the call: with VIEW_READ_MS, a call
 * answers within 55 s, below the host's 60 s request timeout, which shuts the host down when it
 * fires.
 */
export const VIEW_START_LIMIT_MS = 50_000;
/** Bounds the read of a result's view; see VIEW_START_LIMIT_MS. */
export const VIEW_READ_MS = 5_000;

const UNREADABLE_VIEW: PageView = { kind: "none", reason: "unreadable" };

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
  settle,
  views,
  now,
}: HandlerDeps<Handle>): (request: RequestMessage) => Promise<Result<MethodName>> {
  const frameErrors = watchFrameErrors(browser);
  const knownDocuments = watchTopDocuments(browser);
  // Tabs navigate or tab_open returned while their page still loaded, with the count of top-frame
  // navigations begun in each then: until another begins, a load that ends is the returned one.
  const returnedLoading = new Map<number, number>();
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
    sites_request: sitesRequest,
    probe_input: probeInput,
  };

  return async function handleRequest(request) {
    // Read on arrival, so a request that was running when its session ended asks nothing.
    const generation = access.generation(request.session);
    return handlers[request.method](request.session, request.params, generation);
  };

  async function tabsList(session: string): Promise<Result<"tabs_list">> {
    const group = await groups.groupOf(session);
    // Firefox's tabs.query without a groupId returns every tab in the browser.
    if (group === undefined) return { tabs: [] };
    const tabs = await browser.tabs.query({ groupId: group.id });
    const view = await access.view(session);
    return { tabs: tabs.map(view.tabInfo) };
  }

  async function tabOpen(
    session: string,
    params: Params,
    generation: number,
  ): Promise<Result<"tab_open">> {
    const started = now();
    const viewed = viewParam(params, "tab_open");
    const { tab } = await openTab(session, params, generation);
    return viewed ? { tab, view: await pageView(session, tab.id, [], started) } : { tab };
  }

  async function openTab(
    session: string,
    params: Params,
    generation: number,
  ): Promise<{ tab: TabInfo }> {
    const url = tabOpenUrl(params);
    const decision = url === undefined ? undefined : await access.check(session, url);
    if (url !== undefined && decision?.decision === "join") {
      // Waits on the session's open prompt for this site, in its tab, instead of a new tab.
      return {
        tab: await approveAndLoad(session, decision.tabId, url, { kind: "url", url }, generation),
      };
    }
    if (url !== undefined && decision?.decision === "allowed") {
      return { tab: await openOnPage(session, url) };
    }
    if (url !== undefined) return { tab: await openOnPrompt(session, url, generation) };
    const tab = await groups.createTab(session, { url: "about:blank", active: false });
    await groups.ensureGroup(session, tab);
    return { tab: await selectNewTab(session, tab.id) };
  }

  /**
   * Created unloaded on its page: Firefox gives a tab that started on about:blank an about:blank
   * history entry after its page when it unloads and restores it. Grouped before its page loads,
   * so the page never loads outside the session's group. Loaded before it is selected: selecting
   * a tab Firefox has not loaded restores its page as a history load, which shows the cached copy
   * without asking the server unless the response was `no-store`. Not selected while the session
   * is asking the user something.
   */
  async function openOnPage(session: string, url: string): Promise<TabInfo> {
    const tab = await groups.createTab(session, { url, active: false, discarded: true });
    try {
      await groups.ensureGroup(session, tab);
    } catch (error) {
      // Selected outside the group, it would load the page there.
      await removeNewTab(session, tab.id);
      throw error;
    }
    try {
      noteReturned(
        await waitForLoad(
          browser,
          timers,
          tab.id,
          url,
          () => browser.tabs.update(tab.id, { url, loadReplace: true }),
          { unloaded: true, ready: navigations },
        ),
      );
    } catch (error) {
      // Never selected, it holds nothing the user saw.
      await removeNewTab(session, tab.id);
      throw error;
    }
    return selectNewTab(session, tab.id);
  }

  /**
   * Created unloaded on its prompt page, as `openOnPage`'s tab is on its page, so Firefox's unload
   * and restore add no about:blank entry; grouped before the prompt loads. A tab the prompt was
   * not shown in (its site allowed meanwhile) loads the page and is then selected, as
   * `openOnPage`'s is, unless the session is asking the user something.
   */
  async function openOnPrompt(session: string, url: string, generation: number): Promise<TabInfo> {
    const promptUrl = access.newPromptUrl();
    const tab = await groups.createTab(session, {
      url: promptUrl,
      active: false,
      discarded: true,
    });
    let approval: Approval;
    try {
      await groups.ensureGroup(session, tab);
      approval = await access.ask(session, url, tab.id, { generation, promptUrl });
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
    return selectNewTab(session, tab.id);
  }

  /**
   * Selects a tab tab_open opened, unless the session's question is open in a tab, which would
   * then be hidden. The check and the select start in the same turn, with no await in between.
   */
  async function selectNewTab(session: string, tabId: number): Promise<TabInfo> {
    const tab = asking(session)
      ? await browser.tabs.get(tabId)
      : await browser.tabs.update(tabId, { active: true });
    return (await access.view(session)).tabInfo(tab);
  }

  /** Whether the session's site prompt or recipe page is open. */
  function asking(session: string): boolean {
    return access.openPrompt(session) !== undefined || recipes.openPrompt(session) !== undefined;
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

  async function navigate(
    session: string,
    params: Params,
    generation: number,
  ): Promise<Result<"navigate">> {
    const started = now();
    const viewed = viewParam(params, "navigate");
    const { tab } = await navigateTab(session, params, generation);
    return viewed ? { tab, view: await pageView(session, tab.id, [], started) } : { tab };
  }

  async function navigateTab(
    session: string,
    params: Params,
    generation: number,
  ): Promise<{ tab: TabInfo }> {
    const tabId = tabIdParam(params, "navigate");
    const request = navigationTarget(params);
    const tab = await existingTab(tabId);
    const group = await groups.groupOf(session);
    if (group === undefined || tab.groupId !== group.id) throw notInGroup(tabId);
    try {
      const prompt = access.openPrompt(session);
      const asked = access.askedUrl(session, tab);
      // On a prompt's tab, a path is on the site the prompt asks about.
      const page = prompt?.tabId === tabId ? prompt.url : (asked ?? tab.url);
      const target: NavigationTarget =
        request.kind === "path" ? { kind: "url", url: pathUrl(request.path, page) } : request;
      // A request on the prompt's own tab goes through the prompt, so Foxleash never leaves it.
      if (prompt?.tabId === tabId) {
        const url = retryUrl(prompt, target);
        return { tab: await approveAndLoad(session, tabId, url, { kind: "url", url }, generation) };
      }
      // On a prompt the user has answered, a reload loads the page it asked about, and a URL loads
      // in the prompt's place in the tab's history.
      const url = target.kind === "url" ? target.url : isReload(target) ? asked : undefined;
      if (asked !== undefined && url !== undefined) {
        return { tab: await approveAndLoad(session, tabId, url, { kind: "url", url }, generation) };
      }
      const gated = await gate(session, tab, target);
      if (gated !== undefined && gated.decision.decision !== "allowed") {
        return { tab: await approveAndLoad(session, tabId, gated.url, target, generation) };
      }
      keepPrompt(session, tabId);
      const history =
        target.kind === "action" && target.action !== "reload"
          ? watchHistoryLoad(tabId)
          : undefined;
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
                { unloaded: tab.discarded === true, ready: navigations },
              );
        noteReturned(loaded);
        const shown =
          history === undefined ? loaded : await reloadHistoryLoad(session, tabId, loaded, history);
        if (shown !== loaded) noteReturned(shown);
        const view = await access.view(session);
        return { tab: view.tabInfo(shown) };
      } finally {
        history?.stop();
      }
    } finally {
      // Its own load is in its result: only a navigation after it returns counts for wait_for.
      navigations.acted(session, tabId);
    }
  }

  /**
   * Notes a tab's top-level commits and navigations and its top-level and frame requests until
   * `stop`, with their start times: Firefox can report a document's own request after its commit
   * (ADR 0016), so they are matched by time, not by the order they arrive in. It `reloads` when
   * the last top-level request started by the tab's last top-level commit is for the commit's URL,
   * and no top-level request that started from that request on, or was reported after it, was not
   * a GET, counting only those that started no later than the commit current when it is asked;
   * `topPosted` tells whether one started after it (ADR 0053), `framePosted` whether a frame
   * request was not a GET (ADR 0052). A commit of a document the tab committed before the step was
   * kept in memory: it reloads nothing once KEPT_GRACE_MS passed with no top-level navigation begun
   * after it, by the order Firefox reports them. The grace starts when `navigate` decides, or at a
   * later such commit (ADR 0049).
   */
  function watchHistoryLoad(tabId: number): HistoryLoad {
    // A copy: the record hears each commit before the listener below does.
    const known = knownDocuments(tabId);
    let commit:
      | {
          url: string;
          timeStamp: number;
          documentId: string | undefined;
          kept: boolean;
          graced: boolean;
        }
      | undefined;
    // The documents of the top-level commits since the step began.
    const committed = new Set<string>();
    let begun = false;
    let deciding = false;
    let grace: Handle | undefined;
    // The latest top-level request started by the commit, and the latest one reported before any
    // commit or started after the one it was reported after.
    let byCommit: TopRequest | undefined;
    let next: TopRequest | undefined;
    // The start times of the top-level requests that were not a GET.
    const topNonGets: number[] = [];
    let frameNonGetStarted = Number.NEGATIVE_INFINITY;
    let wake: (() => void) | undefined;
    const onRequest = (details: RequestDetails) => {
      if (details.tabId !== tabId) return;
      const top = details.type === "main_frame";
      if (details.method !== "GET") {
        if (top) {
          topNonGets.push(details.timeStamp);
          if (byCommit !== undefined) {
            byCommit.nonGetAfter = Math.min(byCommit.nonGetAfter, details.timeStamp);
          }
          if (next !== undefined) next.nonGetAfter = Math.min(next.nonGetAfter, details.timeStamp);
        } else if (
          // Firefox reports a load in an <object> element's frame as an object request.
          details.type === "sub_frame" ||
          details.type === "object"
        ) {
          frameNonGetStarted = Math.max(frameNonGetStarted, details.timeStamp);
          if (byCommit !== undefined) byCommit.framesOnlyGets = false;
          if (next !== undefined) next.framesOnlyGets = false;
        }
      }
      if (!top) return;
      const request = {
        url: withoutFragment(details.url),
        timeStamp: details.timeStamp,
        nonGetAfter: Number.POSITIVE_INFINITY,
        framesOnlyGets: true,
      };
      if (commit !== undefined && request.timeStamp <= commit.timeStamp) {
        byCommit = later(byCommit, request);
      } else {
        next = later(next, request);
      }
      wake?.();
    };
    // The commit's URL, not the tab's: the page can change its address with the History API.
    // A commit does not wake the wait: its own request, a POST perhaps, can be reported after it.
    const onCommit = (details: NavigationDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      const { documentId } = details;
      if (documentId !== undefined) committed.add(documentId);
      commit = {
        url: withoutFragment(details.url),
        timeStamp: details.timeStamp,
        documentId,
        kept: documentId !== undefined && known.has(documentId),
        graced: false,
      };
      begun = false;
      if (next !== undefined && next.timeStamp <= commit.timeStamp) {
        byCommit = later(byCommit, next);
      }
      startGrace();
    };
    const onNavigate = (details: NavigationDetails) => {
      if (details.tabId === tabId && details.frameId === 0) begun = true;
    };
    browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] });
    browser.webNavigation.onCommitted.addListener(onCommit);
    browser.webNavigation.onBeforeNavigate.addListener(onNavigate);
    return {
      reloads,
      framePosted: () =>
        byCommit?.framesOnlyGets !== true || frameNonGetStarted >= byCommit.timeStamp,
      topPosted: () => {
        const last = commit;
        return last === undefined || topNonGets.some((started) => started > last.timeStamp);
      },
      decided: (ms) => {
        deciding = true;
        startGrace();
        return new Promise((resolve) => {
          const timer = timers.setTimeout(done, ms);
          wake = () => {
            if (reloads() !== undefined) done();
          };
          function done(): void {
            timers.clearTimeout(timer);
            resolve();
          }
        });
      },
      shows: (documentId) =>
        documentId === undefined ||
        commit?.documentId === undefined ||
        !known.has(documentId) ||
        // One that also committed during the step: the frames may predate a later commit.
        committed.has(documentId),
      stop: () => {
        browser.webRequest.onBeforeRequest.removeListener(onRequest);
        browser.webNavigation.onCommitted.removeListener(onCommit);
        browser.webNavigation.onBeforeNavigate.removeListener(onNavigate);
        if (grace !== undefined) timers.clearTimeout(grace);
      },
    };

    function reloads(): boolean | undefined {
      // No commit: the step loaded no document. webRequest sees no page off the web.
      if (commit === undefined || siteOf(commit.url) === undefined) return false;
      // Before the request: one for the address of a document kept in memory loaded no document.
      if (commit.kept) return commit.graced && !begun ? false : undefined;
      // Firefox can report the page's own request late (ADR 0016).
      if (byCommit?.url !== commit.url) return undefined;
      // A request that started after the commit cannot be the request of the document shown.
      const first = byCommit.timeStamp;
      const last = commit.timeStamp;
      return (
        byCommit.nonGetAfter > last &&
        !topNonGets.some((started) => started >= first && started <= last)
      );
    }

    /** Gives the last commit, once `navigate` decides and if it was kept, its grace. */
    function startGrace(): void {
      if (grace !== undefined) timers.clearTimeout(grace);
      const shown = commit;
      if (!deciding || shown?.kept !== true) return;
      grace = timers.setTimeout(() => {
        shown.graced = true;
        wake?.();
      }, KEPT_GRACE_MS);
    }
  }

  /**
   * Loads the address again of a page that going back or forward loaded again instead of taking
   * it from the back-forward cache: Firefox puts field values back into such a page without its
   * autofill mark (ADR 0025). The load is a GET that replaces the history entry, so it restores no
   * field value and sends no form again, also not a frame's; an address with a fragment would be a
   * fragment navigation, so it is reloaded without the cache instead (ADR 0051). Only in the
   * session's group, off its prompt, on a site it may act on, unless the tab shows a document from
   * before the step that no commit during the step named, never after a top-level request that was
   * not a GET by the commit, and for an address with a fragment also never after a frame's, a
   * top-level one after the commit, or a load its timeout cut off (ADR 0052, 0053). A page kept in
   * memory waits KEPT_GRACE_MS for a navigation of its own, which is then decided on as a page
   * loaded again, also one the tab commits while it is read before the load (ADR 0049).
   */
  async function reloadHistoryLoad(
    session: string,
    tabId: number,
    loaded: Tab,
    history: HistoryLoad,
  ): Promise<Tab> {
    // Twice at most: a commit heard while the tab is read, of a page kept in memory perhaps, is
    // decided once more.
    for (let decisions = 0; decisions < 2; decisions += 1) {
      if (history.reloads() === undefined) await history.decided(HISTORY_REQUEST_TIMEOUT_MS);
      if (history.reloads() !== true) return loaded;
      const group = await groups.groupOf(session);
      const view = await access.view(session);
      const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => null);
      const tab = await existingTab(tabId);
      // No await from here to the load, so a request the page sends meanwhile still counts.
      const reloads = history.reloads();
      if (reloads === undefined) continue;
      const url = tab.url ?? "";
      const fragment = withoutFragment(url) !== url;
      if (
        !reloads ||
        (fragment &&
          // A load cut off by its timeout may not have requested its frames yet, POSTs among them.
          (loaded.status !== "complete" ||
            history.framePosted() ||
            // The reload reloads the entry the tab shows, which a POST sent after the commit may
            // have replaced unheard.
            history.topPosted())) ||
        // A page restored from memory may commit nothing: the tab must not show it.
        !history.shows(frames?.find((frame) => frame.frameId === 0)?.documentId) ||
        group === undefined ||
        tab.groupId !== group.id ||
        access.openPrompt(session)?.tabId === tabId ||
        !view.allowed(url)
      ) {
        return loaded;
      }
      history.stop();
      // No URL to wait for, so that a redirect still ends the wait; it still needs the load's
      // commit, so that the complete of a load stopped or cut off before it does not end it.
      return waitForLoad(
        browser,
        timers,
        tabId,
        undefined,
        fragment
          ? () => browser.tabs.reload(tabId, { bypassCache: true })
          : () => browser.tabs.update(tabId, { url, loadReplace: true }),
        { timeoutMs: HISTORY_RELOAD_TIMEOUT_MS, commit: true },
      );
    }
    return loaded;
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
    keepPromptInView(session, tabId);
    const updated = await browser.tabs.update(tabId, { active: true });
    const view = await access.view(session);
    return { tab: view.tabInfo(updated) };
  }

  /**
   * Waits until the page in a tab of the session's group shows a text or has an element matching
   * a selector, read through the content script after the site gate, or until a navigation in the
   * tab finishes; a navigation that began and finished since the session's last action in the
   * tab, and that no earlier wait returned for, counts at once. The tab must still be in the group
   * when the wait ends.
   */
  async function waitFor(session: string, params: Params): Promise<Result<"wait_for">> {
    const started = now();
    const viewed = viewParam(params, "wait_for");
    const { tab } = await waitInTab(session, params);
    return viewed ? { tab, view: await pageView(session, tab.id, [], started) } : { tab };
  }

  async function waitInTab(session: string, params: Params): Promise<{ tab: TabInfo }> {
    const tabId = tabIdParam(params, "wait_for");
    const condition = waitCondition(params);
    const timeoutMs = waitTimeoutMs(params);
    if ("navigation" in condition) {
      // Checked in the same turn as the wait's listeners go in, so no navigation falls between. A
      // navigation under way is waited for, as before; the take after it spends what finished.
      if (navigations.underWay(tabId) || !navigations.takeFinished(session, tabId)) {
        // Until another navigation begins, a load that ends is the one navigate or tab_open
        // returned the tab during, which is in their result.
        const returned = returnedLoading.get(tabId);
        const outcome = await waitForNavigation(
          { browser, timers },
          tabId,
          timeoutMs,
          () => groupTab(session, tabId),
          () => navigations.begun(tabId) !== returned,
        );
        if (outcome === "closed") throw tabNotFound(tabId);
        if (outcome === "timeout") {
          throw new ToolError(
            "wait_timeout",
            `Tab ${tabId} did not finish a navigation within ${secondsText(timeoutMs)}.`,
          );
        }
        // Spends the navigation this wait returned for: the tracker's listeners, added first,
        // have numbered it.
        navigations.takeFinished(session, tabId);
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
    const before = views.document(tabId);
    const reply = await pages.request(session, tabId, "read_page", options);
    const { tree, truncated } = treeReadOf(reply, tabId);
    if (options.find === undefined) {
      // What the model now has of the page: the next view says what changed since.
      if (isWholeView(options)) views.record(session, tabId, before, { tree, truncated });
      return { tree, truncated };
    }
    const found = foundLinesOf(
      isRecord(reply) ? ownField(reply, "found") : undefined,
      tree,
      truncated,
    );
    if (found === undefined) throw pageError(tabId);
    if (options.finds === undefined) return { tree, truncated, found };
    return { tree, truncated, found, finds: foundTreesOf(reply, options.finds.length, tabId) };
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
    const started = now();
    const viewed = viewParam(params, "upload_file");
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
    const watch = settle.begin(session, tabId);
    let result: Result<"upload_file"> & { after: ActAfter };
    try {
      const reply = await pages.request(session, tabId, "upload_file", { ref, files: handed }, () =>
        watch.sent(),
      );
      // The reply comes from the page's content process: only its own target is read.
      const target = isRecord(reply) ? ownField(reply, "target") : undefined;
      if (target !== "input" && target !== "drop") {
        throw new ToolError(
          "page_error",
          `Foxleash could not complete the request in the page in tab ${tabId}.`,
        );
      }
      const listed = files.map(({ name, size }) => ({ name, size }));
      result = { target, files: listed, after: await watch.after(reply) };
    } finally {
      watch.stop();
    }
    return viewed ? withActView(session, tabId, result, [ref], started) : result;
  }

  /**
   * Acts in a page through the content script, which runs only after the site gate: the tool's
   * options parsed here and again in the page, and the page's reply checked. Then waits for the
   * page to settle, and adds what followed the act.
   */
  async function pageAction<O extends Params, R>(
    session: string,
    params: Params,
    tool: "click" | "hover" | "scroll" | "drag" | "type" | "press_key" | "fill_form",
    parse: (params: Params) => O | string,
    check: (reply: unknown, options: O) => R | undefined,
  ): Promise<R & { after: ActAfter; view?: PageView }> {
    const started = now();
    const viewed = viewParam(params, tool);
    const tabId = tabIdParam(params, tool);
    const options = parse(params);
    if (typeof options === "string") throw new ToolError("invalid_params", options);
    const watch = settle.begin(session, tabId);
    let result: R & { after: ActAfter };
    try {
      const reply = await pages.request(session, tabId, tool, options, () => {
        navigations.acted(session, tabId);
        watch.sent();
      });
      // The reply comes from the page's content process: own fields only, of exact types.
      const checked = check(reply, options);
      if (checked === undefined) {
        throw new ToolError(
          "page_error",
          `Foxleash could not complete the request in the page in tab ${tabId}.`,
        );
      }
      result = { ...checked, after: await watch.after(reply) };
    } finally {
      watch.stop();
    }
    return viewed
      ? withActView(session, tabId, result, actFocus(options, result), started)
      : result;
  }

  /**
   * The act's result with the view of the page after it: none once the tab closed, and no read
   * while the tab still loads another page, which would wait for the load past VIEW_READ_MS.
   */
  async function withActView<R extends { after: ActAfter }>(
    session: string,
    tabId: number,
    result: R,
    focus: readonly string[],
    started: number,
  ): Promise<R & { view?: PageView }> {
    const { page } = result.after;
    if (page === "closed") return result;
    const view: PageView =
      page === "loading"
        ? { kind: "none", reason: "loading" }
        : await pageView(session, tabId, focus, started);
    return { ...result, view };
  }

  /**
   * The view of the page in the tab, read as read_page reads it, through the same gate. Never
   * rejects: the call's own result stands whatever the view's read does.
   */
  async function pageView(
    session: string,
    tabId: number,
    focus: readonly string[],
    started: number,
  ): Promise<PageView> {
    if (now() - started > VIEW_START_LIMIT_MS) return UNREADABLE_VIEW;
    const before = views.document(tabId);
    let read: TreeRead;
    try {
      read = await viewRead(session, tabId);
    } catch (error: unknown) {
      return refusedView(session, tabId, error);
    }
    return views.view(session, tabId, before, read, focus);
  }

  /** The tree the view shows, within VIEW_READ_MS; not an act, so wait_for's mark stays. */
  async function viewRead(session: string, tabId: number): Promise<TreeRead> {
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(
      () => reject(new Error("The view's read timed out.")),
      VIEW_READ_MS,
    );
    try {
      const reply = await Promise.race([
        pages.request(session, tabId, "read_page", { filter: VIEW_FILTER }),
        timedOut,
      ]);
      return treeReadOf(reply, tabId);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  /**
   * The view after a failed read: a page the session may not read gives its site alone, as
   * tabs_list shows it, and the memory of it is dropped.
   */
  async function refusedView(session: string, tabId: number, error: unknown): Promise<PageView> {
    const code = error instanceof ToolError ? error.code : undefined;
    if (code === "page_not_web") {
      views.forget(session, tabId);
      return { kind: "none", reason: "not_web" };
    }
    if (code !== "site_not_approved" && code !== "site_blocked") return UNREADABLE_VIEW;
    views.forget(session, tabId);
    try {
      const tab = await groupTab(session, tabId);
      const view = await access.view(session);
      return { kind: "site", url: view.tabInfo(tab).url };
    } catch {
      return UNREADABLE_VIEW;
    }
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
    return result.recording ? { ...result, since: live.since } : result;
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
    if (isSitePath(url)) {
      throw new ToolError(
        "invalid_url",
        "download needs a whole http or https URL. An address starting with / from read_page is on the site of the page it was read from: put that site in front of it.",
      );
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

  /**
   * Asks the user to allow the sites an agent named for the session, on the run page; each entry
   * reduced to its site as a recipe's are, duplicates collapsed, in the agent's order.
   */
  async function sitesRequest(session: string, params: Params): Promise<Result<"sites_request">> {
    const given = own(params, "sites");
    if (!Array.isArray(given)) {
      throw new ToolError("invalid_params", "request_sites needs sites to be a list of addresses.");
    }
    const entries: unknown[] = given;
    const sites = new Set<string>();
    // By index, so a hole reads as undefined and is refused.
    for (let index = 0; index < entries.length; index++) {
      const site = requestedSite(entries[index]);
      if (typeof site !== "string") {
        throw new ToolError(
          "invalid_params",
          `request_sites was refused: entry ${index + 1}: ${site.problem}`,
        );
      }
      sites.add(site);
      if (sites.size > MAX_RECIPE_SITES) {
        throw new ToolError(
          "invalid_params",
          `request_sites was refused: it names more than ${MAX_RECIPE_SITES} sites; ask for at most ${MAX_RECIPE_SITES}.`,
        );
      }
    }
    if (sites.size === 0) {
      throw new ToolError(
        "invalid_params",
        "request_sites was refused: name at least one site, such as https://example.com.",
      );
    }
    return recipes.request(session, [...sites]);
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
    generation: number,
  ): Promise<TabInfo> {
    const { answer } = await access.ask(session, url, tabId, { generation });
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
            // A reload through a prompt waits for the whole page, as every reload does.
            {
              unloaded: tab.discarded === true,
              ready: target.kind === "url" ? navigations : undefined,
            },
          );
    noteReturned(loaded);
    const after = await access.view(session);
    return after.tabInfo(loaded);
  }

  /** Notes a tab a load returned while its page still loads, for wait_for. */
  function noteReturned(tab: Tab): void {
    // A note left from an earlier load never matches again: each load begins a navigation.
    if (tab.status !== "complete") returnedLoading.set(tab.id, navigations.begun(tab.id));
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
    const page = recipes.openPrompt(session);
    if (page?.tabId === tabId) {
      throw new ToolError(
        "recipe_prompt_open",
        `Foxleash is asking the user in tab ${tabId} ${page.question}; leave that tab open.`,
      );
    }
  }

  /**
   * Refuses selecting any tab but the one showing the session's open prompt or recipe page, which
   * would hide the user's question behind a page the agent chose. Called right before the select
   * starts, with no await in between.
   */
  function keepPromptInView(session: string, tabId: number): void {
    const shown = access.openPrompt(session);
    if (shown !== undefined && shown.tabId !== tabId)
      throw approvalPending(shown.tabId, `whether to allow ${shown.site}`);
    const page = recipes.openPrompt(session);
    if (page !== undefined && page.tabId !== tabId) {
      throw new ToolError(
        "recipe_prompt_open",
        `Foxleash is still asking the user in tab ${page.tabId} ${page.question}. Try again after the user has answered there.`,
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

/**
 * Remembers, per tab, the top-level web documents Firefox reported committing, at most
 * KNOWN_DOCUMENTS_PER_TAB, the least recently committed dropped first, and gives a copy of a
 * tab's. Adds its listeners at once.
 */
function watchTopDocuments(
  browser: Pick<BrowserApi, "webNavigation" | "tabs">,
): (tabId: number) => Set<string> {
  const tabs = new Map<number, Set<string>>();

  browser.webNavigation.onCommitted.addListener(record);
  browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

  return (tabId) => new Set(tabs.get(tabId));

  function record({ tabId, frameId, documentId, url }: NavigationDetails): void {
    if (frameId !== 0 || typeof documentId !== "string" || siteOf(url) === undefined) return;
    let documents = tabs.get(tabId);
    if (documents === undefined) {
      documents = new Set();
      tabs.set(tabId, documents);
    }
    // Last in the set's insertion order, also when Firefox commits it again.
    documents.delete(documentId);
    documents.add(documentId);
    if (documents.size > KNOWN_DOCUMENTS_PER_TAB) {
      const oldest = documents.values().next();
      if (!oldest.done) documents.delete(oldest.value);
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
  if (isSitePath(url)) {
    throw new ToolError(
      "invalid_url",
      "tab_open needs a whole http or https URL. An address starting with / from read_page is on the site of the page it was read from: put that site in front of it, or use navigate in that page's tab.",
    );
  }
  return webUrl(url, "Foxleash opens only http and https URLs, or about:blank.");
}

/** An address starting with a single /, as read_page shows a link to the page's own site. */
function isSitePath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
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

/** Whether the result ends with a view of the page: unless the view param is false. */
function viewParam(params: Params, method: string): boolean {
  return flagParam(params, method, "view", true);
}

/** A read_page reply from the page's content process: own fields only, and the cap again. */
function treeReadOf(reply: unknown, tabId: number): TreeRead {
  const tree = isRecord(reply) ? ownField(reply, "tree") : undefined;
  const truncated = isRecord(reply) ? ownField(reply, "truncated") : undefined;
  if (
    typeof tree !== "string" ||
    tree.length > READ_PAGE_MAX_CHARS ||
    typeof truncated !== "boolean"
  ) {
    throw pageError(tabId);
  }
  return { tree, truncated };
}

/** The answers in a read_page reply's finds, `count` of them, each checked as a find's reply is. */
function foundTreesOf(reply: unknown, count: number, tabId: number): FoundTree[] {
  const finds = isRecord(reply) ? ownField(reply, "finds") : undefined;
  // The length first: a sparse array can claim billions of entries.
  if (!Array.isArray(finds) || finds.length !== count) throw pageError(tabId);
  return Array.from(finds, (part: unknown) => {
    const { tree, truncated } = treeReadOf(part, tabId);
    const found = foundLinesOf(
      isRecord(part) ? ownField(part, "found") : undefined,
      tree,
      truncated,
    );
    if (found === undefined) throw pageError(tabId);
    return { tree, truncated, found };
  });
}

function pageError(tabId: number): ToolError {
  return new ToolError(
    "page_error",
    `Foxleash could not complete the request in the page in tab ${tabId}.`,
  );
}

/** Whether a read_page without find reads what a view reads: the whole document, in its filter. */
function isWholeView(options: ReadPageOptions): boolean {
  return options.filter === VIEW_FILTER && options.ref === undefined && options.depth === undefined;
}

/** The refs an act aimed at, from its options and its result: ref, targetRef and each field's. */
function actFocus(options: object, result: object): string[] {
  const refs: unknown[] = [];
  for (const source of [options, result]) {
    refs.push(ownField(source, "ref"), ownField(source, "targetRef"));
    const fields = ownField(source, "fields");
    if (!Array.isArray(fields)) continue;
    for (const field of fields) if (isRecord(field)) refs.push(ownField(field, "ref"));
  }
  return refs.filter((ref) => typeof ref === "string");
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

const HOST_LABEL = /^[a-z0-9_-]{1,63}$/;

/** A request_sites entry's site, or why it is refused. */
function requestedSite(entry: unknown): string | { problem: string } {
  const site = siteOfEntry(entry);
  if (site === undefined) return { problem: "this entry is blank." };
  if (typeof site !== "string") return site;
  // The page shows each host as it is: punctuation that no domain name has would let the agent
  // write sentences there. The URL parser writes an IPv6 host in brackets.
  const host = URL.parse(site)?.hostname ?? "";
  if (!host.startsWith("[") && !host.split(".").every((label) => HOST_LABEL.test(label))) {
    return { problem: "this address's host is not a domain name or an IP address." };
  }
  return site;
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

/**
 * read_network's options: pattern and types only when given, failed, headers and body false
 * unless true, the limit's default filled in.
 */
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
  const types = networkTypes(params);
  const failed = flagParam(params, "read_network", "failed", false);
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
  const headers = flagParam(params, "read_network", "headers", false);
  const body = flagParam(params, "read_network", "body", false);
  const options: NetworkReadOptions = { failed, headers, body, limit };
  if (pattern !== undefined) options.pattern = pattern;
  if (types !== undefined) options.types = types;
  return options;
}

/** read_network's types, copied; the count is checked before any entry is read. */
function networkTypes(params: Params): string[] | undefined {
  const given = own(params, "types");
  if (given === undefined) return undefined;
  const message = `read_network needs types to be a list of 1 to ${MAX_NETWORK_TYPES} resource types, each text of 1 to ${MAX_NETWORK_HEADER.toLocaleString("en-US")} characters.`;
  if (!Array.isArray(given) || given.length < 1 || given.length > MAX_NETWORK_TYPES) {
    throw new ToolError("invalid_params", message);
  }
  const entries: unknown[] = given;
  const types: string[] = [];
  // By index, so a hole reads as undefined and is refused.
  for (let index = 0; index < entries.length; index++) {
    const type = entries[index];
    if (typeof type !== "string" || type.length < 1 || type.length > MAX_NETWORK_HEADER) {
      throw new ToolError("invalid_params", message);
    }
    types.push(type);
  }
  return types;
}

/** A true-or-false param: `fallback` when absent. */
function flagParam(params: Params, method: string, key: string, fallback: boolean): boolean {
  const flag = own(params, key);
  if (flag === undefined) return fallback;
  if (flag === true || flag === false) return flag;
  throw new ToolError("invalid_params", `${method} needs ${key} to be true or false.`);
}

function navigationTarget(params: Params): NavigationRequest {
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
    if (isSitePath(url)) return { kind: "path", path: url };
    return { kind: "url", url: webUrl(url, "Foxleash navigates only to http and https URLs.") };
  }
  if (!hasAction) throw new ToolError("invalid_params", "navigate needs a url or an action.");
  const action = params.action;
  if (!isNavigateAction(action)) {
    throw new ToolError("invalid_params", "action must be back, forward or reload.");
  }
  return { kind: "action", action };
}

/**
 * The address of a path on the site of the tab's page. Resolved against the page's origin, so
 * nothing else of the page's URL, such as a user name, is carried over.
 */
function pathUrl(path: string, tabUrl: string | undefined): string {
  const page = tabUrl === undefined || siteOf(tabUrl) === undefined ? null : URL.parse(tabUrl);
  if (page === null) {
    throw new ToolError(
      "invalid_url",
      "navigate takes an address starting with / only in a tab that shows an http or https page; give the whole URL.",
    );
  }
  const leaving =
    "An address starting with / must stay on the site the tab shows; give the whole URL.";
  const href = webUrl(path, leaving, page.origin);
  // A backslash, tab or newline after the / can make the parser read another host.
  if (URL.parse(href)?.origin !== page.origin) throw new ToolError("invalid_url", leaving);
  return href;
}

/** The parsed href, so the URL that was checked is the URL that is opened. */
function webUrl(url: string, refusal: string, base?: string): string {
  const parsed = URL.parse(url, base);
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
