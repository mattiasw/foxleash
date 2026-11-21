import assert from "node:assert/strict";
import { after, before, describe, type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TabInfo } from "@foxleash/protocol";
import { DEFAULT_BLOCKLIST } from "../apps/extension/src/default-blocklist.ts";
import { PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

/** Well under the 30 s a load may take to commit: the refusal comes when the hop is cancelled. */
const ANSWER_WITHIN_MS = 10_000;

describe("a redirect hop of the agent's load, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  // The same server under another site, which the tests never approve.
  let other = "";

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      other = `http://localhost:${fixtures.port}`;
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

  describe("to a site on the blocklist", () => {
    before(
      async () => {
        await harness.seedSettings({ blocklist: ["localhost"] });
      },
      { timeout: 60_000 },
    );

    test("navigate fails at once, sends nothing to that site and keeps the tab's page", async (t) => {
      const tab = await open("/a");
      const text = await refusedInTime(t, "navigate", {
        tabId: tab.id,
        url: fixtures.url("/load-hop/blocked"),
      });
      assert.equal(text, blockedHop(tab.id));
      assert.equal(fixtures.hits("/load-hop/blocked"), 1);
      assert.equal(fixtures.hits("/load-hop/blocked-target"), 0);
      assert.equal((await listed(tab.id))?.url, fixtures.url("/a"));
      await close(tab);
    });

    test("tab_open fails at once, sends nothing to that site and leaves no tab", async (t) => {
      const before = (await tabs()).map(({ id }) => id);
      const hits = fixtures.hits("/load-hop/blocked");
      const text = await refusedInTime(t, "tab_open", { url: fixtures.url("/load-hop/blocked") });
      assert.match(text, blockedHopPattern());
      assert.equal(fixtures.hits("/load-hop/blocked"), hits + 1);
      assert.equal(fixtures.hits("/load-hop/blocked-target"), 0);
      assert.deepEqual(
        (await tabs()).map(({ id }) => id),
        before,
      );
    });

    test("a reload whose address now redirects there fails at once and keeps the tab's page", async (t) => {
      const tab = await open("/load-hop/reload");
      const text = await refusedInTime(t, "navigate", { tabId: tab.id, action: "reload" });
      assert.equal(text, blockedHop(tab.id));
      assert.equal(fixtures.hits("/load-hop/reload"), 2);
      assert.equal(fixtures.hits("/load-hop/reload-target"), 0);
      const shown = await settled(tab.id);
      assert.equal(shown.url, fixtures.url("/load-hop/reload"));
      assert.equal(shown.title, TITLES.loadHop);
      await close(tab);
    });

    test("every later reload of that tab fails at once too and sends nothing to that site", async (t) => {
      const tab = await open("/load-hop/reload-again");
      assert.equal(
        await refusedInTime(t, "navigate", { tabId: tab.id, action: "reload" }),
        blockedHop(tab.id),
      );
      await settled(tab.id);
      // Firefox sends the next reload straight to the address of the cancelled redirect.
      assert.equal(
        await refusedInTime(t, "navigate", { tabId: tab.id, action: "reload" }),
        blockedHop(tab.id),
      );
      assert.equal(
        await refusedInTime(t, "navigate", { tabId: tab.id, action: "reload" }),
        blockedHop(tab.id),
      );
      assert.equal(fixtures.hits("/load-hop/reload-again"), 2);
      assert.equal(fixtures.hits("/load-hop/reload-again-target"), 0);
      const shown = await settled(tab.id);
      assert.equal(shown.url, fixtures.url("/load-hop/reload-again"));
      assert.equal(shown.title, TITLES.loadHop);
      await close(tab);
    });

    test("a reload the page holds back past the wait sends nothing to that site", async (t) => {
      const tab = await open("/load-hop/held");
      const started = Date.now();
      const result = await harness.call(session, "navigate", { tabId: tab.id, action: "reload" });
      const answeredMs = Date.now() - started;
      // The wait ends at its grace before the load starts, or hears the cancel if it started first.
      if (result.isError) {
        assert.equal(untrustedContent(result.text) ?? result.text, blockedHop(tab.id));
      }
      await sleep(3000);
      assert.equal(fixtures.hits("/load-hop/held"), 2);
      assert.equal(fixtures.hits("/load-hop/held-target"), 0);
      t.diagnostic(
        `navigate reload answered in ${answeredMs} ms, ${result.isError ? "refused" : "with the tab"}`,
      );
      await close(tab);
    });

    test("a reload on a page that keeps navigating itself sends nothing to that site", async (t) => {
      const tab = await open("/load-hop/busy-reload");
      await stepOnBusyPage(t, tab, "reload", "/load-hop/busy-reload");
    });

    test("a step back from a page that keeps navigating itself sends nothing to that site", async (t) => {
      const tab = await open("/load-hop/busy-back");
      await harness.ok(session, "navigate", {
        tabId: tab.id,
        url: fixtures.url("/load-hop/busy-next"),
      });
      await stepOnBusyPage(t, tab, "back", "/load-hop/busy-back");
    });

    /**
     * The page's own navigations end the wait before the step's load starts; that load's redirect
     * is cancelled all the same.
     */
    async function stepOnBusyPage(
      t: TestContext,
      tab: TabInfo,
      action: string,
      entry: string,
    ): Promise<void> {
      // The step must come while the page is busy with a navigation of its own, so that the wait ends
      // on that navigation before the step's load starts; a step right after the load comes first
      // and is refused during the wait.
      await sleep(1500);
      const started = Date.now();
      const result = await harness.call(session, "navigate", { tabId: tab.id, action });
      const answeredMs = Date.now() - started;
      if (result.isError) {
        assert.equal(untrustedContent(result.text) ?? result.text, blockedHop(tab.id));
      }
      // Fails rather than passes when Firefox shows the page again without requesting it.
      await pollUntil(
        async () => (fixtures.hits(entry) >= 2 ? true : undefined),
        15_000,
        `the ${action} step to request ${entry}`,
      );
      const requestedMs = Date.now() - started;
      await sleep(2000);
      assert.equal(fixtures.hits(`${entry}-target`), 0);
      t.diagnostic(
        `navigate ${action} answered in ${answeredMs} ms, ${result.isError ? "refused" : "with the tab"}; its request seen by ${requestedMs} ms`,
      );
      await close(tab);
    }
  });

  describe("to a site that is only not approved", () => {
    before(
      async () => {
        await harness.seedSettings({ blocklist: [...DEFAULT_BLOCKLIST] });
      },
      { timeout: 60_000 },
    );

    test("navigate loads it and returns the tab with its site only", async () => {
      const tab = await open("/a");
      const shown = tabOf(
        await harness.ok(session, "navigate", {
          tabId: tab.id,
          url: fixtures.url("/load-hop/away"),
        }),
      );
      assert.deepEqual(shown, { id: tab.id, url: other, title: "", active: true });
      assert.equal(fixtures.hits("/load-hop/away-target"), 1);
      await close(tab);
    });
  });

  function blockedHop(tabId: number): string {
    return `Tab ${tabId}'s load was redirected to ${other}, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`;
  }

  function blockedHopPattern(): RegExp {
    return new RegExp(
      `^Tab \\d+'s load was redirected to ${other.replaceAll(".", "\\.")}, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there\\.$`,
    );
  }

  /** The call's refusal, in the untrusted frame it comes in; it must come well under 30 s. */
  async function refusedInTime(
    t: TestContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const started = Date.now();
    const text = await harness.refused(session, name, args);
    const answeredMs = Date.now() - started;
    t.diagnostic(`${name} refused in ${answeredMs} ms`);
    assert.ok(answeredMs < ANSWER_WITHIN_MS, `${name} took ${answeredMs} ms`);
    return untrustedContent(text) ?? text;
  }

  async function open(path: string): Promise<TabInfo> {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url(path) }));
    assert.equal(tab.url, fixtures.url(path));
    return tab;
  }

  async function tabs(): Promise<TabInfo[]> {
    return tabsOf(await harness.ok(session, "tabs_list"));
  }

  /** The refusal comes before Firefox stops the reload, and a loading tab lists no title. */
  async function settled(tabId: number): Promise<TabInfo> {
    return pollUntil(
      async () => {
        const listedTab = await listed(tabId);
        if (listedTab !== undefined && listedTab.title !== "") return listedTab;
        throw new Error(`tab ${tabId} is listed as ${JSON.stringify(listedTab)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${tabId} to finish its refused reload`,
    );
  }

  async function listed(tabId: number): Promise<TabInfo | undefined> {
    return (await tabs()).find(({ id }) => id === tabId);
  }

  async function close(tab: TabInfo): Promise<void> {
    await harness.ok(session, "tab_close", { tabId: tab.id });
  }
});
