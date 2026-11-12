# 0022: Every page request remembers the page's password fields before it acts

**Status:** Accepted, 2026-10-23. Supersedes the rule of
[0010](0010-page-tools-withhold-credential-field-values.md) that the content script remembers
password fields at the start of every read, and its consequence that a field the page switches
before the first read_page in a document shows its value. Supersedes the wording of
[0013](0013-screenshots-hide-credential-field-text.md) that the remembered password fields are
the ones read_page saw.

## Context

ADR 0010 keeps a password field protected after the page turns it into text, but only if
read_page saw it as a password field first: only read_page added to the content script's set of
remembered fields. ADR 0013 hides every top-document input in a screenshot once a remembered
field was revealed, so it had the same gap. In this sequence the password reached the agent:

1. A login field holds a password, typed by the user or filled by Firefox, with no
   `autocomplete` token, or after Firefox's autofill mark is gone (ADR 0021).
2. The agent's first request in that document is a screenshot, or a click by coordinates on
   the page's show-password toggle, which sets `type = "text"`.
3. read_page then returns the value as the field's text, and a later screenshot draws it.

The switch in step 2 can be the agent's own action, so ADR 0010's acceptance of page-driven
switches before the first read does not cover it.

## Decision

- `handlePageMessage` (`apps/extension/src/page-messages.ts`) takes a `before` hook and calls it
  inside `run`'s `try`, synchronously right before every handler, so no page script runs between
  it and the handler starting. It does not run for a message that reaches no handler. A throw
  from it fails the request with `page_error`, and the handler does not run.
- `content.ts` passes `notePasswordFields` (`apps/extension/src/read-page.ts`), which adds every
  input with type `password` in the document and its shadow roots, closed and hidden ones
  included, to the per-document set. It is the one recording path: `readPage` no longer records
  by itself.
- So every request through the content script records: read_page, get_page_text, screenshot's
  `element_rect` and `password_fields`, upload_file, click, hover, scroll, drag, type,
  press_key, read_console and wait_for.

## Alternatives rejected

- **Watching the page from load**, with a MutationObserver or an injection at
  `document_start`: it needs a content script registered by URL, which ADR 0009 rejects, and it
  still could not run before Firefox's autofill.
- **A MutationObserver started at the first request**, recording `type` changes away from
  `password`: it would also catch a field that becomes a password field and is switched between
  two requests, but it needs an observer on the document and on every shadow root, closed ones
  and ones attached later, alive for the document's lifetime. The switches it adds are the
  page's own, and a page that switches a field by itself can as well copy the value into any
  text, which ADR 0010 already accepts.
- **Recording only in the tools that act**: a screenshot or get_page_text first, then the page's
  own switch, would still leak. One hook in the dispatch covers every request, including tools
  added later.

## Consequences

- A field the page switches before the first Foxleash request in a document still shows its
  value, and so do a new text field the page puts in place of a password field and a password
  field the page creates and switches between two requests.
- Each page request walks the whole document once more. wait_for polls every 250 ms, so a wait
  walks it about four times a second, on top of the walk its text check already does.
- Password fields in frames are still not remembered: the content script runs in the top frame
  only (ADR 0009).
- Tools that send no request to the content script (tabs_list, tab_open, navigate, tab_close,
  tab_select, resize_window, read_network, download) record nothing.
- A field the page reuses, one `<input>` that is a password field in one step of a form and a
  text field holding a name in the next, or one the user reveals, stays `protected` once any
  earlier request saw it as a password field, not only after a read_page. The agent then cannot
  read back what it typed there, and every later screenshot hides the text of every
  top-document input.
