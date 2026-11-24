# 0080: click and Enter do not send a protected field's value in a form sent with GET

**Status:** Accepted, 2026-11-18.

Amended 2026-11-24: the click upload_file makes on a button or link runs under the same guard ([0107](0107-upload-file-catches-the-file-picker-a-click-opens.md)).

## Context

Foxleash withholds the values of protected fields from text results: password fields, one-time
code and card number fields, and text fields Firefox filled in
([0010](0010-page-tools-withhold-credential-field-values.md),
[0021](0021-autofilled-fields-are-protected.md)). A form sent with GET puts the values of its named
fields in the address of the page it opens, and the agent gets that address in the action's
result (`after.url`), in `tabs_list` and in `read_network`.

Measured in Firefox 156.0.1: a page with `<form action="/after">`, a user and a password field,
and a saved login that Firefox fills in. `read_page` shows both fields `protected filled`, and
`press_key` Enter on the password field returns
`"url": "http://127.0.0.1:44461/after?user=saved-user-Q7xa&pass=pw-saved-Zk4mT9"`. A click on the
submit button does the same, with no page script, in the default configuration. So does a form
whose script handles the submission but has not attached its listener yet, or whose script
failed. Only the cross-site check of [0018](0018-click-and-enter-refuse-destinations-outside-the-web.md)
ran before the browser submitted the form.

## Decision

While `click`, `press_key` or the click `upload_file` makes on a button or link runs, the content
script (`withoutProtectedGetSubmit` in `apps/extension/src/content.ts`) cancels a submission that the page did not cancel itself, that is
sent with GET and whose form would send the value of a protected field, and the act then fails
with the code `protected_get_form` (`apps/extension/src/page-messages.ts`), whose message names
the field. The refusal takes precedence over the act's result; an error the act throws itself
passes through unchanged. The cross-site refusal still comes first: it throws before any event is
sent.

- **Last on the event's path.** The guard adds a bubble-phase `submit` listener to `window` and
  to every shadow root of the document, closed ones included, that exists when the act starts,
  and removes them all in a `finally` when the act returns. Listeners on one node run in the
  order they were added, so each runs after every listener the page had there. `submit` is not
  composed: a form in a shadow root sends a submit event whose path ends at that shadow root and
  never reaches `window`, so `window` alone would miss a web component's sign-in form. A shadow
  root's listener decides only when the event's path (`composedPath()`) ends at that shadow root:
  a light-DOM form slotted into a shadow tree passes the shadow root on its way to `window`, and
  deciding there would cancel a form that the page handles on `document` or `window`. Each event
  is decided once, by the listener on the last node of its path.
- **The method.** `submissionMethod` (`apps/extension/src/page-actions.ts`) takes the submitter's
  `formmethod` attribute when present, else the form's `method` attribute, matches `post` and
  `dialog` ASCII case-insensitively, and gives GET for anything else, so an unknown value errs to
  a refusal. Attributes are read through `Element.prototype`, since a control named `method`
  shadows the form's own property.
- **The fields.** The first listed control of the form (`formElements`,
  `apps/extension/src/page-input-dom.ts`) that is an `input` or `textarea`, is protected
  (`isProtected`, `apps/extension/src/read-page.ts`), is not disabled, and has a non-empty name
  and value. A form-associated custom element sends whatever its script passes to
  `ElementInternals.setFormValue`, with or without a name, so for such an element that is not
  disabled the first protected `input` or `textarea` with a value inside it, in its shadow tree or
  among its descendants, counts.
- **Fails closed.** If the listener's check throws, it cancels the submission and the act fails
  with a message saying Foxleash could not check the form.
- **Synchronous.** `actions.click` and `input.pressKey` fire the submit event synchronously
  (`button.click()`, `requestSubmit`, the synthetic click's activation behaviour), so the guard
  is synchronous. `upload_file` clicks a button or link through `actions.click` under the same
  guard. Other act tools send no click or Enter that submits and get no guard.
- A submit event a page script makes during the act is not told apart from the browser's: at
  worst it is refused needlessly.

## Alternatives rejected

- **Refusing the click or Enter before it is sent**, as cross-site destinations are. It would
  also refuse sign-in forms that a script handles and that carry no `method` attribute, which is
  most of them.
- **Redacting the address in results only.** The tab's address, its history and the site's logs
  would still hold the password, and `read_network`, `tabs_list` and `after.url` would each need
  the same redaction.
- **A capture-phase listener that cancels first.** Foxleash could no longer tell a form the page
  handles from one it does not, and pages that check `defaultPrevented` would break.
- **A listener on `window` only.** It misses forms in shadow roots, whose submit events never
  reach `window`.
- **A listener on the form, or on every shadow root without the path check.** It runs before the
  page's handlers on `document` and `window` (where React attaches its own), so it would refuse
  forms the page handles.
- **A `formdata` listener that removes protected values from what the form sends.** It would also
  cover a `form.submit()` during the act, but it silently changes what the site receives, and it
  covers nothing after the act.

## Consequences

- The agent cannot send such a form itself, even with a password it typed in; it asks the user.
- A page's own scripts can still put the values in an address: with `form.submit()`, which fires
  no submit event, also from the submit button's own click handler or from a `javascript:` link,
  whose script runs after the act returns; by handling the submission and putting the values in
  the page's address or in the address of a request it makes, which `read_network` shows; from a
  submit started after the act returned, such as from a timer; by stopping the event's
  propagation before the last node of its path; by adding a listener, a form or a shadow root
  during the act; or with a `formdata` listener that adds values. There is no event to stop these
  on without also refusing forms that the site's scripts handle, and they depend on the site's
  own code. A page script can read the field anyway.
- A form the user sends with GET is not touched, and its address reaches the agent through
  `tabs_list` and `read_network`.
- Each `click` and `press_key` walks the document's elements once more to find its shadow roots,
  as the protected-field bookkeeping before every page request already does.
