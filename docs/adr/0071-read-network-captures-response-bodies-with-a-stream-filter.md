# 0071: read_network captures response bodies with a stream filter it never disconnects

**Status:** Accepted, 2026-11-17. Supersedes the rule "Non-blocking listeners only" and the
rejected alternative "Response bodies" of
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md).

Amended 2026-11-17: the capture no longer disconnects its filter once data flows (at the cap, on
a release or on a fault), since a disconnect after the start reordered or dropped the chunks
still on their way; it disconnected the filter only inside `onstart`, before any data.

Amended by [0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md),
2026-11-18: "it never blocks or changes a request" gains the exception of a page or frame load in
a tab of a session's group whose answer is not a web page and comes from a site the session may
not act on, which is cancelled.

Amended 2026-11-19: no filter is disconnected at all, since the `onstart` disconnect too
reordered or dropped chunks on Firefox 156.0.1 under CPU contention.

Amended by [0099](0099-download-cancels-redirect-hops-to-sites-the-session-may-not-act-on.md),
2026-11-19: "it never blocks or changes a request" gains the exception of a download's redirect
hop to a site the session may not act on, which is cancelled.

Amended by [0101](0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md), 2026-11-19: it
also gains the exception of a redirect hop to a blocklisted site in a load the agent started in a
session tab, which is cancelled.

Amended 2026-11-20: a filter cannot pass a response's failure on, so a response the connection
cuts short reaches a recorded page as complete; the limit is now stated, and `read_network` gives
such a request no body.

## Context

A form's POST answered 500 with a 36-byte JSON body, and `read_network` gave the agent only the
status and headers. A response body cannot be fetched afterwards, and sending the request again
can be impossible (a single-use reCAPTCHA token) or harmful (a second form submission). Before
the first public listing, the maintainer decided that Foxleash reads response bodies with a
stream filter (`browser.webRequest.filterResponseData`), with the manifest permissions
`webRequestBlocking` and `webRequestFilterResponse`. The add-on listing states that Foxleash
passes every byte of each response on to the page unchanged and never changes a request, and
names the few things it stops.

What bound the design was measured
([response stream filter measurements](../measurements/response-stream-filter.md); M1 to M16 are
in [how a stream filter behaves](../measurements/response-stream-filter.md#how-a-stream-filter-behaves-2026-11-17)).
A filter works only for a request a blocking listener of the add-on saw (M1); one that returns at
once is enough, also when added at runtime for one tab (M2, M14), but every blocking listener
costs a round trip to the background, tens to hundreds of milliseconds while the event page is
suspended (M13). Bodies arrive decoded (M3). The headers and the filter's events come in no fixed
order (M6). A filter does not follow a redirect or reach a service worker's answer (M7, M9).
`disconnect()` throws before the filter starts (M5); once data flows, a disconnect reorders or
drops the chunks still on their way
([disconnecting after the start](../measurements/response-stream-filter.md#disconnecting-after-the-start-2026-11-17)),
and on Firefox 156.0.1 so did one inside `onstart`, on CI
([the order test on CI](../measurements/response-stream-filter.md#the-order-test-on-ci-with-the-onstart-disconnect-2026-11-19))
and under CPU contention
([disconnecting at the start](../measurements/response-stream-filter.md#disconnecting-at-the-start-under-cpu-contention-2026-11-19)).
A filter cannot pass a response's failure on
([a response the connection cuts short](../measurements/response-stream-filter.md#a-response-the-connection-cuts-short-2026-11-20)).

## Decision

- **Blocking.** Apart from the hold below, which returns at once, and three listeners that cancel,
  Foxleash "never blocks or changes a request". The three are the file guard
  ([0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md)), a download's
  redirect hop ([0099](0099-download-cancels-redirect-hops-to-sites-the-session-may-not-act-on.md))
  and a redirect hop to a blocklisted site in a tab's top-level load while the agent waits for a
  load there and for 5 minutes after
  ([0101](0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md)); each record gives its
  exception's full scope. The doc comment on `webRequest` in `apps/extension/src/browser-api.ts`
  lists the four blocking places.
- **A per-tab hold.** While a tab has a live log (ADR 0016, 0066), `network-log.ts` keeps one
  blocking `onBeforeRequest` listener for it, `{ urls: ["<all_urls>"], types: ["xmlhttprequest"],
  tabId }`, which returns `undefined` at once (M2, M14). `goneLive` adds it; `dropLog` removes it
  whenever the tab is left without its live log (a commit, a refusal, a log dropped because its
  document stopped being live, the tab closing). A tab has at most one. No listener of the network
  log returns a Promise or a BlockingResponse.
- **When a filter is attached.** In the non-blocking `onBeforeRequest`, right after the request's
  entry is pushed to the tab's log (so nothing from before recording started is captured), only
  for `type` `xmlhttprequest`, a live log, and a request whose own URL is approved for the session
  and not on the blocklist (`SiteView.allowed`), whether the page or a frame made it, and while
  the log has fewer than `MAX_OPEN_CAPTURES` (64) captures open.
- **A synchronous site check.** `onBeforeRequest` cannot wait for `access.view()`, so `viewOf`
  caches each session's `SiteView`, read when a log goes live and on a miss, never awaited: a
  request that misses goes uncaptured. Every settings change, grant, withdrawal and stop clears the
  cache synchronously (`clearViews`), and a read started before a clear is thrown away. After each
  read every open capture of the session asks again; a failed read, or a chunk that arrives with no
  current view, releases it. `dropRefusedBodies` forgets the stored bodies from sites a read
  refuses, and `read` gives no body without a current view.
- **The capture** (`captureResponse` in `response-body.ts`). `ondata` writes each chunk on, then
  copies it up to `MAX_NETWORK_RESPONSE_BYTES` (65,536); a chunk past that marks the body truncated
  and the copying stops. A body is stored once the response ended or the copy limit cut it, its
  headers said text and the site check allows it, in any order (M6). The capture is released, its
  copy dropped, for a type that is not text, a site check that refuses, a redirect or a new hop
  (the next hop decides on its own URL, M7, M9), an error, the end of the log or its tab, a dropped
  entry and any exception. Once a capture ends, `passOn` takes the filter's events, holding
  nothing but the filter: it sets no `onstart`, writes every chunk on in the order it arrives and
  closes the filter at the stop. No response's stream filter is ever disconnected, before, at or
  after its start.
- **Text only.** `textEncoding` keeps a response with exactly one `Content-Type` header of
  `text/*` other than `text/event-stream` (it has no end at which a body is complete),
  `application/json`, `application/xml`, `application/javascript`,
  `application/x-www-form-urlencoded`, `application/*+json` or `application/*+xml`, decoded by its
  charset, UTF-8 when it names none or an unknown one. A charset that can decode ASCII bytes
  to other characters ([response bodies](../security.md#response-bodies) lists them), a UTF-16
  byte order mark and a NUL in the text are refused: they would hide a token from the redaction.
- **Redaction, as a best effort.** Before the text is cut to `MAX_NETWORK_RESPONSE_TEXT` (32,768
  UTF-16 units), `redactTokens` replaces with `[redacted]` the values of keys named
  `access_token` or `refresh_token` with any prefix, or `id_token` with none (in any case,
  camelCase or with a hyphen), in JSON, JavaScript, XML elements and form or query fields, and JWT-shaped strings, also when the text ends inside one. Every pattern starts
  only where a name or token can start, so none rescans a long run of text from every position.
- **Shape and reading.** The field `NetworkRequest.responseBody?: { text, truncated? }` in
  `packages/protocol` came with protocol 6. It is returned only with the read option
  `responseBody: true`, off by default (ADR 0065), and only once its request ended (`copyOf`). A
  body stored before an error, at the copy limit or at a stop that came first, is dropped at the
  error (`onErrorOccurred`). Bodies count toward the page's `MAX_LOG_CHARS` (4,000,000); while
  they take more than half of it, `trim` drops the oldest bodies before any request.
- **A cut response is stated and pinned.** The add-on listing and
  [response bodies](../security.md#response-bodies) state that a response that fails while it
  arrives reaches a recorded page without its error. The end-to-end test `a response the connection
  cuts short reaches a recorded page as complete, and read_network shows the error` in
  `e2e/network.test.ts` pins it, so a Firefox change that passes the error on shows.

## Alternatives rejected

- **One static blocking listener for every fetch.** It would hold every tab's requests for a round
  trip to the background, and for tens to hundreds of milliseconds while the event page is
  suspended (M13). The per-tab hold confines that to tabs being recorded.
- **Registering the recording listener itself as blocking.** It sees every request of every type
  in the browser.
- **Attaching the filter inside the hold.** The entry must exist first, and the order in which
  Firefox calls two listeners is not something to build on.
- **`filterResponseData` without the two permissions or without a blocking listener.** It fails
  (M1, ADR 0016).
- **Every resource type, or page loads.** A page load's body is the page itself, which the page
  tools read under their own rules; scripts, styles and images are large and rarely what a
  request's outcome hinges on.
- **Capturing every request ADR 0016 lists, frames' requests to other sites included.** A frame
  from a blocklisted or unapproved site would hand its bodies to the agent.
- **Waiting for `view()` in `onBeforeRequest`.** A listener that returns a Promise blocks the
  request.
- **Attaching the filter only once the headers show a text type.** That needs a blocking
  `onHeadersReceived`, which makes every recorded request wait for the background (M13, M14), and
  kept text responses would still lose their error.
- **Disconnecting the filter once a capture ends**, mid-stream as 0.5.0 did, only inside
  `onstart`, or only on versions measured safe. A disconnect after the start reordered or dropped
  chunks; 0.5.0's passed a cut response's error on but changed 20 and 28 of 40 complete responses
  per case on 156.0.1; the `onstart` disconnect damaged responses on 156.0.1 under contention, 153
  is the minimum version, and the affected range is unknown.
- **Disconnecting after `onstart` while no chunk has arrived yet.** Not measured, and the headers
  and the filter's events come in no fixed order (M6), so a capture can end at any point of the
  response, and both disconnect points measured before the stop, inside `onstart` and once data
  flowed, damaged responses on 156.0.1.
- **Closing the filter early.** It would cut the response short for the page.
- **`disconnect()` at the stop.** The page still gets no error.
- **Keeping the partial body with `truncated`.** The error already says the body is incomplete,
  and the tool promises no body on error.

## Consequences

- A recorded tab's fetches wait for the background's answer to the hold (M13). Other tabs, and
  tabs outside a session, are never held.
- Every filtered response, kept or not, passes through the extension chunk by chunk to its end,
  also past the cap: a round trip per chunk. A round whose capture ended before the start took a
  median 2 to 4 ms longer on loopback
  ([disconnecting at the start](../measurements/response-stream-filter.md#disconnecting-at-the-start-under-cpu-contention-2026-11-19)).
- A response the connection cuts short reaches a recorded page as complete: with the status the
  server sent (200 in every measured case), the bytes that arrived and no error. This holds for
  every filtered response; 0.5.0 lost the error only for text under the copy limit. A page that
  saves or acts on what it fetched (an export, an editor saving a document back) can take a short
  body as the whole. `read_network` gives such a request its error and no body
  ([response bodies](../security.md#response-bodies)).
- No body for: a request whose response is still arriving; a request that ended in an error (a
  response with an error status keeps its body) or was redirected; a service worker's answer
  (M9); a non-text, event-stream or header-less response, or one in a refused charset; a body
  whose site stopped being approved or was blocklisted; a request started in the moment after
  recording began, before the hold or the site check is in place (its filter errors or none is
  attached); a request beyond 64 open captures; one whose recording was interrupted while it
  arrived; a body dropped to make room.
- The rule is the request's own URL, so a frame from another site that fetches from an approved
  site, and a response the page cannot read (`no-cors`, a failed CORS check), are captured.
  Redaction is a best effort, as ADR 0016 says of URLs and headers; what it misses, a response
  that echoes a form included, is listed in [response bodies](../security.md#response-bodies).
- A body that finishes between a storage write and its `onChanged` event is stored under the
  access Foxleash had seen, as every gate check acts on the state it has seen.
- A background that stopped in the middle of a response left the page every byte in M11, measured
  only with chunks 200 ms apart. Whether Firefox's own hand-back then reorders the chunks of a
  fast response was not measured, and every filtered response now stays filtered to its end, so
  every one is exposed to it.
- A capture that ended leaves the 64 open captures while its filter still passes data, so a page
  can have more than 64 filters open; the bound of 4 MiB on copies (64 captures of 64 KiB per
  page) holds. A long response, such as an event stream, whose capture ended keeps its filter open
  and the event page awake (M12) while it lasts. Its handlers hold only the filter, so the
  capture, its hooks and the page's network log are freed.
- A write that throws loses that chunk for the page; the later chunks are still written.
- The end-to-end suite runs on 160.0.1 and 153.7.0esr, where the `onstart` disconnect did not
  reorder; the unit tests' assertions that no filter is disconnected are the guard.
- Firefox shows no permission line for `webRequestBlocking` or `webRequestFilterResponse`: read
  in its source (M15) and seen on the update to 0.5.0
  ([an update that adds the two permissions](../measurements/response-stream-filter.md#an-update-that-adds-the-two-permissions-2026-11-17)).
