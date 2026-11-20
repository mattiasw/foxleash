# File guard

Measurements behind [ADR 0081](../adr/0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md).

In every section, A is a site the session is approved for and B a site the session may not act
on (not approved for the session, or on the blocklist). "Saved" means that Firefox wrote the file
into the download folder and it stayed there.

## Three ways a page got a file of another site saved, before the guard (2026-11-18)

Measured in Firefox 160.0.1, headless,
with A on `127.0.0.1` and B on `localhost`, three ways, the tab staying on A's page in each:

1. A `click` on a same-site link whose answer redirects to B's file. The result said
   `"page": "unchanged"` and nothing about a file; the file was saved.
2. `navigate` to that same-site address. It failed after 30,013 ms with "did not load a page from
   that URL within 30 seconds", and the file was saved.
3. No act at all: A's own script set `location.href` to B's file after `tab_open` of A.

## Loads in a session tab that end in a file, without and with a cancel (2026-11-18)

In headless Firefox through the end-to-end harness, with a probe add-on that logged every
`webRequest`, `webNavigation`, `tabs` and `downloads` event and, in a second phase, cancelled from
a blocking `onHeadersReceived` that answered with a Promise. On Firefox 160.0.1, and on
153.7.0esr where a row or an item says "both versions".

Without a cancel:

| Load in a session tab | `type` Firefox reports | Saved? | Cookies B got |
|---|---|---|---|
| click on A's link, 302 to B's attachment | `main_frame` | yes | Lax (not Strict) |
| `navigate` or `tab_open` to A's address, 302 to B's attachment | `main_frame` | yes, the call fails after 30 s | Lax and Strict |
| `navigate` reload of A's page whose second load redirects to B's attachment | `main_frame` | yes, the call answers in 67 ms with the tab and no error | Lax and Strict |
| A's script sets `location.href` to B's attachment | `main_frame` | yes | Lax |
| the same, B answers `text/csv` with no `Content-Disposition` | `main_frame` | yes, as `export.csv` | Lax |
| the same, B answers two `Content-Type` headers, `text/html` then `text/csv` | `main_frame`; the listener gets one entry, `text/html,text/csv` | yes, as `exportx.csv` (both versions) | Lax |
| the same, `text/csv` then `text/html` | `main_frame`, one entry `text/csv,text/html` | no: shown as a page | Lax |
| `<iframe>` on A to B's attachment, directly or through A's redirect | `sub_frame` | yes | none |
| `<object>` or `<embed>` on A to B: a CSV attachment directly and through A's redirect, a CSV without disposition, `application/octet-stream` with and without disposition, `application/zip` | `object`, `frameId` 0 | no, in all eight shapes (the last six on both versions) | none |
| `<a download>` on A, 302 to B's attachment | `main_frame` | yes | Lax |
| `<a download>` on A, 302 to B's HTML page; a script-clicked `<a download>` straight to B's HTML page | `main_frame` | no: the tab goes to B's page, which reaches the agent as its site only | Lax |
| `target=_blank` link or `window.open(url)` with pop-ups allowed for A | `main_frame` in the new tab, which has the session's `groupId` from `tabs.onCreated` on (both versions) | yes; Firefox then closes the blank tab | Lax |
| `window.open(url, "_blank", "popup,...")` with pop-ups allowed for A | `main_frame` in a new window whose tab has `groupId` -1 and no `openerTabId` (both versions) | yes | Lax |
| B's attachment taken from Firefox's cache | `main_frame`, `fromCache: true`, status 200, the cached headers | yes | (no request) |
| B's attachment revalidated | two events: status 304 with no entity headers, then status 200 with `fromCache: true` and the cached headers | yes | Lax |
| 302, 300 or 305 from B with attachment headers and no, an empty, an unparseable, an unknown-scheme or a `data:` `Location` | `main_frame` | no (none of the seven variants) | Lax |
| 204 or 205 from B with attachment headers | `main_frame` | no, and no navigation (both versions) | Lax |
| an unsolicited 304, and 300, 306 and 399 with a valid `Location`, all with attachment headers | `main_frame` | no; Firefox does not follow the 300, and opens a new tab in the group on its error page for B's address (both versions) | Lax |
| B's attachment answered by B's service worker (`fetch(event.request)`, or a `Response` it builds) | `onBeforeRequest` `main_frame` with the tab id, `onBeforeRedirect` with `statusCode` 0 and `redirectUrl` equal to the URL, then no `onHeadersReceived` for the tab's request; the worker's own fetch is `xmlhttprequest` with `tabId` -1 | yes | Lax |
| B's HTML page, reached by A's redirect or shown in a frame on A, builds a Blob and clicks `a[download]` on load | no request for the file | yes | n/a |

`downloads.onCreated` gives `url`, `filename`, `referrer` (A's page) and `state: "in_progress"`,
and no tab id.

With the cancel (`{ cancel: true }` from a Promise in a blocking `onHeadersReceived`):

- Nothing was saved in any of: the click, `navigate`, `tab_open`, the reload, the script's
  navigation, both frame cases, `<a download>`, `text/csv` without disposition, the two
  `Content-Type` headers, the pop-up tabs, the cached response (cancelled on its status 200
  `fromCache` event) and the revalidated response (the 304 let through, cancelled on the status
  200 `fromCache` event). The same on 153.7.0esr for the cases run there: the click, the script's
  navigation, the frame, the pop-up tabs, the cached and the revalidated response and the two
  `Content-Type` headers.
- The tab keeps its page: its elements are still there, and `tabs_list` shows A's address. Firefox
  shows no error page. The events are `webRequest.onErrorOccurred` with `NS_ERROR_ABORT`,
  `webNavigation.onErrorOccurred` for B's address and `tabs.onUpdated` with `status: "complete"`.
- `navigate` and `tab_open` still waited out their 30 s, and a reload still answered with the tab
  and no error: nothing told them.
- A pop-up tab whose load was cancelled stays open on `about:blank` in the session's group.
  Firefox closes it only when a download starts.
- A revalidated HTML page on B still loads when its 304 is let through. That 304 carries no
  `Content-Type`, so a guard that judged it by its headers would cancel the page.
- The service-worker cases, the Blob case and the pop-up window were still saved: there is no
  response to cancel, or no session to judge it by.
- When A's own service worker answers a load with a redirect to B's attachment (a
  `Response.redirect`, or the server's own 302 passed on with `fetch(event.request)`), the
  redirected request reaches the listener, here the file guard of ADR 0081, with the
  tab's id as `main_frame` (`sub_frame` in a frame) and is cancelled. Nothing was saved in the
  five cases: a click, a script's navigation and a frame with `Response.redirect`, and a click
  and a script's navigation with the passed-on 302 (both versions). So the service-worker limit
  needs a worker on B.
- A tab outside any group was untouched: its file was saved.

Not measured: `<object>` with `application/pdf` while Firefox's PDF viewer is switched off, and
whether Firefox suspends the background while a session runs.

## When Firefox reports a window that a page opens (2026-11-18)

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

## Session groups across a restart, an update or a reload (2026-11-18)

In headless Firefox 160.0.1 and 153.7.0esr through the end-to-end harness, with the built
extension and a probe add-on that only logged. Restarts are the harness's
`restartFirefox(..., { restoreSession: true })`, which installs the add-on again as a temporary
add-on.

**Before groups were remembered.** With the code before the guard remembered session groups, a
probe showed the gap: after a reload and after a restart, the old group's tab sent to the other
site's attachment got it saved.

**The group id (H3).** A session tab's `groupId`, read with `browser.tabs.query({})` in the
settings page, was the same number before and after `browser.runtime.reload()`, and after each of
three restarts (on 160.0.1 the tab's id changed from 7 to 1, its `groupId` did not). A group the
user saves and closes and opens again, done with `group.saveAndClose()` and
`SessionStore.openSavedTabGroup(id, window)` in a privileged script, came back with the same
`groupId` and a new tab id (4 to 6 in the separate run, on both versions; `saveAndClose()` is
synchronous on 153 and returns a promise on 160). Firefox's internal group id was of the shape
`"1795019160877-40"`, and the number the extension API gives is that id's millisecond timestamp
times 1000 plus its suffix (`getExtTabGroupIdForInternalTabGroupId` in Firefox's `ext-browser.js`).
An internal id of another shape gets a small number counted from 1 per browser run instead, which
would not be stable; every group measured had the timestamp shape.

**Storage (H4).** A `storage.local` key survived `runtime.reload()` and the harness restart with no
pref set, on both versions; it also survived with `extensions.webextensions.keepStorageOnUninstall`
set, and with that and `extensions.webextensions.keepUuidOnUninstall`, so neither pref is needed.

**Idle suspension (H11, runs 1 and 2).** A session ended with its group's tab left on the approved
site's page; Firefox's background state (`WebExtensionPolicy.getByID(id).extension.backgroundState`)
was read every 9 seconds. With the native port connected (run 1), and with the native host killed
and its manifest removed so that every reconnect, at most every 10 seconds, failed (run 2), the
background was `running` throughout 63 seconds on both versions; the page's own 60-second timer
then loaded the other site's attachment, and nothing was saved. Firefox's `ext-backgroundPage.js`
exempts a background with an open native messaging port from the idle timeout; in run 2 it stayed
running all the same.

**A listener added during a request (H13).** A blocking `onHeadersReceived` listener added 1,002
to 1,006 ms into a request whose answer came at about 3,000 ms saw that response at 3,002 to 3,003
ms and cancelled it, nothing saved, in 4 of 4 runs on each version; 2 control runs per version with
the listener added before the request gave the same.

**The listener's cost (H11, run 3).** In one Firefox, each step waited 45 seconds with no session
running, then made 20 loads, one after another, of a small HTML page of the approved site in a tab
outside every group, each timed by the page's Navigation Timing `duration`. The background was
`running` before and after every wait. Medians in ms, minimum to maximum in brackets:

| Step, in order | 160.0.1 | 153.7.0esr |
|---|---|---|
| 1. no listener, before any session | 12 (8 to 19) | 12 (9 to 17) |
| 2. the guard's listener, after a session ran and ended | 34 (30 to 36) | 27 (25 to 33) |
| 3. no listener, after `runtime.reload()` | 27.5 (25 to 39) | 27 (25 to 35) |
| 4. as 3, plus another add-on's blocking listener that answers at once, with the guard's filter | 32 (28 to 45) | 29 (26 to 42) |

Against the step right after it, without it, the guard's listener added 6.5 ms on 160.0.1 and none
on 153.7.0esr; a bare blocking listener added 4.5 and 2 ms. Every step after the first was about
15 ms slower whatever listener was there, also once the reload had removed the guard's; that began
after the probe add-on was installed, and its cause was not looked for. A second full run on
160.0.1 repeated the results above.

**Firefox's record of the listener.** With the guard that remembers groups built, a privileged script read
`ExtensionParent.GlobalManager.getExtension(id).persistentListeners` and the add-on's
`startupData.persistentListeners`, the listeners Firefox records for the background's next start:

| State | 160.0.1 | 153.7.0esr |
|---|---|---|
| A fresh start | not recorded | not recorded |
| After a session ran and ended (the listener added at its first request) | not recorded | not recorded |
| After `runtime.reload()` with the old group's tab open (added at the background's start) | not recorded | not recorded |
| After a restart, the tab restored (added at the background's start) | recorded | not recorded |
| After a second restart | not recorded | not recorded |

Recorded means both held the guard's blocking `webRequest.onHeadersReceived` listener (`types:
["main_frame", "sub_frame"]`, `urls: ["<all_urls>"]`, `["blocking", "responseHeaders"]`) and its
`webNavigation.onCreatedNavigationTarget` listener. The harness installs the add-on again after
Firefox has started, so it cannot show what Firefox does with a record at its own start. Read in
Firefox 160's source: `ExtensionCommon.sys.mjs` records a listener added while the background
context's `listenerPromises` is set, which `ext-backgroundPage.js` clears once the listeners added
during the script's start have been handled. At the background's next start Firefox primes the
recorded listeners of the modules `ext-toolkit.json` marks `startupBlocking`, which `webRequest` is
and `webNavigation` is not, so the requests a primed `webRequest` listener matches wait until the
background has started. A listener added again during that start gets them; for one that is not,
`clearPrimedListeners` rejects them, `WebRequest.sys.mjs` lets a request go on past a listener
whose answer rejects, and the record is dropped.

## A service worker's answer, the download it becomes, and removing its file (2026-11-18)

With a probe add-on that only logged, installed beside the built extension in the end-to-end
harness, on Firefox 160.0.1 and 153.7.0esr, headless. A was `http://127.0.0.1:<port>`, approved;
B was `http://localhost:<port>`, with a service worker that passed a request on with
`fetch(event.request)` ("pass"), answered with a `Response` it built ("built"), or answered with a
`fetch()` of another address of B ("other"). Each way once per version; a pair `release / ESR`
gives each version's number, every other number holds for both.

| Way | pass | built | other | The load's events after `onBeforeRequest` |
|---|---|---|---|---|
| A's script sets `location.href` | saved, matched | saved, matched | saved, matched | `onBeforeRedirect` status 0, same URL; `webNavigation.onCompleted` at the load's URL |
| `click` on A's link that redirects to B | saved, matched | saved, matched | saved, matched | `onBeforeRedirect` 0 only |
| `navigate` to that link's address | saved, matched (the call took 30 s) | saved, matched | saved, matched | `onBeforeRedirect` 0 only |
| frame on A, with B's worker registered in A's partition | saved, matched | saved, matched | saved, matched | `onBeforeRedirect` 0; `webNavigation.onCompleted` |
| frame on A, with no worker of B in A's partition | not saved: the load went to the network, and ADR 0081's listener cancelled it on its `onHeadersReceived` 200 | | | |
| a tab A opens (`target="_blank"`) | saved, matched | saved, matched | saved, matched | `onBeforeRedirect` 0 only; Firefox closed the new tab 8 to 10 ms after `downloads.onCreated` |
| a passed-on fetch answered from Firefox's cache, by script and by click | saved, matched | | | as above |
| the worker answers with an HTML page (script, frame) | no download | | | `onBeforeRedirect` 0; `webNavigation.onCommitted` at the load's URL |

"Matched": the download's `url` equalled the URL of a `main_frame` or `sub_frame` load of that
tab, also for "other" (it names the request's address, not the one the worker fetched), and its
`startTime` was 4 to 32 ms after that load's `timeStamp` (524 ms for a slow 20 MB answer, whose
download starts with its first bytes). A load that ended in a download got none of
`webRequest.onCompleted`, `webRequest.onErrorOccurred` and `webNavigation.onCommitted`; one that
ended in a page the worker served got `webNavigation.onCommitted`. `webNavigation.onCompleted`
fired at the load's address also when it ended in a download, so it is no sign of a page. The
item was `in_progress`, `exists: false`, with no `byExtensionId`, its `referrer` A's page.

Order of events: in 9 of the 44 single loads (5 / 4) the load's `onBeforeRequest` reached the
background after `downloads.onCreated`, by up to 35 ms. In the retry runs below it came later in
45 to 88 percent of the downloads, by up to 288 / 250 ms, and by up to 445 ms with the probe
holding its own download handler back. Once in six runs of the "tab A opens" way the tab's
`tabs.onRemoved` reached the background before the tab's own load, and once per version the
commit of a page the worker served in a frame came up to 6 ms before its load.

Foxleash's own `download` tool: its item has `byExtensionId` equal to `browser.runtime.id` and a
`blob:moz-extension://` address.

A worker that never settles its `respondWith`: alone, Firefox sent the tab's request to the
network itself after 60.0 / 60.2 s. While a page of B posted the worker a message every second, no
end within 600 s on either version.

A prototype of the refusal (in `downloads.onCreated`: match the load, `cancel`, `search`, then
`removeFile` when complete or existing), with a separate process listing the download folder
every millisecond:

| Answer | release: state at the refusal; longest a file or `.part` file existed | ESR |
|---|---|---|
| 26 B | in progress, cancelled; 16 ms | in progress, cancelled; 26 ms |
| 1 MB | in progress, cancelled; 23 ms | complete (the download event came first), removed; 47 ms |
| 20 MB over 10 s | in progress, cancelled; 25 ms | in progress, cancelled; 19 ms |

No file stayed in any run. A page of A that set `location.href` to B's built answer every 30 ms
for 60 s:

| Run (release / ESR) | downloads | longest a file existed | lists that found a file | of 50 upload checks: found a file / would hand it over with the age check |
|---|---|---|---|---|
| natural order | 1887 / 1732 | 126 / 91 ms | 28.8 / 36.0 % | 5 / 10, 0 / 0 |
| the download handler held 100 ms (the load first) | 1696 / 1418 | 272 / 473 ms | 93.8 / 93.4 % | 50 / 50, 0 / 0 |
| the load handler held 100 ms (the download first) | 1313 / 1048 | 166 / 249 ms | 36.7 / 37.1 % | 9 / 11, 0 / 0 |

From `downloads.onCreated` to the file gone: median 12 to 29 ms, at most 376 ms. The upload checks
opened the file, read its times with `fstat` and refused it when the newest of mtime, ctime and
birthtime was less than 5 s old; every file they found was at most 168 ms old. `cancel` of a
complete download rejects with `Download N is already complete`, and a `search` right after
`removeFile` resolved still said `exists: true` while the folder no longer held the file.

With the second layer built, in the same harness, 20 runs of each act per version:

| Act | the result's `refusedFiles` listed B (release / ESR) | files saved |
|---|---|---|
| `click` on A's link to B's address that the worker passes on | 19 / 20 | 0 / 0 |
| `click` on A's link to B's address that the worker answers with a `Response` it built | 17 / 18 | 0 / 0 |

Each miss was an act that settled as "page unchanged" 129 to 237 ms after the click, before the
download was created; the clicks took 135 ms (median). In the end-to-end tests on the release, a
click on a link that opens B's address in a new tab saved nothing and listed nothing, for both
answers: the new tab joins the session's group, so the refusal is recorded for that tab alone, and
Firefox has closed it by the time the act lists the group's tabs. In those tests the longest a
file was in the download folder was 5 to 14 ms, per worker way. A page that loaded B's built answer
again and again, with 50 `upload_file` calls over 60 s: 13 calls found a file in the folder, 14
were refused for the file's age and the others because it was gone or changed while read; a file
was there for at most 70 ms, and 21.1 % of the folder's listings held one.

## Files a page builds itself (2026-11-19)

With a probe add-on that only logged and ran the second layer's refuse step, installed beside the
built extension in the end-to-end harness, on Firefox 160.0.1 and 153.7.0esr, headless. A was
`http://127.0.0.1:<port>`, approved; B was `http://localhost:<port>`. B's page, on its load, built
`new Blob([...], { type: "text/csv" })` or a `data:text/csv` address and clicked an `a[download]`;
reached in the top frame by `navigate` to A's address that answers 302 to it, or shown in an
`<iframe>` that A's page added.

Twenty shapes per version, identical on both: Blob and `data:`, top frame and frame, with B's
default referrer policy, `Referrer-Policy: origin` and `no-referrer`; `history.replaceState` before
the save; the frame removed 0, 5 and 50 ms after its `load` event.

| Field | Value |
|---|---|
| `item.referrer` | undefined in all 40 downloads (the key present, the value undefined), whatever B's referrer policy |
| `item.url` | Blob: `blob:http://localhost:<port>/<uuid>`, whose origin is B's; `data:`: the whole `data:text/csv;charset=utf-8,...` address |
| `item.mime`, `item.state` | `text/csv`, `in_progress` |
| `item.startTime` | 19 to 44 ms after the `timeStamp` of B's document's `webNavigation.onCommitted`; the commit reached the background first in every shape |
| B's frame in `getAllFrames` when the handler ran, 14 to 41 ms after `startTime` | listed in every shape except "removed 5 ms after its load", which removed it 11 to 25 ms after the load; listed at 50 ms |
| Frame removed 0 ms after its load | no download at all, Blob and `data:` |
| `history.replaceState` | `onHistoryStateUpdated` with the new address before the download, top frame and frame |
| The refuse step | the download was already `complete` at the search, so `cancel` rejected and `removeFile` resolved; 2 to 11 ms; no file left |

A page with no origin of its own (both versions, identical): B's page in
`<iframe sandbox="allow-scripts allow-downloads">` on A, and B's page in a window that a sandboxed
`srcdoc` frame of A opened (`allow-scripts allow-popups allow-downloads`, pop-ups allowed for A;
the window is top level, its `self.origin` is `"null"`), save the Blob as `blob:null/<uuid>`, with
no referrer. `webNavigation` gives B's address for that frame or window.

A page's own `blob:` document, and a page opened from a local file (2026-11-19, both versions,
identical): when B's page opens a `blob:` HTML document it built, in a frame or in the top frame,
`webNavigation.onCommitted` reports that frame's address as `blob:http://localhost:<port>/<uuid>`,
`getAllFrames` lists the frame with that address, and the Blob that document saves is
`blob:http://localhost:<port>/<uuid>`, whose origin is B's. A page opened from a local file
(`file:///...`) saves its Blob as `blob:null/<uuid>`, with no referrer.

A page that saved a new file every 30 ms for 64 s (about 2,118 downloads), with 50 `upload_file`
calls spread over 60 s on A's page, the probe refusing every built file, two runs per version, in
the top frame and in a frame, Blob and `data:`: no file stayed after the refuse step and no call
handed B's content to A's page, in any shape. From `downloads.onCreated` to the file gone, with the
probe logging little: median 12 to 19 ms and at most 27 to 84 ms for a Blob on both versions, and
at most 160 ms for a `data:` file. On the ESR, after about 6,400 earlier downloads in Firefox's
list: median 232 ms, at most 2,417 ms, and no call found a file 5 s old. In a run whose probe
logged several requests per download, the ESR took up to about 9 s at that backlog; no call handed
anything over there either.

## A later load of the address of a refused download (2026-11-19)

Seen in the end-to-end specs, headless, on both pinned Firefox versions, with the guard as it was
before its 2026-11-19 amendment, which reports such a refusal to a load heard after it.
"Refused" means that the second layer cancelled the download and removed its file.

The second layer of ADR 0081 judges a download, at its `downloads.onCreated`, against the kept loads
(hops) of its address, and records a refusal only for the tab and frame of the hop that refused
it. A closed tab's hops stay matchable for `HOP_GRACE_MS` (2 s), and a hop that refused a download
is not used up.

An agent can click a link to an address that the service worker of a site the session may not act
on answers with a file, and then, within 2 s, `navigate` or `tab_open` to the same address. When the
second load's `onBeforeRequest` reaches the background after its download's `onCreated`, which the
measurements of 2026-11-18 above found in 9 of 44 single loads, the earlier tab's hop refuses the download first, and the
refusal is recorded for that tab alone. The tab that is waiting for its load never hears of it:
`wait-for-load.ts` listens for a refusal in its tab's top frame, the load commits no document, and
the call fails after 30 s as a timeout instead of at once with the file refused. The end-to-end
specs for this case timed out intermittently on both pinned Firefox versions; nothing was saved.

The late load can arrive in two windows: while the download is still being judged (the earlier
hop's verdict resolves first, and the late hop's own judgement finds the download already
refused), and after the download was refused, when no judgement of it runs any more.

## A window opened by a tab that closes itself at once (2026-11-20)

On Firefox 160.0.1 and 153.7.0esr, headless, with the guard as it was before its 2026-11-20
amendment, which ties such a window by the group its opener was seen in: a page on A, in a tab
that `tab_open` opened, ran the script below, 5 runs per version, with pop-ups allowed for A.

ADR 0081 ties a window that a page in a session's tab opens to the session through
`webNavigation.onCreatedNavigationTarget`: the guard looks the source tab up with `tabs.get` and
judges the window as the source's session. A page on an approved site, in a tab that `tab_open`
opened, can open a window on a file of another site and close its own tab in the same task:

```js
addEventListener("load", () => { window.open("<B>/export", "_blank", "popup,width=400,height=300"); window.close(); })
```

A tab with one entry in its history may be closed by its own script, and pop-ups must be allowed
for the approved site. Measured on Firefox 160.0.1 and 153.7.0esr headless: Firefox saved B's
file, fetched with the cookies it sends B, in 5 of 5 runs on each. By the time the guard looks
the source up, Firefox has forgotten the tab, so `tabs.get` fails, and the guard kept no record of
the group the tab was in; its only fallback was the source's own tie, which a tab in a group,
not opened from another tab, does not have. A chain of windows whose middle tab closes saved 0 of
5: that fallback held, which also shows the event arrives with a valid `sourceTabId` before the
source's removal is processed.

## A site an ended session was allowed for (2026-11-20)

Seen with the guard as it was before its 2026-11-20 amendment, which keeps an ended session's own
sites for files. No Firefox version or harness was recorded for it; the one timing is about 10 ms.
"Cancelled" means that the guard cancelled the download and removed its file.

The user allows a site (B) for one agent session only ("Allow this session"). The session ends,
as when the agent's program exits, and one of its tabs stays open in the session's tab group,
showing a page of B. `endSession` in `apps/extension/src/site-access.ts` deletes the session's
answers, so `view(session)` then allows only the sites stored as allowed always. The file guard
keeps judging the tabs left in the group as that session's (`groups.rememberedSessionOf` in
`sessionOfTab`, ADR 0081), and asked `view(session).allowed(url)` in the header layer (`judge`),
the hop layer (`verdictOf`) and `allows`, which the built-file layer and the flood marks
use. So B, which the user's click allowed for that session, became a site the session may not act
on:

1. `byFrames` queries every open tab with no time bound, found the left-over tab showing B, and
   cancelled every Blob file of B in any tab, including the user's own tabs outside every group,
   about 10 ms after Firefox started it and with no message, for as long as that tab stayed open.
   The usual "Export CSV" button of a site builds such a file.
2. In the left-over tab itself, a file of B loaded by address was stopped.
