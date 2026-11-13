# 0050: Action results end with a bounded view of the page

**Status:** Accepted, 2026-11-13.

## Context

After [0047](0047-act-tools-wait-for-the-page-to-settle.md) an act's result says what followed
(`after`), and `tab_open`, `navigate` and `wait_for` return only the tab. None of them carries the
page's elements, so the model follows each of them with `read_page`, one more round trip per
step. A measurement proxy that appended the page to each action's result took a shop task from
13 to 14 model requests down to 8, with about the same characters over the whole task, since the
separate reads had returned the same content. That proxy appended the whole tree after every
call; on a large page that would cost tens of thousands of tokens per act.

So this change sends more page content to the model without the model asking for it, and the
content has to stay bounded and say what it left out.

## Decision

**What ends the results.** The results of `tab_open`, `navigate`, `wait_for`, `upload_file` and
the seven acts (`click`, `hover`, `scroll`, `drag`, `type`, `press_key`, `fill_form`) end with a
view of the tab's page as this session may read it (`PageView` in
`packages/protocol/src/methods.ts`):

- `tree`: the first time this session gets a document in the tab, its tree as `read_page` shows
  it, whole up to `PAGE_VIEW_MAX_CHARS` (8,000 characters), else cut by relevance (below), with
  the number of lines left out;
- `changes`: for the same document as this session's last view of the tab, the lines that
  changed, `+ ` added and `- ` removed, each run after the unchanged lines that contain it, which
  start with two spaces and are shown once; when the changes would be longer than the tree view
  of the new read, the tree view instead, so changes are bounded by the budget without a cut of
  their own (that also covers `lineDiff` past `MAX_DIFF_CELLS`, which returns every middle line
  removed then added);
- `unchanged`: one line saying nothing changed since that view;
- `site`: the tab's site alone, as `tabs_list` shows it, when the read is refused as not
  approved or blocked;
- `none`: one line for a page that is not a web page, a tab still loading another page after
  the act (no read is made: it would wait for the load), or a read that failed or timed out.

**The same read, the same gates.** The view is read through `pages.request(session, tabId,
"read_page", { filter: "all" })`, the call `read_page` makes: the tab must be in the session's
group, on a web page, on a site the session may act on and not blocked, and not the session's
open prompt; the content script notes password fields before the request, protected fields show
as `protected`, and `checkAgain` drops a reply from a page whose access was withdrawn meanwhile.
The reply gets `read_page`'s own checks (own fields, the 50,000-character cap; one function,
`treeReadOf` in `handlers.ts`). A refusal as not approved or blocked gives only the site through
`tabInfo`'s redaction, after a check that the tab is still in the session's group, with no title
and no tree, and forgets the memory. A read that passed the gate gives the tree whatever the
live-document state, which is what `read_page` gives at that moment. The view's read is not an
act: `wait_for` navigation's mark does not move.

**Relevance, past the budget.** `cutTree` in `apps/extension/src/page-view.ts` parses each line
(level from its spaces, role its first word, a name skipped as one JSON string, then the ref in
brackets; a line that does not parse is still a line) and keeps lines in this order, each tier in
document order, while they fit: the lines of the element the act aimed at (the act's `ref`,
`targetRef` and each `fill_form` field's ref, from its options and its result) and
`FOCUS_CONTEXT_LINES` (5) lines before and after each; `alert`, `alertdialog`, `status`, `log`
and `dialog` lines with all they contain; headings and landmarks; fields and buttons; links; the
rest. A kept line brings the lines that contain it. Each run of left-out lines under one kept
line becomes one line, `… N lines`, one level under that line; a tree line always starts with a
role word, so the page cannot write a line that starts with `…`. The cost of each candidate
counts its new lines and every placeholder it adds or changes, so the kept lines and
placeholders never pass the budget. The server's note gives the count and how to read the rest:
`read_page` with the ref of the line that contains a `…` line, or with `find`.

**Memory per session and tab.** `createPageViews` keeps, per tab and per session, the document
of the last view given (its own `createLiveDocuments` instance: a new object at each top-frame
commit, none while the session may not act on the site) and the tree read. It is dropped when
the tab closes, the session ends, the session's approval of the site is withdrawn, or the read
was refused; a view of another document replaces it. A read during which the tab committed
another document, or of a tab with no live document (for example a site approved through
`request_sites` after its page committed), is shown as a tree and not recorded. Agents sharing a
session ([0038](0038-agents-sharing-a-session-share-its-tab-group.md)) share the memory, so an
agent can get changes against a view another agent of the session got; the `unchanged` line
says so and names `read_page` for the whole page. Removed lines come only from the same
document's earlier read in the same session, which the session could read then.

**`read_page` records it.** A `read_page` of the whole document (no `ref`, `find` or `depth`)
with the view's filter records its tree as the last view, so the next act's view is what
changed since the read the model has. On the shop's product page the act after a recorded read
gets 161 characters of changes instead of a 1,687-character tree.

**A read cut at 50,000 characters.** A change past the cut is invisible, and a line pushed past
the cut by an insertion above looks removed. When the new read is cut, the removed lines after
its last line are dropped, and `changes` and `unchanged` carry `truncated`, so the server says
that the comparison covers only the first 50,000 characters and that `read_page` with `find`
searches the whole page.

**Server.** `apps/server/src/tools.ts` renders the result's JSON without `view` first, framed as
before (a copy built with `Object.fromEntries`, so an own `__proto__` key stays text), then the
view as items of its own: a Foxleash line, the page text in its own `untrusted()` frame, and
Foxleash's notes, which hold fixed words and numbers only. `pageViewOf` checks the view's fields
again (own fields, known kinds and reasons, texts within `PAGE_VIEW_MAX_CHARS`); a view it
refuses becomes one line, and the act's result stays. The result's JSON stays the first framed
item (upload_file's `{ after }` included), so `actLoaded` and `someFieldFailed` decide as before.
Each of the eleven tools declares `VIEW_RESULT_SIZE`, Claude Code's 50,000-character default for
the result's own JSON plus twice `PAGE_VIEW_MAX_CHARS` and the frame allowance
([0039](0039-tools-declare-their-result-size-for-claude-code.md)).

**Leaving it out.** Each of these tools takes `view`; `false` leaves the view out: nothing is
read, nothing is recorded, and the result has no view. `batch` gives one view, after its last
step: every earlier step runs with `view` false set on its parsed args, and the batch's own
`view` false leaves out the last step's too; a step's own `view` false is never overridden.

**Deadline.** No view read starts past `VIEW_START_LIMIT_MS` (50 s) into the call, and the read is
raced with `VIEW_READ_MS` (5 s), so a call answers within 55 s, below the host's 60 s request
timeout. A failed or late read gives the `none` line; the act's own result is never lost.

### Measurements that set the defaults

Views built with `page-view.ts` over saved trees: the Wikipedia article read in the current
format, cut at 50,000 characters, and the shop task's pages from agent logs of a measured run,
converted mechanically to the current format (refs renumbered per document, one space per level,
same-site links as paths), as were the other large pages, which were saved in older formats. The
shop's product page after "Add to cart" is its read before the click with the two parts a
`read_page` with `ref` showed changed after it (the cart link and the status region). Tokens are
the difference in a `claude -p` call's prompt tokens, Opus, with and without the text.

A page seen first, characters and lines of the view (lines left out), by budget:

| page | read | 4,000 | 6,000 | 8,000 | 12,000 |
|---|---|---|---|---|---|
| shop search results | 2,483 / 78 | whole | whole | whole | whole |
| shop product page | 1,664 / 49 | whole | whole | whole | whole |
| shop checkout | 2,290 / 75 | whole | whole | whole | whole |
| shop front page (interactive) | 2,715 / 67 | whole | whole | whole | whole |
| Wikipedia article, all | 49,962 / 917 | 4,000 / 133 (821) | 5,999 / 188 (770) | 8,000 / 222 (749) | 12,000 / 309 (665) |
| Wikipedia article, interactive | 49,906 / 811 | 3,954 / 102 (732) | 5,991 / 131 (703) | 7,973 / 164 (670) | 11,975 / 234 (599) |
| GitHub issue list, all | 5,908 / 146 | 4,000 / 111 (56) | whole | whole | whole |
| Hacker News front page, all | 24,013 / 493 | 4,000 / 91 (412) | 6,000 / 131 (380) | 8,000 / 170 (344) | 12,000 / 252 (272) |
| BBC News front page, all | 24,240 / 319 | 3,999 / 48 (284) | 6,000 / 71 (268) | 7,994 / 82 (260) | 11,994 / 131 (216) |
| MDN reference page, all | 38,621 / 662 | 4,000 / 150 (561) | 6,000 / 205 (511) | 8,000 / 258 (464) | 12,000 / 339 (409) |
| GitHub repository page, all | 39,334 / 588 | 3,996 / 93 (505) | 5,997 / 121 (485) | 7,999 / 152 (462) | 11,997 / 211 (409) |

What the cut keeps of the Wikipedia article (all): its 42 headings and landmarks and 11 fields
and buttons at every budget, and 21, 40, 51 and 93 of its 421 links at 4,000, 6,000, 8,000 and
12,000 characters; of the interactive read, its 31 headings and landmarks and 12 fields and
buttons, and 36 to 169 of its 768 links.

Tokens (Opus): the product page's tree, 1,687 characters, 791 tokens; the checkout tree, 2,290
characters, 1,089 tokens; the Wikipedia view at 4,000, 8,000 and 12,000 characters, 1,906, 3,911
and 5,898 tokens; the interactive one at 8,000, 4,065 tokens; the whole Wikipedia read, 49,962
characters, 22,443 tokens.

The view after "Add to cart" on the product page:

| form | all | interactive |
|---|---|---|
| bare changed lines | 118 characters / 3 lines | 93 / 2 |
| changed lines after the lines that contain them | 161 characters / 6 lines (45 tokens) | 107 / 3 |

- **Budget: 8,000 characters** (about 4,000 tokens). Every shop page comes whole at every
  candidate; the Wikipedia view is 16% of its read and keeps every heading, landmark, field and
  button, as 4,000 does, with more than twice the links of 4,000. 12,000 would add about 2,000
  tokens per first view of a large page for links only.
- **Tree kind: all.** The interactive filter leaves out the text "Added to cart", prices and
  stock, which are what the agent checks after an act on a shop: its view after "Add to cart"
  shows only the cart link. On the large pages the two kinds cost the same at each budget.
- **Changed lines after the lines that contain them.** 43 characters more than bare lines on the
  product page, and the agent sees where each change is (the status region, the banner's cart
  link) without reading the page again.

The fixture pages' numbers come from `e2e/page-view.test.ts` in Firefox, which reports each
view's characters and lines: a small page seen first, 488 characters / 16 lines; the changes
after "Add to cart", 226 / 8; a page past the budget, 7,999 / 261; a site that is not approved,
22 / 1. A click that changed nothing took 144 ms with its view and 128 ms without.

## Alternatives rejected

- **Appending the whole tree.** What the proxy did; on a large page every act would cost about
  22,000 tokens.
- **A cut in document order**, as `read_page`'s own 50,000-character cut: a large page's view
  would hold its banner and navigation and none of what the act changed, and the model would read
  the page again.
- **The interactive filter**, which leaves out the text an act changes (above).
- **A memory per tab shared by every session**: a session would get changes against a view it
  never got, and removed lines of a page another session read.
- **A diff with its own relevance cut.** Changes longer than the tree view are sent as the tree
  view, which is already bounded and cut by relevance.
- **Not recording `read_page`.** The act after a read would get the whole tree again.

## Consequences

- More page content reaches the model without the model asking for it: on a site the session may
  act on, up to 8,000 characters per first view of a document, framed as untrusted. The add-on
  listing says so.
- A view the server drops (a `batch` whose earlier steps used up its byte budget, a view
  `pageViewOf` refuses) was still recorded in the extension, so the next view can be changes
  against, or "nothing changed" since, a page the model never got. The notes for those cases, and
  `batch`'s note for a result left out, say that `read_page` reads the page.
- An agent of the same session can get changes against a view another agent got; the
  `unchanged` line names `read_page` for the whole page.
- A read cut at 50,000 characters whose start shifted by more than about 2,000 lines differs from
  the last one past `lineDiff`'s cap, and its view is the tree again.
- A tab still loading after the act gets no view; `read_page` reads the page once it has loaded.
- Each view costs a page request: about the cost of a `read_page` after the act settled, and up
  to `VIEW_READ_MS` on a page that does not answer.
