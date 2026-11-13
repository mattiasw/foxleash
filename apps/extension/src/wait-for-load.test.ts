import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tab } from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  type FakeBrowser,
  type FakeTab,
  flush,
} from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { createTabNavigations } from "./tab-navigations.ts";
import {
  LOAD_AFTER_READY_MS,
  LOAD_GRACE_MS,
  LOAD_TIMEOUT_MS,
  waitForLoad,
} from "./wait-for-load.ts";

describe("waitForLoad", { timeout: 10000 }, () => {
  it("waits about 1 s for a load to start and up to 30 s for it to finish", () => {
    assert.equal(LOAD_GRACE_MS, 1000);
    assert.equal(LOAD_TIMEOUT_MS, 30000);
  });

  it("gives a load whose document is ready 0.4 s more to finish", () => {
    assert.equal(LOAD_AFTER_READY_MS, 400);
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
      seen.push(fake.listenerCount(), fake.committedListenerCount(), timers.pending());
      fake.emitStatus(tab.id, "loading");
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
      fake.emitStatus(tab.id, "complete");
    });
    assert.deepEqual(seen, [1, 1, 1]);
    assertCleanedUp(fake, timers);
  });

  it("resolves when the load finishes before the navigation's promise settles", async () => {
    const { fake, timers, tab } = setup();
    const loaded = await waitForLoad(fake.browser, timers, tab.id, "https://b.example/", () => {
      fake.emitStatus(tab.id, "loading");
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
      fake.emitStatus(tab.id, "complete");
      return new Promise(() => {});
    });
    assert.equal(loaded.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("resolves after the grace when nothing loads and the destination is not known", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, undefined, () => new Promise(() => {})),
    );
    timers.advance(1000);
    await flush();
    assert.equal(wait.tab()?.id, tab.id);
    assertCleanedUp(fake, timers);
  });

  it("ignores a complete before any loading when the destination is not known", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, undefined, async () => {
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
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.id, tab.id);
    assertCleanedUp(fake, timers);
  });

  it("keeps waiting past the grace for a load that starts late", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}),
    );
    timers.advance(1000);
    await flush();
    assert.equal(wait.done(), false);
    await fake.browser.tabs.update(tab.id, { url: "https://b.example/" });
    await flush();
    assert.equal(wait.tab()?.url, "https://b.example/");
    assert.equal(wait.tab()?.status, "complete");
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
    assert.equal(wait.done(), false);
    await fake.browser.tabs.update(tab.id, { url: "https://b.example/" });
    await flush();
    assert.equal(wait.tab()?.url, "https://b.example/");
    assertCleanedUp(fake, timers);
  });

  it("fails 30 s after the grace check found an earlier load still running", async () => {
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
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
    assertCleanedUp(fake, timers);
  });

  it("returns the tab as it is 30 s after loading started", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
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
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
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

  it("fails 30 s after a load that leaves the tab on about:blank", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    timers.advance(1000);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(28999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
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
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
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
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
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
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
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
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
    });
    await flush();
    fake.tabs.delete(tab.id);
    timers.advance(30000);
    await assert.rejects(wait, /Invalid tab ID/);
    assertCleanedUp(fake, timers);
  });

  for (const [when, url] of [
    ["", "https://b.example/"],
    [" when the destination is not known", undefined],
  ] as const) {
    it(`does not restart the wait when loading starts during the grace check${when}`, async () => {
      const { fake, timers, tab } = setup();
      const lookup = Promise.withResolvers<Tab>();
      fake.browser.tabs.get = () => lookup.promise;
      const wait = track(waitForLoad(fake.browser, timers, tab.id, url, async () => {}));
      timers.advance(1000);
      fake.emitStatus(tab.id, "loading");
      lookup.resolve({ ...tab, status: "complete" });
      await flush();
      assert.equal(wait.done(), false);
      assert.equal(timers.pending(), 1);
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.done(), true);
      assertCleanedUp(fake, timers);
    });
  }

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
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
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

  it("finishes on the page's complete when its commit follows a blank complete", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "about:blank" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    assert.equal(wait.done(), false);
    tab.url = "https://b.example/";
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.url, "https://b.example/");
    assertCleanedUp(fake, timers);
  });

  for (const unloaded of [false, true]) {
    const when = unloaded ? " when told the tab was unloaded" : "";

    it(`waits past the commit and complete of a tab Firefox restores for the page it loads${when}`, async () => {
      const { fake, timers } = setup();
      const url = "https://a.example/page";
      const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => restore(fake, tab), {
          unloaded,
        }),
      );
      await flush();
      assert.equal(wait.done(), false);
      await fake.browser.tabs.update(tab.id, { url });
      await flush();
      assert.equal(wait.tab()?.title, `Title of ${url}`);
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers);
    });

    it(`returns the page it loads into a tab Firefox restores on another page${when}`, async () => {
      const { fake, timers } = setup();
      const tab = fake.openTab({ url: "https://a.example/old", discarded: true, title: "Old" });
      const url = "https://b.example/new";
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => restore(fake, tab), {
          unloaded,
        }),
      );
      await flush();
      assert.equal(wait.done(), false);
      await fake.browser.tabs.update(tab.id, { url });
      await flush();
      assert.equal(wait.tab()?.url, url);
      assert.equal(wait.tab()?.title, `Title of ${url}`);
      assertCleanedUp(fake, timers);
    });

    it(`fails with navigation_timeout when the load after a restore of another page commits nothing${when}`, async () => {
      const { fake, timers } = setup();
      const tab = fake.openTab({ url: "https://a.example/old", discarded: true, title: "Old" });
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          "https://b.example/new",
          async () => {
            restore(fake, tab);
            fake.emitStatus(tab.id, "loading");
            fake.emitStatus(tab.id, "complete");
          },
          { unloaded },
        ),
      );
      await flush();
      timers.advance(LOAD_TIMEOUT_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await assert.rejects(wait.promise, { code: "navigation_timeout" });
      assertCleanedUp(fake, timers);
    });

    it(`fails with navigation_timeout when the load after a restore of the requested URL commits nothing${when}`, async () => {
      const { fake, timers } = setup();
      const url = "https://a.example/file.pdf";
      const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            restore(fake, tab);
            fake.emitStatus(tab.id, "loading");
            fake.emitStatus(tab.id, "complete");
          },
          { unloaded },
        ),
      );
      await flush();
      timers.advance(LOAD_TIMEOUT_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await assert.rejects(wait.promise, { code: "navigation_timeout" });
      assertCleanedUp(fake, timers);
    });

    it(`does not finish on a restore of the requested URL when the grace check finds it complete${when}`, async () => {
      const { fake, timers } = setup();
      const url = "https://a.example/page";
      const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => restore(fake, tab), {
          unloaded,
        }),
      );
      await flush();
      timers.advance(LOAD_GRACE_MS);
      await flush();
      assert.equal(wait.done(), false);
      await fake.browser.tabs.update(tab.id, { url });
      await flush();
      assert.equal(wait.tab()?.title, `Title of ${url}`);
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers);
    });

    it(`fails with navigation_timeout when the load into a tab created unloaded on its URL commits nothing${when}`, async () => {
      const { fake, timers } = setup();
      const url = "https://a.example/file.bin";
      const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            restoreNeverLoaded(fake, tab);
            fake.emitStatus(tab.id, "loading");
            fake.emitStatus(tab.id, "complete");
          },
          { unloaded },
        ),
      );
      await flush();
      timers.advance(LOAD_TIMEOUT_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await assert.rejects(wait.promise, { code: "navigation_timeout" });
      assertCleanedUp(fake, timers);
    });

    it(`returns the page it loads into a tab created unloaded on its URL${when}`, async () => {
      const { fake, timers } = setup();
      const url = "https://a.example/page";
      const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            restoreNeverLoaded(fake, tab);
            await fake.browser.tabs.update(tab.id, { url });
          },
          { unloaded },
        ),
      );
      await flush();
      assert.equal(wait.tab()?.title, `Title of ${url}`);
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers);
    });
  }

  const unloadedDownloads: [string, (fake: FakeBrowser, tab: FakeTab, url: string) => void][] = [
    ["after a restore of a tab created unloaded", (fake, tab) => restoreNeverLoaded(fake, tab)],
    [
      "after a restore of a tab Firefox had loaded",
      (fake, tab, url) => {
        restore(fake, tab);
        fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
      },
    ],
    [
      "with no restore reported",
      (fake, tab, url) => {
        tab.discarded = false;
        fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
      },
    ],
  ];
  for (const [name, begin] of unloadedDownloads) {
    it(`fails with navigation_timeout when a load of the unloaded tab's fragment URL commits nothing ${name}`, async () => {
      const { fake, timers } = setup();
      const url = "https://a.example/file.bin#x";
      const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            begin(fake, tab, url);
            fake.emitStatus(tab.id, "loading");
            fake.emitStatus(tab.id, "complete");
          },
          { unloaded: true },
        ),
      );
      await flush();
      timers.advance(LOAD_TIMEOUT_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await assert.rejects(wait.promise, { code: "navigation_timeout" });
      assertCleanedUp(fake, timers);
    });
  }

  it("does not count a restore's commit before the grace check when told the tab was unloaded", async () => {
    const { fake, timers } = setup();
    const url = "https://a.example/file.bin";
    const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
    const wait = track(
      waitForLoad(
        fake.browser,
        timers,
        tab.id,
        url,
        async () => {
          tab.discarded = false;
          fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
        },
        { unloaded: true },
      ),
    );
    await flush();
    timers.advance(LOAD_GRACE_MS);
    await flush();
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
    fake.emitStatus(tab.id, "loading");
    fake.emitStatus(tab.id, "complete");
    await flush();
    timers.advance(LOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
    assertCleanedUp(fake, timers);
  });

  it("does not count a restore's commit after a loading when told the tab was unloaded", async () => {
    const { fake, timers } = setup();
    const url = "https://a.example/file.bin";
    const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
    const wait = track(
      waitForLoad(
        fake.browser,
        timers,
        tab.id,
        url,
        async () => {
          tab.discarded = false;
          fake.emitStatus(tab.id, "loading");
          fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
          fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
          fake.emitStatus(tab.id, "complete");
        },
        { unloaded: true },
      ),
    );
    await flush();
    timers.advance(LOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
    assertCleanedUp(fake, timers);
  });

  it("does not count a restore's commit after an about:blank load when told the tab was unloaded", async () => {
    const { fake, timers } = setup();
    const url = "https://a.example/file.bin";
    const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
    const wait = track(
      waitForLoad(
        fake.browser,
        timers,
        tab.id,
        url,
        async () => {
          tab.discarded = false;
          tab.url = "about:blank";
          fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "about:blank" });
          fake.emitStatus(tab.id, "loading");
          fake.emitStatus(tab.id, "complete");
          tab.url = url;
          fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
          fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
          fake.emitStatus(tab.id, "loading");
          fake.emitStatus(tab.id, "complete");
        },
        { unloaded: true },
      ),
    );
    await flush();
    timers.advance(LOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
    assertCleanedUp(fake, timers);
  });

  const unloadedPages: [string, string, (fake: FakeBrowser, tab: FakeTab) => void][] = [
    [
      "its fragment URL into a tab created unloaded on it",
      "https://a.example/page#part",
      restoreNeverLoaded,
    ],
    ["another fragment of the page a restored tab shows", "https://a.example/page#other", restore],
  ];
  for (const [name, url, begin] of unloadedPages) {
    it(`returns the page when told the tab was unloaded for a load of ${name}`, async () => {
      const { fake, timers } = setup();
      const tab = fake.openTab({
        url: "https://a.example/page#part",
        discarded: true,
        title: "Stored title",
      });
      const loaded = await waitForLoad(
        fake.browser,
        timers,
        tab.id,
        url,
        async () => {
          begin(fake, tab);
          await fake.browser.tabs.update(tab.id, { url });
        },
        { unloaded: true },
      );
      assert.equal(loaded.url, url);
      assert.equal(loaded.title, `Title of ${url}`);
      assert.equal(loaded.status, "complete");
      assertCleanedUp(fake, timers);
    });
  }

  it("returns the page when told the tab was unloaded and its commit came before its loading", async () => {
    const { fake, timers } = setup();
    const url = "https://a.example/page#part";
    const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
    const loaded = await waitForLoad(
      fake.browser,
      timers,
      tab.id,
      url,
      async () => {
        restoreNeverLoaded(fake, tab);
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      },
      { unloaded: true },
    );
    assert.equal(loaded.url, url);
    assert.equal(loaded.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("finishes on the page's complete when its commit came before its loading", async () => {
    const { fake, timers, tab } = setup();
    const url = "https://b.example/";
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, url, async () => {
        tab.url = url;
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    assert.equal(wait.tab()?.url, url);
    assertCleanedUp(fake, timers);
  });

  it("finishes on the page's complete when its commit came after its onBeforeNavigate and before its loading", async () => {
    const { fake, timers, tab } = setup();
    const url = "https://b.example/";
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, url, async () => {
        fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
        tab.url = url;
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    assert.equal(wait.tab()?.url, url);
    assertCleanedUp(fake, timers);
  });

  it("keeps an early commit across onBeforeNavigate of other tabs and of frames", async () => {
    const { fake, timers, tab } = setup();
    const other = fake.openTab();
    const url = "https://b.example/";
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, url, async () => {
        tab.url = url;
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
        fake.emitBeforeNavigate({ tabId: other.id, frameId: 0, url });
        fake.emitBeforeNavigate({ tabId: tab.id, frameId: 1, url });
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    assert.equal(wait.tab()?.url, url);
    assertCleanedUp(fake, timers);
  });

  for (const [timeoutMs, text] of [
    [undefined, "30 seconds"],
    [20000, "20 seconds"],
  ] as const) {
    it(`fails with navigation_timeout when nothing commits within ${text}`, async () => {
      const { fake, timers, tab } = setup();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          "https://b.example/",
          async () => {},
          timeoutMs === undefined ? {} : { timeoutMs },
        ),
      );
      timers.advance(LOAD_GRACE_MS);
      await flush();
      timers.advance((timeoutMs ?? LOAD_TIMEOUT_MS) - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await assert.rejects(wait.promise, (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, "navigation_timeout");
        assert.equal(
          error.message,
          `Tab ${tab.id} did not load a page from that URL within ${text}.`,
        );
        return true;
      });
      assertCleanedUp(fake, timers);
    });
  }

  it("fails at the timeout when a load completes without a commit", async () => {
    const { fake, timers, tab } = setup();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    timers.advance(1000);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(28999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
    assertCleanedUp(fake, timers);
  });

  it("finishes a fragment navigation after the grace", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "https://a.example/page" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://a.example/page#part", async () => {
        tab.url = "https://a.example/page#part";
      }),
    );
    timers.advance(999);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await flush();
    assert.equal(wait.tab()?.url, "https://a.example/page#part");
    assertCleanedUp(fake, timers);
  });

  for (const [name, from, to] of [
    ["the same URL without a fragment", "https://a.example/page", "https://a.example/page"],
    ["a fragment URL on another path", "https://a.example/page", "https://a.example/other#part"],
  ] as const) {
    it(`waits for a load after the grace for ${name}`, async () => {
      const { fake, timers } = setup();
      const tab = fake.openTab({ url: from });
      const wait = track(waitForLoad(fake.browser, timers, tab.id, to, async () => {}));
      timers.advance(1000);
      await flush();
      assert.equal(wait.done(), false);
      await fake.browser.tabs.update(tab.id, { url: to });
      await flush();
      assert.equal(wait.tab()?.url, to);
      assertCleanedUp(fake, timers);
    });
  }

  const notFragmentTabs: [string, (fake: FakeBrowser) => number][] = [
    [
      "a discarded tab labelled with it",
      (fake) => fake.openTab({ url: "https://a.example/page#part", discarded: true }).id,
    ],
    [
      "a tab whose URL is not known",
      (fake) => {
        const { id } = fake.openTab({ url: "https://a.example/page" });
        fake.browser.tabs.get = async (tabId) => ({ id: tabId, windowId: 1, active: false });
        return id;
      },
    ],
  ];
  for (const [name, openTab] of notFragmentTabs) {
    it(`does not take ${name} for a fragment navigation`, async () => {
      const { fake, timers } = setup();
      const tabId = openTab(fake);
      const wait = track(
        waitForLoad(fake.browser, timers, tabId, "https://a.example/page#part", async () => {}),
      );
      timers.advance(1000);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(30000);
      await assert.rejects(wait.promise, { code: "navigation_timeout" });
      assertCleanedUp(fake, timers);
    });
  }

  it("ends a fragment navigation in a page still loading on that page's complete", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "https://a.example/page" });
    fake.emitStatus(tab.id, "loading");
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://a.example/page#part", async () => {
        tab.url = "https://a.example/page#part";
      }),
    );
    timers.advance(1000);
    await flush();
    assert.equal(wait.done(), false);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.url, "https://a.example/page#part");
    assert.equal(wait.tab()?.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("ends a fragment navigation reported as loading on the page's complete", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "https://a.example/page" });
    fake.emitStatus(tab.id, "loading");
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://a.example/page#part", async () => {
        // Firefox reports a location change in a page still loading as loading.
        tab.url = "https://a.example/page#part";
        fake.emitStatus(tab.id, "loading");
      }),
    );
    await flush();
    assert.equal(wait.done(), false);
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.url, "https://a.example/page#part");
    assertCleanedUp(fake, timers);
  });

  it("returns a fragment navigation in a page that never completes at the timeout", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "https://a.example/page" });
    fake.emitStatus(tab.id, "loading");
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://a.example/page#part", async () => {
        tab.url = "https://a.example/page#part";
      }),
    );
    timers.advance(1000);
    await flush();
    timers.advance(30000);
    await flush();
    assert.equal(wait.tab()?.url, "https://a.example/page#part");
    assert.equal(wait.tab()?.status, "loading");
    assertCleanedUp(fake, timers);
  });

  it("ignores commits of other tabs, of frames and of about:blank", async () => {
    const { fake, timers, tab } = setup();
    const other = fake.openTab();
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {
        fake.emitStatus(tab.id, "loading");
      }),
    );
    fake.emitCommitted({ tabId: other.id, frameId: 0, url: "https://b.example/" });
    fake.emitCommitted({ tabId: tab.id, frameId: 1, url: "https://b.example/" });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.done(), false);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(wait.tab()?.id, tab.id);
    assertCleanedUp(fake, timers);
  });

  it("watches no commits when the destination is not known", async () => {
    const { fake, timers, tab } = setup();
    const seen: number[] = [];
    await waitForLoad(fake.browser, timers, tab.id, undefined, async () => {
      seen.push(fake.committedListenerCount());
      fake.emitStatus(tab.id, "loading");
      fake.emitStatus(tab.id, "complete");
    });
    assert.deepEqual(seen, [0]);
    assertCleanedUp(fake, timers);
  });

  describe("told when the document is ready", () => {
    const url = "https://b.example/";

    /** The tab's top frame starting a load of `url`, then committing it as document "doc-b". */
    function loadAndCommit(fake: FakeBrowser, tab: FakeTab): void {
      fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
      fake.emitStatus(tab.id, "loading");
      tab.url = url;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url, documentId: "doc-b" });
    }

    function domReady(fake: FakeBrowser, tab: FakeTab, documentId = "doc-b"): void {
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url, documentId });
    }

    it("resolves 0.4 s after the committed document's DOM is ready, with the tab as it is then", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready,
        }),
      );
      await flush();
      timers.advance(LOAD_GRACE_MS);
      await flush();
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await flush();
      assert.equal(wait.tab()?.url, url);
      assert.equal(wait.tab()?.status, "loading");
      assertCleanedUp(fake, timers, baseline);
    });

    it("resolves at a complete that comes before the 0.4 s end, and leaves no timer", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready,
        }),
      );
      await flush();
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS - 1);
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers, baseline);
    });

    it("starts no extra time at a DOMContentLoaded of the document the tab is leaving", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
            fake.emitStatus(tab.id, "loading");
            domReady(fake, tab, "doc-a");
          },
          { ready },
        ),
      );
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      tab.url = url;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url, documentId: "doc-b" });
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS);
      await flush();
      assert.equal(wait.tab()?.url, url);
      assertCleanedUp(fake, timers, baseline);
    });

    it("never returns the page the tab is leaving, even when its load ends", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
            fake.emitStatus(tab.id, "loading");
            fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/" });
          },
          { ready },
        ),
      );
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      tab.url = url;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url, documentId: "doc-b" });
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.url, url);
      assertCleanedUp(fake, timers, baseline);
    });

    it("counts DOM ready only of the commit after the onBeforeNavigate of a tab told unloaded", async () => {
      const { fake, timers, ready, baseline } = setupReady();
      const stored = "https://a.example/page";
      const tab = fake.openTab({ url: stored, discarded: true, title: "Stored title" });
      // The tracker holds a navigation the restore began, which its commit and DOM ready end.
      fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: stored });
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            tab.discarded = false;
            fake.emitStatus(tab.id, "loading");
            fake.emitCommitted({ tabId: tab.id, frameId: 0, url: stored, documentId: "doc-a" });
            fake.emitDOMContentLoaded({
              tabId: tab.id,
              frameId: 0,
              url: stored,
              documentId: "doc-a",
            });
          },
          { unloaded: true, ready },
        ),
      );
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      loadAndCommit(fake, tab);
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await flush();
      assert.equal(wait.tab()?.url, url);
      assertCleanedUp(fake, timers, baseline);
    });

    it("fails at the timeout when the URL commits nothing", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
            fake.emitStatus(tab.id, "loading");
            fake.emitStatus(tab.id, "complete");
          },
          { ready },
        ),
      );
      await flush();
      timers.advance(LOAD_TIMEOUT_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await assert.rejects(wait.promise, { code: "navigation_timeout" });
      assertCleanedUp(fake, timers, baseline);
    });

    it("starts no extra time when the tracker lost the navigation to a complete before its commit", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
            fake.emitStatus(tab.id, "loading");
            fake.emitStatus(tab.id, "complete");
            tab.url = url;
            fake.emitCommitted({ tabId: tab.id, frameId: 0, url, documentId: "doc-b" });
          },
          { ready },
        ),
      );
      await flush();
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers, baseline);
    });

    it("resolves 0.4 s after DOM ready when the commit came before the loading", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
            tab.url = url;
            fake.emitCommitted({ tabId: tab.id, frameId: 0, url, documentId: "doc-b" });
            fake.emitStatus(tab.id, "loading");
          },
          { ready },
        ),
      );
      await flush();
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await flush();
      assert.equal(wait.tab()?.url, url);
      assert.equal(wait.tab()?.status, "loading");
      assertCleanedUp(fake, timers, baseline);
    });

    it("waits for the complete when the commit and DOM ready both came before the loading", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(
          fake.browser,
          timers,
          tab.id,
          url,
          async () => {
            fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url });
            tab.url = url;
            fake.emitCommitted({ tabId: tab.id, frameId: 0, url, documentId: "doc-b" });
            domReady(fake, tab);
            fake.emitStatus(tab.id, "loading");
          },
          { ready },
        ),
      );
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers, baseline);
    });

    it("starts no extra time when another wait's bound ended the navigation committed", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready,
        }),
      );
      await flush();
      const other = ready.settled(tab.id, 100);
      timers.advance(100);
      assert.equal(await other, "committed");
      domReady(fake, tab);
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.status, "complete");
      assertCleanedUp(fake, timers, baseline);
    });

    it("follows a page that leaves for another after its DOM is ready to that page's DOM ready", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const redirect = "https://c.example/";
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready,
        }),
      );
      await flush();
      domReady(fake, tab);
      await flush();
      timers.advance(100);
      fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: redirect });
      timers.advance(200);
      tab.url = redirect;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: redirect, documentId: "doc-c" });
      await flush();
      timers.advance(LOAD_AFTER_READY_MS);
      await flush();
      assert.equal(wait.done(), false);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: redirect, documentId: "doc-c" });
      await flush();
      timers.advance(LOAD_AFTER_READY_MS - 1);
      await flush();
      assert.equal(wait.done(), false);
      timers.advance(1);
      await flush();
      assert.equal(wait.tab()?.url, redirect);
      assertCleanedUp(fake, timers, baseline);
    });

    it("counts only the DOM ready of the page the tab committed last, when the first left early", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const redirect = "https://c.example/";
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready,
        }),
      );
      await flush();
      fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: redirect });
      tab.url = redirect;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: redirect, documentId: "doc-c" });
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: redirect, documentId: "doc-c" });
      await flush();
      timers.advance(LOAD_AFTER_READY_MS - 1);
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.url, redirect);
      assertCleanedUp(fake, timers, baseline);
    });

    it("starts no extra time when the page the tab leaves ends its load before the next commits", async () => {
      const { fake, timers, tab, ready, baseline } = setupReady();
      const redirect = "https://c.example/";
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready,
        }),
      );
      await flush();
      fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: redirect });
      fake.emitCompleted({ tabId: tab.id, frameId: 0, url });
      await flush();
      timers.advance(LOAD_AFTER_READY_MS * 5);
      await flush();
      assert.equal(wait.done(), false);
      tab.url = redirect;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: redirect, documentId: "doc-c" });
      fake.emitStatus(tab.id, "complete");
      await flush();
      assert.equal(wait.tab()?.url, redirect);
      assertCleanedUp(fake, timers, baseline);
    });

    it("fails with the error of a readiness check that rejects", async () => {
      const { fake, timers, tab } = setup();
      const error = new Error("tracker failed");
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, url, async () => loadAndCommit(fake, tab), {
          ready: { settled: () => Promise.reject(error) },
        }),
      );
      await assert.rejects(wait.promise, error);
      assertCleanedUp(fake, timers);
    });
  });
});

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const tab = fake.openTab({ url: "https://a.example/" });
  return { fake, timers, tab };
}

/** `setup` with the navigation tracker created first, as the background script creates it. */
function setupReady() {
  const { fake, timers, tab } = setup();
  const ready = createTabNavigations({ browser: fake.browser, timers });
  return { fake, timers, tab, ready, baseline: listenerCounts(fake) };
}

interface ListenerCounts {
  updated: number;
  committed: number;
  beforeNavigate: number;
}

function listenerCounts(fake: FakeBrowser): ListenerCounts {
  return {
    updated: fake.listenerCount(),
    committed: fake.committedListenerCount(),
    beforeNavigate: fake.beforeNavigateListenerCount(),
  };
}

function assertCleanedUp(
  fake: FakeBrowser,
  timers: { pending(): number },
  baseline: ListenerCounts = { updated: 0, committed: 0, beforeNavigate: 0 },
): void {
  assert.equal(fake.listenerCount(), baseline.updated, "listeners left");
  assert.equal(fake.committedListenerCount(), baseline.committed, "commit listeners left");
  assert.equal(
    fake.beforeNavigateListenerCount(),
    baseline.beforeNavigate,
    "onBeforeNavigate listeners left",
  );
  assert.equal(timers.pending(), 0, "timers left");
}

function track(promise: Promise<Tab>): {
  promise: Promise<Tab>;
  done(): boolean;
  tab(): Tab | undefined;
} {
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
  return { promise, done: () => done, tab: () => result };
}

/**
 * What Firefox reports restoring a tab it unloaded after loading it, before the requested
 * navigation begins: a commit of its stored URL and a complete.
 */
function restore(fake: FakeBrowser, tab: FakeTab): void {
  tab.discarded = false;
  fake.emitCommitted({ tabId: tab.id, frameId: 0, url: tab.url });
  fake.emitStatus(tab.id, "complete");
}

/**
 * What Firefox reports restoring a tab it created unloaded, before the requested load starts: a
 * commit of its stored URL, with no complete, then the requested navigation's onBeforeNavigate.
 */
function restoreNeverLoaded(fake: FakeBrowser, tab: FakeTab): void {
  tab.discarded = false;
  fake.emitCommitted({ tabId: tab.id, frameId: 0, url: tab.url });
  fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: tab.url });
}
