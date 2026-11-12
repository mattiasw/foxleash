# 0036: The propose page shows a proposal's whole sites and steps

**Status:** Accepted, 2026-10-30.

## Context

A saved recipe reaches later agent sessions as the user's own instructions
([0035](0035-recipes-saved-and-run-only-by-a-user-click.md)), and an agent proposes one on a
page where the user reads it and clicks Save. That page showed the steps in a fixed 12-row
field and the sites in a 4-row one, each with its own scroll. A proposal longer than the
field, for example with 60 line breaks before an instruction, pushed that instruction out of
view while Save stayed in view below the field. The user would save text the page never
showed.

## Decision

- On the propose page (`propose.html`), the sites and steps fields carry the class `whole`.
  In `pages.css` that class has no scroll of its own (`overflow: hidden`) and no drag handle,
  breaks long words (`overflow-wrap: anywhere`), and lets a run of spaces or tabs take rows of
  its own (`white-space: break-spaces`). In a default field Firefox 156 lets a run of spaces
  hang at the end of its row and starts the text after it on the next row, so the run's length
  does not show; with `break-spaces` it shows as blank rows.
- `propose.ts` grows those fields to their text, never below their `rows`: after the page
  fills them (a proposal or a restored draft), on every input, and whenever the box of the
  steps field's label changes. The label is as wide as the fields and its text scales with
  theirs, so its box changes with a window resize, a page zoom, text-only zoom or the page's
  own scrollbar; fitting the fields changes it only when it turns that scrollbar on or off,
  and the refit settles in the next frame.
- A Save click first checks that each of those fields shows all of its text (its scroll size
  at most 1 px over its client size). If one does not, the page refits the fields, does not
  save, re-arms the buttons, moves focus to that field and says why.
- `checkRecipe` (`recipes.ts`) folds three or more line breaks in a row in the steps to two,
  on the settings page too.

The guarantee is the layout together with the Save-time check. The fold is hardening that
keeps blank padding short; it does not stop padding: 19,000 tabs in one line, or
`'\n.'.repeat(9000)`, still pass `checkRecipe` and make a long page, which the user scrolls
past to reach Save.

## Alternatives rejected

- A scrolling field with a line count: the user still has to scroll a box to read all of it,
  and a count is easy to overlook.
- A read-only copy of the steps beside the editor: two renderings of one text to keep the
  same.
- Folding every run of spaces in the steps: it changes spacing the steps keep on purpose, and
  long real steps hide text just the same in a fixed field.
- CSS `field-sizing: content`: Firefox supports it from version 152 (`@mdn/browser-compat-data`
  8.1.4, `css.properties.field-sizing`), and Foxleash supports 142
  ([0034](0034-firefox-142-is-the-minimum-version.md)).
- A window `resize` listener alone: the page's own scrollbar appearing and text-only zoom
  change the fields' wrapping without a `resize` event.

## Consequences

- A long proposal makes a long page, and Save is below all of it.
- A reflow after the last fit, such as a fallback font that loads late, is not refit until the
  next input, fill or label change, and `overflow: hidden` shows no scrollbar meanwhile; the
  Save-time check holds the bound then.
- Text that cannot fit at all, such as one character cluster wider than the field, blocks Save
  until the user edits it.
- The name and description are one-line inputs and are not covered here.
- The settings page keeps its 12-row steps field.
