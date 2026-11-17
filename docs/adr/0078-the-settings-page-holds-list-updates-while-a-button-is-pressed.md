# 0078: The settings page holds its list updates while a button is pressed

**Status:** Accepted, 2026-11-17.

## Context

Firefox gives the pressed button no click when the mousedown and the mouseup of a press land on
different elements. An end-to-end test of the settings page's answer rows failed at its release step when
the rows were replaced between the press and the release: the button under the pointer at the
release was not the one pressed, and no click reached either.

The settings page rewrites its lists with no regard to a held button:

- The answers of the running agent sessions are read again on the window's `focus`, which a
  mousedown into an unfocused page fires, and on `visibilitychange`. The rows are updated in place
  by key (`updateAnswerRows`), which keeps a row's button through a change of its label, but rows
  are still added and removed around it: an answer added above the pressed row, or a row or a whole
  session removed above it, moves the pressed button away from the pointer.
- Every `storage.local` change calls `render()`, whose `show` and `showRecipes` replace the rows of
  the sites allowed always and of the recipes, so the pressed button is replaced by a new element
  even when nothing moves. In real use these writes come from another settings page, or a recipe
  saved from another tab.
- The sections are stacked, so a change of one list's height moves every button below it.

## Decision

While a primary pointer button is down anywhere on the settings page, the page holds the updates
of its three lists and applies them after the release. `createPressHold` in
`apps/extension/src/press-hold.ts` does this; `options.ts` makes one for the page and puts each
list update through `hold.run(slot, update)`, with the slots `"sites"`, `"answers"` and
`"recipes"`.

- A `pointerdown` with `button` 0 starts the hold for its pointer. Only the primary button: after a
  secondary press on Linux, Firefox opens its context menu and the page gets no `pointerup`
  ([0064](0064-the-keys-firefox-menus-take-from-a-prompt.md) records a right-click as
  `pointerdown`, `mousedown`, `contextmenu` and nothing after), which would leave the hold stuck; and
  only a primary press makes a click on a button.
- `pointerup` and `pointercancel` end the hold for their pointer; the window's own `blur` ends it
  for every pointer, since the release can go to another window. The `blur` listener is not in the
  capture phase, where it would also get the blur of the element a press moves focus away from.
- Each slot keeps only its latest update. Once no pointer is down, the held updates run in a
  `setTimeout(0)` task, in the order their slots were first held. Firefox dispatches a release's
  `pointerup`, `mouseup` and `click` in one task, so the click reaches the pressed button before a
  held update moves or replaces it. The task does nothing when a new press has started; that
  press's release schedules it again.
- An update that arrives after the release but before that task is held too, so an older held
  update never lands on top of a newer one.
- The read counters (`renders`, `answerReads`) are checked when a result arrives and again when a
  held update runs, so a result that a newer read superseded is dropped and never replaces the
  newer one in its slot.
- With no pointer down and nothing held, `run` applies the update at once: keyboard use and idle
  updates are unchanged, and the focus rules (`restoreFocus`, the in-place answer rows) still keep
  focus on the same row's button.

## Alternatives rejected

- **Updating rows in place by key alone.** Keeps the pressed button through a change of its own
  label only; rows added or removed above it still move it, and `replaceChildren` still replaces
  the buttons of the other two lists.
- **Pointer capture on the pressed button.** A replaced button is detached from the page, and
  whether Firefox retargets the `click` to the capturing element is not verified.
- **Reserving space so rows cannot move.** Does not cover a replaced button, and lists grow and
  shrink.
- **Holding only the list the press is in.** The sections stack, so a change in a list above moves
  the pressed button as well.

## Consequences

Any later settings-page update that can move or replace a button goes through `hold.run`.

Not held, on purpose:

- The program section (`watchProgram`): it changes only when the program connects, disconnects or
  reports its version, and `program-status.ts` is shared with the first-run page.
- The status lines that report the result of the user's own click (Revoked, Forgot, Stopped,
  Deleted, Saved, Restored, the blocklist and window-setting statuses).
- The blocklist's fill: it fills a textarea of fixed size, on load and after the user's own Save,
  so it moves no button.
- The window setting's checkbox: its state moves no button, and a state held through a press on
  it would undo that press's click until the page reads the saved setting.

Known gaps:

- A Firefox menu opened during a primary press can take the release, so the page sees no
  `pointerup`. The hold then lasts until the next primary release on the page or a window blur.
  Nothing is lost; the lists show the latest update late.
- Firefox can send a touch tap's click after its `pointerup`, once it has recognized the tap, so
  the held updates can run before that click. Taps are not covered, and are no worse off than
  before.
- A Space press activates a button at the keyup only when the keydown reached that button. A
  storage change between the two replaces the sites' and recipes' buttons, and focus moves to the
  new button, whose keyup activates nothing. We revisit this on a report of a lost keyboard
  activation on the settings page.
- An update that lands just before the press, such as the answers read that clicking into an
  unfocused page starts when its reply arrives before the `pointerdown`, can still move another
  row's button under the pointer: a click on the wrong row's position, which the hold cannot cover.
- When a held result is superseded by a newer read that then fails, the list keeps the rows it had
  before the press, where before this change the older result would have been shown. This happens
  only after a failed `storage.local` read.
- A held read failure announces its status line after the release instead of during the press.
