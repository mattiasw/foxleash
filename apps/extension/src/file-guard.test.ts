import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type {
  BrowserApi,
  HeadersReceivedDetails,
  HttpHeader,
  RequestDetails,
} from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakeBrowser,
  type FakeTab,
  flush,
} from "./fake-browser.ts";
import {
  createFileGuard,
  DOCUMENT_AGE_MS,
  type FileGuard,
  HOP_AGE_MS,
  HOP_GRACE_MS,
  MAX_GONE_TABS,
  MAX_REFUSAL_TABS,
  MAX_REFUSALS,
  MAX_TAB_HOPS,
  MAX_TAB_SITES,
} from "./file-guard.ts";
import { createSessionGroups, MAX_REMEMBERED_GROUPS } from "./session-groups.ts";
import { grantSite, revokeSite, SESSION_GROUPS_KEY, saveBlocklist } from "./settings.ts";
import { createSiteAccess, type SessionMemory, type SiteAccess } from "./site-access.ts";

/** Stored as approved by `tabIn`. */
const A = "https://a.example";
/** Never approved unless a test does it. */
const B = "https://b.example";
/** A third site, never approved. */
const C = "https://c.example";
/** A Blob that a page of B built. */
const BLOB = `blob:${B}/0b2c5d1e`;
const HTML: HttpHeader[] = [{ name: "Content-Type", value: "text/html" }];
const ATTACHMENT: HttpHeader[] = [
  { name: "Content-Type", value: "text/csv" },
  { name: "Content-Disposition", value: 'attachment; filename="export.csv"' },
];
const LOCATION: HttpHeader = { name: "Location", value: `${B}/next` };
/** The guard's listener for the responses, as it registers it. */
const REGISTRATION = {
  event: "onHeadersReceived",
  filter: { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
  extraInfoSpec: ["blocking", "responseHeaders"],
};
/** Every webRequest listener the guard registers, in order; only the first blocks. */
const REGISTRATIONS = [
  REGISTRATION,
  ...["onBeforeRequest", "onCompleted", "onErrorOccurred"].map((event) => ({
    event,
    filter: { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
  })),
];

describe("the file guard's listener", { timeout: 10000 }, () => {
  it("is added when the first session starts running, once, and stays", async () => {
    const { fake, access, groups, tabIn } = setup();
    assert.deepEqual(fake.webRequestRegistrations, []);
    await tabIn("s1");
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
    await tabIn("s2");
    access.endSession("s1");
    await groups.endSession("s1");
    access.endSession("s2");
    await groups.endSession("s2");
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
    assert.deepEqual(fake.activeWebRequestRegistrations(), REGISTRATIONS);
    // A session that runs again adds no second one.
    access.admit("s1");
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
  });

  it("hears of the tabs that tabs open from the first running session on, once", async () => {
    const { fake, tabIn } = setup();
    assert.equal(fake.createdNavigationTargetListenerCount(), 0);
    await tabIn("s1");
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    await tabIn("s2");
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
  });

  it("hears no response before a session ran", () => {
    const { fake } = setup();
    const tab = fake.openTab({ url: `${A}/page` });
    assert.deepEqual(fake.emitWebRequest("onHeadersReceived", response({ tabId: tab.id })), []);
  });
});

describe("the file guard after a restart, an update or a reload", { timeout: 10000 }, () => {
  it("listens at once when a tab of a group made for a session is open", async () => {
    const { fake } = await leftBehind();
    assert.deepEqual(fake.webRequestRegistrations, []);
    assert.equal(fake.createdNavigationTargetListenerCount(), 0);
    restart(fake);
    await flush();
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
  });

  it("listens only once a tab is created in such a group", async () => {
    const { fake, left } = await leftBehind();
    fake.removeTab(left.id);
    restart(fake);
    await flush();
    fake.openTab({ url: `${A}/page` });
    fake.openTab({ url: `${A}/page`, groupId: 4242 });
    await flush();
    assert.deepEqual(fake.webRequestRegistrations, []);
    assert.equal(fake.createdNavigationTargetListenerCount(), 0);
    // The user opens the saved group again: Firefox keeps its id.
    fake.openTab({ url: `${A}/page`, groupId: left.groupId });
    await flush();
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
  });

  it("listens only once a tab is moved into such a group", async () => {
    const { fake, left } = await leftBehind();
    const groupId = left.groupId;
    fake.ungroup(left.id);
    restart(fake);
    await flush();
    await fake.browser.tabs.group({ tabIds: [left.id] });
    fake.emitStatus(left.id, "loading");
    await flush();
    assert.deepEqual(fake.webRequestRegistrations, []);
    fake.groups.set(groupId, { id: groupId, windowId: left.windowId });
    await fake.browser.tabs.group({ groupId, tabIds: [left.id] });
    await flush();
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
  });

  it("judges a tab left in such a group by the sites allowed always", async () => {
    const { fake, left } = await leftBehind();
    const { access, sessions, guard } = restart(fake);
    await flush();
    assert.equal(await verdict(respondOnce(fake, { tabId: left.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(left.id, 0), [B]);
    assert.equal(
      await verdict(respondOnce(fake, { tabId: left.id, url: `${A}/export` })),
      "passed",
    );
    // The session reconnects with its id: its new answers count, as for any session.
    access.admit("old");
    sessions.set("old", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respondOnce(fake, { tabId: left.id })), "passed");
  });

  it("listens once a tab event shows such a group when the open tabs cannot be read", async (t) => {
    const warned = warnings(t);
    const { fake, left } = await leftBehind();
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", collect);
    try {
      restart(fake, {
        ...fake.browser,
        tabs: {
          ...fake.browser.tabs,
          query: async () => {
            throw new Error("Tabs cannot be read");
          },
        },
      });
      await flush();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", collect);
    }
    assert.deepEqual(fake.webRequestRegistrations, []);
    assert.deepEqual(warned(), [
      { event: "file_guard_tabs_unread", error: "Error: Tabs cannot be read" },
    ]);
    fake.emitStatus(left.id, "loading");
    await flush();
    assert.deepEqual(fake.webRequestRegistrations, REGISTRATIONS);
  });

  it("ties a window opened from a tab left in such a group to its session", async () => {
    const { fake, left } = await leftBehind();
    const { guard } = restart(fake);
    await flush();
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, left, window);
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(left.id, 0), [B]);
  });

  it("judges a tab opened from no session's tab and moved into such a group by that group", async () => {
    const { fake, left } = await leftBehind();
    const { guard } = restart(fake);
    await flush();
    const own = fake.openTab({ url: `${A}/page` });
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, own, window);
    await flush();
    await fake.browser.tabs.group({ groupId: left.groupId, tabIds: [window.id] });
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(own.id, 0), []);
  });

  it("judges a tied tab moved into such a group by its tie", async () => {
    const { fake, left } = await leftBehind();
    const { access, groups, sessions } = restart(fake);
    access.admit("s2");
    const opener = fake.openTab({ url: `${A}/page` });
    await groups.ensureGroup("s2", opener);
    sessions.set("s2", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    await flush();
    await fake.browser.tabs.group({ groupId: left.groupId, tabIds: [window.id] });
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "passed");
  });

  it("judges a tab of a running session's group by that session, whatever is stored", async () => {
    const fake = createFakeBrowser();
    await grantSite(fake.browser, A);
    const { access, groups, sessions } = restart(fake);
    access.admit("s1");
    const tab = fake.openTab({ url: `${A}/page` });
    const groupId = await groups.ensureGroup("s1", tab);
    await fake.browser.storage.local.set({
      [SESSION_GROUPS_KEY]: [{ id: groupId, session: "old" }],
    });
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "passed");
  });
});

describe("a file from a site the session may not act on", { timeout: 10000 }, () => {
  it("is cancelled, recorded and reported when the site is not approved", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    const answer = respond({ tabId: tab.id, timeStamp: 1000 });
    assert.ok(answer instanceof Promise);
    assert.deepEqual(await answer, { cancel: true });
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
    assert.deepEqual(heard, [[tab.id, B, 0]]);
  });

  it("is cancelled when the site is approved and on the blocklist", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    await grantSite(fake.browser, B);
    assert.equal(await verdict(respond({ tabId: tab.id })), "passed");
    await saveBlocklist(fake.browser, ["b.example"]);
    assert.equal(await verdict(respond({ tabId: tab.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("is cancelled in a stopped session's tab, also from an approved site", async () => {
    const { access, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    assert.equal(await verdict(respond({ tabId: tab.id, url: `${A}/export` })), "passed");
    access.stop("s1");
    assert.equal(await verdict(respond({ tabId: tab.id, url: `${A}/export` })), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [A]);
  });

  it("is cancelled when the settings cannot be read", async (t) => {
    const { fake, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    t.mock.method(fake.browser.storage.local, "get", async () => {
      throw new Error("The storage is broken");
    });
    assert.equal(await verdict(respond({ tabId: tab.id, url: `${A}/export` })), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [A]);
  });

  it("passes in an ended session's tab a file of a site approved for that session only, until the guard restarts", async () => {
    const { access, groups, sessions, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respond({ tabId: tab.id })), "passed");
    access.endSession("s1");
    await groups.endSession("s1");
    assert.equal(await verdict(respond({ tabId: tab.id })), "passed");
    // A site allowed always still loads its files there, and one never approved does not.
    assert.equal(await verdict(respond({ tabId: tab.id, url: `${A}/export` })), "passed");
    assert.equal(await verdict(respond({ tabId: tab.id, url: `${C}/export` })), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [C]);
  });

  it("is cancelled in a tab whose id is 0: only a negative id means no tab", async (t) => {
    const { fake, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const get = fake.browser.tabs.get;
    t.mock.method(fake.browser.tabs, "get", async (tabId: number) =>
      tabId === 0 ? { ...(await get(tab.id)), id: 0 } : get(tabId),
    );
    assert.equal(await verdict(respond({ tabId: 0 })), "cancelled");
    assert.deepEqual(guard.refusedSince(0, 0), [B]);
  });

  it("is cancelled, with nothing recorded, when the tab cannot be looked up", async () => {
    const { guard, tabIn, respond } = setup();
    await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    const answer = respond({ tabId: 999 });
    assert.ok(answer instanceof Promise);
    assert.deepEqual(await answer, { cancel: true });
    assert.deepEqual(guard.refusedSince(999, 0), []);
    assert.deepEqual(heard, []);
  });

  it("is judged by the session of its own tab", async () => {
    const { sessions, guard, tabIn, respond } = setup();
    const first = await tabIn("s1");
    const second = await tabIn("s2");
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respond({ tabId: first.id })), "passed");
    assert.equal(await verdict(respond({ tabId: second.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(first.id, 0), []);
    assert.deepEqual(guard.refusedSince(second.id, 0), [B]);
  });

  it("is judged anew each time: an approval counts at once, and so does its withdrawal", async () => {
    const { fake, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    assert.equal(await verdict(respond({ tabId: tab.id })), "cancelled");
    await grantSite(fake.browser, B);
    assert.equal(await verdict(respond({ tabId: tab.id })), "passed");
    await revokeSite(fake.browser, B);
    assert.equal(await verdict(respond({ tabId: tab.id })), "cancelled");
  });

  it("is recorded with its frame, and by its site alone", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    const frame = { tabId: tab.id, type: "sub_frame", frameId: 7 };
    assert.equal(await verdict(respond({ ...frame, url: `${B}:8443/a/b?c=d#e` })), "cancelled");
    // A host that is no site of its own reveals only the scheme.
    assert.equal(await verdict(respond({ ...frame, url: "http://./export" })), "cancelled");
    assert.deepEqual(heard, [
      [tab.id, `${B}:8443`, 7],
      [tab.id, "http:", 7],
    ]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [`${B}:8443`, "http:"]);
  });
});

describe("an ended session's tabs", { timeout: 10000 }, () => {
  it("are judged by the sites allowed always by a guard that starts after the end, though one that saw it passes", async () => {
    const { fake, tab } = await endedWithB();
    const { guard } = restart(fake);
    await flush();
    const answers = fake.emitWebRequest("onHeadersReceived", response({ tabId: tab.id }));
    assert.equal(answers.length, 2);
    assert.equal(await verdict(answers[0]), "passed");
    assert.equal(await verdict(answers[1]), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("keep a Blob file of a site the session was allowed, built in a tab of the user's own or in the ended session's tab", async () => {
    for (const own of [true, false]) {
      const { fake, clock, guard, tab } = await endedWithB();
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
      fake.setFrames(tab.id, [{ frameId: 0, url: `${B}/page` }]);
      if (own) {
        const mine = fake.openTab({ url: `${B}/page` });
        fake.emitCommitted({ tabId: mine.id, frameId: 0, url: `${B}/page`, timeStamp: 1010 });
      }
      clock.now = 1040;
      download(fake, { id: 1, url: BLOB, started: 1030 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [], String(own));
      assert.deepEqual(guard.refusedSince(tab.id, 0), [], String(own));
    }
  });

  it("cancel a Blob file of a site the session was never allowed", async () => {
    const { fake, clock, guard, tab } = await endedWithB();
    clock.now = 1000;
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${C}/page`, timeStamp: 1000 });
    fake.setFrames(tab.id, [{ frameId: 0, url: `${C}/page` }]);
    clock.now = 1040;
    download(fake, { id: 1, url: `blob:${C}/0b2c5d1e`, started: 1030 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [C]);
  });

  it("let a download from a load whose headers never came through for a site the session was allowed only", async () => {
    for (const [site, cancelled] of [
      [B, false],
      [C, true],
    ] as const) {
      const { fake, clock, guard, tab } = await endedWithB();
      hop(fake, { tabId: tab.id, url: `${site}/export`, timeStamp: 1000 });
      clock.now = 1010;
      download(fake, { id: 1, url: `${site}/export`, started: 1004 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, cancelled ? [1] : [], site);
    }
  });

  it("do not keep a site the user withdrew before the end", async () => {
    const { fake, access, groups, sessions, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    access.forget("s1", B);
    access.endSession("s1");
    await groups.endSession("s1");
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("do not keep a site the session held again and the user withdrew after the end, and keep the others", async () => {
    const { fake, access, groups, sessions, tabIn } = setup();
    const tab = await tabIn("s1");
    const other = "https://d.example";
    sessions.set("s1", { allowed: new Set([B, other]), refused: new Set(), closed: 0 });
    access.endSession("s1");
    await groups.endSession("s1");
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    access.forget("s1", B);
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "cancelled");
    assert.equal(
      await verdict(respondOnce(fake, { tabId: tab.id, url: `${other}/export` })),
      "passed",
    );
  });

  it("are judged by the session's current answers alone once it runs again", async () => {
    const { fake, access, sessions, tab } = await endedWithB();
    access.admit("s1");
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "cancelled");
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "passed");
    // Its next end keeps what it then had.
    access.endSession("s1");
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "passed");
  });

  it("refuse every file once the user stopped the session, before or after its end", async () => {
    for (const stopped of ["before", "after"] as const) {
      const { fake, access, groups, sessions, tabIn } = setup();
      const tab = await tabIn("s1");
      sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
      if (stopped === "before") access.stop("s1");
      access.endSession("s1");
      await groups.endSession("s1");
      if (stopped === "after") {
        assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "passed");
        access.stop("s1");
      }
      for (const url of [`${B}/export`, `${A}/export`]) {
        assert.equal(
          await verdict(respondOnce(fake, { tabId: tab.id, url })),
          "cancelled",
          `${stopped} ${url}`,
        );
      }
    }
  });

  it("refuse a file of a site the session was allowed once it is on the blocklist", async () => {
    const { fake, tab } = await endedWithB();
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "passed");
    await saveBlocklist(fake.browser, ["b.example"]);
    assert.equal(await verdict(respondOnce(fake, { tabId: tab.id })), "cancelled");
  });

  it("lose the sites of their session once MAX_REMEMBERED_GROUPS later sessions ended with a site", async () => {
    for (const [later, kept] of [
      [MAX_REMEMBERED_GROUPS - 1, true],
      [MAX_REMEMBERED_GROUPS, false],
    ] as const) {
      const { fake, access, groups, sessions, tab, tabIn } = await endedWithB();
      // The oldest of the later sessions, whose sites must outlive s1's.
      const next = await tabIn("f0");
      for (let index = 0; index < later; index += 1) {
        sessions.set(`f${index}`, {
          allowed: new Set([C, `https://s${index}.example`]),
          refused: new Set(),
          closed: 0,
        });
        access.endSession(`f${index}`);
      }
      await groups.endSession("f0");
      // Sessions that end with no site allowed for themselves count for nothing.
      sessions.set("refusing", { allowed: new Set(), refused: new Set([C]), closed: 0 });
      access.endSession("refusing");
      access.endSession("idle");
      assert.equal(
        await verdict(respondOnce(fake, { tabId: tab.id })),
        kept ? "passed" : "cancelled",
        String(later),
      );
      assert.equal(
        await verdict(respondOnce(fake, { tabId: next.id, url: `${C}/export` })),
        "passed",
        String(later),
      );
    }
  });

  it("do not keep a site for a judgement under way when the session runs again or the user withdraws it", async (t) => {
    for (const change of ["admit", "forget"] as const) {
      const { fake, access, guard, sessions, tab } = await endedWithB();
      const views = holdViews(t, access);
      const answer = respondOnce(fake, { tabId: tab.id });
      await idle(guard, false);
      if (change === "admit") access.admit("s1");
      else {
        sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
        access.forget("s1", B);
      }
      views.release();
      assert.equal(await verdict(answer), "cancelled", change);
    }
  });
});

describe("a response the guard answers at once, from a site not approved", {
  timeout: 10000,
}, () => {
  const passing: [string, Overrides][] = [
    ["a request of no tab", { tabId: -1 }],
    ["an ftp: address", { url: "ftp://b.example/export.csv" }],
    ["a data: address", { url: "data:text/csv,a" }],
    ["a file: address", { url: "file:///home/user/export.csv" }],
    ["an extension page", { url: "moz-extension://0000/options.html" }],
    ["a 204", { statusCode: 204 }],
    ["a 205", { statusCode: 205 }],
    ["a 304", { statusCode: 304 }],
    ...[301, 302, 303, 307, 308].map((statusCode): [string, Overrides] => [
      `a ${statusCode} with a Location`,
      { statusCode, responseHeaders: [...ATTACHMENT, LOCATION] },
    ]),
    ["a redirect whose header names are lowercase", redirect("location")],
    ["an HTML page", { responseHeaders: HTML }],
    ["an HTML page with a charset, in capitals", page("TEXT/HTML; charset=utf-8")],
    ["an HTML page with spaces and tabs around its type", page(" \ttext/html\t ")],
    ["an XHTML page", page("application/xhtml+xml")],
    ["a page whose header names are in capitals", { responseHeaders: capitals() }],
    ["a page sent inline", page("text/html", "inline")],
    ["a page sent inline with a file name", page("text/html", "INLINE; filename=a.html")],
    ["a page sent inline with spaces around the type", page("text/html", "\t inline \t")],
  ];
  for (const [name, details] of passing) {
    it(`lets ${name} through without a lookup`, async (t) => {
      const { fake, guard, tabIn, respond } = setup();
      const tab = await tabIn("s1");
      const get = t.mock.method(fake.browser.tabs, "get");
      // undefined itself, not a promise of it: Firefox holds the request for a promise.
      assert.equal(respond({ tabId: tab.id, ...details }), undefined);
      assert.equal(get.mock.callCount(), 0);
      assert.deepEqual(guard.refusedSince(tab.id, 0), []);
    });
  }

  it("cancels the same response once it is a file with a status that loads", async () => {
    const { tabIn, respond } = setup();
    const tab = await tabIn("s1");
    assert.equal(await verdict(respond({ tabId: tab.id, statusCode: 200 })), "cancelled");
  });
});

describe("a file the guard lets through after its lookup", { timeout: 10000 }, () => {
  it("comes from a site the session may act on", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    const answer = respond({ tabId: tab.id, url: `${A}/export` });
    assert.ok(answer instanceof Promise);
    assert.equal(await answer, undefined);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
    assert.deepEqual(heard, []);
  });

  it("loads in a tab outside every group", async () => {
    const { fake, guard, tabIn, respond } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    assert.equal(await verdict(respond({ tabId: own.id })), "passed");
    assert.deepEqual(guard.refusedSince(own.id, 0), []);
  });

  it("loads in a tab of a group that is no session's", async () => {
    const { fake, guard, tabIn, respond } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page`, groupId: 4242 });
    assert.equal(await verdict(respond({ tabId: own.id })), "passed");
    assert.deepEqual(guard.refusedSince(own.id, 0), []);
  });
});

describe("a tab or window opened from another tab", { timeout: 10000 }, () => {
  it("is judged as the session of its opener's group, its refusal listed for both", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
  });

  it("lets a file of a site the session may act on load", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id, url: `${A}/export` })), "passed");
    assert.deepEqual(guard.refusedSince(window.id, 0), []);
    assert.deepEqual(guard.refusedSince(opener.id, 0), []);
  });

  it("is judged by the tab in a group that a chain of them began in", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const first = fake.openTab({ url: "about:blank" });
    const second = fake.openTab({ url: "about:blank" });
    opens(fake, opener, first);
    await flush();
    opens(fake, first, second);
    assert.equal(await verdict(respond({ tabId: second.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(first.id, 0), []);
    assert.deepEqual(guard.refusedSince(second.id, 0), [B]);
  });

  it("is no session's when its opener is no session's", async () => {
    const { fake, guard, tabIn, respond } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, own, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "passed");
    assert.deepEqual(guard.refusedSince(window.id, 0), []);
    assert.deepEqual(guard.refusedSince(own.id, 0), []);
  });

  it("is no session's when its opener in no group is gone, and leaves no rejection unhandled", async () => {
    const { fake, tabIn, respond } = setup();
    await tabIn("s1");
    const gone = fake.openTab({ url: `${A}/page` });
    fake.removeTab(gone.id);
    const window = fake.openTab({ url: "about:blank" });
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", collect);
    try {
      opens(fake, gone, window);
      await flush();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", collect);
    }
    assert.equal(await verdict(respond({ tabId: window.id })), "passed");
  });

  it("takes its opener's own tie when the opener is gone by the time it is looked up", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const first = fake.openTab({ url: "about:blank" });
    const second = fake.openTab({ url: "about:blank" });
    opens(fake, opener, first);
    await flush();
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = (tabId) =>
      tabId === first.id ? Promise.reject(new Error("No tab.")) : get(tabId);
    opens(fake, first, second);
    assert.equal(await verdict(respond({ tabId: second.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
  });

  it("is tied when its opener closes while the opener is looked up", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const first = fake.openTab({ url: "about:blank" });
    const second = fake.openTab({ url: "about:blank" });
    opens(fake, opener, first);
    await flush();
    opens(fake, first, second);
    fake.removeTab(first.id);
    assert.equal(await verdict(respond({ tabId: second.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
  });

  it("passes on no tie once MAX_GONE_TABS tabs closed after it", async () => {
    const { fake, clock, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    await flush();
    clock.now = 1000;
    fake.removeTab(window.id);
    clock.now = 1000 + HOP_GRACE_MS;
    closeTabs(fake, MAX_GONE_TABS);
    const next = fake.openTab({ url: "about:blank" });
    opens(fake, window, next);
    assert.equal(await verdict(respond({ tabId: next.id })), "passed");
  });

  it("is still refused a file when it closes while that file is judged", async () => {
    const { fake, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    await flush();
    const answer = respond({ tabId: window.id });
    fake.removeTab(window.id);
    assert.deepEqual(await answer, { cancel: true });
  });

  it("is judged as the session of a group it joins, and its refusal there is not the opener's", async () => {
    const { fake, access, groups, sessions, guard, respond, tabIn } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id, timeStamp: 1000 })), "cancelled");
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
    access.admit("s2");
    await groups.ensureGroup("s2", window);
    sessions.set("s2", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respond({ tabId: window.id, timeStamp: 2000 })), "passed");
    const third = { tabId: window.id, url: `${C}/export`, timeStamp: 3000 };
    assert.equal(await verdict(respond(third)), "cancelled");
    assert.deepEqual(guard.refusedSince(window.id, 3000), [C]);
    assert.deepEqual(guard.refusedSince(opener.id, 3000), []);
  });

  it("is judged as the session its opener joined after opening it", async () => {
    const { fake, groups, guard, tabIn, respond } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, own, window);
    await flush();
    await groups.ensureGroup("s1", own);
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(own.id, 0), [B]);
  });

  it("is refused under its own id only to the refusal listeners", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    assert.deepEqual(heard, [[window.id, B, 0]]);
  });

  it("is refused a file that arrives before its opener was looked up", async () => {
    const { fake, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    const answer = respond({ tabId: window.id });
    assert.deepEqual(await answer, { cancel: true });
  });

  it("is tied to the group its opener was in when the opener closed before it was opened", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    // As tab_open does: the tab is grouped, then loads, and the load's update names no group.
    fake.emitStatus(opener.id, "complete");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.removeTab(opener.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to its opener's group when the opener closes before it is looked up", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    const window = fake.openTab({ url: "about:blank" });
    const held = holdGets(t, fake, opener.id);
    opens(fake, opener, window);
    fake.removeTab(opener.id);
    held.release();
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to the group of an opener seen only among the tabs open at the start", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, groups, access, opener } = await groupedBeforeGuard();
    createFileGuard({ browser: fake.browser, groups, access, now: () => 0 });
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.removeTab(opener.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "cancelled");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is not tied by the tabs open at the start when a tab event since showed the opener", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, groups, access, opener } = await groupedBeforeGuard();
    const gate = Promise.withResolvers<void>();
    const query = fake.browser.tabs.query;
    // The answer is taken when the guard asks, and reaches it only after the tab left the group.
    const browser: BrowserApi = {
      ...fake.browser,
      tabs: {
        ...fake.browser.tabs,
        query: async (queryInfo) => {
          const answer = await query(queryInfo);
          await gate.promise;
          return answer;
        },
      },
    };
    createFileGuard({ browser, groups, access, now: () => 0 });
    await flush();
    fake.ungroup(opener.id);
    gate.resolve();
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.removeTab(opener.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "passed");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is no session's when its opener left the group before it closed", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.ungroup(opener.id);
    fake.removeTab(opener.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "passed");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is no session's when its opener moved to another window before it closed", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.emitDetached(opener.id);
    fake.removeTab(opener.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "passed");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to its gone opener's group until MAX_GONE_TABS tabs closed after the opener", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, clock, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    clock.now = 1000;
    fake.removeTab(opener.id);
    clock.now = 1000 + HOP_GRACE_MS;
    // A load runs the pruning.
    const other = fake.openTab({ url: `${A}/page` });
    hop(fake, { tabId: other.id, url: `${A}/next`, timeStamp: clock.now });
    closeTabs(fake, MAX_GONE_TABS - 1);
    const late = fake.openTab({ url: "about:blank" });
    opens(fake, opener, late);
    assert.equal(await verdict(respond({ tabId: late.id })), "cancelled");
    closeTabs(fake, 1);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "passed");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to its gone opener's group for HOP_GRACE_MS however many tabs closed since", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, clock, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    clock.now = 1000;
    fake.removeTab(opener.id);
    clock.now = 1000 + HOP_GRACE_MS - 1;
    closeTabs(fake, MAX_GONE_TABS);
    const late = fake.openTab({ url: "about:blank" });
    opens(fake, opener, late);
    assert.equal(await verdict(respond({ tabId: late.id })), "cancelled");
    clock.now = 1000 + HOP_GRACE_MS;
    closeTabs(fake, 1);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "passed");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("takes the tie of an opener that closed before it was opened", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, guard, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const first = fake.openTab({ url: "about:blank" });
    opens(fake, opener, first);
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.removeTab(first.id);
    const second = fake.openTab({ url: "about:blank" });
    opens(fake, first, second);
    assert.equal(await verdict(respond({ tabId: second.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to the group of a gone opener before the opener's own tie", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, access, groups, sessions, guard, tabIn, respond } = setup();
    const own = await tabIn("s2");
    const mid = fake.openTab({ url: "about:blank" });
    opens(fake, own, mid);
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    access.admit("s1");
    await groups.ensureGroup("s1", mid);
    sessions.set("s2", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    fake.removeTab(mid.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, mid, window);
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(mid.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(own.id, 0), []);
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to the session of its gone opener's group as it was when it was opened", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, access, groups, sessions, tabIn, respond } = setup();
    const own = await tabIn("s2");
    const mid = fake.openTab({ url: "about:blank" });
    opens(fake, own, mid);
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    access.admit("s1");
    await groups.ensureGroup("s1", mid);
    sessions.set("s2", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    const held = holdGets(t, fake, mid.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, mid, window);
    // The group goes with its last tab, and s1 forgets it.
    fake.removeTab(mid.id);
    assert.equal(await groups.groupOf("s1"), undefined);
    held.release();
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to its gone opener's group when it is remembered from before a restart", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, left } = await leftBehind();
    const { guard } = restart(fake);
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.removeTab(left.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, left, window);
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(left.id, 0), [B]);
    const own = { tabId: window.id, requestId: "r2", url: `${A}/export` };
    assert.equal(await verdict(respondOnce(fake, own)), "passed");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to the remembered session of a gone opener's group, past the opener's empty tie", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, left } = await leftBehind();
    const { guard } = restart(fake);
    const own = fake.openTab({ url: `${A}/page` });
    const mid = fake.openTab({ url: "about:blank" });
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    opens(fake, own, mid);
    await flush();
    await fake.browser.tabs.group({ groupId: left.groupId, tabIds: [mid.id] });
    fake.removeTab(mid.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, mid, window);
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(mid.id, 0), [B]);
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to the group a gone opener was created in", async (t) => {
    const unhandled = unhandledRejections(t);
    const { fake, left } = await leftBehind();
    fake.removeTab(left.id);
    restart(fake);
    await flush();
    // The user opens the saved group again: only onCreated names the group.
    const reopened = fake.openTab({ url: `${A}/page`, groupId: left.groupId });
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    fake.removeTab(reopened.id);
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, reopened, window);
    assert.equal(await verdict(respondOnce(fake, { tabId: window.id })), "cancelled");
    await flush();
    assert.deepEqual(unhandled, []);
  });

  it("is tied to the group its opener left while the opener was looked up", async (t) => {
    const { fake, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    await flush();
    assert.equal(fake.createdNavigationTargetListenerCount(), 1);
    const window = fake.openTab({ url: "about:blank" });
    const held = holdGets(t, fake, opener.id);
    opens(fake, opener, window);
    fake.ungroup(opener.id);
    held.release();
    assert.equal(await verdict(respond({ tabId: window.id })), "cancelled");
  });
});

describe("what counts as a file", { timeout: 10000 }, () => {
  const files: [string, Overrides][] = [
    ["an attachment that is HTML", page("text/html", "attachment")],
    ["a Content-Disposition with no type", page("text/html", "filename=x.csv")],
    ["an empty Content-Disposition", page("text/html", "")],
    ["a Content-Disposition of an unknown type", page("text/html", "render")],
    [
      "two Content-Disposition headers",
      {
        responseHeaders: [
          ...HTML,
          { name: "Content-Disposition", value: "inline" },
          { name: "content-disposition", value: "inline" },
        ],
      },
    ],
    ["two Content-Disposition types in one header", page("text/html", "inline,attachment")],
    ["a Content-Disposition in lowercase", { responseHeaders: lowercase() }],
    ["no headers", { responseHeaders: [] }],
    ["headers Firefox did not pass", { responseHeaders: null }],
    ["no Content-Type", { responseHeaders: [{ name: "Content-Length", value: "3" }] }],
    ["a Content-Type with no value", { responseHeaders: [{ name: "Content-Type" }] }],
    ["an empty Content-Type", page("")],
    ["a Content-Type of spaces and tabs only", page(" \t ")],
    ["a Content-Disposition of spaces only", page("text/html", "  ")],
    ["two Content-Type headers", { responseHeaders: [...HTML, ...HTML] }],
    [
      "two Content-Type headers whose names differ in case",
      { responseHeaders: [...HTML, { name: "CONTENT-TYPE", value: "text/html" }] },
    ],
    ["HTML then CSV in one Content-Type", page("text/html,text/csv")],
    ["CSV then HTML in one Content-Type", page("text/csv, text/html")],
    ["a comma in a Content-Type parameter", page('text/html; charset="utf-8,x"')],
    ["a CSV", page("text/csv")],
    ["a PDF", page("application/pdf")],
    ["an image", page("image/png")],
    ["plain text", page("text/plain")],
    ["a type that only starts as HTML", page("text/html5")],
    ["a form feed after the type", page("text/html\x0c")],
    ["a no-break space after the type", page("text/html\xa0")],
    ["a vertical tab before the type", page("\x0btext/html")],
    ["a line break after the type", page("text/html\n")],
    ["a no-break space after inline", page("text/html", "inline\xa0")],
    ["a dotless i in inline", page("text/html", "ınline")],
    ["a dotted capital I in inline", page("text/html", "İnline")],
    ["a dotless i in the type", page("applıcation/xhtml+xml")],
    ["a space inside the type", page("text /html")],
    ["blanks only around a type that is not HTML", page(" text/csv ")],
    ["a form feed before inline", page("text/html", "\x0cinline")],
    ["a 300 with a Location", { statusCode: 300, responseHeaders: [...ATTACHMENT, LOCATION] }],
    ["a 302 without a Location", { statusCode: 302, responseHeaders: ATTACHMENT }],
    ["a 306 with a Location", { statusCode: 306, responseHeaders: [...ATTACHMENT, LOCATION] }],
    ["a 200 with a Location", { statusCode: 200, responseHeaders: [...ATTACHMENT, LOCATION] }],
    ["an attachment whose address has its scheme in capitals", { url: "HTTPS://b.example/export" }],
    ["an attachment over http:", { url: "http://b.example/export" }],
  ];
  for (const [name, details] of files) {
    it(`cancels ${name} from a site not approved`, async () => {
      const { tabIn, respond } = setup();
      const tab = await tabIn("s1");
      assert.equal(await verdict(respond({ tabId: tab.id, ...details })), "cancelled");
    });
  }
});

describe("refusedSince", { timeout: 10000 }, () => {
  it("lists a refusal at or after the time asked for, per tab", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const other = await tabIn("s1");
    await verdict(respond({ tabId: tab.id, timeStamp: 1000 }));
    assert.deepEqual(guard.refusedSince(tab.id, 999), [B]);
    assert.deepEqual(guard.refusedSince(tab.id, 1000), [B]);
    assert.deepEqual(guard.refusedSince(tab.id, 1001), []);
    assert.deepEqual(guard.refusedSince(other.id, 0), []);
  });

  it("lists each site once, oldest first", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    for (const [index, host] of ["c", "b", "c", "d", "b"].entries()) {
      const url = `https://${host}.example/export`;
      await verdict(respond({ tabId: tab.id, url, timeStamp: 1000 + index }));
    }
    assert.deepEqual(guard.refusedSince(tab.id, 0), [
      "https://c.example",
      "https://b.example",
      "https://d.example",
    ]);
    assert.deepEqual(guard.refusedSince(tab.id, 1002), [
      "https://c.example",
      "https://d.example",
      "https://b.example",
    ]);
  });

  it("keeps only a tab's newest refusals", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    for (let index = 0; index <= MAX_REFUSALS; index += 1) {
      await verdict(respond({ tabId: tab.id, url: `https://s${index}.example/export` }));
    }
    const sites = Array.from(
      { length: MAX_REFUSALS },
      (_, index) => `https://s${index + 1}.example`,
    );
    assert.equal(MAX_REFUSALS, 20);
    assert.deepEqual(guard.refusedSince(tab.id, 0), sites);
  });

  it("forgets a closed tab's refusals", async () => {
    const { fake, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const other = await tabIn("s1");
    await verdict(respond({ tabId: tab.id }));
    await verdict(respond({ tabId: other.id }));
    fake.removeTab(tab.id);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
    assert.deepEqual(guard.refusedSince(other.id, 0), [B]);
  });

  it("keeps the refusals of a bounded number of tabs, dropping the tab whose first one is oldest", async () => {
    const { guard, tabIn, respond } = setup();
    assert.equal(MAX_REFUSAL_TABS, 100);
    const tabs: FakeTab[] = [];
    for (let index = 0; index < MAX_REFUSAL_TABS; index += 1) {
      const tab = await tabIn("s1");
      tabs.push(tab);
      await verdict(respond({ tabId: tab.id }));
    }
    const [first, second] = tabs;
    assert.ok(first !== undefined && second !== undefined);
    // A later refusal does not move a tab back in the line.
    await verdict(respond({ tabId: first.id, url: "https://c.example/export" }));
    assert.deepEqual(guard.refusedSince(first.id, 0), [B, "https://c.example"]);
    const last = await tabIn("s1");
    await verdict(respond({ tabId: last.id }));
    assert.deepEqual(guard.refusedSince(first.id, 0), []);
    assert.deepEqual(guard.refusedSince(second.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(last.id, 0), [B]);
    const next = await tabIn("s1");
    await verdict(respond({ tabId: next.id }));
    assert.deepEqual(guard.refusedSince(second.id, 0), []);
    assert.deepEqual(guard.refusedSince(last.id, 0), [B]);
  });
});

describe("onRefused", { timeout: 10000 }, () => {
  it("stops calling a listener once its remover ran", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const heard: string[] = [];
    const remove = guard.onRefused(() => heard.push("removed"));
    guard.onRefused(() => heard.push("kept"));
    await verdict(respond({ tabId: tab.id }));
    remove();
    await verdict(respond({ tabId: tab.id }));
    assert.deepEqual(heard, ["removed", "kept", "kept"]);
  });

  it("cancels, records and calls the other listeners when a listener throws", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const heard: string[] = [];
    guard.onRefused(() => heard.push("first"));
    guard.onRefused(() => {
      throw new Error("A listener failed");
    });
    guard.onRefused(() => heard.push("last"));
    assert.equal(await verdict(respond({ tabId: tab.id })), "cancelled");
    assert.deepEqual(heard, ["first", "last"]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("lets a listener remove itself while the listeners are called", async () => {
    const { guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    const heard: string[] = [];
    const remove = guard.onRefused(() => {
      heard.push("once");
      remove();
    });
    guard.onRefused(() => heard.push("each"));
    await verdict(respond({ tabId: tab.id }));
    await verdict(respond({ tabId: tab.id }));
    assert.deepEqual(heard, ["once", "each", "each"]);
  });
});

describe("a download from a load whose headers never came", { timeout: 10000 }, () => {
  it("is cancelled and recorded for the load's tab and frame, by its site alone", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    const url = `${B}:8443/a/b?c=d`;
    hop(fake, { tabId: tab.id, url: `${url}#e`, frameId: 3, type: "sub_frame", timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, url: `${url}#f`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(fake.removedFiles, []);
    assert.deepEqual(heard, [[tab.id, `${B}:8443`, 3]]);
    // Recorded once the file was gone, on the guard's clock.
    assert.deepEqual(guard.refusedSince(tab.id, 1010), [`${B}:8443`]);
    assert.deepEqual(guard.refusedSince(tab.id, 1011), []);
  });

  it("has its file removed when it is already complete, and is then recorded", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004, state: "complete" });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(fake.removedFiles, [1]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("is reported to nobody, and logged, when it is interrupted and its file still exists", async (t) => {
    const warned = warnings(t);
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    clock.now = 1010;
    // Firefox removes the file of no download that is not complete.
    download(fake, { id: 1, started: 1004, state: "interrupted", exists: true });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(fake.removedFiles, []);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
    assert.deepEqual(warned(), [{ event: "file_guard_download_kept", id: 1 }]);
  });

  it("is matched with a load that reaches the guard after it, for HOP_GRACE_MS", async () => {
    for (const [late, matched] of [
      [HOP_GRACE_MS - 1, true],
      [HOP_GRACE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1010;
      download(fake, { id: 1, started: 1004 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, []);
      clock.now = 1010 + late;
      hop(fake, { tabId: tab.id, timeStamp: 1000 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, matched ? [1] : [], String(late));
      assert.deepEqual(guard.refusedSince(tab.id, 0), matched ? [B] : [], String(late));
    }
  });

  it("is not matched with a load whose headers came, whatever they were", async () => {
    for (const responseHeaders of [HTML, ATTACHMENT, null]) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      hop(fake, { tabId: tab.id, requestId: "h1", url: `${A}/next#top`, timeStamp: 1000 });
      fake.emitWebRequest(
        "onHeadersReceived",
        response({ tabId: tab.id, requestId: "h1", url: `${A}/next`, responseHeaders }),
      );
      // Headers of another request, or of another address of the same request, end nothing.
      hop(fake, { tabId: tab.id, requestId: "h2", timeStamp: 1000 });
      fake.emitWebRequest("onHeadersReceived", response({ tabId: tab.id, requestId: "h3" }));
      fake.emitWebRequest(
        "onHeadersReceived",
        response({ tabId: tab.id, requestId: "h2", url: `${B}/other` }),
      );
      await revokeSite(fake.browser, A);
      clock.now = 1010;
      download(fake, { id: 1, url: `${A}/next`, started: 1004 });
      download(fake, { id: 2, started: 1004 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [2], JSON.stringify(responseHeaders));
    }
  });

  it("is not matched with a load that committed a page once HOP_GRACE_MS passed", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, url: `${B}/page`, timeStamp: 1000 });
    clock.now = 1010;
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${B}/page#top`, timeStamp: 1005 });
    clock.now = 1010 + HOP_GRACE_MS - 1;
    download(fake, { id: 1, url: `${B}/page`, started: 1006 });
    await idle(guard);
    // A wrong pick stays matchable for a moment.
    assert.deepEqual(fake.cancelledDownloads, [1]);
    hop(fake, { tabId: tab.id, requestId: "h2", url: `${B}/page`, timeStamp: 2000 });
    clock.now = 2010;
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${B}/page`, timeStamp: 2005 });
    clock.now = 2010 + HOP_GRACE_MS;
    download(fake, { id: 2, url: `${B}/page`, started: 2006 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("ends only the newest load of a commit's frame and address, begun before it", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const frame = { tabId: tab.id, frameId: 2, type: "sub_frame", url: `${B}/page` };
    hop(fake, { ...frame, requestId: "h1", timeStamp: 1000 });
    hop(fake, { ...frame, requestId: "h2", timeStamp: 1100 });
    hop(fake, { ...frame, requestId: "h3", timeStamp: 1300 });
    // Of another frame, and of the top frame: not this frame's loads.
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${B}/page`, timeStamp: 1100 });
    fake.emitCommitted({ tabId: tab.id, frameId: 5, url: `${B}/page`, timeStamp: 1100 });
    fake.emitCommitted({ tabId: tab.id, frameId: 2, url: `${B}/page`, timeStamp: 1100 });
    clock.now = 1400 + HOP_GRACE_MS;
    // h1 is older than the load the commit ended: it still matches.
    download(fake, { id: 1, url: `${B}/page`, started: 1050 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    // With h1 taken by the header layer: h2 is gone, and h3, begun after the commit, still matches.
    fake.emitWebRequest(
      "onHeadersReceived",
      response({ tabId: tab.id, requestId: "h1", url: `${B}/page`, responseHeaders: HTML }),
    );
    download(fake, { id: 2, url: `${B}/page`, started: 1150 });
    download(fake, { id: 3, url: `${B}/page`, started: 1350 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1, 3]);
  });

  it("is not matched with a load that began after it, but with one in the same millisecond", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, requestId: "h1", timeStamp: 1005 });
    hop(fake, { tabId: tab.id, requestId: "h2", url: `${B}/other`, timeStamp: 1004.6 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    download(fake, { id: 2, url: `${B}/other`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [2]);
  });

  it("is judged by the session's sites, read anew", async (t) => {
    const { fake, clock, access, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, requestId: "h1", url: `${A}/export`, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, url: `${A}/export`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
    // The allowed load ended in that download: its site no longer counts for another.
    await revokeSite(fake.browser, A);
    download(fake, { id: 2, url: `${A}/export`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
    await grantSite(fake.browser, B);
    await saveBlocklist(fake.browser, ["b.example"]);
    hop(fake, { tabId: tab.id, requestId: "h2", timeStamp: 1000 });
    download(fake, { id: 3, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [3]);
    await saveBlocklist(fake.browser, []);
    hop(fake, { tabId: tab.id, requestId: "h3", timeStamp: 1000 });
    t.mock.method(access, "view", async () => {
      throw new Error("The session stopped");
    });
    download(fake, { id: 4, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [3, 4]);
  });

  it("is not matched with a load of a tab outside every group", async () => {
    const { fake, clock, guard, tabIn } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    hop(fake, { tabId: own.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("is matched with a load of a tab moved into a session's group since, looked up anew", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const moved = fake.openTab({ url: `${A}/page` });
    hop(fake, { tabId: moved.id, timeStamp: 1000 });
    await idle(guard);
    // Moved without a word of it: only the download's own lookup sees it.
    const fakeTab = fake.tabs.get(moved.id);
    assert.ok(fakeTab !== undefined);
    fakeTab.groupId = tab.groupId;
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("waiting for its load's tab to join a session's group, is refused when it does", async (t) => {
    for (const how of ["named", "on the tab"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const moved = fake.openTab({ url: `${A}/page` });
      const gets = holdGets(t, fake, moved.id);
      gets.release();
      hop(fake, { tabId: moved.id, timeStamp: 1000 });
      clock.now = 1010;
      download(fake, { id: 1, started: 1004 });
      fake.emitStatus(moved.id, "loading");
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, []);
      if (how === "named") {
        await fake.browser.tabs.group({ groupId: tab.groupId, tabIds: [moved.id] });
      } else {
        // Firefox does not always name the change: the tab shows it.
        const fakeTab = fake.tabs.get(moved.id);
        assert.ok(fakeTab !== undefined);
        fakeTab.groupId = tab.groupId;
        fake.emitStatus(moved.id, "loading");
      }
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [1], how);
      assert.deepEqual(guard.refusedSince(moved.id, 0), [B], how);
      // A tab event that shows the same group looks nothing up again.
      const looked = gets.calls();
      fake.emitStatus(moved.id, "complete");
      await idle(guard);
      assert.equal(gets.calls(), looked, how);
    }
  });

  it("waiting for its load's tab to be tied, is refused for the tab and its opener", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    hop(fake, { tabId: window.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
    opens(fake, tab, window);
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("is refused, and recorded, when its load's tab cannot be looked up", async () => {
    const { fake, clock, guard, tabIn } = setup();
    await tabIn("s1");
    hop(fake, { tabId: 999, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(999, 0), [B]);
  });

  it("is matched with every load of its address when its start cannot be read", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, timeStamp: 5000 });
    clock.now = 5010;
    fake.emitDownloadCreated({
      id: 1,
      url: `${B}/export`,
      filename: "/home/user/Downloads/export.csv",
      state: "in_progress",
      startTime: "not a time",
    });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("is untouched when Foxleash started it, or comes from no web address", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    // A flood mark would refuse every other download.
    const flooding = await tabIn("s1");
    flood(fake, flooding.id, 1000);
    hop(fake, { tabId: flooding.id, requestId: "over", url: `${B}/over`, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004, byExtensionId: FAKE_EXTENSION_ID });
    download(fake, { id: 2, started: 1004, byExtensionId: "other@example.org" });
    download(fake, { id: 3, url: "blob:moz-extension://x/y", started: 1004 });
    download(fake, { id: 4, url: "data:text/csv,a", started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [2]);
  });

  it("is matched with a load that refused another download of its address", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    // The same load reported twice counts once against the cap.
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    hop(fake, { tabId: tab.id, timeStamp: 1001 });
    for (let index = 1; index < MAX_TAB_HOPS; index += 1) {
      hop(fake, { tabId: tab.id, requestId: `f${index}`, url: `${A}/f${index}`, timeStamp: 1002 });
    }
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    download(fake, { id: 2, started: 1004 });
    // No flood mark refuses it.
    download(fake, { id: 3, url: `${C}/own`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1, 2]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("is refused after a download of its address from a window the page opened and closed", async () => {
    for (const order of ["past the cap", "download first"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const popup = fake.openTab({ url: "about:blank" });
      opens(fake, tab, popup);
      await idle(guard);
      // The other site's worker holds this load of the agent's tab.
      hop(fake, { tabId: tab.id, requestId: "held", timeStamp: 1000 });
      const decoy = () => hop(fake, { tabId: popup.id, requestId: "decoy", timeStamp: 1200 });
      if (order === "past the cap") {
        flood(fake, popup.id, 1100);
        decoy();
      }
      clock.now = 1210;
      download(fake, { id: 1, started: 1205 });
      await idle(guard);
      // Reported after its own download.
      if (order === "download first") decoy();
      clock.now = 1300;
      fake.removeTab(popup.id);
      await idle(guard);
      // The worker answers the held load once the window's loads are gone.
      clock.now = 1300 + HOP_GRACE_MS;
      download(fake, { id: 2, started: 1300 + HOP_GRACE_MS - 5 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [1, 2], order);
      assert.deepEqual(guard.refusedSince(tab.id, 0), [B], order);
    }
  });

  it("is matched with a load that ended otherwise, for HOP_GRACE_MS", async () => {
    for (const event of ["onCompleted", "onErrorOccurred"] as const) {
      for (const [later, matched] of [
        [HOP_GRACE_MS - 1, true],
        [HOP_GRACE_MS, false],
      ] as const) {
        const { fake, clock, guard, tabIn } = setup();
        const tab = await tabIn("s1");
        hop(fake, { tabId: tab.id, requestId: "h1", timeStamp: 1000 });
        hop(fake, { tabId: tab.id, requestId: "h2", url: `${B}/2`, timeStamp: 1000 });
        clock.now = 1010;
        const ended = { requestId: "h1", tabId: tab.id, timeStamp: 1005 };
        if (event === "onCompleted") {
          fake.emitWebRequest(event, { ...ended, statusCode: 200, fromCache: false });
        } else {
          fake.emitWebRequest(event, { ...ended, error: "NS_BINDING_ABORTED" });
        }
        clock.now = 1010 + later;
        download(fake, { id: 1, started: 1004 });
        download(fake, { id: 2, url: `${B}/2`, started: 1004 });
        await idle(guard);
        assert.deepEqual(fake.cancelledDownloads, matched ? [1, 2] : [2], `${event} ${later}`);
      }
    }
  });

  it("whose file is not removed is reported to nobody, and logged", async (t) => {
    const warned = warnings(t);
    for (const how of ["removal fails", "gone from the list", "still in progress"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      hop(fake, { tabId: tab.id, timeStamp: 1000 });
      clock.now = 1010;
      if (how === "removal fails") fake.failRemoveFile(new Error("Cannot remove"));
      if (how === "still in progress") fake.failCancel(new Error("Cancel failed"));
      download(fake, {
        id: 7,
        started: 1004,
        state: how === "removal fails" ? "complete" : undefined,
      });
      if (how === "gone from the list") fake.downloads.delete(7);
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [7], how);
      assert.deepEqual(guard.refusedSince(tab.id, 0), [], how);
      assert.deepEqual(heard, [], how);
    }
    assert.deepEqual(warned(), [
      { event: "file_guard_download_kept", id: 7 },
      { event: "file_guard_download_kept", id: 7 },
      { event: "file_guard_download_kept", id: 7 },
    ]);
  });

  it("is refused once when a load arrives while its own judgement waits", async (t) => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const slow = await tabIn("s1");
    const held = holdGets(t, fake, slow.id);
    hop(fake, { tabId: slow.id, requestId: "h1", timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard, false);
    hop(fake, { tabId: tab.id, requestId: "h2", timeStamp: 1001 });
    await idle(guard, false);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    held.release();
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(slow.id, 0), []);
  });

  it("of two of one address reported before the load, both are refused by it", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    download(fake, { id: 2, started: 1004 });
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1, 2]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });
});

describe("a load of a refused download's address heard after it", { timeout: 10000 }, () => {
  it("hears of the refusal when a closed tab's load refused it first", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const first = await tabIn("s1");
    const second = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    hop(fake, { tabId: first.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    clock.now = 1100;
    fake.removeTab(first.id);
    clock.now = 1200;
    download(fake, { id: 2, started: 1160 });
    await idle(guard);
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1150 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1, 2]);
    assert.deepEqual(heard, [
      [first.id, B, 0],
      [first.id, B, 0],
      [second.id, B, 0],
    ]);
    assert.deepEqual(guard.refusedSince(second.id, 0), [B]);
  });

  it("hears of it when it arrives while another load's judgement refuses it", async (t) => {
    const { fake, clock, access, guard, tabIn } = setup();
    const first = await tabIn("s1");
    const second = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    hop(fake, { tabId: first.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    clock.now = 1100;
    fake.removeTab(first.id);
    clock.now = 1200;
    // The verdicts of the two loads, the late one's judged by its hop and by its lookup, wait on one
    // gate, and every later one on the other.
    const view = access.view;
    const verdicts = Promise.withResolvers<void>();
    const later = Promise.withResolvers<void>();
    let views = 0;
    t.mock.method(access, "view", async (session: string) => {
      views += 1;
      await (views <= 3 ? verdicts : later).promise;
      return view(session);
    });
    download(fake, { id: 2, started: 1160 });
    await idle(guard, false);
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1150 });
    await idle(guard, false);
    assert.equal(views, 3);
    const done = tracked(guard.settled());
    verdicts.resolve();
    await idle(guard, false);
    assert.deepEqual(fake.cancelledDownloads, [1, 2]);
    assert.deepEqual(guard.refusedSince(second.id, 0), []);
    // Its judgements end only once it was told.
    assert.equal(done(), false);
    later.resolve();
    await idle(guard);
    assert.equal(done(), true);
    assert.deepEqual(heard, [
      [first.id, B, 0],
      [first.id, B, 0],
      [second.id, B, 0],
    ]);
    assert.deepEqual(guard.refusedSince(second.id, 0), [B]);
  });

  it("hears of it only when it began no later than the download", async () => {
    for (const [timeStamp, told] of [
      [1004.5, true],
      [1005, false],
    ] as const) {
      const { fake, guard, tabIn } = await refusedByLoad();
      const second = await tabIn("s1");
      hop(fake, { tabId: second.id, requestId: "h2", timeStamp });
      await idle(guard);
      assert.deepEqual(guard.refusedSince(second.id, 0), told ? [B] : [], String(timeStamp));
      assert.deepEqual(fake.cancelledDownloads, [1], String(timeStamp));
    }
  });

  it("hears of it for HOP_GRACE_MS from the download's onCreated", async () => {
    for (const [late, told] of [
      [HOP_GRACE_MS - 1, true],
      [HOP_GRACE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = await refusedByLoad();
      const second = await tabIn("s1");
      clock.now = 1010 + late;
      hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1002 });
      await idle(guard);
      assert.deepEqual(guard.refusedSince(second.id, 0), told ? [B] : [], String(late));
    }
  });

  it("hears nothing in a tab whose session may act on the site, or of no session", async () => {
    const { fake, guard, heard, tabIn } = await refusedByLoad();
    const second = await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    await grantSite(fake.browser, B);
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1002 });
    hop(fake, { tabId: own.id, requestId: "h3", timeStamp: 1002 });
    await idle(guard);
    assert.equal(heard.length, 1);
    assert.deepEqual(guard.refusedSince(second.id, 0), []);
    assert.deepEqual(guard.refusedSince(own.id, 0), []);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("is told once per tab and frame, and judged no more once told", async (t) => {
    const { fake, access, guard, first, heard, tabIn } = await refusedByLoad();
    const second = await tabIn("s1");
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1002 });
    await idle(guard);
    const view = t.mock.method(access, "view");
    hop(fake, { tabId: second.id, requestId: "h3", timeStamp: 1003 });
    // The refusing load's own tab and frame.
    hop(fake, { tabId: first.id, requestId: "h4", timeStamp: 1003 });
    await idle(guard);
    assert.equal(view.mock.callCount(), 0);
    hop(fake, {
      tabId: second.id,
      requestId: "h5",
      frameId: 3,
      type: "sub_frame",
      timeStamp: 1003,
    });
    await idle(guard);
    assert.deepEqual(heard, [
      [first.id, B, 0],
      [second.id, B, 0],
      [second.id, B, 3],
    ]);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("hears nothing when the refused download's file is not gone", async (t) => {
    const warned = warnings(t);
    const { fake, guard, heard, tabIn } = await refusedByLoad({
      state: "interrupted",
      exists: true,
    });
    const second = await tabIn("s1");
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1002 });
    await idle(guard);
    assert.deepEqual(heard, []);
    assert.deepEqual(guard.refusedSince(second.id, 0), []);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(warned(), [{ event: "file_guard_download_kept", id: 1 }]);
  });

  it("is told before the guard settles", async (t) => {
    const { fake, access, guard, tabIn } = await refusedByLoad();
    const second = await tabIn("s1");
    const views = holdViews(t, access);
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1002 });
    const done = tracked(guard.settled());
    await idle(guard, false);
    assert.equal(done(), false);
    assert.deepEqual(guard.refusedSince(second.id, 0), []);
    views.release();
    await idle(guard);
    assert.equal(done(), true);
    assert.deepEqual(guard.refusedSince(second.id, 0), [B]);
  });

  it("is told once its tab becomes a session's, with its opener", async () => {
    const { fake, clock, guard, first, heard } = await refusedByLoad();
    const window = fake.openTab({ url: "about:blank" });
    hop(fake, { tabId: window.id, requestId: "h2", timeStamp: 1002 });
    await idle(guard);
    assert.deepEqual(guard.refusedSince(window.id, 0), []);
    clock.now = 1100;
    opens(fake, first, window);
    await idle(guard);
    // A further lookup tells it nothing more.
    opens(fake, first, window);
    await idle(guard);
    assert.deepEqual(heard, [
      [first.id, B, 0],
      [window.id, B, 0],
    ]);
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(first.id, 1100), [B]);
  });

  it("hears nothing of a download a flood mark refused", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const flooding = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    flood(fake, flooding.id, 1000);
    hop(fake, { tabId: flooding.id, requestId: "over", url: `${B}/over`, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    hop(fake, { tabId: tab.id, requestId: "h2", timeStamp: 1002 });
    await idle(guard);
    assert.deepEqual(heard, []);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
  });

  it("of a tab closed before it was heard, is told for the tab's opener", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const opener = await tabIn("s1");
    const other = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    await idle(guard);
    hop(fake, { tabId: other.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(guard.refusedSince(opener.id, 0), []);
    clock.now = 1100;
    fake.removeTab(window.id);
    await idle(guard);
    hop(fake, { tabId: window.id, requestId: "h2", timeStamp: 1002 });
    await idle(guard);
    assert.deepEqual(guard.refusedSince(opener.id, 0), [B]);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("of a tab that cannot be looked up, is told", async () => {
    const { fake, guard } = await refusedByLoad();
    hop(fake, { tabId: 999, requestId: "h2", timeStamp: 1002 });
    await idle(guard);
    assert.deepEqual(guard.refusedSince(999, 0), [B]);
  });

  it("heard in time, is told when its judgement ends after HOP_GRACE_MS", async (t) => {
    const { fake, clock, guard, heard, tabIn } = await refusedByLoad();
    const second = await tabIn("s1");
    const gets = holdGets(t, fake, second.id);
    clock.now = 1010 + HOP_GRACE_MS - 1;
    hop(fake, { tabId: second.id, requestId: "h2", timeStamp: 1002 });
    await idle(guard, false);
    clock.now = 1010 + HOP_GRACE_MS;
    gets.release();
    await idle(guard);
    assert.deepEqual(heard.slice(1), [[second.id, B, 0]]);
  });
});

describe("the loads the guard keeps", { timeout: 10000 }, () => {
  it("are at most MAX_TAB_HOPS per tab; past that, a flood mark refuses by site", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    flood(fake, tab.id, 1000);
    // Not kept: matched by the flood mark only, so nothing is recorded.
    hop(fake, { tabId: tab.id, requestId: "over", url: `${B}/over`, timeStamp: 1500 });
    const other = fake.openTab({ url: `${A}/page` });
    clock.now = 1600;
    download(fake, { id: 1, url: `${B}/over`, started: 1550 });
    download(fake, { id: 2, url: `${C}/own`, started: 1550 });
    download(fake, { id: 3, url: `${A}/own`, started: 1550 });
    // Begun before the mark.
    download(fake, { id: 4, url: `${C}/before`, started: 1499 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1, 2]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
    assert.deepEqual(guard.refusedSince(other.id, 0), []);
    assert.deepEqual(heard, []);
  });

  it("keep a flood mark when the count falls, until HOP_AGE_MS after the last load over the cap", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    flood(fake, tab.id, 1000);
    hop(fake, { tabId: tab.id, requestId: "over-1", url: `${B}/over`, timeStamp: 1500 });
    hop(fake, { tabId: tab.id, requestId: "over-2", url: `${B}/over`, timeStamp: 1700 });
    clock.now = 1800;
    for (let index = 0; index < MAX_TAB_HOPS; index += 1) {
      fake.emitWebRequest("onErrorOccurred", {
        requestId: `f${index}`,
        tabId: tab.id,
        timeStamp: 1800,
        error: "NS_BINDING_ABORTED",
      });
    }
    clock.now = 1800 + HOP_GRACE_MS;
    download(fake, { id: 1, url: `${C}/a`, started: 1500 });
    await idle(guard);
    clock.now = 1700 + HOP_AGE_MS;
    download(fake, { id: 2, url: `${C}/b`, started: 1500 });
    await idle(guard);
    clock.now = 1701 + HOP_AGE_MS;
    download(fake, { id: 3, url: `${C}/c`, started: 1500 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1, 2]);
  });

  it("of a closed tab, flood mark included, go HOP_GRACE_MS after it closed", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const flooding = await tabIn("s1");
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    hop(fake, { tabId: tab.id, requestId: "h2", url: `${B}/second`, timeStamp: 1000 });
    flood(fake, flooding.id, 1000);
    hop(fake, { tabId: flooding.id, requestId: "over", url: `${B}/over`, timeStamp: 1500 });
    clock.now = 2000;
    fake.removeTab(tab.id);
    fake.removeTab(flooding.id);
    clock.now = 2000 + HOP_GRACE_MS - 1;
    download(fake, { id: 1, started: 1600 });
    download(fake, { id: 2, url: `${C}/a`, started: 1600 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads.toSorted(), [1, 2]);
    clock.now = 2000 + HOP_GRACE_MS;
    download(fake, { id: 3, url: `${C}/b`, started: 1600 });
    download(fake, { id: 4, url: `${B}/second`, started: 1600 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads.toSorted(), [1, 2]);
  });

  it("of a tab of no session set a flood mark that refuses nothing", async () => {
    const { fake, clock, guard, tabIn } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    flood(fake, own.id, 1000);
    hop(fake, { tabId: own.id, requestId: "over", url: `${B}/over`, timeStamp: 1500 });
    clock.now = 1600;
    download(fake, { id: 1, url: `${C}/a`, started: 1550 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("of a tab tied after the download set a flood mark that refuses it", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    flood(fake, window.id, 1000);
    hop(fake, { tabId: window.id, requestId: "over", timeStamp: 1001 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1005 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
    opens(fake, tab, window);
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("of a tab tied while its first lookup runs set a flood mark that refuses its download", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    flood(fake, window.id, 1000);
    hop(fake, { tabId: window.id, requestId: "over", timeStamp: 1001 });
    opens(fake, tab, window);
    clock.now = 1010;
    download(fake, { id: 1, started: 1005 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("of a tab that cannot be looked up set a flood mark that refuses every site", async () => {
    const { fake, clock, guard, tabIn } = setup();
    await tabIn("s1");
    flood(fake, 999, 1000);
    hop(fake, { tabId: 999, requestId: "over", url: `${B}/over`, timeStamp: 1500 });
    clock.now = 1600;
    download(fake, { id: 1, url: `${A}/own`, started: 1550 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("of a session whose sites cannot be read set a flood mark that refuses every site", async (t) => {
    const { fake, clock, access, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    flood(fake, tab.id, 1000);
    hop(fake, { tabId: tab.id, requestId: "over", url: `${B}/over`, timeStamp: 1500 });
    t.mock.method(access, "view", async () => {
      throw new Error("The session stopped");
    });
    clock.now = 1600;
    download(fake, { id: 1, url: `${A}/own`, started: 1550 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("go once HOP_AGE_MS old", async () => {
    for (const [age, matched] of [
      [HOP_AGE_MS - 1, true],
      [HOP_AGE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      hop(fake, { tabId: tab.id, timeStamp: 1000 });
      clock.now = 1000 + age;
      download(fake, { id: 1, started: 1000 + age - 5 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, matched ? [1] : [], String(age));
    }
  });

  it("of a tab of no session go once HOP_GRACE_MS old", async () => {
    for (const [age, matched] of [
      [HOP_GRACE_MS - 1, true],
      [HOP_GRACE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const moved = fake.openTab({ url: `${A}/page` });
      hop(fake, { tabId: moved.id, timeStamp: 1000 });
      await idle(guard);
      // Moved without a word of it: only a download's own lookup sees it.
      const fakeTab = fake.tabs.get(moved.id);
      assert.ok(fakeTab !== undefined);
      fakeTab.groupId = tab.groupId;
      clock.now = 1000 + age;
      download(fake, { id: 1, started: 1004 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, matched ? [1] : [], String(age));
    }
  });

  it("of a burst share one lookup, and a tie while it runs looks the tab up again", async (t) => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    const held = holdGets(t, fake, window.id);
    for (const requestId of ["h1", "h2", "h3"]) {
      hop(fake, { tabId: window.id, requestId, url: `${B}/${requestId}`, timeStamp: 1000 });
    }
    await flush();
    assert.equal(held.calls(), 1);
    opens(fake, tab, window);
    held.release();
    await idle(guard);
    assert.equal(held.calls(), 2);
    // The second lookup's outcome serves the download.
    clock.now = 1010;
    download(fake, { id: 1, url: `${B}/h1`, started: 1004 });
    await idle(guard);
    assert.equal(held.calls(), 2);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    // A load after both settled starts one more, which the next load shares.
    hop(fake, { tabId: window.id, requestId: "h4", url: `${B}/h4`, timeStamp: 1005 });
    hop(fake, { tabId: window.id, requestId: "h5", url: `${B}/h5`, timeStamp: 1005 });
    await idle(guard);
    assert.equal(held.calls(), 3);
  });

  it("left with nothing while their lookup runs keep sharing it", async (t) => {
    const { fake, tabIn } = setup();
    const tab = await tabIn("s1");
    const held = holdGets(t, fake, tab.id);
    hop(fake, { tabId: tab.id, requestId: "r1", timeStamp: 1000 });
    // The load became a page: the header layer has it, and the tab keeps no load.
    respondOnce(fake, { tabId: tab.id, responseHeaders: HTML });
    // Another tab's load runs the pruning.
    const other = fake.openTab({ url: `${A}/page` });
    hop(fake, { tabId: other.id, url: `${A}/next`, timeStamp: 1001 });
    hop(fake, { tabId: tab.id, requestId: "r2", timeStamp: 1002 });
    await flush();
    assert.equal(held.calls(), 1);
    held.release();
  });

  it("of a tab closed before its load reached the guard are judged by the tab's opener", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const own = fake.openTab({ url: `${A}/page` });
    const fromSession = fake.openTab({ url: "about:blank" });
    opens(fake, tab, fromSession);
    const fromOwn = fake.openTab({ url: "about:blank" });
    opens(fake, own, fromOwn);
    const closedSession = await tabIn("s1");
    await flush();
    clock.now = 1000;
    for (const closing of [fromSession, fromOwn, closedSession]) fake.removeTab(closing.id);
    clock.now = 1010;
    hop(fake, { tabId: fromSession.id, requestId: "h1", url: `${B}/1`, timeStamp: 1000 });
    hop(fake, { tabId: fromOwn.id, requestId: "h2", url: `${B}/2`, timeStamp: 1000 });
    hop(fake, { tabId: closedSession.id, requestId: "h3", url: `${B}/3`, timeStamp: 1000 });
    for (const id of [1, 2, 3]) download(fake, { id, url: `${B}/${id}`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads.toSorted(), [1, 3]);
    assert.deepEqual(guard.refusedSince(fromSession.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("whose commit came first end at once, and still match for HOP_GRACE_MS", async () => {
    for (const [later, matched] of [
      [HOP_GRACE_MS - 1, true],
      [HOP_GRACE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 4, url: `${B}/page`, timeStamp: 1005 });
      clock.now = 1001;
      hop(fake, { tabId: tab.id, frameId: 4, url: `${B}/page`, timeStamp: 1005 });
      clock.now = 1001 + later;
      download(fake, { id: 1, url: `${B}/page`, started: 1006 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, matched ? [1] : [], String(later));
    }
  });

  it("are not ended by a commit of another frame, or one older than the load", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    clock.now = 1000;
    fake.emitCommitted({ tabId: tab.id, frameId: 5, url: `${B}/page`, timeStamp: 1010 });
    fake.emitCommitted({ tabId: tab.id, frameId: 4, url: `${B}/page`, timeStamp: 1004 });
    fake.emitCommitted({ tabId: tab.id, frameId: 4, url: `${B}/other`, timeStamp: 1010 });
    fake.emitCommitted({ tabId: -1, frameId: 4, url: `${B}/page`, timeStamp: 1010 });
    fake.emitCommitted({ tabId: tab.id, frameId: 4, url: "about:blank", timeStamp: 1010 });
    hop(fake, { tabId: tab.id, frameId: 4, url: `${B}/page`, timeStamp: 1005 });
    clock.now = 1000 + HOP_GRACE_MS + 1;
    download(fake, { id: 1, url: `${B}/page`, started: 1006 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("are only of tabs, and only of web addresses", async (t) => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const looked: number[] = [];
    const get = fake.browser.tabs.get;
    t.mock.method(fake.browser.tabs, "get", (tabId: number) => {
      looked.push(tabId);
      return get(tabId);
    });
    hop(fake, { tabId: -1, timeStamp: 1000 });
    hop(fake, { tabId: tab.id, url: "ftp://b.example/export", timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(looked, []);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("are kept only once a session ran, by listeners that do not block", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = fake.openTab({ url: `${A}/page` });
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.equal(fake.committedListenerCount(), 0);
    await tabIn("s1");
    assert.equal(fake.committedListenerCount(), 1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), REGISTRATIONS);
    download(fake, { id: 2, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });
});

describe("the guard's bounds, at their edges", { timeout: 10000 }, () => {
  it("keeps a load of a tab whose id is 0: only a negative id means no tab", async (t) => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const get = fake.browser.tabs.get;
    t.mock.method(fake.browser.tabs, "get", async (tabId: number) =>
      tabId === 0 ? { ...(await get(tab.id)), id: 0 } : get(tabId),
    );
    hop(fake, { tabId: 0, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("checks a waiting download against a load of a tab that cannot be looked up", async () => {
    const { fake, clock, guard, tabIn } = setup();
    await tabIn("s1");
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    hop(fake, { tabId: 999, timeStamp: 1000 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("checks a waiting download against a flood mark set after it", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    clock.now = 1010;
    download(fake, { id: 1, url: `${C}/own`, started: 1004 });
    await idle(guard);
    flood(fake, tab.id, 1000);
    hop(fake, { tabId: tab.id, requestId: "over", url: `${B}/over`, timeStamp: 1001 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("keeps a flood mark's start while a load over the cap comes by its end", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    flood(fake, tab.id, 900);
    clock.now = 1000;
    hop(fake, { tabId: tab.id, requestId: "over-1", url: `${B}/over`, timeStamp: 1000 });
    // The first loads are too old by now: the tab fills up again.
    clock.now = 1000 + HOP_AGE_MS;
    for (let index = 0; index < MAX_TAB_HOPS; index += 1) {
      hop(fake, {
        tabId: tab.id,
        requestId: `g${index}`,
        url: `${A}/g${index}`,
        timeStamp: clock.now,
      });
    }
    hop(fake, { tabId: tab.id, requestId: "over-2", url: `${B}/over`, timeStamp: clock.now });
    download(fake, { id: 1, url: `${C}/own`, started: 1500 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("uses a commit for one load only", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const frame = { tabId: tab.id, frameId: 4, url: `${B}/page` };
    clock.now = 1000;
    fake.emitCommitted({ ...frame, timeStamp: 1010 });
    hop(fake, { ...frame, type: "sub_frame", requestId: "h1", timeStamp: 1005 });
    hop(fake, { ...frame, type: "sub_frame", requestId: "h2", timeStamp: 1006 });
    clock.now = 1000 + HOP_GRACE_MS;
    download(fake, { id: 1, url: `${B}/page`, started: 1007 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("does not keep a commit that ended a load for a later one", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const frame = { tabId: tab.id, frameId: 4, url: `${B}/page` };
    clock.now = 1000;
    hop(fake, { ...frame, type: "sub_frame", requestId: "h1", timeStamp: 1000 });
    fake.emitCommitted({ ...frame, timeStamp: 1050 });
    // Reported after the commit, begun before it.
    hop(fake, { ...frame, type: "sub_frame", requestId: "h2", timeStamp: 1040 });
    clock.now = 1000 + HOP_GRACE_MS;
    download(fake, { id: 1, url: `${B}/page`, started: 1045 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("does not spend a commit on a load too old to match", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const frame = { tabId: tab.id, frameId: 4, url: `${B}/page` };
    hop(fake, { ...frame, type: "sub_frame", requestId: "h1", timeStamp: 1000 });
    clock.now = 1000 + HOP_AGE_MS;
    fake.emitCommitted({ ...frame, timeStamp: 1000 + HOP_AGE_MS });
    // Reported after the commit, begun before it: the commit is this load's.
    hop(fake, { ...frame, type: "sub_frame", requestId: "h2", timeStamp: 999 + HOP_AGE_MS });
    clock.now = 1000 + HOP_AGE_MS + HOP_GRACE_MS;
    download(fake, { id: 1, url: `${B}/page`, started: 1000 + HOP_AGE_MS });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("keeps a commit with no load for HOP_GRACE_MS only", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const frame = { tabId: tab.id, frameId: 4, url: `${B}/page` };
    clock.now = 1000;
    fake.emitCommitted({ ...frame, timeStamp: 1010 });
    clock.now = 1000 + HOP_GRACE_MS;
    hop(fake, { ...frame, type: "sub_frame", timeStamp: 1005 });
    clock.now = 1001 + 2 * HOP_GRACE_MS;
    download(fake, { id: 1, url: `${B}/page`, started: 1006 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("counts a load the header layer took no more against the cap", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    hop(fake, { tabId: tab.id, requestId: "first", url: `${B}/first`, timeStamp: 1000 });
    for (let index = 1; index < MAX_TAB_HOPS; index += 1) {
      hop(fake, { tabId: tab.id, requestId: `f${index}`, url: `${A}/f${index}`, timeStamp: 1000 });
    }
    fake.emitWebRequest(
      "onHeadersReceived",
      response({ tabId: tab.id, requestId: "f1", url: `${A}/f1`, responseHeaders: HTML }),
    );
    hop(fake, { tabId: tab.id, requestId: "next", url: `${C}/next`, timeStamp: 1001 });
    clock.now = 1010;
    download(fake, { id: 1, url: `${B}/first`, started: 1004 });
    download(fake, { id: 2, url: `${C}/next`, started: 1004 });
    await idle(guard);
    // Both by their load, not by a flood mark: both recorded.
    assert.deepEqual(guard.refusedSince(tab.id, 0).toSorted(), [B, C]);
  });

  it("drops a waiting download HOP_GRACE_MS old before a lookup settles", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    hop(fake, { tabId: window.id, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await idle(guard);
    clock.now = 1010 + HOP_GRACE_MS;
    opens(fake, tab, window);
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("refuses a download once when two judgements find the same flood", async (t) => {
    const { fake, clock, access, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    flood(fake, tab.id, 1000);
    hop(fake, { tabId: tab.id, requestId: "over-1", url: `${B}/over`, timeStamp: 1001 });
    await idle(guard);
    const held = holdViews(t, access);
    clock.now = 1010;
    download(fake, { id: 1, url: `${C}/own`, started: 1004 });
    hop(fake, { tabId: tab.id, requestId: "over-2", url: `${B}/over`, timeStamp: 1005 });
    await idle(guard, false);
    held.release();
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("judges a tab closed HOP_GRACE_MS ago as one that cannot be looked up", async () => {
    for (const [later, refused] of [
      [HOP_GRACE_MS - 1, false],
      [HOP_GRACE_MS, true],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      await tabIn("s1");
      const own = fake.openTab({ url: `${A}/page` });
      const fromOwn = fake.openTab({ url: "about:blank" });
      opens(fake, own, fromOwn);
      await flush();
      clock.now = 1000;
      fake.removeTab(fromOwn.id);
      clock.now = 1000 + later;
      hop(fake, { tabId: fromOwn.id, timeStamp: 1000 });
      download(fake, { id: 1, started: 1004 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, refused ? [1] : [], String(later));
    }
  });
});

describe("a file a page builds itself", { timeout: 10000 }, () => {
  it("is cancelled and recorded for the frame of a document of its site the tab showed, shown now or not", async () => {
    for (const listed of [true, false]) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report#top`, timeStamp: 1000 });
      if (listed) fake.setFrames(tab.id, [0, { frameId: 7, url: `${B}/report` }]);
      clock.now = 1040;
      download(fake, { id: 1, url: BLOB, started: 1030 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [1], String(listed));
      assert.deepEqual(heard, [[tab.id, B, 7]], String(listed));
      // Recorded once the file was gone, on the guard's clock, by its site alone.
      assert.deepEqual(guard.refusedSince(tab.id, 1040), [B], String(listed));
      assert.deepEqual(guard.refusedSince(tab.id, 1041), [], String(listed));
    }
  });

  it("from the top frame is recorded for frame 0, unless a page of another site replaced it before the file began", async () => {
    for (const [replacedAt, recorded] of [
      [undefined, true],
      [6000, false],
      [11_000, false],
      // After the file began: the page that built it was still shown.
      [11_001, true],
      // Which of the two came first cannot be told.
      [1000, true],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
      // Another site in a frame replaces nothing.
      fake.emitCommitted({ tabId: tab.id, frameId: 3, url: `${C}/widget`, timeStamp: 2000 });
      if (replacedAt !== undefined) {
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${A}/next`, timeStamp: replacedAt });
      }
      clock.now = 11_010;
      download(fake, { id: 1, url: BLOB, started: 11_000 });
      await idle(guard);
      const label = String(replacedAt);
      assert.deepEqual(fake.cancelledDownloads, [1], label);
      assert.deepEqual(heard, recorded ? [[tab.id, B, 0]] : [], label);
      assert.deepEqual(guard.refusedSince(tab.id, 0), recorded ? [B] : [], label);
    }
  });

  it("is recorded by the tab's top page and its frames as committed, whatever frame showed its site last", async () => {
    for (const [name, events, recorded] of [
      // A frame of the site's own page commits after the page.
      [
        "frame of the top page",
        [
          [0, `${B}/page`, 1000, true],
          [5, `${B}/frame`, 1010, true],
        ],
        0,
      ],
      // The page that replaced it has frames too.
      [
        "replaced",
        [
          [0, `${B}/page`, 1000, true],
          [0, `${A}/next`, 6000, true],
          [3, `${A}/f`, 6500, true],
        ],
        undefined,
      ],
      // The top page is replaced by one of its own site, and the frame with it.
      [
        "frame replaced",
        [
          [0, `${A}/page`, 900, true],
          [7, `${B}/widget`, 1000, true],
          [0, `${A}/next`, 6000, true],
        ],
        undefined,
      ],
      // A page with no site replaces it too.
      [
        "replaced by about:blank",
        [
          [0, `${B}/page`, 1000, true],
          [0, "about:blank", 6000, true],
        ],
        undefined,
      ],
      [
        "replaced by data:",
        [
          [0, `${B}/page`, 1000, true],
          [0, "data:text/html,x", 6000, true],
        ],
        undefined,
      ],
      // A frame with no site replaces nothing.
      [
        "frame with no site",
        [
          [0, `${B}/page`, 1000, true],
          [5, "about:blank", 6000, true],
        ],
        0,
      ],
      // An address the History API set replaces no frame.
      [
        "history",
        [
          [0, `${A}/page`, 900, true],
          [7, `${B}/widget`, 1000, true],
          [0, `${A}/page?q=1`, 6000, false],
        ],
        7,
      ],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      clock.now = 1000;
      for (const [frameId, url, timeStamp, committed] of events) {
        const details = { tabId: tab.id, frameId, url, timeStamp };
        if (committed) fake.emitCommitted(details);
        else fake.emitHistoryStateUpdated(details);
      }
      clock.now = 11_010;
      download(fake, { id: 1, url: BLOB, started: 11_000 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [1], name);
      assert.deepEqual(heard, recorded === undefined ? [] : [[tab.id, B, recorded]], name);
    }
  });

  it("is cancelled when a tab looked up as no session's joined a group since, its frames unread", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const moved = fake.openTab({ url: `${B}/page` });
    fake.setFrames(moved.id, null);
    clock.now = 1000;
    fake.emitCommitted({ tabId: moved.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
    await idle(guard);
    // Moved without a word of it.
    const fakeTab = fake.tabs.get(moved.id);
    assert.ok(fakeTab !== undefined);
    fakeTab.groupId = tab.groupId;
    clock.now = 1500;
    download(fake, { id: 1, url: BLOB, started: 1490 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("is saved when a tab of the user's own that showed its site, or any site, closed a moment ago", async () => {
    for (const url of [BLOB, "blob:null/0b2c5d1e"]) {
      const { fake, clock, guard, tabIn } = setup();
      await tabIn("s1");
      const own = fake.openTab({ url: `${B}/page` });
      clock.now = 1000;
      fake.emitCommitted({ tabId: own.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
      await idle(guard);
      clock.now = 1500;
      fake.removeTab(own.id);
      clock.now = 1790;
      download(fake, { id: 1, url, started: 1780 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [], url);
    }
  });

  it("is recorded for the tab that showed a document of its site last", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const first = await tabIn("s1");
    const last = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    clock.now = 1000;
    fake.emitCommitted({ tabId: first.id, frameId: 3, url: `${B}/a`, timeStamp: 1000 });
    fake.emitCommitted({ tabId: last.id, frameId: 5, url: `${B}/b`, timeStamp: 2000 });
    fake.emitCommitted({ tabId: first.id, frameId: 4, url: `${C}/c`, timeStamp: 3000 });
    clock.now = 3040;
    download(fake, { id: 1, url: BLOB, started: 3030 });
    await idle(guard);
    assert.deepEqual(heard, [[last.id, B, 5]]);
  });

  it("is cancelled and recorded for a frame of its site a tab shows now, however long ago it came", async () => {
    for (const committed of [false, true]) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      clock.now = 1000;
      if (committed) {
        fake.emitCommitted({ tabId: tab.id, frameId: 5, url: `${B}/widget`, timeStamp: 1000 });
      }
      fake.setFrames(tab.id, [
        0,
        { frameId: 4, url: `${A}/frame` },
        { frameId: 5, url: `${B}/widget` },
      ]);
      clock.now = 1000 + DOCUMENT_AGE_MS + 10;
      download(fake, { id: 1, url: BLOB, started: clock.now - 5 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [1], String(committed));
      assert.deepEqual(heard, [[tab.id, B, 5]], String(committed));
    }
  });

  it("is matched with a Blob document of its site that a tab showed or shows", async () => {
    for (const how of ["kept", "shown"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      clock.now = 1000;
      const url = `blob:${B}/9a8b7c6d`;
      if (how === "kept") {
        fake.emitCommitted({ tabId: tab.id, frameId: 7, url, timeStamp: 1000 });
        clock.now = 1040;
      } else {
        fake.setFrames(tab.id, [0, { frameId: 7, url }]);
        clock.now = 1000 + DOCUMENT_AGE_MS + 10;
      }
      download(fake, { id: 1, url: BLOB, started: clock.now - 10 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [1], how);
      assert.deepEqual(heard, [[tab.id, B, 7]], how);
    }
  });

  it("is matched with a document of its site until DOCUMENT_AGE_MS after its last event", async () => {
    for (const [age, matched] of [
      [DOCUMENT_AGE_MS - 1, true],
      [DOCUMENT_AGE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      clock.now = 1000 + age;
      download(fake, { id: 1, url: BLOB, started: 1000 + age - 5 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, matched ? [1] : [], String(age));
    }
  });

  it("is matched with a document whose address the History API changed, from the change on", async () => {
    for (const changed of [true, false]) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      clock.now = 51_000;
      if (changed) {
        fake.emitHistoryStateUpdated({
          tabId: tab.id,
          frameId: 7,
          url: `${B}/report?page=2`,
          timeStamp: 51_000,
        });
      }
      // The frame is gone by the download.
      clock.now = 71_000;
      download(fake, { id: 1, url: BLOB, started: 70_990 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, changed ? [1] : [], String(changed));
    }
  });

  it("is saved when only a tab of the user's own shows or showed its site, and cancelled when a session's tab does too", async () => {
    for (const judgedToo of [false, true]) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      const own = fake.openTab({ url: `${B}/page` });
      clock.now = 1000;
      fake.emitCommitted({ tabId: own.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
      if (judgedToo) {
        fake.emitCommitted({ tabId: tab.id, frameId: 3, url: `${B}/widget`, timeStamp: 900 });
      }
      clock.now = 1040;
      download(fake, { id: 1, url: BLOB, started: 1030 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, judgedToo ? [1] : [], String(judgedToo));
      assert.deepEqual(heard, judgedToo ? [[tab.id, B, 3]] : [], String(judgedToo));
    }
  });

  it("of the user's own, from a site a session's tab shows in a frame, is cancelled too", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    // The user builds the file on the site's page in a tab of their own.
    const own = fake.openTab({ url: `${B}/statements` });
    fake.emitCommitted({ tabId: own.id, frameId: 0, url: `${B}/statements`, timeStamp: 1000 });
    fake.setFrames(tab.id, [0, { frameId: 6, url: `${B}/embed` }]);
    clock.now = 1040;
    download(fake, { id: 1, url: BLOB, started: 1030 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
  });

  it("is saved when the session may act on its site, and cancelled when the session's sites cannot be read", async (t) => {
    for (const how of ["approved", "unreadable"] as const) {
      const { fake, clock, access, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      if (how === "approved") await grantSite(fake.browser, B);
      else {
        t.mock.method(access, "view", async () => {
          throw new Error("The session stopped");
        });
      }
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      fake.setFrames(tab.id, [0, { frameId: 7, url: `${B}/report` }]);
      clock.now = 1040;
      download(fake, { id: 1, url: BLOB, started: 1030 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, how === "approved" ? [] : [1], how);
    }
  });

  it("is judged by its referrer's site when it is no Blob, and saved with no referrer", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    clock.now = 1000;
    fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
    fake.setFrames(tab.id, [0, { frameId: 7, url: `${B}/report` }]);
    clock.now = 1040;
    download(fake, { id: 1, url: "data:text/csv,a", started: 1030 });
    download(fake, { id: 2, url: "data:text/csv,b", started: 1030, referrer: `${B}/report` });
    download(fake, { id: 3, url: "data:text/csv,c", started: 1030, referrer: `${A}/page` });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [2]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("with no origin of its own is cancelled, and recorded nowhere, while a session's tab shows or showed a site it may not act on", async () => {
    for (const [how, cancelled] of [
      ["kept", true],
      ["shown", true],
      ["approved only", false],
      ["own tab only", false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const heard: unknown[][] = [];
      guard.onRefused((...refusal) => heard.push(refusal));
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${A}/page`, timeStamp: 900 });
      fake.setFrames(tab.id, [
        { frameId: 0, url: `${A}/page` },
        { frameId: 2, url: `${A}/f` },
      ]);
      if (how === "kept") {
        fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      } else if (how === "shown") {
        fake.setFrames(tab.id, [
          { frameId: 0, url: `${A}/page` },
          { frameId: 7, url: `${B}/report` },
        ]);
      } else if (how === "own tab only") {
        const own = fake.openTab({ url: `${B}/page` });
        fake.emitCommitted({ tabId: own.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
      }
      clock.now = 1040;
      download(fake, { id: 1, url: "blob:null/0b2c5d1e", started: 1030 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, cancelled ? [1] : [], how);
      assert.deepEqual(guard.refusedSince(tab.id, 0), [], how);
      assert.deepEqual(heard, [], how);
    }
  });

  it("of another add-on, or of a page neither on a site nor in a sandbox, is saved", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    clock.now = 1000;
    fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
    fake.setFrames(tab.id, [0, { frameId: 7, url: `${B}/report` }]);
    clock.now = 1040;
    // Each parses to the origin "null" here.
    download(fake, { id: 1, url: "blob:moz-extension://5d1e0b2c/0b2c5d1e", started: 1030 });
    download(fake, { id: 2, url: "blob:file:///0b2c5d1e", started: 1030 });
    download(fake, { id: 3, url: "blob:nullx/0b2c5d1e", started: 1030 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("with no origin of its own is cancelled during a document flood of a session's tab", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    floodSites(fake, clock, tab.id);
    download(fake, { id: 1, url: "blob:null/0b2c5d1e", started: clock.now - 5 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
  });

  it("is untouched when Foxleash built it", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
    fake.setFrames(tab.id, [0, { frameId: 7, url: `${B}/report` }]);
    clock.now = 1040;
    download(fake, { id: 1, url: BLOB, started: 1030, byExtensionId: FAKE_EXTENSION_ID });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, []);
  });

  it("is judged by the tab's session once a tab of no session that showed its site joined a group", async () => {
    for (const lookedUpAgain of [true, false]) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const moved = fake.openTab({ url: `${A}/page` });
      clock.now = 1000;
      fake.emitCommitted({ tabId: moved.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      await idle(guard);
      // Moved without a word of it: a later document of the tab looks it up again.
      const fakeTab = fake.tabs.get(moved.id);
      assert.ok(fakeTab !== undefined);
      fakeTab.groupId = tab.groupId;
      if (lookedUpAgain) {
        fake.emitCommitted({ tabId: moved.id, frameId: 3, url: `${A}/frame`, timeStamp: 1001 });
        await idle(guard);
      }
      // A tab of no session keeps a document HOP_GRACE_MS only.
      clock.now = 1000 + HOP_GRACE_MS;
      download(fake, { id: 1, url: BLOB, started: clock.now - 5 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, lookedUpAgain ? [1] : [], String(lookedUpAgain));
    }
  });

  it("is saved when its tab's frames cannot be read or the tabs cannot be listed, unless a document was kept", async (t) => {
    for (const [how, kept] of [
      ["discarded", false],
      ["discarded", true],
      ["unlisted", false],
      ["unlisted", true],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      if (how === "discarded") fake.setFrames(tab.id, null);
      else {
        fake.setFrames(tab.id, [0, { frameId: 7, url: `${B}/report` }]);
        t.mock.method(fake.browser.tabs, "query", async () => {
          throw new Error("No tabs");
        });
      }
      clock.now = 1000;
      if (kept) {
        fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      }
      clock.now = 1040;
      download(fake, { id: 1, url: BLOB, started: 1030 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, kept ? [1] : [], `${how} ${kept}`);
      t.mock.restoreAll();
    }
  });

  it("is cancelled when a tab that shows its site cannot be looked up", async (t) => {
    const { fake, clock, groups, guard, tabIn } = setup();
    await tabIn("s1");
    const own = fake.openTab({ url: `${B}/page` });
    t.mock.method(groups, "rememberedSessionOf", async () => {
      throw new Error("Storage cannot be read");
    });
    clock.now = 1040;
    download(fake, { id: 1, url: BLOB, started: 1030 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(own.id, 0), [B]);
  });

  it("is cancelled, and recorded, when a tab that showed its site cannot be looked up", async () => {
    const { fake, clock, guard, tabIn } = setup();
    await tabIn("s1");
    clock.now = 1000;
    fake.emitCommitted({ tabId: 999, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
    clock.now = 1040;
    download(fake, { id: 1, url: BLOB, started: 1030 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.deepEqual(guard.refusedSince(999, 0), [B]);
  });

  it("of a closed tab's documents is matched until HOP_GRACE_MS after it closed", async () => {
    for (const [later, matched] of [
      [HOP_GRACE_MS - 1, true],
      [HOP_GRACE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const flooding = await tabIn("s1");
      clock.now = 1000;
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
      sites(fake, flooding.id, 1000);
      fake.emitCommitted({ tabId: flooding.id, frameId: 1, url: `${C}/over`, timeStamp: 1500 });
      const closedAt = 2000;
      clock.now = closedAt;
      fake.removeTab(tab.id);
      fake.removeTab(flooding.id);
      clock.now = closedAt + later;
      download(fake, { id: 1, url: BLOB, started: closedAt + 1 });
      download(fake, { id: 2, url: `blob:${C}/0b2c`, started: closedAt + 1 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads.toSorted(), matched ? [1, 2] : [], String(later));
    }
  });

  it("is matched with a closed window's document taken before its judgement awaited", async (t) => {
    const { fake, clock, access, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, tab, window);
    clock.now = 1000;
    fake.emitCommitted({ tabId: window.id, frameId: 0, url: `${B}/page`, timeStamp: 1000 });
    await idle(guard);
    const held = holdViews(t, access);
    clock.now = 1040;
    download(fake, { id: 1, url: BLOB, started: 1030 });
    fake.removeTab(window.id);
    // Prunes the window's entry while the judgement waits.
    clock.now = 1040 + HOP_GRACE_MS;
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: `${A}/next`, timeStamp: clock.now });
    await idle(guard, false);
    held.release();
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    // Recorded for the window, and so for the tab that opened it.
    assert.deepEqual(guard.refusedSince(window.id, 0), [B]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("is waited for by settled, through its judgement and its refusal", async (t) => {
    for (const what of ["sites", "cancel"] as const) {
      const { fake, clock, access, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      fake.emitCommitted({ tabId: tab.id, frameId: 7, url: `${B}/report`, timeStamp: 1000 });
      await idle(guard);
      let release: () => void;
      if (what === "sites") release = holdViews(t, access).release;
      else {
        const gate = Promise.withResolvers<void>();
        const cancel = fake.browser.downloads.cancel;
        t.mock.method(fake.browser.downloads, "cancel", async (id: number) => {
          await gate.promise;
          return cancel(id);
        });
        release = () => gate.resolve();
      }
      clock.now = 1040;
      download(fake, { id: 1, url: BLOB, started: 1030 });
      const done = tracked(guard.settled());
      await idle(guard, false);
      assert.equal(done(), false, what);
      release();
      await idle(guard);
      assert.equal(done(), true, what);
      assert.deepEqual(fake.cancelledDownloads, [1], what);
      t.mock.restoreAll();
    }
  });
});

describe("the documents the guard keeps", { timeout: 10000 }, () => {
  it("are at most MAX_TAB_SITES sites per tab; past that, a flood mark refuses by site and records nothing", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const heard: unknown[][] = [];
    guard.onRefused((...refusal) => heard.push(refusal));
    clock.now = 1000;
    sites(fake, tab.id, 1000);
    fake.emitCommitted({ tabId: tab.id, frameId: 1, url: `${C}/over`, timeStamp: 1500 });
    const other = fake.openTab({ url: `${A}/page` });
    clock.now = 1600;
    download(fake, { id: 1, url: `blob:${C}/1`, started: 1550 });
    download(fake, { id: 2, url: `blob:${B}/2`, started: 1550 });
    download(fake, { id: 3, url: `blob:${A}/3`, started: 1550 });
    // Begun before the mark, and as it began.
    download(fake, { id: 4, url: `blob:${C}/4`, started: 1499 });
    download(fake, { id: 5, url: `blob:${C}/5`, started: 1500 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads.toSorted(), [1, 2, 5]);
    assert.deepEqual(guard.refusedSince(tab.id, 0), []);
    assert.deepEqual(guard.refusedSince(other.id, 0), []);
    assert.deepEqual(heard, []);
  });

  it("keep a flood mark when they age out, until DOCUMENT_AGE_MS after the last site over the cap", async () => {
    for (const [at, cancelled] of [
      [1500 + DOCUMENT_AGE_MS, true],
      [1501 + DOCUMENT_AGE_MS, false],
    ] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1000;
      sites(fake, tab.id, 1000);
      fake.emitCommitted({ tabId: tab.id, frameId: 1, url: `${C}/over`, timeStamp: 1200 });
      fake.emitCommitted({ tabId: tab.id, frameId: 1, url: `${B}/over`, timeStamp: 1500 });
      // Looked up: an entry whose lookup runs is kept whatever it holds.
      await idle(guard);
      clock.now = at;
      download(fake, { id: 1, url: `blob:${C}/1`, started: 1300 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, cancelled ? [1] : [], String(at));
    }
  });

  it("make room for a new site once they age out, also at an address the History API set", async () => {
    for (const event of ["commit", "history"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1000;
      sites(fake, tab.id, 1000);
      clock.now = 1000 + DOCUMENT_AGE_MS;
      const details = { tabId: tab.id, frameId: 0, url: `${A}/next`, timeStamp: clock.now };
      if (event === "commit") fake.emitCommitted(details);
      else fake.emitHistoryStateUpdated(details);
      download(fake, { id: 1, url: BLOB, started: clock.now });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [], event);
    }
  });

  it("set no flood mark for a site they keep, or for many addresses of one site", async () => {
    for (const how of ["refreshed", "history"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      clock.now = 1000;
      if (how === "refreshed") {
        sites(fake, tab.id, 1000);
        fake.emitCommitted({
          tabId: tab.id,
          frameId: 2,
          url: "https://s0.example/",
          timeStamp: 1500,
        });
      } else {
        for (let index = 0; index < 300; index += 1) {
          fake.emitHistoryStateUpdated({
            tabId: tab.id,
            frameId: 0,
            url: `${A}/search?q=${index}`,
            timeStamp: 1000 + index,
          });
        }
      }
      clock.now = 1600;
      download(fake, { id: 1, url: `blob:${C}/1`, started: 1550 });
      await idle(guard);
      assert.deepEqual(fake.cancelledDownloads, [], how);
    }
  });

  it("and the loads it keeps set flood marks that refuse only their own kind of download", async () => {
    const { fake, clock, guard, tabIn } = setup();
    const loads = await tabIn("s1");
    const documents = await tabIn("s1");
    flood(fake, loads.id, 1000);
    hop(fake, { tabId: loads.id, requestId: "over", url: `${B}/over`, timeStamp: 1000 });
    clock.now = 1000;
    sites(fake, documents.id, 1000);
    fake.emitCommitted({ tabId: documents.id, frameId: 1, url: `${B}/over`, timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, url: `blob:${C}/built`, started: 1004 });
    download(fake, { id: 2, url: `${C}/load`, started: 1004 });
    await idle(guard);
    assert.deepEqual(fake.cancelledDownloads.toSorted(), [1, 2]);
    // Each mark alone.
    const only = setup();
    const hopTab = await only.tabIn("s1");
    flood(only.fake, hopTab.id, 1000);
    hop(only.fake, { tabId: hopTab.id, requestId: "over", url: `${B}/over`, timeStamp: 1000 });
    only.clock.now = 1010;
    download(only.fake, { id: 1, url: `blob:${C}/built`, started: 1004 });
    await idle(only.guard);
    assert.deepEqual(only.fake.cancelledDownloads, []);
    const other = setup();
    const documentTab = await other.tabIn("s1");
    other.clock.now = 1000;
    sites(other.fake, documentTab.id, 1000);
    other.fake.emitCommitted({
      tabId: documentTab.id,
      frameId: 1,
      url: `${B}/over`,
      timeStamp: 1000,
    });
    other.clock.now = 1010;
    download(other.fake, { id: 2, url: `${C}/load`, started: 1004 });
    await idle(other.guard);
    assert.deepEqual(other.fake.cancelledDownloads, []);
  });

  it("are only of tabs, a tab whose id is 0 included", async () => {
    for (const [tabId, kept] of [
      [-1, false],
      [0, true],
    ] as const) {
      for (const event of ["commit", "history"] as const) {
        const { fake, clock, guard, tabIn } = setup();
        await tabIn("s1");
        clock.now = 1000;
        const details = { tabId, frameId: 0, url: `${B}/page`, timeStamp: 1000 };
        if (event === "commit") fake.emitCommitted(details);
        else fake.emitHistoryStateUpdated(details);
        clock.now = 1040;
        // Tab 0 cannot be looked up, which lets no file through.
        download(fake, { id: 1, url: BLOB, started: 1030 });
        await idle(guard);
        assert.deepEqual(fake.cancelledDownloads, kept ? [1] : [], `${tabId} ${event}`);
      }
    }
  });

  it("are kept once a session ran, by one more listener that does not block", async () => {
    const { fake, tabIn } = setup();
    assert.equal(fake.navigationListenerCount(), 0);
    await tabIn("s1");
    assert.equal(fake.navigationListenerCount(), 1);
    assert.equal(fake.committedListenerCount(), 1);
    await tabIn("s2");
    assert.equal(fake.navigationListenerCount(), 1);
  });
});

describe("settled", { timeout: 10000 }, () => {
  it("resolves at once when no download is judged", async () => {
    const { guard } = setup();
    const done = tracked(guard.settled());
    await flush();
    assert.equal(done(), true);
  });

  it("waits for a judgement that waits for a tab lookup or the session's sites", async (t) => {
    for (const what of ["tab", "sites"] as const) {
      const { fake, clock, access, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      const held = what === "tab" ? holdGets(t, fake, tab.id) : holdViews(t, access);
      hop(fake, { tabId: tab.id, timeStamp: 1000 });
      clock.now = 1010;
      download(fake, { id: 1, started: 1004 });
      const done = tracked(guard.settled());
      await flush();
      await flush();
      assert.equal(done(), false, what);
      held.release();
      await idle(guard);
      assert.equal(done(), true, what);
      assert.deepEqual(fake.cancelledDownloads, [1], what);
    }
  });

  it("waits for the cancel and the removal of a download refused by a load or a flood", async (t) => {
    for (const what of ["flood", "cancel", "removal"] as const) {
      const { fake, clock, guard, tabIn } = setup();
      const tab = await tabIn("s1");
      if (what === "flood") {
        flood(fake, tab.id, 1000);
        hop(fake, { tabId: tab.id, requestId: "over", url: `${B}/over`, timeStamp: 1001 });
      } else {
        hop(fake, { tabId: tab.id, timeStamp: 1000 });
      }
      await idle(guard);
      const gate = Promise.withResolvers<void>();
      const method = what === "removal" ? "removeFile" : "cancel";
      const original = fake.browser.downloads[method];
      t.mock.method(fake.browser.downloads, method, async (id: number) => {
        await gate.promise;
        return original(id);
      });
      clock.now = 1010;
      const url = what === "flood" ? `${C}/own` : `${B}/export`;
      download(fake, {
        id: 1,
        url,
        started: 1004,
        state: what === "removal" ? "complete" : undefined,
      });
      await flush();
      const done = tracked(guard.settled());
      await idle(guard, false);
      assert.equal(done(), false, what);
      gate.resolve();
      await idle(guard);
      assert.equal(done(), true, what);
      assert.deepEqual(fake.cancelledDownloads, [1], what);
    }
  });

  it("waits for a refusal of the same download that a judgement begun after it made", async (t) => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    const slow = await tabIn("s1");
    const held = holdGets(t, fake, slow.id);
    hop(fake, { tabId: slow.id, requestId: "h1", timeStamp: 1000 });
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await flush();
    const done = tracked(guard.settled());
    const gate = Promise.withResolvers<void>();
    const cancel = fake.browser.downloads.cancel;
    t.mock.method(fake.browser.downloads, "cancel", async (id: number) => {
      await gate.promise;
      return cancel(id);
    });
    hop(fake, { tabId: tab.id, requestId: "h2", timeStamp: 1001 });
    await idle(guard, false);
    held.release();
    await idle(guard, false);
    // The download's own judgement found it refused by the other one, whose cancel is held.
    assert.equal(done(), false);
    gate.resolve();
    await idle(guard, false);
    assert.equal(done(), true);
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
  });

  it("does not wait for a download waiting for its load, or a judgement begun after it", async (t) => {
    const { fake, clock, guard, tabIn } = setup();
    const tab = await tabIn("s1");
    clock.now = 1010;
    download(fake, { id: 1, started: 1004 });
    await flush();
    const done = tracked(guard.settled());
    holdGets(t, fake, tab.id);
    hop(fake, { tabId: tab.id, timeStamp: 1000 });
    await flush();
    await flush();
    assert.equal(done(), true);
    assert.deepEqual(fake.cancelledDownloads, []);
  });
});

/** Fires `onBeforeRequest` for a page or frame load: B's export in the top frame by default. */
function hop(
  fake: FakeBrowser,
  details: Partial<RequestDetails> & { tabId: number; timeStamp: number },
): void {
  fake.emitWebRequest("onBeforeRequest", {
    requestId: "h1",
    frameId: 0,
    url: `${B}/export`,
    method: "GET",
    type: "main_frame",
    ...details,
  });
}

/**
 * Lists a download Firefox began, of B's export by default, and fires `downloads.onCreated`. Firefox
 * gives a file a page built itself no referrer.
 */
function download(
  fake: FakeBrowser,
  {
    id,
    url = `${B}/export`,
    started,
    state = "in_progress",
    ...rest
  }: {
    id: number;
    url?: string;
    started: number;
    state?: string | undefined;
    byExtensionId?: string;
    exists?: boolean;
    referrer?: string;
  },
): void {
  fake.emitDownloadCreated({
    id,
    url,
    filename: `/home/user/Downloads/file-${id}`,
    state,
    startTime: new Date(started).toISOString(),
    ...rest,
  });
}

/** MAX_TAB_HOPS loads in the tab, of A's pages. */
function flood(fake: FakeBrowser, tabId: number, timeStamp: number): void {
  for (let index = 0; index < MAX_TAB_HOPS; index += 1) {
    hop(fake, { tabId, requestId: `f${index}`, url: `${A}/f${index}`, timeStamp });
  }
}

/** Commits, at `timeStamp`, documents of MAX_TAB_SITES sites other than A, B and C in the tab. */
function sites(fake: FakeBrowser, tabId: number, timeStamp: number): void {
  for (let index = 0; index < MAX_TAB_SITES; index += 1) {
    fake.emitCommitted({ tabId, frameId: 1, url: `https://s${index}.example/`, timeStamp });
  }
}

/**
 * Sets the tab's document flood mark, from 1500 on, with documents of MAX_TAB_SITES sites at 1000
 * and one of C at 1500, and leaves the clock where those documents just aged out.
 */
function floodSites(fake: FakeBrowser, clock: { now: number }, tabId: number): void {
  clock.now = 1000;
  sites(fake, tabId, 1000);
  fake.emitCommitted({ tabId, frameId: 1, url: `${C}/over`, timeStamp: 1500 });
  clock.now = 1000 + DOCUMENT_AGE_MS;
}

/** Lets every pending callback run and, unless `judged` is false, every judgement end. */
async function idle(guard: FileGuard, judged = true): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await flush();
    if (judged) await guard.settled();
  }
}

/** Holds `tabs.get` of the tab until `release`; `calls` counts them. */
function holdGets(t: TestContext, fake: FakeBrowser, tabId: number) {
  const get = fake.browser.tabs.get;
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  t.mock.method(fake.browser.tabs, "get", async (id: number) => {
    if (id !== tabId) return get(id);
    calls += 1;
    await gate.promise;
    return get(id);
  });
  return { calls: () => calls, release: () => gate.resolve() };
}

/** Holds every `access.view` until `release`. */
function holdViews(t: TestContext, access: Pick<SiteAccess, "view">) {
  const view = access.view;
  const gate = Promise.withResolvers<void>();
  t.mock.method(access, "view", async (session: string) => {
    await gate.promise;
    return view(session);
  });
  return { release: () => gate.resolve() };
}

/** Whether the promise has settled, read synchronously. */
function tracked(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return () => done;
}

/** The rejections nobody handled, collected until the test ends. */
function unhandledRejections(t: TestContext): unknown[] {
  const unhandled: unknown[] = [];
  const collect = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", collect);
  t.after(() => {
    process.off("unhandledRejection", collect);
  });
  return unhandled;
}

/** Opens and closes `count` tabs in no group. */
function closeTabs(fake: FakeBrowser, count: number): void {
  for (let i = 0; i < count; i += 1) fake.removeTab(fake.openTab({ url: "about:blank" }).id);
}

/** Fires what Firefox reports when a page in `source` opens `target`, a new tab or window. */
function opens(fake: FakeBrowser, source: FakeTab, target: FakeTab): void {
  fake.emitCreatedNavigationTarget({
    sourceTabId: source.id,
    sourceFrameId: 0,
    tabId: target.id,
    url: target.url,
    timeStamp: 500,
  });
}

/** How the guard answered: at once with nothing, or after its lookup. */
async function verdict(answer: unknown): Promise<"passed at once" | "passed" | "cancelled"> {
  if (answer === undefined) return "passed at once";
  assert.ok(answer instanceof Promise);
  const settled: unknown = await answer;
  if (settled === undefined) return "passed";
  assert.deepEqual(settled, { cancel: true });
  return "cancelled";
}

/** The headers of a response with that Content-Type and, when given, Content-Disposition. */
function page(type: string, disposition?: string): Overrides {
  const responseHeaders: HttpHeader[] = [{ name: "Content-Type", value: type }];
  if (disposition !== undefined) {
    responseHeaders.push({ name: "Content-Disposition", value: disposition });
  }
  return { responseHeaders };
}

function redirect(name: string): Overrides {
  return { statusCode: 302, responseHeaders: [...ATTACHMENT, { name, value: `${B}/next` }] };
}

function capitals(): HttpHeader[] {
  return [
    { name: "CONTENT-TYPE", value: "text/html" },
    { name: "CONTENT-DISPOSITION", value: "inline" },
  ];
}

function lowercase(): HttpHeader[] {
  return [
    { name: "content-type", value: "text/html" },
    { name: "content-disposition", value: "attachment" },
  ];
}

/** A response's details to change; null `responseHeaders` leave the headers out. */
type Overrides = Partial<Omit<HeadersReceivedDetails, "responseHeaders">> & {
  responseHeaders?: HttpHeader[] | null;
};

/** B's export answering a top-frame load with an attachment, unless `details` say otherwise. */
function response(details: Overrides & { tabId: number }): HeadersReceivedDetails {
  const { responseHeaders = ATTACHMENT, ...rest } = details;
  const sent: HeadersReceivedDetails = {
    requestId: "r1",
    timeStamp: 1000,
    frameId: 0,
    url: `${B}/export`,
    type: "main_frame",
    statusCode: 200,
    ...rest,
  };
  if (responseHeaders !== null) sent.responseHeaders = responseHeaders;
  return sent;
}

/**
 * A tab left on A's page in a group an earlier background made for the session "old", with A
 * stored as approved; nothing listens yet.
 */
async function leftBehind(): Promise<{ fake: FakeBrowser; left: FakeTab }> {
  const fake = createFakeBrowser();
  await grantSite(fake.browser, A);
  // No guard here: its registration would pass for the next background's.
  const earlier = createSessionGroups(fake.browser);
  const left = fake.openTab({ url: `${A}/page` });
  await earlier.ensureGroup("old", left);
  return { fake, left };
}

/** A setup where s1's tab stays in its group after s1 ended, with B allowed for s1 only. */
async function endedWithB() {
  const context = setup();
  const tab = await context.tabIn("s1");
  context.sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
  context.access.endSession("s1");
  await context.groups.endSession("s1");
  return { ...context, tab };
}

/** The background as it starts again, over the same browser. */
function restart(fake: FakeBrowser, browser: BrowserApi = fake.browser) {
  const timers = createFakeTimers();
  const groups = createSessionGroups(browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser, groups, sessions, timers });
  const guard = createFileGuard({ browser, groups, access, now: () => 0 });
  return { groups, sessions, access, guard };
}

/** A tab on A's page in s1's group, with A stored as approved, before any file guard exists. */
async function groupedBeforeGuard() {
  const fake = createFakeBrowser();
  await grantSite(fake.browser, A);
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  access.admit("s1");
  const opener = fake.openTab({ url: `${A}/page` });
  await groups.ensureGroup("s1", opener);
  return { fake, groups, access, opener };
}

/** Fires the response at the guard's listener, the only one; what it answered. */
function respondOnce(fake: FakeBrowser, details: Overrides & { tabId: number }): unknown {
  const answers = fake.emitWebRequest("onHeadersReceived", response(details));
  assert.equal(answers.length, 1);
  return answers[0];
}

/** Collects what is logged with console.warn, parsed. */
function warnings(t: TestContext): () => unknown[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}

function setup() {
  const fake = createFakeBrowser();
  // The guard's clock, on the scale of the fake's timeStamps.
  const clock = { now: 0 };
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  const guard = createFileGuard({ browser: fake.browser, groups, access, now: () => clock.now });

  /** A tab on A's page in the session's group, with A stored as approved. */
  async function tabIn(session: string): Promise<FakeTab> {
    // A group exists only after its session's first request admitted it.
    access.admit(session);
    await grantSite(fake.browser, A);
    const tab = fake.openTab({ url: `${A}/page` });
    await groups.ensureGroup(session, tab);
    return tab;
  }

  function respond(details: Overrides & { tabId: number }): unknown {
    return respondOnce(fake, details);
  }

  return { fake, clock, groups, sessions, access, guard, tabIn, respond };
}

/**
 * A setup where a load of `first`, a tab of the session s1, began at 1000, and a download of B's
 * export, begun at 1004, was refused by it at 1010; `heard` collects what `onRefused` hears.
 */
async function refusedByLoad(item: { state?: string; exists?: boolean } = {}) {
  const context = setup();
  const { fake, clock, guard, tabIn } = context;
  const first = await tabIn("s1");
  const heard: unknown[][] = [];
  guard.onRefused((...refusal) => heard.push(refusal));
  hop(fake, { tabId: first.id, timeStamp: 1000 });
  clock.now = 1010;
  download(fake, { id: 1, started: 1004, ...item });
  await idle(guard);
  return { ...context, first, heard };
}
