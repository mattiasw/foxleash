import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createFakeBrowser, createFakeTimers, type FakeTab, flush } from "./fake-browser.ts";
import {
  createLiveDocuments,
  type LiveDocument,
  type LiveDocumentsDeps,
} from "./live-documents.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite, TAG_MARK_KEY } from "./settings.ts";
import { createSiteAccess, type SessionMemory } from "./site-access.ts";

const SITE = "https://a.example";
const URL_A = `${SITE}/page`;

describe("live documents", { timeout: 10000 }, () => {
  it("runs onCommit at a top-frame commit with its time, before the commit is checked", async (t) => {
    const events: string[] = [];
    const { fake, documents, tabIn } = setup({
      onCommit: (tabId, url, timeStamp) => {
        events.push(`commit ${tabId} ${url} ${timeStamp} ${documents.live(tabId) === undefined}`);
      },
    });
    const tab = await tabIn();
    const get = fake.browser.tabs.get;
    t.mock.method(fake.browser.tabs, "get", (tabId: number) => {
      events.push(`get ${tabId}`);
      return get(tabId);
    });
    fake.emitCommitted({ tabId: tab.id, frameId: 2, url: `${SITE}/frame`, timeStamp: 1000 });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, timeStamp: 1001 });
    events.push("returned");
    await flush();
    fake.navigateByUser(tab.id, `${SITE}/next`);
    assert.deepEqual(events.slice(0, 3), [
      `commit ${tab.id} ${URL_A} 1001 true`,
      `get ${tab.id}`,
      "returned",
    ]);
    assert.equal(events[events.length - 2], `commit ${tab.id} ${SITE}/next 1002 true`);
  });

  it("gives onDecided the live document, or undefined for a refused commit", async (t) => {
    t.mock.method(console, "warn", () => {});
    const decided: [number, LiveDocument | undefined][] = [];
    const { fake, documents, tabIn } = setup({
      onDecided: (tabId, live) => {
        decided.push([tabId, live]);
        return true;
      },
    });
    const tab = await tabIn();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    const live = documents.live(tab.id);
    assert.ok(live !== undefined);
    assert.deepEqual(live, { session: "s1", site: SITE, groupId: fake.tabs.get(tab.id)?.groupId });
    const loose = fake.openTab();
    fake.navigateByUser(loose.id, URL_A);
    fake.navigateByUser(tab.id, "https://c.example/");
    fake.emitCommitted({ tabId: 999, frameId: 0, url: URL_A });
    await flush();
    assert.equal(decided[0]?.[1], live);
    // The checks end in any order; for one tab, in commit order.
    assert.deepEqual(
      decided.toSorted(([a], [b]) => a - b),
      [
        [tab.id, live],
        [tab.id, undefined],
        [loose.id, undefined],
        [999, undefined],
      ],
    );
  });

  it("gives onDecided the commit's documentId, when it has one", async (t) => {
    quiet(t);
    const decided: [number, string | undefined, string | undefined][] = [];
    const { fake, tabIn } = setup({
      onDecided: (tabId, live, documentId) => {
        decided.push([tabId, live?.site, documentId]);
        return true;
      },
    });
    const tab = await tabIn();
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-1" });
    await flush();
    fake.emitCommitted({
      tabId: tab.id,
      frameId: 0,
      url: "https://c.example/",
      documentId: "doc-2",
    });
    await flush();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.deepEqual(decided, [
      [tab.id, SITE, "doc-1"],
      [tab.id, undefined, "doc-2"],
      [tab.id, SITE, undefined],
    ]);
  });

  it("logs a drop by an update or a detach once, with its reason and at most the site", async (t) => {
    const warned = quiet(t);
    const { fake, documents, liveTab } = setup({});
    const ungrouped = await liveTab();
    fake.ungroup(ungrouped.id);
    fake.ungroup(ungrouped.id);
    const moved = await liveTab();
    fake.pushState(moved.id, "https://b.example/secret?q=1");
    fake.pushState(moved.id, "https://c.example/");
    const blank = await liveTab();
    fake.pushState(blank.id, "about:blank");
    const detached = await liveTab();
    fake.emitDetached(detached.id);
    fake.emitDetached(detached.id);
    for (const tab of [ungrouped, moved, blank, detached]) {
      assert.equal(documents.live(tab.id), undefined);
    }
    assert.deepEqual(warned(), [
      { event: "test_failed", tabId: ungrouped.id, reason: "group" },
      { event: "test_failed", tabId: moved.id, reason: "site", site: "https://b.example" },
      { event: "test_failed", tabId: blank.id, reason: "site", site: "about:blank" },
      { event: "test_failed", tabId: detached.id, reason: "detached" },
    ]);
    assert.doesNotMatch(JSON.stringify(warned()), /secret/);
  });

  it("logs a drop by a recheck with its reason, only when it drops", async (t) => {
    const warned = quiet(t);
    const { fake, documents, liveTab, tabIn } = setup({});
    const tab = await tabIn();
    const read = fake.browser.storage.local.get;
    let moved = false;
    // The gate reads storage after it read the tab's group; the tab leaves while it waits.
    const get = t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      const stored = await Reflect.apply(read, fake.browser.storage.local, args);
      if (!moved) {
        moved = true;
        fake.ungroup(tab.id);
      }
      return stored;
    });
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    get.mock.restore();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(warned(), [{ event: "test_failed", tabId: tab.id, reason: "group" }]);

    // A recheck of a document an update already dropped.
    const gone = await liveTab();
    fake.emitStorageChanged("local");
    fake.ungroup(gone.id);
    await flush();
    assert.deepEqual(warned().slice(1), [
      { event: "test_failed", tabId: gone.id, reason: "group" },
    ]);

    const revoked = await liveTab();
    await revokeSite(fake.browser, SITE);
    await flush();
    assert.equal(documents.live(revoked.id), undefined);
    assert.deepEqual(warned().slice(2), [
      { event: "test_failed", tabId: revoked.id, reason: "refused", code: "site_not_approved" },
    ]);
  });

  it("rechecks nothing at a change of recipes only, and rechecks at a mixed change", async (t) => {
    const warned = quiet(t);
    const { fake, documents, liveTab } = setup({});
    const tab = await liveTab();
    const get = t.mock.method(fake.browser.storage.local, "get");
    await fake.browser.storage.local.set({ "recipe:a": {}, "recipe:b": {} });
    await fake.browser.storage.local.remove("recipe:a");
    await flush();
    assert.equal(get.mock.callCount(), 0);
    assert.ok(documents.live(tab.id) !== undefined);

    await fake.browser.storage.local.set({ "recipe:c": {}, [`site:${SITE}`]: null });
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(warned(), [
      { event: "ignored_setting", key: `site:${SITE}` },
      { event: "test_failed", tabId: tab.id, reason: "refused", code: "site_not_approved" },
    ]);
  });

  it("rechecks nothing at a change of the tag mark, and rechecks when a site key changes too", async (t) => {
    const warned = quiet(t);
    const { fake, documents, liveTab } = setup({});
    const tab = await liveTab();
    const get = t.mock.method(fake.browser.storage.local, "get");
    await fake.browser.storage.local.set({ [TAG_MARK_KEY]: 100 });
    await fake.browser.storage.local.set({ [TAG_MARK_KEY]: 200, "recipe:a": {} });
    await flush();
    assert.equal(get.mock.callCount(), 0);
    assert.ok(documents.live(tab.id) !== undefined);

    await fake.browser.storage.local.set({ [TAG_MARK_KEY]: 300, [`site:${SITE}`]: null });
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(warned(), [
      { event: "ignored_setting", key: `site:${SITE}` },
      { event: "test_failed", tabId: tab.id, reason: "refused", code: "site_not_approved" },
    ]);
  });

  it("logs no drop at a new commit, a close or a withdrawal", async (t) => {
    const warned = quiet(t);
    const { fake, documents, liveTab } = setup({});
    const replaced = await liveTab();
    fake.emitCommitted({ tabId: replaced.id, frameId: 0, url: "https://c.example/" });
    await flush();
    assert.equal(documents.live(replaced.id), undefined);
    const closed = await liveTab();
    fake.removeTab(closed.id);
    const withdrawn = await liveTab();
    documents.withdraw("s1", SITE);
    assert.equal(documents.live(withdrawn.id), undefined);
    await flush();
    assert.deepEqual(warned(), []);
  });

  it("does not call onDecided for a commit that is no longer the tab's latest", async (t) => {
    quiet(t);
    const decided: [number, string | undefined][] = [];
    const { fake, tabIn } = setup({
      onDecided: (tabId, live) => {
        decided.push([tabId, live?.site]);
        return true;
      },
    });
    const tab = await tabIn();
    fake.navigateByUser(tab.id, "https://c.example/");
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.deepEqual(decided, [[tab.id, SITE]]);
    const closed = await tabIn();
    fake.navigateByUser(closed.id, URL_A);
    fake.removeTab(closed.id);
    fake.navigateByUser(tab.id, "https://c.example/");
    fake.removeTab(tab.id);
    await flush();
    assert.deepEqual(decided, [[tab.id, SITE]]);
  });

  it("keeps a newer document live when an older one's onDecided fails late", async (t) => {
    const warned = t.mock.method(console, "warn", () => {});
    const answers: PromiseWithResolvers<boolean>[] = [];
    const { fake, documents, tabIn } = setup({
      onDecided: (_tabId, live) => {
        if (live === undefined) return true;
        const answer = Promise.withResolvers<boolean>();
        answers.push(answer);
        return answer.promise;
      },
    });
    const tab = await tabIn();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    const newer = documents.live(tab.id);
    assert.ok(newer !== undefined);
    answers[0]?.resolve(false);
    await flush();
    assert.equal(documents.live(tab.id), newer);
    fake.navigateByUser(tab.id, `${SITE}/third`);
    await flush();
    const third = documents.live(tab.id);
    answers[1]?.reject(new Error("late"));
    await flush();
    assert.equal(documents.live(tab.id), third);
    assert.equal(warned.mock.callCount(), 1);
  });

  it("ends the latest document when its onDecided gives false or rejects", async (t) => {
    const warned = t.mock.method(console, "warn", () => {});
    const answers: (() => Promise<boolean>)[] = [
      async () => false,
      async () => {
        throw new Error("no recorder");
      },
      () => {
        throw new Error("thrown");
      },
      async () => true,
    ];
    const { fake, documents, tabIn } = setup({
      onDecided: (_tabId, live) => (live === undefined ? true : (answers.shift()?.() ?? true)),
    });
    const tab = await tabIn();
    for (const path of ["/false", "/rejects", "/throws"]) {
      fake.navigateByUser(tab.id, `${SITE}${path}`);
      await flush();
      assert.equal(documents.live(tab.id), undefined, path);
    }
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.ok(documents.live(tab.id) !== undefined);
    assert.deepEqual(
      warned.mock.calls.map((call) => JSON.parse(String(call.arguments[0]))),
      [
        { event: "test_failed", tabId: tab.id, error: "Error: no recorder" },
        { event: "test_failed", tabId: tab.id, error: "Error: thrown" },
      ],
    );
  });
});

function setup(hooks: Pick<LiveDocumentsDeps, "onCommit" | "onDecided">) {
  const fake = createFakeBrowser();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({
    browser: fake.browser,
    groups,
    sessions,
    timers: createFakeTimers(),
  });
  const documents = createLiveDocuments({
    browser: fake.browser,
    groups,
    access,
    failure: "test_failed",
    ...hooks,
  });

  /** A blank tab in s1's group, with A's site stored as approved. */
  async function tabIn(): Promise<FakeTab> {
    await grantSite(fake.browser, SITE);
    const tab = fake.openTab();
    await groups.ensureGroup("s1", tab);
    return tab;
  }

  /** A tab in s1's group with a live document on A's site. */
  async function liveTab(): Promise<FakeTab> {
    const tab = await tabIn();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.ok(documents.live(tab.id) !== undefined);
    return tab;
  }

  return { fake, documents, tabIn, liveTab };
}

/** Keeps the log lines out of the test output; returns a reader for them. */
function quiet(t: TestContext): () => Record<string, unknown>[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}
