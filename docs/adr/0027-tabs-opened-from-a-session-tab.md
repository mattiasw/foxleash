# 0027: Firefox decides where a tab that a session's page opens goes

**Status:** Accepted, 2026-10-24.

## Context

`click` and `press_key` Enter refuse only destinations on another site or outside the web
([0014](0014-act-tools-synthesize-pointer-input-in-the-page.md),
[0018](0018-click-and-enter-refuse-destinations-outside-the-web.md)), so a same-site link or
form with target `_blank` is clicked. Foxleash reads no `openerTabId` and reaches only tabs in
the session's group (`tabs_list` and the act tools), so a new tab outside the group would be
out of the agent's reach and a stray tab for the user.

Measured in the pinned end-to-end Firefox, 156.0.1, headless. A session tab opened with
`tab_open` showed a same-site page with `<a target="_blank" href="/a">` (implicit noopener),
`<a target="_blank" rel="opener">` and `<form action="/a" method="get" target="_blank">`;
`click` clicked each by ref, the first link also at a point, and every tab was read with
`browser.tabs.query({})`.

- **Pop-up blocker on** (`dom.disable_open_during_load` `true`, Firefox desktop's default):
  the links and the form opened no tab within 6.5 s, and the session tab stayed on its page
  and stayed active. Firefox counted the pop-up as blocked: the session tab's
  `popupAndRedirectBlocker.getBlockedPopupCount()` was 1 within 15 ms of the click result.
  `press_key` Enter on the link and on the form button did the same, and its result still said
  `{"action":"clicked","prevented":false}`. A page script's `window.open` returned `null`. A
  trusted click in the page (WebDriver) right before Foxleash's click let the tab through, by
  the transient user activation it gives the page.
- **Pop-up blocker off**, the value Firefox's remote agent sets as recommended when the
  profile sets none (so the end-to-end profile ran with it until now): each click opened one
  tab in the session tab's group and window, `openerTabId` set to the session tab, active,
  right after it; `tabs_list` listed it with its title.
- **Pop-ups allowed for the site** (the site's `popup` permission, which Firefox's per-site
  pop-up exceptions store): the link, the form and `press_key` Enter on the link each opened
  one tab in the session's group, `openerTabId` set. With the group collapsed and the session
  tab in the background, the tab still joined the group and Firefox expanded the group. A
  click handler calling `window.open(url, "_blank", "width=400,height=300")` opened a new
  pop-up window, its tab in no group.
- **Pop-ups allowed and `browser.link.open_newwindow` 2** (links open in new windows): the
  link and the form each opened a new normal window, its tab in no group.

Firefox's source in that build agrees: `Tabbrowser.sys.mjs` inserts a tab with
`tabGroup: tabGroup ?? openerTab?.group` and expands a collapsed group that gains a tab. So a
tab the user opens from a link in the agent's tab joins the agent's group too.

## Decision

No extension code. Firefox already puts a new tab opened from a session tab in the same
window into the session's group, and a synthetic click under the pop-up blocker opens
nothing.

- The end-to-end profile keeps the pop-up blocker on (`buildUserJs` in `e2e/firefox.ts`), so
  the tests see what users see. `firefox.allowPopups(origin)` sets a site's `popup`
  permission, `firefox.resetPopups(origin)` removes it and `firefox.blockedPopups(url)` reads
  Firefox's blocked count for a tab; `e2e/act.test.ts` pins both outcomes for a link and a
  form button, and the blocked one for Enter on the link and in the form's field.
- The `click` and `press_key` descriptions in `apps/server/src/tools.ts`, the server
  instructions, the README and the add-on listing say what happens: the pop-up blocker stops
  such a link or form unless the user allows pop-ups for the site or has just clicked in the
  page; a new tab that opens in the same window joins the session's group; a new window is
  out of reach; the agent checks `tabs_list`, or opens a link's address with `tab_open`.
- The results of `click` and `press_key` do not change.

## Alternatives rejected

- **Report the new tab in click's result.** Firefox creates the tab after the click event has
  been dispatched and nothing ties a created tab to one click, so the result would race
  `tabs.onCreated`. It is not needed once the tab is in the group.
- **Group the tabs Foxleash sees open from a session tab** (`tabs.onCreated` with
  `openerTabId`, then the session's group). Firefox already does this for every same-window
  tab measured. The tabs that escape are in new windows, which such a listener would leave
  alone too; moving them into the group's window would undo the window the page or the
  user's setting chose.
- **Open a target `_blank` link's address with `tabs.create` from `click`.** It would step
  around the pop-up blocker the user keeps and change what `click` does.

## Consequences

An agent on a site without allowed pop-ups gets no tab and a result that reads as success; the
descriptions tell it to check `tabs_list`, or to use `tab_open` for a link. A form's request
has no such way round, since a GET of its action is not the form's request. Firefox shows its
pop-up bar in the session's tab, where the user can allow pop-ups for the site.

A new window that a page in the group opens (window features, or Firefox set to open links in
new windows) is outside the group, out of the agent's reach, and stays with the user.

A tab that a page in the group opens, after the agent's click or the user's own, joins the
group and reaches the agent like any group tab, under per-site approval and redaction
([0007](0007-per-site-approval-and-tab-redaction.md)): joining the group never approves a
site, so a tab on a site the session is not approved for reaches the agent redacted to its
site and the act tools refuse it. The README and the listing say so.

Not measured: a user's middle-click or "Open Link in New Tab" in the agent's tab (Firefox's
source passes the opener's group for every tab it inserts with an opener), and
`browser.tabs.insertRelatedAfterCurrent` false (the same source line passes the group
regardless). Revisit on a report of a tab that a session's page opened landing outside the
session's group in the same window.
