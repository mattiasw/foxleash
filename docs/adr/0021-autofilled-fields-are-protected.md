# 0021: Fields Firefox autofilled are protected until the user edits them

**Status:** Accepted, 2026-10-23. Extends the definition of a protected field in
[0010](0010-page-tools-withhold-credential-field-values.md) and the field mask's selectors in
[0013](0013-screenshots-hide-credential-field-text.md).

## Context

Firefox fills saved logins into login forms when the page loads, and saved cards and addresses
when the user picks one. Form autofill finds card fields by heuristics, so a card number field
it fills can have no `autocomplete` token, and a username field never has one of ADR 0010's
tokens. Such a field matched neither read_page's rule nor the screenshot mask: read_page showed
the filled card number or username as its value, and a screenshot drew it.

Firefox marks each field it fills with its autofill state, which the CSS pseudo-class
`:autofill` matches, and clears the mark when the field is edited. Experiments on Firefox
156.0.1 showed:

- Login autofill marks the username field it fills, with no `autocomplete` attribute on it, and
  the password field.
- An `execCommand("insertText")` into the field, which is what `type` does first (ADR 0017),
  clears the mark: the field then holds the filled value plus the agent's text, unmarked.
- An untrusted `input` event clears login autofill's mark. Setting the value with the native
  setter alone does not. Form autofill (cards, addresses) clears its mark only on a trusted
  `input` event, and execCommand's is trusted.
- A normal reload, the load `tabs.reload(tabId)` starts, restores the field's value from the
  page's saved state without the mark. A reload that bypasses the cache restores no field value.
- Going back to a page kept in the back-forward cache brings the document back with its mark;
  going back to a `Cache-Control: no-store` page restores no field value.

## Decision

- An `input` or `textarea` that matches `:autofill` at the time of the read is protected in
  read_page and in every page tool that follows ADR 0010's rule. The fact is read at each read
  (`matches(":autofill")` in `isProtected`, `apps/extension/src/read-page.ts`, passed as
  `autofilled` to `isProtectedField` in `apps/extension/src/page-tree.ts`), never remembered.
- The screenshot field mask selects `input:autofill` and `textarea:autofill` in its existing
  two rules (`FIELD_SELECTORS` in `apps/extension/src/screenshot.ts`).
- `type` refuses a field that matches `:autofill` with `not_editable` (`typeTarget` in
  `apps/extension/src/page-input-dom.ts`), since typing into it would clear the mark and hand the
  filled value to the next read.
- `navigate`'s reload passes `bypassCache: true` to `tabs.reload` (`apps/extension/src/handlers.ts`),
  because a normal reload restores the value without the mark.

## Alternatives rejected

- **Protecting only card-like autofilled fields**: nothing in the DOM says which kind of data
  Firefox filled.
- **Remembering autofilled fields after an edit**: a field the user edited holds what the user
  typed, and remembering needs per-document state in every tool.
- **Remembering a field `type` typed into** instead of refusing it: it needs per-document state
  in every tool and a screenshot reveal path like 0013's for remembered password fields.
- **A separate CSS rule for `:autofill`**, so a Firefox that rejects the selector keeps the
  other selectors: every Firefox the manifest allows (`strict_min_version` 140) parses it.

## Consequences

- Usernames, email addresses and postal addresses that Firefox filled also show as
  `protected filled` and are hidden in screenshots until the user edits them, so the agent
  cannot read back a username Firefox filled.
- The agent cannot type into a field Firefox filled; it has to ask the user to edit it.
- A value the page copies elsewhere still shows, as in ADR 0010. A page script that dispatches
  an `input` event clears login autofill's mark, after which the field shows its value. A select
  that form autofill fills (card expiry, country) still shows its option. Firefox's autofill
  preview, drawn while the user hovers a suggestion, is not covered.
- `navigate` reloads without the cache: a reload fetches the page and its resources again, and
  form fields lose what was typed into them. Unverified: as with the user's forced reload,
  Firefox may also skip the page's service worker for that load.
- A reload the page's own script starts restores the value without the mark. Unverified: going
  back or forward to a page that is cacheable but not kept in the back-forward cache, and
  Firefox restoring a tab it unloaded or a session after a restart, may do the same.
- Verified in Firefox 156 with the end-to-end tests (`e2e/read-page.test.ts`,
  `e2e/screenshot.test.ts`): login autofill sets `:autofill` on a username field without an
  `autocomplete` token; read_page reads it as `protected filled`; `type` is refused and the mark
  stays; a `navigate` reload brings back no value; Firefox's own capture draws its text while
  Foxhand's screenshot does not, and a plain field's text is drawn. Card and address autofill are
  not covered by the end-to-end tests: they need the user's pick in Firefox's popup.
