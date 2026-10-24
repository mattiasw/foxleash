# 0016: read_network records each live document's requests with non-blocking webRequest listeners

**Status:** Accepted, 2026-10-22.

## Context

`read_network` returns the network requests of a page in the agent's tab group: URL, method,
resource type, status, timing, redirect target, error, cache flag and headers. The manifest
already has `webRequest`, `webNavigation` and `<all_urls>`, and no `webRequestBlocking`; the
add-on listing says "Foxhand does not block or change any request" and that page content,
network requests included, "comes only from what a tab showed or loaded while its page was on a
site you approved". Firefox calls `webRequest` listeners for every request in the browser, the
user's own tabs and the browser itself included, and the request's own headers carry the
user's credentials (cookies, `Authorization`).

`read_console` (ADR 0015) already keeps, per tab, a recording that is live only while its
document's access has been uninterrupted since its top-frame commit. A window that only decides
at the commit and records until the next one leaks in three ways the listing forbids: the user
forgets the site for the session and approves it again later, and the requests from the gap are
read; the user drags the tab out of the group, browses in the page and drags it back; and a page
on an unapproved site restored from the back-forward cache (no commit) records into the approved
page's log.

Firefox can deliver a navigation's own request to the extension after it reports the commit
(measured on Firefox 156: 211 ms after), although the request's `timeStamp` is before the
commit's.

## Decision

- **Non-blocking listeners only.** `apps/extension/src/network-log.ts` adds six listeners at
  the top level of the background script (`onBeforeRequest`, `onSendHeaders` with
  `requestHeaders`, `onHeadersReceived` and `onCompleted` with `responseHeaders`,
  `onBeforeRedirect`, `onErrorOccurred`), each for `<all_urls>`, never with `"blocking"`, and
  none returns a value. A listener returns at once for a request of no tab or of a tab with no
  log.
- **Live documents.** The tracking that ADR 0015's "Live recordings" describes moves, unchanged,
  into `apps/extension/src/live-documents.ts`; the console recorder and the network log each
  create their own instance. A tab's log belongs to its latest top-frame commit on a web URL. It
  collects requests while the commit is checked, is dropped when the check refuses, and is read
  only while the same live document exists; once that document stops being live, the log is
  dropped and nothing more is recorded until the next commit.
- **The page's own request.** It is matched to its document by URL and by its start time
  between the tab's previous commit and this one: a `main_frame` request becomes the first entry
  of a log when its URL, without the fragment, equals the committed URL and it started after the
  tab's previous top-frame commit and no later than this one. The match is made at the commit
  for a request reported before it, and when the request arrives for one reported after it.
  Until then the tab's latest `main_frame` request is kept apart from every log, and each
  top-frame commit forgets it, matched or not, so the request of a navigation that never
  committed, or of a page refused earlier, never reaches a later log. Redirect hops before the
  final URL are not carried.
- **Late requests of the previous page.** A request is kept only when the site of its top-level
  document (`documentUrl`, else `originUrl`, in the top frame; the last of `frameAncestors` in a
  frame) is the log's site. An unload beacon of the previous page, which Firefox sends after the
  new page committed, does not land in the new page's log. Nor does a request, or a redirect hop
  of one, that started before the log's commit: Firefox can report a request of the previous page
  only after the new page's commit. Events for request ids the current log does not know are
  ignored.
- **Redaction at record time.** The values of `Cookie`, `Set-Cookie`, `Authorization` and
  `Proxy-Authorization` are replaced with `[redacted]`, the name compared in lowercase before any
  cut, so an unredacted value never sits in the log. `binaryValue` is never read.
- **Bounds.** Per page, the newest 500 requests and at most 4,000,000 UTF-16 units across all
  their strings; older requests are dropped and the result says `truncated`. URLs and redirect
  targets are cut to 2,000 units; header names and values, method, type and error to 1,000; at
  most 100 headers each way. `pattern` is at most 1,000 characters and `limit` 1 to 500, checked
  in the MCP server and again in the extension.
- **Filtering in the extension, by substring.** `pattern` is plain text that the URL must
  contain, so there is nothing to time-limit, unlike ADR 0015's regular expression. The MCP
  server checks the result's shape and limits again and, when a result within every bound still
  does not fit in one tool result, returns the most of its newest requests that do.

## Alternatives rejected

- **Response bodies.** They need `webRequestBlocking` and `webRequestFilterResponse`, measured on
  Firefox 156, and a filter intercepts every response from the moment capture starts; the listing
  promises Foxhand does not block or change any request.
- **Deciding only at the commit and recording until the next one.** The three leaks above.
- **Sharing `read_console`'s live recordings.** Its injection can fail (Firefox's PDF or JSON
  viewer), which would stop network recording too.
- **A regular expression for `pattern`.** The page chooses the URLs it runs against, so it would
  need a time limit, and a substring is enough to find requests.

## Consequences

- Requests started before the page's commit are left out, apart from its own document request.
  That covers any request Firefox starts for the page ahead of its commit, such as an Early
  Hints preload. `timeStamp` is wall-clock time, so when the system clock steps back past the
  commit, the page's requests are left out until the clock passes the commit's time again or
  the page loads again, while `recording` stays true.
- A page that loaded before the user approved its site, or whose access was interrupted, is not
  recorded until it loads again; `recording: false` says so.
- The latest `main_frame` request of every tab, the user's own included, is held in memory
  until the tab's next top-frame commit, its next `main_frame` request or its closing.
- When two requests of the committed URL start between the same two commits, such as a reload
  repeated at once, the log can begin with the one that did not commit.
- Requests of frames embedded from other sites, blocklisted ones included, are included.
- Unlike `read_console`, which starts recording only after the gate passes, requests made between
  the commit and the gate's answer are kept, so a tab moved into the group within those
  milliseconds, or out of it and back, keeps the requests its page made meanwhile (the same
  document, on the same approved site).
- Without a commit, same-site documents share a list: a same-site page's unload requests, or a
  same-site page restored from the back-forward cache.
- A redirect hop that an earlier same-site page's request makes after the commit lands in the new
  page's list.
- URLs and other headers can still carry tokens; the listing's `authenticationInfo` declaration
  says so.
- A result that does not fit in one tool result is cut to the newest requests that do.
