# 0053: After going back or forward, a load cut off by its timeout or a page's POST after it arrived no longer stops `navigate` loading the page's address again with GET

**Status:** Accepted, 2026-11-13. Supersedes, for a URL without a fragment, the condition of
[0025](0025-history-loads-and-autofilled-fields.md) that the step's load completed before its
30 s timeout, and the top-level veto for a request that started after the tab's last top-level
commit, as 0025, [0051](0051-history-steps-load-the-page-again-with-get.md) and
[0052](0052-history-get-loads-ignore-frame-posts.md) kept them. Answers 0052's "Still open"
consequence.

## Context

After `navigate` goes back or forward to a page Firefox loads again, `reloadHistoryLoad` in
`apps/extension/src/handlers.ts` loads the page's address again, so that the field values Firefox
put back without their `:autofill` mark (0025) are gone before `read_page` can read them. For a
tab URL without a fragment that load is `tabs.update(tabId, { url, loadReplace: true })`, a GET
that sends no form and loads each frame from its `src` (0051, 0052); for a URL with a fragment it
is `tabs.reload(tabId, { bypassCache: true })`, which keeps the frame veto (0052).

A page on an approved site could still make Foxleash skip that load with things it controls
during the step:

1. **The timeout.** A load that the step's 30 s `LOAD_TIMEOUT_MS` cut off was never loaded
   again, and a page causes that by never finishing one resource, such as an image whose
   response never ends. History steps wait with no URL, so 0048's return at DOM ready does not
   apply: an incomplete load here means only that the timeout cut it. The reason for the guard,
   that a cut-off load may not have requested its frames yet, POSTs among them, matters only to
   the reload, since the GET load ignores frame POSTs.
2. **A top-level request that was not a GET, sent by the page after its own document
   committed**, for example a form sent with POST to an address that answers 204 and so leaves
   the page in place. It refused both loads. The GET load cannot send that form again.
3. **For a URL with a fragment, a frame request that was not a GET** refuses the reload.
4. **The page decides whether its address has a fragment**, with the History API or
   `location.hash`, during the step's load or at any time before it.

What the switches expose: the values Firefox put back. The switches that the top page's own
script must pull (2, 4, and a frame of the page's own site sending a form) add only values put
back into a frame from another site, which the top page cannot read itself (the user's typed
values; Firefox fills no saved login into such a frame, 0025): a page can already read and show
its own fields. Three need no script of the top page, and on an address with a fragment each
also keeps the values put back into the page's own fields, such as a username Firefox filled
from a saved login: a resource from a server that never ends its response, which content a site
shows from others can carry; a frame from another site, such as an embedded widget, that sends
its own form with POST, since any frame request in the tab counts; and a fragment in the
address the agent opened.

## Decision

In `reloadHistoryLoad`:

- A load the step's timeout cut off is refused only for a URL with a fragment, beside the frame
  veto. For a URL without one the decision runs as for a completed load; when the page's own
  request has not been reported yet, the existing wait of up to `HISTORY_REQUEST_TIMEOUT_MS`
  handles it.
- A top-level request that was not a GET and started after the last top-level commit, by the
  commit current when the decision is made, cannot be the request of the document the tab shows,
  and no longer refuses the GET load. One that started no later than that commit still refuses
  both loads when it started from the commit's own request on, or Firefox reported it after that
  request (the page a form sent with POST, under 0016's late reports). When the page's own POST
  navigates and commits during the step, it is the new commit's own request and refuses.
- For a URL with a fragment, `HistoryLoad.topPosted()` keeps the rest of today's veto: it is true
  when a top-level request that was not a GET started after the last top-level commit. The
  reload reloads the history entry the tab shows, so if the page's own POST navigation committed
  between the check and the reload, it would send that POST again; the GET load replaces the
  entry with a GET of the checked URL and sends nothing.
- Whether the address has a fragment is still read from the tab's URL, once, in the same
  synchronous span as the last checks and the load: loading a URL with a fragment over its own
  document is a fragment navigation that loads no document (0051). Switches 3 and 4 are bounded
  here, not closed.

`watchHistoryLoad` keeps the start time of every top-level request that was not a GET, and for
each top-level request the earliest start time of such a request reported after it. The rule
compares both with the commit current when it is asked, never at report time: a later commit or
a later commit request moves both ends of the range that counts.

`navigateTab` now also notes the tab its history load returned while still loading, so that
`wait_for` with `navigation` does not count that load's end, as 0048 decided for `navigate`'s
own loads.

## Alternatives rejected

- **Deciding the fragment from the commit's URL instead of the tab's.** The page can give its
  history entry a fragment with the History API before the step, so it bounds nothing.
- **Loading the address without its fragment, or loading it first without the fragment and then
  navigating to the fragment.** It loads another view of a page that routes by its fragment, as
  0051 rejected, and the first load runs that view's scripts. Not measured.
- **Dropping the frame and top-level vetoes for the reload without the cache.** 0052's reason: its
  handling of frame entries is undocumented, and a normal reload was measured to send a frame's
  POST again.
- **Dropping the cut-off-load veto for the reload without the cache.** A cut-off load may not
  have requested its frames yet, so the reload could send a frame's POST that Foxleash never saw:
  an action on the user's behalf.
- **Dropping the top-level veto for the page's own request.** The GET load would show another
  page than the POST result the history entry holds.

## Consequences

- The reload's vetoes remain switches the page controls, bounded by the exposure above, and the
  page can give its address a fragment at any time. The README and the add-on listing name them.
- Unverified, and as before this record: a load can also complete without requesting a frame,
  such as one with `loading="lazy"` out of view or one the page's script keeps from loading with
  `window.stop()`, so the reload without the cache may still send such a frame's POST that
  Foxleash never saw.
- A page whose own script sends a top-level form with POST while it loads (an auto-submitting
  page) can have that navigation cut by the GET load, and its script may then send it again, as
  0052 accepted for frames. So can a form the agent itself sends with POST in that tab, by another
  tool call while `navigate` runs: its server has received it, and the agent then sees the page
  loaded again instead of the result. A POST result whose commit Foxleash has not yet heard is
  replaced by a GET of the tab's URL, which sends no form.
- A step to a page that never finishes loading now takes the step's 31 s, up to two 1 s waits for
  its request and the GET load's 1 s grace and 20 s, so `navigate` still answers within 54 s.
  Past `VIEW_START_LIMIT_MS` (50 s) its result carries no view of the page.
- Unchanged: a page whose document arrives after the step's 30 s timeout, because its server
  holds the response, is never loaded again, with or without a fragment: no commit is known when
  `navigate` decides, and the later commit puts the values back unmarked (0025 accepted it,
  unverified).
- Firefox stamps each webRequest and webNavigation event with `Date.now()` as it fires it, in
  whole milliseconds. A top-level request the page sends within the millisecond its commit is
  stamped counts as started by the commit: one that is not a GET refuses either load, and one for
  another address leaves nothing loaded. Unverified whether a page can hit that millisecond.
- Unverified: the wait for the history load may end before that load commits. It ends at the
  first `complete` after a `loading`, and Firefox reports an aborted top-level request as
  `complete` too. That could happen when Firefox reports the cut-off step load's abort after the
  GET load's `loading`, or when the page's script calls `window.stop()` while the load is pending
  (possible for every history load since 0051). `navigate`'s view and the agent's next reads then
  see the old document, with the values put back, until the load commits, which in the second
  case never comes. Measuring it: an end-to-end test that compares the top frame's `documentId`
  when `navigate` answers with the one the step committed, for a page with an image whose
  response never ends, and for a page that calls `window.stop()` repeatedly while its server
  delays the GET; if either answers on the old document, the wait must require the load's
  commit.
- Unverified that Firefox reports in this order: if it reported a request the page sent after
  its commit before the commit itself, that request would take the place of the page's own, and
  nothing would be loaded. 0016 measured the opposite lag.
- The page the step leaves is alive until the new page commits; a top-level request it starts
  between the new page's own request and that commit is taken for the commit's request, the
  addresses differ, and nothing is loaded. That page can be on any site. Unverified whether
  Firefox lets a page start a navigation during a history traversal without cancelling the
  traversal.
