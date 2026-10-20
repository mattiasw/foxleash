import type { BrowserApi } from "./browser-api.ts";
import { RECORDER_OPTIONS } from "./console-messages.ts";
import { recordConsole } from "./console-recorder.ts";
import { allowedSiteFor, ToolError } from "./handlers.ts";
import { warn } from "./log.ts";
import type { SessionGroups } from "./session-groups.ts";
import { siteOf } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

export interface ConsoleRecordingDeps {
  browser: Pick<BrowserApi, "tabs" | "scripting" | "webNavigation" | "storage">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "openPrompt">;
}

export interface ConsoleRecording {
  /** The tab's live recording for the session, an opaque value; undefined when there is none. */
  liveRecording(session: string, tabId: number): object | undefined;
  /** The session's approval of the site ended: no record of its tabs is read again. */
  withdraw(session: string, site: string): void;
}

/** A recording started at one top-frame commit; a new object for each. */
interface Entry {
  session: string;
  site: string;
  groupId: number;
}

/**
 * Starts Foxhand's console recorder in each document that commits in the top frame of a tab in
 * a session's group, on a site that session may act on, and keeps, per tab, the recording whose
 * access has not been interrupted since. Adds its listeners at once (call it at the top level of
 * the background script).
 */
export function createConsoleRecording({
  browser,
  groups,
  access,
}: ConsoleRecordingDeps): ConsoleRecording {
  const entries = new Map<number, Entry>();
  // The number of each tab's latest top-frame commit, from one counter.
  const latest = new Map<number, number>();
  let commits = 0;

  browser.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    commits += 1;
    latest.set(tabId, commits);
    entries.delete(tabId);
    void start(tabId, url, commits);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const entry = entries.get(tabId);
    if (entry === undefined) return;
    // The tab's own group on every update, so a move is seen even without a groupId change. A
    // late event for the grouping the entry was made in carries the same id.
    const groupId = changeInfo.groupId ?? tab.groupId;
    // A page restored from the back-forward cache brings its own URL, and no commit.
    const moved = changeInfo.url !== undefined && siteOf(changeInfo.url) !== entry.site;
    if (groupId !== entry.groupId || moved) entries.delete(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    entries.delete(tabId);
    latest.delete(tabId);
  });
  // A group stays in its window, so a tab moved to another window has left it.
  browser.tabs.onDetached.addListener((tabId) => entries.delete(tabId));
  browser.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName !== "local") return;
    // Stored approvals and the blocklist live there: only a change that narrows access drops.
    for (const [tabId, entry] of [...entries]) void recheck(tabId, entry);
  });

  return { liveRecording, withdraw };

  async function start(tabId: number, url: string, commit: number): Promise<void> {
    let entry: Entry | undefined;
    try {
      const tab = await browser.tabs.get(tabId);
      const session = groups.sessionOf(tab.groupId);
      if (session === undefined) return;
      // The committed URL: the tab's own can still be the previous page's.
      const site = await allowedSiteFor(access, session, tabId, url);
      if (latest.get(tabId) !== commit) return;
      // Before the injection, so a withdrawal while it runs drops it.
      entry = { session, site, groupId: tab.groupId ?? -1 };
      entries.set(tabId, entry);
      // A move to another group while the gate ran found no entry to drop: check the group again.
      void recheck(tabId, entry);
      const frames = await browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: recordConsole,
        args: [site, RECORDER_OPTIONS],
        world: "MAIN",
        injectImmediately: true,
      });
      const top = frames.find((frame) => frame.frameId === 0);
      if (top === undefined || top.error !== undefined) drop(tabId, entry);
    } catch (error: unknown) {
      // A ToolError is the gate refusing the page: nothing to record there.
      if (!(error instanceof ToolError)) {
        warn({ event: "console_recording_failed", tabId, error: String(error) });
      }
      if (entry !== undefined) drop(tabId, entry);
    }
  }

  /** Drops the entry unless the tab is still in its group and the gate still passes its site. */
  async function recheck(tabId: number, entry: Entry): Promise<void> {
    try {
      const { groupId } = await browser.tabs.get(tabId);
      if (groupId === entry.groupId) {
        await allowedSiteFor(access, entry.session, tabId, entry.site);
        return;
      }
    } catch (error: unknown) {
      if (!(error instanceof ToolError)) {
        warn({ event: "console_recording_failed", tabId, error: String(error) });
      }
    }
    drop(tabId, entry);
  }

  function drop(tabId: number, entry: Entry): void {
    if (entries.get(tabId) === entry) entries.delete(tabId);
  }

  function liveRecording(session: string, tabId: number): object | undefined {
    const entry = entries.get(tabId);
    return entry?.session === session ? entry : undefined;
  }

  function withdraw(session: string, site: string): void {
    for (const [tabId, entry] of [...entries]) {
      if (entry.session === session && entry.site === site) entries.delete(tabId);
    }
  }
}
