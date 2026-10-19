# 0008: End-to-end tests act in extension pages through BiDi and Marionette, with system access

**Status:** Accepted, 2026-10-19.

## Context

The end-to-end tests ([0003](0003-e2e-tests-in-real-firefox-over-webdriver-bidi.md)) must write
settings from the extension's own settings page, since the extension has no test hook, and must
click real buttons on extension pages: the approval prompt answers only trusted clicks.

Measured on Firefox 156.0.1, WebDriver cannot reach an extension page without system access.
Both BiDi `browsingContext.navigate` and Marionette `WebDriver:Navigate` to a
`moz-extension:` URL fail with `unsupported operation: Navigation to "moz-extension://..." is
not allowed in this context`, and script evaluation in a privileged context requires it too.
Started with `--remote-allow-system-access`, BiDi lists, opens, navigates (with
`wait: "none"`), evaluates script in and closes extension pages, but still refuses
`browsingContext.locateNodes` and `input.performActions` there with `The command does not
support browsing contexts in privileged scope`. Marionette's `WebDriver:FindElement` and
`WebDriver:ElementClick` work in the same page, and the page sees the click with
`isTrusted === true`.

## Decision

The test Firefox starts with `--marionette`, `--remote-allow-system-access` and
`--remote-debugging-port=0`, and the pref `marionette.port` set to 0. `e2e/firefox.ts` opens the
one WebDriver session over Marionette with `WebDriver:NewSession` and `webSocketUrl: true`, and
connects its BiDi client to the WebSocket URL that returns, so both protocols share the
session. BiDi does everything it can: installing the extension, listing tabs, opening,
navigating, evaluating and closing. Marionette does only the click (`WebDriver:SwitchToWindow`,
`WebDriver:FindElement`, `WebDriver:ElementClick`). Navigations wait by polling the document's
`readyState` and URL, because Firefox sends no navigation events for extension pages.

The pref `extensions.webextensions.uuids` pins the extension's internal UUID, so its pages have
known `moz-extension:` URLs. `harness.seedSettings` writes `storage.local` from the settings
page and is the only way the tests write settings.

## Alternatives rejected

- **BiDi only.** It has no input in extension pages, even with system access.
- **Marionette only.** BiDi is the standard protocol 0003 chose and already does everything
  but the click, so Marionette is kept to the one command BiDi refuses, and can go once BiDi
  supports it.
- **An evaluated `.click()`.** The event is untrusted, so it cannot test a check on
  `isTrusted`.
- **A test hook or a native-messaging method in the extension that writes settings.** It would
  ship to users and give the agent's side a way to grant sites, which
  [0002](0002-safeguards-live-in-foxhand-not-the-mcp-client.md) rules out.
- **geckodriver or Selenium.** Still a binary or a package for what two sockets do (0003).

## Consequences

0003 still holds: no binary and no WebDriver package. The Marionette client is a short
length-prefixed JSON client in `e2e/firefox.ts`.

System access gives a WebDriver client chrome-privileged script in the throwaway Firefox, which
amounts to running code as the user who runs the tests. Its BiDi and Marionette listeners bind
127.0.0.1 on random ports, and the harness takes the single session as soon as Marionette prints
its port and fails loudly if `NewSession` is refused. What remains is another local process
connecting in that moment, so the suite assumes a machine where other users' local processes are
not a concern, such as a developer machine or a CI VM.

A later Firefox that lets BiDi act on extension pages would let Marionette go.
