import type {
  BrowserApi,
  NavigationDetails,
  Tab,
  TabUpdatedListener,
  Timers,
} from "./browser-api.ts";
import { secondsText, ToolError } from "./handlers.ts";
import { withoutFragment } from "./site.ts";
import type { NavigationOutcome, TabNavigations } from "./tab-navigations.ts";

/**
 * How long a navigation whose URL is not known may take to start loading before the tab counts as
 * loaded; with a known URL, when a fragment navigation, which loads nothing, counts as done.
 */
export const LOAD_GRACE_MS = 1000;
/**
 * How long a started load may take before the tab is returned as it is; with a known URL, how long
 * the navigation may take to commit before the wait fails.
 */
export const LOAD_TIMEOUT_MS = 30000;
/**
 * How long a URL load whose document is ready may take to finish before the tab is returned as it is.
 */
export const LOAD_AFTER_READY_MS = 400;

/**
 * Runs `navigate` and resolves with the tab once its load completes. `url` is the web URL the
 * navigation loads, or `undefined` when that is not known in advance (back, forward, reload).
 * Without it, the wait also ends after the grace period when no load starts, or with the tab as it
 * is after `timeoutMs` (default `LOAD_TIMEOUT_MS`). With it, the wait resolves only once the tab's
 * top frame committed a document (a fragment navigation excepted), and fails with
 * `navigation_timeout` when none did by the timeout; a complete that leaves the tab on about:blank
 * starts the grace period again. `unloaded` says the tab was one Firefox had unloaded: then only a
 * top-frame commit after the tab's onBeforeNavigate counts, since the restore commits the stored URL
 * first, and no fragment navigation is assumed, since a load into a restored tab commits even when
 * only the fragment differs. With `ready` and a URL, the wait also resolves `LOAD_AFTER_READY_MS`
 * after the DOM of the document the tab committed last is ready, as `ready.settled` reports it,
 * with the tab as it is then; a top-frame navigation that leaves the document stops that time.
 * With `commit` and no URL, a complete ends the wait only after a top-frame commit, not of
 * about:blank, that followed a top-frame onBeforeNavigate the wait heard, before or after the
 * loading status and whatever its URL; the grace ends nothing, and the timeout still returns the
 * tab as it is.
 */
export function waitForLoad<Handle>(
  browser: BrowserApi,
  timers: Timers<Handle>,
  tabId: number,
  url: string | undefined,
  navigate: () => Promise<unknown>,
  {
    timeoutMs = LOAD_TIMEOUT_MS,
    unloaded = false,
    commit = false,
    ready,
  }: {
    timeoutMs?: number;
    unloaded?: boolean;
    commit?: boolean;
    ready?: Pick<TabNavigations, "settled"> | undefined;
  } = {},
): Promise<Tab> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    // The tab shows this navigation's document: its top frame committed one, or a fragment
    // navigation needed none.
    let arrived = false;
    // The top frame committed the requested URL before any load started: this navigation's early
    // commit when loading follows it, a restore's or an earlier load's when a complete or the
    // tab's next navigation does.
    let committedBeforeLoad = false;
    let loadStarts = 0;
    // Firefox restores a tab it unloaded, committing its stored URL, before the requested
    // navigation begins. With `commit`, a commit before the navigation begins is not its own either:
    // it keeps out the document the tab showed when the wait began.
    let restoring = unloaded || commit;
    // Whether a complete can end the wait before the tab arrived.
    const anyComplete = url === undefined && !commit;
    let timeoutTimer: Handle | undefined;
    // The ask whose answer counts: the one made at the commit of the document the tab shows, until
    // a navigation leaves it.
    let readyAsk: object | undefined;
    let readyTimer: Handle | undefined;

    // Removed when the wait settles, so it never sees a settled wait.
    const listener: TabUpdatedListener = (_tabId, changeInfo, tab) => {
      // Firefox reports a fragment navigation as a status, loading while the page still loads.
      if (url !== undefined && !unloaded && fragmentNavigation(tab, url)) arrived = true;
      if (changeInfo.status === "loading") start();
      else if (changeInfo.status === "complete" && started) {
        // Firefox can report a complete on a new tab's about:blank before the navigation's page.
        if (url !== undefined && tab.url === "about:blank") restart();
        else if (anyComplete || arrived) finish(tab);
        // Otherwise an earlier load's complete, or a load that showed no document (a 204, a URL
        // Firefox downloads), which the timeout reports.
      }
      // A complete before any loading ends an earlier load, or a restore of a tab Firefox had loaded.
      else if (changeInfo.status === "complete") committedBeforeLoad = false;
    };

    const onCommitted = (details: NavigationDetails) => {
      // Firefox's error page commits the URL that failed; a new tab's own about:blank is not the page.
      if (details.tabId !== tabId || details.frameId !== 0 || details.url === "about:blank") return;
      if (restoring) return;
      // Before any loading, a commit of the URL can be a restore's, not this navigation's: it counts
      // only if loading comes next. With `commit`, the navigation began after the wait did, so its
      // commit counts whatever its URL, a redirect's included.
      if (loadStarts === 0 && !commit) {
        if (url !== undefined && withoutFragment(details.url) === withoutFragment(url)) {
          committedBeforeLoad = true;
        }
        return;
      }
      arrived = true;
      askReady();
      start();
    };

    // Restoring a tab it unloaded, Firefox commits the tab's stored URL before the requested
    // navigation begins, so a commit an onBeforeNavigate follows was not this navigation's.
    const onBeforeNavigate = (details: NavigationDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      committedBeforeLoad = false;
      // A load of about:blank in the tab is not the requested navigation; its restore may follow.
      if (details.url === "about:blank") return;
      restoring = false;
      // The page leaves the document it arrived at, as a client redirect does: the next commit asks
      // again.
      forgetReady();
    };

    browser.tabs.onUpdated.addListener(listener, { tabId, properties: ["status"] });
    if (url !== undefined || commit) {
      browser.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
      browser.webNavigation.onCommitted.addListener(onCommitted);
    }
    let graceTimer = armGrace();
    // The load can finish before the navigation's promise settles, so nothing waits for it.
    (async () => navigate())().catch(fail);

    function start(): void {
      if (started) return;
      started = true;
      if (committedBeforeLoad) {
        arrived = true;
        askReady();
      }
      loadStarts++;
      timers.clearTimeout(graceTimer);
      if (timeoutTimer !== undefined) return;
      timeoutTimer = timers.setTimeout(() => {
        if (url !== undefined && !arrived) {
          fail(
            new ToolError(
              "navigation_timeout",
              `Tab ${tabId} did not load a page from that URL within ${secondsText(timeoutMs)}.`,
            ),
          );
        } else currentTab().then(finish, fail);
      }, timeoutMs);
    }

    // Asked at a commit that makes the tab arrive: the tracker has then already taken the commit,
    // so its "ready" is this document's.
    function askReady(): void {
      if (ready === undefined) return;
      const ask = {};
      readyAsk = ask;
      ready.settled(tabId, timeoutMs).then((outcome) => {
        if (readyAsk === ask) afterReady(outcome);
      }, fail);
    }

    function forgetReady(): void {
      readyAsk = undefined;
      if (readyTimer !== undefined) timers.clearTimeout(readyTimer);
    }

    // "idle" can also mean the tracker lost this navigation to a stray complete before its commit.
    function afterReady(outcome: NavigationOutcome): void {
      if (settled || (outcome !== "ready" && outcome !== "ended")) return;
      readyTimer = timers.setTimeout(() => {
        currentTab().then(finish, fail);
      }, LOAD_AFTER_READY_MS);
    }

    function restart(): void {
      started = false;
      graceTimer = armGrace();
    }

    function armGrace(): Handle {
      return timers.setTimeout(() => {
        checkAfterGrace().catch(fail);
      }, LOAD_GRACE_MS);
    }

    // Runs only while neither settled nor started: both clear the grace timer. A load that starts
    // during the lookup makes it stale, even when a blank complete has restarted the wait since.
    async function checkAfterGrace(): Promise<void> {
      const startsBefore = loadStarts;
      const tab = await currentTab();
      if (settled || loadStarts !== startsBefore) return;
      if (url !== undefined && !unloaded && fragmentNavigation(tab, url)) arrived = true;
      if (tab.status === "complete" && (anyComplete || arrived)) finish(tab);
      else start();
    }

    async function currentTab(): Promise<Tab> {
      return browser.tabs.get(tabId);
    }

    // Settling twice is harmless: a promise keeps its first outcome, and clearing again does nothing.
    function finish(tab: Tab): void {
      cleanUp();
      resolve(tab);
    }

    function fail(error: unknown): void {
      cleanUp();
      reject(error);
    }

    function cleanUp(): void {
      settled = true;
      browser.tabs.onUpdated.removeListener(listener);
      browser.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
      browser.webNavigation.onCommitted.removeListener(onCommitted);
      timers.clearTimeout(graceTimer);
      if (timeoutTimer !== undefined) timers.clearTimeout(timeoutTimer);
      if (readyTimer !== undefined) timers.clearTimeout(readyTimer);
    }
  });
}

/**
 * Whether the tab shows `url` reached by a fragment navigation, which loads no document and so
 * never commits. Only a URL with a fragment navigates that way; a tab Firefox has not loaded carries
 * its URL as a label, and its load commits.
 */
function fragmentNavigation(tab: Tab, url: string): boolean {
  return (
    withoutFragment(url) !== url &&
    tab.discarded !== true &&
    tab.url !== undefined &&
    withoutFragment(tab.url) === withoutFragment(url)
  );
}
