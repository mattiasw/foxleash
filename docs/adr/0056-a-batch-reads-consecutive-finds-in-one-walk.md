# 0056: A batch reads consecutive read_page finds on one tab in one walk

**Status:** Accepted, 2026-11-14. Its rules that only steps with find join and that finds comes only together with find are superseded by [0068](0068-read-page-takes-role-without-find.md), 2026-11-16.

## Context

A `read_page` with `find` walks the whole page: it counts every matching line, so it cannot stop
once its tree is full the way a whole read does. Each `batch` step was its own request and its own
walk, so a batch of several finds on one page walked it once per find. On a long Wikipedia article
(about 13,500 elements, 3,500 links) in headless Firefox, one find took about 860 ms from the
client and a batch of two finds about 1,640 ms, against 250 ms for a whole read cut at 50,000
characters. Agents ask for several finds on one page in one batch, so the second and later walks
were most of the wait.

## Decision

`runBatch` (`apps/server/src/batch.ts`) stays generic: a tool may give two hooks besides `failed`
and `loaded`, `joins(first, next)` and `callMany(argsList, extra)`. When the tool has both and the
steps after a step use the same tool, the batch parses each next step's args with the tool's shape
(with the same `view` treatment as a step run alone) and extends the run while they parse and
`joins` says yes. A run of two or more steps is one `callMany` call, which returns results for the
first steps of the run, at least the first one's; the batch runs the steps it got no result for as
usual. A throw or an error result fails the first step, and the batch reports the rest not run.
Every other rule (the cancel check before each step, headers, the per-step byte budget, the stop
at the first failure) applies to each step as before.

`read_page` (`apps/server/src/tools.ts`) joins a step with the run's first step when both have
`find`, the same `tabId`, `filter`, `depth` and `ref` (absent equals only absent), neither has a
`find` or `role` that is only spaces (such a step runs alone and fails with its own message), and
each `find`, `role` and `ref` is at most 1,000 characters, so that a request of joined steps
stays far under Firefox's 1 MB per message even when every character is escaped.

The request keeps the first step's `find` and `role` and carries the others in `finds`, a list of
1 to `READ_PAGE_MAX_FINDS` (18) `{ find, role? }` entries, taken only together with `find`. The
cap keeps a reply under the background's limit on a page's reply, 2,000,000 characters of JSON:
each of the 19 trees is at most 50,000 characters, and at most twice that as JSON. One request
therefore answers at most 19 steps; the batch sends the rest of a longer run in the next request.
The content script walks the page once and gives each line to one finder per find
(`createLineFinders` in `apps/extension/src/page-tree.ts`), each the same finder a lone find uses,
sharing only the lowercased texts each line is searched in. The reply answers `find` as before
and adds `finds`, one answer per entry, in order; the background checks each answer as it checks a
lone find's (`treeReadOf`, `foundLinesOf`, the array's length equal to the request's) and refuses
anything else as `page_error`. The server builds each step's result with `treeResult`, exactly as
the step's own `read_page` call builds it. A reply without a `finds` of the right length answers
only the first step, and the batch sends the other steps again.

## Alternatives rejected

- **`finds` alone, without `find`.** An extension from before this change ignores keys it does
  not know. Sent `finds` alone, it would do a whole read and record that tree as the session's
  view of the tab, so the next act's view would be a diff against a tree the agent never saw. Sent
  `find` with `finds`, it answers the first find exactly as before, and the server sends the
  remaining steps again.
- **A content-script cache of the last walk.** Field values and computed style change without a
  DOM mutation, and shadow roots are not observed, so a cache could answer a later find from a page
  that no longer looks that way.
- **Several finds in the `read_page` tool itself.** The agent already puts several finds in one
  batch; a second way to ask for them would change the tool's schema and description for no gain.

## Consequences

- A joined run reads one state of the page. Separate steps could see the page change between them;
  joined, they cannot.
- The content script must answer within its 10 s reply limit (`PAGE_REPLY_MS`). A joined run costs
  one walk plus, per extra find, the finder's own bookkeeping, so it stays close to one find; on a
  page so large that one find nearly takes 10 s, a run of 19 finds can pass the limit and fail its
  first step where each step alone would have answered.
- A step that would fail alone for a reason the joined request shares (a stale `ref`, a site not
  approved, a closed tab) fails the same way joined, as the first step of its run, and the batch
  reports the rest not run, as it would have after that step failed alone.
