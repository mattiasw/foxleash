# 0047: Act tools wait for the page to settle and say what followed

**Status:** Accepted, 2026-11-13. Its quiet rule after a request is extended, for a fetch or
XMLHttpRequest, by [0055](0055-act-settle-waits-for-the-page-to-show-a-fetch-answer.md), 2026-11-13.

## Context

An act (`click`, `hover`, `scroll`, `drag`, `type`, `press_key`, `fill_form`, `upload_file`)
returned as soon as the content script replied, with only its targeting data. The post-act gate
of [0040](0040-page-requests-wait-for-a-navigation-under-way.md) returns at once when the page
merely began loading another, by design. So the model followed every act with a read, and a read
in the same `batch` came before the page had reacted.

Firefox runs a hidden tab's page timers about once a second
([0042](0042-page-waits-count-time-across-message-channel-turns.md)), and agents often act in a
tab that is not the selected one. Mutation observers, event listeners and `performance.now()` in
the page are not slowed; the background's timers are not either.

Measured before this change on the `/act` fixture page, headless Firefox 156 in the e2e harness,
whole MCP call times in ms, 12 runs each after one warm-up ("hidden": another tab of the group
selected):

| call | visible | hidden |
|---|---|---|
| click by ref on a button with no DOM effect | median 17 (14 to 86) | median 13 (9 to 17) |
| `wait_for` text already shown (one page request) | median 20 (18 to 21) | median 18 (15 to 19) |
| `read_page` interactive | median 20 (19 to 23) | median 21 (19 to 62) |

One page request (gates, tag, `executeScript`, `sendMessage`) costs 15 to 20 ms with the MCP
round trip, hidden or not, so polling the page through the existing `pages.request` is fast
enough for a 100 ms quiet time, and no lighter path is needed.

Measured after this change in the same harness, whole MCP call times in ms as
`e2e/act-settle.test.ts` reports them, one run each:

| call | visible | hidden |
|---|---|---|
| click on a button that changes nothing (`unchanged`) | 163 | 137 |
| click whose request the server answers after 400 ms, then `read_page`, in one `batch` (`changed`, and the read sees the change) | 573 | 571 |
| click on a same-site link (`loaded`) | 75 | 47 |
| click on a page that never goes quiet (`unsettled`) | 2,056 | 2,025 |

So an act on a quiet page costs about 120 to 150 ms more than before, and a page that never goes
quiet answers within about 60 ms after the cap.

## Decision

**What settled means.** When the act began a top-frame navigation (the navigation tracker's
`begun` count rose since right before the act's message was sent), the new document is ready:
`navigations.settled(tabId, NAVIGATION_WAIT_MS)`, `ready` gives `loaded` with the address,
`committed` gives `loading` with it, `timeout` `loading` without it, `removed` `closed`; `idle`
and `ended` (a 204, a download, a page from the back-forward cache) go on to the page's own
check. The step runs at most once per act, always with `NAVIGATION_WAIT_MS`: at that bound the
tracker ends its hold on a committed navigation, which later page requests rely on. A second
navigation after it gives `loading`. Otherwise the document has shown no change for `QUIET_MS`
(100 ms) and no request the page began after the act is open or ended within `QUIET_MS`, since a
page shows what a request brought only after it ends; the quiet path never ends sooner than
`MIN_SETTLE_MS` (50 ms) after the reply, since a link click starts its load a turn later. The
background polls at most every `POLL_MS` (50 ms), up to `SETTLE_CAP_MS` (2 s) from the reply,
when it answers `unsettled` if the last poll saw a change within `QUIET_MS` or such a request,
else `changed` or `unchanged` by its count. Both numbers live in the protocol package
(`ACT_QUIET_MS`, `ACT_SETTLE_CAP_MS`), so the tool descriptions state them.

**Every wait is the background's.** `apps/extension/src/act-settle.ts` (`createActSettle`)
holds the deadline, the cap, the quiet waits and the minimum on the background's `timers`.
`apps/extension/src/page-changes.ts` runs no timer: one `MutationObserver` (child list,
attributes, character data, subtree) on the document and on every shadow root in it, open or
closed, and on those of elements a change adds; and `input` and `change` listeners at the
document in the capture phase, since a checkbox's state, a field's value or a select's choice
changes no attribute. It counts changes and stamps the last with `performance.now()`. A watch
stops counting 60 s after its start, from inside its own callbacks.

**Document identity.** Each act starts a watch whose id is a per-document nonce (drawn with
`crypto.getRandomValues`, which works on plain http pages) and a counter. A `page_changes`
request with the act's watch answers `current` with the count and the ms since the last change,
`superseded` when a later act in the same document started another watch (`unknown`), or `other`
in another document, such as a page restored from the back-forward cache with an old watch of
its own (`loaded`).

**The result.** Each act's result gets `after`: `element` (the role and name `read_page` shows
for the element that took the act, or its nearest ancestor with a line, described in the page
before the act can remove it, checked in the background: own fields, a role in `ARIA_ROLES`, a
name of at most 201 characters), `page` (`loaded`, `loading`, `changed`, `unchanged`,
`unsettled`, `closed`, `unknown`), `url` (through `access.view(session).tabInfo`, so redacted to
its site on a site the session may not act on, and only while the tab is in the session's group),
`openedTabs` (the group's tab ids, listed synchronously right before the act's message and again
at the end), and `requests` (how many requests the page began after the act, absent at 0 and for
`loaded` and `loading`). Requests alone never make `changed`: analytics requests follow most
clicks on commercial sites. Websockets, media, beacons, pings and CSP reports are left out of
both the count and the wait: the first two stay open by design, the others cannot change the
page. Page text reaches the agent only inside the untrusted frame; `upload_file`'s `after` is a
second, framed text item after its own text. The field is additive: `PROTOCOL_VERSION` stays 3.

**Tagless polls.** `page_changes` carries `tag: null` and reserves no document tag
([0045](0045-short-element-references.md)): polls would multiply the tags each act uses by three
to about thirty, and refs would reach longer tags sooner than planned. A document adopts only a
tagged request's tag; the content script still refuses any other value that is not a tag.

**Decision 1: hover and scroll settle too.** Hover opens menus and tooltips, scroll triggers lazy
loading, and on a quiet page the cost is the quiet time. They stay out of page-scripts'
run-once `ACTING_REQUEST_TYPES`; the snapshot is retaken on each send, so the settle follows
their final run.

**Decision 2: an act aimed blind at a page the agent has not seen.** A click or a drag that
starts or ends at a point, or a `press_key` without ref (`aimsWithoutRef` in the protocol), is
refused with `page_unseen` and not sent when its page request waited for a navigation, or the
tab's begun count rose since the request started (`page-scripts.ts`). `batch` stops before such
a step in a tab where an earlier step reported `loaded` or `loading` in its `after`, or where a
`navigate` step ran, with a note saying why (`batch.ts`). A ref act on a new page is already
refused as `stale_ref`. Hover and scroll are not refused: repeated or misplaced they change
nothing the agent cannot undo, and refusing them would stop common batches such as
`[click a link, scroll, screenshot]`.

This bounds the class rather than closing it. These instances stay uncovered: a same-document
route change through the History API (not a begun navigation, so the act reports `changed` and a
later point act in the batch runs on the new view); a navigation that begins after the settle
ended and is ready before the agent's next call (for example a page timer in a hidden tab, which
Firefox runs about a second later); a navigation that an act in another tab begins, such as a
pop-up setting `opener.location`, and that is ready before the next act in the navigated tab
starts, since a batch notes only the tab each step names; and a page changed by its own scripts
between calls. The rule covers what Foxleash knows: a top-frame navigation the tracker saw while
the act's request waited, or that an earlier step of the same batch reported in its own tab.

**Bounds.** `PAGE_REQUEST_MS` (exported from `page-scripts.ts`: 2 x `NAVIGATION_WAIT_MS` +
`TAG_RESERVE_MS` + `PAGE_INJECTION_MS` + `PAGE_REPLY_MS` = 55 s) bounds the act's page request.
The settle is raced with a deadline timer of `PAGE_REQUEST_MS` started at the call's start, so
the whole act call answers within 55 s plus building the result, below the host's 60 s request
timeout with the same 5 s margin as every page request. Once the deadline passes nothing more is
awaited (no address lookup, no group query): `after` answers `loading` when a navigation began,
else the outcome of the last poll, else `unknown`. Without the deadline the settle alone would
take at most `SETTLE_CAP_MS` + `NAVIGATION_WAIT_MS` plus one poll raced with the cap. Each poll
is raced with the cap; one that loses is left to finish and ignored. The act already ran, so
nothing in the settle throws: a failed poll, a gate refusal or a closed tab ends in `unknown` or
`closed`, never an error that invites repeating the act. The post-act gate and its
`page_changed` error stay as they are.

## Alternatives rejected

- **A timer in the page.** Firefox runs a hidden tab's timers about once a second, so a 100 ms
  quiet time would take a second or more there.
- **Waiting only for network idle.** Most changes after a click need no request, and many
  requests (analytics) change nothing; the document is what the agent reads.
- **No cap.** A ticker, an animation or a long poll would hold every act until the deadline.
- **Counting requests as changes.** `changed` would follow nearly every click on a commercial
  site and `unchanged` would mean nothing; `requests` says that something was sent instead.
- **A longer quiet time in a hidden tab.** The background's timers are not slowed there, and the
  page's observers are not either; the measurement above shows the polls cost the same.
- **Consuming the tracker's finished-navigation mark** (`takeFinished`). `wait_for` navigation
  reads it; the settle uses only the `begun` count, which no caller consumes.

## Consequences

- In a hidden tab, a reaction the page schedules in a timer or an animation frame comes after the
  settle, so the result can say `unchanged` for a change that follows. A reaction later than the
  quiet time without a request, such as a 300 ms debounce, is not waited for either. The
  descriptions tell the agent to read the page before repeating an act that reported `unchanged`.
- Frames, canvas drawing, and CSS animations and transitions are not watched. A script that
  changes an element's style attribute (a ticker, a carousel) changes the page, so an act on a
  page running one answers at the cap.
- Every act on a page that never goes quiet costs the cap, 2 s.
- Each poll runs the content script's password-field walk before its handler, so a poll's cost
  grows with the page.
- An act on a quiet page costs about `QUIET_MS` and two polls more than before.
