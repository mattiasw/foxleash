# 0057: An open question stays in view and is answered only by input made for it

**Status:** Accepted, 2026-11-14. Extends [0044](0044-each-agent-session-in-its-own-window.md)
(each agent session in its own window) and the arming of
[0007](0007-per-site-approval-and-tab-redaction.md) (per-site approval).

Amended 2026-11-14: Enter or Space answers only on a button focused while the page was armed, and
any keydown while unarmed restarts the arming second. Why: Tab in the first second, then Enter,
answered.

Amended 2026-11-14: while the session's question is open, `tab_select` of another tab is refused
and `tab_open` leaves its tab unselected. Why: the agent could hide the question behind its page.

Amended 2026-11-14: pages focus their heading when the question shows, a key answers only at the
end of an armed Tab path from before the buttons, and other presses on a button are refused and
restart the second. Why: Shift+Tab then Enter answered, and refused presses filled the pause.

Amended 2026-11-14: the tab guarantee is bounded to the selects Foxleash makes, with a test for a
further case, and the leave dialog's select is measured and accepted. Why: the gaps had no rule,
and the load case was a belief.

Amended 2026-11-14: a lone Alt holds the arming until the page sees input, and keyups restart the
second. Why: Firefox's menu bar takes the keys after it without a blur.

Amended 2026-11-14: all input that can open a Firefox menu holds, with a 100 ms join window and
listeners from page load; on purpose, an unseen Alt keyup now holds on a fresh page, and a click no
longer cancels a lone Alt. Why: F10, Shift+F10, the Menu key, a right press and Alt chords let a
Tab path answer after a menu closed with a click outside the page.

Amended 2026-11-18: Firefox's select of a tab for its sign-in dialog is accepted, and a load that
waits on the dialog fails with `sign_in_needed` and keeps its tab. Why: `tab_open` timed out after
30 s and closed the tab the user was looking at.

Amended 2026-11-18: a resize restarts the arming second, and `resize_window` is refused while the
question is open. Why: a resize moved the buttons under an armed pointer.

Amended 2026-11-19: the call that showed a question ends with `approval_timeout` when its window is
not in front 2 s later. Why: on a desktop that refused the focus, the call waited 30 s unseen.

Amended 2026-11-24: the site prompt and the run page show the warning about Firefox's access to all
websites above the answers. Its button is no answer and is not armed; whatever the warning changes
on the page restarts the arming second, as a resize does; while the request its button makes is
out, the page is not asking, and the second restarts when it settles; and a Tab path may start at
that button, also when focus came into the page from Firefox's toolbar, as it can from the propose
page's fields. Why: the warning and its status line move the answers when they change, so a click
aimed at one button could land on another; and Firefox 153 opens its prompt for the access without
taking focus (156 takes it), so keys meant for the prompt could reach the answers.

## Context

Foxleash asks the user in a page of its own, in a tab of the session's group: the site prompt
(`approve.html`), the propose page (`propose.html`) and the run page (`run.html`, for a recipe or
`request_sites`). The question must reach the user, also in the session's own window
([0044](0044-each-agent-session-in-its-own-window.md)); its buttons must answer only input made for
it, not keys typed for another window, a click aimed at what the page showed before, or keys a
Firefox menu took unseen; and the agent must not hide it. Firefox's own focus, menus and dialogs
work against each.

[The measurements behind this record](../measurements/prompts.md) give each experiment; users read
[questions stay in front of you](../security.md#questions-stay-in-front-of-you).

## Decision

### The window

- `openOwnWindow` (`session-groups.ts`) opens the session's window with `focused: false`, and the
  focus Firefox gives it anyway is accepted; the setting's help text, `docs/tools.md` and the
  listing say so.
- `SessionGroups.showPromptWindow` gets the window a question was just selected in, from `show`
  (`site-access.ts`) and `propose` and `askForSites` (`recipe-prompts.ts`). For the window Foxleash
  opened for the session, whatever the setting is now, it calls `windows.update` with
  `focused: true`, plus `state: "normal"` only when `windows.get` reports it minimized (a failed
  read still focuses); otherwise `drawAttention`. Never both, and neither for a session stopped or
  ended while the page loaded; it never rejects.
- A request that joins an open question (`join`) only draws attention and selects no tab: nothing
  limits joins.
- After `showPromptWindow`, for a live session and a question still waiting on that call, `show` and
  `askForSites` arm one check `FRONT_CHECK_MS` (2 s) later, run once the page has connected.
  `SessionGroups.windowInFront` answers `focused !== false` from `windows.get`, true when the read
  fails. A window not in front, with the same call still waiting and no answer being handled, ends
  that call with `approval_timeout`; the question stays open, and nothing is granted, refused,
  closed or charged to a budget. What stops the call's `APPROVAL_WAIT_MS` (30 s) timer stops the
  check. Joins and the propose page, which has no waiting call, get none.

Focusing grants nothing: only input on the armed page answers. No page focuses an answer button: a
page focuses its heading when the question first shows, its resting element after a refused press
and, on the propose page, after the stored recipe changed, its status element after an answer or
when the request ended, on the site prompt and the run page the warning's status line when the
warning about Firefox's access to all websites hides with focus in it, and a propose field after the
user's own save. Focus pulls are bounded per session: one question at a time, no close or load over
its tab, and `PROMPT_BUDGET` (three refused or closed site prompts) and `RECIPE_PROMPT_BUDGET`
(three discarded, refused or closed recipe pages) end the asking; a new MCP session starts new
budgets. No call focuses the user's window; no permission is added.

### The arming and the keys

In `armButtons` (`page-ui.ts`), used by all three pages, with `createArming` and `createKeyWatch`
(`prompt-arming.ts`):

- **Arming.** The buttons answer `ARMING_DELAY_MS` (1000 ms) after the page is both visible and
  focused, and disarm when either ends. Only a trusted click with `detail` at most 1 answers, and a
  pointer press only if it started armed; a refused click calls `onUnarmed("arming")`. An answer
  restarts the second. `aria-disabled` keeps the buttons focusable.
- **Focus rests before the buttons.** Each page focuses its `<h1 id="heading" tabindex="-1">` when
  the question first shows. The resting element, `rest()`, is that heading, or on the propose page
  `#current-heading` while a current version shows.
- **The Tab path.** A button's focus counts only when it arrives while armed, by `relatedTarget`,
  from its neighbouring button whose focus counts or, for the first button, from an element of the
  same document that is no answer button, precedes the buttons and does not contain them.
- **Enter and Space are decided at keydown**, in a capture-phase listener on `window`. On an answer
  button while asking, one passes only when armed and the button's focus counts; otherwise it gets
  `preventDefault()`, the second restarts, focus moves to `rest()`, and `onUnarmed("refocus")`
  announces `REFOCUS`. A held key is one press. Space is `key` " " or `code` "Space", and the click
  Firefox makes at a Space keyup answers only for the counted Space that went down on that button.
- **Restarts.** Every keydown while unarmed; while armed every keydown but a modifier, Tab while no
  counted Space is down, and a counted Enter or Space. Every keyup but that of a Tab, Space or
  non-Alt modifier seen going down since the last blur or hold. Any `resize`, through a listener
  `watch()` adds that calls `rearm`, which also voids a pointer press under way. On the site prompt
  and the run page, `rearm` also runs before each change the warning about Firefox's access to all
  websites makes (`beforeChange` of `watchWebsiteAccess`), and when the request its button makes
  starts and when it settles (`onRequest`); in between the page is not asking.
- **Holds.** Input that can open a Firefox menu disarms with no timer until the input that ends the
  hold: a lone Alt (an Alt keyup whose keydown the page saw, with no other keydown, pointer press or
  blur between); an unseen Alt keyup while the page has seen no keydown or pointer press since the
  question showed or the last blur; a keydown of F10, `ContextMenu`, or a non-modifier with Alt and
  without Control or Meta; a secondary-button `pointerdown`, or `mousedown` while another button is
  down; a `contextmenu` event, never cancelled. The keys seen going down are forgotten; for every
  trigger but a lone Alt they become the hold's opening keys. While held, an opening key's keyup or
  keydown, any Alt keyup, and any key event less than `HOLD_JOIN_MS` (100 ms) after the trigger that
  started or last joined the hold keep it; such a keydown's key becomes an opening key without
  moving the window. Any other key event, a primary press or a click ends it; time, `focus` and
  `visibilitychange` do not. The listeners run from page load; `watch()` forgets the keys seen going
  down and arms only when not held.

**The bound.** Enter or Space answers only when (1) the page has been visible, focused and not held
for a full second with no keydown, no resize, no keyup but that of a Tab, Space or non-Alt modifier
it saw go down since its last blur or hold, and no re-arm; (2) since then it saw only Tab, Shift+Tab
and modifier keydowns, and focus moved, armed, from before the buttons onto the first and on from
neighbour to neighbour to the button; (3) the Enter went down, or the Space down and up, on that
button with no disarm between. An answer ends the path. From the resting element the k-th button is
k Tabs away, k + 1 while the warning about Firefox's access shows (Save from the propose page's
`#heading` is 6); Shift+Tab alone answers nothing.

### The selected tab

- While the session's site prompt or recipe page is open, `keepPromptInView` (`handlers.ts`)
  refuses `tabSelect` of any other tab and, called with no tab by `resizeWindow`, every
  `resize_window`, with `approval_pending` or `recipe_prompt_open`. `selectNewTab` selects a tab
  `tab_open` opened, the blank one included, only when no question is open. `keepPrompt` refuses
  `navigate` and `tab_close` of the question's tab. Each check runs in the same turn as its call; a
  question a parallel request shows later selects its own tab again (assumed: Firefox applies
  `tabs.update` calls in order). No window is compared: a group lives in one window.
- **The bound.** Every tab select and window focus Foxleash makes for a session shows the question
  or is decided in the same turn: the guarded calls above; every `SessionGroups.createTab` call
  passes `active: false`, and only the first tab of a window `openOwnWindow` just opened comes back
  selected; `closeTab` runs after `keepPrompt`; `windows.remove` closes only a session window
  showing no question; `tabs.group` moves only tabs just created unselected (whether Firefox selects
  such a tab it moves to another window is not measured); `drawAttention` selects nothing. The
  settings page opens on the user's click, and the welcome page (`first-run.ts`) only at install,
  before any session.
- **The checkpoint is `browser-api.ts`**: `tabs.create`'s `active` and `windows.create`'s `focused`
  are required, there is no `tabs.move`, `tabs.highlight` or `tabs.duplicate`, and five calls can
  select or focus without them (`runtime.openOptionsPage`, `tabs.remove`, `windows.remove`,
  `windows.update` with `state: "normal"`, `tabs.group`). A new select or focus changes that
  interface, passes `active` or `focused`, or calls one of the five, and must meet the bound.
- **A further instance** is accepted when Foxleash does not make it and closing it would mean
  refusing a tool a well-behaved agent uses on its other tabs while it waits; otherwise it is
  refused or fixed as `keepPromptInView` fixed `tab_select`, and added here by an amendment.
- **Firefox's sign-in dialog.** A wait with a known URL in `waitForLoad` (`wait-for-load.ts`) hears
  the tab's top-level `onHeadersReceived` with `responseHeaders`. A `401` with `WWW-Authenticate` or
  `407` with `Proxy-Authenticate` arms `SIGN_IN_GRACE_MS` (2000 ms); a commit, a new navigation
  other than to about:blank, or a response that is no challenge clears it. When it fires, or the
  load timeout comes during it, `tab_open` or `navigate` fails with `sign_in_needed`, and
  `openOnPage` and `openOnPrompt` neither remove nor select the tab. The grace lets through a
  challenge answered without a dialog. The listener is registered without `blocking`, returns
  nothing and changes no request. Waits without a URL (reload, back, forward, the load after a
  history step of [0025](0025-history-loads-and-autofilled-fields.md)) do not listen. Loads with one
  do: the address in a tab Firefox unloaded or in place of a blank entry a reload landed on, and a
  reload on a site question the user answered.

## Alternatives rejected

- **Questions in the user's window**: breaks
  [0030](0030-approval-prompt-tab-created-unloaded-on-the-prompt.md)'s prompt tab, needs tabs moved
  between windows, and changes the user's selected tab.
- **A toolbar badge**: as passive as `drawAttention`, which the user did not notice.
- **A desktop notification**: the `notifications` permission, a listing change and the
  maintainer's decision; the next step if the early end is not enough.
- **Minimizing the new window**: unmeasured, and it hides the first question.
- **Focusing the user's window again**: misfires when the user switched windows, and Wayland may
  refuse it.
- **`drawAttention` with `focused`**: adds nothing where the window comes forward, went unnoticed,
  and is unmeasured where focus is refused.
- **`state: "normal"` on every focus**: un-maximizes and leaves full screen.
- **Focusing on a join**: unbounded.
- **`document.hasFocus()` over the port**: the same activation as `windows.get().focused`, and a new
  message in every page.
- **An early end for joins**: agents would loop, and `foxleash probe`'s 25 retries, which join,
  would last about a minute.
- **A new error code**: agents already read `approval_timeout` as "still open, call again".
- **Ignoring keys on the buttons**: breaks keyboard operation (WCAG 2.1.1).
- **A longer delay**: misses a Tab made before arming and slows every answer.
- **A delay per button from its focus**: every keyboard answer waits a second.
- **Moving focus off a focused button at arming**: focus would leave where the user tabbed, without
  an action of theirs.
- **A dwell of 300 to 500 ms on the button**: refuses fast answers; Tab completion then Enter can
  take longer.
- **Reordering the buttons alone**: does not bound the Tabs from another button.
- **Counting a focus from no element**: it comes after a window return or a click on text, from
  where the page cannot tell.
- **Keeping refused presses exempt from the restart**: they then fill the pause.
- **A resting element just before the propose buttons**: new UI for fewer Tabs; more is safer.
- **Recording the menu cases as residuals**: measured, each answers within a second of keys typed
  into a menu.
- **Restarting at a menu trigger instead of holding**: keys a menu takes later fill the pause.
- **Taking Alt out of the modifiers that keep the page armed**: the same gap as a restart.
- **Cancelling the input that opens a menu** (a lone Alt's keyup, `contextmenu`, F10): takes menus
  from keyboard users, and Firefox honouring it on an extension page is unmeasured.
- **Ending a hold at a window focus**: the menu bar across a blur is unmeasured; holding only
  delays.
- **Restarting only at unseen keyups**: a seen key whose keyup a menu took would not restart.
- **Holding when the pointer leaves the page**: every move to the toolbar would hold, and a pointer
  already outside gives no event.
- **Holding at a lone Control, Shift or Meta**: a lone Control is how screen reader users silence
  speech, and the changed access key is only in `about:config`.
- **Holding at every Control, Alt or Meta keydown**: holds at every shortcut.
- **Comparing the target tab's window**: an await before the select; the group pins the window.
- **Selecting the question's tab again**: the agent's page was already shown; after the leave
  dialog's "Stay" it moves the user off the page they kept, after "Leave" it switches tabs under
  them, since `tabs.onActivated` does not say who selected; it would hide the sign-in dialog.
- **Refusing `tab_open` outright**: agents open tabs in parallel, and an unselected tab is enough.
- **Deciding the blank tab's `active` on arrival**: a question shown while `createTab` waits in the
  queue would be hidden.
- **Refusing closes and loads of the group's other tabs while asking**: stops parallel work of the
  agents sharing the group ([0038](0038-agents-sharing-a-session-share-its-tab-group.md)).
- **Refusing them only after user activation**: an await, a read in every frame, and frames with no
  content script.
- **Guarding the question's window for every session**: with the setting off all sessions share it,
  so one question would stall the others.
- **A blocking `onAuthRequired` that cancels the challenge**: the user could not sign in to an
  approved site, and it adds a blocking listener that can change requests.
- **Hearing the challenge with `onAuthRequired`**: Firefox 160 and 153 ESR call no non-blocking
  listener for a top-level load, and a blocking one is the above.
- **Failing at the challenge, with no grace**: fails loads Firefox signs in to by itself.
- **Only one resize rule**: the page rule alone lets the asking session keep its question unarmed;
  the tool rule alone leaves other sessions' and the user's resizes.
- **Comparing the viewport size at each press**: no test reaches the interval it closes.
- **Keeping a counted Tab path across a resize**: arming logic for a bounded keyboard cost.

## Consequences

- The user's focus moves to the session's window when Firefox opens it and when a question shows in
  it. A window maximized before it was minimized comes back at its normal size, and its restore may
  take 2 s, inside the 30 s wait.
- A desktop reporting a refused window as focused keeps the 30 s wait; a window that comes forward
  and goes behind within 2 s is not noticed; a tab dragged to another window within 2 s may end the
  wait. With the setting off and a terminal in front, every new question ends the call at about 2 s;
  a user who allows before the agent calls again is told to ask the agent to retry, whose `tab_open`
  leaves the answered question's tab behind.
- A keyboard user who Tabs during the second, or after a resize, is refused once and starts again
  from the question (on the propose page with no current version, from the top of the page); Save
  answers a second after the last key typed. A screen reader's own activation answers when armed;
  one moving focus with no `relatedTarget` would be refused once (unverified hypothesis). Pointer
  input is unchanged.
- Residuals: a pause, exactly k Tabs, Enter (Tab completion cycling three times could reach "Always
  allow"); the user's own click or press in the page as a starting point.
- A click right after a hold trigger is refused once; a right-click, the Menu key, F10, an Alt+Tab
  or Alt+digit whose Alt comes up on the page, and macOS Option with a letter cost the same; a
  screen reader's activation after a lone Alt answers a second later, and holds when made with Alt
  down.
- Menu residuals: a tab strip or toolbar context menu used with the mouse, and a menu access key
  changed to Control (measured, answered when closed with a click outside the page); a lone Alt as
  the question's tab opens, before its script runs (measured, answers only with keys into the menu
  bar for a second, a click outside, then Tab, Tab, Enter within a second); pointer events in the
  bare menu bar after a lone Alt; unverified, Control with a letter then the access chord, a press
  synthesized in the content process during an Alt, another shortcut opening a popup without a blur,
  a Space held through a menu input, a main thread busy over 85 ms between two handlers; Wayland and
  GNOME.
- Resizes, not measured: whether a zoom or pinch fires `resize`; a press and release between a
  viewport change and its event; another session restoring a maximized window to its own size.
  Moving a window fires no `resize`, and no tool moves one. A session that keeps resizing a shared
  window keeps the question unarmed.
- While a propose page is open, the session and every agent sharing it cannot select other tabs. A
  blank `tab_open` makes one more `tabs.update` call. A question's tab moved out of the group makes
  the refusal broader, which is harmless.
- Accepted outside the bound: Firefox's leave dialog on `tab_close` and every load `navigate` starts
  (measured) and on a load an act or the page starts (not measured); its sign-in dialog; tabs a page
  opens or selects; a `tab_close` of a tab the user selected; the focus Firefox gives a session
  window opened after the user emptied the group; the downloads panel (not measured); other
  sessions' selects, focuses and resizes.
- The dialogs' risk: an Enter meant for the question can leave or close the user's page, or send a
  saved login to the site that asked, which after a redirect may be one the session may not act on
  (its page then reaches the agent redacted); typing on the propose page can land in the sign-in
  fields; the load leaves its tab in front; a misled agent can open any number of sign-in tabs. The
  question's buttons stay disarmed meanwhile. A challenge Firefox or an add-on answers with a server
  slower than 2 s gives a false `sign_in_needed`; a proxy challenge on an https tunnel and the
  client-certificate dialog may still time out.
- `e2e/approval.test.ts`, `e2e/recipes.test.ts`, `e2e/tab-close.test.ts` and
  `e2e/session-window.test.ts` pin the window focus, the key and resize rules, the refusals and
  Firefox's selects; a Firefox that changes them fails when `bin/firefox-version.json` moves.
  Firefox's menus are measured by hand only, and no test fails when they change. Revisit if Firefox
  lets an extension close or load a tab without the unload check or calls non-blocking
  `onAuthRequired` for top-level loads, or on a report of a dialog or sign-in tabs used to hide a
  question.
