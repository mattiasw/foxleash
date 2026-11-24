import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Firefox } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

// One Firefox for the file: the tests run in order and build on each other's tab.
describe("page tools while Firefox withholds access to websites", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  // biome-ignore lint/correctness/noUnusedVariables: kept for tests that end the withheld state
  let firefox: Firefox;
  let session: Session;
  let tabId = -1;

  /** The page-tool refusal for the tab opened by the first test. */
  function withheld(): string {
    return `Firefox has not given Foxleash access to this site, so Foxleash cannot read or act in the page in tab ${tabId}. Ask the user to open about:addons in Firefox, click Foxleash, then the Permissions tab, and under "Optional" turn on "Access your data for all websites". Firefox lists this access as optional, but Foxleash needs it.`;
  }

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST, { withholdSiteAccess: true });
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

  test("tab_open and tabs_list work", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    assert.equal(tab.title, TITLES.a);
    tabId = tab.id;
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.ok(
      tabs.some((listed) => listed.id === tabId),
      JSON.stringify(tabs),
    );
  });

  for (const tool of ["get_page_text", "read_page", "screenshot"]) {
    test(`${tool} says Firefox withholds the site's access, naming neither the site nor the page`, async () => {
      const result = await harness.call(session, tool, { tabId });
      assert.equal(result.isError, true, result.text);
      assert.ok(result.text.includes(withheld()), result.text);
      assert.ok(!result.text.includes(fixtures.site), result.text);
      assert.ok(!result.text.includes(fixtures.url("/a")), result.text);
      assert.deepEqual(result.images, [], result.text);
    });
  }

  test("wait_for stops at once with the same refusal", async () => {
    const started = performance.now();
    const result = await harness.call(session, "wait_for", {
      tabId,
      text: "Never shown on this page",
      timeout: 10,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.isError, true, result.text);
    assert.ok(result.text.includes(withheld()), result.text);
    assert.ok(elapsed < 5_000, `wait_for took ${Math.round(elapsed)} ms`);
  });
});
