# 0055: After an act, the settle waits for the page to show a fetch's answer

**Status:** Accepted, 2026-11-13. Extends [0047](0047-act-tools-wait-for-the-page-to-settle.md).

## Context

0047 ends an act's settle once the page has not changed for `QUIET_MS` (100 ms) and no request it
began after the act is open, counting the quiet time from the last request's end too. Its
consequences name a reaction later than the quiet time as not waited for.

That gap showed on a shop page that shows the cart count 300 ms after its fetch answers: the click
fetches, and the page updates the count in a `setTimeout(..., 300)` after the response. The click
answered `unchanged` with `requests` 1 and a view without the new count, about 190 ms after it was
sent, and agents then spent a model request on `wait_for`.

How late such a page timer runs after the answer was measured in Firefox 156.0.1, the version
`bin/firefox-version.json` pins, headless: a page whose button fetches a route that answers at once
and, after reading the body, runs `setTimeout(..., 300)`, the delay from the answer to the timer's
callback taken in the page with `performance.now()`, 20 clicks per tab state, each after a random
0 to 1,000 ms pause:

| Tab | Min | Median | Max |
|---|---|---|---|
| Selected | 299 ms | 301 ms | 301 ms |
| Not selected (hidden) | 999 ms | 1,000 ms | 1,047 ms |

The settle cases of `e2e/act-settle.test.ts` before this change, one run, whole-call ms as their
diagnostics print them:

| Case | Selected | Hidden |
|---|---|---|
| Quiet click (`unchanged`) | 212 | 136 |
| Slow click and `read_page` in one `batch` (400 ms request) | 573 | 559 |
| Same-site link (`loaded`) | 101 | 74 |
| Ticker, never quiet (`unsettled`) | 2,025 | 2,021 |

The same cases after this change, one run, in the same harness (headless Firefox 156.0.1), with a
case added for the page that shows the answer 300 ms after it:

| Case | Selected | Hidden |
|---|---|---|
| Quiet click (`unchanged`) | 201 | 143 |
| Slow click and `read_page` in one `batch` (400 ms request) (`changed`) | 575 | 556 |
| Later click, the page shows the answer in a 300 ms timer of its own (`changed`, the answer in the view) | 488 | 1,157 |
| Same-site link (`loaded`) | 108 | 70 |
| Ticker, never quiet (`unsettled`) | 2,026 | 2,020 |

The Quiet, Slow, link and Ticker cases are within run-to-run noise of the first table: they send no
request or show the answer at once, so no window is waited out. The Later click now waits about the
page's timer plus the quiet time (the timer ran 300 ms after the answer in the selected tab and
1,000 ms in the hidden one). With `RESPONSE_WAIT_MS` set to 0 it answered `unchanged` with
`requests` 1, in 160 ms (selected) and 138 ms (hidden), which is the failure this ADR fixes.

## Decision

After each poll, `settle()` in `apps/extension/src/act-settle.ts` treats the page as awaiting a
fetch's answer when a fetch or XMLHttpRequest of the top document, begun after the act, has ended
(`lastFetchEnd`, which `requestsSince` in `apps/extension/src/network-log.ts` gives as the latest
end among those requests), less than `RESPONSE_WAIT_MS` had passed since that end when the poll was
sent (the page reads itself after that, so the last read falls after the window), and the page has
not changed since it (it has not changed since the act, or its quiet time is at least the time since
the end). While awaiting, the settle does not end and polls again after `POLL_MS`; otherwise 0047's
rule applies unchanged. `RESPONSE_WAIT_MS` mirrors `ACT_RESPONSE_WAIT_MS` in
`packages/protocol/src/methods.ts`, 1,200 ms.

- Only fetch and XMLHttpRequest start the window: Firefox's webRequest reports both as
  `xmlhttprequest`. A page shows images, scripts and the other types itself as they load, and a
  tracking pixel changes nothing, so those keep 0047's rule.
- Only the top document's own requests start it. The act's watch does not see changes inside
  frames (0047), so a frame's fetch could start a window that no change ends, and a frame that
  fetches again and again would hold every act to the cap.
- 1,200 ms covers both tab states: the hidden tab's longest delay, 1,047 ms, plus a 100 ms margin,
  rounded up to the next 100 ms.
- The comparison errs towards not waiting. Firefox fires webRequest's `onCompleted`, which gives the
  end, in the parent process before the page's process gets the body, so a change the page makes in
  reaction to the answer comes after the end and always reads as a change since it. A change within
  one poll's return trip before the end reads the same way, and that settle follows 0047's rule as
  before. A page with no change since the act counts its quiet time from the act's watch, which a
  fetch that answers at once ends only a few ms after, less than the poll's return trip: compared
  alone, that page would read as changed since the answer, so no change since the act counts as no
  change since the answer.
- The cap still bounds the wait. A window the cap cuts answers by the change count (`changed` or
  `unchanged`) when the last poll was quiet with no request open; `unsettled` keeps its meaning.
- The settle uses no timer in the page: every wait stays on the background's timers.

## Alternatives rejected

- A longer `QUIET_MS` for every act: it costs every act, also those that send no request.
- A window after every request type: images, scripts and tracking pixels change nothing the page
  does not show at once, so the window would only add time.
- Watching the page's own timers: impossible from the isolated content script without running code
  in the page, which AMO's remote-code rule and this project's rule against running code strings in
  pages exclude.
- A longer window only in a hidden tab: not needed, since one value covers both.

## Consequences

- An act whose fetch shows nothing, such as an analytics request, takes up to about 1.1 s longer
  than before: the window minus the quiet time it replaces.
- A page that sends a fetch more often than every 1.2 s without showing anything holds every act
  until the cap, 2 s; before, only a request that stayed open did.
- In a hidden tab, a 300 ms page timer runs about 1 s after the answer, and the window covers it. A
  longer page timer, or a hidden tab's delay past 1.2 s, is still not waited for.
- A page that changes when a fetch's headers arrive but before its body ends waits the window: time
  only, and the result is still `changed`.
- The first change after the answer ends the window. A page that also changes at once when the
  answer arrives (re-enabling the button, removing a spinner) and shows the answer itself in a timer
  answers `changed` before that timer runs, as under 0047.
- A delayed reaction to an image or a script, or to no request at all (a debounce), is still not
  waited for: 0047's consequence stands for those.
