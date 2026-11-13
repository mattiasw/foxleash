# 0052: After going back or forward, a frame's request that was not a GET no longer stops `navigate` loading the page's address again

**Status:** Accepted, 2026-11-13. Supersedes part of
[0051](0051-history-steps-load-the-page-again-with-get.md), and the frame veto of
[0025](0025-history-loads-and-autofilled-fields.md) for a URL without a fragment. Its decision
that the top-level veto and 0025's completed-load condition stay for both loads, as far as a
top-level request that was not a GET and started after the tab's last top-level commit and a
step's load that its timeout cut off go, for a URL without a fragment, and its "Still open"
consequence, which 0053 answers, are superseded by [0053](0053-history-get-loads-ignore-page-controlled-switches.md), 2026-11-13.

## Context

[0025](0025-history-loads-and-autofilled-fields.md) loads again a page that `navigate` back or
forward made Firefox load again, so that Firefox puts back no field value without its
`:autofill` mark, and refuses that load after any top-level or frame (`sub_frame`, `object`)
request that was not a GET, so that no form is sent again.
[0051](0051-history-steps-load-the-page-again-with-get.md) made that load, for a URL without a
fragment, `tabs.update(tabId, { url, loadReplace: true })`, and kept every veto. It rejected
dropping the frame veto only because doing so changes the exceptions the README and the add-on
listing name.

0051's measurements, in Firefox 156.0.1, headless: the GET load sent no POST and restored no
field value, at top or in a frame, in 11 of 11 runs, eager and lazy frames alike, since it loads
each frame from its `src`. For a page whose frame's history entry is a form POST, Firefox
reported that frame's POST from its cache before the check in 17 of 17 steps, so Foxleash loaded
nothing and Firefox put the frame's values back without the mark, where `read_page` can read
them.

So for the GET load the frame veto protects nothing, and it is a switch the page controls: an
approved page whose frame sends its own form with POST during the step's load makes Foxleash
skip the load.

## Decision

For a URL without a fragment, a frame (`sub_frame`, `object`) request that was not a GET no
longer refuses the load. `watchHistoryLoad` in `apps/extension/src/handlers.ts` tracks top-level
and frame requests that were not a GET apart: `reloads` refuses after a top-level one, and
`framePosted` tells whether a frame one started from the page's request on, or was reported
after it. `reloadHistoryLoad` reads whether the tab's URL has a fragment once, in the same
synchronous span as the last checks and the load, and with it both refuses after a frame's
request and picks the cache-bypassing reload.

A URL with a fragment keeps the frame veto with its `tabs.reload(tabId, { bypassCache: true })`.
The top-level veto, the kept-in-memory grace, the document check, the session's group, prompt
and site, and every wait and bound stay as 0025, 0049 and 0051 decided.

## Alternatives rejected

- **Dropping the frame veto for the fragment reload too.** The cache-bypassing reload's handling
  of frame entries is undocumented, and a normal reload was measured to send a frame's POST
  again.
- **Waiting per frame for its request by `frameId`.** Rejected in 0051: a wait on every step to a
  page with frames, and the outcome would still rest on the reload's handling of frame entries.

## Consequences

- Going back or forward to a page holding a frame a form sent with POST now loads the page's
  address again. Each frame loads from its `src`, so the agent sees the frame's first page, not
  the result of the POST, and the values typed or filled into the frame are gone.
- The exception in the README and the add-on listing narrows to a page whose address has a
  fragment and that holds such a frame.
- 0051's consequence that Foxleash loads nothing for such a page, since the frame veto stays, no
  longer holds for a URL without a fragment.
- A form that the page's own script sends with POST into a frame while the page loads is sent
  again by the load, as every other request the page's scripts send while it loads already was.
  The load sends no frame's POST from its history entry.
- Still open: switches the page controls. A top-level request that was not a GET, also one the
  page itself sends during the step's load, refuses either load, and so does a load that the
  step's timeout cut off, which a page can cause by never finishing a resource. For an address
  with a fragment, a frame request that was not a GET refuses the reload. And the page decides
  whether its address has a fragment, with the History API or `location.hash`, also during the
  step's load, so a page can still keep the frame veto.
