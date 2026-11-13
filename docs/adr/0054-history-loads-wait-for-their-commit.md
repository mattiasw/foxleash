# 0054: After going back or forward, the wait for the load of the page's address ends only after that load committed

**Status:** Accepted, 2026-11-13. Amends [0053](0053-history-get-loads-ignore-page-controlled-switches.md):
answers its consequence that the wait for the history load may end before that load commits.

## Context

After `navigate` goes back or forward to a page Firefox loads again, `reloadHistoryLoad` in
`apps/extension/src/handlers.ts` loads the page's address again (a GET with `loadReplace`, or a
reload without the cache for an address with a fragment) so that the field values Firefox put back
without their `:autofill` mark are gone before anything reads the page (0025, 0051 to 0053). It
waited for that load with `waitForLoad` and no URL, so that a redirect still ends the wait (0051).
With no URL, the wait ended at the first status `complete` after a `loading`, and Firefox also
reports an aborted top-level load as `complete`. 0053 recorded, unverified, two ways the wait could
end before the load committed, leaving the step's document with the values put back.

End-to-end tests in `e2e/read-page.test.ts` measured both in Firefox 156.0.1, the version
`bin/firefox-version.json` pins, on the code before this record. Each goes back to a page with a
frame from another site whose field holds a typed value, while the server delays the page by 2 s,
and reads which document the tab shows when `navigate` answers and 6 s later:

| Case | Runs | What `navigate` answered on |
|---|---|---|
| The step's load cut off by its 30 s timeout by an image held open until the server closes | 3 | The load's document; the wait ran to its 20 s timeout after the commit, as the load's own image never completed |
| The same, with the image released by the load's request, so the step's load finishes while the load is under way | 3 | The load's document, about 2 s after its request |
| A page that calls `window.stop()` every 5 ms once it loaded after a history step | 3 | The step's document with the typed value, 47, 68 and 63 ms after the step; the load never arrived |
| Going back from a page still loading (the step's own wait, which this record does not change) | 3 | The load's document |

So in six runs Firefox never reported a `complete` between the load's `loading` and its commit, but
a page that stops the load ended the wait at once.

## Decision

`waitForLoad` (`apps/extension/src/wait-for-load.ts`) takes a `commit` option, meaningful with no
URL. With it, the wait listens to `webNavigation.onBeforeNavigate` and `onCommitted` and counts only
a top-frame commit of the tab, not of about:blank, after a top-frame `onBeforeNavigate` (not of
about:blank) that it heard after its listeners were added, which is before the load is started.
Such a commit counts whatever its URL, before or after the `loading` status, so a redirect's early
commit still does. A `complete` ends the wait only after that commit, and the 1 s grace with no load
started ends nothing. With no commit by the timeout the tab is returned as it is, never
`navigation_timeout`.

`reloadHistoryLoad` passes `commit: true` with its `HISTORY_RELOAD_TIMEOUT_MS` (20 s). Every other
caller keeps the old behaviour: the step's own wait, URL loads, `tab_open` and reloads.

## Alternatives rejected

- **Passing the tab's URL to the wait.** A redirect's commit of another URL would no longer count,
  and a load with no commit would fail with `navigation_timeout` instead of returning the tab.
- **No change, since only a load that never arrives was measured to end the wait early.** The fix
  does not change what that page shows, but the wait no longer depends on the order in which
  Firefox reports statuses: any `complete` that is not the load's own (an earlier load's abort, a
  load the page began and the GET load cancelled, a stop) no longer ends it while the load is still
  on its way.

## Consequences

- `navigate` still answers within 0053's 54 s: the load's timeout is armed at its first `loading`
  or commit, or at the 1 s grace at the latest, so its wait still takes at most 1 s and 20 s.
- Requiring the commit cannot make a load arrive that the page keeps stopping: the wait now ends at
  its 20 s timeout, on the step's document with the values put back, instead of at once. Measured
  once with this change in the same Firefox: that test answered so, and took 28.4 s instead of
  about 8.4 s; the other two tests still answered on the load's document. The README and the
  add-on listing name this case as known. No further mechanism.
- A load that shows no document, such as a 204 or a download, now takes the 20 s timeout instead of
  answering at once, with the same document shown. Not measured; the README and the listing name it
  as possible.
- A server that takes more than 20 s to answer the load leaves the step's document, with the values
  put back, until the load commits after `navigate` answered, as before this record; the README and
  the listing now name it. Whatever keeps the load from committing within the wait, the tab is
  returned as it is: the 54 s answer bound sets that limit, and this record does not close it.
- A navigation the page itself begins while the load is pending still counts as the load's commit.
  If it puts values back (the page's own reload or history step), that is the page's script, which
  the README and the listing already name.
- The step's own wait is unchanged; going back from a page still loading was measured not to end
  it early.
