# 0092: The file guard also cancels a download from a load whose headers never came, and upload_file refuses a file changed in the last 5 seconds

**Status:** Accepted, 2026-11-18. Amends
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md): its consequence
on an answer that the other site's own service worker gives, and its rejected alternative
"Cancelling and erasing through `downloads.onCreated`" (rejected as the only layer, accepted as
the second).

## Context

ADR 0081's file guard judges only response headers, in a blocking `onHeadersReceived`. When the
service worker of a site the session may not act on (B) answers a page or frame load in a tab of
the session (with `fetch(event.request)`, or with a `Response` it builds), Firefox reports
`onBeforeRequest` for the tab's request, then `onBeforeRedirect` with status 0 and the same URL,
and never `onHeadersReceived`. Nothing is judged, and Firefox saves the file, requested with B's
Lax cookies, into the download folder, which is an upload folder by default. A page on an
approved site (A) could then get it handed over by `upload_file`.

What Firefox does give is `downloads.onCreated`, with the download's address and start time and
no tab id. That is after the fact: the request reached B and the file has started.

## Measurements

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

With the change built, in the same harness, 20 runs of each act per version:

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

## Decision

**A second layer, in `createFileGuard` (`apps/extension/src/file-guard.ts`).** From the first
agent session on, `listen()` also adds non-blocking listeners: `webRequest.onBeforeRequest`,
`onCompleted` and `onErrorOccurred` for `main_frame` and `sub_frame`, `webNavigation.onCommitted`
and `downloads.onCreated`. None is added at the top level.

- Each `http(s)` page or frame load of a tab (a hop) is kept, once per request id and address
  (without its fragment), with its frame and `timeStamp`, and the tab's lookup starts at once:
  one at a time per tab, shared by the hops that come meanwhile, run again when the tab is tied
  (ADR 0089) or `tabs.onUpdated` shows it in another group. A lookup is `judgedSession`; for a tab
  that is gone, the tie it had (kept `HOP_GRACE_MS` after `tabs.onRemoved`) judges it, and with no
  tie the lookup fails.
- A hop goes when the header layer hears its headers (the first line of `onHeaders`), when a
  download took it, `HOP_AGE_MS` (600 s) after its `timeStamp`, `HOP_GRACE_MS` (2 s) after its
  tab closed, and `HOP_GRACE_MS` after its tab's lookup said no session. `onCompleted`,
  `onErrorOccurred` and a commit end it, and it still matches for `HOP_GRACE_MS` after that. A
  commit ends only the newest hop of its tab, frame and address begun before it; a commit that
  finds none is kept `HOP_GRACE_MS` for a hop that arrives after it.
- At most `MAX_TAB_HOPS` (200) hops per tab. A hop over that is not kept, and the tab gets a flood
  mark from the first such hop's `timeStamp` to `HOP_AGE_MS` after the last one's, cut to
  `HOP_GRACE_MS` after the tab closes. The mark does not end when the tab falls under the cap.
- A download that Foxleash did not start (`byExtensionId` is not `browser.runtime.id`), from an
  `http(s)` address, is matched with the kept hops of every tab with its address and a
  `timeStamp`, rounded down, not after its `startTime` (an unreadable `startTime` matches every
  hop), newest first. A hop whose tab is judged as a session's refuses it when that session's view,
  read anew, does not allow the address, or cannot be read; a hop whose tab is no session's is
  looked up once more first; a hop whose lookup failed refuses it. When nothing refuses it, the
  newest hop whose site was allowed is used up, and each flood mark whose tab is a session's, or
  could not be looked up, refuses the download when that session does not allow its address; a
  flooding tab that is no session's is looked up once more first, as for a hop. A download that
  matched nothing waits `HOP_GRACE_MS` for a hop that arrives later, and for the tab of its hop or
  flood mark to become a session's.
- Refusing is decided synchronously, once per download, then: `downloads.cancel` (its
  rejection for a complete download is no failure), `downloads.search`, and `downloads.removeFile`
  when the item is complete (Firefox removes the file of no other). The file is gone once
  `removeFile` resolved, or when the item is `interrupted` and its file does not exist. Only then is a match by a hop recorded
  through `refused()`, for the hop's tab and frame and the tied tab's opener, with
  `redactedUrl(item.url)`, at `now()`; a match by a flood mark records nothing and tells no
  listener. A file that is not gone is logged (`file_guard_download_kept`, its id only) and
  reported nowhere. The download's entry stays in Firefox's list, cancelled.
- `FileGuard.settled()` resolves when the download judgements under way at the call have ended,
  and `act-settle.ts` awaits it, within its deadline, before it reads `refusedSince`.

**An age check in `upload_file`.** `readOpened` in `apps/server/src/upload-policy.ts` refuses a
file, on the descriptor it reads, whose newest of `mtimeMs`, `ctimeMs` and `birthtimeMs` is less
than `FRESH_FILE_MS` (5,000 ms) before now: "was saved or changed a moment ago; try again in a few
seconds." The clock comes in as `ReadContext.now` and `UploadContext.now`, `Date.now` by default;
no environment variable or setting moves it. The newest of three times, because a program can set
mtime back but not ctime, which any change makes now, and a file system with no birth time gives
0. An mtime ahead of the clock is left out: an unpacked archive can carry one, and the ctime of
setting it still counts. 5 s is more than ten times the longest a file existed in the measurements.

Four choices beyond the obvious rules, each closing a gap:

- A hop that `onCompleted` or `onErrorOccurred` ends stays matchable for `HOP_GRACE_MS` instead of
  going at once: the order of a hop's events and its download's is not fixed, and Firefox may
  report an error for a load whose download already began.
- A gone tab is judged by the tie it had: in the "tab A opens" way Firefox closes the tab right
  after the download starts, and its `onRemoved` can reach the background before its load. Without
  the tie, the user's own download through a `target="_blank"` link of a tab of no session would be
  cancelled whenever that race goes the other way.
- A commit ends only the newest matching hop, and leaves it matchable for `HOP_GRACE_MS`: a page
  could otherwise start a load of an address that becomes a download and a moment later a second
  load of it that the worker answers with a page, whose commit would end the first.
- A hop that refused a download is not used up: it refuses every later download of its address
  until it ends some other way or is `HOP_AGE_MS` old. Which load a download came from cannot be
  told. A window that a page of the agent's tab opens could otherwise spend the tab's load, held
  by the worker, on a download of the same address that is its own (a load past the window's cap,
  or one reported after its download), close itself, and have the held load's file saved later.

This layer is after the fact: the request reached B with its cookies, and the file exists for the
window measured above. `upload_file` refuses it for that window. A program other than Foxleash that
reads the download folder in a loop can read it, as ADR 0081 already says of the agent's own
tools, and so can `upload_file` of a Foxleash program from before the age check.

## Alternatives rejected

- **`upload_file` refusing files that Firefox's download list traces to such a site.** The program
  would have to ask the extension, and an agent that reads files with its own tools is not covered
  (ADR 0081).
- **`upload_file` refusing every file that appeared in the download folder during a session,
  unless the `download` tool saved it.** It would bound this at the upload with no race, but stop
  a user from having the agent upload a file they just downloaded themselves, which changes what
  the tool is for.
- **A `Content-Security-Policy: sandbox` header without `allow-downloads` on B's pages.** It
  changes responses, and a page a service worker serves gets no header to change.
- **Cancelling the worker's own fetch.** It covers only a passed-on fetch of the same address, and
  puts every fetch of every tab through a blocking listener.
- **Matching `http(s)` downloads by site and time alone, outside a flood.** It would cancel the
  user's own downloads from a site for as long as an agent's tab shows that site.
- **Narrowing a flood mark's matches by the download's referrer.** The page chooses whether its
  load sends one.
- **Dropping the oldest hop at the cap.** The page pushes its real load out.
- **A blocking `onBeforeRequest` that stops a flooding tab's loads.** A third blocking listener,
  on every page and frame load.
- **Ending a hop on `webNavigation.onCompleted`.** It fires at the load's address also when the
  load ended in a download.

## Consequences

- ADR 0081's consequence "an answer that the other site's own service worker gives" is no longer
  saved in the ways measured: it is cancelled, and its file removed, after the fact. An answer of
  such a worker that Firefox shows rather than saves, such as a PDF, an image or text, creates no
  download, so neither layer stops it.
- False positives. A download of your own is cancelled and its file removed when a tab of an
  agent's group began a load of exactly that address in the `HOP_AGE_MS` before it, on a site
  that session may not act on, that got no answer from the network and showed no page, still
  waiting or with its own download already cancelled; a page can cause that for each address it
  loads so.
  And a page in the agent's tabs that keeps more than 200 such loads under way makes Foxleash
  cancel and remove every download Foxleash did not start, in any tab, from every site that
  session may not act on, until `HOP_AGE_MS` after the last one over the cap, or 2 s after its
  tab closes.
- Limits: a download whose address is no hop's, such as one a worker answers with a redirect it
  builds; a worker that answers later than `HOP_AGE_MS`; a file that could not be removed within
  `FRESH_FILE_MS`; ways not measured. A frame of B on A with no worker of B in A's partition is no
  limit: its load reaches the header layer.
- An act's result can miss a download this layer refused: most often one in a tab the act opened,
  which Firefox closes before the act lists the group's tabs, and sometimes one that began after
  the act settled. The refusal is the same; only the report is missing.
- `upload_file` refuses, once, a file the agent or the `download` tool wrote in the last 5 seconds;
  a `batch` that downloads and uploads in one call meets that.
- The listeners see every tab's page and frame loads and every download from the first session
  on, as ADR 0081's does, without blocking.
