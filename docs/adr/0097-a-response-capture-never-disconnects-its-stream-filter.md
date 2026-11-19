# 0097: A response capture never disconnects its stream filter

**Status:** Accepted, 2026-11-19. Supersedes the `onstart` disconnect of [0073](0073-response-capture-never-disconnects-after-the-start.md).

## Context

After 0073, the end-to-end test that checks every byte of a large response the page fetches in a
recorded tab still failed now and then on CI. In two runs on Firefox 156.0.1, 2 of 40 and 1 of 40
`application/octet-stream` rounds differed, and 0 of 40 `application/json` rounds. Only the binary
response is released before the start: `capture.headers()`, called from `onHeadersReceived`,
releases a type that is not text, and the headers and the filter's events come in no fixed order
(M6 of 0071). When the release came first, `passOn` disconnected the filter inside `onstart`, the
one disconnect 0073 kept.

Measured to confirm it: the order test's 1,200,000-byte `application/octet-stream` body, each
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

## Decision

No stream filter is ever disconnected. `passOn` in `apps/extension/src/response-body.ts` sets no
`onstart`; it writes every chunk on in the order it arrives and closes the filter at the stop,
whether the capture ended before or after the start. Nothing in the extension calls
`filter.disconnect()`.

## Alternatives rejected

- Keeping the `onstart` disconnect: measured above to reorder or drop chunks on 156.0.1, and 153
  is the minimum version.
- Disconnecting at the start only on the versions measured safe: three versions were measured, the
  affected range is unknown, and the hand-back saves only a round trip per chunk.
- Attaching the filter only once the headers show a text type: that needs a blocking
  `onHeadersReceived`, which M13 and M14 of 0071 weigh against, since every recorded request would
  then wait for the background.

## Consequences

- Every response a filter was attached to passes through the extension chunk by chunk to its end,
  including types that are not kept, with a round trip per chunk. Measured in the runs above on
  loopback, a round (the page's fetch of the 1,200,000-byte response and its check) whose capture
  ended before the start took a median 2 to 4 ms longer with the fixed build: 36 against 38 ms on
  156.0.1 with 4 busy cores (n=653 and 656), 36 against 38 ms on 160.0.1, 37 against 41 ms on
  153.7.0esr, 24 against 26 ms on 160.0.1 on one core.
- An event stream or other long response whose capture ended keeps its filter open, and the event
  page awake (M12 of 0071), for as long as it lasts. Its handlers hold only the filter, so the
  capture, its hooks and the page's network log are not kept with it. Released filters still do
  not count toward the 64 open captures.
- A background that stops in the middle of a response now affects every filtered response; M11 of
  0071 measured that case only with slow chunks.
- The end-to-end suite runs on 160.0.1 and 153.7.0esr, where the `onstart` disconnect did not
  reorder, so its order test would not catch the disconnect's return. The unit tests' assertions
  that no filter is disconnected are the guard.
