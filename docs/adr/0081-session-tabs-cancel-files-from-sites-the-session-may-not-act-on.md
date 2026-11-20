# 0081: A session's tabs cancel a response that is not a page from a site the session may not act on

**Status:** Accepted, 2026-11-18. Amends "Non-blocking listeners only" of
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md) and "it never
blocks or changes a request" of
[0071](0071-read-network-captures-response-bodies-with-a-stream-filter.md) for this one case.
Amended by [0089](0089-file-guard-ties-windows-to-the-tab-that-opened-them.md), 2026-11-18: a
window or tab that a page in a session's tab opens is judged as that session's, so a file loaded
there is no longer saved. Amended by
[0091](0091-file-guard-remembers-session-groups-across-restarts.md), 2026-11-18: the tabs of a
session's group stay judged after a Firefox restart or an update or reload of the add-on.
Amended by [0092](0092-file-guard-cancels-downloads-from-loads-whose-headers-never-came.md),
2026-11-18: a download from a load whose headers never came, as when the other site's service
worker answers it, is cancelled and its file removed after the fact, and `upload_file` refuses a
file changed in the last 5 seconds. Amended by
[0094](0094-file-guard-and-files-a-page-builds-itself.md), 2026-11-19: a Blob file that a page of
such a site builds itself in a session's tab or frame is cancelled and its file removed after the
fact; a `data:` file is not. Amended by
[0101](0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md), 2026-11-19: the
consequence "The request still reaches the other site, with the cookies Firefox sends for it" no
longer holds for a redirect hop to a blocklisted site in a load the agent started, which is
cancelled before it is sent. Amended by
[0103](0103-file-guard-keeps-an-ended-sessions-sites-until-restart.md), 2026-11-20: the tabs left
in an ended session's group are judged by the sites allowed always and those that session was
allowed for itself when it ended, and by the sites allowed always alone only after a Firefox
restart or an update or reload of the add-on.

## Context

A page on a site the session is approved for (A) could make Firefox save, into the download
folder, a file served by a site the session may not act on (B: not approved for the session, or
on the blocklist), requested with the user's cookies for B. `~/Downloads` is a default upload
folder, so `upload_file` then handed that file to A's page. Measured in Firefox 160.0.1, headless,
with A on `127.0.0.1` and B on `localhost`, three ways, the tab staying on A's page in each:

1. A `click` on a same-site link whose answer redirects to B's file. The result said
   `"page": "unchanged"` and nothing about a file; the file was saved.
2. `navigate` to that same-site address. It failed after 30,013 ms with "did not load a page from
   that URL within 30 seconds", and the file was saved.
3. No act at all: A's own script set `location.href` to B's file after `tab_open` of A.

Neither existing check can see this. The click check and the gate of `navigate` and `tab_open`
read only the first address, and a response Firefox saves commits no document, so the redaction
of a tab on another site never runs and nothing else watched what a session tab's load ended in.
Until now no listener of the extension blocked a request: ADR 0016 allowed non-blocking listeners
only, and the one blocking listener of ADR 0071 returns at once.

## Measurements

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
  redirected request reaches the listener, here the file guard of the Decision below, with the
  tab's id as `main_frame` (`sub_frame` in a frame) and is cancelled. Nothing was saved in the
  five cases: a click, a script's navigation and a frame with `Response.redirect`, and a click
  and a script's navigation with the passed-on 302 (both versions). So the service-worker limit
  needs a worker on B.
- A tab outside any group was untouched: its file was saved.

Not measured: `<object>` with `application/pdf` while Firefox's PDF viewer is switched off, and
whether Firefox suspends the background while a session runs.

## Decision

`createFileGuard` in `apps/extension/src/file-guard.ts`, called at the top level of
`background.ts`. From the first agent session on, a blocking `webRequest.onHeadersReceived`
listener cancels the response to a top-frame or frame load in a tab of a session's group when
the response is anything other than a web page and its address is on a site that session may not
act on.

**When the listener is added.** At the first call of `access.onRunningChange`, which a session's
first request makes before the session has a tab, once, with `{ urls: ["<all_urls>"], types:
["main_frame", "sub_frame"] }` and `["blocking", "responseHeaders"]`. It is never removed.

**What it answers at once.** `undefined`, synchronously and in this order, for:

1. a request of no tab (`tabId` below 0), which covers the `download` tool's own requests;
2. an address whose scheme is not `http:` or `https:`;
3. status 204 and 205, which load and save nothing, and 304: Firefox reports the response it
   then takes from its cache in an event of its own, with status 200 and the cached headers;
4. status 301, 302, 303, 307 or 308 with a `Location` header: the next hop's own event is judged
   by its own address. A 300, which Firefox does not follow, and every other 3xx are judged by
   their headers like any response;
5. a page: no `Content-Disposition`, or exactly one whose type is `inline` (RFC 6266 section 4.2
   treats an unknown type as `attachment`), and exactly one `Content-Type` header whose value has
   no comma and whose type is `text/html` or `application/xhtml+xml`. The type is the value
   before the first `;`, with only spaces and tabs stripped from its ends and only A to Z
   lowercased: `trim()` and `toLowerCase()` take away more, and a token Firefox reads as
   something else must not pass as a page.

Everything else is a file to the guard: an attachment, a missing or repeated `Content-Type`
(Firefox hands a repeated one over as one entry joined with a comma, and saves by the last type),
a repeated `Content-Disposition`, and every other type, also the ones Firefox would show, such as
a PDF, an image or plain text.

**What it looks up for a file.** It returns a Promise, and:

1. reads the tab (`tabs.get`). When that fails it cancels and records nothing: the tab is gone,
   and a lookup that fails must not let a file through;
2. finds the session of the tab's group (`groups.sessionOf`). A tab outside every session's group
   is let through. Whether the session still runs is not asked: the tabs of a session that ended
   are judged too, by a view that then holds only the sites allowed always;
3. reads the session's site view anew (`access.view`), with no cache, and lets the response
   through when `view.allowed(details.url)`. When the view cannot be read, as for a session the
   user stopped, or the address is not allowed, it refuses;
4. on a refusal, records the site (`redactedUrl`: scheme, host and port, never a path), the frame
   and the response's `timeStamp` for the tab, calls each `onRefused` listener, and answers
   `{ cancel: true }`. The record and each listener run in a `try` of their own, so nothing after
   the decision turns a cancel into a pass.

It keeps the newest 20 refusals of a tab, forgets them when the tab closes, and keeps those of at
most 100 tabs, dropping the tab whose first one is the oldest.

**Results say so.**

- `waitForLoad` takes the guard (`files`). A refusal in the tab's top frame while it waits, also
  after the page it asked for committed, fails the wait at once with `file_refused` and a message
  that names the site and says the site must be approved first, which `tab_open` or `navigate`
  asks the user for unless the site is on the blocklist. `handlers.ts` passes it to every load
  wait, so `tab_open`, `navigate` to a URL, a reload and a history load that Foxleash loads again
  all fail the same way, and `tab_open` removes the tab it made.
- The act tools' `after` gains `refusedFiles` (`ActAfter` in `packages/protocol/src/methods.ts`):
  the sites refused since the act was sent, in the acted tab and in each tab the act opened, each
  once, at most 20, absent when none. `act-settle.ts` reads them from `refusedSince`.
- `PROTOCOL_VERSION` stays 7. The server prints an act's result as it arrives, so the server of
  the release before shows the new field too, and `file_refused` reaches it as any error does.

## Alternatives rejected

- **One listener added at the top level.** Firefox wakes a suspended background for such a
  listener and holds the request meanwhile, 34 to 280 ms in 0071's M13. A browser where no agent
  session has run would pay that on page loads.
- **Removing the listener when no session runs, or judging only running sessions.** A session's
  group stays after its session ended, the pages in it keep running, and a page that tries again
  on a timer would get its file saved the moment the listener left.
- **Following redirects in the click check.** It does not cover a script's own navigation, and
  needs a request of its own.
- **Cancelling and erasing through `downloads.onCreated`.** It carries no tab id, and by then the
  request with the cookies has been made and the file has started.
- **`upload_file` refusing files that Firefox's download records trace to such a site.** The
  program would have to ask the extension, and an agent that reads files with its own tools is
  not covered.
- **A list of the types Firefox shows instead of saving, in place of the HTML-only rule.** What
  Firefox shows depends on the user's settings, such as a PDF set to "Save File", and a tab or
  frame on such a site reaches the agent as its site only either way.
- **Judging a 304 by its own headers.** It cancels revalidated pages.
- **`object` among the listener's types.** `<object>` and `<embed>` saved nothing in eight
  shapes, and cancelling them would blank embedded PDFs and SVGs from other sites.
- **Finding a pop-up window's session through `openerTabId`.** The window's tab has none.
- **A load wait that ignores a refusal once the page it asked for has committed.** A page that
  loads and then moves on to such a file by itself before the call returns would answer as if
  nothing had happened, and no later result reports the stop. Failing the call names the site
  whose file was stopped, as it does when a redirect leads there.

## Consequences

- Not covered, and still saved (all three measured): a response that the other site's own service
  worker gives; a file that a page of the other site builds itself; and a file loaded in a window,
  not a tab, that a page opens where the user allowed pop-ups for its site.
- The request still reaches the other site, with the cookies Firefox sends for it.
- In the tabs of a session's group, a page or frame from such a site that is a PDF, an image,
  plain text or another document that is not HTML is no longer shown.
- In the tabs of a session the user stopped, every such load is cancelled, also from approved
  sites.
- The tabs of a session that ended stay guarded while they stay in its group, by the sites
  allowed always: a file from a site allowed only for that session no longer loads there, until
  the tab is moved out of the group or Firefox restarts. Tabs outside every session's group are
  never guarded.
- A pop-up tab whose load was cancelled stays open, blank.
- A refusal that happens outside an act's wait or a load's wait, as with a slow server or a
  page's own timer, is in no result.
- From the first session until Firefox restarts or the add-on reloads, the responses to every
  tab's page and frame loads pass the listener. It answers at once for a page; a response that is
  a file waits for one `tabs.get`, and in a session's tab for one read of the settings.
- Session groups, and so the guard, live in the background's memory: where a group is no longer
  known, as after a restart, its tabs are no longer guarded.
