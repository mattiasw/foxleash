# 0039: Tools whose results can pass Claude Code's inline limit declare their size

**Status:** Accepted, 2026-11-12.

## Context

Claude Code shows an MCP tool result inline only up to a default limit (25,000 tokens, about
50,000 characters). A larger result is saved to a file, and the model gets only the file's path
and has to search it. Foxhand's own caps let results cross that default: the `read_page` tree is
cut at 50,000 characters, and `get_page_text` returns 50,000 characters by default and up to
200,000 when asked. On the Wikipedia article "Firefox", `read_page` with filter interactive
reached the model as "result (53,091 characters) exceeds maximum allowed tokens", and the model
then ran three searches over the saved file.

Claude Code lets a server raise the limit for one tool with the key
`anthropic/maxResultSizeChars` in that tool's `_meta` in tools/list, up to a ceiling of 500,000.
In Claude Code 2.1.322, a declared tool's result without an image stays inline while the total
length of its text items is at most the declared value; the file it saves otherwise holds the
content array as pretty-printed JSON (`JSON.stringify(content, null, 2)`), the length its
message reports. That JSON is never shorter than the raw text, since each line break, quote and
backslash escapes to two characters.

## Decision

`read_page`, `get_page_text` and `batch` declare the key in their `registerTool` config in
`apps/server/src/tools.ts`. Each value is sized to bound the pretty JSON of the tool's largest
content array, so it holds under the raw-text check Claude Code makes today and under the JSON
measure of the file it saves, except in the cases named below:

- `read_page`: `2 * READ_PAGE_MAX_CHARS + 1,000` (101,000). A tree at the cap whose every
  character escapes to two still fits; the 1,000 covers the frame lines, the cut note and the
  array's JSON. `READ_PAGE_MAX_CHARS` moved to `packages/protocol` so the server derives the
  value from the cap the extension enforces.
- `get_page_text`: `2 * MAX_PAGE_TEXT_CHARS + 1,000` (401,000), the same rule for the most text
  it returns. Its text is already JSON inside the frame, so under the JSON measure it is escaped
  twice: ordinary prose with quotes and line breaks fits with room to spare, text made mostly of
  quotes, backslashes or line breaks does not.
- `batch`: the ceiling, 500,000. A batch holds up to 20 results and Foxhand caps it only at
  8 MiB, far above anything Claude Code accepts, so the ceiling comes closest to its largest
  result.

A result that still goes over (a tree or text full of characters JSON writes as `\uXXXX`, such as
control characters or lone surrogates, or the cases above) falls back to Claude Code's file, as
every result does without the key.

`read_network` and `read_console` do not declare the key. Their results are logs (up to 500
requests with headers, up to 300 console messages of up to 1,000 characters each) that the
agent searches for one request or one message, and the saved file, which the agent can query
with jq or grep, suits that better than a whole log in the model's context. Both can run as
`batch` steps, and there they arrive inline up to batch's value: the agent chose to bundle the
log with other steps, and one value per tool cannot tell batch's steps apart.

A new tool whose result can pass Claude Code's default declares the key the same way, with a
value derived from its own cap. This leaves ADR 0005's rule that tool names and descriptions are
written for any client as it is: the key is namespaced metadata that other clients ignore, and
it changes no wording.

## Alternatives rejected

- **Declaring the key on every tool.** Most tools return a few lines; the key would claim sizes
  they never reach, and the log tools are better served by the file.
- **Declaring the ceiling everywhere.** It would hide the link between a tool's cap and its
  value, and let a log read flood the context where a file serves better.
- **Shrinking Foxhand's own caps to fit Claude Code's default.** A long page would take more
  reads, other clients would lose the larger results for no reason, and the 50,000-character
  tree already passes the default once escaped.

## Consequences

The key replaces Claude Code's token check with a character limit, so a declared result's token
cost is bounded only through its characters. For English trees and text that is a fraction of
the character count, but for scripts where a character costs about a token or more, a
`get_page_text` read asked for its maximum or a large batch can take a large share of the
model's context where it used to go to a file. A measured case of a declared result crowding out
the context would make us lower `get_page_text`'s or `batch`'s value or bound tokens another
way.

Claude Code 2.1.322 also has a budget of 200,000 characters for the tool results of one
message, behind a remote switch that was off when this was written. With it on, one result
over 200,000 characters (a `get_page_text` read near its maximum, a large batch), or parallel
results that pass it together, goes to a file as it did before the key. The values stay as they
are: lowered to 200,000, they would send `get_page_text` and `batch` results between 200,000
characters and their values to a file while the switch is off.

A batch that holds a `screenshot` step keeps Claude Code's token check, since the key applies
only to a result without an image. The values move with `READ_PAGE_MAX_CHARS` and
`MAX_PAGE_TEXT_CHARS`, and the tests assert them as literals, so a cap change shows up as a
failing test.
