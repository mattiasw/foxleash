import type { MethodName } from "@foxleash/protocol";
import type { BrowserApi, Timers } from "./browser-api.ts";
import { documentTag, MAX_TAG_NUMBER } from "./element-refs.ts";
import { allowedPageSite, NAVIGATION_WAIT_MS, pageLoading, ToolError } from "./handlers.ts";
import { warn } from "./log.ts";
import {
  capText,
  MAX_ERROR_MESSAGE,
  MAX_PAGE_REPLY_CHARS,
  ownField,
  PAGE_ERROR_CODES,
  PAGE_REQUEST_KIND,
  type PageRequest,
} from "./page-messages.ts";
import type { SessionGroups } from "./session-groups.ts";
import { isRecord, TAG_MARK_KEY } from "./settings.ts";
import type { SiteAccess } from "./site-access.ts";
import type { TabNavigations } from "./tab-navigations.ts";

/** The content script's bundle in the extension. */
export const CONTENT_SCRIPT = "content.js";
/**
 * A request waits at most NAVIGATION_WAIT_MS for each navigation, and starts a wait or its second
 * run only in its first NAVIGATION_WAIT_MS, so it answers within 2 * NAVIGATION_WAIT_MS +
 * TAG_RESERVE_MS + PAGE_INJECTION_MS + PAGE_REPLY_MS = 55 s, below the host's 60 s request
 * timeout, which shuts the host down.
 */
export const PAGE_INJECTION_MS = 20_000;
export const PAGE_REPLY_MS = 10_000;
export const TAG_RESERVE_MS = 5_000;

/** The document tags reserved by one write of the stored mark. */
export const TAG_BLOCK = 100;

/**
 * Request types that, repeated, do something twice that the agent may not be able to undo (text
 * typed, a form submitted). A late reply does not mean the request did not run: the page thread
 * may have been slow to answer.
 */
const ACTING_REQUEST_TYPES: readonly string[] = [
  "click",
  "drag",
  "type",
  "press_key",
  "fill_form",
  "upload_file",
] satisfies readonly MethodName[];

export interface PageScriptsDeps<Handle> {
  browser: Pick<BrowserApi, "tabs" | "scripting" | "storage">;
  groups: Pick<SessionGroups, "groupOf">;
  access: Pick<SiteAccess, "view" | "openPrompt">;
  timers: Timers<Handle>;
  /** The navigations under way in each tab, which a request waits for. */
  navigations: Pick<TabNavigations, "settled" | "underWay" | "begun">;
}

export interface PageScripts {
  /**
   * Sends a request to Foxleash's content script in the top frame of a tab the session may act
   * in, injecting the script first, and returns the result of the request's page handler. Waits
   * first for a navigation under way in the tab, and runs once more after one that began while
   * it ran, unless it is an act already sent. `onSend` runs right before each send of the
   * request's message to the page, after the waits and the gate's checks.
   */
  request(
    session: string,
    tabId: number,
    type: string,
    params: Record<string, unknown>,
    onSend?: () => void,
  ): Promise<unknown>;
}

export function createPageScripts<Handle>(deps: PageScriptsDeps<Handle>): PageScripts {
  const { browser, groups, timers, navigations } = deps;
  // Tag numbers: the last one handed out, and the stored mark no tag handed out may pass.
  let handed = 0;
  let reserved = 0;
  let loaded = false;
  let extending: Promise<void> | undefined;
  return { request };

  async function request(
    session: string,
    tabId: number,
    type: string,
    params: Record<string, unknown>,
    onSend?: () => void,
  ): Promise<unknown> {
    let late = false;
    const cutoff = timers.setTimeout(() => {
      late = true;
    }, NAVIGATION_WAIT_MS);
    try {
      return await run(session, tabId, type, params, () => late, onSend);
    } finally {
      timers.clearTimeout(cutoff);
    }
  }

  /**
   * Runs the request, and once more when a navigation of the tab began during the run, unless the
   * message of an act was sent: a reply from such a run may be the leaving page's. A wait or a
   * second run starts only before `late`.
   */
  async function run(
    session: string,
    tabId: number,
    type: string,
    params: Record<string, unknown>,
    late: () => boolean,
    onSend: (() => void) | undefined,
  ): Promise<unknown> {
    const acting = ACTING_REQUEST_TYPES.includes(type);
    for (let second = false; ; second = true) {
      await settle(session, tabId, late);
      const begun = navigations.begun(tabId);
      // Above, not just different: a closed tab's count is dropped.
      const moved = () => navigations.begun(tabId) > begun;
      let sent = false;
      try {
        const site = await allowedPageSite(deps, session, tabId);
        // A fresh tag for every message, so no two documents can take the same one.
        const tag = await reserveTag(tabId);
        await inject(tabId);
        await checkAgain(session, tabId, site);
        if (moved()) throw pageChanged(tabId);
        sent = true;
        // Here, not when the request starts: a navigation an act first waits for is not the act's.
        onSend?.();
        const message: PageRequest = { kind: PAGE_REQUEST_KIND, type, site, tag, params };
        const reply = await bounded(
          () => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
          PAGE_REPLY_MS,
          // The document went away, or the reply could not be cloned.
          pageChanged(tabId),
          replyTimeout(tabId, type),
        );
        if (acting) await checkAfterAct(session, tabId, site, type, late);
        else {
          // Nothing from the page reaches the agent once the user has withdrawn access.
          await checkAgain(session, tabId, site);
          if (moved()) throw pageChanged(tabId);
        }
        return parsePageReply(reply, site, tabId);
      } catch (error: unknown) {
        // An act is never sent twice, and a tab that is not the session's is refused as it is.
        if ((acting && sent) || isTabRefusal(error)) throw error;
        // The about:blank of a document swap is the next page loading, not another kind of page.
        if (!moved() && !(isPageNotWeb(error) && navigations.underWay(tabId))) throw error;
        if (second || late()) throw navigations.underWay(tabId) ? pageLoading(tabId) : error;
      }
    }
  }

  /**
   * Waits for the navigation under way in the tab, when the tab is in the session's group, which
   * it checks first: a refusal comes at once, whether or not the tab is loading, so its timing
   * tells nothing about other tabs. `ran` names an act already sent.
   */
  async function settle(
    session: string,
    tabId: number,
    late: () => boolean,
    ran?: string,
  ): Promise<void> {
    if (!(await inGroup(session, tabId)) || !navigations.underWay(tabId)) return;
    if (late() || (await navigations.settled(tabId, NAVIGATION_WAIT_MS)) === "timeout") {
      throw pageLoading(tabId, ran);
    }
  }

  /**
   * The next document tag, never handed out before: also not before a restart, as the stored mark
   * is written before any tag up to it is handed out. One read or write of the mark runs at a
   * time, and a timed-out one is left to finish rather than raced by another. The wait for a tag
   * takes at most TAG_RESERVE_MS in all, however many writes it spans.
   */
  async function reserveTag(tabId: number): Promise<string> {
    const refusal = new ToolError(
      "page_error",
      `Foxleash could not prepare its request to the page in tab ${tabId}; try again.`,
    );
    const { promise: expired, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => reject(refusal), TAG_RESERVE_MS);
    try {
      while (handed >= reserved) {
        extending ??= extend().finally(() => {
          extending = undefined;
        });
        await Promise.race([extending, expired]);
      }
    } catch {
      throw refusal;
    } finally {
      timers.clearTimeout(timer);
    }
    // In the same turn as the check above, so no other request takes this number first.
    handed += 1;
    return documentTag(handed);
  }

  /** Reads the stored mark on first use, then stores a mark TAG_BLOCK above it. */
  async function extend(): Promise<void> {
    if (!loaded) {
      const items = await logged(browser.storage.local.get(null));
      const mark = Object.hasOwn(items, TAG_MARK_KEY) ? items[TAG_MARK_KEY] : 0;
      if (!isTagMark(mark)) {
        // Starting again from 0 could hand out tags that old refs carry.
        warn({ event: "ignored_tag_mark" });
        throw new Error("The stored tag mark is malformed.");
      }
      handed = mark;
      reserved = mark;
      loaded = true;
    }
    if (reserved >= MAX_TAG_NUMBER) {
      warn({ event: "tags_used_up" });
      throw new Error("Every document tag is used up.");
    }
    const next = Math.min(reserved + TAG_BLOCK, MAX_TAG_NUMBER);
    await logged(browser.storage.local.set({ [TAG_MARK_KEY]: next }));
    reserved = next;
  }

  async function inGroup(session: string, tabId: number): Promise<boolean> {
    try {
      const tab = await browser.tabs.get(tabId);
      const group = await groups.groupOf(session);
      return group !== undefined && tab.groupId === group.id;
    } catch {
      return false;
    }
  }

  async function inject(tabId: number): Promise<void> {
    const frames = await bounded(
      () =>
        browser.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: [CONTENT_SCRIPT],
          // The script only adds a listener, so it need not wait for the page to finish loading.
          injectImmediately: true,
        }),
      PAGE_INJECTION_MS,
      // Neutral, and without Firefox's text, which can repeat the URL.
      pageUnreachable(tabId),
      new ToolError(
        "page_timeout",
        `Foxleash could not get into the page in tab ${tabId} in time; try again.`,
      ),
    );
    const top = frames.find((frame) => frame.frameId === 0);
    if (top === undefined || top.error !== undefined) throw pageUnreachable(tabId);
  }

  /**
   * The gate after an act. When it meets the about:blank of a document swap, the gate applies to
   * the page the swap brings; an act whose page merely began loading another is not held.
   */
  async function checkAfterAct(
    session: string,
    tabId: number,
    site: string,
    type: string,
    late: () => boolean,
  ): Promise<void> {
    try {
      await checkAgain(session, tabId, site, type);
    } catch (error: unknown) {
      if (!(isPageNotWeb(error) && navigations.underWay(tabId))) throw error;
      await settle(session, tabId, late, type);
      await checkAgain(session, tabId, site, type);
    }
  }

  /**
   * Starts the browser call at once, then waits for it for at most `ms`: `timeout` when it
   * takes longer, `refusal` when it fails.
   */
  async function bounded<T>(
    start: () => Promise<T>,
    ms: number,
    refusal: ToolError,
    timeout: ToolError,
  ): Promise<T> {
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => reject(timeout), ms);
    try {
      return await Promise.race([start(), timedOut]);
    } catch (error: unknown) {
      throw error === timeout ? timeout : refusal;
    } finally {
      timers.clearTimeout(timer);
    }
  }

  /**
   * The gate again, after a wait during which the user may have withdrawn access or the tab moved
   * on. `ran` names an act already sent.
   */
  async function checkAgain(
    session: string,
    tabId: number,
    site: string,
    ran?: string,
  ): Promise<void> {
    if ((await allowedPageSite(deps, session, tabId)) !== site) throw pageChanged(tabId, ran);
  }
}

/** The storage call's result, with its failure logged. */
async function logged<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error: unknown) {
    warn({ event: "tag_mark_failed", error: String(error) });
    throw error;
  }
}

function isTagMark(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TAG_NUMBER
  );
}

function isPageNotWeb(error: unknown): boolean {
  return error instanceof ToolError && error.code === "page_not_web";
}

/** The gate's refusal of a tab that does not exist or is not in the session's group. */
function isTabRefusal(error: unknown): boolean {
  return (
    error instanceof ToolError &&
    (error.code === "tab_not_found" || error.code === "tab_not_in_group")
  );
}

/**
 * The result in a content script's reply, or the ToolError it stands for. The reply comes from
 * the page's content process, so it is read as untrusted input: own fields only, known codes.
 */
export function parsePageReply(reply: unknown, expectedSite: string, tabId: number): unknown {
  if (!isRecord(reply)) throw pageError(tabId);
  let json: unknown;
  try {
    json = JSON.stringify(reply, capped());
  } catch (error: unknown) {
    // A cycle or a BigInt; anything else is nesting too deep for the stack, or over the cap.
    if (error instanceof TypeError) throw pageError(tabId);
    throw replyTooLarge(tabId);
  }
  if (typeof json !== "string") throw pageError(tabId);
  if (json.length > MAX_PAGE_REPLY_CHARS) throw replyTooLarge(tabId);
  const site = ownField(reply, "site");
  if (typeof site !== "string") throw pageError(tabId);
  if (site !== expectedSite) throw pageChanged(tabId);
  const ok = ownField(reply, "ok");
  if (ok === true) return ownField(reply, "result");
  const code = ownField(reply, "code");
  const message = ownField(reply, "message");
  if (
    ok === false &&
    typeof code === "string" &&
    PAGE_ERROR_CODES.includes(code) &&
    typeof message === "string"
  ) {
    throw new ToolError(code, capText(message, MAX_ERROR_MESSAGE).text);
  }
  throw pageError(tabId);
}

/**
 * A JSON.stringify replacer that throws a RangeError as soon as the text is sure to be longer
 * than MAX_PAGE_REPLY_CHARS, counting each value JSON leaves out as one character. A
 * structured clone carries a shared object once, so a small reply can stand for gigabytes of
 * JSON or billions of values to walk; this stops before either.
 */
function capped(): (this: unknown, key: string, value: unknown) => unknown {
  let cost = 0;
  return function (this: unknown, key: string, value: unknown): unknown {
    cost += costOf(value, Array.isArray(this) ? undefined : key);
    if (cost > MAX_PAGE_REPLY_CHARS) throw new RangeError("The reply is too large.");
    return value;
  };
}

/**
 * One for a value JSON leaves out of an object (in an array it writes null); otherwise no more
 * than the value adds to the text, and at least one: its key in an object, and the characters
 * of a string, also of a String object, which JSON writes as its string.
 */
function costOf(value: unknown, key: string | undefined): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return 1;
  const keyLength = key?.length ?? 0;
  if (typeof value === "string" || value instanceof String) {
    return keyLength + Math.max(1, value.length);
  }
  return keyLength + 1;
}

function replyTimeout(tabId: number, type: string): ToolError {
  const silence = `The page in tab ${tabId} did not answer Foxleash within ${PAGE_REPLY_MS / 1000} seconds`;
  return new ToolError(
    "page_timeout",
    ACTING_REQUEST_TYPES.includes(type)
      ? `${silence}, but ${type} may already have run; read the page before you repeat it.`
      : `${silence}; try again.`,
  );
}

function pageUnreachable(tabId: number): ToolError {
  return new ToolError(
    "page_unreachable",
    `Firefox did not let Foxleash into the page in tab ${tabId}.`,
  );
}

/** `ran` names an act that was sent: it ran, so it is not to be repeated blindly. */
function pageChanged(tabId: number, ran?: string): ToolError {
  return new ToolError(
    "page_changed",
    ran === undefined
      ? `The page in tab ${tabId} changed while Foxleash was working in it; try again.`
      : `The page in tab ${tabId} changed after ${ran} ran; read the page before you repeat it.`,
  );
}

function pageError(tabId: number): ToolError {
  return new ToolError(
    "page_error",
    `Foxleash could not complete the request in the page in tab ${tabId}.`,
  );
}

function replyTooLarge(tabId: number): ToolError {
  return new ToolError(
    "page_reply_too_large",
    `The answer from the page in tab ${tabId} is too large to return.`,
  );
}
