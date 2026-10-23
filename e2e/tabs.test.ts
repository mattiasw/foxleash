import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  counterTitle,
  type FixtureServer,
  parseCount,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

// One Firefox for the file: the tests run in order and build on each other's tabs.
describe("tabs in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let tabId = -1;
  let secondId = -1;

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

  test("tab_open opens a page in the session's group", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    assert.equal(tab.title, TITLES.a);
    assert.equal(tab.url, fixtures.url("/a"));
    tabId = tab.id;
  });

  test("tabs_list lists only the session's group", async () => {
    // Firefox's startup tab is outside the group.
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map((tab) => tab.id),
      [tabId],
    );
  });

  test("navigate to a url returns once the page has loaded", async () => {
    // The fixture holds this response past the extension's load grace period, so a load wait
    // that returns early still shows page A's title.
    const tab = tabOf(await harness.ok(session, "navigate", { tabId, url: fixtures.url("/slow") }));
    assert.equal(tab.title, TITLES.slow);
    assert.equal(tab.url, fixtures.url("/slow"));
  });

  test("navigate back returns the previous page", async () => {
    const tab = tabOf(await harness.ok(session, "navigate", { tabId, action: "back" }));
    assert.equal(tab.title, TITLES.a);
    assert.equal(tab.url, fixtures.url("/a"));
  });

  test("navigate reload loads the page again", async () => {
    const first = tabOf(
      await harness.ok(session, "navigate", { tabId, url: fixtures.url("/counter") }),
    );
    const count = parseCount(first.title);
    const reloaded = tabOf(await harness.ok(session, "navigate", { tabId, action: "reload" }));
    assert.equal(reloaded.title, counterTitle(count + 1));
  });

  test("another session cannot navigate a tab outside its own group", async () => {
    const other = await harness.connect();
    const otherTab = tabOf(await harness.ok(other, "tab_open", { url: fixtures.url("/b") }));
    assert.equal(otherTab.title, TITLES.b);

    const text = await harness.refused(other, "navigate", { tabId, url: fixtures.url("/a") });
    assert.ok(text.includes("is not in this session's tab group"), text);

    // Still on the page the reload test left it on.
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map((tab) => [tab.id, tab.url]),
      [[tabId, fixtures.url("/counter")]],
    );
  });

  test("tab_select makes a tab of the group the active one", async () => {
    const second = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
    assert.equal(second.active, true);
    secondId = second.id;
    const selected = tabOf(await harness.ok(session, "tab_select", { tabId }));
    assert.equal(selected.id, tabId);
    assert.equal(selected.active, true);
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map((tab) => [tab.id, tab.active]),
      [
        [tabId, true],
        [secondId, false],
      ],
    );
  });

  test("resize_window resizes the group's window to the size asked for", async () => {
    assert.deepEqual(await harness.ok(session, "resize_window", { width: 900, height: 700 }), {
      width: 900,
      height: 700,
    });
  });

  test("tab_close closes a tab of the group and returns the rest", async () => {
    const left = tabsOf(await harness.ok(session, "tab_close", { tabId: secondId }));
    assert.deepEqual(
      left.map((tab) => tab.id),
      [tabId],
    );
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map((tab) => tab.id),
      [tabId],
    );
  });

  test("tab_close refuses another session's tab", async () => {
    const other = await harness.connect();
    const otherTab = tabOf(await harness.ok(other, "tab_open", { url: fixtures.url("/b") }));
    const text = await harness.refused(session, "tab_close", { tabId: otherTab.id });
    assert.ok(text.includes("is not in this session's tab group"), text);
    const tabs = tabsOf(await harness.ok(other, "tabs_list"));
    assert.deepEqual(
      tabs.map((tab) => tab.id),
      [otherTab.id],
    );
  });
});
