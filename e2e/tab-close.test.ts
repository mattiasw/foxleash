import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

describe("tab_close with a beforeunload prompt in real Firefox", () => {
  let harness: Harness;
  let firefox: Firefox;
  let fixtures: FixtureServer;
  let session: Session;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST, { holdBeforeUnloadPrompts: true });
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

  test("closing a window's two tabs at once keeps one while the first one's page asks to stay", async () => {
    const first = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/before-unload") }),
    );
    const second = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    // The startup tab: then the group's window holds exactly the two tabs.
    await firefox.closeContext(
      await firefox.waitForContext((context) => context.url === "about:blank", PAGE_TIMEOUT_MS),
    );
    // Another window, so closing the group's window cannot quit Firefox.
    await firefox.openWindow();
    const context = await firefox.waitForContext(
      (candidate) => candidate.url === fixtures.url("/before-unload"),
      PAGE_TIMEOUT_MS,
    );
    const prompt = await firefox.watchPrompt(context);

    const closing = watch(harness.ok(session, "tab_close", { tabId: first.id }));
    const refusing = watch(harness.refused(session, "tab_close", { tabId: second.id }));
    const closes = Promise.allSettled([closing.call, refusing.call]);

    try {
      assert.equal(await prompt.opened(), "beforeunload");
    } catch (error: unknown) {
      // tab_close reads the tab before it queues the close, so the second may have queued first.
      throw new Error(
        `${String(error)}; tab_close on the first tab is ${closing.state()}, on the second ${refusing.state()}`,
        { cause: error },
      );
    }

    const shown = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.ok(shown.includes(first.id), `tabs_list lists ${JSON.stringify(shown)}`);

    await prompt.answer(true);

    const [closed, refusal] = await closes;
    if (closed.status === "rejected") assert.fail(String(closed.reason));
    if (refusal.status === "rejected") assert.fail(String(refusal.reason));
    assert.match(refusal.value, /is the last tab in its window/);

    await pollUntil(
      async () => {
        const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
        if (ids.length === 1 && ids[0] === second.id) return true;
        throw new Error(`tabs_list lists ${JSON.stringify(ids)}`);
      },
      PAGE_TIMEOUT_MS,
      `tabs_list to list only tab ${second.id}`,
    );
  });
});

/** The call, and how it has settled so far, for a failure message. */
function watch<T>(call: Promise<T>): { call: Promise<T>; state(): string } {
  let state = "pending";
  call.then(
    (value) => {
      state = `fulfilled with ${JSON.stringify(value)}`;
    },
    (reason: unknown) => {
      state = `rejected with ${String(reason)}`;
    },
  );
  return { call, state: () => state };
}
