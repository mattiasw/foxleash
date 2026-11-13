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
  /** Marks the session's action in the tab: only a later navigation can count for the session. */
  acted(session: string, tabId: number): void;
  /**
   * Whether a top-frame navigation of the tab began and finished since the session's mark there;
   * it then moves the mark past it, so each finished navigation counts once. False with no mark.
   */
  takeFinished(session: string, tabId: number): boolean;
}

export interface TabNavigationsDeps<Handle> {
  browser: Pick<BrowserApi, "tabs" | "webNavigation">;
  timers: Timers<Handle>;
}

/**
 * A tab's navigation numbers: the last one handed out, the ones the navigations that began and
 * committed last got, and the ones of the last load that completed and the last History API change.
 */
interface Numbers {
  latest: number;
  lastBegun: number;
  lastCommitted: number;
  loaded: number;
  changed: number;
}

/** The numbers at or below which a session has spent a tab's loads and History API changes. */
interface Mark {
  loaded: number;
  changed: number;
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
  const numbers = new Map<number, Numbers>();
  // Tab, then session.
  const marks = new Map<number, Map<string, Mark>>();

  // Firefox swaps a document in through about:blank, and a new tab starts on its own: neither is
  // the navigation's page.
  browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
    if (frameId !== 0 || url === "about:blank") return;
    counts.set(tabId, begun(tabId) + 1);
    const tabNumbers = numbered(tabId);
    tabNumbers.latest += 1;
    tabNumbers.lastBegun = tabNumbers.latest;
    const navigation = navigations.get(tabId);
    if (navigation === undefined) navigations.set(tabId, { phase: "begun", documentId: undefined });
    // A navigation that supersedes it, or the swap's second onBeforeNavigate for the same URL.
    else navigation.phase = "begun";
  });
  // Not a begun navigation: a pushState must not make a page request run again.
  browser.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    const tabNumbers = numbered(tabId);
    tabNumbers.latest += 1;
    tabNumbers.changed = tabNumbers.latest;
  });
  browser.webNavigation.onCommitted.addListener(({ tabId, frameId, url, documentId }) => {
    if (frameId !== 0 || url === "about:blank") return;
    const tabNumbers = numbers.get(tabId);
    if (tabNumbers !== undefined) tabNumbers.lastCommitted = tabNumbers.lastBegun;
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
    // It finishes the navigation that committed last and takes that one's number: a completion
    // after a mark (navigate's own load) is at or below the mark, and a navigation that never
    // commits (a download) lends its number to no other page's completion.
    const tabNumbers = numbers.get(tabId);
    if (tabNumbers !== undefined) tabNumbers.loaded = tabNumbers.lastCommitted;
    if (navigations.has(tabId)) end(tabId, "ended");
  });
  // A 204, a download, a page from the back-forward cache, which brings no commit.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete" && navigations.has(tabId)) end(tabId, "ended");
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    counts.delete(tabId);
    numbers.delete(tabId);
    marks.delete(tabId);
    end(tabId, "removed");
  });

  return { underWay, begun, settled, acted, takeFinished };

  function begun(tabId: number): number {
    return counts.get(tabId) ?? 0;
  }

  function numbered(tabId: number): Numbers {
    const tabNumbers = numbers.get(tabId) ?? {
      latest: 0,
      lastBegun: 0,
      lastCommitted: 0,
      loaded: 0,
      changed: 0,
    };
    numbers.set(tabId, tabNumbers);
    return tabNumbers;
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

  function acted(session: string, tabId: number): void {
    const tabMarks = marks.get(tabId) ?? new Map<string, Mark>();
    marks.set(tabId, tabMarks);
    const latest = numbers.get(tabId)?.latest ?? 0;
    tabMarks.set(session, { loaded: latest, changed: latest });
  }

  function takeFinished(session: string, tabId: number): boolean {
    const mark = marks.get(tabId)?.get(session);
    const tabNumbers = numbers.get(tabId);
    if (mark === undefined || tabNumbers === undefined) return false;
    if (tabNumbers.loaded <= mark.loaded && tabNumbers.changed <= mark.changed) return false;
    // Each kind to its own last finished one, never to the latest: a load that began before a
    // History API change, or after the last load completed, still counts once it completes.
    mark.loaded = Math.max(mark.loaded, tabNumbers.loaded);
    mark.changed = Math.max(mark.changed, tabNumbers.changed);
    return true;
  }
}
