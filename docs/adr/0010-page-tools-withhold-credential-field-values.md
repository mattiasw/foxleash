# 0010: Page tools never return the value of a password, one-time code or card number field

**Status:** Accepted, 2026-10-19. Its definition of a protected field is extended by
[0021](0021-autofilled-fields-are-protected.md), 2026-10-23. Its rule that password fields are
remembered at the start of every read is superseded by
[0022](0022-page-requests-remember-password-fields.md), 2026-10-23.

## Context

read_page writes the value of form fields into its tree, so the agent can check what it typed
and what a page has filled in. Firefox fills saved logins into login forms when the page
loads, without a click. A session that the user approved for a site with a login page would
therefore hand the saved password to the agent the moment it reads that page, and a page that
injects instructions into the model could then ask for it to be sent anywhere.

The value of a password field is not something the agent needs to read: it can see that the
field is filled, and the user can check the rest. The same holds for one-time codes and card
numbers, which pages mark with `autocomplete` tokens.

## Decision

- A **protected field** is an `input` whose `type` property is `password`, an `input` that
  was a password field at an earlier read_page in the same document, or an `input` or
  `textarea` whose `autocomplete` attribute (case-insensitive, whitespace-separated tokens,
  read from the attribute) includes `current-password`, `new-password`, `one-time-code`,
  `cc-number` or `cc-csc`. The rule is `isProtectedField` and `isCredentialAutocomplete` in
  `apps/extension/src/page-tree.ts`.
- A protected field's line shows `protected`, plus `filled` when it holds a value, and never
  the value. The line formatter's types make a protected field with a value impossible to
  write.
- No other path carries a control's value: names never include text from inside an `input`,
  `textarea` or `select`, a textarea's child text (its default value) is never read, and only
  submit, reset and button inputs that are not protected take their name from `value`.
- At the start of every read, the content script remembers every input in the document with
  type `password` (a `WeakSet` in `content.ts`), shadow roots and hidden parts included and
  whatever the filter, depth or cap, so a show-password toggle that sets `type = "text"` does
  not reveal a field that was a password field at an earlier read.
- Later page tools that return page text or field values (get_page_text, fill_form,
  wait_for) follow the same rule.

## Alternatives rejected

- **Return every value.** It hands the saved password to the agent on any approved login
  page, which is the case this decision exists for.
- **Return no form values at all.** The agent could then not check what it typed or what a
  form holds, which the page tools need in order to fill forms reliably.
- **Mark protected fields in the DOM.** It would change the page, which read_page must not do
  (ADR 0009), and the page could remove the mark.

## Consequences

- The agent cannot read back a password or code it typed; it sees only `filled`.
- A field that the page switched from password to text before the first read_page in that
  document shows its value, as any text field does, and so does a new text field that a page
  puts in place of a password field, copying its value. Catching these would need watching the
  page from the start of every load, which Foxhand does not do.
- A credential field that the page marks with neither type `password` nor one of the tokens
  (a custom PIN field, for example) is read like any text field. Page text outside fields can
  still carry account details, as the add-on listing says.
