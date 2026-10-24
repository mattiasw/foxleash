# 0029: `tab_open` loads a page in a tab created unloaded on it, grouped before it loads

**Status:** Accepted, 2026-10-24.

## Context

`tab_open` must never load a page outside the session's tab group, so it used to create the tab
on `about:blank`, put it in the group, wait for Firefox's own `about:blank` load in the tab to
commit, and only then load the page. The context of
[0025](0025-history-loads-and-autofilled-fields.md) describes that order: the wait for the
blank commit kept the tab's session history at just the page when the tab was opened.

It did not survive Firefox unloading the tab to save memory. Measured on Firefox 156.0.1,
headless: after an unload and a select, every `tab_open` tab had an `about:blank` entry after
its page (54 of 54), so Forward led to a blank page, and in 5 of them the blank entry was the
current one, so the tab came back blank. With no extension installed, a tab created on
`about:blank` that then loaded a page did the same (15 of 15 and 10 of 10), while a tab created
directly on its URL restored clean (22 of 22). It is Firefox's restore behaviour for a tab that
started on `about:blank`.

Firefox can create a tab on its URL without loading it (`tabs.create` with `discarded: true`,
which Firefox allows only for a tab that is not selected). In a chrome-context experiment on the
same Firefox, a tab created that way, put in a tab group, then selected, which loaded it, then
unloaded and selected again kept only its page in its history, 5 of 5; the control, a tab
created on `about:blank` that loaded the page a second later, had the `about:blank` entry after
it, 5 of 5. The end-to-end test in `e2e/tabs.test.ts` checks the extension's own path.

Selecting a tab Firefox has not loaded does not load its URL the way `tabs.update({ url })`
does: the session store restores the tab and reloads its one history entry, a history load,
which takes the page from the HTTP cache without asking the server unless the response was
`no-store`. A page the user visited before would then show its cached copy.

## Decision

With a URL on a site the session may act on, `tab_open` creates the tab with
`{ url, active: false, discarded: true }` (in the window of the session's group when it has
one), puts it in the session's group, loads the page in it with
`tabs.update({ url, loadReplace: true })`, which replaces the tab's one history entry, waits
for that load, and then selects the tab (`tabOpen` and `openOnPage` in
`apps/extension/src/handlers.ts`). A tab whose grouping fails is closed, since selecting it
later would load the page outside the group.

`tab_open` without a URL, and the tab for an approval prompt, still start on `about:blank`,
grouped first and after the blank commit: the prompt needs a tab before anything loads.

## Alternatives rejected

- Create the tab on `about:blank`, group it, then load the page (the previous order): the
  stray `about:blank` entry after an unload, with Forward to a blank page and sometimes a blank
  tab.
- Create the tab selected on its URL: the page loads before the tab is in the group.
- Create it on its URL, not selected but loaded, and group it at once: the page still starts
  loading before the tab is in the group.
- Create it unloaded, group it, then select it so that Firefox loads it: the page comes from
  the cache as a history load.

## Consequences

The page still loads only in the group, except when the new tab is selected in the moment
between its creation and its grouping: by the user's click, or by Firefox itself when the
selected tab in that window closes in that moment (by the user, the page's own
`window.close()`, or another session's `tab_close`) and Firefox selects the neighbouring new
tab. The site is one the session may act on either way, but the console and network recording
that starts at the top-frame commit for tabs in the group
([0015](0015-console-recorder-in-the-page-world.md),
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md)) may miss
that first document. Accepted: the window is the time of one grouping.

The new tab is selected only once its page has loaded, so it loads in the background.

Two paths still start a tab on `about:blank` and are not measured for this restore behaviour:
the tab for an approval prompt, and `tab_open` without a URL followed by `navigate`. Revisit if
Firefox changes how it restores a tab that started on `about:blank`, or if those paths show
the entry.
