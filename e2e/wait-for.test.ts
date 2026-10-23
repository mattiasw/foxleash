import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  type FixtureServer,
  startFixtureServer,
  TITLES,
  WAIT_LATE_TEXT,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

// One Firefox for the file: the tests run in order and build on each other's tab.
describe("wait_for in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let tabId = -1;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("wait_for text fails before the page shows it, then returns once it does", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/wait-late") }));
    tabId = tab.id;
    const early = await harness.refused(session, "wait_for", {
      tabId,
      text: WAIT_LATE_TEXT,
      timeout: 0.1,
    });
    assert.ok(early.includes("did not show that text within 0.1 seconds"), early);
    const shown = tabOf(await harness.ok(session, "wait_for", { tabId, text: WAIT_LATE_TEXT }));
    assert.equal(shown.id, tabId);
    assert.equal(shown.title, TITLES.waitLate);
  });

  test("wait_for selector returns once an element matches", async () => {
    await harness.ok(session, "navigate", { tabId, action: "reload" });
    const shown = tabOf(await harness.ok(session, "wait_for", { tabId, selector: "#late" }));
    assert.equal(shown.id, tabId);
  });

  test("wait_for navigation returns the tab once the page's own navigation finishes", async () => {
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/wait-navigate") });
    const moved = tabOf(await harness.ok(session, "wait_for", { tabId, navigation: true }));
    assert.equal(moved.id, tabId);
    assert.equal(moved.url, fixtures.url("/a"));
    assert.equal(moved.title, TITLES.a);
  });

  test("wait_for fails when the text never shows", async () => {
    const text = await harness.refused(session, "wait_for", {
      tabId,
      text: "Never shown on this page",
      timeout: 0.5,
    });
    assert.ok(text.includes("did not show that text within 0.5 seconds"), text);
  });

  test("wait_for refuses a selector that is not valid CSS", async () => {
    const text = await harness.refused(session, "wait_for", { tabId, selector: "[[" });
    assert.ok(text.includes("The selector is not valid CSS."), text);
  });

  test("wait_for refuses a selector on the value attribute", async () => {
    const text = await harness.refused(session, "wait_for", {
      tabId,
      selector: 'input[value^="a"]',
    });
    assert.ok(
      text.includes(
        'wait_for does not take a selector that contains both "[" and "value", since it could test what a password field holds.',
      ),
      text,
    );
  });
});
