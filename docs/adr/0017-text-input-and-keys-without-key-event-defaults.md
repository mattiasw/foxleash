# 0017: type inserts text without key events, and press_key performs key defaults itself

**Status:** Accepted, 2026-10-23. Its rule that only http and https destinations are checked is superseded by [0018](0018-click-and-enter-refuse-destinations-outside-the-web.md), 2026-10-23. Its `type` refuses a field Firefox autofilled, by [0021](0021-autofilled-fields-are-protected.md), 2026-10-23. Its caret at the end of an editable area is superseded by [0028](0028-type-adds-text-at-the-caret-of-an-editable-area.md), 2026-10-24.

Amended 2026-11-25: the act tools send the focus events Firefox holds back from a page not in
front.

Amended 2026-11-25: Foxleash also reports focus moves the page or Firefox makes during an act, in
rounds of at most 10.

## Context

Firefox gives extensions no trusted input (ADR 0014), so `type` and `press_key` can only work
from Foxleash's content script in the tab's top frame (ADR 0009), with DOM calls and synthetic
events.

Measured with `foxleash probe` in Firefox 159 on a plain input, a contenteditable, Gmail's search
box and compose body, Google Docs' title input and its document body:

- Synthetic key events never insert text, in any of them.
- `document.execCommand("insertText")` inserted text in every target whose text can be read,
  and Firefox fired the resulting `input` event as trusted. It can fail silently.
- Setting an input's value through the prototype setter, then an `input` event, worked where
  frameworks track the value themselves (React-style). A cancelable `beforeinput`, then DOM
  insertion and an `input` event, worked in Gmail's compose body.
- In Google Docs both execCommand and beforeinput plus DOM insertion inserted text into the
  document, which draws its text on a canvas, so reading it back sees nothing.
- An Enter keydown did not submit a form; `requestSubmit()` did. A Tab keydown did not move
  focus; `focus()` did.

Enter's default actions navigate: implicit submission and a click on a link or submit button.
Without a check, a page could get a fooled agent to type what it read into a form whose action
is on another site and press Enter, the leak ADR 0014 closes for clicks.

## Decision

The page code is in `apps/extension/src/page-input-dom.ts`; the parsers, reply checks and pure
rules (key syntax, tab order, implicit submission, option stepping) are in
`apps/extension/src/page-input.ts`.

- **type** focuses the field or the element's editing host, puts the caret at the end, and
  inserts with `execCommand("insertText")`, then reads the field's value, or the host's text and
  number of elements (a typed line break may add only a `<br>`), back after about 100 ms. Only
  when nothing changed and no `input` event from the browser reached the page does it fall back,
  once: the native value setter of the field's own window plus an `input` event, or a cancelable
  `beforeinput` plus a text node at the caret and an `input` event. A page that received the
  input event and shows nothing new took the text (an editor's input that clears itself) or
  refused it; a fallback could give it the text twice, so that is `no_effect` at once. The
  setter fallback never overfills `maxlength` and sets the old value back when the field would
  not keep the new one (a number input given letters). An input whose caret cannot be set
  (email, number) that already holds text skips execCommand, which would insert wherever the
  caret is. Nothing is inserted more than 5 seconds after the call began. An editor frame on the
  page's own site (Google Docs' input frame) is entered; its text cannot be read, so the reply
  is `sent_unconfirmed`. The reply says only how the text went in, never a value.
- **press_key** sends keydown, keypress (Enter and characters, without Control or Meta, and
  not after a cancelled keydown) and keyup with `key` and `code` only, then performs the
  default action itself unless the page cancelled one of them, and for Enter and the arrow keys
  only on an element a keyboard could reach (it took focus and is not disabled): implicit
  submission with HTML's default-button and one-field rules, as a `click()` on the default
  button (as Firefox does, so the page's click listeners run) or else `requestSubmit`, `click()`
  on a button, link or summary, sequential focus navigation for Tab and Shift+Tab (the flat
  tree, shadow roots included, positive tab indexes first, and a focused element outside the
  order as the starting point), closing the last open auto popover or modal dialog for Escape
  (not one with `closedby="none"`), and the next enabled option of a select for the arrow keys.
  A form that constraint validation stops is still asked to submit, so the page shows its
  messages, and reports `none`.
- **Enter never opens a page on another site.** After keydown and keypress, right before the
  default action, Enter is refused with `cross_site_navigation` when the link, the default
  button or the form's own action leads to another site, through the same check click uses
  (ADR 0014). keyup is sent first, as for a released key.
- **Focus events where Firefox sends none.** In a document without focus, Firefox moves focus
  without events ([measurements](../measurements/focus-events.md)). When it sent none, Foxleash
  sends `blur` and `focusout` to the element the page was told has focus, then `focus` and
  `focusin` to the new one, in Firefox's order with `relatedTarget`; never at the body, the root,
  `document` or `window`, and `hasFocus()` is unchanged. It remembers which element it told, so
  a click then a type give one focus. Firefox sends `change` for such a blur as for its own.
  It also reports a move the page or Firefox makes during an act: as a focus listener passes
  focus on, before the act goes on; focus Firefox restores when Escape closes a dialog or
  popover, before keyup; and any other by the time the act ends, such as into a dialog a click
  opens. As focus enters or leaves a same-site editor frame the agent types into, the element in
  the document it leaves gets its blur, and a frame body that is the editing host gets the focus.
  A frame element never gets one; Firefox sends it none either.
- **Forms are read through prototypes.** A form control's name shadows the form's own property
  of that name, so `requestSubmit`, `elements`, `noValidate`, `getRootNode`, `baseURI` and the
  `action` attribute are read through `HTMLFormElement.prototype`, `Node.prototype` and
  `Element.prototype`.

## Alternatives rejected

- **Key events for insertion and for default actions.** The probe saw them insert nothing and
  submit or focus nothing.
- **A cross-site check before keydown.** A page that handles Enter itself, cancelling keydown,
  must keep working in a field whose form posts elsewhere; and the page's key listeners can
  rewrite an address, so only a check after them sees where Enter would go.
- **Legacy key codes (`keyCode`, `charCode`, `which`).** Whether Firefox runs its own default
  actions for untrusted events that carry 13 or 32 is unmeasured; if it did, it would submit or
  click before or without the cross-site check. They stay out until measured.
- **Key events around each character, for a list that opens on focus.** Focus was the cause,
  and key events insert nothing.
- **Focusing the session's window for real focus events.**
  [ADR 0044](0044-each-agent-session-in-its-own-window.md) rejects taking focus from the user.

## Consequences

- A page that reacts only to real keys does not react to press_key, and one that accepts only
  real typing gives `no_effect`.
- The key events of an Enter refused for another site have already reached the page.
- Tab does not enter frames, follow focus delegation or know the top layer's order: Escape
  closes the last open popover in tree order.
- The validity of form-associated custom elements is not read, so such a form can report
  `submitted` while its validation stopped it.
- A page brought to the front gets Firefox's real focus on top of the one Foxleash sent.
- A focus move the page makes after an act ends, from a timer, gets its events only when the
  next act ends, and only in a page Foxleash already sent focus events. The `document` and
  `window` events Firefox sends as focus enters or leaves a frame stay unsent, a frame the agent
  never typed into gets none when the page moves focus into it, nor does the body of a frame in
  `designMode`.
