# 0089: A window or tab that a page in a session's tab opens is judged as that session's by the file guard

**Status:** Accepted, 2026-11-18. Amends
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md): its consequence
that a file loaded in a window a page opens is still saved.

## Context

The file guard of ADR 0081 decides a tab's session by the tab's group alone. A window that a page
in a session's tab opens with `window.open(url, "_blank", "popup,...")`, where the user allowed
pop-ups for the page's site, has a tab outside every group (`groupId` -1) and no `openerTabId`.
So a file that a site the session may not act on answers there was saved, and `upload_file` could
hand it to the approved page. The window's response does reach the guard's `onHeadersReceived`
listener, as `main_frame` with the window tab's id: only the session to judge it by was missing.

`webNavigation.onCreatedNavigationTarget` reports a tab or window that a tab's frame opened, with
the opening tab as `sourceTabId`. Whether it arrives before the window's response, for every way a
page opens a window, decided whether the guard can rely on it.

## Measurements

In headless Firefox 160.0.1 and 153.7.0esr through the end-to-end harness, with a probe add-on
that only logged `tabs.onCreated`, `webNavigation.onCreatedNavigationTarget` and the window tab's
`webRequest.onBeforeRequest` and `onHeadersReceived`, each with `Date.now()` taken in its handler.
Its `onHeadersReceived` listener was blocking, with `responseHeaders`, for `main_frame` and
`sub_frame` like the guard's, and answered at once. Pop-ups were allowed for A, and each way
started from a tab in a session's group on A's page. Ways 1, 3, 4, 6, 7 and 8 ran from a trusted
click (for way 4 on the same-site frame's button), way 2 from A's script on its `load`, way 5 from
the third-site frame's own script on its `load` (a WebDriver click does not reach into a frame of
another site's process). Way 8 is a click that opens a window on A's page whose script opens the
second window on B's file on `load`. Each way ran 20 times per cell, straight to B's attachment
and through A's 302 to it, answered from the network and from Firefox's cache (fetched once
beforehand; each run its own address). Every cache run had `fromCache: true`, and the server saw
no request.

Each cell is the largest lateness in ms, over 20 runs, of `onCreatedNavigationTarget` against the
window tab's `onHeadersReceived` for B's file, the response the guard judges. Negative means the
event came first, by at least that much.

| Way | 160 direct, network | 160 redirect, network | 160 direct, cache | 160 redirect, cache | 153 ESR direct, network | 153 ESR redirect, network | 153 ESR direct, cache | 153 ESR redirect, cache |
|---|---|---|---|---|---|---|---|---|
| 1. `window.open(url, "_blank", "popup,width=400,height=300")` from a click | -5 | -10 | -3 | -8 | -5 | -11 | -4 | -9 |
| 2. the same from the page's own script on load | -5 | -13 | -5 | -13 | -5 | -11 | -3 | -9 |
| 3. with `noopener` among the features | -6 | -14 | -4 | -11 | -6 | -14 | -5 | -11 |
| 4. from a same-site frame of A's page | -4 | -8 | -3 | -8 | -4 | -10 | -3 | -8 |
| 5. from a frame on a third site in A's page | -5 | -15 | -3 | -15 | -6 | -12 | -4 | -12 |
| 6. `window.open("", "_blank", "popup")`, then `w.location = url` | -10 | -18 | -9 | -15 | -11 | -19 | -9 | -18 |
| 7. `window.open(url, "_blank", "width=400,height=300")` (no `popup`) | -4 | -13 | -3 | -9 | -5 | -10 | -3 | -9 |
| 8. a second window opened by the first window's page | -5 | -14 | -5 | -9 | -6 | -13 | -4 | -12 |

- In all 1,280 runs the event fired with `tabId` the window's tab and `sourceTabId` the tab in the
  session's group (way 8: the first window's tab, whose own event named the group tab). Its
  `sourceFrameId` was the frame's for ways 4 and 5, and its `url` `about:blank` for way 6.
- The order was the same every time: `tabs.onCreated` for the window's tab (`groupId` -1, no
  `openerTabId`), then `onCreatedNavigationTarget`, then the window tab's first `onBeforeRequest`,
  then its first `onHeadersReceived`. Against that first `onHeadersReceived` (A's 302 in the
  redirect columns) the event was at least 3 ms first in every run, by arrival order and by time.
- The event fired for every way, always before the headers, so no hold for a late event is built.
- H14: in 20 runs per version, the click's result listed the other site in `refusedFiles` every
  time.

## Decision

In `createFileGuard` (`apps/extension/src/file-guard.ts`):

- `listen()`, run at the first `access.onRunningChange`, adds the blocking `onHeadersReceived`
  listener of ADR 0081 and a `webNavigation.onCreatedNavigationTarget` listener, once.
- That listener, synchronously, stores an entry for the new tab: its source tab and the promise of
  its tie. The tie is the source's judgement (`judgedSession`): its session, and as opener the
  tab in a session's group that the chain began in (the source when its group decided, else the
  source's own opener). A source that is gone by the time Firefox answers passes on its own tie,
  taken when the event arrived; otherwise the tie is nothing. The promise never rejects.
- `sessionOfTab` judges a tab by its group first; then, when it has an entry, by its tie; and when
  the source was no session's when it opened the tab, by the source's judgement now.
  `judgedSession` takes the entry before it looks the tab up, so a tab that closes meanwhile is
  still judged by its tie.
- `refused` records a refusal for the tab and, when a tie decided, for the opener too, for
  `refusedSince` only: an act in the opener lists the site in `refusedFiles`. `onRefused`
  listeners hear the tab's id only, so a refusal in a window never fails the opener's load wait.
- `tabs.onRemoved` deletes the tab's entry. There is no cap: one entry per open tab opened from
  another tab since the first session ran.

## Alternatives rejected

- **Finding the window's session through `openerTabId`.** The window's tab had none in any of the
  1,280 runs.
- **Holding a young tab's file up to 250 ms for a tie that comes late.** The event never came late,
  and the hold would delay the user's own files.
- **Making such windows the session's tabs that the agent can list and act on.** That widens the
  agent's reach to windows the user did not put in the group; ADR 0027 keeps it to the group.
- **Stopping every answer that is not a page in every tab outside a group while a session runs.**
  It would stop the user's own downloads everywhere.
- **Tying only windows a page opened, not those the user opens from a session's tab.** The event
  does not say who opened the target; the guard errs toward guarding.
- **A tie listener at the top level of the background.** It has the wake-up cost that ADR 0071 and
  0081 rejected.
- **A cap on the entries.** Dropping one would stop guarding its tab.

## Consequences

- A window or tab opened from a tab of a session's group, or from a chain of them, is guarded as
  that session's until it closes, also after the session ended or was stopped, and stays out of
  the agent's reach: `tabs_list` does not show it, no tool acts on it, and an act's `openedTabs`
  does not list it.
- A link the user opens in a new window or tab from a session's tab is tied too (Firefox documents
  the event for that; not measured here, nor whether the event comes before the answer to that
  window's first load). The user's own downloads there from sites the session
  may not act on are stopped until it closes, and a refusal there during an act in the opener
  names that site, as its origin only, in the act's result.
- A file in a tab opened from another tab waits for a lookup of its chain of openers, one
  `tabs.get` per step, a few milliseconds. Pages are not affected: only files are judged.
- The entries live in the background's memory: after a reload, an update or a Firefox restart,
  windows opened before are not guarded, as groups are not.
- Not covered: a window that no tab's frame opens, such as one a service worker opens when the
  user clicks its notification; a source tab in a group, with no tie of its own, that closes
  within the moment of its lookup, whether the agent, the user or its own page closes it (a page
  may close its tab while the tab has one entry in its history; not measured); and the tab that
  opened a tab the user later moved into the group, whose page can navigate `window.opener` (not
  measured).
- A refusal in such a window is listed by `refusedSince` for the group tab its chain began in and
  never fails that tab's load wait.
