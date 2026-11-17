# 0071: read_network captures response bodies with a stream filter

**Status:** Accepted, 2026-11-17. Supersedes the rule "Non-blocking listeners only" and the
rejected alternative "Response bodies" of
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md).

## Context

A form's POST answered 500 with a 36-byte JSON body, and `read_network` gave the agent only the
status and headers. A response body cannot be fetched afterwards, and sending the request again
can be impossible (a single-use reCAPTCHA token) or harmful (a second form submission). The
maintainer decided that Foxleash reads response bodies with a stream filter
(`browser.webRequest.filterResponseData`), with the manifest permissions `webRequestBlocking` and
`webRequestFilterResponse`, before the first public listing. The listing's sentence "Foxleash
does not block or change any request" becomes "Foxleash reads these responses and passes every
byte on unchanged; it never blocks or changes a request."

Measured in Firefox 156.0.1, headless, with a probe add-on (MV3 event page, the three
`webRequest` permissions and `<all_urls>`) and a local server on 127.0.0.1 and localhost; the
page computed a SHA-256 of what it received and the server of what it sent:

- M1. `filterResponseData` called from a listener not registered `"blocking"`, when no blocking
  listener of the add-on saw the request, fails: the filter's `onerror` fires with "Invalid
  request ID", and the page gets its response unchanged.
- M2. With a blocking `onBeforeRequest` listener that returns `undefined` at once seeing the
  request, a filter made in a separate non-blocking `onBeforeRequest` listener works, whichever
  of the two was added first (88 of 88).
- M3. A response sent with `Content-Encoding: gzip` reaches `ondata` uncompressed.
- M4. With a filter that writes every chunk, the page got exactly the server's bytes for bodies of
  14 B, 31 B (a POST answered 500), 8,191 B gzip, 200,000 B, 11 chunks streamed 200 ms apart, and
  200,000 B with a disconnect after the first `ondata`. One `ondata` carried 131,072 bytes.
- M5. `disconnect()` throws `NS_ERROR_FAILURE` while the filter has not started (in
  `onHeadersReceived` and `onBeforeRedirect`); from `onstart` on it works, the rest reaches the
  page unchanged, and the filter fires no more events.
- M6. `onHeadersReceived` and `onCompleted` arrive in no fixed order relative to the filter's
  `start`, `data` and `stop`.
- M7. A filter does not follow a redirect: it errors with "Channel redirected". The next hop's
  `onBeforeRequest`, with the same `requestId`, can attach a new one.
- M8. A fresh response from the HTTP cache reaches a filter like a network one.
- M9. A response a service worker gives shows as `onBeforeRedirect` with status 0 to the same URL
  and no `onHeadersReceived` or `onCompleted`. In a page a worker controls but does not answer
  for, the first hop's filter errors with "ServiceWorker fallback redirection" and a second
  `onBeforeRequest` with the same `requestId` follows. The worker's own fetch has `tabId` -1.
- M10. Requests of a frame from another site filter like the top document's.
- M11. `runtime.reload()` after the first of 11 streamed chunks: the page still got every byte.
- M12. With filters open and a chunk every 4 s for 40 s, the event page was not suspended
  (Firefox's ext-backgroundPage.js resets its idle timer while a stream filter is active).
- M13. 40 sequential 14 B fetches took 88 and 89 ms seen only by a non-blocking listener, 89 and
  110 ms with a blocking no-op seeing them too. After 45 s idle, with the event page suspended,
  the first fetch a blocking listener saw took 34 and 280 ms (it waited for the background to
  start), against 5 ms for one seen only by a non-blocking listener.
- M14. A blocking no-op added at runtime with the filter `{ urls: ["<all_urls>"], types:
  ["xmlhttprequest"], tabId }` makes that tab's fetches filterable; before it is added, after it
  is removed, and for another tab, the filter errors with "Invalid request ID".
- M15. Firefox has no permission prompt text for `webRequest`, `webRequestBlocking` or
  `webRequestFilterResponse` (no `webext-perms-description-*` string for them, read in its
  source). Whether an update that adds them prompts was not run.
- M16. `filter.write(event.data)` leaves the buffer readable: its bytes after the write are the
  response's.

## Decision

- **A per-tab hold.** While a tab has a live log (ADR 0016, 0066), `network-log.ts` keeps one
  extra `onBeforeRequest` listener for it, with the filter `{ urls: ["<all_urls>"], types:
  ["xmlhttprequest"], tabId }` and extra info `["blocking"]`, which returns `undefined` at once and
  does nothing else (M2, M14). It is added when a log goes live and removed whenever the tab is
  left without its live log: a commit, a refusal, a log dropped because its document stopped
  being live, the tab closing. A tab has at most one. No listener returns a Promise or a
  BlockingResponse.
- **When a filter is attached.** In the non-blocking `onBeforeRequest`, right after the request's
  entry is pushed to the tab's log (so nothing from before recording started is captured), only
  for `type` `xmlhttprequest`, a live log, and a request whose own URL is approved for the session
  and not on the blocklist (`SiteView.allowed`), whether the page or a frame made it, and while
  the log has fewer than `MAX_OPEN_CAPTURES` (64) captures open.
- **A synchronous site check.** `onBeforeRequest` cannot wait for `access.view()`, so
  `network-log.ts` caches each session's `SiteView`. It is read when a log goes live and on a
  miss, never awaited: a request that misses goes uncaptured. Every settings change, grant,
  withdrawal and stop clears the cache synchronously and starts reading it again for the live
  logs; a read that started before a clear is thrown away. After each read, every open capture of
  the session asks again, so one whose own site was withdrawn or blocklisted while the page's
  site stayed live stores nothing; a failed read releases them all. A chunk that arrives while
  the session has no current view releases its capture, so no copied byte comes from a moment
  whose access Foxleash had not checked. Each read also forgets the stored bodies of the session's
  logs whose request's site it refuses, and `read` gives no body while the session has no current
  view, so a body never outlives its site's approval.
- **The capture** (`captureResponse` in `response-body.ts`). `ondata` first writes the chunk on,
  then copies it up to `MAX_NETWORK_RESPONSE_BYTES` (65,536); a chunk past that cap marks the body
  truncated and disconnects the filter, so the rest flows past the extension. `onstop` closes the
  filter. A body is stored only once the response ended, its headers said it is text and the
  site check still allows it, in whichever order those come (M6). The capture is released (copy
  dropped, filter disconnected, or at `onstart` when a disconnect threw, M5) on a redirect (the
  next hop decides again on its own URL, M7, M9), an error, the end of the log, a dropped entry
  and the tab closing; any exception does the same. The handlers are never removed, so until
  Firefox stops sending events every chunk is written and the stop closes the filter.
- **Text only.** Exactly one `Content-Type` header whose type is `text/*` (not
  `text/event-stream`, which has no end at which a body is complete), `application/json`,
  `application/*+json`, `application/xml`, `application/*+xml`, `application/javascript` or
  `application/x-www-form-urlencoded`. Its charset picks the decoder, UTF-8 when it names none or
  an unknown one. A charset whose decoder can turn ASCII bytes into other characters (UTF-16;
  ISO-2022-JP through its escapes; Shift_JIS, GBK, gb18030, Big5 and EUC-KR, whose lead bytes take
  an ASCII byte as their second; not EUC-JP, whose never do), a body that starts with a UTF-16 byte
  order mark, and a body whose text holds a NUL are refused: the redaction reads ASCII, and those
  would hide a token from it.
- **Redaction, as a best effort.** Before the text is cut to `MAX_NETWORK_RESPONSE_TEXT` (32,768
  UTF-16 units), the values of keys named `access_token`, `refresh_token` (with any prefix) or
  `id_token`, in any case and in camelCase or with a hyphen, are replaced with `[redacted]`: in
  JSON or JavaScript (quoted after `:` or `=`), XML elements and form or query fields, also when
  the text ends inside one; so is every JWT-shaped string (`eyJ` at the start of a base64url run
  or right after a %-escape such as `%20`, then one to four dot-separated segments) and a trailing
  `eyJ` run. Every pattern starts only where a name or token can start, so none rescans a long run
  of text from every position.
- **Shape.** `NetworkRequest.responseBody?: { text, truncated? }` in `packages/protocol`, returned
  only with the read option `responseBody: true`, off by default (ADR 0065). It counts toward the
  page's 4,000,000 characters; while bodies take more than half of them, the oldest bodies go
  before any request. `PROTOCOL_VERSION` is 6.

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

## Consequences

- A recorded tab's fetches wait for the background's answer to the hold (M13). Other tabs, and
  tabs outside a session, are never held.
- No body for: a request whose response is still arriving; a request that ended in an error (a
  response with an error status keeps its body) or was redirected; a service worker's answer
  (M9); a non-text, event-stream or header-less response, or one in a charset refused above; a
  body whose site stopped being approved or was blocklisted; a request started in the moment
  after recording began, before the hold or the site check is in place (its filter errors or none
  is attached); a request beyond 64 open captures; one whose recording was interrupted while it
  arrived; a body dropped to make room.
- A frame from another site that fetches from an approved site has that response captured: the
  rule is the request's own URL. So is a response the page itself cannot read (a `no-cors` fetch,
  a failed CORS check) from an approved site.
- Redaction is a best effort, as ADR 0016 says of URLs and headers. It misses other names
  (`token`, `session`, `apiKey`), keys spelled with escapes or inside a JSON string that holds
  JSON (caught only when the value is a JWT), a token value that is not a string, an XML element
  with attributes, a body encoded another way (base64 of the whole body), and a response that
  repeats what a request sent: a form echoed back, protected values included.
- A body that finishes between a storage write and its `onChanged` event is stored under the
  access Foxleash had seen, as every gate check acts on the state it has seen.
- When the background stops in the middle of a response, the page still gets every byte (M11).
- In-flight copies are bounded per page by 64 captures of 64 KiB (4 MiB).
- Whether Firefox shows a prompt when an installed version updates to one with the two new
  permissions was read in its source (M15), not run; check it on the first signed update.
