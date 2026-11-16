# 0043: read_page finds lines by the text it shows

**Status:** Accepted, 2026-11-13. Its rule that role comes only together with find is superseded by [0068](0068-read-page-takes-role-without-find.md), 2026-11-16.

## Context

On a large page an agent that looks for one element reads the whole tree (up to about 26,000
tokens measured on real pages) or saves it and searches the file. The tree is cut at 50,000
characters, so an element past the cut cannot be found by reading at all. The agent needs to ask
for the lines that contain a text, and to know how many more there are.

Two things constrain the answer. read_page withholds some text on purpose: the values of
protected fields, and anything past the 200-character cut of a name, value, link address or
text. A search that looked past what the tree shows would let the agent test, through matches
and counts, characters the tree hides. And matching must stay plain and predictable: Foxleash
runs no model and scores nothing (ADR 0005).

## Decision

`read_page` takes `find`, a text, and `role`, which it accepts only together with `find`.

- A line matches when `find`, with whitespace collapsed and trimmed, is a case-insensitive
  substring (`toLowerCase` on both sides, a final sigma taken as a sigma, no Unicode
  normalisation) of one of: its name, its field value when the field is not protected, or its
  link address. Text lines carry their text as their name. Each is compared in the form the line
  shows it between its quotes: whitespace collapsed, cut at 200 characters and then ending with
  the `…` mark, before JSON escaping (`shownText` in `apps/extension/src/page-tree.ts`, which
  `quote` uses too). Role words, state words and
  references never match. A protected field's line carries no value, so nothing it holds can
  match. A later state that holds page text must decide here whether it is searched.
- With `role`, a matching line must also have exactly that role, compared cleaned and in lower
  case.
- The result is the first 20 matching lines (`READ_PAGE_MAX_MATCHES`), each after the lines of
  the elements that contain it, each line written once; a match's siblings and contents are not
  written. The tree keeps its 50,000-character cap. The page also returns `found`: the matching
  lines written, all matching lines and all lines searched, checked against each other and
  against the tree by `foundLinesOf` in `packages/protocol/src/methods.ts`, in the extension and
  again in the server. The server adds
  Foxleash's own note with the number of matching lines not shown, or, with no match, returns
  only a sentence with the number of lines searched. These notes hold numbers only, never page
  text or the query, and stay outside the untrusted frame.
- With `find` the walk does not stop at the 50,000-character point where a full read stops: it
  goes to the end of what `ref`, `filter` and `depth` keep, so the counts cover all of it.
- `PROTOCOL_VERSION` is 3: an older extension would ignore `find` and return the whole tree.

## Alternatives rejected

- **A separate find tool.** With tools loaded on demand, a parameter of `read_page` is there
  whenever `read_page` is; a second tool would also duplicate `ref`, `filter` and `depth`.
- **Fuzzy or scored matching, or a model.** ADR 0005 keeps models out of Foxleash, and results
  the agent cannot predict make it read the tree anyway to check them.
- **Matching a value beyond its 200-character shown cut, or a value the tree withholds.** A
  match or a count would then tell the agent what the tree hides.
- **Stopping at the 50,000-character cut.** The counts would be wrong and a match past the cut,
  the case find exists for, would be out of reach.
- **Returning a match's siblings or contents.** `ref` reads an element and what it contains;
  find returns only what locates the match.

## Consequences

- A read with find walks the whole page, as `filter: "interactive"` already does, but it also
  builds every line: a name, states and a reference for each element with a line, kept for the
  document's life as every reference is. On a very large page it costs more than
  `filter: "interactive"`. The walk has no time bound; bounding it needs a way to say the counts
  are partial. Its cost on a large real page is not measured.
- An extension and a server of different protocol versions refuse each other until both are
  updated.
