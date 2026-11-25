# Focus events in a page that is not in front

Measurements behind [ADR 0017](../adr/0017-text-input-and-keys-without-key-event-defaults.md)'s
focus events.

## Focus and blur in a window behind another, and in a tab that is not selected (2026-11-25)

Experiments on Firefox 160.0.1, headless, on Linux, through the end-to-end harness, with the
setting "each agent session in its own window" on: the session's window and the user's window,
`browser.windows.update(id, { focused: true })` from the settings page to put one in front
(confirmed with `windows.get(id).focused`). Capture listeners on two inputs, `p1` and `p2`,
recorded `focus`, `focusin`, `blur`, `focusout`, `change` and `input` with `isTrusted` and
`relatedTarget`, and `focus` and `blur` at `window` and `document`. The page ran, through WebDriver
BiDi `script.evaluate`: `p1.focus()`, `execCommand("insertText")`, `p2.focus()`, `insertText`,
`p2.blur()`, reading the log 150 ms after each step.

| Step | Session window in front | Session window behind the user's | Tab not selected, its window in front |
|---|---|---|---|
| `document.hasFocus()` | true | false | false |
| `p1.focus()` from `body` | `focus`, `focusin` on p1, trusted, dispatched synchronously inside the call, `relatedTarget` null | nothing; `activeElement` becomes p1 | nothing; `activeElement` becomes p1 |
| `insertText` in p1 | trusted `input` | trusted `input` | trusted `input` |
| `p2.focus()` | `change` p1, `blur` p1 (related p2), `focusout` p1 (related p2), `focus` p2 (related p1), `focusin` p2 (related p1) | nothing; `activeElement` p2 | nothing |
| `p2.blur()` after `insertText` | `change` p2, `blur` p2, `focusout` p2 (related null) | nothing; `activeElement` body | nothing |

- With p1 focused while behind, raising the session's window delivered a trusted `focus` at
  `document` and `window`, then `focus` and `focusin` on p1. Selecting a tab that was not selected
  did the same. Sending the window behind again delivered `blur` and `focusout` on p1, then `blur`
  at `document` and `window`; p1 stayed `document.activeElement` and `hasFocus()` became false.
- Headless Firefox reports a minimized window as still focused (`state: "minimized"`,
  `focused: true`) and delivers every event to it.

Foxleash's tools before focus events were sent, with the session's window behind:

- `type` gave the page only the trusted `input`.
- `click` on the field gave nothing.
- `fill_form` gave `input`, then Foxleash's own untrusted `change` after the blur, which sent no
  events.
- `press_key` Tab from a field given by ref gave only the `keydown`; focus moved without events.

With the session's window in front, the same tools gave: `type` `focus`, `focusin`, `input`;
`click` `focus`, `focusin`, and a `type` after it only `input`; `fill_form` `focus`, `focusin`,
`input`, `change`, `blur`, `focusout`, all trusted; Tab `focus` and `focusin` on p1, `keydown`,
`blur` and `focusout` on p1 (related p2), `focus` and `focusin` on p2 (related p1).

A widget that opens its suggestion list only after its own focus listener ran (React's `onFocus`
listens for `focusin` at its root) therefore never opened it while the agent's tab was not in
front. `e2e/session-window.test.ts` checks what `type`, `click`, `fill_form` and `press_key` give a
page behind the user's window, and that a page in front sees only Firefox's own events.

Not measured: a headed Firefox under a desktop window manager, and a minimized window (headless
keeps it focused).
