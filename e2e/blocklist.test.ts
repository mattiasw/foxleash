import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { TabInfo } from "@foxhand/protocol";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

const BLOCKLIST_TEXT = "Foxhand's blocklist";

// One Firefox for the file: the tests run in order and share the tabs opened before them.
describe("the blocklist, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let pageTab = -1;
  let blankTab = -1;
  let hitsB = 0;

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
      const page = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
      assert.equal(page.url, fixtures.url("/b"));
      assert.equal(page.title, TITLES.b);
      pageTab = page.id;
      blankTab = tabOf(await harness.ok(session, "tab_open")).id;
      hitsB = fixtures.hits("/b");
      // The fixture server is on 127.0.0.1; blocking it and localhost makes it a blocked site.
      await harness.seedSettings({ blocklist: ["127.0.0.1", "localhost"] });
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

  test("tab_open refuses a blocked site before it opens a tab or sends a request", async () => {
    const before = await tabIds();
    const text = await harness.refused(session, "tab_open", { url: fixtures.url("/a") });
    assert.ok(text.includes(fixtures.site), text);
    assert.ok(text.includes(BLOCKLIST_TEXT), text);
    assert.equal(fixtures.hits("/a"), 0);
    assert.deepEqual(await tabIds(), before);
  });

  test("navigate refuses a blocked site before it sends a request", async () => {
    const text = await harness.refused(session, "navigate", {
      tabId: blankTab,
      url: fixtures.url("/a"),
    });
    assert.ok(text.includes(fixtures.site), text);
    assert.ok(text.includes(BLOCKLIST_TEXT), text);
    assert.equal(fixtures.hits("/a"), 0);
    const blank = (await tabs()).find(({ id }) => id === blankTab);
    assert.equal(blank?.url, "about:blank");
  });

  test("a trailing dot does not get past the blocklist", async () => {
    const before = await tabIds();
    const text = await harness.refused(session, "tab_open", {
      url: `http://localhost.:${fixtures.port}/a`,
    });
    assert.ok(text.includes(`http://localhost:${fixtures.port}`), text);
    assert.ok(text.includes(BLOCKLIST_TEXT), text);
    assert.equal(fixtures.hits("/a"), 0);
    assert.deepEqual(await tabIds(), before);
  });

  test("reload refuses a tab on a blocked site, which shows only its site", async () => {
    const text = await harness.refused(session, "navigate", { tabId: pageTab, action: "reload" });
    assert.ok(text.includes(fixtures.site), text);
    assert.ok(text.includes(BLOCKLIST_TEXT), text);
    assert.equal(fixtures.hits("/b"), hitsB);
    const page = (await tabs()).find(({ id }) => id === pageTab);
    assert.deepEqual(page === undefined ? undefined : { url: page.url, title: page.title }, {
      url: fixtures.site,
      title: "",
    });
  });

  test("reload of a blank tab still works", async () => {
    const reloaded = tabOf(
      await harness.ok(session, "navigate", { tabId: blankTab, action: "reload" }),
    );
    assert.equal(reloaded.url, "about:blank");
  });

  async function tabs(): Promise<TabInfo[]> {
    return tabsOf(await harness.ok(session, "tabs_list"));
  }

  async function tabIds(): Promise<number[]> {
    return (await tabs()).map(({ id }) => id);
  }
});
