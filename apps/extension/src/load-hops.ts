import type {
  BrowserApi,
  Cancel,
  CompletedDetails,
  ErrorDetails,
  RequestDetails,
  Timers,
} from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { siteOf } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

/**
 * Cancels a redirect hop to a blocklisted site in a top-level load of a tab: while the agent's
 * wait for a load in that tab runs, for every load the tab starts in the `LATE_START_MS` after
 * the last such wait, and for each such load until Firefox reports it ended (ADR 0101).
 */
export interface LoadHops {
  /**
   * Starts judging the tab's top-level loads; `refuse` hears each cancel until the returned
   * function is called. A newer watch of the tab takes over adopting new loads from this one.
   * With `gated`, the address the agent's reload was checked on, a new request that leaves its
   * site while the wait runs is judged as a hop is.
   */
  watch(
    session: string,
    tabId: number,
    refuse: (error: ToolError) => void,
    gated?: string,
  ): () => void;
}

/**
 * How long after the last wait in a tab every new top-level load of the tab is still adopted and
 * its hops judged against the blocklist: a page can hold back the agent's load past the wait, also
 * by keeping navigations of its own going (ADR 0101).
 */
export const LATE_START_MS = 300_000;

/** A watch as the other watches of its tab and the tab's window reach it. */
interface TabWatch {
  /** A newer watch of the tab heard a request. */
  endAdoption(): void;
  /** The tab's window ended: adoption ends unless the wait still runs. */
  windowEnded(): void;
}

/**
 * A tab's watches, oldest first, and the window that the end of each of their waits restarts, so
 * that it runs until `LATE_START_MS` after the last one, whichever watch adopts.
 */
interface WatchedTab<Handle> {
  watches: Set<TabWatch>;
  windowTimer: Handle | undefined;
}

export function createLoadHops<Handle>({
  browser,
  access,
  timers,
}: {
  browser: Pick<BrowserApi, "webRequest">;
  access: Pick<SiteAccess, "view" | "blocklisted">;
  timers: Timers<Handle>;
}): LoadHops {
  const tabs = new Map<number, WatchedTab<Handle>>();
  return { watch };

  function watch(
    session: string,
    tabId: number,
    refuse: (error: ToolError) => void,
    gated?: string,
  ): () => void {
    // The top-level requests of the tab this watch judges the hops of.
    const seen = new Set<string>();
    // Those Firefox has not reported ended.
    const open = new Set<string>();
    let waiting = true;
    // False once the tab's window ended after the wait or a newer watch of the tab took over.
    let adopting = true;
    const gatedSite = gated === undefined ? undefined : siteOf(gated);
    const tab = tabOf(tabId);
    const self: TabWatch = { endAdoption, windowEnded };
    tab.watches.add(self);
    const filter = { urls: ["<all_urls>"], types: ["main_frame"], tabId };
    browser.webRequest.onBeforeRequest.addListener(onRequest, filter, ["blocking"]);
    browser.webRequest.onCompleted.addListener(onEnded, filter);
    browser.webRequest.onErrorOccurred.addListener(onEnded, filter);
    return stop;

    // A new request's first address was gated, or the page started the load: it goes on at once,
    // unless it leaves the site a reload was gated on while the wait runs.
    function onRequest(details: RequestDetails): Promise<Cancel | undefined> | undefined {
      // Firefox adds a listener asynchronously: the tab's older watches adopt until this one hears.
      endOlder();
      if (seen.has(details.requestId)) return judgeHop(details.url);
      // After a reload's redirect hop was cancelled, Firefox sends the tab's next reload straight to
      // the hop's address (ADR 0101).
      const first = waiting && gated !== undefined && siteOf(details.url) !== gatedSite;
      if (!adopting && !first) return undefined;
      seen.add(details.requestId);
      open.add(details.requestId);
      return first ? judgeHop(details.url) : undefined;
    }

    function endOlder(): void {
      for (const other of tab.watches) {
        if (other === self) return;
        other.endAdoption();
      }
    }

    /** Never rejects. Cancels after `stop` too: Firefox applies a pending answer after removal. */
    async function judgeHop(url: string): Promise<Cancel | undefined> {
      const protocol = URL.parse(url)?.protocol;
      if (protocol !== "http:" && protocol !== "https:") return undefined;
      const refusal = await hopRefusal(url);
      if (refusal === undefined) return undefined;
      // Before the cancel is answered: a wait without a URL would otherwise end at the complete
      // Firefox reports for the page the tab keeps.
      if (waiting) {
        try {
          refuse(refusal);
        } catch {
          // Firefox lets the request go on when the answer rejects.
        }
      }
      return { cancel: true };
    }

    /**
     * Why the hop to `url` may not be requested: while the wait runs, from the session's view
     * read anew; after it, from the blocklist alone, also for a session the user stopped.
     */
    async function hopRefusal(url: string): Promise<ToolError | undefined> {
      const site = siteOf(url);
      if (site === undefined) return hopUnchecked(tabId, undefined);
      try {
        // Read as the hop arrives, before any await.
        if (!waiting) {
          return (await access.blocklisted(url)) ? hopBlocked(tabId, site) : undefined;
        }
        const view = await access.view(session);
        return view.blocked(url) ? hopBlocked(tabId, site) : undefined;
      } catch (error: unknown) {
        return error instanceof ToolError ? error : hopUnchecked(tabId, site);
      }
    }

    function onEnded(details: CompletedDetails | ErrorDetails): void {
      open.delete(details.requestId);
      removeWhenDone();
    }

    function stop(): void {
      if (!waiting) return;
      waiting = false;
      restartWindow(tab);
      removeWhenDone();
    }

    function windowEnded(): void {
      if (!waiting) endAdoption();
    }

    function endAdoption(): void {
      if (!adopting) return;
      adopting = false;
      removeWhenDone();
    }

    function removeWhenDone(): void {
      if (waiting || adopting || open.size > 0) return;
      browser.webRequest.onBeforeRequest.removeListener(onRequest);
      browser.webRequest.onCompleted.removeListener(onEnded);
      browser.webRequest.onErrorOccurred.removeListener(onEnded);
      if (tab.watches.delete(self) && tab.watches.size === 0) tabs.delete(tabId);
    }
  }

  function tabOf(tabId: number): WatchedTab<Handle> {
    const known = tabs.get(tabId);
    if (known !== undefined) return known;
    const tab: WatchedTab<Handle> = { watches: new Set(), windowTimer: undefined };
    tabs.set(tabId, tab);
    return tab;
  }

  function restartWindow(tab: WatchedTab<Handle>): void {
    if (tab.windowTimer !== undefined) timers.clearTimeout(tab.windowTimer);
    tab.windowTimer = timers.setTimeout(() => {
      for (const watch of tab.watches) watch.windowEnded();
    }, LATE_START_MS);
  }
}

function hopUnchecked(tabId: number, site: string | undefined): ToolError {
  return new ToolError(
    "redirect_unchecked",
    site === undefined
      ? `Tab ${tabId}'s load was redirected to an address Foxleash could not check, so Foxleash stopped it before anything was requested there.`
      : `Tab ${tabId}'s load was redirected to ${site}, which Foxleash could not check against its blocklist, so Foxleash stopped it before anything was requested there.`,
  );
}

function hopBlocked(tabId: number, site: string): ToolError {
  return new ToolError(
    "site_blocked",
    `Tab ${tabId}'s load was redirected to ${site}, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`,
  );
}
