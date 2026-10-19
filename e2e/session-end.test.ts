import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "./firefox.ts";
import { type FixtureServer, startFixtureServer } from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session } from "./harness.ts";

const GONE_TIMEOUT_MS = 15_000;
const GONE_POLL_MS = 100;

// One Firefox for the file; a live session probes the tabs of the sessions that end.
describe("session end in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let live: Session;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      await harness.startFirefox(EXTENSION_DIST);
      live = await harness.connect();
      await harness.waitUntilReady(live);
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

  test("closes a group of only blank tabs when its session ends", async () => {
    const session = await harness.connect();
    const tabId = tabIdOf(await harness.ok(session, "tab_open"));
    await session.close();
    await waitUntilGone(tabId);
  });

  test("keeps a group with a page when its session ends", async () => {
    const session = await harness.connect();
    const page = tabIdOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    const blank = tabIdOf(await harness.ok(session, "tab_open"));
    await session.close();

    // The extension decides session ends one at a time, in the order the sessions closed, so
    // once this tab is gone the earlier group has been decided.
    const later = await harness.connect();
    const marker = tabIdOf(await harness.ok(later, "tab_open"));
    await later.close();
    await waitUntilGone(marker);

    for (const tabId of [page, blank]) {
      const text = await harness.refused(live, "navigate", { tabId, action: "reload" });
      assert.ok(text.includes("is not in this session's tab group"), text);
    }
  });

  async function waitUntilGone(tabId: number): Promise<void> {
    const deadline = Date.now() + GONE_TIMEOUT_MS;
    for (;;) {
      const text = await harness.refused(live, "navigate", { tabId, action: "reload" });
      if (text.includes("does not exist")) return;
      assert.ok(Date.now() < deadline, `tab ${tabId} still open; last refusal: ${text}`);
      await sleep(GONE_POLL_MS);
    }
  }
});

function tabIdOf(value: unknown): number {
  assert.ok(
    isRecord(value) && isRecord(value.tab) && typeof value.tab.id === "number",
    `expected { tab: { id } }, got ${JSON.stringify(value)}`,
  );
  return value.tab.id;
}
