# 0081: A session's tabs cancel a response that is not a page from a site the session may not act on

**Status:** Accepted, 2026-11-18. Amends "Non-blocking listeners only" of
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md) and "it never
blocks or changes a request" of
[0071](0071-read-network-captures-response-bodies-with-a-stream-filter.md) for this one case.

Amended 2026-11-18: a window or tab that a page in a session's tab opens is judged as that
session's, so a file loaded there is no longer saved.

Amended 2026-11-18: the tab groups made for sessions are stored, so the tabs of a session's group
stay judged after a Firefox restart or an update or reload of the add-on.

Amended 2026-11-18: a download from a load whose headers never came, as when the other site's
service worker answers it, is cancelled and its file removed after the fact; since such a file
exists for a moment, `upload_file` refuses a file changed in the last 5 seconds.

Amended 2026-11-19: a Blob file that a page of such a site builds itself in a session's tab or
frame is cancelled and its file removed after the fact; a `data:` file is not.

Amended 2026-11-19: a download a load refused is also reported to a later load of its address,
so a `navigate` or `tab_open` of that address fails at once instead of timing out.

Amended by [0101](0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md), 2026-11-19: the
consequence "The request still reaches the other site, with the cookies Firefox sends for it" no
longer holds for a redirect hop to a blocklisted site in a load the agent started, which is
cancelled before it is sent.

Amended 2026-11-20: a window whose opening tab closes at once is judged by the group that tab was
seen in, and a page that saves its own address as a file is named as still saved.

Amended 2026-11-20: the tabs left in an ended session's group also pass files of the sites that
session was allowed for itself, until the background restarts, so such a site's files are no
longer stopped there, nor its Blob files cancelled in every tab.

## Context

A page on a site the session is approved for (A) could make Firefox save, into the download
folder, a file served by a site the session may not act on (B: not approved for the session, or
on the blocklist), requested with the user's cookies for B: by a click on a link that redirects
there, a `navigate`, or A's own script
([three ways measured](../measurements/file-guard.md#three-ways-a-page-got-a-file-of-another-site-saved-before-the-guard-2026-11-18)).
The download folder is an upload folder by default, so `upload_file` then handed that file to A's
page.
The click check and the gate of `navigate` and `tab_open` read only the first address, and a
response Firefox saves commits no document, so the redaction of a tab on another site never runs.
No listener of the extension blocked a request: ADR 0016 allowed non-blocking listeners only, and
the one blocking listener of ADR 0071 returns at once.

A check of response headers misses the same file by other routes: a window a page opens has no
group and no `openerTabId`; the background forgets its groups at a restart, an update or a
reload; B's service worker answers a load with no `onHeadersReceived`; and B's page can build the
file itself, with no request. The [file guard measurements](../measurements/file-guard.md) cover
each, and the cases the fixes brought. What users are told is in
[Files a page loads in the agent's tabs](../security.md#files-a-page-loads-in-the-agents-tabs).

## Decision

`createFileGuard` in `apps/extension/src/file-guard.ts`, called at the top level of
`background.ts`.

**Listeners.** At the top level it adds only tab listeners (`tabs.onCreated`, `tabs.onUpdated`,
`tabs.onRemoved`, `tabs.onDetached`) and site access ones (`onRunningChange`, `onWithdraw`).
`listen()` adds the rest once, never removed: at the first `access.onRunningChange`, or when a tab
whose group `rememberedSessionOf` answers is seen in a tab event or in the start-up
`tabs.query({})` (`listenForOpenTabs`). They are a blocking `webRequest.onHeadersReceived`
(`onHeaders`, with `{ urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] }` and
`["blocking", "responseHeaders"]`), `webNavigation.onCreatedNavigationTarget` (`tie`) and,
non-blocking, `webRequest.onBeforeRequest` (`onHop`), `onCompleted` and `onErrorOccurred`
(`onEnded`), `webNavigation.onCommitted` (`onCommitted`), `onHistoryStateUpdated`
(`onHistoryState`) and `downloads.onCreated` (`onDownload`).

**Whose a tab is.** `sessionOfTab` asks the session of the tab's group (`groups.sessionOf`); then
the tab's tie, or when that found none its source's judgement now; then
`groups.rememberedSessionOf(tab.groupId)`. `tie` stores in `opened`, synchronously, the new tab's
source and the promise of its tie: the source's judgement (`tieOf`), with as opener the tab in a
session's group its chain began in. When the source cannot be read or is no session's,
`tieOfGone` takes, in order, the session of the source's group as read at the event, the
source's own tie and the session remembered for that group. The group comes from `tabGroups`
(each open tab's group, -1 for none, from `tabs.onCreated`, `tabs.onUpdated` as
`changeInfo.groupId ?? tab.groupId ?? -1`, -1 at `tabs.onDetached`, and the start-up query for
tabs not seen yet) or, for a closed tab, `goneTabs` (every tab closed in the last `HOP_GRACE_MS`,
2,000 ms, and the last `MAX_GONE_TABS`, 200). `opened` has no cap and loses a tab at
`tabs.onRemoved`.

**Remembered groups.** `addToGroup` in `session-groups.ts` keeps each group it creates in
`createdGroups` and appends it to the list under `SESSION_GROUPS_KEY` (`"sessionGroups"`,
`settings.ts`) in `storage.local`; `ensureGroup` resolves once that append is done, and `forget`
removes nothing from either. A failed read skips the write; a stored value of another shape counts
as empty. Past `MAX_REMEMBERED_GROUPS` (200) the oldest groups with no tab in one `tabs.query({})`
are dropped, none when it fails. `rememberedSessionOf` answers from memory, else from the stored
list; `sessionOf`, `isSessionGroup` and `groupOf`, which decide the agent's reach, never see a
remembered group.

**What a session allows.** `allows`, used by every layer, reads the site view anew
(`access.view`) and passes what it allows, or a site in the session's `endedSites` entry that the
view does not block. A view that throws, as for a stopped session, refuses. `endedSites` holds in
memory, per ended session, the sites it was allowed for itself: `keepEnded` adds them on
`onWithdraw` with the `WithdrawCause` `"end"` and drops one on `"forget"` or `"stop"`, `dropEnded`
drops a session that runs again, and past `MAX_REMEMBERED_GROUPS` ended sessions the oldest goes.

**Header layer.** `onHeaders` answers `undefined` at once for a request of no tab (`tabId` below
0, as the `download` tool's are), an address that is not `http:` or `https:`, status 204, 205 or
304 (`NO_CONTENT`; Firefox reports a cached answer in an event of its own), 301, 302, 303, 307 or
308 with a `Location` (`REDIRECTS`; 300 and other 3xx are judged), and a page (`isPage`): no
`Content-Disposition` or one of the type `inline` (RFC 6266 section 4.2 treats an unknown type as
`attachment`), and one `Content-Type`, with no comma, of a type in `PAGE_TYPES` (`text/html`,
`application/xhtml+xml`). `tokenOf` strips only spaces and tabs and lowercases only A to Z, so a
token Firefox reads as something else does not pass. Anything else is a file: `judge` looks the
tab up (`judgedSession`: `tabs.get`, then `sessionOfTab`), cancels when that fails, passes a tab
of no session or an address `allows` passes, and otherwise records a refusal and answers
`{ cancel: true }`.

**Load layer.** `onHop` keeps each `http(s)` page or frame load (a hop) until its headers come,
`HOP_AGE_MS` (600,000 ms), or `HOP_GRACE_MS` after its tab closed or was found no session's; an
end or a commit leaves it `HOP_GRACE_MS` more. Past `MAX_TAB_HOPS` (200) a tab keeps no more and
gets a flood mark until `HOP_AGE_MS` after the last. `onDownload` matches a download Foxleash did
not start (`byExtensionId` is not `browser.runtime.id`) from an `http(s)` address with the hops
of its address begun by its start, newest first: a hop of a session that does not allow it, or
of a tab that could not be looked up, refuses it; else a flood mark of such a session does. With no
refusal the newest allowed hop is used up; a hop that refused is not. A download that matched
nothing waits `HOP_GRACE_MS`.

**Built-file layer.** The navigation listeners keep, per tab, the site of each `http(s)` or
`blob:` document its frames showed, for `DOCUMENT_AGE_MS` (60,000 ms), at most `MAX_TAB_SITES`
(200), past which a document flood mark is set and nothing evicted. `judgeBuilt` takes any other
download: a Blob's site is its origin's (`blob:null/` matches every site), any other file's its
referrer's, which Firefox does not give, so a `data:` file has none and passes. It is matched with
a kept document of its site, a frame of it shown now (`byFrames`), or a document flood mark, in a
tab whose session does not allow the site or cannot be looked up.

**Refusing a download.** `refuse` calls `downloads.cancel`, `downloads.search` and, for a
complete item, `downloads.removeFile`; a file not gone is logged (`file_guard_download_kept`).
Once it is gone, a match by a hop, a kept document or a shown frame is recorded for its tab and
frame; a flood mark's, a site-less Blob's and one by a document that a later top page of another
site replaced before the file began are not. A download a hop refused stays in
`refusedDownloads` for `HOP_GRACE_MS`, and `tell` records it for each load of its address begun
before it and heard after it whose own verdict refuses, once per tab and frame.

**Results.** `refused` records the site (`redactedUrl`) for the tab and its tie's opener, each step
in an `attempt` of its own so nothing turns a cancel into a pass, and tells `onRefused` listeners
the tab's id, never the opener's, so a window's refusal never fails its opener's load wait. A tab
keeps its newest `MAX_REFUSALS` (20) until it closes, for at most `MAX_REFUSAL_TABS` (100) tabs.
`waitForLoad` (`wait-for-load.ts`) fails at once with `file_refused` on a refusal in its tab's top
frame, also after its page committed; `handlers.ts` passes the guard to every load wait, and
`tab_open` removes its tab. `act-settle.ts` awaits `settled()` and lists `refusedFiles` (`ActAfter`)
from `refusedSince`.

**Uploads.** `readOpened` in `apps/server/src/upload-policy.ts` refuses a file whose newest of
`mtimeMs` (unless ahead of the clock), `ctimeMs` and `birthtimeMs` is under `FRESH_FILE_MS` (5,000
ms) old.

## Alternatives rejected

- **A listener at the top level.** Firefox wakes a suspended background for such a listener and
  holds the request meanwhile, 34 to 280 ms in 0071's M13; a browser where no agent session has
  run would pay that, and an update or reload still leaves a moment before it exists.
- **Adding the listener only after the background's start, so Firefox never records it.** It
  lengthens the time after each start in which nothing is judged.
- **Removing the listener when no session runs, judging only running sessions, or ending a
  group's guard when its session ends.** The group and its pages stay, and a page that tries again
  on a timer would get its file saved.
- **Following redirects in the click check.** It misses a script's navigation, and needs a request.
- **Cancelling and erasing through `downloads.onCreated` as the only layer.** No tab id, and by
  then the request was made and the file has started.
- **`upload_file` refusing files Firefox's download records trace to such a site.** The program
  would ask the extension, and an agent reading files with its own tools is not covered.
- **`upload_file` refusing every file that appeared in the download folder during a session.** It
  stops uploads of files the user just downloaded.
- **A list of the types Firefox shows.** It depends on the user's settings, and such a tab reaches
  the agent as its site only either way.
- **Judging a 304 by its own headers.** It cancels revalidated pages.
- **`object` among the types.** It saved nothing in eight shapes, and cancelling would blank
  embedded PDFs and SVGs.
- **A load wait that ignores a refusal once its page committed.** A page moving on to such a file
  by itself would answer as if nothing happened.
- **`openerTabId` for a window.** The window's tab never had one.
- **Holding a young tab's file for a late tie.** The event never came late, and it delays the
  user's files.
- **Making tied windows or remembered groups the agent's to reach.** ADR 0027 keeps the agent to
  its current group.
- **Stopping non-page answers in every tab while a session runs.** It stops the user's downloads.
- **Tying only windows a page opened.** The event does not say who opened it.
- **A cap on ties, or a closed tab's group kept for `HOP_GRACE_MS` only.** Dropping one stops
  guarding its tab, and how late Firefox reports a `noopener` window is not measured.
- **Failing closed when the opener is gone.** It stops the user's download pop-ups.
- **The network log's map of tab groups.** It would change the network log (ADR 0085), and it
  forgets a tab at `tabs.onRemoved`, before a late tie reads it.
- **`sessions.setTabValue`, or a group's title and colour.** The first needs a new permission and
  misses tabs moved in later; the user can make an orange group named Foxleash.
- **`storage.session`, or the ended sites in storage.** Firefox clears the first at a restart; the
  second outlives the browser session "Allow this session" meant.
- **A `Content-Security-Policy: sandbox` header.** It changes responses, and a worker's has none.
- **Cancelling the worker's own fetch.** It covers only a passed-on fetch and blocks every fetch.
- **Matching downloads by site and time alone outside a flood.** It cancels the user's downloads
  while an agent's tab shows the site.
- **Narrowing a flood mark by referrer.** The page chooses whether to send one.
- **Dropping the oldest hop at the cap.** The page pushes its real load out.
- **A blocking `onBeforeRequest` for a flooding tab.** A third blocking listener on every load.
- **Ending a hop on `webNavigation.onCompleted`.** It fires also for a load that became a download.
- **Matching built files by referrer address.** Firefox gives them none.
- **Documents per address.** A search-as-you-type page would set the flood mark.
- **`blob:null` as a named limit.** One `sandbox` attribute would bypass the layer.
- **Refusing every site-less file, `data:` included.** It cancels the approved page's own exports.
- **A time bound on a frame shown now.** A page saving later would pass.
- **Leaving ended sessions' tabs out of the built-file layer.** They could build any site's Blob.
- **Telling an end from `access.running(session)`.** A `forget` on an idle session would look like
  one and keep a site the user withdrew.
- **Specs waiting `HOP_GRACE_MS`, or telling every matching load.** The first hides a case agents
  meet; the second adds refusals to other tabs' results.
- **Holding the cancel for the download's own load.** Firefox writes the file meanwhile.
- **Marking a late load before its verdict.** A concurrent path skips, and nothing is recorded.
- **Keeping a page load until its commit, for a self-saved address.** A page can wait longer.

## Consequences

- The request still reaches the other site, with the cookies Firefox sends for it, except a
  redirect hop to a blocklisted site in the loads that
  [ADR 0101](0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md) covers.
- A PDF, an image, text or another non-HTML page from such a site is no longer shown in the group's
  tabs; one a worker gives creates no download and is still shown.
- A stopped session's tabs cancel every such file, also from approved sites. After a restart,
  update or reload, ties and the stopped state are gone: windows opened before are not judged, and
  a stopped session is judged by the sites allowed always.
- An ended session's tabs pass files of its own sites until the background restarts, then of the
  sites allowed always only; the oldest of over 200 ended sessions falls back early, also with its
  tab open. Its sites are no longer on the settings page, and a Forget on one opened before the end
  drops nothing; the blocklist, closing the tab or moving it out ends it.
- Tabs outside every group, not tied and not remembered, are not guarded by the header layer.
  Moving a tab out of the group ends its guard unless tied.
- A tied window stays out of the agent's reach, and is guarded until it closes. A window the user
  opens from a session's tab is tied too, possibly not for its first load: the user's own
  downloads there from sites the session may not act on are stopped until it closes, and a refusal
  there during an act in the opener is in that act's `refusedFiles`. One from a tab dragged out
  of the group during the lookup is tied to the group it left. Not tied: a window that no tab's
  page opens, one from a tab whose group was never seen, and one reported over 2 seconds after its
  source closed, past 200 other closes. The tab that opened a tab later moved into the group can
  still navigate `window.opener`.
- A cancelled pop-up tab stays open, blank.
- A refusal outside an act's or a load's wait is in no result, and an act can miss a download
  refusal: in a tab Firefox closed, or one after the act settled. A flood mark's, a `blob:null`
  file's, a kept file's and one matched by a document a later top page of another site replaced
  are never listed. A load heard before the download is told only when it refused itself; a late
  load whose verdict came after another's refusal still times out; a load that became a page can
  get `file_refused`.
- The second and built-file layers act after the fact: the file exists for a moment, readable by a
  program that watches the folder, the agent's own tools, or an older Foxleash's `upload_file`.
  `upload_file` refuses once a file written in the last 5 seconds, so a `batch` that downloads and
  uploads meets that. The cancelled download stays in Firefox's list.
- False positives: a user's download of an address a session tab began loading in the last
  `HOP_AGE_MS` from a site it may not act on, unanswered; during a load flood, every download from
  such sites, any tab; a user's Blob file from a site a group tab shows or showed in the last 60
  seconds; a `blob:null` file while a group tab shows such a site or showed one in the last 60
  seconds; during a document flood, every Blob file from such sites.
- Still saved: a `data:` file; a page that saves its own address, which the header layer passes
  as a page; a download at no hop's address, as from a worker's built redirect; a worker answering
  after `HOP_AGE_MS`; a file removed after over 5 seconds; a file saved over 60 seconds after its
  page's last address change from a frame or window gone right then.
- From the first session, or from the start with a remembered group's tab, every page and frame
  load passes the blocking listener: at once for a page, measured at 0 to 6.5 ms more per page
  load (medians); a file waits for a `tabs.get`, a tied tab's tie (one `tabs.get` per opener,
  started when Firefox reported the tab) and a settings read.
- Between Firefox's start, or an update or reload, and the listener, nothing is judged, and a
  window opened from a remembered group's tab then gets no tie, since Firefox does not prime
  `onCreatedNavigationTarget` at a start, and is not judged until it closes. Firefox can record
  the listener for the next start, holding page loads until the background starts, the hold
  rejected above at each wake-up; loads in a remembered group are then judged, or let go unjudged.
- The background was not seen suspended; a measurement of that would reopen the idle question.
- Remembered groups: past 200 without a tab, the oldest go, so a saved group reopened later is not
  judged; an agent can cause that. Groups made before the list was stored are not judged. While the
  list cannot be read, old groups' tabs are no session's. A group id of Firefox's fallback shape,
  counted per browser run, could name another group after a restart: more stopping, never more
  reach.
- Memory: one entry per tied tab, one number per open tab, the last 200 closed tabs and every one
  closed in the last 2 seconds, one site set per ended session up to 200; one storage read and
  write per group created.
