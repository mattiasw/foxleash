# 0101: A load the agent starts in a session tab cancels a redirect hop to a blocklisted site

**Status:** Accepted, 2026-11-19. Amends
[0007](0007-per-site-approval-and-tab-redaction.md),
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md),
[0071](0071-read-network-captures-response-bodies-with-a-stream-filter.md),
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md) and
[0099](0099-download-cancels-redirect-hops-to-sites-the-session-may-not-act-on.md).

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

Firefox runs no add-on's `webRequest` listener for a request to one of its restricted or
quarantined domains (0099; read in the source, not measured).

## Decision

`createLoadHops` in `apps/extension/src/load-hops.ts`. `watch(session, tabId, refuse)` adds, at
once, a blocking `webRequest.onBeforeRequest` listener with
`{ urls: ["<all_urls>"], types: ["main_frame"], tabId }` and `["blocking"]`, and non-blocking
`onCompleted` and `onErrorOccurred` listeners with the same filter, and returns `stop`. Each watch
keeps its own `requestId`s: those it saw, and those of them Firefox has not reported ended.

`waitForLoad` takes the watch as its `hops` option, starts it before the navigation, next to the
file guard's, with the wait's `fail` as `refuse`, and stops it when the wait settles. The handlers
pass it, bound to the session, to every wait of a load the agent starts: `navigate` to a URL or
path, reload, back and forward, `tab_open` directly or after the approval prompt, the reload of an
address a history step did not load again, and the reloads of a tab Firefox unloaded or one a
reload left blank.

The `onBeforeRequest` listener answers:

1. A `requestId` it has not seen: `undefined` at once. While the wait runs it is remembered as a
   top-level load of the tab; its first address was checked, or the page started it.
2. A `requestId` it has seen is a redirect hop of that load, also of a load a page started
   during the wait. A Promise that never rejects judges it:
   - an address that is not http(s): `undefined` (the blocklist matches only web sites);
   - an http(s) address with no site, which Firefox would not normally give: `{ cancel: true }`
     with `redirect_unchecked`;
   - otherwise the session's view is read anew. A blocklisted site, approved or not:
     `{ cancel: true }` with `site_blocked`. A view that fails with a stopped session's error:
     `{ cancel: true }` with that error; any other failure: `{ cancel: true }` with
     `redirect_unchecked`;
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

- **Late phase.** While a load the watch saw has not ended, the listeners stay and keep judging
  its hops, until Firefox reports every such load ended (`onCompleted` or `onErrorOccurred`); new
  `requestId`s are not taken on. A server can delay its redirect past the wait's 30 s, and the
  load runs on in Firefox.
- **Start phase.** When the watch saw no top-level request at all, the listeners stay for
  `LATE_START_MS` (5 minutes): the first new `requestId` is taken on as the wait's load and judged
  as in the late phase, and the timer is cleared. If none comes in that time, the listeners are
  removed. M9 is why: a page can hold back the start of a reload, back or forward past the wait.
- Otherwise the listeners are removed at once.

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
  and the checks of history steps stay as they are.
- **Falling back to a per-tab registry in the file guard.** M1 and M2 show the per-load listener
  sees every hop in time.

## Consequences

- 0016's non-blocking rule and 0071's "it never blocks or changes a request" gain this exception.
  0081's consequence that the request still reaches the other site with its cookies no longer
  holds for a blocklisted hop of an agent's load, nor 0007's acceptance of such a redirect with
  redaction; 0099's hop cancelling now also covers these loads, for blocklisted sites only.
- During the wait, a page's own navigation through a blocklisted site is cancelled too, and the
  call fails with `site_blocked`.
- When the wait saw no load, the tab's next load within 5 minutes is judged as the agent's, also
  when it is a load the page or the user starts because the step itself loaded nothing; only a
  request to a blocklisted site from a tab of the agent's group is ever stopped by it. A load held
  back longer, and any other later load of the tab, is not judged.
- A load still running when the call returned keeps its listeners until Firefox reports it ended.
- Without access to all websites Foxleash sees no hop to a site outside its grants (M7), so it
  cancels none.
- A redirect hop to a restricted or quarantined domain is not seen, so Firefox sends it.
- A hop to a site that is only not approved still loads, and the tab reaches the agent redacted
  (0007).
- Seen while measuring M5: with HTTPS-Only Mode, cancelling the upgraded first address of a load
  still opened one TLS connection to its host, with no request. A first address is checked before
  the load, not by this listener.
