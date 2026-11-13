# 0046: An agent can ask for a task's sites on one page, granted for the session by one click

**Status:** Accepted, 2026-11-13.

## Context

[0007](0007-per-site-approval-and-tab-redaction.md) asks the user once per site, in the tab
that is about to load it, and [0035](0035-recipes-saved-and-run-only-by-a-user-click.md)
added one exception: the sites of a recipe the user saved are granted for a session by one
click on an extension page. A task without a recipe that spans several sites still interrupts
the user once per site: each `tab_open` on a new site waits up to 30 s for its own prompt, and
a missed prompt costs the agent another round trip.

Letting the agent name the sites moves the approval boundary: the list now comes from the
agent, which a page it read may have fooled, not from a recipe the user saved. A fooled agent
could ask for many sites at once, or keep asking, hoping for a click without reading.

## Decision

- `request_sites` (method `sites_request`) takes a list of addresses. The extension reduces
  each to its site exactly as a recipe's sites are reduced (`siteOfEntry` in
  `apps/extension/src/recipes.ts`), collapses duplicates in the agent's order, and refuses with
  `invalid_params`, before any page opens or any setting is read, a list with an entry that is
  not an http or https address, has a user name or a wildcard, or a host over 253 characters,
  or a host that is neither an IP address nor dot-separated labels of 1 to 63 letters, digits,
  hyphens or underscores (the page shows each host as it is, and punctuation would let the
  agent write sentences there), and a list of more than `MAX_RECIPE_SITES` (20) distinct sites. It never trusts the MCP
  server's schema for these bounds (`sitesRequest` in `apps/extension/src/handlers.ts`).
- The request reuses the recipe run page (`run.html`, `apps/extension/src/recipe-prompts.ts`):
  one page in the session's tab group lists each site in full with its state and a fixed intro
  from Foxleash; nothing else from the agent reaches the page.
- Only a trusted click on the page's armed Allow button grants anything: the page sends its
  answer only on an `isTrusted` click after the buttons armed, and the extension takes it only
  from the port `portShowsPage` ties to the page's URL and tab. Allow grants the askable sites
  for this session only, never always; `allowForSession` reads the states again after the click,
  so the blocklist and the session's refusals still win. Sites already allowed, blocked or
  refused in the session are not asked; when none is askable the call returns at once without a
  page.
- Don't allow fails the call (`sites_refused`) and refuses no site: each still asks on its own
  when opened, as for a recipe. Closing the page fails it (`recipe_prompt_closed`).
- A request page shares every limit of the recipe pages: one page at a time per session, across
  propose, run and request pages; none beside an open site prompt; none once the session's site
  prompts stopped asking; and one budget of three pages discarded, refused or closed without an
  answer. Two calls for the same set of sites share one page and one click; a recipe and a
  request never join each other's page.

## Alternatives rejected

- **An "always" option on the page.** One click on a list an agent wrote would widen the stored
  grants for every later session, the reason 0035 has none for recipes.
- **Free text from the agent explaining why it needs the sites.** A fooled agent would write
  whatever makes the user click; the page shows only the sites and Foxleash's own words.
- **A separate budget or page kind for requests.** A fooled agent could alternate between
  recipe pages and request pages to be asked six times instead of three, and a second page kind
  would duplicate the run page's handling of trusted clicks, closing and session ends.

## Consequences

- A user who clicks Allow without reading grants up to 20 sites the agent named for the rest of
  the session, as a user who allows each site's prompt without reading does one at a time. The
  page shows every site in full, and grants end with the session.
- A host's labels can still spell words; the page's intro says that only the addresses come
  from the agent.
- Don't allow refuses nothing, so a fooled agent can still open each site and get its own
  prompt; after three refused or closed request pages the session gets no more pages.
- Sites outside the list still ask one by one; nothing in the site prompts changes.
