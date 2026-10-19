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
| [0007](0007-per-site-approval-and-tab-redaction.md) | A site is an http(s) URL's origin; a session acts only on sites the user approved with a trusted click (stored one `storage.local` key per site, or for the session), the gate runs before the request, and tabs on other sites reach the agent redacted to their site with no title. |
| [0008](0008-e2e-tests-act-in-extension-pages-through-bidi-and-marionette.md) | The end-to-end Firefox starts with Marionette and system access: BiDi installs, navigates and evaluates in extension pages, Marionette clicks with trusted input, and tests seed settings only through the settings page. |
| [0009](0009-content-scripts-injected-per-tab.md) | Foxhand's content script is injected per tab and per request into the top frame after the site gate, never registered by URL; it only answers the background, checks its site again and hands out per-document element refs; tool results frame page content with a random id. |
| [0010](0010-page-tools-withhold-credential-field-values.md) | Page tools never return the value of a password field, a field read_page saw as one, or a field whose `autocomplete` names a password, one-time code or card number: its line shows `protected` and `filled`, and names never include a form control's value. |
