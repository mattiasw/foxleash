import type {
  BrowserApi,
  NavigationDetails,
  Tab,
  TabUpdatedListener,
  Timers,
} from "./browser-api.ts";

/** How long a navigation may take to start loading before the tab counts as loaded. */
export const LOAD_GRACE_MS = 1000;
/** How long a started load may take before the tab is returned as it is. */
export const LOAD_TIMEOUT_MS = 30000;

/**
 * Runs `navigate` and resolves with the tab once its load completes, or after the grace period
 * when no load starts, or as it is after `timeoutMs`. `url` is the web URL the navigation loads,
 * or `undefined` when that is not known in advance (back, forward, reload). When it is given, a
 * complete that leaves the tab on about:blank starts the grace period again instead of ending the
 * wait.
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
    let loadStarts = 0;
    let timeoutTimer: Handle | undefined;

    // Removed when the wait settles, so it never sees a settled wait.
    const listener: TabUpdatedListener = (_tabId, changeInfo, tab) => {
      if (changeInfo.status === "loading") start();
      // A complete before any loading can be the end of an earlier load.
      else if (changeInfo.status === "complete" && started) {
        // Firefox can report a complete on a new tab's about:blank before the navigation's page.
        if (url !== undefined && tab.url === "about:blank") restart();
        else finish(tab);
      }
    };

    browser.tabs.onUpdated.addListener(listener, { tabId, properties: ["status"] });
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
        currentTab().then(finish, fail);
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
      if (tab.status === "complete") finish(tab);
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
      timers.clearTimeout(graceTimer);
      if (timeoutTimer !== undefined) timers.clearTimeout(timeoutTimer);
    }
  });
}

/** How long tab_open waits for a new tab's own about:blank load to commit (measured: < 0.1 s). */
export const BLANK_COMMIT_TIMEOUT_MS = 1000;

/** What `watchBlankCommits` returns. */
export interface BlankCommits {
  /**
   * Resolves once the tab's top frame has committed about:blank, or after `timeoutMs`. One call
   * per watcher.
   */
  committed(tabId: number, timeoutMs?: number): Promise<void>;
  /** Removes the listener and settles a `committed` call still pending, clearing its timer. */
  stop(): void;
}

/**
 * Notes every tab whose top frame commits about:blank, from now until `stop`. Firefox loads
 * about:blank into a tab that `tabs.create` opens on it, and a load started in the tab before that
 * load commits can see it commit after its own page, which leaves an about:blank history entry
 * after the page as the current one. The tab's `status: complete` comes before that commit.
 */
export function watchBlankCommits<Handle>(
  browser: BrowserApi,
  timers: Timers<Handle>,
): BlankCommits {
  const committedTabs = new Set<number>();
  let pending: { tabId: number; timer: Handle; resolve: () => void } | undefined;

  const listener = (details: NavigationDetails) => {
    if (details.frameId !== 0 || details.url !== "about:blank") return;
    committedTabs.add(details.tabId);
    if (pending?.tabId === details.tabId) settle();
  };
  browser.webNavigation.onCommitted.addListener(listener);

  return {
    committed: (tabId, timeoutMs = BLANK_COMMIT_TIMEOUT_MS) => {
      if (committedTabs.has(tabId)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      pending = { tabId, timer: timers.setTimeout(settle, timeoutMs), resolve };
      return promise;
    },
    stop: () => {
      browser.webNavigation.onCommitted.removeListener(listener);
      settle();
    },
  };

  function settle(): void {
    if (pending === undefined) return;
    timers.clearTimeout(pending.timer);
    pending.resolve();
    pending = undefined;
  }
}
