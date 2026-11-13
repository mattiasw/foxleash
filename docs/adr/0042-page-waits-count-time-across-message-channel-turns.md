# 0042: Page waits count time across message channel turns

**Status:** Accepted, 2026-11-13. Amends the waits of
[0017](0017-text-input-and-keys-without-key-event-defaults.md),
[0023](0023-fill-form-sets-each-field-by-its-kind.md) and
[0032](0032-html-drag-sends-the-ends-events-in-a-later-task.md).

## Context

The page code's settle waits were timers: `SETTLE_MS`, 100 ms after an insertion, for the page
to re-render or undo it before the text is read back (ADR 0017 and 0023), and `DRAG_START_MS`,
20 ms after dragstart, for the page to start its drag (ADR 0032). Firefox runs the timers of a
hidden tab at most about once a second, also after the tab has been hidden for 35 s. A tab is
hidden whenever it is not the active tab of its window, which is the normal case when the user
works in another tab or several agents each use a tab of their own.

Measured in the end-to-end harness (headless Firefox 156), before this change: `type` took 1,019
to 1,022 ms in a hidden tab against 124 to 183 ms in a visible one; `fill_form` with five text
fields took 4,088 ms hidden, and its fifth field was `not_attempted` because no field starts after
`FILL_START_LIMIT_MS` (4 s), against 588 ms visible. In a page, `setTimeout(100)` took 1,000 to
1,041 ms hidden and `setTimeout(0)` 1,000 ms, while a wait counted across `MessageChannel` turns
took its length, 100 ms or 20 ms, in a hidden tab and a visible one alike.

## Decision

`wait` in `apps/extension/src/page-input-dom.ts` posts a message to itself on a `MessageChannel`
and, on each turn, posts again until `performance.now()` has reached the deadline. It is one code
path in every visibility state. The lengths (100 ms and 20 ms) and what each wait guards are
unchanged.

After this change, in the same harness: `type` took 114 to 119 ms in a hidden tab (115 to 160 ms
visible), and `fill_form` with five text fields 523 ms hidden, all five filled (613 ms visible).

`dropOnEnd` in `apps/extension/src/page-actions-dom.ts` waits for both the 20 ms and one turn of
the content script's timers. Pages start a drag in a timer (SortableJS in one of 0 ms). Through
the extension, with a 20 ms wait alone, a drag in a hidden tab moved the item 3 of 3 times when
the page had run no timer for 2.5 s, and 0 of 3 times right after the page ran a timer: the page
saw the end's events before its drag started, and cancelled it. In a page, a hidden tab's 0 ms
timer took about 1,000 ms in 11 of 12 runs, and 0 ms once, set after 2.5 s without page timers.
This is consistent with Firefox running a hidden tab's timers at most about once a second; that
mechanism is a hypothesis, the outcomes are measured. With the timer turn added, the page's 0 ms
timer had run when the wait ended (3 of 3 in a page, hidden and visible), since Firefox runs our
later timer after the page's earlier one. So a drag in a hidden tab takes about 20 ms when the
page ran no timer in about the last second, and up to about a second otherwise, as before this
change (1,017 ms measured); in a visible tab it takes 20 ms. That is as soon as the page can start
it.

## Alternatives rejected

- **Keep `setTimeout`:** the one-second delay above.
- **`scheduler.postTask`:** measured 1,000 to 1,074 ms in a hidden tab, as slow as a timer.
- **A round trip to the background script that answers after the delay:** 3 to 7 ms out of the
  page and back, but the background has no `runtime.onMessage` listener, and adding one opens a
  new entry point from content processes for nothing a wait inside the page cannot do.
- **A timer in a dedicated Worker,** which would leave the thread idle. Not tried: a worker that
  a content script starts runs either from a `blob:` URL, which a page's content security policy
  may refuse with a strict `worker-src`, or from an extension file the page would have to be
  allowed to load, a manifest change.
- **A message channel wait alone for the drag:** measured to end before the page starts its drag
  in a hidden tab when the page ran a timer in about the last second.

## Consequences

- In a hidden tab the settle wait no longer covers a re-render or undo that the page schedules in
  a timer: the page's timers are delayed to a second and the wait is not. A page
  `setTimeout(..., 50)` ran during none of 3 hidden 100 ms waits, and during 3 of 3 visible ones.
  So in a hidden tab `type` and `fill_form` can answer `typed`, with no setter fallback, for text
  that a page timer undoes about a second later; with the old one-second wait that timer had run
  first. Accepted: the alternative is a second per field, and the agent reads the page before it
  relies on what it typed.
- In a hidden tab the drag still lets a page start its drag in a 0 ms timer, as SortableJS does,
  but not in a longer one: with the old 20 ms timer, a page timer of up to 20 ms was due first and
  ran before the end's events; now our 0 ms timer is due first. Unmeasured hypothesis, from timers
  running in the order they are due; no page that starts its drag in such a timer is known.
- The thread is busy for the whole wait (23,000 to 39,000 turns per 100 ms) where a timer left it
  idle: about 100 ms of one core per text field, in a visible tab too. A page's
  `requestIdleCallback` work without a timeout does not run during the wait (0 of 3, visible and
  hidden; during a timer 3 of 3 visible), so a re-render or undo that a page puts in an idle
  callback now runs after the read-back, in a visible tab too. That is the one result in a visible
  tab that changes; the pattern is rare, since frameworks re-render in microtasks, message channel
  tasks or timers. A page's timers, animation frames and fetch callbacks still run during the wait
  in a visible tab (3 of 3 each).
- `fill_form`'s budget in a hidden tab is now the same as in a visible one, about 40 text fields
  per call at 100 ms each. The measurement before this change confirmed ADR 0023's unmeasured
  hypothesis (four text fields, the fifth `not_attempted`); this change lifts that limit.
- Window states: in headless Firefox a tab whose window is behind another window stays `visible`
  and its timers are not delayed (`setTimeout(100)` 100 ms, `type` 121 ms), since headless Firefox
  has no window occlusion. A covered window on a real display and a minimized window were not
  measured. Unmeasured hypothesis: the message channel wait does not depend on visibility, so it
  takes its length there too, while a drag there waits for the page's timers as in a hidden tab.
- Revisit if Firefox starts delaying message tasks in hidden tabs: the hidden-tab end-to-end tests
  of `type` and `fill_form` then fail when the pinned Firefox is updated to such a version.
