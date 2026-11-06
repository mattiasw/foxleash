import type {
  BrowserApi,
  NavigationDetails,
  Tab,
  TabUpdatedListener,
  Timers,
} from "./browser-api.ts";
import { secondsText, ToolError } from "./handlers.ts";
import { withoutFragment } from "./site.ts";

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
 * Runs `navigate` and resolves with the tab once its load completes. `url` is the web URL the
 * navigation loads, or `undefined` when that is not known in advance (back, forward, reload).
 * Without it, the wait also ends after the grace period when no load starts, or with the tab as it
 * is after `timeoutMs`. With it, the wait resolves only once the tab's top frame committed a
 * document (a fragment navigation excepted), and fails with `navigation_timeout` when none did by
 * the timeout; a complete that leaves the tab on about:blank starts the grace period again.
 */
export function waitForLoad<Handle>(
  browser: BrowserApi,
  timers: Timers<Handle>,
  tabId: number,
  url: string | undefined,
  navigate: () => Promise<unknown>,
  timeoutMs = LOAD_TIMEOUT_MS,
): Promise<Tab> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    // The tab shows this navigation's document: its top frame committed one, or a fragment
    // navigation needed none.
    let arrived = false;
    let loadStarts = 0;
    let timeoutTimer: Handle | undefined;

    // Removed when the wait settles, so it never sees a settled wait.
    const listener: TabUpdatedListener = (_tabId, changeInfo, tab) => {
      // Firefox reports a fragment navigation as a status, loading while the page still loads.
      if (url !== undefined && fragmentNavigation(tab, url)) arrived = true;
      if (changeInfo.status === "loading") start();
      // A complete before any loading can be the end of an earlier load.
      else if (changeInfo.status === "complete" && started) {
        // Firefox can report a complete on a new tab's about:blank before the navigation's page.
        if (url !== undefined && tab.url === "about:blank") restart();
        else if (url === undefined || arrived) finish(tab);
        // Otherwise an earlier load's complete, or a load that showed no document (a 204, a URL
        // Firefox downloads), which the timeout reports.
      }
    };

    const onCommitted = (details: NavigationDetails) => {
      // Firefox's error page commits the URL that failed; a new tab's own about:blank is not the page.
      if (details.tabId !== tabId || details.frameId !== 0 || details.url === "about:blank") return;
      arrived = true;
      start();
    };

    browser.tabs.onUpdated.addListener(listener, { tabId, properties: ["status"] });
    if (url !== undefined) browser.webNavigation.onCommitted.addListener(onCommitted);
    let graceTimer = armGrace();
    // The load can finish before the navigation's promise settles, so nothing waits for it.
    (async () => navigate())().catch(fail);

    function start(): void {
      if (started) return;
      started = true;
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
      if (url !== undefined && fragmentNavigation(tab, url)) arrived = true;
      if (tab.status === "complete" && (url === undefined || arrived)) finish(tab);
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
      browser.webNavigation.onCommitted.removeListener(onCommitted);
      timers.clearTimeout(graceTimer);
      if (timeoutTimer !== undefined) timers.clearTimeout(timeoutTimer);
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
