import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, isRecord, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer } from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

const TITLE_ON = "Foxhand: an agent session can use this tab";
const TITLE_OFF = "Foxhand";
const WAIT_MS = 10_000;

interface TabState {
  id: number;
  url: string;
  groupId: number;
}

// One Firefox for the file: the tests run in order and build on each other's tabs.
describe("toolbar badge in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let settings: string;
  let agentTabId = -1;
  let userTabId = -1;

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
      settings = await harness.settingsPage();
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

  test("a tab the agent opens shows ON", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    agentTabId = tab.id;
    await expectIndicator(agentTabId, "ON", TITLE_ON);
  });

  test("Firefox's startup tab shows no badge", async () => {
    const startup = (await queryTabs()).find(
      (tab) => !tab.url.startsWith("moz-extension:") && !tab.url.startsWith(fixtures.site),
    );
    assert.ok(startup !== undefined, "no startup tab");
    await expectIndicator(startup.id, "", TITLE_OFF);
  });

  test("the agent's tab still shows ON after the agent navigates it", async () => {
    await harness.ok(session, "navigate", { tabId: agentTabId, url: fixtures.url("/b") });
    await expectIndicator(agentTabId, "ON", TITLE_ON);
  });

  test("the agent's tab still shows ON after the user navigates it", async () => {
    const context = await firefox.waitForContext((tab) => tab.url === fixtures.url("/b"), WAIT_MS);
    await firefox.navigate(context, fixtures.url("/a"));
    await expectIndicator(agentTabId, "ON", TITLE_ON);
  });

  test("a tab the user opens outside the group shows no badge", async () => {
    await firefox.openContext(fixtures.url("/b"));
    const user = (await queryTabs()).find(
      (tab) => tab.url === fixtures.url("/b") && tab.groupId === -1,
    );
    assert.ok(user !== undefined, "no user tab at /b outside a group");
    userTabId = user.id;
    await expectIndicator(userTabId, "", TITLE_OFF);
  });

  test("a tab the user moves into the session's group shows ON", async () => {
    const agent = (await queryTabs()).find((tab) => tab.id === agentTabId);
    assert.ok(agent !== undefined && agent.groupId !== -1, "the agent's tab is in no group");
    await firefox.evaluate(
      settings,
      `browser.tabs.group({ groupId: ${agent.groupId}, tabIds: [${userTabId}] }).then(() => true)`,
    );
    await expectIndicator(userTabId, "ON", TITLE_ON);
  });

  test("a tab taken out of the session's group loses the badge", async () => {
    await firefox.evaluate(settings, `browser.tabs.ungroup(${agentTabId}).then(() => true)`);
    await expectIndicator(agentTabId, "", TITLE_OFF);
  });

  async function queryTabs(): Promise<TabState[]> {
    const json = await firefox.evaluate(
      settings,
      "browser.tabs.query({}).then((tabs) => JSON.stringify(tabs.map(({ id, url, groupId }) => ({ id, url, groupId }))))",
    );
    assert.equal(typeof json, "string", `tabs.query returned ${String(json)}`);
    const tabs: unknown = JSON.parse(String(json));
    assert.ok(Array.isArray(tabs), `tabs.query returned ${String(json)}`);
    return tabs.map((tab: unknown) => {
      assert.ok(
        isRecord(tab) &&
          typeof tab.id === "number" &&
          typeof tab.url === "string" &&
          typeof tab.groupId === "number",
        `unexpected tab ${JSON.stringify(tab)}`,
      );
      return { id: tab.id, url: tab.url, groupId: tab.groupId };
    });
  }

  async function expectIndicator(tabId: number, text: string, title: string): Promise<void> {
    const expected = JSON.stringify([text, title]);
    await pollUntil(
      async () => {
        const seen = await firefox.evaluate(
          settings,
          `Promise.all([browser.action.getBadgeText({ tabId: ${tabId} }), browser.action.getTitle({ tabId: ${tabId} })]).then((values) => JSON.stringify(values))`,
        );
        if (seen === expected) return true;
        throw new Error(`badge and title are ${String(seen)}`);
      },
      WAIT_MS,
      `tab ${tabId} to show ${expected}`,
    );
  }
});
