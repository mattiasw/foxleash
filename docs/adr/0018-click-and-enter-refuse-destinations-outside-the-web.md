# 0018: click and Enter refuse every destination outside the page's site, not only other web sites

**Status:** Accepted, 2026-10-23. Supersedes the rule of
[0014](0014-act-tools-synthesize-pointer-input-in-the-page.md) and
[0017](0017-text-input-and-keys-without-key-event-defaults.md) that only http and https
destinations are checked.

## Context

`click` and `press_key` Enter refuse a link or form that leads to another site, so a fooled
agent cannot send what it read to another site by putting it in an address. The check compared
only http and https sites and let every other scheme through. A `mailto:` link, or a
`method="post" enctype="text/plain"` form with a `mailto:` action, which puts the field values
in the mail body, therefore sent what the agent typed or read to an address outside the approved
site. Whether Firefox hands the `mailto:` of a synthetic click to a mail handler without user
activation is unverified; the decision does not depend on it.

## Decision

`crossSiteDestination` in `apps/extension/src/page-actions.ts` resolves the destination
against the element's base, as before, and then decides by the parsed scheme:

- `javascript:` goes ahead: it runs page script and navigates nowhere by itself.
- `http:` and `https:` go ahead on the page's site and are refused on any other, naming that
  site, as before.
- `blob:` goes ahead when its origin is on the page's site and is refused otherwise, opaque
  origins included.
- Every other scheme (`mailto:`, `tel:`, `data:`, `about:`, `file:`, `web+` handlers, any
  other) is refused.

A destination that does not parse goes ahead, since the browser does not navigate to it, and a
base that does not parse refuses everything. A refusal outside the web names only the scheme,
never the address, which can carry the data. `leavesSiteText` in the same file words the
refusal for both tools: a page on another site points the agent to `navigate`; an address
outside the site says that `navigate` does not open it either.

## Alternatives rejected

- **Refusing only `mailto:` and `tel:`.** Protocol handlers are open-ended (`web+` schemes,
  desktop handlers the user installed); a list of allowed schemes fails closed.
- **Refusing `javascript:` too.** Page script can do the same from a click listener, and many
  pages' buttons are `javascript:` links.
- **Echoing the full address in the refusal.** The address can carry the data the refusal is
  meant to keep in the page.

## Consequences

- Links to `tel:`, `about:`, `data:` and other addresses outside the web are refused even where
  harmless, erring on the safe side as ADR 0014 accepts. The likeliest are `data:` download
  links, such as "export CSV" buttons.
- A `javascript:` link may still navigate anywhere, or open an email address, with its own
  script: the same accepted gap as a page's click listener.
- A `blob:` of the page's own origin opens.
