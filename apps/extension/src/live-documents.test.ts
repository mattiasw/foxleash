import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  createFakeBrowser,
  createFakeTimers,
  type FakeBrowser,
  type FakeTab,
  flush,
} from "./fake-browser.ts";
import {
  createLiveDocuments,
  type LiveDocument,
  type LiveDocumentsDeps,
} from "./live-documents.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite, TAG_MARK_KEY } from "./settings.ts";
import { siteOf } from "./site.ts";
import { createSiteAccess, type SessionMemory, type SiteAccess } from "./site-access.ts";

const SITE = "https://a.example";
const URL_A = `${SITE}/page`;
const OTHER = "https://b.example";
const URL_B = `${OTHER}/page`;

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
    assert.deepEqual(live, {
      session: "s1",
      site: SITE,
      groupId: fake.tabs.get(tab.id)?.groupId,
      startedBy: "commit",
    });
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
    // The gate reads storage after it read the tab's group; the tab leaves, unseen, while it waits.
    const get = t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      const stored = await Reflect.apply(read, fake.browser.storage.local, args);
      const shown = fake.tabs.get(tab.id);
      if (!moved && shown !== undefined) {
        moved = true;
        shown.groupId = -1;
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
    const { fake, documents, sessions, access, liveTab } = setup({});
    const replaced = await liveTab();
    fake.emitCommitted({ tabId: replaced.id, frameId: 0, url: "https://c.example/" });
    await flush();
    assert.equal(documents.live(replaced.id), undefined);
    const closed = await liveTab();
    fake.removeTab(closed.id);
    const withdrawn = await liveTab();
    sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    access.forget("s1", SITE);
    assert.equal(documents.live(withdrawn.id), undefined);
    await flush();
    assert.deepEqual(warned(), []);
  });

  it("stops at once the documents of a site the session's approval of ends, and only those", async () => {
    const { documents, sessions, access, liveTab } = setup({});
    sessions.set("s1", {
      allowed: new Set([SITE, "https://c.example"]),
      refused: new Set(),
      closed: 0,
    });
    const withdrawn = await liveTab();
    const otherSite = await liveTab("s1", "https://c.example/");
    const otherSession = await liveTab("s2");
    const others = [documents.live(otherSite.id), documents.live(otherSession.id)];
    access.forget("s1", SITE);
    assert.equal(documents.live(withdrawn.id), undefined);
    await flush();
    // A's stored approval still passes the gate: a new document starts, from the withdrawal on.
    assert.equal(documents.live(withdrawn.id)?.startedBy, "grant");
    assert.deepEqual([documents.live(otherSite.id), documents.live(otherSession.id)], others);
    assert.equal(documents.live(otherSite.id)?.startedBy, "commit");
  });

  it("stops at once every document of a session the user stops, whatever the site, and only those", async () => {
    const { documents, sessions, access, liveTab } = setup({});
    sessions.set("s1", { allowed: new Set(["https://c.example"]), refused: new Set(), closed: 0 });
    // A's site is stored as approved: allowed always.
    const always = await liveTab();
    const forSession = await liveTab("s1", "https://c.example/");
    const otherSession = await liveTab("s2");
    const other = documents.live(otherSession.id);
    access.stop("s1");
    assert.equal(documents.live(always.id), undefined);
    assert.equal(documents.live(forSession.id), undefined);
    await flush();
    assert.equal(documents.live(always.id), undefined);
    assert.equal(documents.live(forSession.id), undefined);
    assert.equal(documents.live(otherSession.id), other);
    assert.equal(other?.startedBy, "commit");
  });

  it("makes nothing live from a commit's check a stop came during", async (t) => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return true;
      },
    });
    const tab = await tabIn();
    const release = holdView(t, access);
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    access.stop("s1");
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(decided, [undefined]);
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

describe("catching up with a document a tab already shows", { timeout: 10000 }, () => {
  it("makes it live when the session is allowed its site, for that session only", async () => {
    const decided: [number, LiveDocument | undefined, string | undefined][] = [];
    const { fake, documents, access, sessions, tabIn } = setup({
      onDecided: (tabId, live, documentId) => {
        decided.push([tabId, live, documentId]);
        return true;
      },
    });
    const tab = await unrecorded(fake, tabIn);
    const other = await unrecorded(fake, tabIn, "s2");
    // Allowed without a grant: only a catch-up of its own session's tabs would start it.
    const otherSession = await tabIn("s2");
    fake.navigateByUser(otherSession.id, "https://c.example/");
    await flush();
    sessions.set("s2", { allowed: new Set(["https://c.example"]), refused: new Set(), closed: 0 });
    decided.length = 0;
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    const live = documents.live(tab.id);
    assert.deepEqual(live, {
      session: "s1",
      site: OTHER,
      groupId: fake.tabs.get(tab.id)?.groupId,
      startedBy: "grant",
    });
    assert.deepEqual(decided, [[tab.id, live, `document-${tab.id}-0`]]);
    assert.equal(documents.live(other.id), undefined);
    assert.equal(documents.live(otherSession.id), undefined);
  });

  it("makes it live in every session when the site is stored as approved", async () => {
    const { fake, documents, tabIn } = setup({});
    const tab = await unrecorded(fake, tabIn);
    const other = await unrecorded(fake, tabIn, "s2");
    const loose = fake.openTab({ url: URL_B });
    await grantSite(fake.browser, OTHER);
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    assert.equal(documents.live(other.id)?.session, "s2");
    assert.equal(documents.live(loose.id), undefined);
  });

  it("makes it live when its tab joins the group of a session allowed its site", async () => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, tabIn } = setup({
      onDecided: (_tabId, live, documentId) => {
        decided.push(`${live?.startedBy} ${documentId}`);
        return true;
      },
    });
    const keeper = await tabIn();
    const groupId = groupIdOf(fake, keeper.id);
    const tab = fake.openTab({ url: URL_A });
    fake.setFrames(tab.id, [{ frameId: 0, url: URL_A, documentId: "doc-a" }]);
    await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    await flush();
    assert.deepEqual(documents.live(tab.id), {
      session: "s1",
      site: SITE,
      groupId,
      startedBy: "grant",
    });
    assert.deepEqual(decided, ["grant doc-a"]);
  });

  it("sees a join from the tab's group alone, once per change of group", async () => {
    let decided = 0;
    const { fake, documents, tabIn } = setup({
      onDecided: () => {
        decided += 1;
        return false;
      },
    });
    const keeper = await tabIn();
    const groupId = groupIdOf(fake, keeper.id);
    const tab = fake.openTab({ url: URL_A });
    fake.emitStatus(tab.id, "loading");
    await flush();
    assert.equal(decided, 0);
    const shown = fake.tabs.get(tab.id);
    assert.ok(shown !== undefined);
    shown.groupId = groupId;
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(decided, 1);
    // Refused by onDecided: neither the next update in that group nor the refusal tries again.
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(decided, 1);
    assert.equal(documents.live(tab.id), undefined);
  });

  it("makes nothing live where the gate refuses, and logs no refusal", async (t) => {
    const warned = quiet(t);
    let decided = 0;
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        if (live !== undefined) decided += 1;
        return true;
      },
    });
    await fake.browser.storage.local.set({ blocklist: ["blocked.example"] });
    await grantSite(fake.browser, "https://blocked.example");
    const blocked = await tabIn();
    fake.navigateByUser(blocked.id, "https://blocked.example/");
    const elsewhere = await tabIn();
    fake.navigateByUser(elsewhere.id, "https://c.example/");
    const blank = await tabIn();
    const loose = fake.openTab({ url: URL_B });
    const userGroup = fake.openTab({ url: URL_B });
    await fake.browser.tabs.group({ tabIds: [userGroup.id] });
    const discarded = await unrecorded(fake, tabIn);
    fake.setFrames(discarded.id, null);
    const frameOnly = await unrecorded(fake, tabIn);
    fake.setFrames(frameOnly.id, [1]);
    const noUrl = await unrecorded(fake, tabIn);
    fake.setFrames(noUrl.id, [{ frameId: 0, documentId: "doc" }]);
    const prompt = await unrecorded(fake, tabIn);
    await access.ask("s1", "https://d.example/", prompt.id, {
      generation: access.generation("s1"),
    });
    fake.setFrames(prompt.id, [{ frameId: 0, url: URL_B, documentId: "doc" }]);
    await flush();
    warned().length = 0;
    await access.allowForSession("s1", [OTHER], () => true);
    await fake.browser.storage.local.set({ "site:https://e.example": true });
    await flush();
    for (const tab of [blocked, elsewhere, blank, loose, userGroup, discarded, frameOnly, noUrl]) {
      assert.equal(documents.live(tab.id), undefined, String(tab.id));
    }
    assert.equal(documents.live(prompt.id), undefined);
    assert.equal(decided, 0);
    assert.deepEqual(
      warned().filter((fields) => fields.event === "test_failed"),
      [],
    );
  });

  it("leaves a live document as it is", async () => {
    let decided = 0;
    const { fake, documents, access, tabIn } = setup({
      onDecided: () => {
        decided += 1;
        return true;
      },
    });
    const tab = await tabIn();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    const live = documents.live(tab.id);
    assert.equal(live?.startedBy, "commit");
    await access.allowForSession("s1", [OTHER], () => true);
    await grantSite(fake.browser, "https://c.example");
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(documents.live(tab.id), live);
    assert.equal(decided, 1);
  });

  it("gives a new document at each new approval after a withdrawal", async () => {
    const { fake, documents, access, tabIn } = setup({});
    const tab = await unrecorded(fake, tabIn);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    const first = documents.live(tab.id);
    assert.equal(first?.startedBy, "grant");
    access.forget("s1", OTHER);
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    const second = documents.live(tab.id);
    assert.equal(second?.startedBy, "grant");
    assert.notEqual(second, first);
  });

  it("lets a commit during the catch-up win", async (t) => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return true;
      },
    });
    const tab = await unrecorded(fake, tabIn);
    decided.length = 0;
    const release = holdFrames(t, fake, tab.id);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    release();
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "commit");
    assert.deepEqual(decided, ["commit"]);
  });

  it("restarts at a withdrawal, so no gate answer read before it makes a document live", async (t) => {
    const warned = quiet(t);
    const decided: (LiveDocument | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live);
        return true;
      },
    });
    const tab = await unrecorded(fake, tabIn);
    decided.length = 0;
    const release = holdView(t, access);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    access.forget("s1", OTHER);
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(decided, []);
    assert.deepEqual(warned(), []);
  });

  it("restarts at a storage change, so no gate answer read before it makes a document live", async (t) => {
    const warned = quiet(t);
    const decided: (LiveDocument | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live);
        return true;
      },
    });
    const tab = await unrecorded(fake, tabIn);
    decided.length = 0;
    const release = holdView(t, access);
    await grantSite(fake.browser, OTHER);
    await flush();
    await revokeSite(fake.browser, OTHER);
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(decided, []);
    assert.deepEqual(warned(), []);
  });

  it("restarts when the tab moves to another group during the catch-up", async (t) => {
    const warned = quiet(t);
    const decided: (LiveDocument | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live);
        return true;
      },
    });
    const tab = await unrecorded(fake, tabIn);
    await tabIn("s2");
    decided.length = 0;
    const release = holdFrames(t, fake, tab.id);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    fake.ungroup(tab.id);
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(decided, []);
    assert.deepEqual(warned(), []);
  });

  it("restarts when the tab shows another site during the catch-up, not for the same site", async (t) => {
    const { fake, documents, access, tabIn } = setup({});
    const tab = await unrecorded(fake, tabIn);
    const release = holdView(t, access);
    const frames = t.mock.method(fake.browser.webNavigation, "getAllFrames");
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    fake.pushState(tab.id, `${OTHER}/elsewhere`);
    await flush();
    assert.equal(frames.mock.callCount(), 1);
    // A's site, stored as approved, as a page restored from memory shows it.
    fake.pushState(tab.id, URL_A);
    release();
    await flush();
    assert.equal(frames.mock.callCount(), 2);
    assert.equal(documents.live(tab.id)?.site, SITE);
  });

  it("makes nothing live in a tab that closes during the catch-up, and logs nothing", async (t) => {
    const warned = quiet(t);
    const decided: (LiveDocument | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live);
        return true;
      },
    });
    // Never committed while the background listened, as a tab open since before it started.
    const keeper = await tabIn();
    const tab = fake.openTab({ url: URL_B });
    await fake.browser.tabs.group({ groupId: groupIdOf(fake, keeper.id), tabIds: [tab.id] });
    await flush();
    decided.length = 0;
    const release = holdFrames(t, fake, tab.id);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    fake.removeTab(tab.id);
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(decided, []);
    assert.deepEqual(warned(), []);
  });

  it("logs a failure to read the tab or the tabs as the check's failure", async (t) => {
    const warned = quiet(t);
    const { fake, documents, access, tabIn } = setup({});
    const tab = await unrecorded(fake, tabIn);
    const frames = t.mock.method(fake.browser.webNavigation, "getAllFrames", async () => {
      throw new Error("No frames");
    });
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    frames.mock.restore();
    t.mock.method(fake.browser.tabs, "query", async () => {
      throw new Error("No tabs");
    });
    await access.allowForSession("s1", ["https://c.example"], () => true);
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(warned(), [
      { event: "test_failed", tabId: tab.id, error: "Error: No frames" },
      { event: "test_failed", error: "Error: No tabs" },
    ]);
  });

  it("gives one document to an approval and a join that arrive together", async () => {
    let decided = 0;
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        if (live !== undefined) decided += 1;
        return true;
      },
    });
    const keeper = await tabIn();
    const groupId = groupIdOf(fake, keeper.id);
    const tab = fake.openTab({ url: URL_B });
    const joined = fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    const allowed = access.allowForSession("s1", [OTHER], () => true);
    await Promise.all([joined, allowed]);
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    assert.equal(decided, 1);
  });

  it("gives the tab that moves to another session's group that session's document", async () => {
    const { fake, documents, tabIn } = setup({});
    const tab = await tabIn();
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    const other = await tabIn("s2");
    const groupId = groupIdOf(fake, other.id);
    await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    await flush();
    assert.deepEqual(documents.live(tab.id), {
      session: "s2",
      site: SITE,
      groupId,
      startedBy: "grant",
    });
  });

  it("gives that session's document also when the move lands while the commit is checked", async (t) => {
    quiet(t);
    const { fake, documents, tabIn } = setup({});
    const tab = await tabIn();
    const other = await tabIn("s2");
    const groupId = groupIdOf(fake, other.id);
    const read = fake.browser.storage.local.get;
    let moved = false;
    // The gate reads storage after it read the tab's group; the tab moves while it waits.
    t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      const stored = await Reflect.apply(read, fake.browser.storage.local, args);
      if (!moved) {
        moved = true;
        await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
      }
      return stored;
    });
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.deepEqual(documents.live(tab.id), {
      session: "s2",
      site: SITE,
      groupId,
      startedBy: "grant",
    });
  });

  it("makes it live once an undecided commit's gate ran before the approval", async (t) => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return true;
      },
    });
    const tab = await tabIn();
    const release = holdView(t, access);
    fake.navigateByUser(tab.id, URL_B);
    await flush();
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    assert.deepEqual(decided, []);
    release();
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    assert.deepEqual(decided, [undefined, "grant"]);
  });

  it("makes nothing live from a commit's check an approval came during, then catches up", async (t) => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return true;
      },
    });
    const tab = await tabIn();
    const held = Promise.withResolvers<void>();
    const read = fake.browser.storage.local.get;
    let first = true;
    t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      if (first) {
        first = false;
        await held.promise;
      }
      return Reflect.apply(read, fake.browser.storage.local, args);
    });
    // Before any catch-up could list the tabs.
    const query = t.mock.method(fake.browser.tabs, "query", () => new Promise(() => {}));
    fake.navigateByUser(tab.id, URL_B);
    await flush();
    await access.allowForSession("s1", [OTHER], () => true);
    held.resolve();
    await flush();
    assert.ok(query.mock.callCount() > 0);
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    assert.deepEqual(decided, [undefined, "grant"]);
  });

  it("makes nothing live from a commit's check stored access changed during, then catches up", async (t) => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return true;
      },
    });
    const tab = await tabIn();
    const held = Promise.withResolvers<void>();
    const read = fake.browser.storage.local.get;
    let first = true;
    t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      if (first) {
        first = false;
        await held.promise;
      }
      return Reflect.apply(read, fake.browser.storage.local, args);
    });
    t.mock.method(fake.browser.tabs, "query", () => new Promise(() => {}));
    fake.navigateByUser(tab.id, URL_B);
    await flush();
    await grantSite(fake.browser, OTHER);
    held.resolve();
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    assert.deepEqual(decided, [undefined, "grant"]);
  });

  it("makes nothing live from a gate answer read before a withdrawal during the check", async (t) => {
    const decided: (string | undefined)[] = [];
    const { fake, documents, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return true;
      },
    });
    const tab = await tabIn();
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    const release = holdView(t, access);
    fake.navigateByUser(tab.id, URL_B);
    await flush();
    access.forget("s1", OTHER);
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(decided, [undefined]);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    assert.deepEqual(decided, [undefined, "grant"]);
  });

  it("lets an undecided commit's onDecided end before the catch-up it held back starts", async (t) => {
    const decided: (string | undefined)[] = [];
    const held = Promise.withResolvers<boolean>();
    const { fake, access, tabIn } = setup({
      onDecided: (_tabId, live) => {
        decided.push(live?.startedBy);
        return live === undefined ? held.promise : true;
      },
    });
    const tab = await tabIn();
    const release = holdView(t, access);
    fake.navigateByUser(tab.id, URL_B);
    await flush();
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    const frames = t.mock.method(fake.browser.webNavigation, "getAllFrames");
    release();
    await flush();
    assert.deepEqual(decided, [undefined]);
    assert.equal(frames.mock.callCount(), 0);
    held.resolve(true);
    await flush();
    assert.deepEqual(decided, [undefined, "grant"]);
  });

  it("drops a caught-up document whose tab left the group unseen while the gate ran", async (t) => {
    const warned = quiet(t);
    const { fake, documents, access, tabIn } = setup({});
    const tab = await unrecorded(fake, tabIn);
    const release = holdView(t, access);
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    const shown = fake.tabs.get(tab.id);
    assert.ok(shown !== undefined);
    shown.groupId = -1;
    release();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
    assert.deepEqual(warned(), [{ event: "test_failed", tabId: tab.id, reason: "group" }]);
  });

  it("forgets a catch-up a newer commit made moot", async (t) => {
    const { fake, documents, access, tabIn } = setup({});
    const tab = await tabIn();
    // Held at a commit's gate: the approval arrives while that commit is undecided.
    const release = holdView(t, access);
    fake.navigateByUser(tab.id, URL_B);
    await flush();
    await access.allowForSession("s1", ["https://c.example"], () => true);
    await flush();
    let frames = 0;
    const getAllFrames = fake.browser.webNavigation.getAllFrames;
    const held = Promise.withResolvers<void>();
    t.mock.method(
      fake.browser.webNavigation,
      "getAllFrames",
      async (details: { tabId: number }) => {
        frames += 1;
        if (frames === 1) await held.promise;
        return getAllFrames(details);
      },
    );
    fake.navigateByUser(tab.id, "https://d.example/");
    release();
    await flush();
    // The newer commit's own check read access as it is: nothing caught up after it.
    assert.equal(frames, 0);

    // A catch-up under way when a commit comes is not restarted by a later withdrawal.
    await access.allowForSession("s1", ["https://e.example"], () => true);
    await flush();
    assert.equal(frames, 1);
    fake.navigateByUser(tab.id, "https://f.example/");
    await flush();
    access.forget("s1", "https://c.example");
    await flush();
    assert.equal(frames, 1);
    held.resolve();
    await flush();
    assert.equal(documents.live(tab.id), undefined);
  });

  it("sees a tab again by its group once it closed, if its id comes back", async () => {
    const { fake, documents, tabIn } = setup({});
    const keeper = await tabIn();
    const groupId = groupIdOf(fake, keeper.id);
    const tab = fake.openTab({ url: URL_A });
    await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
    const shown = fake.tabs.get(tab.id);
    assert.ok(shown !== undefined);
    fake.removeTab(tab.id);
    // The same tab id again, as a test can make it.
    fake.tabs.set(tab.id, { ...shown, groupId });
    fake.emitStatus(tab.id, "complete");
    await flush();
    assert.equal(documents.live(tab.id)?.startedBy, "grant");
  });
});

/** The tab's group, -1 for none. */
function groupIdOf(fake: FakeBrowser, tabId: number): number {
  const tab = fake.tabs.get(tabId);
  assert.ok(tab !== undefined);
  return tab.groupId;
}

/** A tab in the session's group showing B's page, which the session may not act on yet. */
async function unrecorded(
  fake: FakeBrowser,
  tabIn: (session?: string) => Promise<FakeTab>,
  session = "s1",
): Promise<FakeTab> {
  const tab = await tabIn(session);
  fake.navigateByUser(tab.id, URL_B);
  await flush();
  return tab;
}

/** Makes the next `webNavigation.getAllFrames` of the tab wait for the returned release. */
function holdFrames(t: TestContext, fake: FakeBrowser, tabId: number): () => void {
  const held = Promise.withResolvers<void>();
  const getAllFrames = fake.browser.webNavigation.getAllFrames;
  let first = true;
  t.mock.method(fake.browser.webNavigation, "getAllFrames", async (details: { tabId: number }) => {
    if (first && details.tabId === tabId) {
      first = false;
      await held.promise;
    }
    return getAllFrames(details);
  });
  return () => held.resolve();
}

/**
 * Makes the next gate read wait for the returned release, and answer then for A's and B's pages
 * as access stood when it read it.
 */
function holdView(t: TestContext, access: SiteAccess): () => void {
  const held = Promise.withResolvers<void>();
  const view = access.view;
  let first = true;
  t.mock.method(access, "view", async (session: string) => {
    const current = await view(session);
    if (!first) return current;
    first = false;
    const read = new Map([URL_A, URL_B].map((url) => [siteOf(url), current.allowed(url)]));
    await held.promise;
    return { ...current, allowed: (url: string) => read.get(siteOf(url)) ?? false };
  });
  return () => held.resolve();
}

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

  /** A blank tab in the session's group, with A's site stored as approved. */
  async function tabIn(session = "s1"): Promise<FakeTab> {
    await grantSite(fake.browser, SITE);
    const tab = fake.openTab();
    await groups.ensureGroup(session, tab);
    return tab;
  }

  /** A tab in the session's group with a live document on `url`, A's page by default. */
  async function liveTab(session = "s1", url = URL_A): Promise<FakeTab> {
    const tab = await tabIn(session);
    fake.navigateByUser(tab.id, url);
    await flush();
    assert.ok(documents.live(tab.id) !== undefined);
    return tab;
  }

  return { fake, documents, sessions, access, tabIn, liveTab };
}

/** Keeps the log lines out of the test output; returns a reader for them. */
function quiet(t: TestContext): () => Record<string, unknown>[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}
