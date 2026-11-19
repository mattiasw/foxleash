# 0099: download cancels a redirect hop to a site the session may not act on, before Firefox sends it

**Status:** Accepted, 2026-11-19. Amends
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md),
[0019](0019-download-fetches-in-the-background-and-saves-through-downloads.md),
[0071](0071-read-network-captures-response-bodies-with-a-stream-filter.md) and
[0084](0084-download-fetches-an-http-address-over-http.md). Amended by
[0101](0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md), 2026-11-19: its
hop cancelling is extended to the loads the agent starts in a session tab, for blocklisted sites
only.

## Context

`download` (`apps/extension/src/downloads.ts`, ADR 0019) checked the site of the start URL before
its fetch and of `response.url` after it. The fetch runs with `credentials: "include"` and lets
Firefox follow redirects, so a redirect from an approved site made Firefox request any other site
with the user's cookies for it, `SameSite=Strict` included, blocklisted sites too, with no tab;
and a chain approved, then unapproved, then approved again passed both checks and saved the file.

Measured in Firefox 160.0.1 and 153.7.0esr headless, the same on both, with a throwaway MV3
add-on with Foxleash's permissions and content security policy, a blocking `onBeforeRequest`
listener with the filter `{ urls: ["<all_urls>"], tabId: -1 }`, a background-page fetch with
`{ credentials: "include", cache: "no-store" }`, and a local server on 127.0.0.1, also reached as
`localhost` and `lan.test`, counting requests by path:

- M1. The listener sees the fetch's first request and every redirect hop, with `tabId` -1, `type`
  "xmlhttprequest", `frameId` 0, `originUrl` and `documentUrl` the add-on's
  `moz-extension://<uuid>/_generated_background_page.html`, and one `requestId` for the first
  request and all its hops.
- M2. A Promise resolving to `{ cancel: true }`, after a `storage.local.get` and 30 ms, stops the
  hop before it is sent: its path and every later path got no request. A synchronous
  `{ cancel: true }` does the same.
- M3. A listener added immediately before `fetch()` was in place for the first request and the
  first hop in 31 of 31 trials per build, the first (cold) one included.
- M4. HTTPS-Only Mode on `lan.test` shows the upgrade as a redirect with `statusCode` 0, then an
  `onBeforeRequest` for the `https://` address with the same `requestId`; cancelling it sent
  nothing, not even a TLS handshake, also for an upgrade of a hop. An HSTS upgrade, through
  Firefox's preload list, is the same internal redirect, cancelled before any connection.
- M5. A cancelled hop makes `fetch` reject with `TypeError` "NetworkError when attempting to
  fetch resource."
- M6. `details.url` keeps the fragment of the start URL and of a `Location`; `response.url` never
  has one.
- M7. A pending `{ cancel: true }` answer is applied even when it resolves after the listener was
  removed.
- M8. Aborting the fetch while a hop's answer is pending does not stop the hop: the fetch
  rejected at once with `AbortError`, but when the answer let the hop through later, Firefox sent
  it and followed its redirect to the next address, which no listener judged once the listener
  was removed.
- M9. With the background page kept busy while a redirect arrived, then the fetch aborted and the
  listener removed in the same task, no hop event reached the listener and no hop was requested
  (7 trials per build): Firefox follows a fetch's redirect only after the page's own thread has
  handled it.

Firefox runs no add-on's `webRequest` listener for a request to one of its restricted domains
(`extensions.webextensions.restrictedDomains`, such as addons.mozilla.org) or to a quarantined
domain (`extensions.quarantinedDomains.list`, empty by default and filled from Mozilla's remote
settings): `WebRequest.sys.mjs` in 160.0.1 does not match a channel whose `canModify` is false.
Read in the source, not measured.

## Decision

While a download runs, `save` in `downloads.ts` adds one `webRequest.onBeforeRequest` listener
with the filter `{ urls: ["<all_urls>"], tabId: -1 }` and `["blocking"]`, before the start URL's
site check and the fetch, and removes it in its `finally`. The filter is not narrowed by `types`:
M1 shows "xmlhttprequest", but the safeguard would then depend on how Firefox classifies a
background fetch.

The listener answers, in this order:

0. Once the download ended: `{ cancel: true }` for a request with the fetch's recorded
   `requestId`, `undefined` for anything else.
1. While no `requestId` is recorded, `undefined` for a request that comes while the fetch is not
   running (from just before `fetch()` until it settles), whose `originUrl` does not start with
   the add-on's base URL (`runtime.getURL("")`), or whose `requestId` is one an earlier download's
   listener still cancels (below).
2. The first own request while the fetch runs records its `requestId`. When its URL without
   fragment is the start URL without fragment, it is the first request and gets `undefined`: the
   site check before the fetch covered it. Otherwise the first request was missed and this is a
   hop.
3. A request with the recorded `requestId` is a hop.
4. Anything else, other own requests included, gets `undefined` at once.

A hop is judged against the session's site view read anew (`access.view(session)`), and gets
`{ cancel: true }` when its address is not http(s) or not canonical, the view cannot be read, the
site is on the blocklist, or the session may not act on it; otherwise `undefined`, and its
address is recorded as the last one let through. A judgement that settles after the download
ended answers `{ cancel: true }` whatever it found (M8). The listener never throws and its
Promise never rejects.

A cancelled hop's refusal is what the call returns, naming only the hop's site:

- `site_blocked`: "The link led to `<site>`, which is on Foxleash's blocklist; nothing was
  requested there and nothing was saved."
- `site_not_approved`: "The link led to `<site>`, which Foxleash is not allowed on in this
  session; nothing was requested there and nothing was saved."
- `download_failed` ("Firefox could not fetch the file; nothing was saved.") for an address
  that is not http(s) or a view that could not be read, and the view's own error for a stopped
  session.

When `response.url`, without fragment, is neither the start URL nor the last address the listener
let through, the answer came through a redirect the listener did not see, and nothing is saved
(`download_failed`). The two checks of `response.url` stay, for an approval withdrawn after the
last hop was judged.

When a download ends while its fetch has not settled and the listener has seen one of its
requests, which only the timeout can do, the listener stays in the ended mode of rule 0 for
`LATE_HOP_MS` (5 minutes, Firefox's default `network.http.response.timeout`), then is removed:
a hop held past the abort and let through can come back with a redirect that long after. Its
`requestId` is kept meanwhile, so the next download's listener never takes that late request for
its own fetch and leaves its own hops unjudged. In every other case it is removed at once.

`download` first checks that Foxleash has access to all websites
(`permissions.contains({ origins: ["<all_urls>"] })`, a rejection counting as no) and refuses
with `download_failed` without it: Firefox fires `webRequest` events only for addresses an add-on
has host permission for (MDN; not measured here), so the listener would not see a hop to a site
outside the user's grants.

## Alternatives rejected

- **Keeping only the `response.url` checks.** The hop is already sent, with its site's cookies,
  when the response arrives, and a chain back to an approved site passes them.
- **`downloads.download` of the http URL.** 0019 rejected it: it hides where redirects lead.
- **`redirect: "manual"` and following hops by hand.** A fetch from an extension page gets an
  opaque-redirect response with no `Location`, so the next address is unknown without
  `webRequest` anyway.
- **One listener registered once in `createDownloads`.** M3 shows a per-download listener is in
  place in time, and a permanent blocking listener would make every request that belongs to no
  tab wait for the extension all the time.
- **Narrowing the filter by `types`.** See the Decision.
- **Recognising the fetch by `requestId` alone, from a first request matching the start URL.** A
  missed first request would leave every hop unjudged, and a site's service worker requesting the
  same URL at that moment could be taken for the fetch. Rule 1 also keeps an own request from
  before the fetch, and a timed-out download's late request, from being taken for it.
- **Removing a timed-out download's listener when its request ends** (`onErrorOccurred`,
  `onCompleted`). Two more listeners per download for a rare path; the 5-minute bound suffices.
  A 1-second delay was too short for a slow redirect.

## Consequences

- A download whose redirects pass through a site the session may not act on fails, also when the
  chain leads back to an approved site, such as a sign-in bounce.
- An HTTPS-Only Mode or HSTS upgrade to an `https://` site that is not approved is cancelled
  before it is sent, of the start URL too: 0084's consequence that the upgraded request reaches
  the https site and the check after the headers refuses it no longer holds.
- 0019's rejected alternative "`webRequestBlocking`: a second new permission" and its consequence
  that redirect hops are requested with their own sites' cookies no longer hold for `download`;
  the permission is already granted for 0071.
- 0071's "it never blocks or changes a request" and 0016's non-blocking rule gain this exception.
- While a download runs, at most 50 seconds, every request that belongs to no tab waits for the
  extension's synchronous answer; after a download that timed out during its fetch, for up to 5
  more minutes.
- The first request is not judged again: the start URL's check ran a moment before, and an
  approval withdrawn in between still gets that one request sent, as before. A hop is judged
  against the view of that moment; the checks of `response.url` catch a later withdrawal.
- A listener that saw none of the fetch's requests would leave its hops unjudged (0 of 31 per
  build in M3); the save then fails on the unseen redirect. A hop held past the abort whose
  redirect comes more than 5 minutes later would be unjudged.
- `download` is refused while Foxleash lacks access to all websites.
- A redirect hop to a restricted or quarantined domain is not seen, so Firefox sends it; the save
  fails when it is the last hop. The listing and the docs name this exception.
- Not measured: another add-on's blocking listener holding a hop past the abort (the ended mode
  covers it whichever route leads to M8), and an event in flight at the listener's removal (M9
  could not produce one).
