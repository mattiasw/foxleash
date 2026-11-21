# Redirect hops of the agent's loads

Measurements behind [ADR 0101](../adr/0101-agent-loads-cancel-redirect-hops-to-blocklisted-sites.md).

## A page that keeps navigating itself, and a stopped session (2026-11-20)

Taken in Firefox 160.0.1 headless with Foxleash as it was before the 2026-11-20 amendment of ADR
0101, against a local server on 127.0.0.1, also reached as `localhost`. `127.0.0.1` was approved
and the blocklist was `localhost`; an earlier visit to `localhost` had set a Strict and a Lax
cookie there. The server counted requests by path and logged their cookies.

The page sets a flag and assigns `location.href` to a 204 address of its own, with a counter in
the query, every 100 ms. Its `beforeunload` handler is busy for 400 ms on its own navigation and
stops the loop at the first `beforeunload` without the flag, which is the agent's load. The page's
address answers its first request with the page and its second with a 302 to `localhost`. For
back, a second such page was loaded in the tab first, and the step went back to the first.

| `navigate` | Answered in | Answer | Requests at the `localhost` target | Cookies sent there |
|---|---|---|---|---|
| `action: "reload"` | 181 ms | success | 1 | `strict=s1; lax=l1` |
| `action: "reload"` | 188 ms | success | 1 | `strict=s1; lax=l1` |
| `action: "back"` | 548 ms | success | 1 | `strict=s1; lax=l1` |
| `action: "reload"`, control | 1,020 ms | success | 0 | no request |

In each failing run the step's own request for the page's address came shortly after `navigate`
answered, and the request to the blocklisted target 3 to 6 ms after that. The control page starts
no navigations of its own and holds the reload for 3 s in its `beforeunload`; its step requested
the page's address again, and nothing reached the target.

Stopped session: after the user stopped the session, a load started in one of its tabs over
WebDriver BiDi, as the user would start it, that redirected to a site not on the blocklist was
aborted at that redirect (`NS_ERROR_ABORT`, 0 requests at its target), and the next one loaded.

The end-to-end tests "a reload on a page that keeps navigating itself sends nothing to that site"
and "a step back from a page that keeps navigating itself sends nothing to that site" in
`e2e/redirect-hop.test.ts` reproduce the reload and back rows.

## A reload after a refused redirect hop (2026-11-21)

Taken in Firefox 160.0.1 headless with the end-to-end harness, the blocklist `localhost`, the
fixture server approved as `127.0.0.1`. The page's address answers its first request with the
page and every later one with a 302 to `http://localhost:<port>/<path>-target`; the server counts
requests by path.

Before the 2026-11-21 amendment of ADR 0101, on a copy of the end-to-end test "a reload whose
address now redirects there fails at once and keeps the tab's page": once that test's steps
passed, a second reload 4 to 13 ms after the tab listed its title again returned success, and the
hits went from page 2, target 0 to page 2, target 1, in 2 of 2 runs. With reloads one right after
another, a later reload returned success with the tab on `localhost` in 4 of 4 runs.

Then on a copy of that test with a diagnostic that recorded, for each watch, every `main_frame`
`onBeforeRequest` it heard (the `requestId`, the URL, whether any watch had seen that
`requestId`, and whether the watch was waiting and adopting), 3 runs each:

| Step | Before the amendment | With it |
|---|---|---|
| First reload | refused in 32 to 35 ms | refused in 50 to 95 ms |
| Second reload, after the tab listed its title | success in 83 to 116 ms, tab listed as `http://localhost:<port>` with no title, target 0 to 1 | refused in 20 to 72 ms |
| Third reload, right after the second | not taken | refused in 23 to 84 ms |
| Fourth reload, after the tab listed its title | not taken | refused in 20 to 128 ms |
| Hits, page and target, at the end | 2 and 1 | 2 and 0 |

The second reload's first request had a new `requestId`, type `main_frame`, the target's URL and
the extension's own origin as `originUrl`, while `tabs.Tab.url` still reported the page. It came 9
to 11 ms after the reload's watch started, and both that watch and the older one of the tab heard
it; before the amendment both answered it at once, unjudged. With the amendment each later
reload's first request went to the target too, and was cancelled. After settling the tab listed
the page with its title, 6 to 72 ms after the refusal.

- A `navigate` from `/a` to a page that redirects there, refused, then two reloads: both
  requested `/a` (hits 2, then 3), and the target got none, in 3 of 3 runs.
- A step back onto the page after its refused reload and a `navigate` to another page: success in
  87 to 167 ms, the tab listed on `localhost`, target 0 to 1, in 3 of 3 runs, with and without
  the amendment. Its first request had a new `requestId` and the target's URL, 5 to 12 ms after
  the step's watch started.
- The test's steps (a refused reload, the tab settled, two reloads one right after the other),
  each time on a fresh path, 10 times per run: every reload refused, page 2 and target 0, in 20 of
  20.
- With the amendment, a page whose `beforeunload` is busy for 1.5 s: the first reload returned
  success in about 1.54 s, its hop cancelled after the wait (page 2, target 0); the second
  returned success in about 1.57 s and its first request then went to the target after the wait
  (target 0 to 1), the tab ending up on `localhost`, in 2 of 2.
- With the amendment, the page's own `location.reload()`, run over WebDriver BiDi 2 s after a
  refused reload: target 0 to 1, the tab on `localhost`, in 2 of 2.
- A reload of a tab on about:blank after a refused `navigate` from it requested nothing: target 0,
  the tab on about:blank, in 2 of 2.

The end-to-end test "every later reload of that tab fails at once too and sends nothing to that
site" in `e2e/redirect-hop.test.ts` reproduces the reload rows.
