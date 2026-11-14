# 0059: Agents cannot change the selected tab while a question is open

**Status:** Accepted, 2026-11-14. Amended by
[0062](0062-an-open-question-guards-only-the-tab-selects-foxleash-makes.md), 2026-11-14: its
accepted gaps are bounded to the selects Foxleash does not make, and the leave dialog on a load is
measured.

## Context

A question Foxleash asks the user (the site prompt, or a recipe page: the propose page, the run
page for a recipe or for `request_sites`) selects its own tab when it is shown. Until now nothing
stopped the agent from selecting another tab after that: `tab_select` of any tab of its group,
or a `tab_open` that selects its new tab. The question was then hidden behind a page the agent
chose.

With "Open each agent session in its own window" on, the session's window takes focus when
Firefox creates it ([0044](0044-each-agent-session-in-its-own-window.md)) and is brought to the
front for a prompt ([0057](0057-prompts-bring-the-sessions-own-window-to-the-front.md)), so the
keys the user types next can reach a focused field of that page instead of the question (not
reproduced in a browser). [0058](0058-prompt-keys-answer-only-on-a-button-focused-after-arming.md)
hardens the prompt's buttons against those keys; this record keeps the question in view. With
the setting off, the same switch happens in the user's own window.

## Decision

For both values of the setting, in `apps/extension/src/handlers.ts`:

- While the session's site prompt or recipe page is open, `tab_select` of any tab other than the
  question's own is refused. `keepPromptInView` throws `approval_pending` for a site prompt and
  `recipe_prompt_open` for a recipe page, with the wordings those codes already carry; selecting
  the question's own tab works as before.
- While one is open, `tab_open` leaves its new tab unselected, and its result reports
  `active: false`. `selectNewTab` selects the new tab only when `asking` says no question is
  open, and otherwise reads it with `tabs.get`. The blank tab is created unselected and selected
  through `selectNewTab` too, like the tabs on a page.
- With no question open, both tools behave as before.

Every check runs in the same turn as the select it guards, after the last await before it.
A question shown by a parallel request is then either seen by the check, or shown after the
select started; showing it selects its own tab again (assumed, not measured: Firefox applies an
extension's `tabs.update` calls in the order they are issued). A decision taken earlier would
not hold: the blank tab's `createTab` can wait in the session's queue behind other tabs, and a
question the agent shows meanwhile would be hidden by a tab created selected.

No window is compared. A session can select only tabs of its own group, Firefox keeps a tab
group's tabs in one window, and the question's tab is in that group when it is shown. Refusing
every other tab of the group therefore refuses every select this session could make in the
question's window, without a `tabs.get` await between the check and the select. If the user
moved the question's tab out of the group, the refusal is broader than needed, which is
harmless.

## Alternatives rejected

- Comparing the target tab's window with the question tab's window: an await between the check
  and the select, and the group already pins one window.
- Selecting the question's tab again afterwards: the agent's page was already shown and could
  take keys meanwhile.
- Refusing `tab_open` outright: a well-behaved agent may open tabs in parallel, and leaving the
  new tab unselected is enough.
- Deciding the blank tab's `active` when the request arrives: a question shown while `createTab`
  waits in the session's queue would be hidden.

## Consequences

A well-behaved agent waits on the answer anyway. While a propose page is open (`recipe_propose`
returns at once), the agent cannot select other tabs until the user answers or closes it, as it
already cannot open a site prompt beside it; this holds for every subagent or parallel agent that
shares the session's connection ([0038](0038-agents-sharing-a-session-share-its-tab-group.md)).
A blank `tab_open` makes one more `tabs.update` call.

Accepted gaps:

- A tab a page opens or selects itself (after the agent's click, `target=_blank`,
  `window.open`) may still be selected by Firefox.
- Firefox selects a tab to ask the user whether to leave its page, so the agent's `tab_close`
  of a tab whose page asks that selects it (read in Firefox 156's tab browser, not reproduced),
  and a load in it presumably does too. Firefox asks only on a page the user has interacted
  with, and the user then sees that question in front of the page, not the page's fields.
  Refusing every close and load while a question is open would stop an agent's parallel work in
  its other tabs.
- The check is per session. With the setting off, a question in the user's own window selects
  its tab there, and another session's `tab_select` or `tab_open` can still change that window's
  selected tab. That window is not brought to the front for the question, the user sees the
  switch in the window they are using, any session can already change it when nothing is asked,
  and it takes a second session fooled separately. With the setting on, each session has its own
  window.
- When the user selected another tab of the group, a `tab_close` of that tab lets Firefox pick
  the next selected tab.
