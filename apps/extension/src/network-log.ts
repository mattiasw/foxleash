import {
  MAX_NETWORK_HEADER,
  MAX_NETWORK_HEADERS,
  MAX_NETWORK_REQUESTS,
  MAX_NETWORK_URL,
  type NetworkHeader,
  type NetworkRequest,
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
} from "./browser-api.ts";
import { createLiveDocuments, type LiveDocument } from "./live-documents.ts";
import { capText } from "./page-messages.ts";
import type { SessionGroups } from "./session-groups.ts";
import { siteOf, withoutFragment } from "./site.ts";
import type { SiteAccess } from "./site-access.ts";

/** The most UTF-16 units a page's log holds across all its strings; older requests go first. */
export const MAX_LOG_CHARS = 4_000_000;
export const REDACTED = "[redacted]";
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

export interface NetworkLogDeps {
  browser: Pick<BrowserApi, "tabs" | "webNavigation" | "storage" | "webRequest">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "openPrompt">;
}

export interface NetworkReadOptions {
  pattern?: string;
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
  /** The session's approval of the site ended: no request of its tabs there is read again. */
  withdraw(session: string, site: string): void;
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
  /** The `timeStamp` of the commit. */
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
  dropped: boolean;
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
 * credential headers redacted and every string capped as it arrives. Adds its listeners at once
 * (call it at the top level of the background script); none of them blocks a request.
 */
export function createNetworkLog({ browser, groups, access }: NetworkLogDeps): NetworkLog {
  const logs = new Map<number, Log>();
  const pages = new Map<number, Page>();
  // The `timeStamp` of each tab's latest top-frame commit, on a web URL or not.
  const committedAt = new Map<number, number>();
  const documents = createLiveDocuments({
    browser,
    groups,
    access,
    failure: "network_recording_failed",
    onCommit,
    onDecided,
  });

  const { webRequest } = browser;
  webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] });
  webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ["<all_urls>"] }, ["requestHeaders"]);
  webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ["<all_urls>"] }, [
    "responseHeaders",
  ]);
  webRequest.onBeforeRedirect.addListener(onBeforeRedirect, { urls: ["<all_urls>"] });
  webRequest.onCompleted.addListener(onCompleted, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  webRequest.onErrorOccurred.addListener(onErrorOccurred, { urls: ["<all_urls>"] });
  browser.tabs.onRemoved.addListener((tabId) => {
    logs.delete(tabId);
    pages.delete(tabId);
    committedAt.delete(tabId);
  });

  return { read, withdraw: documents.withdraw, requestsSince };

  function onCommit(tabId: number, url: string, timeStamp: number): void {
    logs.delete(tabId);
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
      dropped: false,
    };
    logs.set(tabId, log);
    if (page !== undefined && loads(page, log)) addPage(log, page);
  }

  function onDecided(tabId: number, live: LiveDocument | undefined): boolean {
    const log = logs.get(tabId);
    if (log === undefined || log.live !== undefined) return true;
    if (live === undefined || live.site !== log.site) logs.delete(tabId);
    else log.live = live;
    return true;
  }

  function onBeforeRequest(details: RequestDetails): void {
    const { tabId, requestId } = details;
    if (tabId < 0) return;
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
  }

  function onSendHeaders(details: SendHeadersDetails): void {
    update(details.tabId, details.requestId, false, (request) => {
      request.requestHeaders = redactHeaders(details.requestHeaders);
    });
  }

  function onHeadersReceived(details: HeadersReceivedDetails): void {
    update(details.tabId, details.requestId, false, (request) => {
      request.status = details.statusCode;
      request.responseHeaders = redactHeaders(details.responseHeaders);
    });
  }

  function onBeforeRedirect(details: RedirectDetails): void {
    update(details.tabId, details.requestId, true, (request) => {
      request.status = details.statusCode;
      request.redirectUrl = capText(details.redirectUrl, MAX_NETWORK_URL).text;
      request.fromCache = details.fromCache;
      request.durationMs = details.timeStamp - request.startTime;
    });
  }

  function onCompleted(details: CompletedDetails): void {
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
      logs.delete(tabId);
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

  function trim(log: Log): void {
    while (log.entries.length > MAX_NETWORK_REQUESTS || log.chars > MAX_LOG_CHARS) {
      const oldest = log.entries.shift();
      if (oldest === undefined) return;
      log.chars -= oldest.chars;
      if (log.open.get(oldest.requestId) === oldest) log.open.delete(oldest.requestId);
      log.dropped = true;
    }
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
    { pattern, limit }: NetworkReadOptions,
  ): Result<"read_network"> {
    const log = current(tabId);
    if (log?.live === undefined || log.live.session !== session || log.live.site !== site) {
      return { recording: false, requests: [], truncated: false };
    }
    const matches =
      pattern === undefined
        ? log.entries
        : log.entries.filter((entry) => entry.request.url.includes(pattern));
    const kept = matches.slice(Math.max(0, matches.length - limit));
    return {
      recording: true,
      requests: kept.map((entry) => copyOf(entry.request)),
      truncated: log.dropped || matches.length > kept.length,
    };
  }
}

/** The headers as Foxleash keeps them: capped, and the credential ones without their value. */
export function redactHeaders(headers: readonly HttpHeader[] | undefined): NetworkHeader[] {
  return (headers ?? []).slice(0, MAX_NETWORK_HEADERS).map(({ name, value }) => ({
    name: capText(name, MAX_NETWORK_HEADER).text,
    value: REDACTED_HEADERS.has(name.toLowerCase())
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
  return chars;
}

function copyOf(request: NetworkRequest): NetworkRequest {
  const copy: NetworkRequest = {
    url: request.url,
    method: request.method,
    type: request.type,
    startTime: request.startTime,
    requestHeaders: request.requestHeaders.map((header) => ({ ...header })),
    responseHeaders: request.responseHeaders.map((header) => ({ ...header })),
  };
  if (request.durationMs !== undefined) copy.durationMs = request.durationMs;
  if (request.status !== undefined) copy.status = request.status;
  if (request.redirectUrl !== undefined) copy.redirectUrl = request.redirectUrl;
  if (request.error !== undefined) copy.error = request.error;
  if (request.fromCache !== undefined) copy.fromCache = request.fromCache;
  return copy;
}
