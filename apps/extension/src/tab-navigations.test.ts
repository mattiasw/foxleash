import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeBrowser, createFakeTimers, flush } from "./fake-browser.ts";
import { createTabNavigations, type NavigationOutcome } from "./tab-navigations.ts";

const URL_A = "https://a.example/";
const URL_B = "https://a.example/next";

describe("tab navigations", { timeout: 10000 }, () => {
  it("keeps a navigation under way from its start until the committed document is parsed", async () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(navigations.begun(tab.id), 0);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.underWay(tab.id), true);
    assert.equal(navigations.begun(tab.id), 1);
    const outcome = navigations.settled(tab.id, 10_000);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    assert.equal(navigations.underWay(tab.id), true);
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(await outcome, "ready");
    assert.equal(navigations.begun(tab.id), 1);
  });

  it("ends a navigation with onCompleted, before or after its commit", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.underWay(tab.id), false);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(navigations.begun(tab.id), 2);
  });

  it("ends a navigation that shows no document when the tab reports complete", async () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "https://a.example/nocontent" });
    fake.emitStatus(tab.id, "loading");
    assert.equal(navigations.underWay(tab.id), true);
    const outcome = navigations.settled(tab.id, 10_000);
    fake.emitStatus(tab.id, "complete");
    assert.equal(await outcome, "ended");
    assert.equal(navigations.underWay(tab.id), false);
  });

  it("ignores what is not the top frame's navigation", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    // A commit and a status with nothing under way.
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitStatus(tab.id, "loading");
    assert.equal(navigations.underWay(tab.id), false);
    // A frame's navigation, and about:blank.
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 1, url: URL_B });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "about:blank" });
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(navigations.begun(tab.id), 0);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    // The leaving document's late DOMContentLoaded, before the commit.
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "old" });
    fake.emitCommitted({ tabId: tab.id, frameId: 1, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_A });
    assert.equal(navigations.underWay(tab.id), true);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    for (const event of [
      { frameId: 1, url: URL_B, documentId: "new" },
      { frameId: 0, url: "about:blank", documentId: "new" },
      { frameId: 0, url: URL_B, documentId: "other" },
    ]) {
      fake.emitDOMContentLoaded({ tabId: tab.id, ...event });
      fake.emitCompleted({ tabId: tab.id, ...event, frameId: event.frameId === 0 ? 1 : 2 });
      fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "about:blank" });
      assert.equal(navigations.underWay(tab.id), true, JSON.stringify(event));
    }
    fake.emitStatus(tab.id, "loading");
    assert.equal(navigations.underWay(tab.id), true);
    assert.equal(navigations.begun(tab.id), 1);
  });

  it("ignores the DOMContentLoaded of a document a later navigation superseded", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "next" });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "https://a.example/last" });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "next" });
    assert.equal(navigations.underWay(tab.id), true);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://a.example/last" });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: "https://a.example/last" });
    assert.equal(navigations.underWay(tab.id), false);
  });

  it("ends on the DOMContentLoaded of a commit with no document id, or one without", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    assert.equal(navigations.underWay(tab.id), false);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.underWay(tab.id), false);
  });

  for (const blankFirst of [true, false]) {
    it(`keeps a document swap under way until its page is parsed (${blankFirst ? "about:blank" : "second start"} first)`, async () => {
      const { fake, navigations } = setup();
      const tab = fake.openTab({ url: URL_A });
      fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
      const outcome = settledOutcome(navigations.settled(tab.id, 10_000));
      fake.emitStatus(tab.id, "loading");
      const swap = [
        () => {
          const shown = fake.tabs.get(tab.id);
          if (shown !== undefined) shown.url = "about:blank";
          fake.emitStatus(tab.id, "loading");
        },
        () => fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B }),
      ];
      for (const step of blankFirst ? swap : swap.reverse()) step();
      assert.equal(navigations.underWay(tab.id), true);
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
      await flush();
      assert.equal(outcome.value, undefined);
      assert.equal(navigations.begun(tab.id), 2);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
      await flush();
      assert.equal(outcome.value, "ready");
    });
  }

  it("keeps a navigation that begins after the old page's own end", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    // A click on a page still loading: Firefox stops the old load first.
    fake.emitStatus(tab.id, "complete");
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.underWay(tab.id), true);
  });

  it("ends a back or forward from memory, which has no DOMContentLoaded, on onCompleted", async () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    const outcome = navigations.settled(tab.id, 10_000);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    assert.equal(await outcome, "ended");
  });

  it("ends a redirect to a 204 whose end carries another URL", async () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "https://a.example/go" });
    const outcome = navigations.settled(tab.id, 10_000);
    fake.emitStatus(tab.id, "loading");
    fake.emitStatus(tab.id, "complete");
    assert.equal(await outcome, "ended");
  });

  it("drops a closed tab's navigation and count, and settles its waits", async () => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    const other = fake.openTab({ url: URL_A });
    for (const tabId of [tab.id, other.id]) {
      fake.emitBeforeNavigate({ tabId, frameId: 0, url: URL_B });
    }
    const before = timers.pending();
    const waits = [navigations.settled(tab.id, 10_000), navigations.settled(tab.id, 5_000)];
    const otherWait = settledOutcome(navigations.settled(other.id, 10_000));
    fake.removeTab(tab.id);
    assert.deepEqual(await Promise.all(waits), ["removed", "removed"]);
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(navigations.begun(tab.id), 0);
    // The other tab is untouched.
    await flush();
    assert.equal(otherWait.value, undefined);
    assert.equal(navigations.underWay(other.id), true);
    assert.equal(navigations.begun(other.id), 1);
    assert.equal(timers.pending(), before + 1);
    fake.emitCompleted({ tabId: other.id, frameId: 0, url: URL_B });
    await flush();
    assert.equal(otherWait.value, "ended");
    assert.equal(timers.pending(), before);
  });
});

describe("settled", { timeout: 10000 }, () => {
  it("resolves idle at once, with no timer, when nothing is under way", async () => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    const outcome = settledOutcome(navigations.settled(tab.id, 10_000));
    assert.equal(timers.pending(), 0);
    await flush();
    assert.equal(outcome.value, "idle");
    assert.equal(await navigations.settled(99, 10_000), "idle");
  });

  it("settles every wait of the tab at the navigation's end, leaving no timer", async () => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    const first = navigations.settled(tab.id, 10_000);
    const second = navigations.settled(tab.id, 3_000);
    assert.equal(timers.pending(), 2);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
    assert.equal(timers.pending(), 0);
    timers.advance(10_000);
    // A later navigation starts afresh.
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    const third = settledOutcome(navigations.settled(tab.id, 10_000));
    timers.advance(9_999);
    await flush();
    assert.equal(third.value, undefined);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    await flush();
    assert.equal(third.value, "ended");
    assert.equal(timers.pending(), 0);
  });

  it("times out at the bound while Firefox reports the tab loading, keeping the navigation", async () => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitStatus(tab.id, "loading");
    const short = settledOutcome(navigations.settled(tab.id, 1_000));
    const long = settledOutcome(navigations.settled(tab.id, 10_000));
    timers.advance(999);
    await flush();
    assert.equal(short.value, undefined);
    timers.advance(1);
    await flush();
    assert.equal(short.value, "timeout");
    assert.equal(long.value, undefined);
    assert.equal(navigations.underWay(tab.id), true);
    assert.equal(timers.pending(), 1);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B });
    await flush();
    assert.equal(long.value, "ready");
    assert.equal(timers.pending(), 0);
  });

  it("ends a navigation whose end it missed when Firefox reports the tab not loading", async () => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    const short = settledOutcome(navigations.settled(tab.id, 1_000));
    const long = settledOutcome(navigations.settled(tab.id, 10_000));
    timers.advance(1_000);
    await flush();
    assert.deepEqual([short.value, long.value], ["ended", "ended"]);
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(timers.pending(), 0);
    assert.equal(await navigations.settled(tab.id, 10_000), "idle");
  });

  it("reports removed when the tab is gone at the bound", async (t) => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    t.mock.method(fake.browser.tabs, "get", async () => {
      throw new Error("Invalid tab ID");
    });
    const short = settledOutcome(navigations.settled(tab.id, 1_000));
    const long = settledOutcome(navigations.settled(tab.id, 10_000));
    timers.advance(1_000);
    await flush();
    assert.deepEqual([short.value, long.value], ["removed", undefined]);
    assert.equal(timers.pending(), 1);
  });

  it("stops holding a committed document still parsing at the bound, asking nothing", async (t) => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    const get = t.mock.method(fake.browser.tabs, "get");
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    const short = settledOutcome(navigations.settled(tab.id, 1_000));
    // The swap's second start, then the commit: the wait armed while begun still ends at its bound.
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    const long = settledOutcome(navigations.settled(tab.id, 10_000));
    timers.advance(1_000);
    await flush();
    assert.deepEqual([short.value, long.value], ["committed", "committed"]);
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(timers.pending(), 0);
    assert.equal(await navigations.settled(tab.id, 10_000), "idle");
  });

  it("changes nothing when Firefox answers after the wait already ended", async (t) => {
    const { fake, navigations, timers } = setup();
    const tab = fake.openTab({ url: URL_A });
    const { promise: answer, resolve } = Promise.withResolvers<void>();
    const get = fake.browser.tabs.get;
    t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
      await answer;
      return get(tabId);
    });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    const outcome = settledOutcome(navigations.settled(tab.id, 1_000));
    timers.advance(1_000);
    await flush();
    assert.equal(outcome.value, undefined);
    // The navigation ends, and another begins, before Firefox answers that the tab is complete.
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    await flush();
    assert.equal(outcome.value, "ended");
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_A });
    resolve();
    await flush();
    assert.equal(outcome.value, "ended");
    assert.equal(navigations.underWay(tab.id), true);
    assert.equal(timers.pending(), 0);
  });
});

describe("navigations finished since a session's action", { timeout: 10000 }, () => {
  it("counts none for a session with no action in the tab, and makes no mark", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    load(fake, tab.id, URL_B);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("counts a navigation that began and finished after the action once", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    navigations.acted("s1", tab.id);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("does not count a navigation that began before the action and finished after it", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    navigations.acted("s1", tab.id);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("does not credit a page's completion to a later navigation that never committed", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 0, url: URL_B, documentId: "new" });
    navigations.acted("s1", tab.id);
    // A download: it begins, and brings no commit and no completion of its own.
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: `${URL_A}file.zip` });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    load(fake, tab.id, URL_A);
    assert.equal(navigations.takeFinished("s1", tab.id), true);
  });

  it("still counts a navigation that began before a take and finished after it", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    navigations.acted("s1", tab.id);
    load(fake, tab.id, URL_B);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_A });
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_A });
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("counts a History API change of the top frame, without counting it as begun", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    navigations.acted("s1", tab.id);
    fake.emitHistoryStateUpdated({ tabId: tab.id, frameId: 1, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    fake.emitHistoryStateUpdated({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.begun(tab.id), 0);
    assert.equal(navigations.underWay(tab.id), false);
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("does not count a frame's navigation or a completion of about:blank", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    load(fake, tab.id, URL_B);
    navigations.acted("s1", tab.id);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 1, url: URL_B });
    fake.emitCompleted({ tabId: tab.id, frameId: 1, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "about:blank" });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "about:blank" });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("still counts a load under way when a History API change during it was taken", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    navigations.acted("s1", tab.id);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_B });
    // The leaving page changes its address while the next one loads.
    fake.emitHistoryStateUpdated({ tabId: tab.id, frameId: 0, url: `${URL_A}?step=2` });
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("does not let a take lower the mark below a load that began before the action", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    load(fake, tab.id, URL_B);
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: URL_A });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    navigations.acted("s1", tab.id);
    fake.emitHistoryStateUpdated({ tabId: tab.id, frameId: 0, url: `${URL_A}?step=2` });
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: URL_A });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });

  it("keeps each session's mark apart", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    navigations.acted("s1", tab.id);
    navigations.acted("s2", tab.id);
    load(fake, tab.id, URL_B);
    assert.equal(navigations.takeFinished("s1", tab.id), true);
    assert.equal(navigations.takeFinished("s2", tab.id), true);
    load(fake, tab.id, URL_A);
    navigations.acted("s2", tab.id);
    assert.equal(navigations.takeFinished("s2", tab.id), false);
    assert.equal(navigations.takeFinished("s1", tab.id), true);
  });

  it("drops a closed tab's marks", () => {
    const { fake, navigations } = setup();
    const tab = fake.openTab({ url: URL_A });
    navigations.acted("s1", tab.id);
    fake.removeTab(tab.id);
    fake.emitHistoryStateUpdated({ tabId: tab.id, frameId: 0, url: URL_B });
    assert.equal(navigations.takeFinished("s1", tab.id), false);
  });
});

/** A top-frame navigation of the tab from its start to its completion. */
function load(fake: ReturnType<typeof createFakeBrowser>, tabId: number, url: string): void {
  fake.emitBeforeNavigate({ tabId, frameId: 0, url });
  fake.emitCommitted({ tabId, frameId: 0, url });
  fake.emitCompleted({ tabId, frameId: 0, url });
}

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const navigations = createTabNavigations({ browser: fake.browser, timers });
  return { fake, timers, navigations };
}

/** The outcome once the wait settles. */
function settledOutcome(wait: Promise<NavigationOutcome>): {
  value: NavigationOutcome | undefined;
} {
  const outcome: { value: NavigationOutcome | undefined } = { value: undefined };
  void wait.then((value) => {
    outcome.value = value;
  });
  return outcome;
}
