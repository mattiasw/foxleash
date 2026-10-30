import type { BrowserApi } from "./browser-api.ts";
import { allowedSiteFor, ToolError } from "./handlers.ts";
import { warn } from "./log.ts";
import type { SessionGroups } from "./session-groups.ts";
import { RECIPE_KEY_PREFIX } from "./settings.ts";
import { redactedUrl, siteOf } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

/** A top-frame document whose session may act on its site, uninterrupted since its commit. */
export interface LiveDocument {
  readonly session: string;
  readonly site: string;
  readonly groupId: number;
}

export interface LiveDocumentsDeps {
  browser: Pick<BrowserApi, "tabs" | "webNavigation" | "storage">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "openPrompt">;
  /**
   * The `event` of the warning logged when a check fails for another reason than the gate, and
   * when a live document stops being live for a reason other than a commit, its tab closing, a
   * withdrawal or `onDecided`.
   */
  failure: string;
  /** Runs at each top-frame commit, synchronously, before the commit is checked. */
  onCommit?: (tabId: number, url: string, timeStamp: number) => void;
  /**
   * Runs when the check of a commit ends while it is still the tab's latest: with its live document,
   * or undefined when it has none, and the commit's documentId, when Firefox gave one. The document
   * stops being live when this rejects or gives false.
   */
  onDecided?: (
    tabId: number,
    live: LiveDocument | undefined,
    documentId: string | undefined,
  ) => boolean | Promise<boolean>;
}

export interface LiveDocuments {
  /** The tab's live document; a new object at each commit, so identity means "uninterrupted". */
  live(tabId: number): LiveDocument | undefined;
  /** The session's approval of the site ended: its documents on that site stop being live. */
  withdraw(session: string, site: string): void;
}

/**
 * Keeps, per tab, the document that committed in its top frame while the tab was in a session's
 * group, on a site that session may act on, for as long as that access is not interrupted. Adds
 * its listeners at once (call it at the top level of the background script).
 */
export function createLiveDocuments({
  browser,
  groups,
  access,
  failure,
  onCommit,
  onDecided,
}: LiveDocumentsDeps): LiveDocuments {
  const entries = new Map<number, LiveDocument>();
  // The number of each tab's latest top-frame commit, from one counter.
  const latest = new Map<number, number>();
  let commits = 0;

  browser.webNavigation.onCommitted.addListener(
    ({ tabId, frameId, url, timeStamp, documentId }) => {
      if (frameId !== 0) return;
      commits += 1;
      latest.set(tabId, commits);
      entries.delete(tabId);
      onCommit?.(tabId, url, timeStamp);
      void start(tabId, url, commits, documentId);
    },
  );
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const entry = entries.get(tabId);
    if (entry === undefined) return;
    // The tab's own group on every update, so a move is seen even without a groupId change. A
    // late event for the grouping the entry was made in carries the same id.
    const groupId = changeInfo.groupId ?? tab.groupId;
    // A page restored from the back-forward cache brings its own URL, and no commit.
    const moved = changeInfo.url !== undefined && siteOf(changeInfo.url) !== entry.site;
    if (groupId !== entry.groupId) drop(tabId, entry, { reason: "group" });
    else if (moved) drop(tabId, entry, { reason: "site", site: redactedUrl(changeInfo.url) });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    entries.delete(tabId);
    latest.delete(tabId);
  });
  // A group stays in its window, so a tab moved to another window has left it.
  browser.tabs.onDetached.addListener((tabId) => {
    const entry = entries.get(tabId);
    if (entry !== undefined) drop(tabId, entry, { reason: "detached" });
  });
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const keys = Object.keys(changes);
    // A recipe never narrows access.
    if (keys.length > 0 && keys.every((key) => key.startsWith(RECIPE_KEY_PREFIX))) return;
    // Stored approvals and the blocklist live there: only a change that narrows access drops.
    for (const [tabId, entry] of [...entries]) void recheck(tabId, entry);
  });

  return { live, withdraw };

  async function start(
    tabId: number,
    url: string,
    commit: number,
    documentId: string | undefined,
  ): Promise<void> {
    let entry: LiveDocument | undefined;
    try {
      const tab = await browser.tabs.get(tabId);
      const session = groups.sessionOf(tab.groupId);
      if (session !== undefined) {
        // The committed URL: the tab's own can still be the previous page's.
        const site = await allowedSiteFor(access, session, tabId, url);
        if (latest.get(tabId) !== commit) return;
        // Before onDecided, so a withdrawal while it runs drops it.
        entry = { session, site, groupId: tab.groupId ?? -1 };
        entries.set(tabId, entry);
        // A move to another group while the gate ran found no entry to drop: check the group again.
        void recheck(tabId, entry);
      }
    } catch (error: unknown) {
      // A ToolError is the gate refusing the page: nothing to record there.
      if (!(error instanceof ToolError)) warn({ event: failure, tabId, error: String(error) });
    }
    if (latest.get(tabId) !== commit) return;
    try {
      const kept = await onDecided?.(tabId, entry, documentId);
      if (kept === false && entry !== undefined) drop(tabId, entry);
    } catch (error: unknown) {
      warn({ event: failure, tabId, error: String(error) });
      if (entry !== undefined) drop(tabId, entry);
    }
  }

  /** Drops the entry unless the tab is still in its group and the gate still passes its site. */
  async function recheck(tabId: number, entry: LiveDocument): Promise<void> {
    let reason: Record<string, unknown> | undefined;
    try {
      const { groupId } = await browser.tabs.get(tabId);
      if (groupId === entry.groupId) {
        await allowedSiteFor(access, entry.session, tabId, entry.site);
        return;
      }
      reason = { reason: "group" };
    } catch (error: unknown) {
      if (error instanceof ToolError) reason = { reason: "refused", code: error.code };
      else warn({ event: failure, tabId, error: String(error) });
    }
    drop(tabId, entry, reason);
  }

  /** Ends the entry if it is still the tab's live document, logging `reason` when given. */
  function drop(tabId: number, entry: LiveDocument, reason?: Record<string, unknown>): void {
    if (entries.get(tabId) !== entry) return;
    entries.delete(tabId);
    if (reason !== undefined) warn({ event: failure, tabId, ...reason });
  }

  function live(tabId: number): LiveDocument | undefined {
    return entries.get(tabId);
  }

  function withdraw(session: string, site: string): void {
    for (const [tabId, entry] of [...entries]) {
      if (entry.session === session && entry.site === site) entries.delete(tabId);
    }
  }
}
