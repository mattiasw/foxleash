import type { BrowserApi } from "./browser-api.ts";
import { allowedSiteFor, ToolError } from "./handlers.ts";
import { warn } from "./log.ts";
import type { SessionGroups } from "./session-groups.ts";
import { RECIPE_KEY_PREFIX, TAG_MARK_KEY } from "./settings.ts";
import { redactedUrl, siteOf } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

/**
 * A top-frame document whose session may act on its site, uninterrupted since its commit, or
 * since access to it began.
 */
export interface LiveDocument {
  readonly session: string;
  readonly site: string;
  readonly groupId: number;
  /** "commit" when it went live at its commit, "grant" when access to the shown document began. */
  readonly startedBy: "commit" | "grant";
}

export interface LiveDocumentsDeps {
  browser: Pick<BrowserApi, "tabs" | "webNavigation" | "storage">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "openPrompt" | "onWithdraw" | "onStop" | "onGrant">;
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
   * or undefined when it has none, and the commit's documentId, when Firefox gave one. Runs too when
   * a catch-up's check ends with a live document: with `startedBy` "grant" and the documentId the
   * top frame had when the catch-up read it. The document stops being live when this rejects or
   * gives false.
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
}

/** A catch-up running for a tab; `site` is set once it read the top frame's URL. */
interface CatchUp {
  site: string | undefined;
}

/**
 * Keeps, per tab, the document that committed in its top frame while the tab was in a session's
 * group, on a site that session may act on, for as long as that access is not interrupted. When a
 * session may have gained access to the document a tab already shows (an approval, a storage
 * change, the tab joining a group), a catch-up checks that document and, when the gate passes,
 * keeps it from then on. Adds its listeners at once (call it at the top level of the background
 * script).
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
  // The commit whose check is still under way, per tab, and the tabs whose access may have changed
  // while it ran: such a check makes nothing live, and a catch-up runs once it ends.
  const deciding = new Map<number, number>();
  const pending = new Set<number>();
  const catchUps = new Map<number, CatchUp>();
  // The group (-1 for none) each tab's last update showed it in.
  const groupSeen = new Map<number, number>();

  browser.webNavigation.onCommitted.addListener(
    ({ tabId, frameId, url, timeStamp, documentId }) => {
      if (frameId !== 0) return;
      commits += 1;
      latest.set(tabId, commits);
      deciding.set(tabId, commits);
      pending.delete(tabId);
      catchUps.delete(tabId);
      entries.delete(tabId);
      onCommit?.(tabId, url, timeStamp);
      void start(tabId, url, commits, documentId);
    },
  );
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Seen from the tab's own group, as Firefox does not always name a change of it.
    const group = changeInfo.groupId ?? tab.groupId ?? -1;
    const regrouped = groupSeen.get(tabId) !== group;
    groupSeen.set(tabId, group);
    const entry = entries.get(tabId);
    if (entry === undefined) {
      const running = catchUps.get(tabId)?.site;
      const otherSite =
        changeInfo.url !== undefined && running !== undefined && siteOf(changeInfo.url) !== running;
      if (regrouped || otherSite) void catchUp(tabId);
      return;
    }
    // The tab's own group on every update, so a move is seen even without a groupId change. A
    // late event for the grouping the entry was made in carries the same id.
    const groupId = changeInfo.groupId ?? tab.groupId;
    // A site change without a commit: Firefox commits a page it restores from memory (ADR 0049).
    const moved = changeInfo.url !== undefined && siteOf(changeInfo.url) !== entry.site;
    if (groupId !== entry.groupId) {
      // It may have joined another session's group.
      if (drop(tabId, entry, { reason: "group" })) void catchUp(tabId);
    } else if (moved) drop(tabId, entry, { reason: "site", site: redactedUrl(changeInfo.url) });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    entries.delete(tabId);
    latest.delete(tabId);
    deciding.delete(tabId);
    pending.delete(tabId);
    catchUps.delete(tabId);
    groupSeen.delete(tabId);
  });
  // A group stays in its window, so a tab moved to another window has left it.
  browser.tabs.onDetached.addListener((tabId) => {
    const entry = entries.get(tabId);
    if (entry !== undefined) drop(tabId, entry, { reason: "detached" });
  });
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const keys = Object.keys(changes);
    // A recipe or the tag mark never narrows access.
    if (
      keys.length > 0 &&
      keys.every((key) => key.startsWith(RECIPE_KEY_PREFIX) || key === TAG_MARK_KEY)
    ) {
      return;
    }
    accessChanged();
    // Stored approvals and the blocklist live there: only a change that narrows access drops.
    for (const [tabId, entry] of [...entries]) void recheck(tabId, entry);
    // Or one that widens it. A catch-up under way restarts, so none keeps an earlier gate answer.
    for (const tabId of [...catchUps.keys()]) void catchUp(tabId);
    void catchUpTabs(() => true);
  });
  access.onWithdraw(withdraw);
  access.onStop(stop);
  access.onGrant((session) => {
    accessChanged();
    void catchUpTabs((other) => other === session);
  });

  return { live };

  async function start(
    tabId: number,
    url: string,
    commit: number,
    documentId: string | undefined,
  ): Promise<void> {
    try {
      let entry: LiveDocument | undefined;
      try {
        const tab = await browser.tabs.get(tabId);
        const session = groups.sessionOf(tab.groupId);
        if (session !== undefined) {
          // The committed URL: the tab's own can still be the previous page's.
          const site = await allowedSiteFor(access, session, tabId, url);
          if (latest.get(tabId) !== commit) return;
          // Access changed while the gate ran: the catch-up once this check ends reads it again.
          if (!pending.has(tabId)) {
            // Before onDecided, so a withdrawal while it runs drops it.
            entry = { session, site, groupId: tab.groupId ?? -1, startedBy: "commit" };
            entries.set(tabId, entry);
            // A move to another group while the gate ran found no entry to drop: check it again.
            void recheck(tabId, entry);
          }
        }
      } catch (error: unknown) {
        // A ToolError is the gate refusing the page: nothing to record there.
        if (!(error instanceof ToolError)) warn({ event: failure, tabId, error: String(error) });
      }
      if (latest.get(tabId) !== commit) return;
      await decide(tabId, entry, documentId);
    } finally {
      if (deciding.get(tabId) === commit) {
        deciding.delete(tabId);
        // Access may have changed after this commit's gate read it.
        if (pending.delete(tabId) && !entries.has(tabId)) void catchUp(tabId);
      }
    }
  }

  /** Runs onDecided; the entry stops being live when it gives false or rejects. */
  async function decide(
    tabId: number,
    entry: LiveDocument | undefined,
    documentId: string | undefined,
  ): Promise<void> {
    try {
      const kept = await onDecided?.(tabId, entry, documentId);
      if (kept === false && entry !== undefined) drop(tabId, entry);
    } catch (error: unknown) {
      warn({ event: failure, tabId, error: String(error) });
      if (entry !== undefined) drop(tabId, entry);
    }
  }

  /** Marks every commit under check, synchronously: its gate may have read access from before. */
  function accessChanged(): void {
    for (const tabId of deciding.keys()) pending.add(tabId);
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
    // It may have joined another session's group.
    if (drop(tabId, entry, reason) && reason?.reason === "group") void catchUp(tabId);
  }

  /**
   * Ends the entry if it is still the tab's live document, logging `reason` when given; whether
   * it did.
   */
  function drop(tabId: number, entry: LiveDocument, reason?: Record<string, unknown>): boolean {
    if (entries.get(tabId) !== entry) return false;
    entries.delete(tabId);
    if (reason !== undefined) warn({ event: failure, tabId, ...reason });
    return true;
  }

  /** Catches up every tab in the group of a session `sessions` accepts. */
  async function catchUpTabs(sessions: (session: string) => boolean): Promise<void> {
    try {
      // Every tab: a session's group is not known here.
      for (const tab of await browser.tabs.query({})) {
        const session = groups.sessionOf(tab.groupId);
        if (tab.id !== undefined && session !== undefined && sessions(session)) {
          void catchUp(tab.id);
        }
      }
    } catch (error: unknown) {
      warn({ event: failure, error: String(error) });
    }
  }

  /**
   * Makes the document the tab shows live when its session may act on its site, from now on. A
   * later call for the tab supersedes one under way; any commit, entry or removal of the tab while
   * it runs stops it.
   */
  async function catchUp(tabId: number): Promise<void> {
    if (entries.has(tabId)) return;
    if (deciding.has(tabId)) {
      pending.add(tabId);
      return;
    }
    const token: CatchUp = { site: undefined };
    catchUps.set(tabId, token);
    const commit = latest.get(tabId);
    const stale = () =>
      catchUps.get(tabId) !== token || latest.get(tabId) !== commit || entries.has(tabId);
    try {
      const tab = await browser.tabs.get(tabId);
      const session = groups.sessionOf(tab.groupId);
      if (stale() || session === undefined) return;
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      // The committed document's URL: the tab's own can be a pending navigation's.
      const top = frames?.find((frame) => frame.frameId === 0);
      if (stale() || typeof top?.url !== "string") return;
      token.site = siteOf(top.url);
      const site = await allowedSiteFor(access, session, tabId, top.url);
      if (stale()) return;
      const entry: LiveDocument = { session, site, groupId: tab.groupId ?? -1, startedBy: "grant" };
      entries.set(tabId, entry);
      // A move to another group or a withdrawal while the gate ran found no entry to drop.
      void recheck(tabId, entry);
      await decide(tabId, entry, top.documentId);
    } catch (error: unknown) {
      // A superseded catch-up's failure, such as reading a tab that closed, says nothing.
      if (!(error instanceof ToolError) && !stale()) {
        warn({ event: failure, tabId, error: String(error) });
      }
    } finally {
      if (catchUps.get(tabId) === token) catchUps.delete(tabId);
    }
  }

  function live(tabId: number): LiveDocument | undefined {
    return entries.get(tabId);
  }

  /**
   * The session's approval of the site ended: its documents on that site stop being live. Each
   * starts again, empty, when a stored approval still allows it, and a catch-up under way restarts.
   */
  function withdraw(session: string, site: string): void {
    accessChanged();
    const dropped: number[] = [];
    for (const [tabId, entry] of [...entries]) {
      if (entry.session === session && entry.site === site) {
        entries.delete(tabId);
        dropped.push(tabId);
      }
    }
    for (const tabId of new Set([...dropped, ...catchUps.keys()])) void catchUp(tabId);
  }

  /** The user stopped the session: none of its documents is live, whatever the site. */
  function stop(session: string): void {
    accessChanged();
    for (const [tabId, entry] of [...entries]) {
      if (entry.session === session) entries.delete(tabId);
    }
  }
}
