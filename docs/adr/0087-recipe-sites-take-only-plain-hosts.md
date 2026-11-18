# 0087: Recipe sites take only plain hosts

**Status:** Accepted, 2026-11-18.

## Context

`hasPlainHost` (`site.ts`) bounds the hosts a page may show as they are: at most 253 characters,
and labels of 1 to 63 letters, digits, `_` and `-`, or an IPv6 address. The site prompt applies
it (`refuseIfNotPlain` in `site-access.ts`) and `request_sites` applied it (`requestedSite` in
`handlers.ts`, ADR 0046). Recipes did not: `siteOfEntry` checked only the 253-character limit
and the wildcard, so `propose_recipe` could put a site such as
`https://accounts.google.com(verified-by-foxleash).evil.example` on the propose page, the run
page then listed it as "will be allowed for this session", and after the click `tab_open` went
through, because `check` allows a granted site before `refuseIfNotPlain`.

## Decision

Every page where a user's click grants an agent-given site applies `hasPlainHost`:

- the site prompt, through `refuseIfNotPlain`;
- the propose page, its Save and the settings page's recipe editor, through `checkRecipe` and
  `siteOfEntry` in `recipes.ts`, which reports such a site's line as "this address's host is not
  a domain name or an IP address.", after its length and wildcard checks;
- `request_sites`, through `siteOfEntry`, with the same message as before;
- `start_recipe`: `run` in `recipe-prompts.ts` refuses with `invalid_url`, before any page opens
  and charging no recipe page budget, a stored recipe that lists such a site, naming the recipe
  and the first such site;
- the grant itself: `allowForSession` in `site-access.ts` skips such a site whatever its caller
  passes.

A recipe already stored with such a site keeps reading (`recipeOf` and `readRecipes` are
unchanged): `list_recipes`, `get_recipe` and the settings page show it, and the editor's Save
reports the line until the user fixes it. Grants already made (a stored always-grant, a session
grant) keep working in `check`, as the site prompt's rule left them.

Extends [0035](0035-recipes-saved-and-run-only-by-a-user-click.md) and
[0046](0046-agents-ask-for-a-tasks-sites-on-one-page.md).

## Alternatives rejected

- Refusing such a recipe in `recipeOf`: it would vanish from the settings page with only a
  console warning, so the user could not see or fix it, and `saveRecipe`'s comparison with the
  stored value would treat it as absent.
- Dropping the site silently from the run page: the page and the result would hide from both the
  user and the agent that a listed site was not asked.
- Guarding only `allowForSession`: the run page would still list the site as "will be allowed
  for this session" and then not allow it.

## Consequences

A user with such a recipe must remove the site on the settings page before `start_recipe` runs
it. The run page (`run.ts`) and `askForSites` are unchanged and get no new site state. A new
page that grants an agent-given site must apply `hasPlainHost` too.
