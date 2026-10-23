# 0013: Screenshots hide the text of credential fields with a user style sheet in every frame

**Status:** Accepted, 2026-10-20. Supersedes the consequence of
[0011](0011-screenshots-saved-by-the-mcp-server-in-its-working-folder.md) that screenshots show
form fields as the page draws them. Its rule that a frame refusing the sheet refuses the
screenshot is superseded by [0020](0020-screenshots-pass-over-frames-showing-an-error-page.md),
2026-10-23. Its field mask's selectors are extended by
[0021](0021-autofilled-fields-are-protected.md), 2026-10-23. Its wording that the remembered
password fields are the ones read_page saw is superseded by
[0022](0022-page-requests-remember-password-fields.md), 2026-10-23: they are the ones any page
request saw.

## Context

ADR 0010 keeps the values of password, one-time code and card number fields out of read_page
and get_page_text. ADR 0011 recorded that screenshots did not follow: `tabs.captureTab` returns
pixels, Firefox masks only fields of type password, and a card number, card security code or
one-time code field, or a password field the page shows as text, appears with its value. Payment
fields usually sit in frames from another site.

read_page's rule cannot simply be reused. It decides per element in the top document, through
the content script, but a screenshot is pixels of every frame, and Foxhand's content script runs
only in the top frame (ADR 0009). The fields read_page remembers as password fields live in a
`WeakSet` in the content script, which CSS cannot select, and ADR 0010 rejects marking them in
the DOM.

These findings come from reading Firefox 156's own extension code and form style sheet:

- `scripting.insertCSS` with `allFrames: true` skips, without an error, every frame the
  extension may not run in, and rejects only when no frame took the sheet. A target of a single
  frame id that Firefox will not enter rejects.
- `insertCSS` sets `matchOriginAsFallback`, so `about:blank`, `about:srcdoc`, `data:` and `blob:`
  frames take the sheet under the origin of the document that created them.
- `insertCSS` and `removeCSS` have no `injectImmediately` in Firefox and run once the frame is
  idle: a frame still loading delays the insertion, and a removal can wait the same way.
- Firefox's `forms.css` sets `color: FieldText !important` on autofilled fields, and a
  user-agent `!important` declaration beats a user one, so `color` alone cannot hide an
  autofilled value.
- A frame that commits a new document after the insertion does not have the sheet.

## Decision

Every screenshot, of the viewport or of an element, hides the text of protected fields, and
returns no image when that cannot be put in place.

- **The field mask** (`FIELD_MASK_CSS` in `apps/extension/src/screenshot.ts`) is a user-origin
  sheet built from read_page's own token list (`CREDENTIAL_TOKENS` in `page-tree.ts`), so the
  two rules cannot drift. It selects `input[type="password" i]` and, for each token,
  `input[*|autocomplete~="<token>" i]` and `textarea[*|autocomplete~="<token>" i]`, in one rule,
  and the same selectors with `::selection` in a second rule, so a selector Firefox rejects
  cannot drop the other rule. Every declaration is `!important`: `color`,
  `-webkit-text-fill-color` (which hides autofilled text), `-webkit-text-stroke-color`,
  `text-emphasis-color`, `text-decoration-color` and `caret-color` transparent, `text-shadow:
  none`, `background-clip: border-box` and `transition: none`, so a page's stroke, shadow,
  emphasis marks, underline, clipped background or colour transition cannot draw the text.
  A user-origin `!important` declaration beats the page's author `!important`, inline styles and
  animations, applies inside shadow roots, and is not visible to the page's CSSOM. A third rule
  makes `::view-transition-old(*)` transparent. During a view transition the user sees a
  snapshot of the page taken when the transition started, which can predate the sheet. Firefox
  156's `tabs.captureTab` draws the live page instead, with the sheet, so there the rule changes
  nothing; it is there to keep the snapshot out of a capture that paints it, as WebDriver BiDi's
  `browsingContext.captureScreenshot` does in the same Firefox.
- **The input mask** (`INPUT_MASK_CSS`) has the same declarations for every `input` of the top
  document. A `password_fields` request to the content script (`passwordFieldsRevealed` in
  `read-page.ts`, registered in `content.ts`) answers whether a field read_page remembers as a
  password field, in the document or its shadow roots, now has another type. When it does, the
  input mask goes into the top frame too. When it does not, the request is made again after the
  capture, and a field revealed in between refuses the screenshot as a page change. The reply is
  read as untrusted input: an own boolean `revealed`, anything else is `page_error`.
- **One insertion per frame** (`handlers.ts`): Foxhand lists the tab's frames with
  `webNavigation.getAllFrames` and inserts the field mask into each with its own
  `frameIds: [id]` target, then captures with `tabs.captureTab` exactly as before. A frame that
  refuses the sheet, a list Firefox cannot give, or one without the top frame refuses the
  screenshot with `screenshot_failed`, without Firefox's error text and without a capture.
  Listing, insertion and capture share `CAPTURE_TIMEOUT_MS`; an insertion still pending then
  answers `page_timeout`, and nothing is captured after that.
- **Each screenshot's sheets are its own.** Firefox reuses one sheet for a given text, and a
  document holds a sheet once, so two screenshots of one tab inserting the same text would share
  it, and the first removal would unmask the second capture. Each screenshot appends a comment
  with a random id to the text it inserts, and removes exactly that text. Nothing from the request
  or the page goes into the CSS.
- **Removal is started, not awaited.** After the capture settles, and after a failed list,
  insertion or timeout, Foxhand removes every sheet the screenshot tried to insert, each once
  its own insertion settled, without waiting for the removals. A removal that fails does not withhold
  the image: it was taken with the sheets in place.
- **Frame loads refuse the screenshot.** From before the first site gate until after the
  second check, a `webNavigation.onCommitted` listener notes any commit in the tab, in any frame,
  the top one included, and the screenshot is refused as a page change, which tells the agent to
  try again. This covers a frame that loads a document without the sheet, and a same-site load of
  the top document, which the site watch does not see.
- **One deadline.** The screenshot may now make up to three page requests, so a whole
  screenshot is bounded by `SCREENSHOT_TIMEOUT_MS` (50 s), below the host's 60 s request timeout,
  and answers `page_timeout` when it passes. Once it has passed, Foxhand inserts no sheet and
  starts no capture.

## Alternatives rejected

- **`insertCSS` with `allFrames: true`**: Firefox skips a frame it will not enter without an
  error, so a frame the sheet never reached would be captured with its fields drawn.
- **Painting boxes over the PNG in the background**: it needs a PNG decoder and encoder in the
  extension, and the field rectangles, measured in each frame, race with the page the same way.
- **Structural selectors** (`:nth-child` paths) for the remembered fields: they race with page
  changes and cannot cross shadow roots.
- **DOM marks or `element.style` writes** on the fields, and **setting `type = "password"`
  back**: they change the page, and ADR 0010 rejects marks.
- **Refusing every screenshot of a page with such fields**: login and payment pages are where
  an agent most needs to see what it is doing.
- **One shared constant sheet**: concurrent screenshots of one tab would unmask each other.
- **Awaiting the removal**: Firefox removes a sheet only once the frame is idle, so a frame
  that never becomes idle would hold the tool result and its listeners.
- **Injecting a script into every frame** to confirm each took the sheet: ADR 0009 keeps
  Foxhand's scripts to the top frame.

## Consequences

- The page can observe the transparent computed style while a screenshot is taken. A field
  with a transition on its colour fades back in over that transition afterwards, and
  `transition: none` also ends a size transition the page runs on that field at that moment.
- On a page where the agent read a password field that the page then turned into another kind
  of field, every input's text in the top document is hidden, button labels included; frames
  are not affected.
- Password fields show empty, without Firefox's bullets.
- Fields marked neither way, and a value the page copies into a new text field or any other
  element, still show, as in ADR 0010; so do glyphs of a colour font, which keep their own
  colours. The sheet styles the field itself, so a page that draws through the field's text from
  an element around it, such as `background-clip: text` on an ancestor behind a field with a
  transparent background, is not covered. A page that reveals a remembered field and turns it
  back within the capture is not seen. A frame a page script creates without a URL and writes into during the capture is not
  seen by the frame watch.
- A page whose frames keep loading documents, such as rotating ads, refuses some screenshots
  with "try again".
- A page holding a frame Foxhand cannot enter, such as another add-on's frame (a password
  manager's inline menu) or a site Mozilla keeps add-ons off, cannot be captured.
- Every screenshot now injects the content script, so a page Firefox keeps extensions out of
  cannot be captured.
- A frame whose document never finishes loading, such as one that streams its HTML, never takes
  the sheet, so every screenshot of that page times out.
- A failed removal returns the image and leaves that page's protected field text transparent
  until it reloads. So can a page the tab leaves while a screenshot is taken: the removal goes to
  the frame, which by then shows the new document, and Firefox can restore the old one, sheet
  and all, from its back-forward cache when the user goes back.
- During a view transition a screenshot shows the live page, which is not what the user sees
  until the transition ends.
- Verified in Firefox 156 with the end-to-end tests (`e2e/screenshot.test.ts`):
  - The sheet reaches a protected field in an open shadow root.
  - A protected field's selected text is hidden, while the selected text of a plain field is
    painted.
  - `tabs.captureTab` draws the live page during a view transition: the view transition case
    checks that the transition is still running and that a frame's field is drawn. It passes
    without the `::view-transition-old(*)` rule.
  - Firefox's PDF viewer does not let the content script in, so a PDF tab cannot be captured,
    and a page that frames a PDF is refused, because that frame does not take the sheet.
  - The five cases that look for protected field text fail when the mask has no declarations,
    and also without `transition: none`, as the fixture's field with `transition: all 60s` then
    shows its text. The case of a revealed password field fails when the content script always
    answers that none was revealed.
