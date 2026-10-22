import type { BrowserApi } from "./browser-api.ts";
import { RECORDER_OPTIONS } from "./console-messages.ts";
import { recordConsole } from "./console-recorder.ts";
import { createLiveDocuments, type LiveDocument } from "./live-documents.ts";
import type { SessionGroups } from "./session-groups.ts";
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

/**
 * Starts Foxhand's console recorder in each live document (see live-documents.ts) and keeps, per
 * tab, the recording of the one that is still live. Adds its listeners at once (call it at the
 * top level of the background script).
 */
export function createConsoleRecording({
  browser,
  groups,
  access,
}: ConsoleRecordingDeps): ConsoleRecording {
  const documents = createLiveDocuments({
    browser,
    groups,
    access,
    failure: "console_recording_failed",
    onDecided,
  });

  return { liveRecording, withdraw: documents.withdraw };

  async function onDecided(tabId: number, live: LiveDocument | undefined): Promise<boolean> {
    if (live === undefined) return true;
    const frames = await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: recordConsole,
      args: [live.site, RECORDER_OPTIONS],
      world: "MAIN",
      injectImmediately: true,
    });
    const top = frames.find((frame) => frame.frameId === 0);
    return top !== undefined && top.error === undefined;
  }

  function liveRecording(session: string, tabId: number): object | undefined {
    const live = documents.live(tabId);
    return live?.session === session ? live : undefined;
  }
}
