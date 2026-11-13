import type { BrowserApi, NavigationDetails, Timers } from "./browser-api.ts";
import type { PageScripts } from "./page-scripts.ts";

/** How long wait_for sleeps between two checks of a page. */
export const WAIT_POLL_MS = 250;

// A document in transition, as during a navigation, fails a request with one of these.
const RETRIED: readonly unknown[] = [
  "page_changed",
  "page_unreachable",
  "page_timeout",
  "page_loading",
];

/**
 * Asks the content script in the tab whether the page shows the text or has an element matching
 * the selector, every WAIT_POLL_MS, until it answers true (resolves true) or `timeoutMs` passes
 * (resolves false, or rejects with the last poll's error when that was a retried one). Any
 * other error rejects at once. A request still in flight at the deadline is not waited for.
 */
export function waitForPage<Handle>(
  { pages, timers }: { pages: Pick<PageScripts, "request">; timers: Timers<Handle> },
  session: string,
  tabId: number,
  check: { text: string } | { selector: string },
  timeoutMs: number,
): Promise<boolean> {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  let settled = false;
  let retried: { error: unknown } | undefined;
  let sleep: Handle | undefined;
  const deadline = timers.setTimeout(() => {
    if (retried === undefined) finish(() => resolve(false));
    else {
      const { error } = retried;
      finish(() => reject(error));
    }
  }, timeoutMs);
  void poll();
  return promise;

  async function poll(): Promise<void> {
    try {
      const reply = await pages.request(session, tabId, "wait_for", check);
      if (settled) return;
      retried = undefined;
      // The reply is the page's: only exactly true counts.
      if (reply === true) {
        finish(() => resolve(true));
        return;
      }
    } catch (error: unknown) {
      if (settled) return;
      if (!isRetried(error)) {
        finish(() => reject(error));
        return;
      }
      retried = { error };
    }
    sleep = timers.setTimeout(() => void poll(), WAIT_POLL_MS);
  }

  function finish(settle: () => void): void {
    settled = true;
    timers.clearTimeout(deadline);
    if (sleep !== undefined) timers.clearTimeout(sleep);
    settle();
  }
}

function isRetried(error: unknown): boolean {
  return error instanceof Error && "code" in error && RETRIED.includes(error.code);
}

/**
 * Resolves "navigated" once the top frame of the tab finishes a load or changes its address with
 * the History API and `checks` has resolved, in either order; "closed" when the tab is removed;
 * "timeout" when `timeoutMs` passes first. Rejects with the error of `checks`. The listeners go
 * in before `checks` runs, so a navigation that ends while it runs still counts, and so does a
 * load already in progress. A finished load counts only when `loadCounts` says so, asked as it
 * finishes.
 */
export function waitForNavigation<Handle>(
  {
    browser,
    timers,
  }: { browser: Pick<BrowserApi, "tabs" | "webNavigation">; timers: Timers<Handle> },
  tabId: number,
  timeoutMs: number,
  checks: () => Promise<unknown>,
  loadCounts: () => boolean = () => true,
): Promise<"navigated" | "closed" | "timeout"> {
  return new Promise((resolve, reject) => {
    let navigated = false;
    let checked = false;
    const timer = timers.setTimeout(() => finish(() => resolve("timeout")), timeoutMs);
    const onLoad = (details: NavigationDetails) => {
      if (inTopFrame(details) && loadCounts()) navigatedNow();
    };
    const onHistoryChange = (details: NavigationDetails) => {
      if (inTopFrame(details)) navigatedNow();
    };
    const onRemoved = (removedId: number) => {
      if (removedId === tabId) finish(() => resolve("closed"));
    };
    browser.webNavigation.onCompleted.addListener(onLoad);
    browser.webNavigation.onHistoryStateUpdated.addListener(onHistoryChange);
    browser.tabs.onRemoved.addListener(onRemoved);
    (async () => checks())().then(
      () => {
        checked = true;
        if (navigated) finish(() => resolve("navigated"));
      },
      (error: unknown) => finish(() => reject(error)),
    );

    function inTopFrame(details: NavigationDetails): boolean {
      return details.tabId === tabId && details.frameId === 0;
    }

    function navigatedNow(): void {
      navigated = true;
      if (checked) finish(() => resolve("navigated"));
    }

    // Settling twice is harmless: a promise keeps its first outcome, and removing again does nothing.
    function finish(settle: () => void): void {
      browser.webNavigation.onCompleted.removeListener(onLoad);
      browser.webNavigation.onHistoryStateUpdated.removeListener(onHistoryChange);
      browser.tabs.onRemoved.removeListener(onRemoved);
      timers.clearTimeout(timer);
      settle();
    }
  });
}
