# 0003: End-to-end tests run in real Firefox over WebDriver BiDi, not Playwright

**Status:** Accepted, 2026-10-17.

## Context

Foxhand works only in Firefox, and much of its logic depends on how a real browser
behaves: reading a page for `read_page`, or typing into rich text editors. That logic
needs tests that run in Firefox with the extension installed.

Playwright, a common choice for browser tests, supports extensions only in Chromium. Its
documentation says so, and the request for Firefox extension support was closed as
outside its scope ([Playwright issue
#7297](https://github.com/microsoft/playwright/issues/7297)).

## Decision

The end-to-end tests live in `e2e/`. Each run starts a pinned Firefox version headless,
with a temporary HOME directory. That HOME holds the native host manifest, so Firefox
finds `foxhand host` the way it does on a user's machine. Firefox and the test's
`foxhand mcp` also get a temporary `XDG_RUNTIME_DIR`, so the test's host listens in its
own socket directory, apart from any Foxhand the developer has running.

The test installs the extension with the WebDriver BiDi command `webExtension.install`,
sent over Node's built-in WebSocket. There is no geckodriver and no WebDriver client
package.

The test then acts as an MCP client: it uses the MCP SDK client over stdio to start
`foxhand mcp` and calls the real tools. The tools act on local fixture pages served by a
Node HTTP server. A test therefore goes through the same path as a real MCP client, from
the MCP server through the host to the extension and the page.

This setup was measured working on Firefox 156, with an MV3 extension that has content
scripts and a native host.

Code that depends on the DOM is tested here, in real Firefox, and not against a simulated
DOM. Unit tests with `node:test` cover the rest.

## Alternatives rejected

- **Playwright.** It cannot load an extension into Firefox, which is the one thing these
  tests need.
- **geckodriver or Selenium.** Both add a binary or a package to do what WebDriver BiDi
  already does over a WebSocket that Firefox opens itself.
- **jsdom or another simulated DOM.** Page reading and editor input depend on layout,
  focus, event order and editor behaviour that a simulated DOM does not reproduce. Tests
  against it would pass where Firefox fails.

## Consequences

The suite is slower than the unit tests and starts a real browser for each run.

The Firefox version is pinned, so a new Firefox release does not change the test results
by itself. The pin is raised on purpose, as its own change.

Pages that need a login, such as webmail or online editors, are not covered. They need a
manual check in the user's own browser.
