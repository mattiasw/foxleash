import type {
  BrowserApi,
  Cancel,
  CreatedNavigationTargetDetails,
  HeadersReceivedDetails,
  HttpHeader,
  Tab,
} from "./browser-api.ts";
import type { SessionGroups } from "./session-groups.ts";
import { redactedUrl } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

/** The most refusals kept per tab, and so the most sites `refusedSince` returns. */
export const MAX_REFUSALS = 20;
/** The most tabs whose refusals are kept; the tab whose first one is the oldest goes first. */
export const MAX_REFUSAL_TABS = 100;

export interface FileGuardDeps {
  browser: Pick<BrowserApi, "webRequest" | "tabs" | "webNavigation">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "onRunningChange">;
}

export interface FileGuard {
  /**
   * The sites of what was refused in the tab at or after `since` (webRequest's clock), oldest
   * first, each once. A refusal in a tab or window opened from the tab, or from a chain of them,
   * is listed for the tab too.
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

/** What a tab is judged as. */
interface Judgement {
  session: string;
  /** With a tie: the tab in a session's group that the chain of openers began in. */
  opener?: number;
}

/** The judgement of a tab or window opened from a tab judged as a session's. */
interface Tie {
  session: string;
  opener: number;
}

/** A tab or window opened from another tab's frame. */
interface Opened {
  /** The tab whose frame opened it. */
  source: number;
  /** Settles to undefined when the source was no session's; never rejects. */
  tie: Promise<Tie | undefined>;
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
 * saves nor shows it (ADR 0081). A tab or window opened from a tab judged as a session's is judged
 * as that session's too, until it closes (ADR 0089). Call it at the top level of the background
 * script. Its listeners, for the responses and for the tabs that tabs open, are added when the
 * first session starts running, not at once: Firefox wakes a suspended background for a listener
 * added at the top level, and holds the request meanwhile (ADR 0071). They are never removed: a
 * session's group outlives its session, and a page left open in it can load a file at any time.
 */
export function createFileGuard({ browser, groups, access }: FileGuardDeps): FileGuard {
  const refusals = new Map<number, Refusal[]>();
  const listeners = new Set<RefusalListener>();
  const opened = new Map<number, Opened>();
  let listening = false;

  access.onRunningChange(listen);
  browser.tabs.onRemoved.addListener((tabId) => {
    refusals.delete(tabId);
    opened.delete(tabId);
  });

  return { refusedSince, onRefused };

  function listen(): void {
    if (listening) return;
    listening = true;
    browser.webRequest.onHeadersReceived.addListener(
      onHeaders,
      { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
      ["blocking", "responseHeaders"],
    );
    browser.webNavigation.onCreatedNavigationTarget.addListener(tie);
  }

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
    let judged: Judgement | undefined;
    try {
      judged = await judgedSession(details.tabId);
    } catch {
      // The tab is gone, so nothing is lost; a lookup that fails lets no file through.
      return { cancel: true };
    }
    if (judged === undefined) return undefined;
    try {
      // Read anew each time: an approval the user withdrew a moment ago no longer counts.
      const view = await access.view(judged.session);
      if (view.allowed(details.url)) return undefined;
    } catch {
      // A session the user stopped, or settings that cannot be read: refused.
    }
    refused(
      details.tabId,
      redactedUrl(details.url),
      details.frameId,
      details.timeStamp,
      judged.opener,
    );
    return { cancel: true };
  }

  /** Rejects when the tab is gone. */
  async function judgedSession(tabId: number): Promise<Judgement | undefined> {
    // Taken before the lookup: the tab can close meanwhile, and its entry with it.
    const entry = opened.get(tabId);
    const tab = await browser.tabs.get(tabId);
    return sessionOfTab(tab, entry);
  }

  async function sessionOfTab(tab: Tab, entry: Opened | undefined): Promise<Judgement | undefined> {
    const session = groups.sessionOf(tab.groupId);
    // The group wins over a tie, and a refusal there is not the old opener's.
    if (session !== undefined) return { session };
    if (entry === undefined) return undefined;
    const tie = await entry.tie;
    if (tie !== undefined) return tie;
    // The source was no session's when it opened the tab, but may have joined a group since.
    return tieOf(entry.source).catch(() => undefined);
  }

  /** The only place a refusal is recorded. The opener hears of it for `refusedSince` only. */
  function refused(
    tabId: number,
    site: string,
    frameId: number,
    at: number,
    opener?: number,
  ): void {
    const refusal = { site, frameId, at };
    // Nothing from here on can turn the cancel into a pass.
    attempt(() => record(tabId, refusal));
    if (opener !== undefined) attempt(() => record(opener, refusal));
    for (const listener of [...listeners]) {
      attempt(() => listener(tabId, site, frameId));
    }
  }

  function tie(details: CreatedNavigationTargetDetails): void {
    // The source's own tie, taken now: a page can close a window or tab it opened at once, and
    // its entry goes with it.
    const fallback = opened.get(details.sourceTabId)?.tie;
    opened.set(details.tabId, {
      source: details.sourceTabId,
      tie: tieOf(details.sourceTabId).catch(() => fallback),
    });
  }

  /** Rejects when the source is gone. */
  async function tieOf(source: number): Promise<Tie | undefined> {
    const judged = await judgedSession(source);
    if (judged === undefined) return undefined;
    // A chain of tabs points at the tab in a session's group it began in.
    return { session: judged.session, opener: judged.opener ?? source };
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
