# 0023: fill_form sets each field by its kind and reports every field

**Status:** Accepted, 2026-10-24. Builds on the text input of
[0017](0017-text-input-and-keys-without-key-event-defaults.md), the withheld values of
[0010](0010-page-tools-withhold-credential-field-values.md) and the autofill refusal of
[0021](0021-autofilled-fields-are-protected.md).

## Context

Filling a form with `type`, `click` and `press_key` takes one call per field, and `type` only
appends. `fill_form` sets many fields in one call: text fields and textareas, selects, checkboxes
and radio buttons, each by its read_page reference. Several choices here have an obvious
alternative that a contributor would reach for, and each would break a page or the safeguards:

- Custom-styled checkboxes and radio buttons are usually invisible, under their label or a
  styled sibling, so ADR 0014's pointer events with the covered-element check would refuse most
  of them. A keyboard user toggles them without the pointer at all.
- Firefox fires its own trusted `change` on a text field when it loses focus with a value that
  differs from the one it had at focus. A synthetic `change` sent while the field keeps focus
  gives the page a second one when focus moves on, which the next field's focus does.
- A text field's result that depends on what the field held (an "unchanged" short-cut, or which
  path the text took, which can differ when the new text equals the old) would let an agent
  learn whether a guess equals a password field's value, which ADR 0010 withholds.
- execCommand into a number field holding "12" with "abc" leaves `.value` at "" while the field
  shows "abc", so reading the value back alone cannot tell success from the browser's value
  sanitization.
- The page reply times out after 10 seconds (`PAGE_REPLY_MS`), measured from the background's
  send, which also covers delivery, the `before` hook of ADR 0022 and any long task the page runs.

## Decision

`fillForm` (`apps/extension/src/page-fill-dom.ts`) walks the fields in request order and gives
each one result, `{ ref, ok, outcome }` or `{ ref, ok, code, message }`; one field's failure, or
any exception in it, never stops the others. Each ref is resolved when its turn comes. The
background (`fillFormResultOf` in `apps/extension/src/page-fill.ts`) rebuilds every entry from
those fields only, in the requested order with the requested refs, and caps messages.

- **Text fields** replace their content. The disabled, read-only and `:autofill` refusal is the
  one `type` uses (`refuseLockedField` in `page-input-dom.ts`), checked again after `focus()`,
  since the page's focus listeners run there. A value the browser would sanitize on an input of
  the field's type and `multiple` (checked on a detached input in the field's document) is
  refused with `invalid_params`, as is text longer than the field's maxlength. Foxhand selects the field's content and runs execCommand
  `insertText`, or `delete` for an empty string; with no trusted `input` it falls back once to
  the native setter plus an `input` event. It then blurs the field. Firefox sends its own
  `change` at the blur when the value differs from the one it recorded at focus, which its value
  setter moves along when the field still held it; a field that has focus when its turn comes is
  blurred first, so that Firefox records it at Foxhand's focus. Where Firefox will send none,
  Foxhand sends `change` just before the blur, and after the blur only when Firefox sent none
  after all, so the page sees exactly one, in the same order whatever the field held. Its type,
  maxlength and the sanitization check are read again after `focus()`. It reads the value back
  once more, so a field that clears itself on blur, such as a suggesting box, is `no_effect`. The
  result is `typed` whatever the field held and never names the path the text took.
- **Selects** match each wanted string against option values first, then labels
  (`optionMatcher`), refuse a missing or disabled option, and set the whole selection, then send
  `input` and `change`, as `press_key`'s arrows do; `unchanged` when the selection already is so.
- **Checkboxes and radio buttons** take a boolean (`true` only for a radio button) and are
  `element.click()`ed when their state differs, so the page sees click, input and change in the
  browser's order. A checkbox inside a link is its own click's activation target, so the link is
  not followed.
- **Password fields** are noted before each field, as before each request (ADR 0022): one
  field's events may add a password field that a later field in the same call turns into text.
- **Time**: no field starts after `FILL_START_LIMIT_MS` (4 s) from fillForm's start; such fields
  get `not_attempted`. No text goes in after 5 s, the bound `type` has, giving the last field
  about `type`'s margin under the 10 s page reply.
- At most `MAX_FILL_FIELDS` (50) fields and `MAX_FILL_CHARS` (100,000) characters across all
  values, an empty string counting one; each ref at most once.

## Alternatives rejected

- **Pointer events with the covered-element check for checkboxes.** Refuses the common
  custom-styled checkbox, and the page's own click and change handlers run either way.
- **Always dispatching `change` after the fill.** Two change events once focus moves on.
- **Reporting `unchanged` for text, or the input method as `type` does.** A guessing oracle on
  protected fields.
- **Stopping at the first failing field.** The agent would have to work out which fields were
  set; per-field results let it retry only the failed or not attempted ones.
- **A cutoff passed from the background.** A new request parameter the agent's input would also
  have to be kept from setting; the fixed bounds of `type` give the same margin.

## Consequences

- About 40 text fields fit in one call on an idle page, since each waits at least 100 ms for the
  page to settle; the rest get `not_attempted`. Unmeasured hypothesis: Firefox clamps timers in
  a background tab to one second, which would leave room for only a few text fields per call
  there, as it slows `type`.
- A select or checkbox whose change handler navigates or submits is the page's own script acting,
  the gap ADR 0018 accepts for clicks.
- A reformatting mask that changes the text as it goes in is reported `no_effect`; the fallback
  does not overwrite what the page made of the text.
- Whether Firefox fires a trusted `input` when execCommand replaces a selection with identical
  text is checked end to end; if it ever does not, the setter fallback still gives the same
  result.
