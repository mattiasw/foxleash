# 0073: A response capture never disconnects its stream filter after the start

**Status:** Accepted, 2026-11-17. Supersedes the capture rule ("disconnects the filter" at the cap and on release) and measurement M4 of [0071](0071-read-network-captures-response-bodies-with-a-stream-filter.md). Its `onstart` disconnect is superseded by [0097](0097-a-response-capture-never-disconnects-its-stream-filter.md), 2026-11-19.

## Context

In a tab of the agent's group that `read_network` records, a page's own fetch and
XMLHttpRequest calls could get a response whose 131,072-byte chunks were out of order, or with a
chunk missing, with no error. The same page in a user's tab got every response intact.

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

The capture called `filter.disconnect()` once data was flowing: at the 65,536-byte cap, when it
was released (a type that is not text, a site check that no longer allows the request, a
redirect, an error, the end of recording, a dropped entry, the tab closing) and on any fault.
Firefox then hands the chunks still on their way to the page out of order, or loses one.

ADR 0071's M4 did not show this. Its bodies were one chunk or periodic, and its 200,000 B case
with a disconnect after the first `ondata` used a body whose period of 16 bytes divides the
chunk size, so swapped 131,072-byte chunks gave the same bytes. The end-to-end check of large
responses had the same blind spot.

## Decision

When a capture ends, `captureResponse` in `apps/extension/src/response-body.ts` hands the filter's
events to `passOn`, whose handlers hold nothing but the filter. Its `onstart` is the only place
that calls `filter.disconnect()`: a capture that ended before the start (a release or a fault)
hands the response back to Firefox before any data, the path M5 of 0071 measured safe. Once the
filter started, nothing disconnects it: past the cap, after a release and after a fault, every
chunk is still written on, in the order it arrives, and the stop closes the filter. Only the
copying stops: the copy is dropped, `end` is called once, and nothing more is stored.

## Alternatives rejected

- Disconnecting after the start, as before: measured above to reorder or drop chunks.
- Closing the filter early: it would cut the response short for the page.
- Disconnecting after `onstart` while no chunk has arrived yet: not measured, and M6 of 0071 shows
  that the headers and the filter's events come in no fixed order, so the only point measured safe
  is inside `onstart`.

## Consequences

- A recorded tab's fetch and XMLHttpRequest responses that a filter was attached to pass through
  the extension chunk by chunk to their end, also past the cap and for types that are not kept: a
  round trip per chunk.
- While such a filter is open the event page is not suspended (M12 of 0071). That now holds for a
  long response whose capture ended after `onstart`, such as an event stream whose headers
  arrived after it.
- A released capture no longer counts toward the 64 open captures of a page although its filter
  still passes data through; the bound of 4 MiB on copies (64 captures of 64 KiB) holds.
- A filter whose capture ended after the start stays open until its response ends, which for an
  event stream can last as long as the page. Its handlers hold only the filter, so the capture,
  its hooks and the page's network log are not kept in memory with it.
- M11 of 0071 measured a background that stops in the middle of a response only with chunks 200 ms
  apart. Whether Firefox's own hand-back then can reorder the chunks of a fast response was not
  measured, and released filters now stay open longer, so that case is more likely.
- A write that throws loses that chunk for the page, as before; the later chunks are still written.
