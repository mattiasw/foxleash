# 0064: Input that can open a Firefox menu holds a prompt's arming until the page sees input again

**Status:** Accepted, 2026-11-14. Extends
[0063](0063-a-lone-alt-holds-a-prompts-arming-until-the-page-sees-input.md).

## Context

[0063](0063-a-lone-alt-holds-a-prompts-arming-until-the-page-sees-input.md) holds a prompt page's
arming (`approve.html`, `run.html`, `propose.html`) after a lone Alt, because on Linux it opens
Firefox's menu bar, which takes the keys after it without a blur. It left F10, Shift+F10, the Menu
key, Alt+letter access keys, a changed menu access key and Wayland as unverified gaps. Other
Firefox menus take keys the same way: while a menu popup is open, or the menu bar was activated
from the keyboard, Firefox consumes every key event before the page.

Measured in Firefox 156.0.1, not headless, under Xvfb on X11 without a window manager, with real X
key and pointer events, on an approval prompt opened by `tab_open` and armed. Each trial opens a
menu, types keys into it for 1.3 s (arrow keys into a popup, q, w, z into the bare menu bar),
closes it, and 80 to 150 ms later presses Tab, Tab, Enter. "Answered" means the prompt answered
Allow this session; "refused" means it was not answered within 3 s. Times in the page's capture
logs are milliseconds from the trial's start. No key typed into any menu reached the page. The
controls held in every run: armed, Tab, Tab, Enter answered; with no menu, q, w, z, Escape, Tab,
Tab, Enter was refused. Before this decision:

- **F10** opens the menu bar and its File menu. The page saw F10's keydown and restarted the
  second there. Closed with Escape, Escape, or with F10 again, the closing key's keyup reached the
  page and the Tab path was refused; after one Escape the menu bar stayed active and took the first
  Tab's keydown. Closed with a click on the tab strip or in the page, the page saw nothing after
  F10's keydown (`keydown:F10@52, ARMED@1052, pointer-left@1738, keydown:Tab@1873`; F10's keyup
  taken; the click in the page did not reach it), and the Tab path **answered**.
- **Shift+F10** fires `contextmenu` in the page and opens the context menu:
  `keydown:Shift@46, keydown:F10@47, contextmenu@59, keyup:F10@83, keyup:Shift@84`, so the
  opening keys' keyups reach the page after the `contextmenu` event. Closed with Escape (its keyup
  reached the page) it was refused; closed with a click on the tab strip (`keydown:Shift@55,
  keydown:F10@56, contextmenu@57, ARMED@1168`) it **answered**.
- **The Menu key**: `keydown:ContextMenu@54, contextmenu@55`, its keyup taken. Refused when closed
  with Escape; **answered** when closed with a click on the tab strip
  (`keydown:ContextMenu@59, contextmenu@60, ARMED@1059`).
- **A right-click** in the page: `pointerdown:b2@107, mousedown:b2@107, contextmenu:b2@119`, so the
  secondary pointer press arrives before the menu opens. Refused when closed with Escape; when
  closed with a click on the tab strip the page stayed armed throughout and the Tab path
  **answered**. Closed with a click in the page, the click did not reach the page.
- **Alt+V** (the View menu): `keydown:Alt@55, keydown:v@85`, no keyups. Refused when closed with
  Escape, Escape; **answered** when closed with a click on the tab strip
  (`keydown:Alt@31, keydown:v@62, ARMED@1062`).
- **A seen-down key a menu took the keyup of**: Tab down, F10, Tab up, arrows, a Tab that closes
  the menus, the question refocused by script: `keydown:Tab@50, keydown:F10@150, ARMED@1151,
  keyup:Tab@1946`. The closing Tab's keydown was taken; its keyup counted as the keyup of the Tab
  the page saw go down and left the page armed, and the Tab path **answered**.
- **A lone Alt the page did not hold for**: an Alt sent right after `tab_open` was called did not
  open the menu bar (q, w, z reached the page), and one sent when the prompt's page first appeared
  found the question already showing, a plain lone Alt that held; both refused. An Alt pressed in
  another tab and released on the prompt opened the menu bar (`blur@20, focus@174, keyup:Alt@198,
  ARMED@1198`) and **answered**. An Alt with a click and no pointer press between its keydown and
  keyup opened the menu bar (`keydown:Alt@51, click(untrusted)@57, keyup:Alt@87`, which ended the
  candidate) and **answered**. AltLeft down, AltRight down, AltLeft up and AltRight up sent at
  once all reached the page at 47 ms; the second Alt keyup ended the hold, the menu bar opened,
  and the Tab path **answered**.
- **The menu access key set to Control** (`ui.key.menuAccessKey` 17, an `about:config` setting): a
  lone Control opened the menu bar, and the page saw only Control's keydown and keyup, a modifier
  it saw go down, so nothing restarted. Refused when closed with Escape; **answered** when closed
  with a click on the tab strip. A lone Alt then did not open the menu bar.
- **Menus of Firefox's own window opened with the mouse**: the application menu button's panel
  blurred the page when it opened (`blur@448`, `focus@1794` when it closed), which disarms it, so
  the Tab path was refused. A right-click on the tab strip opens its context menu with no event in
  the page (the pointer had left the page earlier): refused when closed with Escape, whose keyup
  reached the page; **answered** when closed with a click on the tab strip.

The same trials repeated against this decision's rules, in the same setup, with the controls
holding again:

- **Every trial above that answered was refused**, and every trial closed with Escape stayed
  refused: F10 closed with a click on the tab strip or in the page; Shift+F10, the Menu key and a
  right-click on the heading, each closed with a click on the tab strip; Alt+V closed with a click
  on the tab strip; the seen-down Tab whose keyup a menu took; an Alt pressed in another tab and
  released on the prompt; a script click between Alt's keydown and keyup; AltLeft and AltRight
  released together. With F10 closed by a click on the tab strip the page stayed unarmed from the
  F10 until the first Tab, and armed a second after it: `UNARMED@52, keydown:F10@52,
  pointer-left@1715, keydown:Tab@1848, ..., keydown:Enter@2070, ARMED@3100`.
- **A right-click with Shift held** fires no `contextmenu` event in the page
  (`dom.event.contextmenu.shift_suppresses_event` is true by default): the page saw
  `keydown:Shift, pointerdown:b2, mousedown:b2, keyup:Shift`. Closed with a click on the tab strip,
  it answered before this decision and was refused with it, held by the secondary-button press.
  With `dom.event.contextmenu.enabled` set to false the `contextmenu` event still reached the
  extension page; a right-click there answered before this decision and was refused with it.
- **A key pressed just after the opening input**: before the join window was added, a Down
  pressed 0 ms after F10 reached the page and ended the hold, and the Tab path answered; so did a
  Down 5 ms after the Menu key. A Down 5 ms after F10, a right-click or Alt+V, or 15 ms or more
  after the Menu key, was taken by the menu. With the 100 ms join window every such trial was
  refused: 0 ms after F10, and 5, 15, 30, 60 and 120 ms after F10, the Menu key, a right-click and
  Alt+V. In the 0 ms trial the page saw `keydown:F10@35, keydown:ArrowDown@36, keyup:F10@36,
  keyup:ArrowDown@37` and stayed unarmed until the first Tab.
- **A lone Alt while the prompt tab loads**: sent right after `tab_open` was called, before the
  prompt page's script ran, it opened the menu bar in this run (with the same timing it had not
  before), the page saw nothing of it and armed a second after the question showed, and the Tab
  path **answered** after the menu bar was closed with a click on the tab strip. Sent once the
  question was showing, it held as a lone Alt and was refused. Neither timing hit the moment
  between the page's script starting and the question showing.
- **Unchanged**: with the menu access key set to Control, a lone Control and a right-click on the
  tab strip were each refused when the menu was closed with Escape and **answered** when it was
  closed with a click on the tab strip; the application menu panel's blur disarmed the page, and
  the Tab path was refused.

Wayland and GNOME were not measured: no Wayland compositor was available. End-to-end tests cannot
show Firefox's menus: WebDriver keys are dispatched in the page whatever has focus.

## Decision

`createKeyWatch` in `apps/extension/src/prompt-arming.ts` holds the arming at every input the page
sees that can open a Firefox menu. `armButtons` in `apps/extension/src/page-ui.ts` feeds it from
capture-phase `keydown`, `keyup`, `pointerdown`, `mousedown`, `click` and `contextmenu` listeners
on `window` and a `blur` listener, all registered when `armButtons` runs at page load, not when the question
shows; it never cancels the `contextmenu` event. When the question shows, `watch()` forgets the
keys the page saw go down, as at a blur, and starts arming focused only when the page is not held.

**Menu-opening input starts a hold.** These hold the arming at once, disarmed with no timer
running: a keydown of `F10` with any modifiers; a keydown of `ContextMenu`; a keydown of a key
other than a modifier with Alt down and Control and Meta up (an Alt chord, read from the event's
modifier flags); a pointer press with the secondary button, seen as a `pointerdown` or, when
another button is already down and the press fires only a `pointermove`, as a `mousedown`; and a
`contextmenu` event. A right press holds because the press comes before the menu, and because
Firefox can open a context menu without a `contextmenu` event in the page. Such input while already held joins the hold rather
than ending it.

**The opening gesture's keyups keep the hold.** At a hold that one of these inputs starts or
joins, the keys the page saw go down since its last blur or hold, the trigger included, become the
hold's opening keys. While held, the keyup of an opening key keeps the hold, and so does another
keydown of one, such as the repeats of a Shift held through a right-click. Ending a hold forgets
the opening keys.

**Input less than 100 ms after a trigger joins the hold.** While held, a keydown that comes less
than 100 ms (`HOLD_JOIN_MS`) after the input that started the hold, or that last joined it as a
trigger, joins it instead of ending it: its key becomes an opening key, so its keyup keeps the hold
too. A keyup in that time keeps the hold whatever its key. The triggers are the inputs above that
start a hold and the Alt keyups below that start one; a keydown that joins only by this window does
not move it, so a stream of fast keys cannot keep the hold open. A key pressed together with or just
after a menu-opening input can reach the page before the menu takes the keyboard, and so can the
keyup of a key held through it, also one the page did not see go down or has forgotten (a key held
since before the question showed or the window last lost focus): measured, Shift+F10's Shift keyup
reached the page 25 ms after the `contextmenu` event, and a Shift's 40 ms after a right press.
Either would otherwise end the hold while the menu takes the keys after it.
The window applies to every hold, a lone Alt's included: one rule is simpler to state, and it only
keeps a hold longer.

**Every hold forgets the seen-down keys.** At any hold, a lone Alt's included, the page forgets
which keys it saw go down, so a keyup a menu took cannot leave a key counted as down.

**An Alt keyup while held keeps the hold.** Two Alt keys released together must not end the hold
the first one started.

**Only a pointer press cancels a lone Alt.** A lone Alt is an Alt keyup whose keydown the page saw,
with no other keydown, pointer press or window blur in between; a click with no pointer press in
between no longer cancels it, because Firefox opens the menu bar there. The click still ends any
current hold.

**An unseen Alt keyup holds while the page is fresh.** An Alt keyup whose keydown the page did not
see holds when the page has seen no keydown or pointer press since the question showed or since the
window last lost focus: Firefox opens the menu bar at an Alt released on the prompt after being
pressed elsewhere, and a click with no pointer press in between does not stop it, as for a lone
Alt.

**What ends a hold** is unchanged otherwise: the next keydown that neither starts nor joins a hold,
a keyup that the rules above do not keep, a primary pointer press or a click, and the arming second starts from that
event. A hold never times out, and a window focus or a `visibilitychange` does not end it.

Condition 1 of 0061's bound, as 0063 restated it, becomes: the page has been visible and focused
for a full second in which it saw no keydown, no keyup but that of a Tab, Space or non-Alt
modifier it saw go down since its last blur or hold, and is not held, where a hold starts at a
lone Alt, at an Alt keyup it did not see go down while it had seen no keydown or pointer press
since the question showed or the window last lost focus, at a keydown of F10, the Menu key
or a key pressed with Alt and without Control or Meta, at a secondary-button pointer press, or at
a `contextmenu` event, and ends only at the next keydown that starts no hold, is not of a key that
opened it, and comes at least 100 ms after the input that started or last joined it as a trigger,
primary pointer press, click, or keyup that comes at least 100 ms after that input and is other
than an Alt keyup, the keyup of a key the page saw go down (since its last blur or hold) before an
F10, Menu-key, Alt-chord, secondary-press or `contextmenu` hold started or joined (a lone-Alt hold
keeps no such key), or the keyup of a key whose keydown joined it within those 100 ms; and was not
re-armed. Conditions 2 and 3 of 0061 are unchanged.

Two rules of 0063 change on purpose: an Alt keyup the page did not see go down can now hold, where
it only restarted the second; and a click between Alt's keydown and keyup no longer cancels the
lone Alt.

## Alternatives rejected

- **Recording these instances as accepted residuals**: measured, each answers a prompt within a
  second of keys typed into the menu.
- **Restarting the second at the new triggers instead of holding**: keys a menu takes more than a
  second after F10 fill the pause, as the measurement shows.
- **Cancelling the `contextmenu` event, or F10, so no menu opens**: it takes menus away from
  keyboard users on the prompt, and whether Firefox honours it for an extension page was not
  measured.
- **Holding when the pointer leaves the page**, to cover menus of Firefox's window opened with the
  mouse: the page sees the pointer leave, but every move to the toolbar would hold, and a pointer
  already outside the page when the prompt opens gives no event.
- **Holding at a lone Control, Shift or Meta**, to cover a changed menu access key: a lone Control
  is how screen reader users silence speech, and the setting is only in `about:config`.
- **Holding at every keydown with Control, Alt or Meta**: it holds at every shortcut, beyond the
  menus measured.

## Consequences

A click right after any hold trigger is refused once, as after a lone Alt, and a key press right
after one starts the second again. A right-click or the Menu key in a prompt costs the same, and
so does F10. On macOS Option with a letter types a character and holds. An Alt+Tab or Alt+digit
tab switch whose Alt comes up on the prompt holds, whether or not a menu opened. A screen reader's
click while Alt is down no longer cancels the lone Alt, so it holds. A key pressed less than 100 ms
after a menu-opening input never ends the hold, and neither does its keyup or any keyup in those
100 ms; on its own that only keeps the hold longer, until the next input that ends it.

Measured as covered by this decision:

- A key pressed just after a menu-opening input, before the menu takes the keyboard: it reached
  the page only when pressed less than 15 ms after that input (0 ms after F10, 5 ms after the Menu
  key), and it now joins the hold, so the 100 ms join window leaves a margin of more than 85 ms.
- A right-click with Shift held, which fires no `contextmenu` event in the page, and a right-click
  with `dom.event.contextmenu.enabled` false: the secondary-button press holds for both.
- The application menu panel: it blurs the page, which disarms it.

Residuals:

- A context menu of the tab strip or a toolbar opened and closed with the mouse: measured before
  and after this decision, the page sees nothing. It is refused when closed with Escape, whose
  keyup restarts the second, and answered when closed with a click outside the page.
- A menu access key changed to Control in `about:config`: measured before and after this decision,
  a lone Control opens the menu bar and the page sees only Control's keydown and keyup. It is
  refused when closed with Escape and answered when closed with a click outside the page. Control
  with a letter, then the menu access chord, only restarts the second, as Alt+V did before this
  decision (an unverified hypothesis).
- A lone Alt pressed while the prompt tab opens, before the prompt page's script runs: measured,
  Firefox can open the menu bar there and the page sees nothing of it. The Tab path answers only
  with an Alt within the moment the prompt tab opens, then keys typed into the menu bar for over a
  second, then a close by a click outside the page (Escape's keyup restarts the second), then Tab,
  Tab, Enter within a second. An Alt between the page's script starting and the question showing
  was not reached by the measurement.
- A pointer press synthesized in the content process between Alt's keydown and keyup cancels the
  lone Alt in the page but not in Firefox: an unverified hypothesis.
- A keyboard shortcut other than these that opens a popup of Firefox's window without moving focus:
  its keydown restarts the second and does not hold (an unverified hypothesis).
- A Space held on an answer button through a menu-opening input and released before the menu takes
  the keyboard: the hold keeps its keyup, but the click Firefox makes on the button at that keyup
  ends the hold (an unverified hypothesis).
- The 100 ms are measured when the page's script handles each event, not when the event happened:
  a main thread busy for more than 85 ms between the two handlers ends the hold at a key the window
  would have joined (an unverified hypothesis).
- Wayland and GNOME: not measured.
