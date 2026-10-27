# 0030: The tab for an approval prompt is created unloaded on the prompt page

**Status:** Accepted, 2026-10-27. Supersedes the consequence of
[0029](0029-tab-open-loads-a-page-in-a-tab-created-unloaded-on-it.md) that the tab for an
approval prompt still starts on `about:blank`.

## Context

[0029](0029-tab-open-loads-a-page-in-a-tab-created-unloaded-on-it.md) measured that Firefox 156
restores any tab that started on `about:blank` and then loaded a page with an `about:blank`
entry after the page (54 of 54, and 15 of 15 without the extension), while a tab created on its
URL restores clean. It fixed `tab_open` on a site the session may act on, and left two paths
starting on `about:blank`: the tab for an approval prompt, and `tab_open` without a URL followed
by `navigate`. A check in a desktop Firefox after 0029 saw Forward enabled on both after Unload
Tab.

The prompt's tab is the first tab of every session on each new site. Measured in headless
Firefox 156.0.1 with the extension installed: the tab unloaded, another tab selected, the tab
selected again, and its session history read 1.5 s and 3 s later.

| Path | History after restore |
|---|---|
| Prompt tab created on `about:blank`, as before | page, then `about:blank`: 3 of 3 |
| Tab created unloaded on the prompt URL, grouped, prompt loaded with `loadReplace`, page loaded with `loadReplace` after Allow | page only: 5 of 5 |
| Same, but the tab selected before the prompt loads, then the prompt loaded with `loadReplace` | page only: 3 of 3 |
| Same tab never selected, the page loaded into it with `loadReplace` (site allowed meanwhile), then selected | page only: 3 of 3, and 4 of 4 with a slow page |
| `tab_open` without a URL, then `navigate` | page, then `about:blank`: 3 of 3 |
| `tab_open` without a URL, page loaded with `loadReplace` | page, then `about:blank`: 4 of 4, and 3 of 3 with the tab deselected first |
| Blank tab deselected, unloaded with `tabs.discard`, page loaded with `loadReplace` | page, then `about:blank`: 3 of 3 |

Firefox accepts `discarded: true` on the extension's `approve.html` URL. The unloaded tab reports
the prompt URL with `status: "complete"`, and when the prompt loads, the only `url` that
`tabs.onUpdated` reports is the prompt URL, so the prompt commits as before.

## Decision

`tab_open` on a site that needs approval asks site access for a new prompt URL
(`newPromptUrl`), creates the tab with `{ url: promptUrl, active: false, discarded: true }` (in
the window of the session's group when it has one), puts it in the group, and calls `ask` with
that URL. `ask` records the prompt and loads it with
`tabs.update({ url: promptUrl, active: true, loadReplace: true })`, which replaces the tab's one
history entry and brings the tab to the front. After Allow, the page replaces the prompt with
`loadReplace` as before.

A grouping failure, or an `ask` that shows nothing (refused, blocked, budget spent, another
prompt open), removes the tab. When the site was allowed between the check and `ask`, nothing
loads the prompt: the page loads into the unloaded tab with `loadReplace`, and then the tab is
selected. If that request then fails, the tab is removed, since it showed nothing. A tab in
which a parallel `navigate` has shown its own prompt meanwhile is kept, as `tab_close` keeps it.

The code is `openOnPrompt` in `apps/extension/src/handlers.ts`, and `newPromptUrl`, `ask` and
`show` in `apps/extension/src/site-access.ts`.

## Alternatives rejected

- Keep starting the prompt's tab on `about:blank`: the stray entry, 3 of 3.
- Create the tab selected on the prompt URL: the prompt page loads before the tab is in the
  group.
- Select the unloaded tab so that Firefox loads the prompt (clean, 5 of 5): a tab selected
  before the prompt is recorded, by the user's click or by Firefox when the selected tab closes,
  shows a prompt page that says the request has ended and never connects again, so the request
  fails after its 30 s wait. Loading the prompt URL with `loadReplace` loads it again.
- For `tab_open` without a URL: load the first page with `loadReplace` (the entry stays, 4 of 4
  and 3 of 3); unload the blank tab with `tabs.discard` before loading the page (Firefox unloads
  a deselected blank tab, and its restored history still has the entry, 3 of 3; a new `tab_open`
  tab is the selected one, which Firefox does not unload); create the tab on a blank page of the
  extension's own (the tool returns `about:blank`, and it adds a page to the package).

## Consequences

`tab_open` without a URL followed by `navigate` keeps the entry, also when the page loads
through a prompt in that tab: after Firefox unloads and restores the tab, Forward leads to a
blank page, and sometimes the tab comes back blank. Its end-to-end test is a `test.todo` in
`e2e/tabs.test.ts`. Revisit if Firefox changes how it restores a tab that started on
`about:blank`.

If the new tab is selected between its creation and its grouping, the prompt page, an extension
page and no web page, loads outside the group for that moment, and loads again in the group when
the prompt is shown.
