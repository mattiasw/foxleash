# Response stream filter

Measurements behind [ADR 0071](../adr/0071-read-network-captures-response-bodies-with-a-stream-filter.md).

## How a stream filter behaves (2026-11-17)

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

  M4 does not show that a disconnect after the start is safe
  ([Disconnecting after the start](#disconnecting-after-the-start-2026-11-17)). Its bodies were
  one chunk or periodic, and its 200,000 B case with a disconnect after the first `ondata` used a
  body whose period of 16 bytes divides the chunk size, so swapped 131,072-byte chunks gave the
  same bytes. The end-to-end check of large responses had the same blind spot.
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

## An update that adds the two permissions (2026-11-17)

Run in Firefox 156.0.1, headless, with a throwaway profile: the signed 0.4.1 installed, then the
signed 0.5.0, the first release with `webRequestBlocking` and `webRequestFilterResponse`,
installed over it through the update flow, the path a version check takes (Firefox's
`AddonManager` update prompt handler). Firefox found the two permissions new, built no
permission line for them and applied 0.5.0 with no dialog. This settles M15's open question.

Opening the `.xpi` file, which is what `npm run setup` does, always shows Firefox's install
dialog, which does not compare with the installed version. In that run its lines were the same
for 0.4.1 and 0.5.0: five permission lines and the data collection line. Updating 0.4.1 to 0.5.0
with `npm run setup` in Firefox 160.0b5, not headless, showed the same lines, nothing for the two
new permissions.

## Disconnecting after the start (2026-11-17)

Measured in Firefox 156.0.1, headless, with a server on the loopback interface, 40 fetches per
case and two runs. Each 8-byte word of the body held its own offset, and the page reported the
first offset holding another word:

- `application/octet-stream`, 300,000 B: 5 and 3 of 40 differed; 1,200,000 B: 17 and 23 of 40;
  100,000 B: 0 and 0.
- `image/png`, 300,000 B: 4 and 1; no `Content-Type`, 300,000 B: 6 and 7.
- `text/plain`, 300,000 B (kept, then cut): 0 and 0; `application/json`, 1,200,000 B (kept, then
  cut): 20 and 19.
- The same fetches in a user's tab: 0 of 280 in both runs.
- Examples: a 300,000 B response whose offset 131,072 held the word of offset 262,144; a response
  of 1,068,928 B, 131,072 bytes short of its 1,200,000, whose offset 1,048,576 held the word of
  offset 1,179,648.
- A second run with a page doing the fetches itself: in the agent's tab, `application/octet-stream`
  1,200,000 B differed in 21 of 40 (4 of them with bytes missing), `application/json`
  1,200,000 B in 19 of 40 (7 with bytes missing), 100,000 B in 0 of 40; in a user's tab 0, 0
  and 0.
- Not affected: bodies of one chunk (131,072 bytes on loopback), and bodies the server sent in
  4,096-byte pieces 1 ms apart (0 of 150, up to 300,000 B). A real network was not measured.
- Two builds that differed from the released one only in the capture, one whose disconnect did
  nothing and one that disconnected only inside `onstart`: 0 of 280 each.

In a tab of the agent's group that `read_network` records, a page's own fetch and
XMLHttpRequest calls could get a response whose 131,072-byte chunks were out of order, or with a
chunk missing, with no error. The same page in a user's tab got every response intact.

0.5.0's capture called `filter.disconnect()` once data was flowing: at the 65,536-byte cap, when it
was released (a type that is not text, a site check that no longer allows the request, a
redirect, an error, the end of recording, a dropped entry, the tab closing) and on any fault.
Firefox then hands the chunks still on their way to the page out of order, or loses one.

## The order test on CI with the onstart disconnect (2026-11-19)

Seen in the end-to-end order test (`the page gets every chunk of a large response in order, kept
or not` in `e2e/network.test.ts`, 40 rounds per run), on CI in Firefox 156.0.1, headless,
against the fixture server on loopback.

With the build with the `onstart` disconnect (ADR 0071's amendment of 2026-11-17), the end-to-end
order test still failed now and then on CI on Firefox 156.0.1 (2 and 1 of 40 rounds), for
`application/octet-stream` only: `capture.headers()`, called from `onHeadersReceived`, releases a
type that is not text, which can happen before the filter starts
([M6](#how-a-stream-filter-behaves-2026-11-17)), and `passOn` then disconnected the filter inside
`onstart`, the one disconnect that build kept.

The next section measured that disconnect under CPU contention.

## Disconnecting at the start under CPU contention (2026-11-19)

The measurement: the order test's 1,200,000-byte `application/octet-stream` body, each
8-byte word holding its own offset, fetched by the page in a recorded tab of the agent's group,
headless Firefox, a fixture server on loopback. Contention: the whole test process tree (Node,
the fixture server, Firefox) pinned to 4 cores with a busy loop on each of them, or pinned to 1
core with no busy loop. A temporary note in the build recorded, per round, whether the capture
ended before the filter started and whether the `onstart` disconnect ran. "Current" is the build
of ADR 0071's amendment of 2026-11-17, with the `onstart` disconnect; "fixed" is the build
without the `onstart` handler.

| Firefox | Contention | Current build: rounds differing | Rounds with the onstart disconnect | Fixed build: rounds differing |
|---|---|---|---|---|
| 156.0.1 | 4 cores, 4 busy loops | 56 of 1,000, all 56 with the onstart disconnect | 653 | 0 of 1,000 (656 ended before the start) |
| 156.0.1 | 1 core | 10 of 1,000, all 10 with the onstart disconnect | 740 | not run |
| 160.0.1 | 4 cores, 4 busy loops | 0 of 1,000 | 706 | 0 of 1,000 |
| 160.0.1 | 1 core | 0 of 500 | 406 | 0 of 500 |
| 153.7.0esr | 4 cores, 4 busy loops | 0 of 1,000 | 647 | 0 of 1,000 |

- Of the 56 differing rounds on 156.0.1, 6 were 131,072 bytes short (1,068,928 B); the others had
  the right length with chunks out of order. Examples: offset 0 held the word of offset 524,288;
  offset 0 held the word of offset 1,179,648; offset 1,048,576 held the word of offset 1,179,648.
- No round differed anywhere without the `onstart` disconnect.
- The extension's minimum is Firefox 153, so users on a version that behaves like 156 got damaged
  responses. Only 153.7.0esr, 156.0.1 and 160.0.1 were measured.
- The "0 of 280" of [Disconnecting after the start](#disconnecting-after-the-start-2026-11-17)
  for a build that disconnected only inside `onstart` was measured on 156.0.1 without CPU
  contention.

Measured in the runs above on loopback, a round (the page's fetch of the 1,200,000-byte response
and its check) whose capture ended before the start took a median 2 to 4 ms longer with the fixed
build: 36 against 38 ms on 156.0.1 with 4 busy cores (n=653 and 656), 36 against 38 ms on
160.0.1, 37 against 41 ms on 153.7.0esr, 24 against 26 ms on 160.0.1 on one core.

## A response the connection cuts short (2026-11-20)

Taken with a page's fetch (reading the body as an `ArrayBuffer`) or XMLHttpRequest, 5 rounds per
row, in Firefox 160.0.1 headless, against a fixture server on loopback that answered status 200,
sent the first part of a body whose `Content-Length` declared more (or a chunked body with no
final chunk), then closed the connection (or reset it). `agent` is a recorded tab of the agent's
group on the approved site; `user` is a tab Foxleash does not record. Firefox 156.0.1 and
153.7.0esr gave the same results.

| Case | Tab | Status | Bytes the page got | Error in the page |
|---|---|---|---|---|
| server cuts at 600,000 of 1,200,000 bytes, octet-stream, Content-Length | agent | 200 (5 of 5) | 600,000 | none |
| same | user | 200 | 600,000 | TypeError (5 of 5) |
| server cuts at 600,000 of 1,200,000 bytes, JSON, chunked | agent | 200 | 600,000 | none |
| XHR, server cuts at 600,000 of 1,200,000 bytes, octet-stream | agent | 200 | 600,000 | none |
| same | user | 0 | 0 | `error` event (5 of 5) |
| server cuts at 30,000 of 60,000 bytes, JSON (below the 65,536-byte copy limit) | agent | 200 | 30,000 | none |
| another site in the same agent tab (no filter), cut at 600,000 of 1,200,000, JSON | agent | 200 | 600,000 | TypeError (5 of 5) |

- `read_network` reports these requests with `error: "NS_ERROR_NET_PARTIAL_TRANSFER"`.
- A build that calls `filter.disconnect()` at the stop in place of `close()`, Firefox 156.0.1, 5
  rounds each, gave the page no error either:

  | Case | agent | user |
  |---|---|---|
  | approved site, JSON cut at 600,000 of 1,200,000 bytes | no error | TypeError |
  | TCP reset at 600,000 of 1,200,000 bytes, octet-stream | no error | TypeError |
  | `text/plain`, 2,000 bytes cut at 1,000 | 1,000 bytes, no error | TypeError |

- 0.5.0's capture, which disconnected the filter mid-stream for `application/octet-stream` and
  for JSON over the copy limit, passed the error on. On complete responses, it changed the bytes
  the page got in this many rounds in the recorded tab:

  | Response | 160.0.1 | 153.7.0esr | 156.0.1 |
  |---|---|---|---|
  | octet-stream, 1.2 MB | 0 of 100 | 0 of 100 | 20 of 40 |
  | JSON, 1.2 MB (kept, cut) | 0 of 100 | 0 of 100 | 28 of 40 |
  | no content type, 300 kB | 0 of 100 | 0 of 100 | 7 of 40 |
  | image/png, 300 kB | 0 of 100 | 0 of 100 | 9 of 40 |
  | text/plain, 300 kB | 0 of 100 | 0 of 100 | 0 of 40 |
  | JSON, 60 kB (kept whole) | 0 of 100 | 0 of 100 | 0 of 40 |

  The tab Foxleash does not record: 0 everywhere. The extension's minimum is Firefox 153.

In 0.5.0 only a text response under the 65,536-byte copy limit lost its error; since ADR 0071's
amendments of 2026-11-17 and 2026-11-19, every filtered response does.

The end-to-end test of this case (`e2e/network.test.ts`) was run once on each version, in Firefox
headless against the fixture server on loopback, with the extension's drop of a failed request's
body removed. On 153.7.0esr the `text/plain` response cut at 1,000 of 2,000 bytes
(`/api/body/cut-text`) kept its 1,000 characters as its body in `read_network`, and the test
failed. On 160.0.1 it had no body, and the test passed. That response is under the copy limit, so
only the filter's stop stores it, and on 153.7.0esr the stop came before the error. So the
end-to-end test can catch a missing drop on 153.7.0esr; the unit tests in
`apps/extension/src/network-log.test.ts` guard it on every version, for a body stored at the stop
and for one stored at the copy limit.
