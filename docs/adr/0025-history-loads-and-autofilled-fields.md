# 0025: After going back or forward to a page Firefox loaded again, `navigate` loads its address again with GET, and reloads without the cache only an address with a fragment

**Status:** Accepted, 2026-10-24. Extends [0021](0021-autofilled-fields-are-protected.md).

Amended 2026-10-27: a login field Firefox restores after a restart was measured to show its value
when no saved login fills it again; accepted, nothing in the extension changed.

Amended 2026-11-13: a page Firefox kept in memory is told by its commit's `documentId` and decided
after a 200 ms grace instead of a one-second wait for a request, and nothing is loaded while the
tab shows a document from before the step that no commit during it named. Why: every step to such
a page waited the full second.

Amended 2026-11-13: for an address without a fragment, the reload without the cache became a GET
load with `tabs.update` and `loadReplace`. Why: it sends no frame's POST whatever order Firefox
reports requests in; the reload's handling of frame entries is undocumented.

Amended 2026-11-13: for an address without a fragment, a frame's request that was not a GET no
longer refuses the load. Why: the GET load sends no frame's POST, so the veto was only a switch
the page controls.

Amended 2026-11-13: for an address without a fragment, neither a step load its timeout cut off nor
a top-level request that was not a GET and started after the last commit refuses the GET load.
Why: both are switches the page controls, and the GET load sends no form again.

Amended 2026-11-13: the wait for the load ends only after the load committed. Why: a page that
stops the load ended the wait at once, on the step's document with the values put back.

## Context

ADR 0021 protects a field while it matches `:autofill`, read at each read. Firefox puts values
back without that mark when it loads a page again from session history instead of showing the
document it kept in memory (the back-forward cache): going back or forward, a page a form sent
with POST, a frame's entry, a tab its session store restores after unloading it or a restart. A
page kept in memory commits again with its earlier `documentId` and makes no request; a page
loaded again commits a new one after its own request, which Firefox can report after the commit
([0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md) measured 211
ms). A normal reload sends a frame's POST again. Loading an address with a fragment over the
document it names loads no document.

[The measurements behind this record](../measurements/history-loads.md) give each experiment;
`e2e/read-page.test.ts` and `e2e/session-restore.test.ts` keep checking these cases.

## Decision

In `apps/extension/src/handlers.ts`:

- `watchTopDocuments` records from startup, per tab, the `documentId` of each top-level commit of
  a web page: at most `KNOWN_DOCUMENTS_PER_TAB` (50), the least recently committed dropped first,
  the tab's record dropped with the tab.
- For `back` and `forward` only, `watchHistoryLoad` copies the tab's record before the step and,
  until the load starts, notes the tab's top-level (`main_frame`) and frame (`sub_frame`,
  `object`) requests and its top-frame commits and `onBeforeNavigate`, matching requests to
  commits by start time (`timeStamp`), not report order. `navigate` with a URL and `reload` need
  nothing more.
- After the step's own wait (`waitForLoad` in `apps/extension/src/wait-for-load.ts`, no URL,
  `LOAD_GRACE_MS` 1000, `LOAD_TIMEOUT_MS` 30000), `reloadHistoryLoad` decides on the last
  top-level commit:
  - none, or off the web (a step with nowhere to go): nothing is loaded or waited for;
  - a `documentId` in the copy, a page kept in memory: once a `KEPT_GRACE_MS` (200 ms) grace ends
    with no top-frame `onBeforeNavigate` reported after that commit, nothing is loaded; a
    navigation begun in it is decided at its commit. The grace starts when `navigate` decides, and
    again at each later commit of a kept document. This precedes the request rule;
  - otherwise, a page loaded again: it is loaded again when the latest top-level request that
    started no later than the commit is for the commit's URL (not the tab's, which the History API
    can change; both without fragment), and no top-level request that was not a GET started from
    that request's start through the commit, or was reported after it and started no later than
    the commit;
  - while undecided it waits up to `HISTORY_REQUEST_TIMEOUT_MS` (1000 ms), which a top-level
    request or a grace's end can end early, a commit not; still undecided, nothing is loaded.
- It then reads the session's group and view, the frames (`webNavigation.getAllFrames`) and the
  tab, the last await before the load. A commit heard meanwhile that reopens the decision is
  decided once more, two decisions at most, then nothing is loaded. Nothing is loaded when frame 0
  names a document from the copy that no commit during the step named while the last commit has a
  `documentId` (the check passes when the frames cannot be read, list no frame 0 or name no
  document), when the tab left the session's group or shows its open prompt, or when the session
  may not act on the URL's site.
- An address with a fragment, empty too, read once from the tab's URL after that last await, is
  also not reloaded after a step load its timeout cut off, a frame request that was not a GET from
  the page's own request on or reported after it (`framePosted`), or a top-level one started after
  the last commit (`topPosted`).
- The load is `browser.tabs.update(tabId, { url, loadReplace: true })`, a GET that replaces the
  history entry, carries no POST data and loads each frame from its `src`; for an address with a
  fragment, `browser.tabs.reload(tabId, { bypassCache: true })`. Its wait is `waitForLoad` with no
  URL, so a redirect still ends it, `commit: true` and `HISTORY_RELOAD_TIMEOUT_MS` (20 s): a
  `complete` ends it only after a top-frame commit, not of about:blank, that followed a top-frame
  `onBeforeNavigate`, not of about:blank, heard after the wait began; the grace ends nothing; with
  no commit by the timeout the tab is returned as it is.
- `navigate` answers within 54 s (the step's 31 s, two 1 s decisions, the load's 1 s grace and 20
  s), below the host's 60 s request timeout (`apps/server/src/host.ts`). `noteReturned` notes a
  tab returned still loading, so `wait_for` with `navigation` does not count that load's end.
- A login field Firefox restores after a restart is accepted as measured.

What users read: [reloading and going back or
forward](../security.md#reloading-and-going-back-or-forward) and [when a field Firefox filled in
shows its value again](../security.md#when-a-field-firefox-filled-in-shows-its-value-again).

## Alternatives rejected

- **Loading again after every step**: it loses what was typed into pages kept in memory, and for a
  POST page shows another page or, with the reload, sends the POST again.
- **A script in the page**: Navigation Timing needs one in every page and cannot see the method;
  reading `performance.timeOrigin` runs a script before the site check, costs a round trip, and a
  compromised content process could fake it. The parent-process `documentId` needs none of this.
- **Skipping `no-store` pages**: it needs the response headers; frames under them were not
  measured.
- **Comparing the request's URL with the tab's**: a page that changes its address with
  `history.replaceState` while it loads would not be loaded again.
- **Deciding at the commit**, or **ending the wait for a request on a commit**: Firefox reports
  the page's own request late (no load in two of five end-to-end tests), and an earlier request
  for the address, such as one the step replaced, would decide before a late POST is reported.
- **Deciding only on requests that started after the previous commit**: a racing load of the page
  being left that commits after the step's request began would leave the page unloaded.
- **Also loading again on frame requests**, or **closing frame-only steps**: a page kept in memory
  whose frame loads on `pageshow` would be loaded again.
- **Keeping the watch past the step's one-second grace**, for a page that delays its unloading:
  every step would hold a listener or load late, and the page can call `history.back()` itself.
- **No grace**, or **one for the step's own commit only**: a page that reloads itself on
  `pageshow`, at once or after going back again, would show the value unmarked.
- **`transitionQualifiers`** (`forward_back` on both kinds), **the absence of `onDOMContentLoaded`
  or of a request** (they need the wait), **the `documentId` of the page being left** (the wrong
  document), **the record instead of a copy** (every page would look kept), **telling a later
  navigation by `timeStamp`** (it once equalled the commit's).
- **Refusing whenever frame 0 is not the last commit's document**: a page that reloads itself
  between the frames read and the check would not be loaded again.
- **Waiting per frame for its request by `frameId`**: a wait on every step to a page with frames,
  and the outcome would still rest on the reload's handling of frame entries.
- **The cache-bypassing reload for every address** (undocumented behaviour) and **a normal
  reload** (measured to send a frame's POST again and restore values).
- **Dropping the fragment, or loading without it first**: another view of a page that routes by
  its fragment, whose scripts run. **The commit's URL for the fragment**: the History API sets it
  before the step.
- **Dropping the reload's frame, top-level or cut-off-load vetoes**: frame entries undocumented,
  frames not yet requested, a POST navigation committed after the check would be sent again.
- **Dropping the top-level veto for the page's own request**: the GET load would replace the POST
  result.
- **The tab's URL for the load's wait**: a redirect would not count, and no commit would fail with
  `navigation_timeout`. **Ending it at the first `complete`**: an earlier load's abort or a stop
  would end it.
- For the accepted cases: **a per-tab note of fields read as autofilled** (per-document state,
  rejected in 0021); **protecting changed text fields in documents loaded by `back_forward`,
  `reload` or the session store** (changes 0021's read rule and hides what the agent typed;
  deferred); **closing tab restore in `tab_select`** (misses tabs the user selects and the tab
  shown at startup; deferred).

## Consequences

- A page loaded again loads and runs its scripts twice and loses what was typed. A page served
  from the cache also requests its server, a `no-store` page twice, unless the GET load comes from
  the HTTP cache for a page declaring freshness. The GET load is a `navigate` for Navigation
  Timing, sends no `Cache-Control: no-cache`, and starts with a null `history.state` (not
  measured).
- Forward is closed as a precaution: no measured forward step restored anything, but nothing rules
  it out. A late own request delays the answer by as much. A step to a page kept in memory answers
  about 0.2 s after it shows.
- A kept page that navigates itself after the grace is not caught, like its own later reloads; one
  that begins a navigation in the grace that never commits waits the second and is not loaded; one
  whose reload's request is reported before its commit is loaded at the second's end.
- A page kept in memory whose id left the record, predates the background, or lacks one, is
  decided as loaded again: it waits the second, and is loaded when a request for its address raced
  the step.
- `navigate` on an unloaded tab shows no restored value; its reload loads the page.
- Accepted, measured: a POST page, whose result a load would replace or send again; a site
  approved after the step; a frame-only step, whose value screenshots draw (`read_page` reads no
  frames); the page's own history steps; an unloaded tab loaded again; a login field restored
  after a restart with no saved login, shown in the front tab and the others alike.
- A page with a frame a form sent with POST: without a fragment it is loaded again, the frame
  shows its first page, and a POST the page's script sends into a frame while loading is sent
  again; with one, the frame veto refuses and the values come back (measured when the veto applied
  to every address).
- With a fragment, the vetoes are switches the page controls: a resource never ending, a frame's
  or top-level POST, the fragment itself. Those needing the top page's script add only values in
  frames from other sites; a never-ending resource, a cross-site frame's POST and a fragment in
  the agent's address also keep the page's own fields' values.
- A top-level POST the page or the agent sends while `navigate` runs can be cut by the GET load:
  its server has it, and the page's script may send it again. An unheard POST result is replaced
  by a GET.
- A page that never finishes loading takes up to 54 s, past `VIEW_START_LIMIT_MS` (50 s): no view.
- A page that keeps stopping the load is answered at the 20 s timeout on the step's document
  (measured); a load with no document (204, download) takes the 20 s (not measured); a server
  slower than 20 s leaves the step's document until it commits; a navigation the page begins
  counts as the load's commit.
- The window between Firefox acting on the load and the last check is narrowed for the GET load
  and remains for the fragment reload.
- The record holds only opaque document ids per tab; nothing new leaves the browser.
- Accepted, unverified: a page delaying its unloading past the step's grace; a `complete` ending
  the step's wait before its commit is heard, which leaves nothing loaded (going back from a page
  still loading did not, 3 of 3); a parallel read before the load; a document arriving after the
  step's 30 s; an own request reported over a second late; the clock stepping back, which can
  block the load or, with a fragment, hide a frame's POST from the veto so the reload sends it;
  with a fragment, a frame's POST reported after the checks or a frame never requested (lazy,
  `window.stop()`); a request in the commit's millisecond; a request sent after the commit
  reported before it; a top-level request the page being left, on any site, starts before the new
  page commits; a kept page's POST to its own address in the grace while a request for that
  address raced the step, reported late, which the fragment reload sends again and whose result
  the GET load replaces; a read between the restore and a new fill; a crash restore, which the
  end-to-end test does not cover (Firefox's remote agent turns
  `browser.sessionstore.resume_from_crash` off unless the profile sets it); Reopen Closed Tab or
  Window; card and address autofill.
- Revisit when Firefox marks restored values as autofilled, changes how it gives document ids or
  reports frames, if the fragment reload's frame veto is dropped, or on a report of a value read
  after an accepted case.
