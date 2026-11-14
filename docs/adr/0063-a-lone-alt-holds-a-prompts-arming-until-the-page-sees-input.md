# 0063: A lone Alt holds a prompt's arming until the page sees input again

**Status:** Accepted, 2026-11-14. Extends
[0061](0061-the-key-presses-that-can-answer-a-prompt.md).

## Context

[0061](0061-the-key-presses-that-can-answer-a-prompt.md) lets a key answer a prompt page
(`approve.html`, `run.html`, `propose.html`) only after the page has been visible and focused for
a full second with no keydown, followed by a Tab path from before the buttons. It listed Firefox's
menus as an unverified residual: on Linux a lone Alt may open a menu that takes the following keys
without blurring the window, so they never restart the second.

Measured in Firefox 156.0.1, not headless, under Xvfb on X11 without a window manager, with real X
key events, on an approval prompt opened by `tab_open` and armed:

- **Alt, q, w, z, Escape, then Tab, Tab, Enter** 100 to 320 ms after the Escape answered "Allow
  this session". After the Alt the menu bar was active. The page's capture log:
  `keydown:Alt@50, keyup:Alt@80, keyup:Escape@670, keydown:Tab@771, focusin:no@773,
  keyup:Tab@801, keydown:Tab@881, focusin:once@883, keyup:Tab@911, keydown:Enter@992`. The page
  saw no keydown for q, w, z or Escape.
- **Alt, v (opens the View menu), q, z, Escape, Tab, Tab, Enter** answered "Don't allow". The page
  saw no keydown for v, q, z, Escape or the first Tab, only that Tab's keyup.
- Controls: without the Alt every keydown reached the page and the Enter was refused; armed, Tab,
  Tab, Enter alone answered.

While the menu bar held the keyboard the page saw neither keydowns nor keyups: no keyup for q, w
or z, nor for the Escape that only closed the View menu. What it does see is the lone Alt's
keydown and keyup, and, once the menu bar lets go, keyups whose keydown it never saw. Whether the
page receives pointer events while the menu bar is active was not measured. End-to-end tests
cannot show the menu bar: WebDriver keys are dispatched in the page whatever has focus.

## Decision

Two rules, decided by `createKeyWatch` in `apps/extension/src/prompt-arming.ts` and wired in
`armButtons` in `apps/extension/src/page-ui.ts` with capture-phase `keydown`, `keyup`,
`pointerdown` and `click` listeners on `window`.

**A lone Alt holds the arming.** A lone Alt is an Alt keyup (`key` `"Alt"`) whose Alt keydown the
page saw, repeats allowed, with no other keydown, pointer press, click or window blur in between.
At a lone Alt the page disarms and stays unarmed with no timer running until it sees its next
keydown, keyup, pointer press or click; that event ends the hold and the arming second starts
again from it. A window `focus` or a `visibilitychange` does not end it. A click ends it because a
screen reader's own activation reaches the page as a click with no key or pointer press.

**Keyups start the second again.** Every keyup starts the arming second again, and ends a hold,
except the keyup of Tab, Space or a modifier other than Alt whose keydown the page saw since the
window last lost focus. Keys are matched by `code`, or by `key` when `code` is empty; the keys
seen going down are forgotten at a window blur. So the keyup the page sees when the menu bar lets
go (Escape's, or a Tab's whose keydown the menu bar took) starts the second again, and so does the
keyup of a key whose keydown the page saw but whose keyup a menu took until that key closes it.
The exempt keys are exactly those whose keydown can leave an armed page armed, so the Tab path,
Shift+Tab and the counted Space's keyup work as before. Every other key's keydown has already
restarted the second, so its keyup changes nothing outside a menu.

Condition 1 of 0061's bound becomes: the page has been visible and focused for a full second in
which it saw no keydown, no keyup but that of Tab, Space or a modifier other than Alt that it saw
go down, and no lone Alt that it has not since seen a key, a pointer press or a click after, and
was not re-armed. Conditions 2 and 3 are unchanged.

## Alternatives rejected

- **Recording the residual as accepted**: it answers a prompt within a second of keys the user
  typed into the menu bar.
- **Restarting the second at a lone Alt, without the hold**: keys the menu bar takes more than a
  second after the Alt would still fill the pause.
- **Taking Alt out of the modifier keys that keep an armed page armed**: it restarts the second at
  the Alt's keydown, with the same gap as a plain restart.
- **Cancelling the lone Alt's keyup so the menu bar does not open**: it takes the menu bar away
  from keyboard users on the prompt page, and whether Firefox honours it for an extension page was
  not measured; the hold does not depend on it.
- **Ending the hold at a window focus**: the menu bar's state across a blur was not measured;
  staying held only delays arming.
- **Restarting only at a keyup whose keydown the page did not see**: a key whose keydown the page
  saw and whose keyup a menu took would not restart the second when it later closes the menu.

## Consequences

A click right after a lone Alt is refused once, and a key press right after it starts the second
again, as any key does; a lone Alt that opened no menu, on another desktop or with another
setting, costs the same. A screen reader's activation after a lone Alt is refused once and answers
a second later. A keyboard user starts again as after any other key.

Residuals, each an unverified hypothesis: F10, Shift+F10, the Menu key, Alt+letter menu access
keys and Wayland or GNOME are not measured; they are covered by the keyup rule only when the key
that closes the menu reaches the page as a keyup and is not a Tab, Space or non-Alt modifier whose
keydown the page saw. Whether the page sees pointer events while the menu bar is active is not
measured. A menu access key changed from Alt in Firefox's advanced settings is not covered. An Alt
that went down before the page started watching for keys comes up as an unseen keyup, which
restarts the second but does not hold.
