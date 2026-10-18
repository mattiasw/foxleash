# Architecture decision records

Each record explains one architecture decision: the context that forced it, the decision,
the alternatives rejected and the consequences. See AGENTS.md for when to write one.
Records are never rewritten; a changed decision gets a new record that supersedes the old.

| Record | Decision |
|---|---|
| [0001](0001-two-processes-joined-by-a-unix-socket.md) | Foxhand runs as two processes, `foxhand mcp` and `foxhand host`, joined by a Unix socket in a 0700 directory, and its three parts check a shared protocol version on connect. |
| [0002](0002-safeguards-live-in-foxhand-not-the-mcp-client.md) | Threat model: the safeguards against prompt injection (such as per-site approval that only a user click grants, a default blocklist, allowed upload folders, untrusted page content) live in Foxhand, not in the MCP client. |
| [0003](0003-e2e-tests-in-real-firefox-over-webdriver-bidi.md) | End-to-end tests start a pinned, headless Firefox, install the extension over WebDriver BiDi and call the real tools as an MCP client; no Playwright. |
| [0004](0004-no-javascript-tool-in-v1.md) | In v1 no tool or tool parameter evaluates code strings in pages, and the extension does not request `userScripts`: every page action ships in the extension package. |
| [0005](0005-mcp-is-the-model-boundary.md) | v1 contains no LLM, model API calls or API keys: the model lives in the MCP client, and tool names and descriptions are written for any client. |
| [0006](0006-no-firefox-for-android-key-in-the-manifest.md) | The manifest has no `gecko_android` key, so AMO never marks Foxhand compatible with Firefox for Android; the extension build allows the one linter warning this causes and fails on any other. |
