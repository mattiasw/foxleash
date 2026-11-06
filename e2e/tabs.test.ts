import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, pollUntil } from "./firefox.ts";
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
  let firefox: Firefox;
  let fixtures: FixtureServer;
  let session: Session;
  let tabId = -1;
  let secondId = -1;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
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
    assert.equal(tab.active, true);
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

  test("navigate reload loads a page Firefox unloaded to save memory", async () => {
    const url = fixtures.url("/counter");
    const shown = tabsOf(await harness.ok(session, "tabs_list")).find((tab) => tab.id === tabId);
    const count = parseCount(shown?.title ?? "");
    // Firefox does not unload the selected tab.
    const other = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
    try {
      await firefox.discardTab(url);
      const reloaded = tabOf(await harness.ok(session, "navigate", { tabId, action: "reload" }));
      assert.equal(reloaded.url, url);
      assert.equal(reloaded.title, counterTitle(count + 1));
      const read = await harness.call(session, "read_page", { tabId });
      assert.equal(read.isError, false, read.text);
      // A plain reload of an unloaded tab turns it blank only after navigate has answered.
      await sleep(2000);
      const later = await harness.call(session, "read_page", { tabId });
      assert.equal(later.isError, false, later.text);
    } finally {
      await harness.ok(session, "tab_close", { tabId: other.id });
    }
  });

  test("navigate loads a url into a tab Firefox unloaded to save memory", async () => {
    // The query only makes the URL unique.
    const stored = fixtures.url("/a?unloaded");
    const unloaded = tabOf(await harness.ok(session, "tab_open", { url: stored }));
    // Firefox does not unload the selected tab.
    const other = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
    try {
      await firefox.discardTab(stored);
      const url = fixtures.url("/b?navigated");
      const navigated = tabOf(await harness.ok(session, "navigate", { tabId: unloaded.id, url }));
      assert.equal(navigated.url, url);
      assert.equal(navigated.title, TITLES.b);
    } finally {
      for (const id of [unloaded.id, other.id])
        await harness.ok(session, "tab_close", { tabId: id });
    }
  });

  test("a tab_open tab Firefox unloaded comes back with only its page in its history", async () => {
    // The query only makes the URL unique; /slow holds its answer past the load grace period.
    const url = fixtures.url("/slow?unloaded");
    const started = Date.now();
    const opened = tabOf(await harness.ok(session, "tab_open", { url }));
    let other: number | undefined;
    try {
      assert.equal(opened.url, url);
      assert.equal(opened.title, TITLES.slow);
      assert.equal(opened.active, true);
      // A load wait that missed the load's end would answer only at its 30 s timeout.
      assert.ok(Date.now() - started < 20_000, `tab_open took ${Date.now() - started} ms`);
      assert.deepEqual(await firefox.sessionHistory(url), { index: 1, entries: [url] });
      // Firefox does not unload the selected tab.
      other = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") })).id;
      await firefox.discardTab(url);
      await harness.ok(session, "tab_select", { tabId: opened.id });
      await pollUntil(
        async () => {
          const history = await firefox.sessionHistory(url);
          if (history.entries[history.index - 1] !== url) {
            throw new Error(`the history is ${JSON.stringify(history)}`);
          }
          return history;
        },
        5000,
        `${url} as the current entry`,
      );
      // Read again as late as the stray about:blank entry was seen: 1.5 s after the select.
      await sleep(1500);
      assert.deepEqual(await firefox.sessionHistory(url), { index: 1, entries: [url] });
    } finally {
      const tabIds = other === undefined ? [opened.id] : [opened.id, other];
      for (const id of tabIds) await harness.ok(session, "tab_close", { tabId: id });
    }
  });

  // Firefox 156 gives a tab that started on about:blank an about:blank entry after its page when
  // it restores it, and no extension API measured avoids it (ADR 0030).
  test.todo(
    "a tab_open tab without a url that navigate loaded a page into comes back with only its page in its history",
  );

  test("tab_open loads a page again that the cache holds", async () => {
    const url = fixtures.url("/counter-no-cache");
    const first = tabOf(await harness.ok(session, "tab_open", { url }));
    let second: number | undefined;
    try {
      const again = tabOf(await harness.ok(session, "tab_open", { url }));
      second = again.id;
      assert.equal(again.title, counterTitle(parseCount(first.title) + 1));
    } finally {
      const tabIds = second === undefined ? [first.id] : [first.id, second];
      for (const id of tabIds) await harness.ok(session, "tab_close", { tabId: id });
    }
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
