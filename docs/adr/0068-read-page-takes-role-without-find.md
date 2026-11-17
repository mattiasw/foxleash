# 0068: read_page takes role without find

**Status:** Accepted, 2026-11-16. Supersedes the rule of
[0043](0043-read-page-finds-lines-by-the-text-it-shows.md) that read_page takes role only together
with find, and the rules of [0056](0056-a-batch-reads-consecutive-finds-in-one-walk.md) that only
steps with find join and that finds comes only together with find. Its rule that a run whose first
step has `find` takes only steps with `find` is superseded by
[0079](0079-a-batch-joins-a-role-only-read-page-step-after-a-find.md), 2026-11-18.

## Context

An agent that wants a page's frames, headings or images has no short way to get them. `find
"iframe"` answers that no line matches although the tree has an `iframe` line, because find
searches only the text between a line's quotes (ADR 0043), and `role` alone was refused. The only
other way is a whole read, up to about 26,000 tokens on a real page, cut at 50,000 characters.

## Decision

- **Role alone.** `read_page` with `role` and no `find` returns every line whose role equals
  `role`, compared cleaned and in lower case exactly as the role filter of a find compares it: the
  first 20 (`READ_PAGE_MAX_MATCHES`), each after the lines of the elements that contain it, each
  line written once, with the same `found` counts (shown, matches, searched), walking the whole
  page past the cut within what `ref`, `filter` and `depth` keep. It is the find finder with the
  text test skipped (`createLineFinder` in `apps/extension/src/page-tree.ts`); a line without a
  name matches too. Like a find, it never records the session's view (`isFindRead`). With `find`
  too, nothing changes.
- **find stays as it is.** find never matches role words, state words or references. When a find
  without role matches nothing and, trimmed of `[\s\u0085]` and in lower case, is a role a line can
  show (a member of `ARIA_ROLES`, `text` or `iframe`), the server adds a second, fixed note:
  "find searches names, field values, text and link addresses, never role words. To get the lines
  of a role, give role without find."
- **Notes for role alone.** No match: "No line has that role. Foxleash searched N lines."
  Matches beyond those shown: "N matching lines are not shown. Add find, or read one element with
  ref." The notes of a find are unchanged. Every note holds numbers or fixed text, never the query
  or page text, outside the untrusted frame.
- **finds.** `finds` comes with `find` or `role`. Each entry has `find`, `role` or both; one that
  has neither is refused with "read_page needs each entry of finds to have a find, a role or
  both.", and a `find` or `role` that is present must not be only spaces.
- **Batch joining.** A `read_page` step with a string `find` or a string `role` can join, under
  0056's other conditions (one tab, same `filter`, `depth` and `ref`, nothing only spaces, each
  text at most 1,000 characters). A run whose first step has `find` takes only steps with `find`;
  a run whose first step is role-only takes both kinds. Each other step goes into `finds` with only
  the keys it has.
- **The role list moves.** `ARIA_ROLES` moves to `packages/protocol/src/methods.ts` so the server
  can check a find against it; `page-tree.ts` imports and re-exports it.
- **`PROTOCOL_VERSION` stays 5.** The change is additive, as in
  [0047](0047-act-tools-wait-for-the-page-to-settle.md).

0056 joined only steps with `find` because an extension from before it ignores `finds`: sent
`finds` without `find`, it would do a whole read and record it as the session's view. That reason
does not apply to a role-only first step. Every extension a server can meet speaks protocol 5 and
knows `finds`, and one from before this change refuses role without find with its own message,
"read_page takes role only together with find.", before it looks at `finds`, so a joined run with
a role-only first step fails exactly as that step alone would. Such an extension does refuse a
`finds` entry without `find`, with a sentence about `finds`. A run that starts with a find and goes
on with a role-only step would then fail its first step, a find that succeeds alone, with a message
about a `finds` the agent never sent; so such a run takes two requests.

## Alternatives rejected

- **Let find match role words or state words.** What find matches would depend on words the tree
  adds, not the page's text, against ADR 0043; `find "link"` would match every link and every
  link-shaped name at once.
- **A separate tool that lists lines by role.** 0043 rejected a separate find tool for the same
  reason: one more tool to choose between for what is a narrower read_page.
- **A copy of the role list in the server.** Two lists to keep equal; the protocol package is
  where both sides already share constants.
- **Bumping the protocol version.** An older extension already refuses role alone clearly, and an
  older server never sends it.
- **Joining a role-only step after a find step.** An extension from before this change refuses
  the `finds` entry and fails the first step, which succeeds alone.

## Consequences

- During an update, an older extension refuses role alone with its own message, and a newer
  extension with an older server changes nothing.
- A batch `[find, role]` takes two walks. That join condition can go at the next
  `PROTOCOL_VERSION` bump, when every extension a server can meet knows role-only entries.
- The role-word note covers only an exact role name. `none` and `presentation` get it though no
  line shows them, which is harmless.
- ADR 0043's guarantees hold: a role-only read shows only lines the whole tree shows, formatted the
  same way, so protected fields stay protected, and the notes hold numbers or fixed text.
