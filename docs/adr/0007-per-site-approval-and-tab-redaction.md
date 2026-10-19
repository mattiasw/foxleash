# 0007: A session acts only on sites the user approved, and sees other tabs redacted to their site

**Status:** Accepted, 2026-10-19.

## Context

Foxhand acts in the user's logged-in Firefox, and a page can carry instructions aimed at the
model ([0002](0002-safeguards-live-in-foxhand-not-the-mcp-client.md)). The first safeguard is
that an agent session acts on a site only after the user approved it in the browser. That needs
a definition of a site, a place to keep the user's answers, a moment at which to ask, and a rule
for what the agent may learn about tabs on sites nobody approved. A tab's URL and title can
carry private data on their own: an OAuth `?code=` on a callback page, a webmail title with the
account address, the path of a local file.

## Decision

**A site is the origin of an http or https URL**, as the WHATWG URL parser gives it (scheme,
lowercase punycoded host, and the port only when it is not the scheme's default), with one
trailing dot of the host stripped, so `https://example.com./` and `https://example.com` are one
site. The scheme is part of the site, so approving `https://intranet.example` does not approve
`http://intranet.example`. Every other scheme (`file:`, `about:`, `moz-extension:`, `data:`,
`blob:`) has no site and can never be approved. `siteOf` in `apps/extension/src/site.ts`
computes it; a host that still ends in a dot after stripping one has no site.

**Approvals are stored one key per site.** An "always" answer is the `storage.local` key
`site:<site>` holding `{ "grantedAt": "<ISO 8601>" }`, written and removed one key at a time,
so the prompt and the settings page never race on a read-modify-write. A key that is not
`site:` followed by exactly what `siteOf` gives back, or whose value is not an object with an
own string `grantedAt`, is ignored and logged as a warning, never honoured. The settings page
(`options.html`, in the add-ons manager) lists these sites with a Revoke button each.
Approvals for one session only live in the background's memory, keyed by the MCP session id.

**Who may write a grant.** `storage.local` is writable from every extension context, including
content scripts the extension injects into web pages. So, next to the per-frame rule below:
scripts Foxhand injects into web pages never read or write `storage`; grants are written only
by the extension's own pages and its background. Nothing in the extension is test-only, and no
native-messaging method writes settings; the end-to-end tests seed settings through the
settings page ([0008](0008-e2e-tests-act-in-extension-pages-through-bidi-and-marionette.md)).

**Tabs on unapproved sites are redacted.** Every tab that `tabs_list`, `tab_open` and
`navigate` return carries its URL and title only while its current URL is on a site approved
for the session (stored, or for this session). Any other tab shows its site as the URL and an
empty title; `about:blank` shows `about:blank`, any other page that is not a website only its
scheme (a local file shows `file:`), and a URL that cannot be parsed shows nothing. A tab that
is still loading shows no title, since Firefox can report the new URL before the new title.
When the settings cannot be read, the call fails instead of returning unredacted tabs.

**The gate runs before the request.** `tab_open` with a URL, `navigate` with a URL and
`navigate` `reload` check the target site before anything is sent, so a fooled agent cannot
leak data in an address on a site nobody approved before the user is asked.

**The prompt is an extension page loaded into the tab**, which web content cannot cover or
click. It is answered only by a trusted click (`event.isTrusted`) on a button that is armed: a
short delay after the page is visible and focused, so a click meant for the replaced page cannot
land on it. Nothing arriving over native messaging can answer it. It offers three answers:
"Allow this session" grants the site to this MCP session only; "Always allow" stores the grant
until the user revokes it; "Don't allow" fails the request and is remembered for the session.

**Each session has a prompt budget**: at most one open prompt, and no more prompts once three
were refused or closed without an answer, so a fooled agent cannot loop on prompts with a new
host each time.

**The per-frame rule.** Every later tool that reads or acts in page content checks the URL of
each frame it touches against the same view of approved and blocked sites, not only the tab's
top-level URL.

Until the prompt exists, nothing is gated: the agent can open any web address, a tab on a site
without a stored grant is only redacted, and a site can be approved only by a stored grant.
The release check refuses a release whose listed safeguards are not built, so the add-on
cannot ship claiming a prompt it does not have.

## Alternatives rejected

- **The registrable domain (eTLD+1) as the site.** It needs the public suffix list: a package,
  or about 250 KB of bundled MPL-licensed data with a refresh routine that Mozilla's reviewers
  would read too. Origins need no data and give narrower grants: approving
  `https://mail.example.com` does not approve `https://pay.example.com`. The cost is more
  prompts on sites that span hosts.
- **Asking after the page loaded.** The request, and any data the agent put in its address,
  would already have reached the site.
- **An overlay injected into the page as the prompt.** The page could hide, cover or click it.
- **Returning full URLs and titles for every tab in the group.** Tabs the user moved into the
  group, or that a page or the user navigated elsewhere, would show the agent private URLs and
  titles of sites nobody approved.

## Consequences

Two paths cannot be gated before the request, so the add-on listing must disclose both once
the gate ships.
`navigate` `back` and `forward` can land on an unapproved site already in the tab's history;
the result is redacted. A page on an approved site can redirect to an unapproved one before any
prompt, an open redirect that carries data the agent put in the approved URL included; the
result is redacted, but the data has left.

Sites that span several hosts ask once per host.

A slow answer followed by a slow load can together exceed the host's 60 s request timeout
(`apps/server/src/host.ts`). The answer is recorded either way, so the agent's retry succeeds.
