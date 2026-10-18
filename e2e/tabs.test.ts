import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { TabInfo } from "@foxhand/protocol";
import { isRecord } from "./firefox.ts";
import {
  counterTitle,
  type FixtureServer,
  parseCount,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session } from "./harness.ts";

// One Firefox for the file: the tests run in order and build on each other's tabs.
describe("tabs in real Firefox", () => {
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
});

function tabOf(value: unknown): TabInfo {
  assert.ok(isRecord(value), `expected { tab }, got ${JSON.stringify(value)}`);
  return checkTab(value.tab);
}

function tabsOf(value: unknown): TabInfo[] {
  assert.ok(
    isRecord(value) && Array.isArray(value.tabs),
    `expected { tabs }, got ${JSON.stringify(value)}`,
  );
  const tabs: unknown[] = value.tabs;
  return tabs.map(checkTab);
}

function checkTab(value: unknown): TabInfo {
  assert.ok(
    isRecord(value) &&
      typeof value.id === "number" &&
      typeof value.url === "string" &&
      typeof value.title === "string" &&
      typeof value.active === "boolean",
    `expected a tab, got ${JSON.stringify(value)}`,
  );
  return { id: value.id, url: value.url, title: value.title, active: value.active };
}
