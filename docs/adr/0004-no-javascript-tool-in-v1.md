# 0004: No tool runs code strings in pages in v1 (no `javascript_tool`)

**Status:** Accepted, 2026-10-17.

## Context

Similar browser agents offer a tool that runs arbitrary JavaScript in the page. It is a
convenient escape hatch: what the fixed tools cannot do, the model writes a script for.

Mozilla's add-on policies forbid an extension from executing code that is not part of its
package, which they call remote code. A script string sent by the MCP client is exactly
that: code the extension did not ship. The `userScripts` API, which does run code from
outside the package, is reserved for user-script managers. An add-on that breaks these
policies gets disabled.

In this record, v1 means Foxhand's current feature set. The decision holds until a later
record supersedes it.

## Decision

v1 has no `javascript_tool`. No parameter of any tool is evaluated as code, in the page or
in the extension. The extension does not request the `userScripts` permission in
`apps/extension/manifest.json`.

Every action Foxhand takes in a page is code shipped in the extension package. A script
that runs in the page's MAIN world is allowed when it is part of the package, such as the
console wrapper behind `read_console`. What is not allowed is code that arrives at run
time.

Adding a tool that runs code strings later takes a new ADR, prompted by a concrete need
that the fixed tools cannot meet.

## Alternatives rejected

- **`scripting.executeScript` evaluating a passed string.** The API is allowed, but
  feeding it a string from the MCP client is still remote code. Wrapping the string in a
  function that calls `eval` or `new Function` does not change that.
- **The `userScripts` API.** It is meant for user-script managers, where the user writes
  or installs the scripts. Using it to run code from the model is outside that purpose.
- **A MAIN-world `eval` bridge.** A packaged script in the page that evaluates strings
  posted to it moves the `eval` into the page, but the code still comes from outside the
  package. It is remote code under another name.

## Consequences

The agent has to work with `read_page`, `click`, `type`, `fill_form` and the other fixed
tools. Some tasks that a script could do in one step take several tool calls, and some
tasks cannot be done at all.

Each new kind of page action is a change to the extension, reviewed and shipped like any
other code. That keeps everything the extension can do on the user's behalf visible in
its package and its listing.
