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
