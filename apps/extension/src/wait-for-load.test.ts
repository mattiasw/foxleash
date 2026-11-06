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
import { LOAD_GRACE_MS, LOAD_TIMEOUT_MS, waitForLoad } from "./wait-for-load.ts";

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

  it("waits past the commit and complete of a tab Firefox restores for the page it loads", async () => {
    const { fake, timers } = setup();
    const url = "https://a.example/page";
    const tab = fake.openTab({ url, discarded: true, title: "Stored title" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, url, async () => restore(fake, tab)),
    );
    await flush();
    assert.equal(wait.done(), false);
    await fake.browser.tabs.update(tab.id, { url });
    await flush();
    assert.equal(wait.tab()?.title, `Title of ${url}`);
    assert.equal(wait.tab()?.status, "complete");
    assertCleanedUp(fake, timers);
  });

  it("returns the page it loads into a tab Firefox restores on another page", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "https://a.example/old", discarded: true, title: "Old" });
    const url = "https://b.example/new";
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, url, async () => restore(fake, tab)),
    );
    await flush();
    assert.equal(wait.done(), false);
    await fake.browser.tabs.update(tab.id, { url });
    await flush();
    assert.equal(wait.tab()?.url, url);
    assert.equal(wait.tab()?.title, `Title of ${url}`);
    assertCleanedUp(fake, timers);
  });

  it("fails with navigation_timeout when the load after a restore of another page commits nothing", async () => {
    const { fake, timers } = setup();
    const tab = fake.openTab({ url: "https://a.example/old", discarded: true, title: "Old" });
    const wait = track(
      waitForLoad(fake.browser, timers, tab.id, "https://b.example/new", async () => {
        restore(fake, tab);
        fake.emitStatus(tab.id, "loading");
        fake.emitStatus(tab.id, "complete");
      }),
    );
    await flush();
    timers.advance(LOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(wait.done(), false);
    timers.advance(1);
    await assert.rejects(wait.promise, { code: "navigation_timeout" });
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

  for (const [timeoutMs, text] of [
    [undefined, "30 seconds"],
    [20000, "20 seconds"],
  ] as const) {
    it(`fails with navigation_timeout when nothing commits within ${text}`, async () => {
      const { fake, timers, tab } = setup();
      const wait = track(
        waitForLoad(fake.browser, timers, tab.id, "https://b.example/", async () => {}, timeoutMs),
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
});

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const tab = fake.openTab({ url: "https://a.example/" });
  return { fake, timers, tab };
}

function assertCleanedUp(fake: FakeBrowser, timers: { pending(): number }): void {
  assert.equal(fake.listenerCount(), 0, "listeners left");
  assert.equal(fake.committedListenerCount(), 0, "commit listeners left");
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
 * What Firefox reports restoring a tab it unloaded, before the requested load starts: a commit of
 * its stored URL and a complete.
 */
function restore(fake: FakeBrowser, tab: FakeTab): void {
  tab.discarded = false;
  fake.emitCommitted({ tabId: tab.id, frameId: 0, url: tab.url });
  fake.emitStatus(tab.id, "complete");
}
