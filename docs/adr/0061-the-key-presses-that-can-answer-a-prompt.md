# 0061: A prompt key press answers only at the end of an armed Tab path from before the buttons

**Status:** Accepted, 2026-11-14. Extends
[0058](0058-prompt-keys-answer-only-on-a-button-focused-after-arming.md).

## Context

[0058](0058-prompt-keys-answer-only-on-a-button-focused-after-arming.md) lets Enter or Space
answer a prompt page (`approve.html`, `run.html`, `propose.html`) only on an answer button that
got focus while the page was armed, and exempts Enter and Space on an answer button from
restarting the arming second. Neither rule says where the focus came from, so key sequences
meant for another window (a terminal, an agent's prompt) still answered:

1. **Shift+Tab, then Enter, from where the page left focus.** None of the pages focused anything
   while asking. Measured end to end in Firefox 156 with WebDriver keys: on a fresh approval
   prompt `document.activeElement` is the body, and after the buttons armed Shift+Tab focused
   "Always allow" and Enter answered it. On the propose page, `changed()` focused `#status`, which
   follows the buttons, when the stored recipe had been removed meanwhile; Shift+Tab from a
   focused `#status` left the page in that measurement, so this one did not reproduce in Firefox
   156, but nothing in the code kept it from reaching Save.
2. **Refused presses fill the pause.** A refused Enter or Space on an answer button did not
   restart the second, and focus that sat on a button whose focus did not count still made its
   neighbour count after one armed Tab: Tab, Tab before the buttons arm, a pause, Tab, Enter
   answered "Always allow"; so did Enter, a pause, Enter, Tab, Enter from a button whose focus
   came back with the window.
3. **Space held while Enter is pressed** clicks twice; 0058's Space keyup rule already refuses it.
4. **Firefox's menus.** On Linux a lone Alt (or F10, Shift+F10, the Menu key) may open a menu that
   takes the following keys without blurring the window, so they never restart the second. This
   needs Firefox on a desktop; WebDriver keys reach the page whatever has focus.

Measured end to end in Firefox 156 with WebDriver keys:

- `heading.focus()` on an `<h1 tabindex="-1">` while the prompt's tab is hidden makes it the
  active element; when the tab is shown, the window's `focus` fires, then the heading's.
- `FocusEvent.relatedTarget` on a button's `focus` is the element focus left: the heading, the
  previous button, or a text field before the buttons.
- Tab past the last button, Shift+Tab from the heading, and Shift+Tab from a focused `#status`
  leave the page: the window blurs and the page disarms. Focus coming back into the page (the
  window returns, or Tab from the browser's toolbar) fires the window's `focus` first, then the
  element's with `relatedTarget` null.
- With no element focused, Tab and Shift+Tab start from where focus last was, with
  `relatedTarget` null.
- Enter clicks a button at keydown, Space at its keyup. `preventDefault()` on the keydown stops
  either click, and so does moving focus to the heading during the keydown.
- Quick find (`/`) blurs the window, which disarms the page.

## Decision

One rule, in `armButtons` in `apps/extension/src/page-ui.ts`, with each page's resting element.

**Focus rests before the buttons.** Each page's `<h1 id="heading">` has `tabindex="-1"`, and the
page focuses it where it first shows its question, before arming starts (`ask()` in `approve.ts`
and `run.ts`, `propose()` in `propose.ts`). The resting element, passed to `armButtons` as
`rest()`, is `#heading`, except on the propose page while a current version shows, where it is
`#current-heading`; `changed()` on the propose page focuses it. The only other focus a page sets
while it asks is a text field on the propose page, which also precedes the buttons.

**A button's focus counts only along an armed Tab path from before the buttons.** When an answer
button gets focus while armed, its focus counts if `relatedTarget` is the button whose focus
counts and the two are neighbours in the button row, or if the button is the first in the row
and `relatedTarget` is an element that is not an answer button, precedes the buttons in document
order, does not contain them and is in the same document. Any other focus, also one from no
element, clears it. Every disarm clears it too. An answer, by key or pointer, starts the arming
second again, so a path ends with the press that answered.

**Every Enter or Space keydown on an answer button is decided at keydown.** A capture-phase
`keydown` listener on `window` lets it through when the page is armed and the button's focus
counts. Otherwise, while the page asks, it is refused: `preventDefault()`, the arming second
starts again, focus moves to the resting element, and the page announces `REFOCUS`, which tells
the user to wait a second, then Tab to the button and press it. A held key is one press: a
repeat on an answer button is refused silently, except the repeats of a counted Space, whose
keyup answers. A Tab while a counted Space is down restarts the second. Every other keydown
restarts the second unless the page is armed and the key is Tab or a modifier, as in 0058. 0058's
Space keyup rule stays: the click at a Space keyup counts only for the counted Space that went
down on that button.

0058 rejected moving focus at arming because the user had not acted. Here focus moves in answer
to the user's own refused key press, and the page says so.

**The bound.** Enter or Space answers a prompt only when all of these hold:

1. the page has been visible and focused for a full second in which it saw no keydown and was
   not re-armed;
2. since then it saw only Tab, Shift+Tab and modifier keydowns, and focus moved, while armed,
   from an element before the answer buttons onto the first button, then from button to
   neighbouring button, to the button;
3. the Enter went down on that button, or the Space went down and came up on it, with no disarm
   between.

There is no other key answer. When the page asks again after an answer (the approval prompt's
"could not save" reply, the propose page's problems reply), it starts the arming second again, and
the answer has ended its path, so a key answers only along a new path after a pause.

From the resting element that is k Tabs, then Enter or Space, for the k-th button: on the
approval prompt 1 for "Don't allow", 2 for "Allow this session", 3 for "Always allow"; on the run
page 1 for "Don't allow", 2 for "Allow these sites for this session"; on the propose page 1 for Discard and 2 for Save from the
current version's heading, and 6 for Save from `#heading` (through the four fields). Shift+Tab
alone answers nothing: from the resting element it reaches a propose field or leaves the page,
which blurs the window and disarms. On the approval and run pages nothing tabbable precedes the
buttons, so after a Tab made during the arming second the way back to a counting path is a
refused press, which moves focus to the heading, or a click on the heading; a click on other text
leaves no element focused, from which Tab never counts. Leaving the page and coming back is not
one: focus returns from no element.

## Alternatives rejected

- **A dwell of 300 to 500 ms on the button before Enter or Space counts**: refuses every fast
  keyboard answer, and a terminal's Tab completion followed by Enter can take longer than that.
- **Reordering the buttons alone**: does not bound how many Tabs reach a button from a resting
  point on another button.
- **Counting a focus from no element**: focus from no element lands where focus last was, or on
  a fresh page on the last button, and arrives that way after a window return and after a click
  on the page's text, starting points the page cannot locate.
- **Keeping refused presses exempt from the restart (0058)**: refused presses then fill the
  pause.
- **A resting element just before the propose page's buttons**: new UI for fewer Tabs; the
  question's heading is the start of the page, and more Tabs is the safer side.

## Consequences

Accepted residuals: a second's pause, then exactly k Tabs, then Enter or Space (Tab completion
that cycles three times and then Enter could reach "Always allow"); the user's own pointer action
in the page as a starting point (a click on a field or the heading, or a pointer press on the
first button released elsewhere); Firefox's menus after a lone Alt, F10, Shift+F10 or the Menu
key, which may take keys the page never sees without a blur (unverified, needs a desktop); and a
screen reader that moves focus with no `relatedTarget` would see its Enter refused once
(unverified hypothesis).

A keyboard user who Tabs during the arming second presses Enter or Space once, is refused with
focus back on the question, and starts again. On the propose page, a refused press while no
current version shows goes back to the top of the page. A screen reader's own activation, which
sends no keydown to the page, still answers when the page is armed, and pointer input is
unchanged.
