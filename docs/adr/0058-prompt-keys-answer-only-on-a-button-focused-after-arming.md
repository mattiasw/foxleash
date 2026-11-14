# 0058: Prompt keys answer only on a button focused after arming

**Status:** Accepted, 2026-11-14. Extends the arming of
[0007](0007-per-site-approval-and-tab-redaction.md). Its rule for which focus counts and its
exemption of Enter and Space on an answer button from restarting the arming second are extended
by [0061](0061-the-key-presses-that-can-answer-a-prompt.md), 2026-11-14.

## Context

A prompt page (the approval prompt `approve.html`, the run page `run.html` and the propose page
`propose.html`) answers only a trusted click on an armed button: the buttons respond one full
second after the page is both visible and focused, and disarm at once when either ends
(`prompt-arming.ts`). A pointer press or an Enter or Space keydown records whether it started
armed, so a press in the first second answers nothing.

Tab is not a press, so focus can reach an answer button while the page is unarmed, and nothing
remembered that. A prompt page that takes keyboard focus while the user types in another window
(a prompt selected in the window the user types in, or the session's own window brought to the
front by [0057](0057-prompts-bring-the-sessions-own-window-to-the-front.md)) received the
user's next keys: Tab, Tab in the first second, then Enter at one second or later, put focus on
"Allow this session" and answered it, because Firefox's keyboard activation of a button is a
trusted click with `detail` 0 (the end-to-end test in `e2e/approval.test.ts` shows it). Three
Tabs then Enter stored "Always allow"; on the run page two Tabs reach "Allow". Typing that
simply went on for more than a second reached armed buttons the same way with a later Tab, Tab,
Enter.

## Decision

Both rules live in `armButtons` in `apps/extension/src/page-ui.ts`. Pointer input keeps its
behaviour.

**An Enter or Space press answers only on a button that got focus while the page was armed, in
the current arming, with no other key pressed since.** Each answer button's `focus` event
records that button as the armed focus when the page is armed, and clears it otherwise; every
transition to unarmed (a window blur, the page hidden, `rearm()`) clears it too, so Firefox's
`focus` event on the still-focused button as its window comes back, which arrives unarmed,
cannot restore it. While armed, Tab clears it and then its own focus move records the new
button, and any other key but a modifier, or Enter or Space on an answer button, disarms the
page (below). A Space press is recognised by `key` " " or by `code` "Space", because Firefox
clicks a focused button on the Space key's keyup also when the layout types another character
with it.

Firefox makes that keyup click when any Space keydown reached the button since its last Space
keyup, also a repeat of a Space that went down elsewhere, and also after a click in between:
Space held while Enter is pressed clicks on Enter and again on the Space keyup. So the click at
the end of a Space keyup on an answer button counts only as the press of the page's last Space
keydown that was not a repeat, when that keydown went down on the same button in the current
arming, and answers only when that press counted. A Space that reached the button only as
repeats is no press.

**Any keydown in the page while it is unarmed, and while it is armed any key but Tab, a
modifier, or Enter or Space on an answer button, starts the arming second again**, repeats
included, through a capture-phase `keydown` listener on `window` that restarts the delay as
`rearm()` does. Typing meant for another window keeps the buttons unarmed until it stops for a
second, also when it resumes after a pause (`git`, a pause, then `ch Tab Tab Enter`), and also
when it is Enter or Space typed with focus on no answer button (Enter, then Tab, Tab, Enter).
Tab, and Enter and Space on an answer button, do not restart it while armed, so a keyboard user
moves to a button and presses it, and after a refused press moves to it again and presses it at
once.

A key press refused only because its button's focus does not count, with the page armed, calls
`onUnarmed("refocus")`; every other refusal calls `onUnarmed("arming")` and shows the page's
existing text. The buttons look enabled then, so the three pages (`approve.ts`, `run.ts`,
`propose.ts`) announce the shared `REFOCUS` text from `page-ui.ts`, which tells the user to move
to the button beside it and back with Shift+Tab and Tab, then press it.

## Alternatives rejected

- **Ignoring keys on the answer buttons**: breaks keyboard operation (WCAG 2.1.1).
- **A longer delay**: does not close the case of a Tab made before arming, and slows every
  answer.
- **A delay per button, from its focus**: makes every keyboard answer wait a second after Tab,
  and the restart on typing already covers typing that goes on.
- **Moving focus off a focused answer button at arming**: moves focus under keyboard and screen
  reader users without their action.

## Consequences

A keyboard user who reaches a button in the first second, or presses another key after reaching
it, moves to another button and back before pressing it, and the page says so. After a
one-second pause in which no key but Tab, a modifier, or Enter or Space on an answer button was
pressed in the prompt, Tab or Shift+Tab immediately followed by Enter or Space answers, the same
residual risk 0007 accepts for a click after the delay. A screen reader's own activation, which
sends no keydown to the page, is unchanged: it answers when the page is armed. On the propose
page, Save answers a second after the last key typed into its fields.
