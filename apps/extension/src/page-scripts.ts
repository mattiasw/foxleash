import type { MethodName } from "@foxhand/protocol";
import type { BrowserApi, Timers } from "./browser-api.ts";
import { allowedPageSite, ToolError } from "./handlers.ts";
import {
  capText,
  MAX_PAGE_REPLY_CHARS,
  ownField,
  PAGE_ERROR_CODES,
  PAGE_REQUEST_KIND,
  type PageRequest,
} from "./page-messages.ts";
import type { SessionGroups } from "./session-groups.ts";
import { isRecord } from "./settings.ts";
import type { SiteAccess } from "./site-access.ts";

/** The content script's bundle in the extension. */
export const CONTENT_SCRIPT = "content.js";
/** With PAGE_REPLY_MS, below the host's 60 s request timeout, which shuts the host down. */
export const PAGE_INJECTION_MS = 20_000;
export const PAGE_REPLY_MS = 10_000;

const MAX_ERROR_MESSAGE = 500;

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
  "upload_file",
] satisfies readonly MethodName[];

export interface PageScriptsDeps<Handle> {
  browser: Pick<BrowserApi, "tabs" | "scripting">;
  groups: Pick<SessionGroups, "groupOf">;
  access: Pick<SiteAccess, "view" | "openPrompt">;
  timers: Timers<Handle>;
}

export interface PageScripts {
  /**
   * Sends a request to Foxhand's content script in the top frame of a tab the session may act
   * in, injecting the script first, and returns the result of the request's page handler.
   */
  request(
    session: string,
    tabId: number,
    type: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}

export function createPageScripts<Handle>(deps: PageScriptsDeps<Handle>): PageScripts {
  const { browser, timers } = deps;
  return { request };

  async function request(
    session: string,
    tabId: number,
    type: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const site = await allowedPageSite(deps, session, tabId);
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
        `Foxhand could not get into the page in tab ${tabId} in time; try again.`,
      ),
    );
    const top = frames.find((frame) => frame.frameId === 0);
    if (top === undefined || top.error !== undefined) throw pageUnreachable(tabId);
    await checkAgain(session, tabId, site);
    const message: PageRequest = { kind: PAGE_REQUEST_KIND, type, site, params };
    const reply = await bounded(
      () => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      PAGE_REPLY_MS,
      // The document went away, or the reply could not be cloned.
      pageChanged(tabId),
      replyTimeout(tabId, type),
    );
    // Nothing from the page reaches the agent once the user has withdrawn access.
    await checkAgain(session, tabId, site);
    return parsePageReply(reply, site, tabId);
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

  /** The gate again, after a wait during which the user may have withdrawn access or the tab moved on. */
  async function checkAgain(session: string, tabId: number, site: string): Promise<void> {
    if ((await allowedPageSite(deps, session, tabId)) !== site) throw pageChanged(tabId);
  }
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
  const silence = `The page in tab ${tabId} did not answer Foxhand within ${PAGE_REPLY_MS / 1000} seconds`;
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
    `Firefox did not let Foxhand into the page in tab ${tabId}.`,
  );
}

function pageChanged(tabId: number): ToolError {
  return new ToolError(
    "page_changed",
    `The page in tab ${tabId} changed while Foxhand was working in it; try again.`,
  );
}

function pageError(tabId: number): ToolError {
  return new ToolError(
    "page_error",
    `Foxhand could not complete the request in the page in tab ${tabId}.`,
  );
}

function replyTooLarge(tabId: number): ToolError {
  return new ToolError(
    "page_reply_too_large",
    `The answer from the page in tab ${tabId} is too large to return.`,
  );
}
