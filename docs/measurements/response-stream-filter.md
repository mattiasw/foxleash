# Response stream filter

Measurements behind [ADR 0097](../adr/0097-a-response-capture-never-disconnects-its-stream-filter.md).

## Disconnecting at the start under CPU contention (2026-11-19)

The measurement: the order test's 1,200,000-byte `application/octet-stream` body, each
8-byte word holding its own offset, fetched by the page in a recorded tab of the agent's group,
headless Firefox, a fixture server on loopback. Contention: the whole test process tree (Node,
the fixture server, Firefox) pinned to 4 cores with a busy loop on each of them, or pinned to 1
core with no busy loop. A temporary note in the build recorded, per round, whether the capture
ended before the filter started and whether the `onstart` disconnect ran. "Current" is the build
of 0073, with the `onstart` disconnect; "fixed" is the build without the `onstart` handler.

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
- 0073's "0 of 280" for a build that disconnected only inside `onstart` was measured on 156.0.1
  without CPU contention.

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

In 0.5.0 only a text response under the 65,536-byte copy limit lost its error; since ADR 0073 and
0097, every filtered response does.

The end-to-end test of this case (`e2e/network.test.ts`) was run once on each version, in Firefox
headless against the fixture server on loopback, with the extension's drop of a failed request's
body removed. On 153.7.0esr the `text/plain` response cut at 1,000 of 2,000 bytes
(`/api/body/cut-text`) kept its 1,000 characters as its body in `read_network`, and the test
failed. On 160.0.1 it had no body, and the test passed. That response is under the copy limit, so
only the filter's stop stores it, and on 153.7.0esr the stop came before the error. So the
end-to-end test can catch a missing drop on 153.7.0esr; the unit tests in
`apps/extension/src/network-log.test.ts` guard it on every version, for a body stored at the stop
and for one stored at the copy limit.
