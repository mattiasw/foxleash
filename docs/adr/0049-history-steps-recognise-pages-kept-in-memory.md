# 0049: Going back or forward tells a page Firefox kept in memory by its document id and answers without waiting for a request

**Status:** Accepted, 2026-11-13. Supersedes parts of [0025](0025-history-loads-and-autofilled-fields.md). Its rejected alternative `tabs.update({ url, loadReplace: true })` and its consequence of a frame's POST that Firefox reports only after the checks, except for a URL with a fragment, are superseded by [0051](0051-history-steps-load-the-page-again-with-get.md), 2026-11-13.

## Context

[0025](0025-history-loads-and-autofilled-fields.md) reloads without the cache a page that
`navigate` back or forward loaded again, and tells such a page by its own `main_frame` request.
A page Firefox kept in memory (the back-forward cache) makes no request, so `navigate` waited the
full `HISTORY_REQUEST_TIMEOUT_MS` (1 s) for one before answering. In the end-to-end harness a step
between two pages Firefox kept in memory took 1,029 to 1,049 ms, a step between two `no-store`
pages 48 to 63 ms.

Measured on Firefox 156.0.1, headless, in the end-to-end harness, from an extension page that
recorded every `webNavigation` event, every `main_frame`, `sub_frame` and `object`
`webRequest.onBeforeRequest`, `tabs.onUpdated`, and after each `navigate` the tab's
`webNavigation.getAllFrames` and the top document's `performance.timeOrigin`. Whether a step
showed the same document was told by a property set on each page before leaving it, and by a
`pageshow` listener noting `event.persisted`:

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
  34 ms after it. 0025's one-second wait caught it.

So a page restored from memory does commit, as 0025 says, also from another site; code comments
that said it brings no commit were wrong and now say so.

## Decision

- From startup the background records, per tab, the `documentId` of each top-level commit of a
  web page (`watchTopDocuments` in `apps/extension/src/handlers.ts`): at most
  `KNOWN_DOCUMENTS_PER_TAB` (50) per tab, the least recently committed dropped first, and the
  tab's record dropped on `tabs.onRemoved`.
- `watchHistoryLoad` takes a copy of the tab's record before the step starts. A copy, since the
  record hears each commit before the watch does. A top-level commit whose `documentId` is in the
  copy shows a document Firefox kept in memory: its field values and their marks are as they
  were, so nothing is reloaded and no request is waited for. This comes before the request
  rule: a `main_frame` request for the address of such a document loaded no document (a
  navigation the step replaced).
- Such a commit gets a grace of `KEPT_GRACE_MS` (200 ms, 40 times the measured 0 to 5 ms) for a
  navigation of its own: the step's own commit from when `navigate` decides, after the step's
  load, and a commit the tab reaches later, such as when the page shown goes back again at once,
  from that commit. A top-level `onBeforeNavigate` the tab reports after the commit makes the
  decision undecided until that navigation commits, which is then decided as 0025 decides.
  "After the commit" goes by the order Firefox reports the two events in, not by `timeStamp`: the
  step's own `onBeforeNavigate` was reported before its commit in every measured step, once with
  the same `timeStamp`. A request alone does not end the grace. Each later top-level commit is
  decided afresh: one with a known id gets its own grace, one with a new id goes down 0025's path.
- All of it stays within 0025's wait of `HISTORY_REQUEST_TIMEOUT_MS` from when `navigate`
  decides, which only a request or the end of a grace ends early, as in 0025: a grace or a
  navigation still under way when the wait ends reloads nothing.
- A top-level commit Foxleash hears while it reads the tab before the reload, after deciding to
  reload, leaves the decision undecided: `navigate` then decides once more, with a wait and a grace
  of their own, and reads the tab again. A second such commit reloads nothing.
- Every other case is 0025's: a commit without a `documentId`, or with one not in the copy, waits
  up to `HISTORY_REQUEST_TIMEOUT_MS` for its request and is reloaded under all of 0025's
  conditions.
- Before `tabs.reload`, `navigate` also reads the tab's frames (`webNavigation.getAllFrames`,
  awaited before `tabs.get`, which stays the last await) and refuses the reload when frame 0
  names a document the tab committed before the step that no top-level commit during the step
  named, as checked in the synchronous check right before the reload. When the frames cannot be
  read, list no frame 0, or name no document, a document first committed during the step, or one
  that also committed during the step, or the commit has no `documentId`, the check passes as
  before: such a document is one the page loaded again, or the frames were read before a later
  commit Foxleash heard by the check.
- `navigate` still answers below the host's 60 s request timeout: at most 31 s for the step, 1 s
  for each of the two decisions and 20 s for the reload, plus the reload's own one-second grace,
  54 s.

## Alternatives rejected

- **The document's `performance.timeOrigin`**, read through `scripting.executeScript`: it also
  separated the cases, but it runs a script in the page the step landed on before the site check,
  so possibly on a site the session may not act on; it costs a round trip; and the value comes
  from the page's content process. The page cannot change it in the isolated world, but a
  compromised content process could make a page loaded again look kept and skip the reload,
  leaving an unmarked restored value readable. A page can already copy its own value into an
  unmarked field, so the gain is small, but the parent-process `documentId` needs none of this.
- **Answering at once, with no grace**: a page that reloads itself on `pageshow` then shows the
  value unmarked, which the one-second wait caught.
- **`transitionQualifiers`**: `forward_back` on both kinds of step.
- **The absence of `onDOMContentLoaded` or of a request**: signals of something not happening,
  which need the wait this change removes.
- **The `documentId` of the page being left**, from `getAllFrames` at the step's start: it names
  the wrong document.
- **Reading the record itself instead of a copy**: it already holds each commit's own id when the
  watch hears the commit, so every page loaded again would look kept.
- **Telling a navigation begun after the commit by `timeStamp`**: the step's own
  `onBeforeNavigate` once carried the same `timeStamp` as its commit.
- **One grace, for the step's own commit only**: a page shown that goes back at once to another
  page kept in memory, which reloads itself on `pageshow`, would not be caught.
- **Ending the wait for a request on a commit**, which would answer about a second sooner for a
  page that reloads itself with its request reported before its commit: an earlier request for
  the commit's address, such as one the step replaced, then decides before the commit's own
  request, perhaps a POST, is reported.
- **Refusing the reload whenever frame 0 names a document other than the last commit's**: a page
  loaded again that reloads itself between the frames read and the check would not be reloaded,
  nor one that goes back to a page kept in memory which then reloads itself in that time.
- **`tabs.update({ url, loadReplace: true })` in place of `tabs.reload`**, which could close a
  frame's late POST: it needs its own measurement with frames.

## Consequences

- A step to a page Firefox kept in memory answers about 0.2 s after the page shows instead of
  about 1 s.
- Closed while Firefox gives document ids (156 does) and the restored document's id is in the
  record: 0025's accepted case of a page that the page shown by the step, or a navigation racing
  the step, replaces at once with a page Firefox kept in memory, which was then reloaded. The
  restore commits with a known id (measured), and should Firefox commit nothing for it, the
  document check refuses the reload, unless that document also committed earlier in the step.
  When the id is not in the record and a request for its address raced the step, the outcome is
  0025's.
- Closed on the same condition: 0025's accepted case of a `navigate` to a page's own address that
  a step to that page, kept in memory, replaces. The page is no longer reloaded.
- As before: a frame's POST that Firefox reports only after the checks. The added `getAllFrames`
  await gives a late report a few more milliseconds before the check, which closes nothing.
- As before, a commit is decided on the latest top-level request that started before it, also
  one an earlier commit of the step was decided on. So a form a page kept in memory sends with
  POST to its own address within the grace, while a request for that address raced the step, is
  sent again if Firefox reports the form's request only after the wait ends, at least 0.8 s after
  it began (0016 measured at most 211 ms after the commit). Deciding only on requests that
  started after the previous commit would close this, but would leave a page loaded again
  unreloaded when a racing load of the page being left commits after the step's request began.
- Narrowed, accepted: a page kept in memory that navigates itself (reload, history step) more
  than `KEPT_GRACE_MS` after it shows, but within the old second, is no longer caught. This is
  the same exposure as the page's own later reloads and history steps, which 0021 and 0025
  accept; one that does so at once, as the measured idiom does, still is.
- A page whose id fell out of the record (50 other web documents committed in the tab since it
  last committed), or that committed before the background started, waits the second as before.
  Without document ids (another Firefox), the behaviour is 0025's.
- A page kept in memory that begins a navigation within the grace which never commits (a 204, a
  download) waits the second and is not reloaded, as a step that loads no document. One whose
  own reload's request Firefox reports before its commit is reloaded at the end of the second, as
  in 0025.
- The window between Firefox acting on `tabs.reload` and the last check remains, for the
  document as for requests.
- The record holds only opaque document ids of web pages, per tab, dropped with the tab; nothing
  new leaves the browser.
- Revisit when Firefox stops giving document ids, or gives a document it restores from memory a
  new one, or gives a document it loads again an id an earlier document had: such a page would
  look kept and not be reloaded.
