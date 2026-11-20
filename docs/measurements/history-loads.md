# History loads and filled-in fields

Measurements behind [ADR 0025](../adr/0025-history-loads-and-autofilled-fields.md).

## Going back and forward, and tabs Firefox unloaded (2026-10-24)

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
  instead, see the Consequences of ADR 0025); `navigate` with its URL loads it fresh; `navigate`
  back on a tab unloaded on the next page loads that page again. None shows a restored value.

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

With the one-second wait for a request that ADR 0025 had until its 2026-11-13 amendment, going
back or forward to a page Firefox kept in memory took about a second longer: the end-to-end test
of that case took about 1.2 s, and about 0.3 s with `reloadHistoryLoad` removed.

## Session restore after a restart (2026-10-27)

ADR 0025 accepted, unverified, that Firefox's session restore after a restart presumably puts
a filled login back into its field without the `:autofill` mark, as it does for a tab that was
unloaded and loaded again. The end-to-end harness can now quit Firefox gracefully and start it
again on the same profile, so this was measured on Firefox 156.0.1, headless:

- Method: save a login for the fixture server's site, open its login page in two tabs of a
  session and let Firefox fill both, flush every tab's state into the session store, quit
  through Marionette as File > Quit does, with `browser.startup.page` 3 ("Open previous
  windows and tabs"), and start Firefox again on the same profile. The extension is installed
  again and the site approval seeded again. The tab that was selected at the quit (front) loads
  at startup; the other (back) is restored unloaded, is moved into the new session's group with
  `tabs.group`, as a user would, and is selected with `tab_select`. Two cases: (a) the login
  still saved, (b) the login removed before the quit, so that no new fill can hide what the
  session store restores. Ten runs.
- Headless Firefox restored the session and the extension installed again in every run.
- Case (a), both tabs, 10 of 10: the field holds the login, marked, and `read_page` shows it as
  protected filled. In the back tab the marked login was there 68 to 120 ms after the load; in
  3 runs the first look before that found the field empty. No unmarked state was seen, polling
  every 100 ms, so a shorter moment between the session store's restore and Firefox's new fill
  is not ruled out. The front tab was marked at the first look, about a second after its load.
  The password field was filled too.
- Case (b), both tabs, 10 of 10: the field holds the login without the mark, and `read_page`
  shows its value. In the back tab it was there at the first look, 56 to 84 ms after the load,
  in the front tab at the first look about a second after its load, and stayed so to 8 s. The
  password field stayed empty: the session store does not keep password fields.
- Selecting the restored back tab made no request for the page to the server: Firefox loaded it
  from its cache.

`e2e/session-restore.test.ts` keeps checking both cases: each test restarts Firefox, waits until
each restored page has been loaded for 3 s, and checks the field and the back tab's `read_page`.

## Pages Firefox kept in memory, told by document id (2026-11-13)

Measured on Firefox 156.0.1, headless, in the end-to-end harness, from an extension page that
recorded every `webNavigation` event, every `main_frame`, `sub_frame` and `object`
`webRequest.onBeforeRequest`, `tabs.onUpdated`, and after each `navigate` the tab's
`webNavigation.getAllFrames` and the top document's `performance.timeOrigin`. Whether a step
showed the same document was told by a property set on each page before leaving it, and by a
`pageshow` listener noting `event.persisted`. `navigate` still had the one-second wait for a
request that ADR 0025 had before this date. In the end-to-end harness a step between two pages
Firefox kept in memory took 1,029 to 1,049 ms, a step between two `no-store` pages 48 to 63 ms.

- 12 steps that showed a page from memory (two storable pages back and forward 4 times; three
  storable pages back twice and forward twice; a page with an `unload` listener and a storable
  page): every one reported `webNavigation.onCommitted` for the top frame, with the
  `documentId` that document had at its earlier commit (its first load, or the reload that last
  loaded it), no `main_frame` request and no `onDOMContentLoaded`. `navigate` took 1,017 to
  1,080 ms.
- 9 steps that loaded the page again (the first step back between two storable pages, all 6
  steps between the two `no-store` pages, 2 steps to the page with an `unload` listener): every
  one committed a new `documentId`, after a `main_frame` GET that started 5 to 13 ms after the
  step began. Foxleash's reload then committed another new one. `navigate` took 45 to 78 ms.
- In all 30 steps, frame 0 of `getAllFrames` named the document of the tab's last top-level
  commit. `no-store` pages were loaded again on 6 of 6 steps.
- `performance.timeOrigin` also separated the cases: 73 ms to 6.5 s before the step began for
  every page shown from memory, after it for the others.
- A page shown from memory from another site (`127.0.0.1` and `localhost`, both approved) also
  committed with its earlier `documentId` (3 of 3, 1,023 to 1,043 ms).
- A page that reloads itself on a persisted `pageshow` (`if (event.persisted)
  location.reload()`, an idiom sites use to opt out of the back-forward cache), with a saved
  login filled into it and then removed: Firefox showed it from memory, its own reload then
  loaded it again, and the login name came back without its `:autofill` mark. In 3 steps the
  tab reported its load complete 15 to 34 ms after the step began, the page's reload began
  (`onBeforeNavigate` for the top frame) 0 to 5 ms after that, and its request was reported 10 to
  34 ms after it. The one-second wait for a request that ADR 0025 then had caught it.

So a page restored from memory does commit, as ADR 0025 says, also from another site.

## Loading the address again with GET, and frames a form sent with POST (2026-11-13)

Measured in Firefox 156.0.1, headless, through the end-to-end harness, on 2026-11-13: a top page
with an `unload` listener holds an iframe whose form was sent with POST, so the frame's history
entry is that POST; values were set in the frame's fields and in a field of the top page; the
tab went to another page and back. An extension page recorded every `webNavigation` event, every
`main_frame`, `sub_frame` and `object` `webRequest.onBeforeRequest` and the tab's status.

- Going back through `navigate`, frame from another site, 12 runs: Firefox loaded the frame again
  from its cache with POST and reported that `sub_frame` POST starting 7 to 21 ms after the
  top-level commit started. It was heard 16 to 29 ms after the commit and 24 to 98 ms before the
  tab's load complete (which came 42 to 124 ms after the commit). The frame veto refused the
  reload in 12 of 12, no second POST reached the server, and Firefox put the values back in the
  frame and in the top page.
- The same with a same-site frame, 5 runs: the POST started 10 to 19 ms after the commit and was
  heard from 9 ms before to 3 ms after the load complete. The check, which runs after further
  awaits, still saw it in 5 of 5.
- webRequest's `frameId` for the frame's request equalled webNavigation's `frameId` of the
  frame's commit in 17 of 17.
- A lazy frame (`loading="lazy"`, scrolled to), 12 runs: going back loaded it from its `src`
  with GET, not from its POST entry; `navigate` reloaded and no POST was sent.
- After a step taken outside Foxleash, three kinds of load: `tabs.reload` with `bypassCache`
  (9 runs) loaded every frame from its `src` with GET, restored nothing and sent no POST, and with
  an eager frame dropped the entries after the page (`history.length` 3 to 2, 6 of 6; the 3 lazy
  runs kept 3); `tabs.reload` without it (6 runs)
  restored the frame's entry and **sent its POST again**, with the values restored at top and in
  the frame; `tabs.update(tabId, { url, loadReplace: true })` with the tab's URL (11 runs, eager
  and lazy frames) loaded every frame from its `src` with GET, restored nothing at top or in the
  frame, sent no POST, reached the server for the top page (which sends no freshness headers),
  kept `history.length`, and Navigation Timing reported `navigate`.
- Request headers, 2 runs each, on a page that set a `SameSite=Strict` and a `SameSite=Lax`
  cookie: the GET load, the cache-bypassing reload and a normal reload all sent both cookies, no
  `Referer` and `Sec-Fetch-Site: same-origin`; only the cache-bypassing reload sent
  `Cache-Control: no-cache`.

So the late report did not occur in any measured step, and even a forced cache-bypassing reload
sent no frame POST. But "no frame form is sent again" rested on two things Firefox does not
promise: the order of its reports, with a margin of a few milliseconds for a same-site frame,
and the cache-bypassing reload's handling of frame entries, which is undocumented and differs
from a normal reload's, measured to send the POST again.

These measurements, in Firefox 156.0.1, headless: the GET load sent no POST and restored no
field value, at top or in a frame, in 11 of 11 runs, eager and lazy frames alike, since it loads
each frame from its `src`. For a page whose frame's history entry is a form POST, Firefox
reported that frame's POST from its cache before the check in 17 of 17 steps, so Foxleash loaded
nothing and Firefox put the frame's values back without the mark, where `read_page` can read
them.

## The wait for the load of the page's address (2026-11-13)

End-to-end tests in `e2e/read-page.test.ts` measured, in Firefox 156.0.1, the version
`bin/firefox-version.json` then pinned, on the code before the wait required the load's commit,
the two ways the wait for the load of the page's address could end before that load committed;
in the table, "this record" means that change. Each goes back to a page with a
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

Measured once with the wait requiring the load's commit, in the same Firefox: the test of the page
that calls `window.stop()` answered at the load's 20 s timeout, on the step's document with the
values put back, and took 28.4 s instead of about 8.4 s; the other two tests still answered on the
load's document.
