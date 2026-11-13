# 0051: After going back or forward, `navigate` loads the page's address again with GET instead of reloading it

**Status:** Accepted, 2026-11-13. Supersedes parts of
[0025](0025-history-loads-and-autofilled-fields.md) and
[0049](0049-history-steps-recognise-pages-kept-in-memory.md).

## Context

[0025](0025-history-loads-and-autofilled-fields.md) reloads without the cache a page that
`navigate` back or forward loaded again, so that Firefox puts back no field value without its
`:autofill` mark, and refuses that reload after any top-level or frame request that was not a
GET, so that no form is sent again. That refusal sees only the requests Firefox reported before
the last check, and nothing waits for a frame's request. Both 0025 ("a frame's POST that
Firefox reports only after the checks") and [0049](0049-history-steps-recognise-pages-kept-in-memory.md)
("As before") left that case open, and 0049 rejected loading the address with
`tabs.update({ url, loadReplace: true })` until it was measured with frames.

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

## Decision

`reloadHistoryLoad` in `apps/extension/src/handlers.ts` loads the tab's URL, the one the site
check just passed, with `browser.tabs.update(tabId, { url, loadReplace: true })`: a GET that
replaces the current history entry, carries no POST data and loads each frame from its `src`.
No await separates the last check from the call.

A URL with a fragment, also an empty one, keeps `browser.tabs.reload(tabId, { bypassCache: true })`:
loading such a URL over the document it names is a fragment navigation, which loads no document.

Every veto, wait and bound of 0025 and 0049 stays: a top-level or frame request that was not a
GET, the kept-in-memory grace, the document check, the session's group, its prompt and its site,
`HISTORY_REQUEST_TIMEOUT_MS`, `KEPT_GRACE_MS` and `HISTORY_RELOAD_TIMEOUT_MS`. The load is waited
for without a URL, as the reload was, so a redirect still ends the wait and the 54 s bound holds.

## Alternatives rejected

- **Waiting, per frame commit, for that frame's request by `frameId`.** The ids agree (17 of
  17), but it adds a wait to every step to a page with frames and still leaves the outcome to the
  reload's handling of frame entries.
- **Keeping the cache-bypassing reload.** Safe as measured, but on undocumented behaviour.
- **A normal reload.** It sends a frame's POST again (measured) and restores field values.
- **Dropping the fragment and loading the address without it.** It loads another view of a page
  that routes by its fragment.
- **Dropping the frame veto now.** It is redundant for the GET load, but dropping it changes the
  exceptions that the README and the add-on listing name: a listing change, possible later.

## Consequences

- Closed by construction for a URL without a fragment: a frame's POST that Firefox reports only
  after the checks (0025's accepted, unverified case; 0049's "As before").
- Narrowed: the window between the checks and Firefox acting on the load (0049). The load is of
  the checked URL, with GET, so a page the tab reached meanwhile is replaced by that URL rather
  than reloaded.
- Still open: a URL with a fragment, whose reload behaves as measured above.
- Changed: the load may come from the browser's HTTP cache for a page that declares freshness,
  and then makes no request to its server; a new load restores no field value either way.
  Navigation Timing reports `navigate`, not `reload`. The request headers are those of the
  reload without its `Cache-Control: no-cache`. By the HTML standard the replacing entry starts
  with a null `history.state`, where a reload keeps the entry's state (not measured), so a page
  that renders from that state shows its default view.
- 0025's accepted case of a page holding a frame a form sent with POST is now measured: Firefox
  restores the frame's values and Foxleash loads nothing, since the frame veto stays. The
  end-to-end test of this case asserts that no second POST reaches the server.
- Revisit when Firefox changes how it reports or restores frames, or if the frame veto is
  dropped.
