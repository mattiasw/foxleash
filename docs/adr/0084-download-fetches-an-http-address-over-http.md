# 0084: download fetches an http address over http

**Status:** Accepted, 2026-11-18. Extends [0019](0019-download-fetches-in-the-background-and-saves-through-downloads.md).

## Context

The extension's manifest declared no `content_security_policy`, so Firefox gave its pages, the
background page included, the Manifest V3 default for extension pages:
`script-src 'self'; upgrade-insecure-requests`. The upgrade sends the background page's fetch of
an `http://` address (ADR 0019) to `https://` on the same host and port, which is another site
(ADR 0007) than the one the site gate checked. Firefox exempts loopback addresses from the
upgrade, and 0019's measurements used `127.0.0.1` and `localhost`, so they did not show it.

Measured in Firefox 160.0.1 and 153.7.0esr headless, with the site approved, on the first
`download` of a file:

- On `http://127.0.0.1` the download saved, and the server saw one plain `GET`.
- On a private non-loopback address (172.17.0.1), and on a host name the test profile resolves
  to this computer, the tool refused with "Firefox could not fetch the file; nothing was saved."
  The server saw only TLS handshakes, no `GET`.
- With only `"content_security_policy": {"extension_pages": "script-src 'self'"}` added to the
  manifest, all three saved over a plain `GET`, which carried the cookie the http site's page
  had set.

Opening those sites with `tab_open` and fetching from their pages worked over http throughout.
Where the host also answered https on that port, the default's upgraded request reached the
https site, and the gate after the headers refused it ("The link led to https://..."), so the
download failed either way.

## Decision

`apps/extension/manifest.json` declares `content_security_policy.extension_pages` as
`script-src 'self'`: Firefox's script rule for extension pages, without the upgrade. A unit test
in `apps/extension/lint.test.ts` pins the string exactly.

The end-to-end test in `e2e/download.test.ts` reaches the fixture server through `lan.test`,
which the test profile maps to this computer with `network.dns.localDomains` (`e2e/firefox.ts`).
Firefox upgrades that name as it does an address on the network, so the test runs on every
machine, and the fixture server listens only on loopback.

## Alternatives rejected

- Refusing non-loopback `http:` addresses in `download`. It makes the tool unusable on servers
  on the user's network, routers and intranet tools, which the agent can already open with
  `tab_open` and read.
- Keeping the default. The request goes to another site than the one checked: the fetch fails,
  or, where the host answers https on that port, the request reaches the https site with its
  cookies and the gate after the headers refuses it.
- Fetching with `downloads.download`. 0019 rejected it because it hides where redirects lead.
- An end-to-end test on a private address of the machine. A machine may have none, so the test
  would be skipped there, and its server would listen on the network.

## Consequences

The gate checks the address the request goes to. An `http://` download travels unencrypted,
with the user's cookies for the site that are not marked Secure (Firefox never sends those over
http), as the page's own requests to that site do; with no redirect, they go only to the
approved site.

Upgrades Firefox makes itself still apply, as they do to the page. In HTTPS-Only Mode a host
name (not a loopback or private IP address) is switched to https, measured; a site that asked
Firefox for https only (HSTS) is switched by the same mechanism, not measured. The upgraded
request then reaches the https site, and the gate after the headers refuses it unless that site
is approved too (measured with HTTPS-Only Mode).

A redirect to an `http://` address is no longer upgraded either, also when it is one step of a
chain that ends on an approved `https://` address. Firefox then requests that step over plain
http, with the cookies of its host that are not marked Secure, and the gate, which checks the
final address, does not see it; this follows from the policy and is not measured. It is the gap
0019 accepts, a redirect hop requested with its own site's cookies, now unencrypted when the hop
is `http://`. A host that asked Firefox for https only (HSTS) is still switched to https.

No extension page loads web content, so nothing else changes; an extension page that later loads
web content gets no automatic upgrade to https.
