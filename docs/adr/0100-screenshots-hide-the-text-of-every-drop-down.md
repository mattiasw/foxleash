# 0100: Screenshots hide the text of every drop-down

**Status:** Accepted, 2026-11-19. Extends the field mask's selectors in
[0013](0013-screenshots-hide-credential-field-text.md).

Part of this record's context is left out: it is the subject of Firefox bug 2095903, which is not
public. Do not narrow the selector on the strength of what is written here.

## Context

The screenshot field mask (0013, 0021) selected a drop-down only while it matched
`select:autofill`, that is while Firefox had filled it in from a saved address or card or was
previewing one there. Firefox previews an entry while the user highlights it in its autofill menu
without choosing it: it draws the entry's option in each drop-down the entry has a value for.

A screenshot must never show a saved detail the user only highlighted, and an agent does not need
a screenshot for a drop-down's option: `read_page` gives the chosen one.

## Decision

`FIELD_SELECTORS` in `apps/extension/src/screenshot.ts` selects every `select` in place of
`select:autofill`, list boxes included, in the mask's two existing rules (the field rule and its
`::selection` rule). Nothing else in the mask changes. Text results are unchanged: `read_page`
gives a drop-down's chosen option, also one Firefox filled in, and never a previewed one.

## Alternatives rejected

- **Keep `select:autofill`**, or another selector that depends on what Firefox marks as filled in,
  such as `:root:has(:autofill) select`: the reasons are in the context left out above.
- **A mask keyed on a focused text field**, hiding every drop-down while a text field in the
  document has focus, since Firefox's menu belongs to a focused field: untested whether a preview
  can outlive that focus, or show in another frame than the focused field's. The end-to-end
  harness previews through the form autofill actor without opening the menu, so it cannot test
  that.
- **Leaving list boxes out** (`multiple`, or `size` above 1): Firefox 160.0.1's forms.css hides
  the label in a list box (forms.css :304-308), but 153.7.0esr's forms.css and select.css have no
  such rule, and whether its list box draws the label was not measured. Firefox tells the two apart
  with `IsCombobox()`, `!Multiple() && Size() <= 1` (HTMLSelectElement.h:325 at
  FIREFOX_160_0_1_RELEASE), parsing `size` as an HTML integer (HTMLSelectElement.cpp :1233-1234),
  so `size=" 1"` or `size="1x"` is a drop-down. Attribute selectors compare strings, so a mask
  leaving out `select[size]` other than "0" and "1" would leave out such drop-downs. Only
  `select[multiple]` could be left out safely, showing the text of multiple-choice list boxes and
  hiding that of single-choice ones. The mask does not depend on Firefox's own
  `:-moz-select-list-box` pseudo-class: a selector Firefox rejects drops its whole rule.

## Consequences

- Screenshots never show a drop-down's text, whether Firefox filled or previewed it or the page
  chose it. An agent that needs a drop-down's option reads the page as text, which gives it
  outside frames only, and the `screenshot` tool's description says so. A drop-down inside a frame
  therefore shows its option to the agent nowhere, since the text tools do not read frames; payment
  forms often sit in frames, and those are the drop-downs a card preview fills.
- A list box's options inherit the mask from the `select`, so they are drawn without their text
  unless the page styles the options' text itself, with its own `-webkit-text-fill-color`,
  `text-shadow` or similar on the option; an option's own `color` is not enough.
- The mask goes into the user's live page during each screenshot, so every drop-down in the
  agent's tab, frames included, shows no text for that moment. 0013's failure modes now cover every
  drop-down: a failed removal, or a page the tab leaves mid-capture that Firefox restores from its
  back-forward cache, leaves every drop-down's text transparent until the page reloads, and
  `transition: none` ends a size transition the page runs on a drop-down at that moment. The
  accessibility tree does not change.
- A page cannot style the label Firefox draws a drop-down's text in: `-moz-select-content` is
  enabled only in chrome (servo/components/style/gecko/pseudo_elements.toml :99-101 at
  FIREFOX_160_0_1_RELEASE, :107-109 at FIREFOX_153_7_0esr_RELEASE), so the label inherits the
  mask, whose user-origin `!important` declarations beat the page's. Nor do a page's
  `::first-line` and `::first-letter` rules reach it (layout/base/nsCSSFrameConstructor.cpp
  :3002-3004 at FIREFOX_160_0_1_RELEASE).
- Measured on Firefox 160.0.1: a previewed option the page wrote as colour emoji drew none of the
  emoji's colour in Foxleash's screenshot, against 40 pixels in Firefox's own capture, so the mask
  hides Firefox's bundled colour emoji too. A page's own colour font keeps its colours, the limit
  0013 already records.
- 0013's other recorded limit, a page drawing through a field's text from an element around it,
  such as `background-clip: text` on an ancestor behind a drop-down with a transparent background,
  applies to drop-downs too. Not measured.
- The end-to-end test "a screenshot hides the option Firefox previews in a drop-down from a saved
  card" pins that a screenshot shows neither a previewed option nor a plain drop-down's text.
- The mask stays as it is for as long as that context holds. If Firefox bug 2095903 becomes
  public, amend this record with the context left out; whether the mask can be narrowed is judged
  then, from the Firefox versions Foxleash supports at that time.
