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
 * Cancels a redirect hop to a blocklisted site in a top-level load of a tab while the agent's
 * wait for a load in that tab runs, and for the loads it saw until Firefox reports them ended
 * (ADR 0101).
 */
export interface LoadHops {
  /**
   * Starts judging the tab's top-level loads; `refuse` hears each cancel until the returned
   * function is called.
   */
  watch(session: string, tabId: number, refuse: (error: ToolError) => void): () => void;
}

/**
 * How long after a wait that saw no load ended the tab's next top-level load is still judged as
 * its load: a page can hold back the start of a load past the wait (ADR 0101).
 */
export const LATE_START_MS = 300_000;

export function createLoadHops<Handle>({
  browser,
  access,
  timers,
}: {
  browser: Pick<BrowserApi, "webRequest">;
  access: Pick<SiteAccess, "view">;
  timers: Timers<Handle>;
}): LoadHops {
  return { watch };

  function watch(session: string, tabId: number, refuse: (error: ToolError) => void): () => void {
    // The top-level requests of the tab this watch judges the hops of.
    const seen = new Set<string>();
    // Those Firefox has not reported ended.
    const open = new Set<string>();
    let watching = true;
    // Set while a wait that saw no load waits for the tab's next new request to adopt as its load.
    let startTimer: Handle | undefined;
    const filter = { urls: ["<all_urls>"], types: ["main_frame"], tabId };
    browser.webRequest.onBeforeRequest.addListener(onRequest, filter, ["blocking"]);
    browser.webRequest.onCompleted.addListener(onEnded, filter);
    browser.webRequest.onErrorOccurred.addListener(onEnded, filter);
    return stop;

    // A new request's first address was gated, or the page started the load: it goes on at once.
    function onRequest(details: RequestDetails): Promise<Cancel | undefined> | undefined {
      if (seen.has(details.requestId)) return judgeHop(details.url);
      if (startTimer !== undefined) {
        timers.clearTimeout(startTimer);
        startTimer = undefined;
      } else if (!watching) return undefined;
      seen.add(details.requestId);
      open.add(details.requestId);
      return undefined;
    }

    /** Never rejects. Cancels after `stop` too: Firefox applies a pending answer after removal. */
    async function judgeHop(url: string): Promise<Cancel | undefined> {
      const protocol = URL.parse(url)?.protocol;
      if (protocol !== "http:" && protocol !== "https:") return undefined;
      const refusal = await hopRefusal(url);
      if (refusal === undefined) return undefined;
      // Before the cancel is answered: a wait without a URL would otherwise end at the complete
      // Firefox reports for the page the tab keeps.
      if (watching) {
        try {
          refuse(refusal);
        } catch {
          // Firefox lets the request go on when the answer rejects.
        }
      }
      return { cancel: true };
    }

    /** Why the hop to `url` may not be requested, from the session's view read anew. */
    async function hopRefusal(url: string): Promise<ToolError | undefined> {
      const site = siteOf(url);
      if (site === undefined) return hopUnchecked(tabId, undefined);
      try {
        const view = await access.view(session);
        return view.blocked(url) ? hopBlocked(tabId, site) : undefined;
      } catch (error: unknown) {
        return error instanceof ToolError ? error : hopUnchecked(tabId, site);
      }
    }

    function onEnded(details: CompletedDetails | ErrorDetails): void {
      if (open.delete(details.requestId) && !watching && open.size === 0) remove();
    }

    function stop(): void {
      if (!watching) return;
      watching = false;
      if (open.size > 0) return;
      if (seen.size > 0) {
        remove();
        return;
      }
      startTimer = timers.setTimeout(remove, LATE_START_MS);
    }

    function remove(): void {
      browser.webRequest.onBeforeRequest.removeListener(onRequest);
      browser.webRequest.onCompleted.removeListener(onEnded);
      browser.webRequest.onErrorOccurred.removeListener(onEnded);
    }
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
