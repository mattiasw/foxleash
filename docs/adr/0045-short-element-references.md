# 0045: Element references are a short document tag from one stored counter, then a number

**Status:** Accepted, 2026-11-13. Supersedes the element reference format of
[0009](0009-content-scripts-injected-per-tab.md) (`<docId>-<n>`, `docId` 8 random hex
characters) and its rejected alternative "a bare counter as the ref".

## Context

`read_page` returns an accessibility tree that costs about one token per two characters, and
every later model request carries it. A ref such as `[411aa450-90]` is most of an interactive
line. Measured with claude-opus-5-5 on one saved Wikipedia tree with 554 refs: 25,890 tokens in
the old format; 17,231 with one-letter tags, links on the page's own site shown as a path and
one space per level; 17,785 with two-letter tags, 18,339 with three or four, 19,447 with five.
Each letter a tag adds costs up to one token per ref (554 tokens, about 3% of that tree) unless
the tokenizer merges it.

The random docId did one job: a ref from a document the tab no longer shows is refused as
`stale_ref`, never resolved to another element, after a navigation, a reload, going back, and
for a ref copied from another tab. A short name keeps that only if no two documents ever get
the same one. The background is an event page that restarts (Firefox start, extension reload or
update, a dropped native port), and Firefox restores tabs as new documents while an agent may
still hold refs from before.

## Decision

- **Format.** A ref is `<tag><n>`: `tag` is 1 to 7 lowercase letters, the bijective base-26
  numeral of a positive number (1 is `a`, 26 `z`, 27 `aa`, 703 `aaa`; `documentTag` in
  `apps/extension/src/element-refs.ts`), and `n` the element's number in its document, from 1,
  at most 16 digits. Letters then digits parse without a separator (`REF`). An old hex ref is
  `invalid_ref`.
- **One counter, a fresh tag per message.** `apps/extension/src/page-scripts.ts` holds one
  counter for the whole extension and sends a new tag in every page message (`PageRequest.tag`),
  after the site gate and before the injection, also for the second run of a request. The
  content script's registry (`createElementRefs`, `adopt`) takes the tag of the first request
  its document gets and keeps it; `handlePageMessage` refuses a request without a well-formed
  tag as unreadable. No tag is sent twice, so no two documents can adopt the same one, even
  when requests overlap a navigation. The tag comes only from the background; nothing from the
  page chooses it.
- **The stored mark.** The counter's mark lives in `storage.local` under `tagMark`
  (`TAG_MARK_KEY` in `settings.ts`). On first use after a start the background reads it, then
  writes the mark `TAG_BLOCK` (100) higher before handing out any tag up to it, and writes the
  next block before passing the end of this one. One read or write runs at a time; concurrent
  requests wait on it, each for at most `TAG_RESERVE_MS` (5 s). A timed-out write is left to
  finish, not raced by another.
- **Failure.** A failed read or write, a stored mark that is not a whole number from 0 to the
  last tag's, or a used-up counter fails the request with a neutral `page_error` and logs it;
  no tag outside the stored mark is handed out, and the next request tries again.
- **Not a setting.** `readSettings` skips `tagMark` without a warning, the settings page does
  not re-render for a change of it alone, and `live-documents.ts` re-checks no tab for it.
- **Link addresses and indentation.** A link to the page's own origin shows its address after
  the origin (`linkAddress` in `page-tree.ts`); `navigate` resolves an address starting with a
  single `/` against the origin of the page its tab shows and refuses one that leaves it, and
  `tab_open` and `download` refuse it. Each level is indented by one space.

## Alternatives rejected

- **A counter per tab.** The first document of two tabs would get the same tag, so a ref copied
  from one tab to the other would resolve to a different element; the random docId refused
  that as stale.
- **Reserving a tag per document through a message from the content script.** More moving parts
  and a new channel from the page's process to the background, which today only answers.
- **Reusing a tag that the reply shows the document did not adopt.** The guarantee would then
  rest on what the page's process replies, and it needs more states.
- **A shorter random id.** Two documents could still share it; the guarantee would only be
  probabilistic.
- **Starting again from 0 on a malformed mark.** That could hand out tags that refs an agent
  still holds carry.

## Consequences

- Tags grow with use: 1 letter for the first 26 messages, 2 from the 27th, 3 from the 703rd, 4
  from the 18,279th, 5 from the 475,255th, up to 7 letters (8,353,082,582 tags). A task makes 2
  to 20 tool calls in our measurements; each page tool call is one message, a `screenshot` two,
  a retried request two, and `wait_for` one per 250 ms poll, so a 30 s wait uses about 120
  tags. A background start wastes at most 99 numbers.
- Uninstalling the extension clears `storage.local`, so after a reinstall tags start again at
  `a`, and a ref an agent kept from before the uninstall could resolve in a new document.
  Accepted: an uninstall also ends every session.
- A tag shows how many page messages the extension sent before it, for every session: an agent
  comparing two of its tags learns how many messages other sessions sent in between, though not
  to which tabs or sites. Accepted: a counter per session would let documents in two sessions'
  tabs share a tag.
- A storage write that fails or hangs fails page requests until storage works again.
- Two Firefox profiles running Foxleash at once each have their own counter.
