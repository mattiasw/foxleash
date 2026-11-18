import type { BrowserApi, Cancel, HeadersReceivedDetails, HttpHeader } from "./browser-api.ts";
import type { SessionGroups } from "./session-groups.ts";
import { redactedUrl } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

/** The most refusals kept per tab, and so the most sites `refusedSince` returns. */
export const MAX_REFUSALS = 20;
/** The most tabs whose refusals are kept; the tab whose first one is the oldest goes first. */
export const MAX_REFUSAL_TABS = 100;

export interface FileGuardDeps {
  browser: Pick<BrowserApi, "webRequest" | "tabs">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "onRunningChange">;
}

export interface FileGuard {
  /**
   * The sites of what was refused in the tab at or after `since` (webRequest's clock), oldest
   * first, each once.
   */
  refusedSince(tabId: number, since: number): string[];
  /** Calls `listener` at each refusal; returns the function that removes it. */
  onRefused(listener: RefusalListener): () => void;
}

export type RefusalListener = (tabId: number, site: string, frameId: number) => void;

interface Refusal {
  site: string;
  frameId: number;
  /** The response's `timeStamp`. */
  at: number;
}

/** The redirects Firefox follows. It follows no 300, so that and every other 3xx is judged. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/**
 * 204 and 205 load nothing and save nothing. A 304 is no response of its own: Firefox reports the
 * one it then takes from its cache in a second event, with status 200 and the cached headers.
 */
const NO_CONTENT: ReadonlySet<number> = new Set([204, 205, 304]);
const PAGE_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

/**
 * In the tabs of a session's group, cancels the response to a page or frame load that is anything
 * other than a web page and comes from a site that session may not act on, so Firefox neither
 * saves nor shows it (ADR 0081). Call it at the top level of the background script. Its listener
 * is added when the first session starts running, not at once: Firefox wakes a suspended
 * background for a listener added at the top level, and holds the request meanwhile (ADR 0071).
 * It is never removed: a session's group outlives its session, and a page left open in it can
 * load a file at any time.
 */
export function createFileGuard({ browser, groups, access }: FileGuardDeps): FileGuard {
  const refusals = new Map<number, Refusal[]>();
  const listeners = new Set<RefusalListener>();
  let listening = false;

  access.onRunningChange(() => {
    if (listening) return;
    listening = true;
    browser.webRequest.onHeadersReceived.addListener(
      onHeaders,
      { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
      ["blocking", "responseHeaders"],
    );
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    refusals.delete(tabId);
  });

  return { refusedSince, onRefused };

  /** Answers at once, with nothing, for everything but a file: only that waits for a lookup. */
  function onHeaders(details: HeadersReceivedDetails): Promise<Cancel | undefined> | undefined {
    if (details.tabId < 0) return undefined;
    // Only these carry a response a site sent.
    if (!/^https?:/i.test(details.url)) return undefined;
    if (NO_CONTENT.has(details.statusCode)) return undefined;
    const headers = details.responseHeaders ?? [];
    // The next hop's own response is judged by its own address.
    if (REDIRECTS.has(details.statusCode) && named(headers, "location").length > 0) {
      return undefined;
    }
    if (isPage(headers)) return undefined;
    return judge(details);
  }

  async function judge(details: HeadersReceivedDetails): Promise<Cancel | undefined> {
    let session: string | undefined;
    try {
      const tab = await browser.tabs.get(details.tabId);
      session = groups.sessionOf(tab.groupId);
    } catch {
      // The tab is gone, so nothing is lost; a lookup that fails lets no file through.
      return { cancel: true };
    }
    if (session === undefined) return undefined;
    try {
      // Read anew each time: an approval the user withdrew a moment ago no longer counts.
      const view = await access.view(session);
      if (view.allowed(details.url)) return undefined;
    } catch {
      // A session the user stopped, or settings that cannot be read: refused.
    }
    const site = redactedUrl(details.url);
    // Nothing from here on can turn the cancel into a pass.
    attempt(() => record(details.tabId, { site, frameId: details.frameId, at: details.timeStamp }));
    for (const listener of [...listeners]) {
      attempt(() => listener(details.tabId, site, details.frameId));
    }
    return { cancel: true };
  }

  function record(tabId: number, refusal: Refusal): void {
    const kept = refusals.get(tabId) ?? [];
    kept.push(refusal);
    if (kept.length > MAX_REFUSALS) kept.shift();
    // A tab keeps its place in the map: the order is that of each tab's first refusal.
    refusals.set(tabId, kept);
    if (refusals.size <= MAX_REFUSAL_TABS) return;
    const oldest = refusals.keys().next();
    if (oldest.done !== true) refusals.delete(oldest.value);
  }

  function refusedSince(tabId: number, since: number): string[] {
    const sites = (refusals.get(tabId) ?? [])
      .filter((refusal) => refusal.at >= since)
      .map((refusal) => refusal.site);
    return [...new Set(sites)];
  }

  function onRefused(listener: RefusalListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
}

/**
 * Whether Firefox shows the response as a web page: no Content-Disposition or one of the type
 * `inline` (RFC 6266 section 4.2 treats an unknown type as `attachment`), and one Content-Type
 * that is HTML or XHTML. Everything else counts as a file, also a type Firefox would show: which
 * types it shows instead of saving depends on the user's settings.
 */
function isPage(headers: readonly HttpHeader[]): boolean {
  const dispositions = named(headers, "content-disposition");
  const types = named(headers, "content-type");
  if (dispositions.length > 1 || types.length !== 1) return false;
  if (dispositions.some(({ value }) => tokenOf(value) !== "inline")) return false;
  const type = types[0]?.value ?? "";
  // Firefox hands a repeated Content-Type over as one entry, joined with a comma, and goes by the
  // last type in it.
  return !type.includes(",") && PAGE_TYPES.has(tokenOf(type));
}

function named(headers: readonly HttpHeader[], name: string): HttpHeader[] {
  return headers.filter((header) => header.name.toLowerCase() === name);
}

/**
 * A header value's part before its first `;`, with spaces and tabs stripped from its ends and A to
 * Z lowercased. Deliberately not `trim()` and `toLowerCase()`, which also take away characters
 * that Firefox may keep in the token, and so would let through a value Firefox reads as another.
 */
function tokenOf(value: string | undefined): string {
  const [token = ""] = (value ?? "").split(";");
  const characters = [...token];
  // With nothing but spaces and tabs both indexes are -1, and the slice is empty.
  return characters
    .slice(characters.findIndex(isNotBlank), characters.findLastIndex(isNotBlank) + 1)
    .join("")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isNotBlank(character: string): boolean {
  return character !== " " && character !== "\t";
}

/** Runs a step whose failure must stop nothing that follows it. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // The response is cancelled all the same.
  }
}
