# 0017: type inserts text without key events, and press_key performs key defaults itself

**Status:** Accepted, 2026-10-23.

## Context

Firefox gives extensions no trusted input (ADR 0014), so `type` and `press_key` can only work
from Foxhand's content script in the tab's top frame (ADR 0009), with DOM calls and synthetic
events.

Measured with `foxhand probe` in Firefox 159 on a plain input, a contenteditable, Gmail's search
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

## Consequences

- A page that reacts only to real keys does not react to press_key, and one that accepts only
  real typing gives `no_effect`.
- The key events of an Enter refused for another site have already reached the page.
- Tab does not enter frames, follow focus delegation or know the top layer's order: Escape
  closes the last open popover in tree order.
- The validity of form-associated custom elements is not read, so such a form can report
  `submitted` while its validation stopped it.
