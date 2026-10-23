import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeBrowser, createFakeTimers, flush } from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { WAIT_POLL_MS, waitForNavigation, waitForPage } from "./wait-for.ts";

interface Request {
  session: string;
  tabId: number;
  type: string;
  params: Record<string, unknown>;
  at: number;
}

describe("waitForPage", { timeout: 10000 }, () => {
  it("asks the page every WAIT_POLL_MS until it answers true", async () => {
    const { timers, pages, requests, answer, elapsed } = setup();
    const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "Saved" }, 10_000);
    for (let poll = 0; poll < 3; poll += 1) {
      answer(false);
      await flush();
      tick(timers, elapsed, WAIT_POLL_MS);
    }
    answer(true);
    assert.equal(await waiting, true);
    assert.deepEqual(
      requests.map(({ session, tabId, type, params, at }) => [session, tabId, type, params, at]),
      [0, 250, 500, 750].map((at) => ["s1", 4, "wait_for", { text: "Saved" }, at]),
    );
    assert.equal(timers.pending(), 0);
  });

  it("retries a page in transition, then resolves once it answers true", async () => {
    const { timers, pages, requests, answer, fail, elapsed } = setup();
    const waiting = waitForPage({ pages, timers }, "s1", 4, { selector: "#done" }, 10_000);
    for (const [index, code] of ["page_changed", "page_unreachable", "page_timeout"].entries()) {
      fail(new ToolError(code, "In transition."));
      await flush();
      tick(timers, elapsed, WAIT_POLL_MS - 1);
      await flush();
      assert.equal(requests.length, index + 1, code);
      tick(timers, elapsed, 1);
      assert.equal(requests.length, index + 2, code);
    }
    answer(true);
    assert.equal(await waiting, true);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[0]?.params, { selector: "#done" });
    assert.equal(timers.pending(), 0);
  });

  it("rejects at once with any other error, and asks no more", async () => {
    const { timers, pages, requests, fail } = setup();
    const refusal = new ToolError("site_not_approved", "Not approved.");
    const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "a" }, 10_000);
    fail(refusal);
    await assert.rejects(waiting, (error: unknown) => error === refusal);
    assert.equal(timers.pending(), 0);
    timers.advance(20_000);
    await flush();
    assert.equal(requests.length, 1);
  });

  it("rejects with an error that only looks like a retried one by its message", async () => {
    const { timers, pages, fail } = setup();
    const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "a" }, 10_000);
    const plain = new Error("page_changed");
    fail(plain);
    await assert.rejects(waiting, (error: unknown) => error === plain);
    assert.equal(timers.pending(), 0);
  });

  it("resolves false at the deadline while a request is pending, and starts nothing after", async () => {
    const { timers, pages, requests, answer, elapsed } = setup();
    const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "a" }, 1000);
    answer(false);
    await flush();
    tick(timers, elapsed, WAIT_POLL_MS);
    await flush();
    assert.equal(requests.length, 2);
    tick(timers, elapsed, 1000 - WAIT_POLL_MS);
    assert.equal(await waiting, false);
    assert.equal(timers.pending(), 0);
    answer(true);
    await flush();
    timers.advance(10_000);
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(timers.pending(), 0);
  });

  it("rejects at the deadline with the last poll's retried error", async () => {
    const { timers, pages, fail, elapsed } = setup();
    const changed = new ToolError("page_changed", "Changed.");
    const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "a" }, 300);
    fail(new ToolError("page_unreachable", "Unreachable."));
    await flush();
    tick(timers, elapsed, WAIT_POLL_MS);
    fail(changed);
    await flush();
    tick(timers, elapsed, 300 - WAIT_POLL_MS);
    await assert.rejects(waiting, (error: unknown) => error === changed);
    assert.equal(timers.pending(), 0);
  });

  it("resolves false at the deadline when a false followed the retried error", async () => {
    const { timers, pages, answer, fail, elapsed } = setup();
    const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "a" }, 300);
    fail(new ToolError("page_changed", "Changed."));
    await flush();
    tick(timers, elapsed, WAIT_POLL_MS);
    answer(false);
    await flush();
    tick(timers, elapsed, 300 - WAIT_POLL_MS);
    assert.equal(await waiting, false);
    assert.equal(timers.pending(), 0);
  });

  it("keeps asking after any reply other than exactly true", async () => {
    for (const reply of ["true", 1, {}, null, undefined]) {
      const { timers, pages, requests, answer, elapsed } = setup();
      const waiting = waitForPage({ pages, timers }, "s1", 4, { text: "a" }, 10_000);
      answer(reply);
      await flush();
      tick(timers, elapsed, WAIT_POLL_MS);
      answer(true);
      assert.equal(await waiting, true, String(reply));
      assert.equal(requests.length, 2, String(reply));
    }
  });
});

describe("waitForNavigation", { timeout: 10000 }, () => {
  it("resolves navigated when the tab's top frame completes a load", async () => {
    const { fake, timers, counts } = navigationSetup();
    const waiting = waitForNavigation({ browser: fake.browser, timers }, 4, 10_000, async () => {});
    await flush();
    fake.emitCompleted({ tabId: 5, frameId: 0, url: "https://other.example/" });
    fake.emitCompleted({ tabId: 4, frameId: 1, url: "https://frame.example/" });
    fake.emitHistoryStateUpdated({ tabId: 4, frameId: 2, url: "https://frame.example/b" });
    assert.equal(await settledYet(waiting), false);
    fake.emitCompleted({ tabId: 4, frameId: 0, url: "https://a.example/" });
    assert.equal(await waiting, "navigated");
    counts.assertBack();
  });

  it("resolves navigated when the page changes its address with the History API", async () => {
    const { fake, timers, counts } = navigationSetup();
    const waiting = waitForNavigation({ browser: fake.browser, timers }, 4, 10_000, async () => {});
    await flush();
    fake.emitHistoryStateUpdated({ tabId: 4, frameId: 0, url: "https://a.example/b" });
    assert.equal(await waiting, "navigated");
    counts.assertBack();
  });

  it("counts a navigation that ends while the checks run, once they pass", async () => {
    const { fake, timers, counts } = navigationSetup();
    const { promise: checked, resolve } = Promise.withResolvers<void>();
    const waiting = waitForNavigation({ browser: fake.browser, timers }, 4, 10_000, () => checked);
    fake.emitCompleted({ tabId: 4, frameId: 0, url: "https://a.example/" });
    assert.equal(await settledYet(waiting), false);
    resolve();
    assert.equal(await waiting, "navigated");
    counts.assertBack();
  });

  it("rejects with the error of the checks", async () => {
    const { fake, timers, counts } = navigationSetup();
    const refusal = new ToolError("tab_not_in_group", "Not in the group.");
    const waiting = waitForNavigation({ browser: fake.browser, timers }, 4, 10_000, async () => {
      throw refusal;
    });
    await assert.rejects(waiting, (error: unknown) => error === refusal);
    counts.assertBack();
  });

  it("resolves closed when the tab is removed, not another one", async () => {
    const { fake, timers, counts } = navigationSetup();
    const tab = fake.openTab({ url: "https://a.example/" });
    const other = fake.openTab({ url: "https://b.example/" });
    const waiting = waitForNavigation(
      { browser: fake.browser, timers },
      tab.id,
      10_000,
      async () => {},
    );
    await flush();
    fake.removeTab(other.id);
    assert.equal(await settledYet(waiting), false);
    fake.removeTab(tab.id);
    assert.equal(await waiting, "closed");
    counts.assertBack();
  });

  it("resolves timeout when nothing happens in time", async () => {
    const { fake, timers, counts } = navigationSetup();
    const waiting = waitForNavigation({ browser: fake.browser, timers }, 4, 500, async () => {});
    await flush();
    timers.advance(499);
    assert.equal(await settledYet(waiting), false);
    timers.advance(1);
    assert.equal(await waiting, "timeout");
    counts.assertBack();
  });
});

function setup() {
  const timers = createFakeTimers();
  const requests: Request[] = [];
  const elapsed = { ms: 0 };
  const replies: PromiseWithResolvers<unknown>[] = [];
  const pages = {
    request(session: string, tabId: number, type: string, params: Record<string, unknown>) {
      requests.push({ session, tabId, type, params, at: elapsed.ms });
      const reply = Promise.withResolvers<unknown>();
      replies.push(reply);
      return reply.promise;
    },
  };

  /** Answers the latest request. */
  function answer(value: unknown): void {
    replies.at(-1)?.resolve(value);
  }

  /** Fails the latest request. */
  function fail(error: unknown): void {
    replies.at(-1)?.reject(error);
  }

  return { timers, pages, requests, answer, fail, elapsed };
}

function tick(
  timers: ReturnType<typeof createFakeTimers>,
  elapsed: { ms: number },
  ms: number,
): void {
  elapsed.ms += ms;
  timers.advance(ms);
}

function navigationSetup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const navigation = fake.navigationListenerCount();
  const removed = fake.removedListenerCount();
  return {
    fake,
    timers,
    counts: {
      assertBack(): void {
        assert.equal(fake.navigationListenerCount(), navigation);
        assert.equal(fake.removedListenerCount(), removed);
        assert.equal(timers.pending(), 0);
      },
    },
  };
}

async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flush();
  return settled;
}
