# 0097: A response capture never disconnects its stream filter

**Status:** Accepted, 2026-11-19. Supersedes the `onstart` disconnect of [0073](0073-response-capture-never-disconnects-after-the-start.md).

Amended 2026-11-20: a filter cannot pass a response's failure on, so a response the connection cuts short reaches a recorded page as complete; the limit is now stated, and `read_network` gives such a request no body.

## Context

After 0073, the end-to-end order test still failed now and then on CI on Firefox 156.0.1 (2 and 1
of 40 rounds), for `application/octet-stream` only: `capture.headers()`, called from
`onHeadersReceived`, releases a type that is not text, which can happen before the filter starts
(M6 of 0071), and `passOn` then disconnected the filter inside `onstart`, the one disconnect 0073
kept.

Under CPU contention on 156.0.1 that disconnect reordered or dropped chunks in 56 of 1,000 rounds
with four busy cores and 10 of 1,000 on one core, and in none without it
([measurements](../measurements/response-stream-filter.md)).

A response cut short (fewer bytes than its `Content-Length` and then a close, a chunked body with
no final chunk, a TCP reset) reaches a page in a recorded tab with status 200, the bytes that
arrived and no error; without a filter, fetch rejects with `TypeError` and XMLHttpRequest fires
`error`. Measured on 153.7.0esr, 156.0.1 and 160.0.1; a `disconnect()` at the stop loses the error
too ([measurements](../measurements/response-stream-filter.md)).

## Decision

No stream filter is ever disconnected. `passOn` in `apps/extension/src/response-body.ts` sets no
`onstart`; it writes every chunk on in the order it arrives and closes the filter at the stop,
whether the capture ended before or after the start.

The filters stay so; the docs and the add-on listing state that a failed response loses its
error. `read_network` gives a body only once its request has ended (as 0071 recorded) and drops
one stored for a request that then fails. An end-to-end test pins a cut response in a recorded
tab, so a Firefox change that passes the error on shows.

## Alternatives rejected

- Keeping the `onstart` disconnect, or keeping it only on versions measured safe: it damaged
  responses on 156.0.1, 153 is the minimum version, and the affected range is unknown.
- Attaching the filter only once the headers show a text type: that needs a blocking
  `onHeadersReceived`, which makes every recorded request wait for the background (M13 and M14 of
  0071), and kept text responses would still lose their error.
- `disconnect()` at the stop: the page still gets no error.
- Disconnecting mid-stream, as 0.5.0 did: it passed the error on, but changed 20 and 28 of 40
  complete responses per case on 156.0.1.
- Keeping the partial body with `truncated`: the error already says the body is incomplete, and
  the tool promises no body on error.

## Consequences

- Every filtered response, kept or not, passes through the extension chunk by chunk to its end:
  a round whose capture ended before the start took a median 2 to 4 ms longer on loopback
  ([measurements](../measurements/response-stream-filter.md)).
- A recorded page that saves or acts on what it fetched (an export, an editor saving a document
  back) can take a short body as the whole after a dropped connection; 0.5.0 lost the error only
  for text under the copy limit. The agent sees the request's error in `read_network`.
- A long response, such as an event stream, whose capture ended keeps its filter open and the
  event page awake (M12 of 0071) while it lasts; its handlers hold only the filter, outside the 64
  open captures.
- A background that stops in the middle of a response affects every filtered response (M11 of
  0071 measured it only with slow chunks).
- The end-to-end suite runs on 160.0.1 and 153.7.0esr, where the `onstart` disconnect did not
  reorder; the unit tests' assertions that no filter is disconnected are the guard.
