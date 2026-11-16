import type { BrowserApi, InjectionResult, Timers } from "./browser-api.ts";
import { RECORDER_OPTIONS } from "./console-messages.ts";
import { recordConsole } from "./console-recorder.ts";
import { createLiveDocuments, type LiveDocument } from "./live-documents.ts";
import { warn } from "./log.ts";
import type { SessionGroups } from "./session-groups.ts";
import type { SiteAccess } from "./site-access.ts";

export interface ConsoleRecordingDeps<Handle> {
  browser: Pick<BrowserApi, "tabs" | "scripting" | "webNavigation" | "storage">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "openPrompt" | "onWithdraw" | "onStop" | "onGrant">;
  timers: Timers<Handle>;
  now: () => number;
}

/** How many times, how far apart, the recorder is injected until it lands: about two seconds. */
export const RECORDER_ATTEMPTS = 40;
export const RECORDER_RETRY_MS = 50;

export interface ConsoleRecording {
  /**
   * The tab's live recording for the session, one object per live document; undefined when there
   * is none, or while its recorder is not yet started or emptied.
   */
  liveRecording(session: string, tabId: number): LiveRecording | undefined;
}

export interface LiveRecording {
  /**
   * The time (ms since the epoch) from which the recording holds every message: when the injection
   * that started or emptied the recorder returned.
   */
  readonly since: number;
}

/** What one injection of the recorder came to. */
interface Outcome {
  /** The recorder's own status, or "rejected", "missing", "error" or "none". */
  status: string;
  /** Whether it ran in the committed document, when Firefox named both. */
  sameDocument?: boolean | undefined;
  /** Firefox's reason for a rejected injection. */
  error?: string;
}

/**
 * Starts Foxleash's console recorder in each live document (see live-documents.ts), or, in one
 * that went live when access to it began, starts or empties it, and keeps, per tab, the recording
 * of the one that is still live, once its recorder is in place. Adds its listeners at once (call
 * it at the top level of the background script).
 */
export function createConsoleRecording<Handle>({
  browser,
  groups,
  access,
  timers,
  now,
}: ConsoleRecordingDeps<Handle>): ConsoleRecording {
  const recordings = new WeakMap<LiveDocument, LiveRecording>();
  const documents = createLiveDocuments({
    browser,
    groups,
    access,
    failure: "console_recording_failed",
    onDecided,
  });

  return { liveRecording };

  async function onDecided(
    tabId: number,
    live: LiveDocument | undefined,
    documentId: string | undefined,
  ): Promise<boolean> {
    if (live === undefined) return true;
    if (live.startedBy === "grant") return startOrClear(tabId, live, documentId);
    let retried = false;
    // Right after a commit, an injection can still run in the document before it: the new tab's
    // about:blank, or the previous page on the same site.
    for (let attempts = 1; ; attempts += 1) {
      const outcome = await inject(tabId, live.site, documentId, false);
      // A recorder still there at the last attempt is in the document the tab shows by then, even
      // when Firefox names no document or names another one.
      const landed =
        outcome.status === "started" ||
        (outcome.status === "present" &&
          (outcome.sameDocument === true || attempts === RECORDER_ATTEMPTS));
      if (landed) {
        if (attempts > 1 || outcome.status !== "started" || outcome.sameDocument === false) {
          void report("console_recording_started", tabId, attempts, outcome, documentId);
        }
        recordings.set(live, { since: now() });
        return true;
      }
      if (documents.live(tabId) !== live) return false;
      if (attempts === RECORDER_ATTEMPTS) {
        void report("console_recording_failed", tabId, attempts, outcome, documentId);
        return false;
      }
      if (!retried) {
        retried = true;
        void report("console_recording_retry", tabId, undefined, outcome, documentId);
      }
      await delay(RECORDER_RETRY_MS);
      if (documents.live(tabId) !== live) return false;
    }
  }

  /**
   * For a document already shown when access to it began: one injection that starts the recorder,
   * or empties the one there, so nothing from before reaches the agent.
   */
  async function startOrClear(
    tabId: number,
    live: LiveDocument,
    documentId: string | undefined,
  ): Promise<boolean> {
    const outcome = await inject(tabId, live.site, documentId, true);
    if (documents.live(tabId) !== live) return false;
    const confirmed =
      (outcome.status === "started" || outcome.status === "cleared") &&
      outcome.sameDocument !== false;
    if (!confirmed) {
      void report("console_recording_failed", tabId, 1, outcome, documentId);
      return false;
    }
    recordings.set(live, { since: now() });
    return true;
  }

  async function inject(
    tabId: number,
    site: string,
    documentId: string | undefined,
    clear: boolean,
  ): Promise<Outcome> {
    try {
      const frames = await browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: recordConsole,
        args: [site, RECORDER_OPTIONS, clear],
        world: "MAIN",
        injectImmediately: true,
      });
      return outcomeOf(
        frames.find((frame) => frame.frameId === 0),
        documentId,
      );
    } catch (error: unknown) {
      return { status: "rejected", error: String(error) };
    }
  }

  /** Logs an attempt's outcome; never its frame's error, which the page's own code can shape. */
  async function report(
    event: string,
    tabId: number,
    attempts: number | undefined,
    { status, sameDocument, error }: Outcome,
    documentId: string | undefined,
  ): Promise<void> {
    const currentDocument = await isCurrent(tabId, documentId);
    warn({ event, tabId, attempts, status, sameDocument, currentDocument, error });
  }

  /** Whether the commit's document is the one the tab's top frame shows now, when Firefox says. */
  async function isCurrent(
    tabId: number,
    documentId: string | undefined,
  ): Promise<boolean | undefined> {
    if (documentId === undefined) return undefined;
    // Only for a log line: a tab that cannot be read leaves the field out.
    const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => null);
    const current = frames?.find((frame) => frame.frameId === 0)?.documentId;
    return typeof current === "string" ? current === documentId : undefined;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => timers.setTimeout(() => resolve(), ms));
  }

  function liveRecording(session: string, tabId: number): LiveRecording | undefined {
    const live = documents.live(tabId);
    return live?.session === session ? recordings.get(live) : undefined;
  }
}

function outcomeOf(
  top: InjectionResult<unknown> | undefined,
  documentId: string | undefined,
): Outcome {
  if (top === undefined) return { status: "missing" };
  const sameDocument =
    typeof top.documentId === "string" && documentId !== undefined
      ? top.documentId === documentId
      : undefined;
  if (top.error !== undefined) return { status: "error", sameDocument };
  return { status: typeof top.result === "string" ? top.result : "none", sameDocument };
}
