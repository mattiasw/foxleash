import {
  MAX_NETWORK_HEADER,
  MAX_NETWORK_HEADERS,
  MAX_NETWORK_REQUESTS,
  MAX_NETWORK_URL,
  type NetworkBody,
  type NetworkHeader,
  type NetworkRequest,
  type NetworkRequestRead,
  type NetworkResponseBody,
  type Result,
} from "@foxleash/protocol";
import type {
  BrowserApi,
  CompletedDetails,
  ErrorDetails,
  HeadersReceivedDetails,
  HttpHeader,
  RedirectDetails,
  RequestDetails,
  SendHeadersDetails,
  StreamFilter,
} from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { createLiveDocuments, type LiveDocument } from "./live-documents.ts";
import { warn } from "./log.ts";
import { capText } from "./page-messages.ts";
import { bodyShape } from "./request-body.ts";
import { captureResponse, REDACTED, type ResponseCapture, type Wanted } from "./response-body.ts";
import type { SessionGroups } from "./session-groups.ts";
import { onSettingsChanged } from "./settings.ts";
import { siteOf, withoutFragment } from "./site.ts";
import type { SiteAccess, SiteView } from "./site-access.ts";

export { REDACTED };

/** The most UTF-16 units a page's log holds across all its strings; older requests go first. */
export const MAX_LOG_CHARS = 4_000_000;
/** The most response bodies a page's log copies at once; a request beyond them gets none. */
export const MAX_OPEN_CAPTURES = 64;
/** Request bodies are left unread while this many milliseconds of shaping have not passed again. */
export const SHAPING_ALLOWANCE_MS = 250;
/**
 * The longest bodies stay unread after one was shaped, in milliseconds, also when the clock jumped
 * forward meanwhile. After a clock set back, what is owed is counted from the next body on.
 */
export const MAX_SHAPING_REST_MS = 10_000;
/** The webRequest resource types `requestsSince` leaves out. */
const UNWATCHED_TYPES: ReadonlySet<string> = new Set([
  "websocket",
  "media",
  "beacon",
  "ping",
  "csp_report",
]);
/** Lowercase: HTTP/2 names arrive lowercase, HTTP/1.1 names as the sender wrote them. */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
]);
/** A request's length follows what its body carries, protected values included (ADR 0070). */
export const REDACTED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  ...REDACTED_HEADERS,
  "content-length",
]);

export interface NetworkLogDeps {
  browser: Pick<BrowserApi, "tabs" | "webNavigation" | "storage" | "webRequest">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<
    SiteAccess,
    | "view"
    | "openPrompt"
    | "onWithdraw"
    | "onStop"
    | "onGrant"
    | "running"
    | "stopped"
    | "onRunningChange"
    | "generation"
  >;
  now: () => number;
}

export interface NetworkReadOptions {
  pattern?: string;
  types?: readonly string[];
  failed: boolean;
  headers: boolean;
  body: boolean;
  responseBody: boolean;
  limit: number;
}

export interface NetworkLog {
  /** The requests of the tab's live document, when it is the session's and on `site`. */
  read(
    session: string,
    tabId: number,
    site: string,
    options: NetworkReadOptions,
  ): Result<"read_network">;
  /**
   * The requests of the tab's live document that began at or after `since` (ms since the epoch,
   * as webRequest's timeStamp): how many began, how many of those have not ended, and when the
   * last of them to end ended, absent when none has, and likewise when the last fetch or
   * XMLHttpRequest of the top document among them ended. Left out: websockets and media streams,
   * which stay open for as long as the connection or the playback runs, and beacons, pings and CSP
   * reports, which cannot change the page.
   */
  requestsSince(tabId: number, since: number): RequestCounts;
}

export interface RequestCounts {
  begun: number;
  open: number;
  lastEnd?: number;
  lastFetchEnd?: number;
}

interface Entry {
  requestId: string;
  request: NetworkRequest;
  /** The length of all the request's strings. */
  chars: number;
  /** The request came from the tab's top document, not a frame. */
  top: boolean;
}

/** The requests of one top-frame document, in start order. */
interface Log {
  site: string;
  /** The committed URL without its fragment. */
  url: string;
  /** The `timeStamp` of the commit, or the time the log started at a grant. */
  at: number;
  /** The `timeStamp` of the tab's commit before it, or -Infinity. */
  since: number;
  /** Set once the document's own request is in it. */
  hasPage: boolean;
  /** Unset while the document's commit is being checked. */
  live?: LiveDocument;
  entries: Entry[];
  /** The entries whose request has not ended yet, by request id. */
  open: Map<string, Entry>;
  /** The sum of the entries' `chars`. */
  chars: number;
  /** The sum of the lengths of the entries' response bodies. */
  bodyChars: number;
  /** How many of its responses are being copied. */
  capturing: number;
  dropped: boolean;
}

/** A response being copied, for its request's entry in `log`. */
interface Capture {
  tabId: number;
  log: Log;
  entry: Entry;
  /** The request's own URL, uncapped. */
  url: string;
  capture: ResponseCapture;
}

/** A tab's latest `main_frame` request, kept until the tab's next commit. */
interface Page {
  requestId: string;
  /** Uncapped and without its fragment, to compare with the committed URL. */
  url: string;
  entry: Entry;
  ended: boolean;
}

type Change = (request: NetworkRequest) => void;

/**
 * Records the network requests of each live document (see live-documents.ts), per tab, with
 * credential headers redacted, request bodies reduced to their shape and every string capped as
 * it arrives, and the text of fetch and XHR responses from sites the session may act on. A request
 * body is read only in the tabs of the group of a running session the user has not stopped, within
 * a time allowance, and Firefox is asked for bodies only for those tabs, one listener per tab
 * (ADR 0085). Adds its listeners at once (call it at the top level of the background script); none
 * of them blocks or changes a request.
 */
export function createNetworkLog({ browser, groups, access, now }: NetworkLogDeps): NetworkLog {
  const logs = new Map<number, Log>();
  const pages = new Map<number, Page>();
  // The `timeStamp` of each tab's latest top-frame commit, on a web URL or not.
  const committedAt = new Map<number, number>();
  // Each tab with a live log has a blocking listener that returns at once: Firefox filters a
  // response only for an add-on with a blocking listener that saw its request (ADR 0071).
  const holds = new Map<number, (details: RequestDetails) => void>();
  // Each tab of a running, not stopped session's group has a non-blocking listener with
  // ["requestBody"]: Firefox builds a body only for a listener whose filter matches the request's
  // tab (ADR 0085).
  const bodyListeners = new Map<number, (details: RequestDetails) => void>();
  // By request id.
  const captures = new Map<string, Capture>();
  // The site view of each session, read ahead, since onBeforeRequest cannot wait for one.
  const views = new Map<string, SiteView>();
  const refreshing = new Set<string>();
  // Raised whenever access may have changed, so a view read before is never stored.
  let epoch = 0;
  // Each tab's group, -1 for none, as its latest event showed it: a request names no group.
  const tabGroups = new Map<number, number>();
  // The milliseconds spent shaping bodies that have not passed again since, as of `owedAt`. One
  // pair for every tab: they share the background's thread.
  let owed = 0;
  let owedAt = 0;
  const documents = createLiveDocuments({
    browser,
    groups,
    access,
    failure: "network_recording_failed",
    onCommit,
    onDecided,
  });

  const { webRequest } = browser;
  // Added first and never removed, so Firefox calls it before a tab's body listener.
  webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] });
  webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ["<all_urls>"] }, ["requestHeaders"]);
  webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ["<all_urls>"] }, [
    "responseHeaders",
  ]);
  webRequest.onBeforeRedirect.addListener(onBeforeRedirect, { urls: ["<all_urls>"] });
  webRequest.onCompleted.addListener(onCompleted, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  webRequest.onErrorOccurred.addListener(onErrorOccurred, { urls: ["<all_urls>"] });
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id === undefined) return;
    tabGroups.set(tab.id, tab.groupId ?? -1);
    syncBodies(tab.id);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Seen from the tab's own group, as Firefox does not always name a change of it.
    tabGroups.set(tabId, changeInfo.groupId ?? tab.groupId ?? -1);
    syncBodies(tabId);
  });
  // A group stays in its window, so a tab moved to another window has left it.
  browser.tabs.onDetached.addListener((tabId) => {
    tabGroups.set(tabId, -1);
    syncBodies(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    dropLog(tabId);
    pages.delete(tabId);
    committedAt.delete(tabId);
    tabGroups.delete(tabId);
    syncBodies(tabId);
  });
  void seedTabGroups();
  access.onRunningChange(syncAllBodies);
  access.onStop(syncAllBodies);
  onSettingsChanged(browser, clearViews);
  access.onGrant(clearViews);
  access.onWithdraw(clearViews);
  access.onStop(clearViews);

  return { read, requestsSince };

  /**
   * Gives the tab a body listener while it is in the group of a running session the user has not
   * stopped, and takes it away otherwise.
   */
  function syncBodies(tabId: number): void {
    const wanted = inRunningSession(tabId);
    const listener = bodyListeners.get(tabId);
    if (wanted && listener === undefined) {
      // A new function per tab: Firefox ignores a second add of a listener it already has.
      const added = (details: RequestDetails): void => onRequestBody(details);
      bodyListeners.set(tabId, added);
      webRequest.onBeforeRequest.addListener(added, { urls: ["<all_urls>"], tabId }, [
        "requestBody",
      ]);
    } else if (!wanted && listener !== undefined) {
      bodyListeners.delete(tabId);
      webRequest.onBeforeRequest.removeListener(listener);
    }
  }

  function syncAllBodies(): void {
    for (const tabId of tabGroups.keys()) syncBodies(tabId);
  }

  /** The group of each tab open before the listeners were added. */
  async function seedTabGroups(): Promise<void> {
    try {
      for (const tab of await browser.tabs.query({})) {
        // An event is newer than the query's answer.
        if (tab.id !== undefined && !tabGroups.has(tab.id)) {
          tabGroups.set(tab.id, tab.groupId ?? -1);
          syncBodies(tab.id);
        }
      }
    } catch (error: unknown) {
      warn({ event: "network_recording_failed", error: String(error) });
    }
  }

  function onCommit(tabId: number, url: string, timeStamp: number): void {
    dropLog(tabId);
    const page = pages.get(tabId);
    // Carried or not: a request of a navigation that never committed is no later document's.
    pages.delete(tabId);
    const since = committedAt.get(tabId) ?? -Infinity;
    committedAt.set(tabId, timeStamp);
    const site = siteOf(url);
    if (site === undefined) return;
    const log: Log = {
      site,
      url: withoutFragment(url),
      at: timeStamp,
      since,
      hasPage: false,
      entries: [],
      open: new Map(),
      chars: 0,
      bodyChars: 0,
      capturing: 0,
      dropped: false,
    };
    logs.set(tabId, log);
    if (page !== undefined && loads(page, log)) addPage(log, page);
  }

  function onDecided(tabId: number, live: LiveDocument | undefined): boolean {
    if (live?.startedBy === "grant") {
      // Starts empty: with its page set and no URL, no page request is ever attached.
      const at = now();
      forgetLog(tabId);
      logs.set(tabId, {
        site: live.site,
        url: "",
        at,
        since: at,
        hasPage: true,
        live,
        entries: [],
        open: new Map(),
        chars: 0,
        bodyChars: 0,
        capturing: 0,
        dropped: false,
      });
      goneLive(tabId, live);
      return true;
    }
    const log = logs.get(tabId);
    if (log === undefined || log.live !== undefined) return true;
    if (live === undefined || live.site !== log.site) {
      dropLog(tabId);
    } else {
      log.live = live;
      goneLive(tabId, live);
    }
    return true;
  }

  function goneLive(tabId: number, live: LiveDocument): void {
    viewOf(live.session);
    if (holds.has(tabId)) return;
    const hold = (): undefined => undefined;
    holds.set(tabId, hold);
    webRequest.onBeforeRequest.addListener(
      hold,
      { urls: ["<all_urls>"], types: ["xmlhttprequest"], tabId },
      ["blocking"],
    );
  }

  /** Ends the tab's log, its hold and every capture of the tab. */
  function dropLog(tabId: number): void {
    forgetLog(tabId);
    const hold = holds.get(tabId);
    if (hold === undefined) return;
    holds.delete(tabId);
    webRequest.onBeforeRequest.removeListener(hold);
  }

  /** Ends the tab's log and every capture of the tab. */
  function forgetLog(tabId: number): void {
    logs.delete(tabId);
    for (const record of [...captures.values()]) {
      if (record.tabId === tabId) record.capture.release();
    }
  }

  function onBeforeRequest(details: RequestDetails): void {
    const { tabId, requestId } = details;
    if (tabId < 0) return;
    // Catches up with a group event the log missed.
    syncBodies(tabId);
    // A hop that did not end, such as one a service worker answered.
    captures.get(requestId)?.capture.release();
    if (details.type === "main_frame") {
      const url = withoutFragment(details.url);
      const page: Page = { requestId, url, entry: entryOf(details), ended: false };
      const log = current(tabId);
      // Firefox can report a document's own request after its commit.
      if (log !== undefined && !log.hasPage && loads(page, log)) {
        // An earlier hop of the same request, also reported after the commit.
        if (pages.get(tabId)?.requestId === requestId) pages.delete(tabId);
        addPage(log, page);
      } else {
        pages.set(tabId, page);
      }
      return;
    }
    const log = current(tabId);
    if (log === undefined) return;
    // Firefox can report an earlier document's request after this one committed.
    if (details.timeStamp < log.at) return;
    // A request the previous document makes after this one committed, such as an unload beacon.
    if (siteOf(topDocumentUrl(details) ?? "") !== log.site) return;
    const entry = entryOf(details);
    log.entries.push(entry);
    log.open.set(requestId, entry);
    log.chars += entry.chars;
    trim(log);
    if (
      details.type === "xmlhttprequest" &&
      log.live !== undefined &&
      viewOf(log.live.session)?.allowed(details.url) === true &&
      log.capturing < MAX_OPEN_CAPTURES
    ) {
      attach(tabId, log, entry, details.url);
    }
  }

  /**
   * Fills in the shape of what the request sent, on the entry `onBeforeRequest` made for it; reads
   * nothing for a request the log does not record.
   */
  function onRequestBody(details: RequestDetails): void {
    update(details.tabId, details.requestId, false, (request) => {
      const body = bodyOf(details);
      if (body !== undefined) request.requestBody = body;
    });
  }

  /**
   * The shape of what the request sent. `other`, with the body left unread, outside the tabs of a
   * running session's group and while shaping has used up its time allowance (ADR 0085).
   */
  function bodyOf(details: RequestDetails): NetworkBody | undefined {
    if (details.requestBody === null || details.requestBody === undefined) return undefined;
    if (!inRunningSession(details.tabId)) return { kind: "other" };
    const start = now();
    // A clock set back pays nothing off; the debt is counted from the new time on.
    owed = Math.max(0, owed - Math.max(0, start - owedAt));
    owedAt = start;
    if (owed >= SHAPING_ALLOWANCE_MS) return { kind: "other" };
    try {
      return bodyShape(details.requestBody);
    } finally {
      owedAt = now();
      // Capped, so a clock set forward meanwhile leaves bodies unread for MAX_SHAPING_REST_MS at
      // most.
      owed = Math.min(
        owed + Math.max(0, owedAt - start),
        SHAPING_ALLOWANCE_MS + MAX_SHAPING_REST_MS - 1,
      );
    }
  }

  /** Whether the tab is in the group of a running session the user has not stopped. */
  function inRunningSession(tabId: number): boolean {
    const session = groups.sessionOf(tabGroups.get(tabId));
    return session !== undefined && readsBodies(session);
  }

  /** Whether the session runs and the user has not stopped it, asked of `access` each time. */
  function readsBodies(session: string): boolean {
    return access.running(session) && !access.stopped(session);
  }

  /** Starts copying the request's response, unless Firefox refuses to filter it. */
  function attach(tabId: number, log: Log, entry: Entry, url: string): void {
    let filter: StreamFilter;
    try {
      filter = webRequest.filterResponseData(entry.requestId);
    } catch {
      return;
    }
    log.capturing += 1;
    const record: Capture = {
      tabId,
      log,
      entry,
      url,
      capture: captureResponse(filter, {
        wanted: () => wanted(record),
        store: (body) => store(record, body),
        end: () => {
          log.capturing -= 1;
          if (captures.get(entry.requestId) === record) captures.delete(entry.requestId);
        },
      }),
    };
    captures.set(entry.requestId, record);
  }

  /** Whether the capture's log is still the tab's and its URL still on a site it may act on. */
  function wanted(record: Capture): Wanted {
    const live = current(record.tabId) === record.log ? record.log.live : undefined;
    if (live === undefined) return "no";
    const view = viewOf(live.session);
    if (view === undefined) return "unknown";
    return view.allowed(record.url) ? "yes" : "no";
  }

  function store({ tabId, log, entry }: Capture, body: NetworkResponseBody): void {
    if (current(tabId) !== log || !log.entries.includes(entry)) return;
    entry.request.responseBody = body;
    const chars = charsOf(entry.request);
    log.chars += chars - entry.chars;
    entry.chars = chars;
    log.bodyChars += body.text.length;
    trim(log);
  }

  /** The session's cached view; on a miss, starts reading one and gives undefined. */
  function viewOf(session: string): SiteView | undefined {
    const view = views.get(session);
    if (view === undefined) refreshView(session);
    return view;
  }

  function refreshView(session: string): void {
    if (refreshing.has(session)) return;
    refreshing.add(session);
    const started = epoch;
    access.view(session).then(
      (view) => {
        if (started !== epoch) return;
        refreshing.delete(session);
        views.set(session, view);
        dropRefusedBodies(session, view);
        for (const record of capturesOf(session)) record.capture.check();
      },
      (error: unknown) => {
        if (started !== epoch) return;
        refreshing.delete(session);
        // A stopped session's view throws a ToolError: nothing of it is recorded any more.
        if (!(error instanceof ToolError)) {
          warn({ event: "network_recording_failed", error: String(error) });
        }
        for (const record of capturesOf(session)) record.capture.release();
      },
    );
  }

  /** Forgets the response bodies of the session's logs from sites the view refuses. */
  function dropRefusedBodies(session: string, view: SiteView): void {
    for (const log of logs.values()) {
      if (log.live?.session !== session) continue;
      for (const entry of log.entries) {
        if (entry.request.responseBody !== undefined && !view.allowed(entry.request.url)) {
          dropBody(log, entry);
        }
      }
    }
  }

  function capturesOf(session: string): Capture[] {
    return [...captures.values()].filter((record) => record.log.live?.session === session);
  }

  /** Access may have changed: forgets every view and reads those of live logs again. */
  function clearViews(): void {
    epoch += 1;
    views.clear();
    refreshing.clear();
    for (const log of logs.values()) {
      if (log.live !== undefined) refreshView(log.live.session);
    }
  }

  function onSendHeaders(details: SendHeadersDetails): void {
    update(details.tabId, details.requestId, false, (request) => {
      request.requestHeaders = redactHeaders(details.requestHeaders, REDACTED_REQUEST_HEADERS);
    });
  }

  function onHeadersReceived(details: HeadersReceivedDetails): void {
    captures.get(details.requestId)?.capture.headers(details.responseHeaders);
    update(details.tabId, details.requestId, false, (request) => {
      request.status = details.statusCode;
      request.responseHeaders = redactHeaders(details.responseHeaders);
    });
  }

  function onBeforeRedirect(details: RedirectDetails): void {
    // The next hop's onBeforeRequest decides again, on its own URL.
    captures.get(details.requestId)?.capture.release();
    update(details.tabId, details.requestId, true, (request) => {
      request.status = details.statusCode;
      request.redirectUrl = capText(details.redirectUrl, MAX_NETWORK_URL).text;
      request.fromCache = details.fromCache;
      request.durationMs = details.timeStamp - request.startTime;
    });
  }

  function onCompleted(details: CompletedDetails): void {
    captures.get(details.requestId)?.capture.headers(details.responseHeaders);
    update(details.tabId, details.requestId, true, (request) => {
      request.status = details.statusCode;
      if (details.responseHeaders !== undefined) {
        request.responseHeaders = redactHeaders(details.responseHeaders);
      }
      request.fromCache = details.fromCache;
      request.durationMs = details.timeStamp - request.startTime;
    });
  }

  function onErrorOccurred(details: ErrorDetails): void {
    captures.get(details.requestId)?.capture.release();
    const log = current(details.tabId);
    const entry = log?.open.get(details.requestId);
    // A body can be stored before the error: at the copy limit, or at a stop that came first.
    if (log !== undefined && entry?.request.responseBody !== undefined) dropBody(log, entry);
    update(details.tabId, details.requestId, true, (request) => {
      request.error = capText(details.error, MAX_NETWORK_HEADER).text;
      request.durationMs = details.timeStamp - request.startTime;
    });
  }

  /** Applies `change` to the request's entry, when the tab's page or current log holds it. */
  function update(tabId: number, requestId: string, ends: boolean, change: Change): void {
    if (tabId < 0) return;
    const page = pages.get(tabId);
    if (page?.requestId === requestId) {
      if (page.ended) return;
      change(page.entry.request);
      page.entry.chars = charsOf(page.entry.request);
      if (ends) page.ended = true;
      return;
    }
    const log = current(tabId);
    const entry = log?.open.get(requestId);
    if (log === undefined || entry === undefined) return;
    change(entry.request);
    const chars = charsOf(entry.request);
    log.chars += chars - entry.chars;
    entry.chars = chars;
    if (ends) log.open.delete(requestId);
    trim(log);
  }

  /** The tab's log, unless its document stopped being live: then nothing of it is kept. */
  function current(tabId: number): Log | undefined {
    const log = logs.get(tabId);
    if (log?.live !== undefined && documents.live(tabId) !== log.live) {
      dropLog(tabId);
      return undefined;
    }
    return log;
  }

  /** Puts the document's own request first in its log. */
  function addPage(log: Log, page: Page): void {
    log.hasPage = true;
    log.entries.unshift(page.entry);
    log.chars += page.entry.chars;
    if (!page.ended) log.open.set(page.requestId, page.entry);
    trim(log);
  }

  /**
   * Drops the oldest requests over the count bound and, over the character bound, the oldest
   * response bodies first while bodies take more than half of it, so a page that polls keeps its
   * request list.
   */
  function trim(log: Log): void {
    while (log.entries.length > MAX_NETWORK_REQUESTS || log.chars > MAX_LOG_CHARS) {
      const withBody =
        log.entries.length <= MAX_NETWORK_REQUESTS && log.bodyChars > MAX_LOG_CHARS / 2
          ? log.entries.find((entry) => entry.request.responseBody !== undefined)
          : undefined;
      if (withBody !== undefined) {
        dropBody(log, withBody);
        continue;
      }
      const oldest = log.entries.shift();
      if (oldest === undefined) return;
      log.chars -= oldest.chars;
      log.bodyChars -= oldest.request.responseBody?.text.length ?? 0;
      if (log.open.get(oldest.requestId) === oldest) log.open.delete(oldest.requestId);
      const record = captures.get(oldest.requestId);
      if (record?.entry === oldest) record.capture.release();
      log.dropped = true;
    }
  }

  /** Forgets the entry's response body, keeping the entry. */
  function dropBody(log: Log, entry: Entry): void {
    log.bodyChars -= entry.request.responseBody?.text.length ?? 0;
    delete entry.request.responseBody;
    const chars = charsOf(entry.request);
    log.chars += chars - entry.chars;
    entry.chars = chars;
  }

  function requestsSince(tabId: number, since: number): RequestCounts {
    const log = current(tabId);
    if (log === undefined) return { begun: 0, open: 0 };
    const counted = (entry: Entry) =>
      entry.request.startTime >= since && !UNWATCHED_TYPES.has(entry.request.type);
    const begun = log.entries.filter(counted);
    const counts: RequestCounts = {
      begun: begun.length,
      open: [...log.open.values()].filter(counted).length,
    };
    for (const { request, top } of begun) {
      if (request.durationMs === undefined) continue;
      const end = request.startTime + request.durationMs;
      counts.lastEnd = Math.max(counts.lastEnd ?? -Infinity, end);
      if (top && request.type === "xmlhttprequest") {
        counts.lastFetchEnd = Math.max(counts.lastFetchEnd ?? -Infinity, end);
      }
    }
    return counts;
  }

  function read(
    session: string,
    tabId: number,
    site: string,
    { pattern, types, failed, headers, body, responseBody, limit }: NetworkReadOptions,
  ): Result<"read_network"> {
    const log = current(tabId);
    if (log?.live === undefined || log.live.session !== session || log.live.site !== site) {
      return { recording: false, requests: [], truncated: false };
    }
    const typeSet = types === undefined ? undefined : new Set(types);
    const matches = log.entries.filter(
      ({ request }) =>
        (pattern === undefined || request.url.includes(pattern)) &&
        (typeSet === undefined || typeSet.has(request.type)) &&
        (!failed || hasFailed(request)),
    );
    const kept = matches.slice(Math.max(0, matches.length - limit));
    // Without a current site view, a body may be from a site whose access just ended.
    const bodies = responseBody && viewOf(session) !== undefined;
    return {
      recording: true,
      since: log.at,
      requests: kept.map((entry) => copyOf(entry.request, headers, body, bodies)),
      truncated: log.dropped || matches.length > kept.length,
    };
  }
}

/** The headers as Foxleash keeps them: capped, and those named in `redacted` without a value. */
export function redactHeaders(
  headers: readonly HttpHeader[] | undefined,
  redacted: ReadonlySet<string> = REDACTED_HEADERS,
): NetworkHeader[] {
  return (headers ?? []).slice(0, MAX_NETWORK_HEADERS).map(({ name, value }) => ({
    name: capText(name, MAX_NETWORK_HEADER).text,
    value: redacted.has(name.toLowerCase())
      ? REDACTED
      : capText(value ?? "", MAX_NETWORK_HEADER).text,
  }));
}

/** Whether it is the request of the log's document: its URL, started between the tab's commits. */
function loads(page: Page, log: Log): boolean {
  const { startTime } = page.entry.request;
  return page.url === log.url && log.since < startTime && startTime <= log.at;
}

function entryOf(details: RequestDetails): Entry {
  const request: NetworkRequest = {
    url: capText(details.url, MAX_NETWORK_URL).text,
    method: capText(details.method, MAX_NETWORK_HEADER).text,
    type: capText(details.type, MAX_NETWORK_HEADER).text,
    startTime: details.timeStamp,
    requestHeaders: [],
    responseHeaders: [],
  };
  return {
    requestId: details.requestId,
    request,
    chars: charsOf(request),
    top: details.frameId === 0,
  };
}

/** The URL of the request's top-level document; `frameAncestors` ends at the top one. */
function topDocumentUrl(details: RequestDetails): string | undefined {
  if (details.frameId === 0) return details.documentUrl ?? details.originUrl;
  return details.frameAncestors?.at(-1)?.url;
}

function charsOf(request: NetworkRequest): number {
  let chars =
    request.url.length +
    request.method.length +
    request.type.length +
    (request.redirectUrl?.length ?? 0) +
    (request.error?.length ?? 0);
  for (const { name, value } of [...request.requestHeaders, ...request.responseHeaders]) {
    chars += name.length + value.length;
  }
  if (request.requestBody !== undefined) {
    chars += request.requestBody.kind.length;
    for (const { name, kind } of request.requestBody.fields ?? []) {
      chars += name.length + kind.length;
    }
  }
  return chars + (request.responseBody?.text.length ?? 0);
}

/** Status 400 or above, or Firefox's error; a redirect or a request still in flight has not. */
function hasFailed(request: NetworkRequest): boolean {
  return (request.status ?? 0) >= 400 || request.error !== undefined;
}

function copyOf(
  request: NetworkRequest,
  headers: boolean,
  body: boolean,
  responseBody: boolean,
): NetworkRequestRead {
  const copy: NetworkRequestRead = {
    url: request.url,
    method: request.method,
    type: request.type,
    startTime: request.startTime,
  };
  if (headers) {
    copy.requestHeaders = request.requestHeaders.map((header) => ({ ...header }));
    copy.responseHeaders = request.responseHeaders.map((header) => ({ ...header }));
  }
  if (body && request.requestBody !== undefined) {
    const { fields, ...shape } = request.requestBody;
    copy.requestBody = { ...shape };
    if (fields !== undefined) copy.requestBody.fields = fields.map((field) => ({ ...field }));
  }
  // Until the request ends, a failure can still take its body away.
  if (responseBody && request.responseBody !== undefined && request.durationMs !== undefined) {
    copy.responseBody = { ...request.responseBody };
  }
  if (request.durationMs !== undefined) copy.durationMs = request.durationMs;
  if (request.status !== undefined) copy.status = request.status;
  if (request.redirectUrl !== undefined) copy.redirectUrl = request.redirectUrl;
  if (request.error !== undefined) copy.error = request.error;
  if (request.fromCache !== undefined) copy.fromCache = request.fromCache;
  return copy;
}
