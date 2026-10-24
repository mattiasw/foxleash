# 0024: batch runs each step as its own tool call

**Status:** Accepted, 2026-10-24. Relies on the safeguards of
[0002](0002-safeguards-live-in-foxhand-not-the-mcp-client.md) and the per-site approval of
[0007](0007-per-site-approval-and-tab-redaction.md).

## Context

An agent often needs several calls in a row that it already knows in full: click a button,
type into the field it showed, press Enter, read the page. Each is a round trip through the
MCP client and the model. `batch` sends such a sequence in one call. The safeguards live in
Foxhand (ADR 0002): the extension checks every bridge request on its own for approval, the
blocklist and the tab group, and the server holds no approval state. Whatever batch does, it
must not give one step's check to another.

## Decision

`batch` runs on the MCP server (`apps/server/src/batch.ts`, registered last in
`registerTools` in `apps/server/src/tools.ts`). Each step names another tool and its args; the
step is validated by that tool's own input shape and run by that tool's own callback, which
makes its own bridge requests, exactly as a direct call does. Nothing is cached or checked in
advance. `batch` itself is not a step, so batches do not nest.

- Steps run in order and the batch stops at the first step that fails: an error result, a
  throw, invalid args, or a `fill_form` step with a field that was not filled. It also stops
  before the next step once the client cancels the call.
- The result holds, for each step that ran, Foxhand's own header line (step number, tool, ok or
  failed) and then that step's own content items unchanged, with their untrusted frames; after
  a failure or a cancellation, a line naming the steps that were not run.
- The result is capped item by item at the size every tool result has: an item that does not
  fit is left out with a note, the step's later items that fit are kept, and later steps still
  run.
- At most 20 steps.

## Alternatives rejected

- **A batch method in the extension**, one native message for all steps. Fewer round trips, but
  a protocol change and a second path through the per-request checks, where one approval check
  could end up covering several steps.
- **Going on after a failed step**, as `fill_form` does with its fields. Its fields are
  independent; batch steps usually depend on the earlier ones, such as typing into the dialog a
  click opened.
- **Passing one step's output into a later step's args.** A template language over results that
  hold untrusted page content.

## Consequences

One round trip to Firefox per step, as before; only the round trips to the model are saved. The
args are fixed when the batch is sent, so a step cannot use a new tab's id or the references a
navigation produced: that takes a second call. An MCP client that asks before each tool call
asks once for a whole batch, and a client rule that denies or asks for one tool does not reach
that tool inside `batch`; Foxhand's own checks still apply to every step, and a user who wants
such a rule to hold sets it for `batch` too. When the client stops waiting before the batch
ends, it gets no result although earlier steps ran.
