# 0062: An open question guards only the tab selects Foxleash makes

**Status:** Accepted, 2026-11-14. Amends [0059](0059-agents-cannot-change-the-selected-tab-while-a-question-is-open.md):
bounds its accepted gaps with a rule that decides a further one, and replaces its unmeasured belief
about loads with a measurement. Amended by
[0082](0082-firefox-may-select-a-tab-for-its-sign-in-dialog-while-a-question-is-open.md),
2026-11-18: adds Firefox's sign-in dialog on a load to its accepted list. Amended by
[0083](0083-a-resize-restarts-a-questions-arming.md), 2026-11-18: refuses resize_window while the
session's question is open, and restarts a question's arming on a resize.

## Context

[0059](0059-agents-cannot-change-the-selected-tab-while-a-question-is-open.md) keeps a session's
open question in view: while it is open, the session's `tab_select` of any other tab is refused
and `tab_open` leaves its new tab unselected. It lists four accepted gaps, but no rule that decides
whether a fifth is a gap or a defect, and its gap for a load in a tab whose page asks to confirm
leaving it was a belief, not a measurement.

We measured it in Firefox 156.0.1, headless, with
`dom.require_user_interaction_for_beforeunload` set to false, which stands in for the user's
interaction with the page, and "Open each agent session in its own window" off. One session had a
site prompt open in its own group tab, selected. Each case opened a page that asks to confirm
leaving it with `tab_open` (the tab opened unselected, as 0059 says), selected the question's tab
again with `tab_select`, then made the call:

| Call | Selected while the leave prompt is open | Selected after the user leaves the page |
|---|---|---|
| `tab_close` | the page's tab | the tab closed; Firefox picked the next tab |
| `navigate` to a URL | the page's tab | the page's tab, on the new URL |
| `navigate` reload | the page's tab | the page's tab |
| `navigate` back | the page's tab | the page's tab, on the earlier page |
| `navigate` forward | the page's tab | the page's tab, on the later page |

The prompt opened 42 to 91 ms after the call, and the tab was still selected a second later. So a
load the agent starts in such a tab gets the same dialog and the same select as a close, and after
the user leaves, Firefox does not select the question's tab again. The end-to-end tests in
`e2e/tab-close.test.ts` now pin these selects, beside a control in which the same calls on a page
that does not ask leave the question's tab selected. Two things seen on the way, not asserted: a
reload, back or forward returns after its one-second load wait with the page still shown while the
dialog holds the load, and the load of the page's address that follows a history step
([0051](0051-history-steps-load-the-page-again-with-get.md)) can raise the same dialog.

## Decision

**The bound.** 0059's guarantee covers every tab select and window focus Foxleash makes for a
session: each `tabs.update` or `tabs.create` with `active: true` (`tabs.create` selects unless
`active: false` is passed) and each `windows.update` or `windows.create` with `focused: true`
either shows the question itself or is decided by `keepPromptInView` or `selectNewTab` in the same
turn as the select. The calls, in `apps/extension/src/`:

- Guarded: `tabSelect` (`keepPromptInView`, then `tabs.update` with `active: true`) and
  `selectNewTab` (selects only when `asking` is false; used by `tab_open`'s blank tab, `openOnPage`
  and `openOnPrompt`), in `handlers.ts`. `keepPrompt`, also in `handlers.ts`, refuses `navigate`
  and `tab_close` of the question's own tab; without it such a load would replace the question
  with no select at all, so it is part of the guarantee.
- Created unselected: every `SessionGroups.createTab` call passes `active: false` (`handlers.ts`:
  the blank tab, `openOnPage`, `openOnPrompt`; `recipe-prompts.ts`: the propose and run pages).
  The one tab it hands back already selected is the blank tab of a window `openOwnWindow` has just
  opened, which Firefox opened selected in that window: the accepted case of the session window
  below.
- Removals: `tab_close` and `tab_open`'s cleanup remove a tab through `SessionGroups.closeTab`,
  after `keepPrompt`, so never the question's own tab; Firefox selects another tab only when the
  removed one was selected, which while a question is open is a tab the user selected (accepted
  below). The session's end removes its tabs and ends its question with them. `windows.remove`
  closes only the session's own window: at the session's end, when it holds nothing but its unused
  first tab, or when it failed to take the session's tab, so never a window showing a question.
- The question's own: `SiteAccess.show` in `site-access.ts`, the propose and run pages'
  `tabs.update` with `active: true` in `recipe-prompts.ts`, and `SessionGroups.showPromptWindow`'s
  `windows.update` with `focused: true`
  ([0057](0057-prompts-bring-the-sessions-own-window-to-the-front.md)).
- Grouping: `SessionGroups.ensureGroup` (`tabs.group`, `session-groups.ts`) groups only tabs
  `createTab` has just made unselected, in the window `createTab` chose. Whether Firefox selects a
  tab that `tabs.group` moves to another window is not measured; the only tabs it moves are such
  new, unselected tabs.
- The session's own window opens with `windows.create({ focused: false })` (`openOwnWindow` in
  `session-groups.ts`), only for a session with neither a tab group nor a window of its own, and
  Firefox may still focus it (0057). A session with an open question has its group, so this is
  reachable then only after the user took the question's tab out of the group, leaving it empty,
  and the session has no window of its own (the setting was turned on after the session started,
  or the user closed that window). See the accepted list below.
- Not a select: `drawAttention` (`site-access.ts`, `recipe-prompts.ts`, `session-groups.ts`);
  `resize_window`'s `windows.update` with `state: "normal"` on the group's window, which holds the
  question's tab (0059) unless the user took that tab out of the group; and the settings page
  `indicator.ts` opens when the user clicks the toolbar button, a select the user makes.

The checkpoint for the bound is `apps/extension/src/browser-api.ts`. `BrowserApi` types
`tabs.create`'s `active` and `windows.create`'s `focused` as required and has no `tabs.move`,
`tabs.highlight` or `tabs.duplicate`. Five of its calls can select a tab or focus a window without
passing `active` or `focused`: `runtime.openOptionsPage` (it selects the settings tab),
`tabs.remove` of a selected tab and `windows.remove` of the focused window (Firefox selects or
focuses another), `windows.update` with `state: "normal"` (Firefox may focus the window it
restores) and `tabs.group` (it moves a tab between windows). So a new call that can select a tab
or focus a window is a change to that interface, a call that passes `active` or `focused`, or a
new call to one of these five. A future Foxleash call that selects a tab or focuses a window must
meet this bound: that is a rule, not a gap.

**Outside the bound, accepted.** Selects and focuses Firefox makes itself because of a page's
behaviour or the user's, and other sessions' selects:

- the leave dialog on `tab_close` and on every load `navigate` starts (a URL, a reload, back,
  forward, and the load of the page's address after a history step), measured above;
- the same dialog on a navigation an act starts (a `click` on a link, a `press_key` or `fill_form`
  that submits a form) or the page starts itself (`location`, `history`, a form's own submit), not
  measured: Firefox's dialog selects the tab whoever started the load, and refusing these would
  mean refusing the acts;
- tabs a page opens or selects (`target=_blank`, `window.open`), also after the agent's click;
- a `tab_close` of a group tab the user selected, after which Firefox picks the next tab;
- the focus Firefox gives a session window Foxleash opens with `focused: false` (0057), and
  `resize_window` restoring the group's window, while a question is open: both are reachable only
  after the user took the question's tab out of the session's group (and for the window, also with
  no session window), so the question is no longer where 0059 guards it, and refusing them would
  mean refusing `tab_open` or `resize_window` for a session whose group the user emptied;
- the downloads panel Firefox may open when `download` starts a download
  (`browser.download.alwaysOpenPanel`), not measured: if it takes the keyboard focus, a key meant
  for the question goes to the panel, and refusing it would mean refusing `download` while the
  agent waits;
- other sessions' selects and focuses, including those that show another session's question, for
  0059's reasons.

**The test for a further instance.** A select or focus is accepted when Foxleash does not make it
and closing it would mean refusing a tool a well-behaved agent uses on its other tabs while it
waits (`tab_close`, `navigate`, the acts). Otherwise it is refused, or fixed the way
`keepPromptInView` fixed `tab_select`. A new accepted instance is added to this list by a later
record, not by a new code path.

**The leave dialog** is accepted. Firefox shows it only on a page the user has interacted with,
and then the dialog, not the page's fields, is in front of the user. The risk stays: an Enter meant
for the question answers Firefox's dialog, which can close the user's page or leave it, and after a
load the tab stays selected on the page the agent's load brought, with the question behind it
until the user selects the question's tab.

The add-on listing's claim that the agent cannot select another tab of its group while Foxleash is
asking (`docs/amo/listing.md`) is about the selects Foxleash makes, which the bound covers, and
README tells the user about the dialog's select.

## Alternatives rejected

- Refusing every `tab_close` and `navigate` of other tabs while a question is open: it stops the
  parallel work an agent and its subagents do in their other tabs, and agents sharing a session
  share its group ([0038](0038-agents-sharing-a-session-share-its-tab-group.md)).
- Refusing them only for a page that has had user activation, read as
  `navigator.userActivation.hasBeenActive` through a content script: an await between the check
  and the close or load, a read in every frame, and frames where no content script runs.
- Selecting the question's tab again once the user answered the dialog: after "Stay" it moves the
  user away from the page they chose to stay on; after "Leave" the user is looking at that tab, and
  `tabs.onActivated` does not say who selected a tab, so Foxleash cannot tell the dialog's select
  from one the user made and would switch tabs under the user.
- For other sessions, recording the question tab's window when the question is shown and refusing
  every session's `tab_select` and selected `tab_open` in that window. It needs no new await
  (`groupTab` and `createTab` return the window), but `site-access.ts` and `recipe-prompts.ts`
  would have to expose it. With the setting off every session shares the user's window, so one
  session's open question would refuse every other session's selects there, and a session could
  stall the others by keeping a question open. The user sees the switch in the window they are
  using, and that window is not brought to the front for a question (0057).

## Consequences

The leave dialog's risk above stays. The end-to-end tests pin Firefox's behaviour, so a Firefox
that stops selecting the tab for the dialog fails them when `bin/firefox-version.json` moves.
Revisit if Firefox lets an extension close or load a tab without the unload check, or if a report
shows the dialog used to hide a question.
