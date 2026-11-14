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

  test("refuses a close the page asks to confirm, without holding other closes", async () => {
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

    const closing = watch(harness.refused(session, "tab_close", { tabId: first.id }));

    try {
      assert.equal(await prompt.opened(), "beforeunload");
    } catch (error: unknown) {
      throw new Error(`${String(error)}; tab_close on the first tab is ${closing.state()}`, {
        cause: error,
      });
    }

    // Answered while the prompt is open: the first close does not hold the second.
    assert.match(
      await harness.refused(session, "tab_close", { tabId: second.id }),
      /is the last tab in its window/,
    );
    assert.equal(closing.state(), "pending");
    assert.match(await closing.call, /asked the user to confirm leaving it/);
    // Asked again while its prompt is open, Firefox would close the tab without the user's answer.
    assert.match(
      await harness.refused(session, "tab_close", { tabId: first.id }),
      /asked the user to confirm leaving it/,
    );

    const shown = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.ok(shown.includes(first.id), `tabs_list lists ${JSON.stringify(shown)}`);

    // Another session's close and session end, still while the prompt is open.
    const other = await harness.connect();
    const page = tabOf(await harness.ok(other, "tab_open", { url: fixtures.url("/b") }));
    const blank = tabOf(await harness.ok(other, "tab_open"));
    const left = tabsOf(await harness.ok(other, "tab_close", { tabId: page.id }));
    assert.deepEqual(
      left.map((tab) => tab.id),
      [blank.id],
    );
    await other.close();
    await pollUntil(
      async () => {
        const text = await harness.refused(session, "navigate", {
          tabId: blank.id,
          action: "reload",
        });
        if (text.includes("does not exist")) return true;
        throw new Error(text);
      },
      PAGE_TIMEOUT_MS,
      `tab ${blank.id} to close with its session`,
    );

    await prompt.answer(true);

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

  test("closing a window's two tabs at once without a prompt closes one and keeps the other", async () => {
    const c = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    const d = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
    for (const tab of tabsOf(await harness.ok(session, "tabs_list"))) {
      if (tab.id !== c.id && tab.id !== d.id) {
        await harness.ok(session, "tab_close", { tabId: tab.id });
      }
    }

    const results = await Promise.all([
      harness.call(session, "tab_close", { tabId: c.id }),
      harness.call(session, "tab_close", { tabId: d.id }),
    ]);
    const refusals = results.filter((result) => result.isError);
    assert.equal(refusals.length, 1, JSON.stringify(results));
    assert.match(refusals[0]?.text ?? "", /is the last tab in its window/);

    const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.equal(ids.length, 1, `tabs_list lists ${JSON.stringify(ids)}`);
    assert.ok(ids[0] === c.id || ids[0] === d.id, `tabs_list lists ${JSON.stringify(ids)}`);
  });

  // Last: it leaves a tab with a beforeunload handler open.
  test("refuses a close when the user chooses to stay on the page, and closes the window's other tab", async () => {
    const left = tabsOf(await harness.ok(session, "tabs_list"));
    assert.equal(left.length, 1, `tabs_list lists ${JSON.stringify(left)}`);
    const kept = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/before-unload") }),
    );
    const context = await firefox.waitForContext(
      (candidate) => candidate.url === fixtures.url("/before-unload"),
      PAGE_TIMEOUT_MS,
    );
    const prompt = await firefox.watchPrompt(context);

    const closing = watch(harness.refused(session, "tab_close", { tabId: kept.id }));
    try {
      assert.equal(await prompt.opened(), "beforeunload");
    } catch (error: unknown) {
      throw new Error(`${String(error)}; tab_close is ${closing.state()}`, { cause: error });
    }
    await prompt.answer(false);

    assert.match(await closing.call, /the user chose to stay/);
    await harness.ok(session, "tab_close", { tabId: left[0]?.id });
    const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.deepEqual(ids, [kept.id]);
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
