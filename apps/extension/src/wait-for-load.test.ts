import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tab } from "./browser-api.ts";
import { createFakeBrowser, createFakeTimers, type FakeBrowser, flush } from "./fake-browser.ts";
import {
  BLANK_COMMIT_TIMEOUT_MS,
  LOAD_GRACE_MS,
  LOAD_TIMEOUT_MS,
  waitForLoad,
  watchBlankCommits,
} from "./wait-for-load.ts";

describe("waitForLoad", { timeout: 10000 }, () => {
  it("waits about 1 s for a load to start and up to 30 s for it to finish", () => {
    assert.equal(LOAD_GRACE_MS, 1000);
    assert.equal(LOAD_TIMEOUT_MS, 30000);
  });

  it("resolves with the loaded tab on complete after loading", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(fake.browser, timers, tab.id, "https://b.example/", () =>
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
    await waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
      seen.push(fake.listenerCount(), timers.pending());
      fake.emitStatus(tab.id, "loading");
      fake.emitStatus(tab.id, "complete");
    });
    assert.deepEqual(seen, [1, 1]);
    assertCleanedUp(fake, timers);
  });

  it("resolves when the load finishes before the navigation's promise settles", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(fake.browser, timers, tab.id, "https://b.example/", () => {
      fake.emitStatus(tab.id, "loading");
      fake.emitStatus(tab.id, "complete");
      return new Promise(() => {});
    });
    assert.equal(loaded.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("resolves after the grace when the navigation never settles and nothing loads", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", () => new Promise(() => {})),
    );
    timers.advance(1000);
    await flush();
    assert.equal(wait.tab()?.id, tab.id);
    assertCleanedUp(fake, timers);
  });

  it("ignores a complete that arrives before any loading", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
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
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
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
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}),
    );
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
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}),
    );
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
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}),
    );
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
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
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
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
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

  it("waits past a complete that leaves the tab on about:blank for the page it loads", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const loaded = await waitForLoad(
      fake.browser,
      timers,
      tab.id,
      "https://b.example/",
      async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
        await fake.browser.tabs.update(tab.id, { url: "https://b.example/" });
      },
    );
    assert.equal(loaded.url, "https://b.example/");
    assert.equal(loaded.status, "complete");
    assert.equal(loaded.title, "Title of https://b.example/");
    assertCleanedUp(fake, timers);
  });

  it("returns a tab the load leaves on about:blank after the grace", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    timers.advance(999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await flush();
    assert.equal(wait.tab()?.url, "about:blank");
    assert.equal(wait.tab()?.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("finishes on a complete on about:blank when the destination is not known", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, undefined, async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    assert.equal(wait.tab()?.url, "about:blank");
    assertCleanedUp(fake, timers);
  });

  it("returns the loaded page at the grace when its complete came during a restart", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
      }),
    );
    fake.emitStatus(tab.id, "complete");
    tab.url = "https://b.example/";
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1000);
    await flush();
    assert.equal(wait.tab()?.url, "https://b.example/");
    assert.equal(wait.tab()?.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("keeps one timeout from the first loading across a restart", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    timers.advance(500);
    fake.emitStatus(tab.id, "loading");
    assert.equal(timers.pending(), 1);
    timers.advance(29499);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await flush();
    assert.equal(wait.tab()?.status, "loading");
    assertCleanedUp(fake, timers);
  });

  it("rejects with the navigation's error and cleans up", async () => {
    const { fake, timers, tab } = setup();
    const error = new Error("navigation failed");
    await assert.rejects(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
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
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", () => {
        throw error;
      }),
      error,
    );
    assertCleanedUp(fake, timers);
  });

  it("ignores a navigation that rejects after the load finished", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(
      fake.browser,
      timers,
      tab.id,
      "https://b.example/",
      async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
        throw new Error("late");
      },
    );
    assert.equal(loaded.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("rejects when the tab is gone at the grace check", async () => {
    const { fake, timers, tab } = setup();
    const wait = waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {});
    fake.tabs.delete(tab.id);
    timers.advance(1000);
    await assert.rejects(wait, /Invalid tab ID/);
    assertCleanedUp(fake, timers);
  });

  it("rejects when the tab is gone at the timeout", async () => {
    const { fake, timers, tab } = setup();
    const wait = waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
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
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}),
    );
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

  it("ignores a grace lookup made stale by a load that a blank complete restarted", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const lookup = Promise.withResolvers<Tab>();
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = () => lookup.promise;
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}),
    );
    timers.advance(1000);
    fake.emitStatus(tab.id, "loading");
    fake.emitStatus(tab.id, "complete");
    lookup.resolve({ ...tab, status: "complete" });
    await flush();
    assert.equal(wait.done(), false);
    fake.browser.tabs.get = get;
    tab.url = "https://b.example/";
    fake.emitStatus(tab.id, "loading");
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.url, "https://b.example/");
    assertCleanedUp(fake, timers);
  });

  it("arms no timer when the wait settled during the grace check", async () => {
    const { fake, timers, tab } = setup();
    const lookup = Promise.withResolvers<Tab>();
    const navigation = Promise.withResolvers<unknown>();
    fake.browser.tabs.get = () => lookup.promise;
    const wait = waitForLoad(
      fake.browser,
      timers,
      tab.id,
      "https://b.example/",
      () => navigation.promise,
    );
    timers.advance(1000);
    navigation.reject(new Error("navigation failed"));
    await assert.rejects(wait, /navigation failed/);
    lookup.resolve({ ...tab, status: "loading" });
    await flush();
    assertCleanedUp(fake, timers);
  });
});

describe("watchBlankCommits", { timeout: 10000 }, () => {
  it("waits up to 1 s for a new tab's about:blank commit", () => {
    assert.equal(BLANK_COMMIT_TIMEOUT_MS, 1000);
  });

  it("resolves at once for the tab's about:blank commit that came before the call", async () => {
    const { fake, timers, tab } = setup();
    const blank = watchBlankCommits(fake.browser, timers);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    const settled = settledFlag(blank.committed(tab.id));
    await flush();
    assert.equal(settled(), true);
    assert.equal(timers.pending(), 0);
    blank.stop();
  });

  it("does not resolve for another tab's about:blank commit that came before the call", async () => {
    const { fake, timers, tab } = setup();
    const other = fake.openTab();
    const blank = watchBlankCommits(fake.browser, timers);
    fake.emitCommitted({ tabId: other.id, frameId: 0, url: "about:blank" });
    const settled = settledFlag(blank.committed(tab.id));
    await flush();
    assert.equal(settled(), false);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    await flush();
    assert.equal(settled(), true);
    assert.equal(timers.pending(), 0);
    blank.stop();
  });

  it("waits for the tab's top frame to commit about:blank and ignores other commits", async () => {
    const { fake, timers, tab } = setup();
    const other = fake.openTab();
    const blank = watchBlankCommits(fake.browser, timers);
    const settled = settledFlag(blank.committed(tab.id));
    await flush();
    assert.equal(settled(), false);
    fake.emitCommitted({ tabId: other.id, frameId: 0, url: "about:blank" });
    fake.emitCommitted({ tabId: tab.id, frameId: 1, url: "about:blank" });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://a.example/" });
    await flush();
    assert.equal(settled(), false);
    assert.equal(timers.pending(), 1);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    await flush();
    assert.equal(settled(), true);
    assert.equal(timers.pending(), 0);
    blank.stop();
  });

  it("resolves after BLANK_COMMIT_TIMEOUT_MS when the tab never commits about:blank", async () => {
    const { fake, timers, tab } = setup();
    const blank = watchBlankCommits(fake.browser, timers);
    const settled = settledFlag(blank.committed(tab.id));
    timers.advance(BLANK_COMMIT_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await flush();
    assert.equal(settled(), true);
    assert.equal(timers.pending(), 0);
    blank.stop();
  });

  it("resolves after the timeout it is given when the tab never commits about:blank", async () => {
    const { fake, timers, tab } = setup();
    const blank = watchBlankCommits(fake.browser, timers);
    const settled = settledFlag(blank.committed(tab.id, 200));
    timers.advance(199);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await flush();
    assert.equal(settled(), true);
    assert.equal(timers.pending(), 0);
    blank.stop();
  });

  it("stops listening on stop and settles a wait still pending", async () => {
    const { fake, timers, tab } = setup();
    const before = fake.committedListenerCount();
    const blank = watchBlankCommits(fake.browser, timers);
    assert.equal(fake.committedListenerCount(), before + 1);
    const settled = settledFlag(blank.committed(tab.id));
    await flush();
    assert.equal(settled(), false);
    blank.stop();
    await flush();
    assert.equal(settled(), true);
    assert.equal(fake.committedListenerCount(), before);
    assert.equal(timers.pending(), 0);
    blank.stop();
    assert.equal(fake.committedListenerCount(), before);
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

function settledFlag(promise: Promise<void>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {},
  );
  return () => settled;
}
