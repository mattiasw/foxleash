# 0101: A load the agent starts in a session tab cancels a redirect hop to a blocklisted site

**Status:** Accepted, 2026-11-19. Amends
[0007](0007-per-site-approval-and-tab-redaction.md),
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md),
[0071](0071-read-network-captures-response-bodies-with-a-stream-filter.md),
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md) and
[0099](0099-download-cancels-redirect-hops-to-sites-the-session-may-not-act-on.md).

Amended 2026-11-20: after the wait, every new top-level load of the tab is adopted and its hops
judged for 5 minutes whatever the watch saw, by the blocklist alone, with one adopting watch per
tab. A page that kept starting navigations of its own ended the wait and the watch before the
agent's reload or back step began, and a stopped session's next load was cancelled at any
redirect.

Amended 2026-11-21: while the wait of the agent's reload of a checked address runs, a new
`requestId` whose site differs from that address's is judged as a hop is. After a cancelled hop,
Firefox sent the tab's next reload straight to the hop's address (M10).

## Context

`navigate` and `tab_open` check only the first address of a load (`gate` and `access.check` in
`handlers.ts`, and the check before the load that follows the user's approval). Every load the
agent starts then waits in `waitForLoad` (`wait-for-load.ts`), and none of its listeners blocks.
The file guard's blocking `onHeadersReceived` (0081) lets every redirect with a `Location`
through. So Firefox follows a redirect from an approved address to any site, a blocklisted one
included, and sends that request with the user's cookies for it. 0081 measured the cookies: a
`navigate` or `tab_open` to A's address with a 302 to B gives B its Lax and its Strict cookies,
while a click on A's link or A's own script sends Lax only. The agent's own load is the one way
an approved page gets a Strict-cookie request sent to a bank or health site, and no legitimate
flow needs to pass through a blocklisted site. 0099 cancels such hops for a download's
background fetch.

Measured in Firefox 160.0.1 and 153.7.0esr headless, the same on both, with a throwaway MV3
add-on with Foxleash's id and permissions (`webRequest`, `webRequestBlocking`, `webNavigation`,
host permission `<all_urls>`) and a local server on 127.0.0.1, also reached as `localhost` and
`lan.test`, counting requests by path. The add-on added a blocking `onBeforeRequest` listener with
`{ urls: ["<all_urls>"], types: ["main_frame"], tabId }` right before the navigation; a
`requestId` it had not seen got `undefined`, a seen one going to `localhost` got a Promise
resolving to `{ cancel: true }` after a `storage.local.get`:

- M1. The listener was in place for the load's first request and every hop in all 50 trials per
  build, the first (cold) one included: 31 `tabs.update(tabId, { url, loadReplace: true })` in a
  loaded tab, 10 tabs created with `{ active: false, discarded: true }` and then updated, as
  `tab_open` makes them, 3 `tabs.reload`, 3 `tabs.goBack` and 3 `tabs.goForward`.
- M2. Every hop came as an `onBeforeRequest` with the first request's `requestId`, also in a
  chain A, A, B. Restoring a discarded tab sends no request: it commits the stored URL before the
  update's navigation begins.
- M3. The cancel, answered 4 to 44 ms after the hop's event (median 11 to 12 ms, 56 cancels per
  build), stopped every blocked hop before it reached the server: 0 requests on each hop's path.
- M4. After the cancel come `webRequest.onErrorOccurred` with `NS_ERROR_ABORT`,
  `webNavigation.onErrorOccurred` for the top frame, then `tabs.onUpdated` loading and complete
  on the old URL, with no top-frame commit, also over 31 s. A tab `navigate` used keeps its page;
  a new tab shows its stored URL. Without a signal, a wait for a URL never sees its commit and
  runs to its 30 s timeout, and a wait without one (reload, back, forward) ends at that complete
  with the old page, reporting success.
- M5. An HSTS upgrade of a hop (a preloaded `.dev` host) shows as a redirect with status 0, then
  an `onBeforeRequest` for the `https://` address with the same `requestId`; cancelled before any
  connection. With HTTPS-Only Mode, a hop to `http://lan.test` comes as the http hop, then the
  upgraded https hop, same `requestId`; cancelling it sent nothing, not even a TLS handshake.
  Loopback is not upgraded.
- M6. A service worker of A answering the navigation with `Response.redirect(B)`, or passing it
  to `fetch` whose answer is a server's 302 to B: B's `onBeforeRequest` has the same `requestId`;
  cancelled, B got no request. Let through, B loaded.
- M7. With access to all websites withdrawn and only `http://127.0.0.1/*` left, the first request
  was seen and the hop to `localhost` was not: B got the request and the tab showed it. With no
  host permission left, no event came at all.
- M8. A history step or a reload of an entry keeps the cookies of the navigation that made the
  entry: back, forward or reload onto an entry A's own script made sent B its Lax cookies only.
- M9. A page whose `beforeunload` handler is busy for 1.5 s held back `tabs.goBack`,
  `tabs.reload` and `tabs.update` alike: the navigation's first request came 1,504 to 1,517 ms
  after the call, after the 1 s a wait without a URL gives a load to start.
- M10 ([measurements](../measurements/agent-load-redirect-hops.md)). After a reload's hop was
  cancelled, `tabs.Tab.url` kept the page, and the tab's next reload, a reload the page held back,
  the page's own reload and a step back onto that entry each sent their first request, with a new
  `requestId`, to the hop's address. A reload after a refused `navigate` to a URL requested the
  page; one of an about:blank tab after a refused `navigate` from it requested nothing.

Firefox runs no add-on's `webRequest` listener for a request to one of its restricted or
quarantined domains (0099; read in the source, not measured).

Two defects of the first rule after the wait, which adopted a new load only when the wait had
seen none ([measurements](../measurements/agent-load-redirect-hops.md)): a page that keeps
navigating itself to an address that answers 204 ends the wait with its own navigation, so the
agent's reload or back step, starting after, was not judged and its hop sent the blocklisted site
the user's Strict and Lax cookies while `navigate` returned success. And after the user stopped a
session, the session's view threw `session_stopped`, so the next load in one of its tabs was
cancelled at its first redirect to any site.

## Decision

`createLoadHops` in `apps/extension/src/load-hops.ts`. `watch(session, tabId, refuse, gated?)`
adds, at once, a blocking `webRequest.onBeforeRequest` listener with
`{ urls: ["<all_urls>"], types: ["main_frame"], tabId }` and `["blocking"]`, and non-blocking
`onCompleted` and `onErrorOccurred` listeners with the same filter, and returns `stop`. Each watch
keeps its own `requestId`s: those it saw, and those of them Firefox has not reported ended.

`waitForLoad` takes the watch as its `hops` option, starts it before the navigation, next to the
file guard's, with the wait's `fail` as `refuse`, and stops it when the wait settles. The handlers
pass it, bound to the session, to every wait of a load the agent starts: `navigate` to a URL or
path, reload, back and forward, `tab_open` directly or after the approval prompt, the reload of an
address a history step did not load again, and the reloads of a tab Firefox unloaded or one a
reload left blank. The waits of `reloadPage`'s reload and of the reload of an address a history
step did not load again also pass the address the reload was checked on, as `gated`.

The `onBeforeRequest` listener answers:

1. A `requestId` it has not seen: `undefined` at once. While the wait runs, and in the window
   after it (below), it is remembered as a top-level load of the tab; its first address was
   checked, or the page started it. The exception: while the wait of a watch given `gated` runs,
   one whose site differs from `gated`'s is remembered and judged as rule 2 judges a hop, also
   once a newer watch of the tab took over adopting.
2. A `requestId` it has seen is a redirect hop of that load, also of a load a page started
   during the wait. A Promise that never rejects judges it:
   - an address that is not http(s): `undefined` (the blocklist matches only web sites);
   - an http(s) address with no site, which Firefox would not normally give: `{ cancel: true }`
     with `redirect_unchecked`;
   - otherwise, for a hop that arrives while the wait runs, the session's view is read anew. A
     blocklisted site, approved or not: `{ cancel: true }` with `site_blocked`. A view that fails
     with a stopped session's error: `{ cancel: true }` with that error; any other failure:
     `{ cancel: true }` with `redirect_unchecked`. For a hop that arrives after `stop`,
     `access.blocklisted(url)`, which takes no session, decides: a blocklisted site gets
     `{ cancel: true }`, also for a session the user stopped; a failure to read cancels as
     `redirect_unchecked`. Which of the two applies is decided when the hop arrives;
   - otherwise `undefined`; a site that is only not approved loads and reaches the agent redacted.
3. `refuse` is called only while the wait runs, and before the cancel is answered: M4 shows the
   complete that follows a cancel would otherwise end a wait without a URL with success. A
   judgement that settles after `stop` still cancels (0099 M7: Firefox applies a pending answer
   after removal).

The refusal names only the hop's site: "Tab `<id>`'s load was redirected to `<site>`, which is on
Foxleash's blocklist; Foxleash stopped it before anything was requested there." `tab_open` then
closes the tab it made, unless the approval prompt was shown in it; a tab `navigate` used keeps
its page.

`stop` ends refusals and then:

- **Window.** For `LATE_START_MS` (5 minutes) every new `requestId` of the tab is taken on and its
  hops judged, whatever the watch saw during the wait; taking one on does not end the window. M9
  is why: a page can hold back the start of a reload, back or forward past the wait, also by
  keeping navigations of its own going, which end the wait first. The window is the tab's: the
  `stop` of each of its watches restarts it, so it ends 5 minutes after the last wait in the tab,
  also when two calls' waits in one tab overlap.
- **Late phase.** While a load the watch took on has not ended, the listeners stay and keep
  judging its hops, until Firefox reports every such load ended (`onCompleted` or
  `onErrorOccurred`). A server can delay its redirect past the wait's 30 s, and the load runs on
  in Firefox. A request that starts after the window is not taken on.
- The listeners are removed once the wait stopped, the window ended and every load taken on
  ended, whichever comes last.
- **One adopting watch per tab.** A map in `createLoadHops` holds each tab's watches, oldest first,
  and its window. Firefox adds a listener asynchronously, so the older watches of the tab keep
  taking on new requests until the newer watch's listener hears its first request; then every
  older one stops taking them on, also one whose wait still runs. An older watch keeps judging the
  loads it took on until they end.

## Alternatives rejected

- **Cancelling the 3xx in the file guard's `onHeadersReceived` by its `Location`.** It misses
  the redirects a service worker builds and Firefox's internal ones (M5, M6), and parses headers.
- **One permanent blocking `onBeforeRequest` for every tab.** Every page load would wait for the
  extension, as 0099 rejected.
- **Judging hops to sites that are only not approved.** A sign-in that bounces through an
  identity provider would make users approve the provider for the agent.
- **Recognising only the agent's own first `requestId`.** A page's own navigation can come
  first; its hops are judged too.
- **Removing the listeners when the wait settles.** A server that delays its redirect past the
  30 s wait would get its hop sent, with the Strict cookies.
- **A fixed late window, as 0099's `LATE_HOP_MS`.** Firefox's response timeout is an idle
  timeout, so a server that trickles header bytes can outlast any window; a listener whose load
  never reports an end is filtered to its tab and answers new requests at once.
- **Judging the first request of a back or forward step too.** M8: a history step keeps the
  cookies of the navigation that made the entry, so it is not the Strict-cookie path this closes,
  and the checks of history steps stay as they are. A step onto an entry whose hop was cancelled
  sends its first request to the hop's address (M10); that is a limit under Consequences.
- **Falling back to a per-tab registry in the file guard.** M1 and M2 show the per-load listener
  sees every hop in time.
- **Adopting only the first request after the wait** (this record's rule until 2026-11-20). A page
  that keeps navigating itself fills the wait with its own loads, and the agent's step that starts
  after the wait is not judged.
- **Dropping the watch when its session is stopped.** An agent load the page held back past the
  stop would then reach the blocklisted site.
- **Ending an older watch's adoption when a newer watch of the tab starts.** A request that starts
  before the newer listener takes effect would be judged by neither, as would a held-back load of
  the older call, which carries Strict cookies.
- **A window per watch.** When two calls' waits in one tab overlap, the call that returns last
  would get only the window of the watch that adopts, which can end up to a wait's length earlier.
- **Gating the reload on the address Firefox will request.** `tabs.Tab.url` reports the page the
  tab kept, and no API gives the address a reload will request.
- **Judging every first request in the window.** It would cancel the user's own direct loads of a
  blocklisted site in that tab.

## Consequences

- 0016's non-blocking rule and 0071's "it never blocks or changes a request" gain this exception.
  0081's consequence that the request still reaches the other site with its cookies no longer
  holds for a blocklisted hop of an agent's load, nor 0007's acceptance of such a redirect with
  redaction; 0099's hop cancelling now also covers these loads, for blocklisted sites only.
- During the wait, a page's own navigation through a blocklisted site is cancelled too, and the
  call fails with `site_blocked`.
- Every top-level load of the tab in the 5 minutes after an agent's load, whoever starts it (the
  page, the user, also once the tab left the agent's group), has its blocklisted hops cancelled,
  and nothing else is stopped, also for a stopped session. A load still running at the end keeps
  being judged; a load started later is not.
- A `navigate` reload or back on a page that keeps navigating itself can still return success
  with the page the tab kept, since the wait ended before the step's load began; its hop is
  cancelled all the same.
- `navigate` to a URL behind a `beforeunload` kept busy past the 30 s timeout is covered by the
  window, not measured.
- A step held back past the window, as behind a leave-page dialog the user answers later, is not
  judged (not measured).
- The user's own loads in that tab in the window, also once the tab left the group, stop at such
  a step with no message, the tab keeping its page; an `http://` address Firefox upgrades to
  `https://` comes as a hop (M5). A load a click or another act starts there is cancelled with no
  note in the act's result.
- An older watch adopts until a newer one of the tab hears its first request, so a request in
  that overlap is judged by both; a cancel from either stops it.
- A load still running when the call returned keeps its listeners until Firefox reports it ended.
- After a cancelled hop, a later load of that page whose first request goes to the hop's address
  is judged only while the wait of the agent's reload runs: a reload held back past its wait (M9),
  the page's own reload and a back or forward step onto that page reach the blocklisted site
  (M10, forward not measured). A first request that comes before the watch's listener takes
  effect is judged by no watch (none seen: M1, M10).
- During such a reload's wait, a top-level load of the tab whose first request goes to a
  blocklisted site off the reloaded page's site is cancelled too, whoever started it.
- Without access to all websites Foxleash sees no hop to a site outside its grants (M7), so it
  cancels none.
- A redirect hop to a restricted or quarantined domain is not seen, so Firefox sends it.
- A hop to a site that is only not approved still loads, and the tab reaches the agent redacted
  (0007).
- Seen while measuring M5: with HTTPS-Only Mode, cancelling the upgraded first address of a load
  still opened one TLS connection to its host, with no request. A first address is checked before
  the load, not by this listener.
