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

## Focus moves the page or Firefox makes during an act (2026-11-25)

Experiments on Firefox 160.0.1, headless, on Linux, through the end-to-end harness, with the
setting "each agent session in its own window" on and
`browser.windows.update(id, { focused: true })` from the settings page putting the session's
window in front of or behind the user's, waiting until the page's `document.hasFocus()` matched.
Capture listeners on the top window and on each frame's window recorded `focus`, `focusin`,
`blur` and `focusout` with `isTrusted` and
`relatedTarget`, and `keydown`, `keyup`, `cancel` and `close`. The log, and `activeElement` and
`hasFocus()` of every document, were read 200 ms after each step. The steps were Foxleash's own
`click`, `type` and `press_key` (a ref from `read_page`), and script calls through WebDriver BiDi
`script.evaluate`; each case ran in a fresh tab. Only the events and the focus state were read,
not the tools' results.

The page: a `<div tabindex=0>` `wrapper` whose `focus` listener calls `inner.focus()` on the input
inside it; a field `top`; a button `opener` whose click calls `showModal()` on a dialog holding a
field `dfield`; a button `popener` whose click calls `showPopover()` on an auto popover holding a
button `pbtn`; two same-site frames written with `document.write`, `ebody` whose
`<body contenteditable>` is the editing host and `einner` holding a `<div contenteditable>` `ed`;
and, on a second page, two inputs whose focus listeners focus each other. Below, `x:y` is an event
at `x` with `relatedTarget` `y`, without `:y` when it is null; `*` marks Foxleash's untrusted
events. "Behind" is Foxleash before it reported these moves.

**A focus listener that passes focus on**

| Step | In front | Behind |
|---|---|---|
| script `wrapper.focus()` | focus:wrapper, blur:wrapper:inner, focusout:wrapper:inner, focus:inner:wrapper, focusin:inner:wrapper; no focusin at the wrapper | nothing; `activeElement` stays the wrapper |
| `click` on the wrapper | the same five events, all trusted | focus:wrapper\*, focusin:wrapper\*; `activeElement` inner, which got nothing |
| `type` into `top` next | blur:inner:top, focusout:inner:top, focus:top:inner, focusin:top:inner | blur:wrapper:top\*, focusout:wrapper:top\*, focus:top:wrapper\*, focusin:top:wrapper\* |

**A modal dialog a click opens, closed by Escape**

| Step | In front | Behind |
|---|---|---|
| `click` on `opener` | focus:opener, focusin:opener, blur:opener:dfield, focusout:opener:dfield, focus:dfield:opener, focusin:dfield:opener | focus:opener\*, focusin:opener\*; `activeElement` dfield, which got nothing |
| `press_key` Escape | keydown:dfield\*, cancel, blur:dfield:opener, focusout:dfield:opener, focus:opener:dfield, focusin:opener:dfield, keyup:dfield\*, close | keydown:dfield\*, cancel, keyup:dfield\*, close; `activeElement` opener, no focus events |
| script `opener.focus(); opener.click()`, then `requestClose()` | the same, without the key events | only cancel and close |

**An auto popover a click opens, with focus moved into it, hidden by Escape**

| Step | In front | Behind |
|---|---|---|
| `click` on `popener`, then on `pbtn` | focus:popener, focusin:popener; blur:popener:pbtn, focusout:popener:pbtn, focus:pbtn:popener, focusin:pbtn:popener | the same, Foxleash's |
| `press_key` Escape | keydown:pbtn\*, blur:pbtn:popener, focusout:pbtn:popener, focus:popener:pbtn, focusin:popener:pbtn, keyup:pbtn\* | keydown:pbtn\*, keyup:pbtn\*; `activeElement` popener, no focus events |

**A top-level field and same-site editor frames**

| Step | In front | Behind |
|---|---|---|
| `type` into `top` | focus:top, focusin:top | focus:top\*, focusin:top\* |
| `type` into `ebody` | blur:top, focusout:top, blur at the top `document` and `window`, focus at the frame's `document` and `window`, focus and focusin at the frame's body; nothing at the `<iframe>` element. Top `activeElement` the `<iframe>`, the frame's `hasFocus()` true | nothing; top `activeElement` the `<iframe>`, both `hasFocus()` false |
| `type` into `top` again | blur and focusout at the frame's body, blur at the frame's `document` and `window`, focus at the top `document` and `window`, focus:top, focusin:top | nothing |
| the same with `einner` | the same, with `ed` in place of the body | into the frame: focus:ed\*, focusin:ed\*, no blur at `top`; into `top` again: nothing |
| the frame's `activeElement` once focus is back in `top` | the frame's body | still `ed` |
| the same moves by script | as with the tools | nothing |

**Two inputs whose focus listeners focus each other**: in front, script `a.focus()` ran the
listeners without a bound (the page stopped itself at 50 focus events); behind, nothing.

So with the window behind, Firefox sends nothing for any of these moves. It restores focus inside
`requestClose()` and `hidePopover()`, before keyup. An element whose focus listener moves focus
on gets no `focusin`. The `<iframe>` element never gets a focus event, and the field focus leaves
for a frame gets its blur with `relatedTarget` null; a contenteditable frame body gets `focus` and
`focusin`. With the window behind, a frame that focus left keeps its `activeElement`, so whether
focus is in a frame has to be read from its parent.

`e2e/session-window.test.ts` checks these moves on the fixture page `/focus-moves` with the
session's window behind the user's, and the wrapper and dialog cases in front as the reference.

Not measured: a frame in `designMode`, a headed Firefox, and focus a page's timer moves after an
act.
