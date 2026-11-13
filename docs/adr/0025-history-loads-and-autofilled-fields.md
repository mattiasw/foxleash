# 0025: `navigate` reloads without the cache a page that going back or forward loaded again

**Status:** Accepted, 2026-10-24. Extends [0021](0021-autofilled-fields-are-protected.md). Its rule that a page taken from the back-forward cache waits a second for a request, and its accepted cases of a page that a page kept in memory replaces at once and of a `navigate` to a page's own address that a step to a page kept in memory replaces, are superseded by [0049](0049-history-steps-recognise-pages-kept-in-memory.md), 2026-11-13.

## Context

ADR 0021 protects a field while it matches `:autofill`, read at each read. Firefox restores
field values without that mark when it loads a page again from session history instead of
taking the document from the back-forward cache, and 0021 left the history loads unverified.
Experiments on Firefox 156.0.1, headless, through the end-to-end harness, with the saved login
removed after Firefox filled the page so that no new fill could hide the result, showed:

- `navigate` back to a cacheable page that has an `unload` listener: Firefox loads it again
  from the HTTP cache (a `main_frame` GET that webRequest sees, Navigation Timing type
  `back_forward`) and puts the filled username back unmarked, with what was typed in other
  fields. Going back over three pages to a page without such a listener mostly does the same;
  in 4 of 12 runs of its end-to-end test Firefox kept it in the back-forward cache instead,
  mark intact (Navigation Timing type `back_forward` all the same). Going forward to such a
  page, and going back or forward over four pages, restored nothing.
- Going back one page to a page without such a listener takes it from the back-forward cache:
  a top-level commit (`webNavigation.onCommitted`) but no request, the mark kept.
- A page a form sent with POST is loaded again from the cache with the POST method, without a
  request to the server, and its value comes back unmarked.
- A `navigate` reload without the cache right after such a step restores nothing.
- `navigate` with the tab's own URL is a replace load and restores nothing.
- A frame from another site: Firefox fills no saved login into it at all. With a value set in
  its field, a `navigate` reload restores nothing in the frame, and neither does a
  `tabs.reload` without `bypassCache`; the page's own `location.reload()` restores it.
- A tab unloaded with `gBrowser.discardBrowser` and selected again with `tab_select`: the
  session store puts the username back unmarked about a second after the load, and read_page
  shows it. This was seen in every run where the tab, selected again, showed the page. An
  end-to-end test checks it (see below).
- The page's own `history.back()` restores the value unmarked, as `navigate` back does.
- A history step that moves only a frame loads that frame again from the cache, with no
  `main_frame` request, and restores the frame's username unmarked.
- `navigate` reload on an unloaded tab leaves it on `about:blank` (`navigate` now loads the page
  instead, see Consequences); `navigate` with its URL loads it fresh; `navigate` back on a tab
  unloaded on the next page loads that page again. None shows a restored value.

The end-to-end tests in `e2e/read-page.test.ts` keep checking going back and forward, a page
that changes its address with `history.replaceState` as going back loads it again, the three
and four page cases, the page kept in memory, the POST page, the tab's own URL and the frame
from another site. The three page and kept in memory tests accept either of Firefox's choices,
keeping the page in memory or loading it again, and check the outcome that goes with it. The
end-to-end tests also check the unloaded tab, since `tab_open` loads the page only after
Firefox's own `about:blank` load in the new tab has committed. Before that, in the full test
file, the session store's history for a tab Foxleash opened usually ended on an `about:blank`
entry after the page, and the tab, selected again, showed `about:blank`. Session restore after
a restart is out of the harness's reach.

## Decision

- For `back` and `forward`, `navigate` watches `webRequest.onBeforeRequest` and
  `webNavigation.onCommitted` for the tab from before the step until the follow-up reload
  starts (`watchHistoryLoad` in `apps/extension/src/handlers.ts`), noting when each request and
  commit started (`timeStamp`). Firefox can report a navigation's own request after its commit
  (measured in 0016: 211 ms after), so the two are matched by when they started, not by the
  order they arrive in. `navigate` then reloads the tab with `bypassCache: true` and returns the
  tab after that load (`reloadHistoryLoad`), only when all of these hold:
  - the step's load completed before its 30 s timeout: a load cut off earlier may not have
    requested its frames yet, so a frame's POST would go unseen;
  - the tab's last top-level commit is on the web, and the last `main_frame` request that
    started no later than that commit is for the commit's URL, both without their fragment. The
    commit's URL, not the tab's, so a page that changes its address with the History API while
    it loads is still reloaded. A request that loads no document (a 204, a download, a
    navigation the step replaced) causes no reload, and stops one only when it started between
    the page's own request and the commit;
  - that request was a GET, and so was every `main_frame` and frame request (`sub_frame`, and
    `object` for a document in an `<object>` element) that started no earlier than it, or that
    Firefox reported after it. A request that started before it and was reported before it was
    for a document that never showed;
  - the tab is still in the session's group, does not show the session's prompt, and is on a
    site the session may act on (approved and not blocked).

  When the step's load has completed with a commit on the web but no request that matches it has
  been reported, `navigate` waits up to 1 s for one (`HISTORY_REQUEST_TIMEOUT_MS`) and then
  decides; without one it reloads nothing. It waits at most 20 s for the reload's load, so that
  with the step's own wait (up to 31 s) and the wait for the request, `navigate` answers within
  the host's 60 s request timeout (53 s at most). The checks and the reload's start run with no
  await between them, so a request the page sends up to then still counts.
- A page taken from the back-forward cache commits but makes no request, so it is not
  reloaded, and `navigate` waits the full second for a request before it answers. A step with
  nowhere to go commits nothing, and `navigate` neither reloads nor waits.
- `navigate` with the tab's own URL and the `reload` action need nothing more.

## Alternatives rejected

- **Reloading after every back and forward**: it reloads pages kept in the back-forward cache
  and sends POST forms again.
- **Telling a page loaded again apart by Navigation Timing**, through a script in the page: it
  needs a script in every page, and cannot see the request's method.
- **Skipping `no-store` pages**, which restore nothing: it needs the response headers, and
  frames under such a page were not measured.
- **Comparing the request's URL with the tab's URL** instead of the commit's: a page that adds a
  timestamp to its address with `history.replaceState` while it loads would not be reloaded.
- **Deciding at the commit, from the requests reported before it**: when Firefox reports the
  page's own request after the commit, the page is not reloaded. An end-to-end run of that
  decision made no reload in two of the five tests that expect one.
- **Also reloading on frame requests**: a page taken from the back-forward cache that adds a
  frame on `pageshow`, or a page whose own frame loads while a step with nowhere to go waits,
  would be reloaded.
- **Closing a step that moves only a frame**: telling it apart needs the top document's identity
  before and after the step, with the same false reloads as above.
- **Keeping the watch after a step that made no request within the load's one-second grace**,
  for a page that delays its unloading: every step back to a page in the back-forward cache
  would hold a listener or reload late, and the page can call `history.back()` itself.
- For the accepted cases, **a per-tab note of fields read as autofilled**: it needs
  per-document state, rejected in 0021. **Protecting changed text fields in documents
  Navigation Timing reports as loaded by `back_forward` or `reload`** would change 0021's read
  rule and hide what the agent typed there; deferred. **Closing tab restore in `tab_select`**
  covers only the tabs the agent selects, not the ones the user does; deferred.

## Consequences

- A page Firefox loads again on going back or forward loads twice and runs its scripts twice;
  a page Firefox served from its cache now also makes a request to its server, a `no-store`
  page two. Its fields lose what the user or the agent typed into them.
- Forward is closed as a precaution: no forward step measured restored anything, but nothing
  rules it out.
- When Firefox reports the page's own request after the step's load completed, `navigate`
  answers that much later.
- Going back or forward to a page Firefox kept in memory takes about a second longer: the
  end-to-end test of that case takes about 1.2 s, and about 0.3 s with `reloadHistoryLoad`
  removed.
- Accepted, measured: a page a form sent with POST, which a reload would send again; a page on
  a site the user approves only after the step; a step that moves only a frame, whose value
  screenshots then draw (read_page does not read frames); the page's own history steps, as 0021
  accepted its own reload; a tab Firefox or the user unloaded, loaded again (checked by an
  end-to-end test, see Context).
- Accepted, unverified: a page holding a frame a form sent with POST, for the same reason as a
  POST page; a page that delays its unloading past the one-second grace escapes the watch, the
  same exposure as the page calling `history.back()`; a parallel tool call can read the page
  between the step's load and the reload; a page that arrives after `navigate`'s 30 s load
  timeout, which commits once the watch has ended, or whose load is still going on then, which
  is not reloaded; a page whose own request Firefox reports more than a second after the step's
  load completed, which is not reloaded; a system clock stepping back during the step
  (`timeStamp` is wall-clock time, see 0016), which can keep the page from being reloaded, or,
  when Firefox also reports the page's own request after a POST of one of its frames, make that
  POST look like the page left's, so that the reload could send it again; a frame's POST that
  Firefox reports only after the checks, as it can report a page's own request late, which the
  reload could send again; a page that the page shown by the step, or a navigation racing the
  step, replaces at once with a page Firefox kept in memory, which is then reloaded, POST data
  included, since the checks look at the last commit and the reload at what the tab shows; a
  `navigate` to a page's own address that a step to that page, kept in memory, replaces: the
  replaced navigation's request matches the step's commit, so the page is reloaded, which
  restores nothing but drops what was typed into it; session restore after a restart, which
  uses the same session-store form data as an unloaded tab and so presumably restores the value
  unmarked; card and address autofill, which need the user's pick in Firefox's popup.
- `navigate` on an unloaded tab shows no restored value (see Context); its reload loads the
  page again, as `navigate` with its URL does.
- Revisit when Firefox marks restored values as autofilled, or on a report of a value read after
  one of the accepted cases.
