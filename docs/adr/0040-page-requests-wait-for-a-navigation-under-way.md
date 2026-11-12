# 0040: Page requests wait for a navigation under way in their tab

**Status:** Accepted, 2026-11-12.

## Context

An agent that clicks a link or submits a form and at once reads the page, as its next call or
the next step of a `batch`, got either the previous page or a `page_not_web` error ("tab N
shows another kind of page"). Measured on a local fixture: a read right after the click failed
`page_not_web` 8 of 8 times, and with the server answering after 150, 400 or 1,000 ms it
returned the old page 24 of 24 times; `wait_for` a selector the old page also matched passed on
the old page. Page requests gated on the tab's current URL and ran in whatever document the top
frame held; nothing in the extension knew a navigation had begun.

What Firefox 156 does, logged event by event around 37 navigating clicks and Enter presses and
the other cases below:

- The navigation's top-frame `webNavigation.onBeforeNavigate` reaches the background 0 to 2 ms
  after the act's reply (once 7 ms), before the agent's next request starts.
- Every top-level navigation that loads a document, `no-cache` and `no-store` pages alike, swaps
  it in through about:blank: the tab reports about:blank while loading, Firefox fires a second
  `onBeforeNavigate` for the same URL and an `onErrorOccurred` (NS_BINDING_ABORTED) for the
  leaving document, in either order, then `onCommitted`, `onDOMContentLoaded` for the committed
  document, `onCompleted` and the tab's status `complete`. A gate during the swap sees
  about:blank.
- A 204 ends with an error for the shown document and status `complete`; a download with
  `onCompleted` and status `complete`; neither commits. Back and forward from memory commit and
  fire no `onDOMContentLoaded`, then `onCompleted`. A redirect's end event can carry the first
  URL or the target's.
- A fragment link and `history.pushState` fire no `onBeforeNavigate`. A beforeunload prompt
  fires nothing until the user leaves.
- A click on a page still loading: Firefox stops the old load (its error, then status
  `complete`) before the new `onBeforeNavigate`.

## Decision

`apps/extension/src/tab-navigations.ts` keeps, per tab and for the top frame only, whether a
navigation is under way, from listeners added once at the top of the background script:

- `onBeforeNavigate` begins one (or, with one under way, sends it back to begun) and counts it.
- `onCommitted` while one is under way makes it committed, keeping Firefox's `documentId`.
- `onDOMContentLoaded` of the committed document ends it as ready.
- `onCompleted` or the tab's status `complete` ends it without a document. No end event's URL is
  compared with the begun one.
- Events for about:blank are ignored, and `tabs.onRemoved` drops the tab.
- `onErrorOccurred` is not used: the swap fires it for the leaving document, usually after the
  second `onBeforeNavigate`, so ending on it would end the wait while the tab shows about:blank.

The state is per tab, not per session: agents sharing a session share its tabs (ADR 0038).

Every page request (`apps/extension/src/page-scripts.ts`) and `screenshot`
(`maskedScreenshot` in `apps/extension/src/handlers.ts`) waits, before its first gate, for the
tab's navigation under way, up to `NAVIGATION_WAIT_MS` (10 s); a wait that reaches it while the
navigation has not committed fails with `page_loading`, which `wait_for` text and selector
retry. A request waits only for a tab in the session's own group, checked before the wait, so
the time a refusal takes tells a session nothing about the user's or another session's tabs.
`read_console` waits too before it notes which recording is live, so it reads the recording of
the page the navigation brings; like `screenshot`, it has its own 50 s bound over the wait and
the page request, and fails `page_changed` when a navigation began during the read.

The about:blank of a swap counts as loading only while a navigation is under way: a gate that
then fails `page_not_web` waits for the navigation and gates again. With nothing under way,
about:blank and every other non-web page fail `page_not_web` as before.

A request that is not an act (`read_page`, `get_page_text`, `wait_for`, `hover`, `scroll` and
the like) and saw a navigation begin while it ran (the tab's count of begun navigations changed
between its first and last gate) discards the reply and runs once more after that navigation.
An act (`click`, `drag`, `type`, `press_key`, `fill_form`, `upload_file`) never sends its
message twice: a run that stops before sending may run again, but once sent, its post-reply gate
waits only when it fails on the swap's about:blank, and then applies to the page the swap
brings (another site: `page_changed`, saying the act ran, so the agent reads the page before
it repeats the act). An act whose page merely began loading another returns at once. A request
for a tab that does not exist or is not in the session's group is refused as it is, never run
again or reported as loading.

A request starts a wait or its second run only in its first `NAVIGATION_WAIT_MS`, so it answers
within 2 × 10 + 20 (injection) + 10 (reply) = 50 s, below the host's 60 s request timeout, the
same margin as `SCREENSHOT_TIMEOUT_MS`. At the bound, a navigation that has not committed asks
Firefox for the tab's status first: a tab no longer loading means the tracker missed the end, so
the state is dropped and the request goes on. A committed document still parsing at the bound is
used: the tracker stops holding the tab, and the request runs in it behind the same gates.

The site gate is unchanged: it runs before the injection, before the message and after the
reply in every run, so a request runs in, and returns content from, only a document whose site
passed it.

## Alternatives rejected

- Ending a navigation on `onErrorOccurred`: the swap fires it for the leaving document, so the
  wait would end while the tab shows about:blank.
- Ending only on an end event for the begun URL: a redirect to a 204 reports its error under the
  target's URL, so the wait would last the whole bound.
- Making every act wait for the navigation it starts: nearly every link click's
  `onBeforeNavigate` arrives before its post-reply gate, so every click would wait for the next
  page, and a slow page would turn a click that ran into an error that invites a repeat. Waiting
  for the page after an act is separate work that builds on this state.
- Polling the tab's status instead of keeping the events: status `loading` says nothing about
  which document a read would reach, and a poll adds its interval to every read.
- Failing a committed but unparsed document at the bound: a page whose parser waits on a slow
  script would fail every read, act and screenshot on every retry, where they used to work on
  what is parsed.
- One deadline for the whole request: it needs a clock the background does not inject; a flag
  set by one timer at `NAVIGATION_WAIT_MS` gives the same bound.

## Consequences

Act tools that wait for the page to settle, and `navigate` returning at DOM ready, can build on
the same per-tab state. Known gaps: a navigation a page's script starts after a read began, and
that Firefox reports only after the read ended, still reads the old page. `hover` and `scroll`
are not acts, so they can run a second time after a navigation began during the first; a ref from
the old page then fails as stale. If Firefox reordered the old page's stop to come after the new
navigation began (measured the other way round), that end would end the wait early and the read
would see the old page, as before this change.
