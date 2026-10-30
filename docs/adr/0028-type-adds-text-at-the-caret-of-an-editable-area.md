# 0028: type adds text in an editable area at its caret, else at its start

**Status:** Accepted, 2026-10-24. Supersedes the caret at the end of an editable area in [0017](0017-text-input-and-keys-without-key-event-defaults.md). Amended 2026-10-30: a caret just before the area's first block goes on that block's first line.

## Context

Under 0017, `type` puts the caret at the end of an editable area before it inserts. In a Gmail
compose body that already holds the user's signature, the typed text therefore went in after
the signature, so an email written through Foxhand ended up below it. An agent cannot work
around that: `fill_form` takes only inputs and textareas, and synthetic keys and clicks do not
move the caret.

Measured in Firefox 156 through the end-to-end harness:

- With a collapsed caret already inside an editing host that has focus, `focus()` on the host
  keeps the caret where it is.
- With the selection outside the host, or with no range at all, `focus()` moves a collapsed
  caret to the start of the host, its first text position.
- Focusing a text input or a textarea, including by typing into it, moves the document's
  selection out of an editing host: it becomes a point in the input's parent. So in a compose
  window where the recipients and subject (inputs) are filled first, no caret is left in the
  body by the time the agent types there.
- A frame whose body is editable, or whose document is in designMode, holds a collapsed
  selection at the start of its body before anything focuses it, and focusing the body keeps it
  there.
- After a caret is restored on an empty line above a signature, `execCommand("insertText")`
  inserts on that line, and a second insertion follows on after the first. A selection collapsed
  to its end before inserting keeps the selected text.
- With a caret collapsed directly in the host before its first block, at `(host, 0)` in front of
  `<div><br></div>`, `execCommand("insertText")` inserts in the host above that block, so the
  empty line stays below the text: `"Hi Ann,\n\nThanks.\n"` typed there leaves two empty lines
  above a signature instead of one. With the caret at the start of that block the text goes on
  the line, as Firefox's own focus places it. A page can leave the caret there; Gmail does after
  opening a reply.

## Decision

For an editable area (a contenteditable element, or an editor frame's editable body), `type`
first focuses the element as before, then reads the window's selection. When its first range
lies inside the target element and its end point is in an editable place (the end container's
element, or a text node's parent, is `isContentEditable`), the text goes at that range's end: a
selection is collapsed to its end, so `type` adds text and never replaces what the page had
selected. Otherwise the text goes at the start of the target element, which is where Firefox
puts the caret when it focuses an editing host. Either point, when nothing comes before it in
the target element and it lies directly in an element just before a block, is moved to the
start of that block's first line, through nested blocks, as Firefox's focus and a click on the
line put it. It never enters a part that is not editable or not shown, nor a table, flex or grid
container, and a caret with anything before it, such as one between two blocks or in front of
the signature's block, stays where it is. A target that is part of an editing host, such as a
paragraph given by its reference, is judged against the target, not the host.

The `beforeinput` fallback applies the same rule to the selection as it is then, and its own
DOM insertion puts the text at the start of the element's first line when the caret is not in
it. Text fields are unchanged: the text goes after what they hold.

The code is in `apps/extension/src/page-input-dom.ts` (`placeCaret`, `caretInside`,
`insertionPoint`).

## Alternatives rejected

The page's caret when the selection is inside the element before focus, else the end: after the
agent types into the recipient or subject field the body holds no caret, so the text still goes
after the signature, and a frame editor always has a caret at its start, so the rule would not
even be uniform.

The caret after focus, else the end: for an editing host this gives the same result, since focus
has already put the caret inside. For a part of one, Firefox's focus puts the caret in the
host's first part, so the first paragraph would get text at its start and the others at their
end.

An explicit position parameter: a protocol change, and the agent would have to know when to
use it. The default should be where a person starts typing.

Always the end, as 0017 had it: the signature case above.

Recognising signatures or quoted messages: that depends on each page's markup.

## Consequences

An agent cannot add text at the end of an editable area that holds text and has no caret in it:
synthetic keys and clicks do not move the caret (0014, 0017), so the text goes at the start,
also for a named paragraph. Text typed in two calls with another field focused in between comes
out in reverse order, since focusing the field moves the caret out of the area; the tool
description tells the agent to type a body in one call, after the other fields. Revisit when an
agent needs either, for example with `press_key` moving the caret or with Foxhand remembering
where its last insertion ended.

The end-to-end fixture models a body with an empty first line above a signature; whether
Gmail's body takes the text above the signature is checked in Gmail itself.
