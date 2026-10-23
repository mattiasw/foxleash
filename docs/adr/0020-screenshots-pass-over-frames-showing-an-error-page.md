# 0020: Screenshots pass over a frame that Firefox reported as showing its error page

**Status:** Accepted, 2026-10-23. Supersedes 0013's rule that a frame refusing the sheet refuses
the screenshot.

## Context

ADR 0013 hides credential-field text with a user style sheet inserted into every frame
`webNavigation.getAllFrames` lists, one `scripting.insertCSS` per frame, and refuses the
screenshot when any insert rejects. End-to-end experiments on Firefox 156.0.1 showed that a
subframe showing Firefox's own error page rejects the sheet (`Missing host permission for the
tab or frames`), so a page with such a frame could not be captured. That happens for a frame
refused by `X-Frame-Options` or CSP `frame-ancestors`, and for one whose load failed at the
network level (refused connection, a host that does not resolve, which includes DNS-level ad
blockers). A frame cancelled by another add-on's blocking `webRequest` listener, or blocked by
tracking protection, stays on its initial `about:blank` and takes the sheet. A PDF in Firefox's
viewer rejects it too.

For an error-page frame Firefox reports, in order: `onErrorOccurred` with the failed URL and the
`documentId` of the frame's previous document (its initial `about:blank`), `onCommitted` with the
failed URL and the error page's `documentId`, then `onDOMContentLoaded` with the error page's
`documentId` and its own address, `about:neterror?e=...&u=<the failed URL, escaped>&...`.
`getAllFrames` then lists the frame with the error page's `documentId` and the failed URL. The
reason, read from Firefox's `WebNavigation.sys.mjs` and `WebNavigationFrames.sys.mjs`: an event's
`url` comes from the document that fired it, but its `documentId` from whatever document the
frame shows when the parent process handles the event. `onErrorOccurred` fires while the
previous document is still current.

In `u=` Firefox escapes `:` `?` `&` `=` `%` `#` and leaves `/`, `.` and `+` as they are.
`decodeURIComponent` of the raw field gave back `getAllFrames`' url exactly in all eight
measured error frames; `URLSearchParams` did not, since it reads `+` as a space. A page cannot
load `about:neterror` into a frame (Firefox leaves the frame on `about:blank`), and
`history.replaceState` to such an address throws `SecurityError` in an http document, its
same-origin `about:blank` child and a `srcdoc` child.

## Decision

A rejected insert into a frame is passed over only when Firefox itself reported that frame's
current document as its error page for the URL the frame now shows. Against the frame as this
screenshot's `getAllFrames` listing gives it, all of these must hold:

1. the frame id is not 0;
2. Foxhand recorded, for that tab and frame id, a `webNavigation.onDOMContentLoaded` event whose
   `url` starts with `about:neterror?`, keeping its `documentId` and the `decodeURIComponent` of
   its `u=` field;
3. the recorded `documentId` equals the listing's `documentId` for the frame;
4. the recorded failed URL equals the listing's `url` for the frame, exactly.

A listing entry without a `documentId` or `url` is never passed over. Every other rejection
refuses with `screenshot_failed`, as before. The sheet is still inserted into every frame, the
frame watch still refuses a screenshot during which any frame commits, Firefox's error text still
never reaches the agent, and every sheet is still removed once its own insert settles.

The record is `apps/extension/src/frame-errors.ts`, created in `createHandlers`: per tab, at most
100 frames, the oldest dropped first, forgotten when the tab closes, in memory only, and no failed
URL longer than 16,000 characters. The excuse is
in `maskedCapture` in `apps/extension/src/handlers.ts`.

Condition 4 exists because the `documentId` is read when the parent handles the event: if the
frame's next document had committed before the error page's `DOMContentLoaded` was handled, the
event would pair the error page's address with the next document's id. Whether that reordering
can happen is not verified. With the url tie it could only excuse a document loaded from exactly
the URL that had just failed: a document that refuses to be framed fails again in the same way,
and one that allows framing did not fail the first time unless that failure passed, such as a
dropped connection.

## Alternatives rejected

- Skipping frames whose last navigation errored, without trying the insert: a load aborted under a
  live document (`window.stop()`, a 204 response) fires `onErrorOccurred` too, so a page could
  abort a load in a payment frame it embeds and have that frame captured unmasked.
- Matching `onErrorOccurred`'s `documentId` and url with the listing: the error event names the
  previous document, and the error page's own commit follows it.
- Pairing an error with the next commit of the same URL: aborting a load of a URL and then
  loading the same URL as a PDF gives the same pair for a document that must refuse.
- Matching the `documentId` alone: it is read when the parent handles the event, so it can name a
  later document.
- `URLSearchParams` for `u=`: it turned `+` into a space in the measurements.
- `errorOccurred` from `getAllFrames` or `getFrame`: Firefox 156 does not give it.
- Probing the frame with `executeScript`: the same matcher that refuses the sheet refuses it.
- Accepting the refusal and documenting it: the measured cases are ordinary pages, many more with
  a DNS-level ad blocker.

## Consequences

Each gap fails closed, refusing the screenshot:

- After a background restart (the background is an event page), a frame that showed its error page
  before the restart refuses until it loads again.
- A screenshot taken between an error page's commit and its `DOMContentLoaded` refuses.
- Other Firefox error pages, `about:certerror?` for certificate errors and `about:blocked?` for
  Safe Browsing, still refuse: only `about:neterror?` was measured.
- In a tab with more than 100 frames showing error pages, the oldest refuse.
- A frame whose failed URL is longer than 16,000 characters refuses.

Accepted without failing closed: the error page in the image shows text the page chose (the failed
URL's host) in Firefox's words. It holds no field the page fills.

Extension ad blockers and tracking protection were measured not to cause this refusal.

Revisit when a Firefox version changes `onDOMContentLoaded`'s url for error pages or how it
escapes `u=` (the end-to-end test of a page with error-page frames would fail), or lets a document
other than its error page report an `about:neterror?` address.
