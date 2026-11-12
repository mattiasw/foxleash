import type { BrowserApi, Timers } from "./browser-api.ts";

/** How a wait for a tab's navigation ended. */
export type NavigationOutcome = "idle" | "ready" | "ended" | "removed" | "committed" | "timeout";

export interface TabNavigations {
  /** Whether the tab's top frame has a navigation under way: begun, or committed and not ready. */
  underWay(tabId: number): boolean;
  /** How many top-frame navigations have begun in the tab, so a caller can tell one began since. */
  begun(tabId: number): number;
  /**
   * Resolves "idle" at once when no navigation is under way; otherwise "ready" (the new
   * document's DOM is parsed), "ended" (it ended without a document, or Firefox reports the tab
   * no longer loading), "removed" (the tab closed), "committed" (`ms` passed with the new
   * document committed but not parsed; the tracker stops holding requests for it), or "timeout"
   * (`ms` passed before any commit while Firefox still reports the tab loading).
   */
  settled(tabId: number, ms: number): Promise<NavigationOutcome>;
}

export interface TabNavigationsDeps<Handle> {
  browser: Pick<BrowserApi, "tabs" | "webNavigation">;
  timers: Timers<Handle>;
}

/** A tab's navigation under way; one object from its start to its end. */
interface Navigation {
  phase: "begun" | "committed";
  documentId: string | undefined;
}

type Settle = (outcome: NavigationOutcome) => void;

/**
 * Keeps, per tab, whether its top frame has a navigation under way. Adds its listeners at once
 * (call it at the top level of the background script).
 */
export function createTabNavigations<Handle>({
  browser,
  timers,
}: TabNavigationsDeps<Handle>): TabNavigations {
  const navigations = new Map<number, Navigation>();
  const counts = new Map<number, number>();
  const waiters = new Map<number, Set<Settle>>();

  // Firefox swaps a document in through about:blank, and a new tab starts on its own: neither is
  // the navigation's page.
  browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
    if (frameId !== 0 || url === "about:blank") return;
    counts.set(tabId, begun(tabId) + 1);
    const navigation = navigations.get(tabId);
    if (navigation === undefined) navigations.set(tabId, { phase: "begun", documentId: undefined });
    // A navigation that supersedes it, or the swap's second onBeforeNavigate for the same URL.
    else navigation.phase = "begun";
  });
  browser.webNavigation.onCommitted.addListener(({ tabId, frameId, url, documentId }) => {
    if (frameId !== 0 || url === "about:blank") return;
    const navigation = navigations.get(tabId);
    if (navigation === undefined) return;
    navigation.phase = "committed";
    navigation.documentId = documentId;
  });
  browser.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId, url, documentId }) => {
    if (frameId !== 0 || url === "about:blank") return;
    const navigation = navigations.get(tabId);
    // Before the commit, it is the leaving document's.
    if (navigation?.phase !== "committed") return;
    const known = navigation.documentId !== undefined && documentId !== undefined;
    if (known && navigation.documentId !== documentId) return;
    end(tabId, "ready");
  });
  // A download, or a page from memory on back or forward, which commits but has no DOMContentLoaded.
  // A redirect's end can carry either URL, so none is compared.
  browser.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
    if (frameId !== 0 || url === "about:blank") return;
    if (navigations.has(tabId)) end(tabId, "ended");
  });
  // A 204, a download, a page from the back-forward cache, which brings no commit.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete" && navigations.has(tabId)) end(tabId, "ended");
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    counts.delete(tabId);
    end(tabId, "removed");
  });

  return { underWay, begun, settled };

  function begun(tabId: number): number {
    return counts.get(tabId) ?? 0;
  }

  /** Ends the tab's navigation, settling every wait for it with `outcome`. */
  function end(tabId: number, outcome: NavigationOutcome): void {
    navigations.delete(tabId);
    for (const settle of [...(waiters.get(tabId) ?? [])]) settle(outcome);
  }

  function underWay(tabId: number): boolean {
    return navigations.has(tabId);
  }

  function settled(tabId: number, ms: number): Promise<NavigationOutcome> {
    if (!navigations.has(tabId)) return Promise.resolve("idle");
    const { promise, resolve } = Promise.withResolvers<NavigationOutcome>();
    let done = false;
    const tabWaiters = waiters.get(tabId) ?? new Set<Settle>();
    waiters.set(tabId, tabWaiters);
    const settle: Settle = (outcome) => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      tabWaiters.delete(settle);
      if (tabWaiters.size === 0 && waiters.get(tabId) === tabWaiters) waiters.delete(tabId);
      resolve(outcome);
    };
    tabWaiters.add(settle);
    const timer = timers.setTimeout(() => void bound(), ms);
    return promise;

    /** `ms` passed with the tab under way all along: an end would have settled this wait. */
    async function bound(): Promise<void> {
      if (navigations.get(tabId)?.phase === "committed") {
        end(tabId, "committed");
        return;
      }
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      if (done) return;
      if (tab === undefined) settle("removed");
      else if (tab.status === "loading") settle("timeout");
      // The tracker missed the navigation's end.
      else end(tabId, "ended");
    }
  }
}
