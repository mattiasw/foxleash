import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tab } from "./browser-api.ts";
import { createFakeBrowser, createFakeTimers, type FakeBrowser, flush } from "./fake-browser.ts";
import { LOAD_GRACE_MS, LOAD_TIMEOUT_MS, waitForLoad } from "./wait-for-load.ts";

describe("waitForLoad", { timeout: 10000 }, () => {
  it("waits about 1 s for a load to start and up to 30 s for it to finish", () => {
    assert.equal(LOAD_GRACE_MS, 1000);
    assert.equal(LOAD_TIMEOUT_MS, 30000);
  });

  it("resolves with the loaded tab on complete after loading", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(fake.browser, timers, tab.id, () =>
      fake.browser.tabs.update(tab.id, { url: "https://b.example/" }),
    );
    assert.equal(loaded.id, tab.id);
    assert.equal(loaded.url, "https://b.example/");
    assert.equal(loaded.status, "complete");
    assert.equal(loaded.title, "Title of https://b.example/");
    assertCleanedUp(fake, timers);
  });

  it("registers the listener and the grace timer before the navigation starts", async () => {
    const { fake, timers, tab } = setup();
    const seen: number[] = [];
    await waitForLoad(fake.browser, timers, tab.id, async () => {
      seen.push(fake.listenerCount(), timers.pending());
      fake.emitStatus(tab.id, "loading");
      fake.emitStatus(tab.id, "complete");
    });
    assert.deepEqual(seen, [1, 1]);
    assertCleanedUp(fake, timers);
  });

  it("resolves when the load finishes before the navigation's promise settles", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(fake.browser, timers, tab.id, () => {
      fake.emitStatus(tab.id, "loading");
      fake.emitStatus(tab.id, "complete");
      return new Promise(() => {});
    });
    assert.equal(loaded.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("resolves after the grace when the navigation never settles and nothing loads", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(waitForLoad(fake.browser, timers, tab.id, () => new Promise(() => {})));
    timers.advance(1000);
    await flush();
    assert.equal(wait.tab()?.id, tab.id);
    assertCleanedUp(fake, timers);
  });

  it("ignores a complete that arrives before any loading", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, async () => {
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    assert.equal(wait.done(), false);
    fake.emitStatus(tab.id, "loading");
    await flush();
    assert.equal(wait.done(), false);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("ignores status changes of other tabs", async () => {
    const { fake, timers, tab } = setup();
    const other = fake.openTab();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, async () => {
        fake.emitStatus(tab.id, "loading");
      }),
    );
    fake.emitStatus(other.id, "loading");
    fake.emitStatus(other.id, "complete");
    await flush();
    assert.equal(wait.done(), false);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.id, tab.id);
    assertCleanedUp(fake, timers);
  });

  it("resolves with the complete tab after the grace when no load starts", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(waitForLoad(fake.browser, timers, tab.id, async () => {}));
    timers.advance(999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await flush();
    assert.deepEqual(wait.tab(), {
      id: tab.id,
      windowId: 1,
      active: false,
      url: "https://a.example/",
      title: "Title of https://a.example/",
      status: "complete",
      groupId: -1,
    });
    assertCleanedUp(fake, timers);
  });

  it("keeps waiting when the grace check finds the tab still loading", async () => {
    const { fake, timers, tab } = setup();
    fake.emitStatus(tab.id, "loading");
    const wait = track(waitForLoad(fake.browser, timers, tab.id, async () => {}));
    timers.advance(1000);
    await flush();
    assert.equal(wait.done(), false);
    assert.equal(timers.pending(), 1);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("returns the still-loading tab 30 s after the grace check found it loading", async () => {
    const { fake, timers, tab } = setup();
    fake.emitStatus(tab.id, "loading");
    const wait = track(waitForLoad(fake.browser, timers, tab.id, async () => {}));
    timers.advance(1000);
    await flush();
    timers.advance(29999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await flush();
    assert.equal(wait.tab()?.status, "loading");
    assertCleanedUp(fake, timers);
  });

  it("returns the tab as it is 30 s after loading started", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, async () => {
        fake.emitStatus(tab.id, "loading");
      }),
    );
    timers.advance(29999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await flush();
    assert.equal(wait.tab()?.status, "loading");
    assertCleanedUp(fake, timers);
  });

  it("arms one timeout however often loading is reported", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "loading");
      }),
    );
    await flush();
    assert.equal(timers.pending(), 1);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.done(), true);
    assertCleanedUp(fake, timers);
  });

  it("rejects with the navigation's error and cleans up", async () => {
    const { fake, timers, tab } = setup();
    const error = new Error("navigation failed");
    await assert.rejects(
      waitForLoad(fake.browser, timers, tab.id, async () => {
        throw error;
      }),
      error,
    );
    assertCleanedUp(fake, timers);
  });

  it("rejects when the navigation throws synchronously", async () => {
    const { fake, timers, tab } = setup();
    const error = new Error("invalid argument");
    await assert.rejects(
      waitForLoad(fake.browser, timers, tab.id, () => {
        throw error;
      }),
      error,
    );
    assertCleanedUp(fake, timers);
  });

  it("ignores a navigation that rejects after the load finished", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(fake.browser, timers, tab.id, async () => {
      fake.emitStatus(tab.id, "loading");
      fake.emitStatus(tab.id, "complete");
      throw new Error("late");
    });
    assert.equal(loaded.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("rejects when the tab is gone at the grace check", async () => {
    const { fake, timers, tab } = setup();
    const wait = waitForLoad(fake.browser, timers, tab.id, async () => {});
    fake.tabs.delete(tab.id);
    timers.advance(1000);
    await assert.rejects(wait, /Invalid tab ID/);
    assertCleanedUp(fake, timers);
  });

  it("rejects when the tab is gone at the timeout", async () => {
    const { fake, timers, tab } = setup();
    const wait = waitForLoad(fake.browser, timers, tab.id, async () => {
      fake.emitStatus(tab.id, "loading");
    });
    await flush();
    fake.tabs.delete(tab.id);
    timers.advance(30000);
    await assert.rejects(wait, /Invalid tab ID/);
    assertCleanedUp(fake, timers);
  });

  it("does not restart the wait when loading starts during the grace check", async () => {
    const { fake, timers, tab } = setup();
    const lookup = Promise.withResolvers<Tab>();
    fake.browser.tabs.get = () => lookup.promise;
    const wait = track(waitForLoad(fake.browser, timers, tab.id, async () => {}));
    timers.advance(1000);
    fake.emitStatus(tab.id, "loading");
    lookup.resolve({ ...tab, status: "complete" });
    await flush();
    assert.equal(wait.done(), false);
    assert.equal(timers.pending(), 1);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.done(), true);
    assertCleanedUp(fake, timers);
  });

  it("arms no timer when the wait settled during the grace check", async () => {
    const { fake, timers, tab } = setup();
    const lookup = Promise.withResolvers<Tab>();
    const navigation = Promise.withResolvers<unknown>();
    fake.browser.tabs.get = () => lookup.promise;
    const wait = waitForLoad(fake.browser, timers, tab.id, () => navigation.promise);
    timers.advance(1000);
    navigation.reject(new Error("navigation failed"));
    await assert.rejects(wait, /navigation failed/);
    lookup.resolve({ ...tab, status: "loading" });
    await flush();
    assertCleanedUp(fake, timers);
  });
});

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const tab = fake.openTab({ url: "https://a.example/" });
  return { fake, timers, tab };
}

function assertCleanedUp(fake: FakeBrowser, timers: { pending(): number }): void {
  assert.equal(fake.listenerCount(), 0, "listeners left");
  assert.equal(timers.pending(), 0, "timers left");
}

function track(promise: Promise<Tab>): { done(): boolean; tab(): Tab | undefined } {
  let result: Tab | undefined;
  let done = false;
  promise.then(
    (tab) => {
      result = tab;
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { done: () => done, tab: () => result };
}
