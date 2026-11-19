# 0094: The file guard cancels a Blob file that a page of a site the session may not act on builds itself

**Status:** Accepted, 2026-11-19. Amends
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md): of its consequence
that a file a page of the other site builds itself is still saved, a Blob file such a page builds
in a session's tab or frame is now cancelled and its file removed after the fact; a `data:` file
is still saved. Extends the second layer of
[0092](0092-file-guard-cancels-downloads-from-loads-whose-headers-never-came.md) to downloads that
come from no load.

## Context

A page on an approved site (A) redirects a session's tab to an HTML page on a site the session may
not act on (B), or shows that page in a frame. B's page builds a file (a Blob or a `data:`
address) and clicks `a[download]` on its load. No request carries the file, so the header layer
(ADR 0081) sees nothing, and the second layer (ADR 0092) skipped every download whose address is
not `http(s)`. Firefox saved the file into the download folder, an upload folder by default, from
where `upload_file` could hand B's content to A's page.

All the second layer has is `downloads.onCreated`: no tab id, and the item's own fields.

## Measurements

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

## Decision

In `createFileGuard` (`apps/extension/src/file-guard.ts`), still from the first agent session on
and never at the top level:

- **Documents, per tab.** The existing `webNavigation.onCommitted` listener and one new
  non-blocking `webNavigation.onHistoryStateUpdated` listener keep, for each tab, the site of
  each `http(s)` document its frames show, and of each `blob:` document by its origin, since a page
  can open one of its own: one entry per site, the newest event's frame and `timeStamp`, for
  `DOCUMENT_AGE_MS` (60 s) from that event, and for `HOP_GRACE_MS` (2 s) when the tab's lookup
  says no session. Each event starts the tab's shared lookup, as a load does. A frame shown now is
  read the same way.
- **A cap and a flood mark.** At most `MAX_TAB_SITES` (200) sites per tab. A document of a new site
  past that is not kept, and the tab gets a document flood mark from the first such document's
  `timeStamp` to `DOCUMENT_AGE_MS` after the last one's, cut to `HOP_GRACE_MS` after the tab closed.
  It is apart from the load flood mark of ADR 0092: neither refuses the other's downloads.
- **The built file's site.** A download Foxleash did not start whose address is not `http(s)` is a
  built file. For a `blob:` address its site is its origin's (`siteOf(URL.parse(item.url)?.origin`);
  for any other address its referrer's, which Firefox does not give today, so a `data:` file has no
  site and is saved. A file whose address begins `blob:null/`, what Firefox names the Blob of a
  page with no origin of its own, has no site either, and is judged as coming from any site. It
  is told apart by that address, not by an origin of `"null"`: another add-on's
  `blob:moz-extension:` file can parse to that origin too, and is saved.
- **The match**, first that applies: a kept document of the file's site (of any site, for a
  site-less Blob) in a judged tab, newest first; else a frame on that site that a judged tab
  shows now (`tabs.query`, then `getAllFrames`); else a document flood mark in force at the
  download's start on a judged tab. Each counts when the tab's session may not act on the site, or
  its sites or the tab cannot be read; a tab of the user's own counts never. The candidates are
  taken before the first `await`, since a closed tab's entry leaves the map and documents age out
  while the lookups run.
- **Refusing** is the second layer's refuse step. Once the file is gone, a match by a kept
  document or a shown frame is recorded through `refused()` for that tab and frame, by the file's
  site: one from a frame fails no load wait, one from the top frame does, as ADR 0081 decided. A
  kept document counts as the top frame's while the newest document committed there is of its
  site. Not recorded: a match by the flood mark, every match of a site-less Blob, and a kept
  document older than a page of another site, or of none such as `about:blank`, committed in the
  top frame before the file began, which replaced it with every frame.

## Alternatives rejected

- **Matching by the referrer's address first, then by site.** Firefox gives these downloads no
  referrer, so an address could never match.
- **Keeping documents per address.** Only the site is compared, and a cap by address would set the
  flood mark for an approved page that changes its address with the History API 201 times in a
  minute, such as search as you type, cancelling every Blob file of every unapproved site for a
  minute.
- **Leaving a `blob:null` file a named limit.** The approved page chooses it with one `sandbox`
  attribute, which would bypass this layer.
- **Refusing every file with no site, `data:` included.** It would cancel the approved page's own
  `data:` exports whenever it embeds any other site. A `data:` file is the choice of B's own page,
  not something the approved page can force.
- **A time bound on a frame still shown.** A page that saves later than the bound would pass.

## Consequences

- False positives. Your own Blob file from a site, in any tab, is cancelled and removed while a tab
  of any agent's group shows a document of that site in any frame, such as a widget embedded in the
  approved page, and for 60 s after it showed one, also when another agent session may act on that
  site. A Blob file that a page with no origin of its own saves, such as a sandboxed page or a page
  opened from a local file, in any tab, is cancelled while a tab of an agent's group shows, or in
  the last 60 s showed, a document of a site its session may not act on. During a document flood,
  every Blob file from a site that session may not act on is.
- Limits: a `data:` file such a page builds is saved, since Firefox gives no referrer; so is a file
  a page saves more than 60 s after its last address change, from a frame or window that is
  removed, closed or sent to another page right then; and one that took longer to remove than the
  5 s `upload_file` refuses a fresh file for (measured up to about 2.4 s, and about 9 s under more
  load, on the ESR with thousands of earlier downloads while a page saves 33 files a second). This
  holds for the service-worker case of ADR 0092 too.
- A frame still shown has no time bound: a page that waits longer before saving is still matched.
- A page cannot push B's document out of the kept list: past 200 sites nothing is evicted, and the
  flood mark refuses instead.
- An act's result can miss a built file's refusal, as for ADR 0092; one that a page with no origin
  of its own saved is never listed.
