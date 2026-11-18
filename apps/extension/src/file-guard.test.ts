import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { BrowserApi, HeadersReceivedDetails, HttpHeader } from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  type FakeBrowser,
  type FakeTab,
  flush,
} from "./fake-browser.ts";
import { createFileGuard, MAX_REFUSAL_TABS, MAX_REFUSALS } from "./file-guard.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite, SESSION_GROUPS_KEY, saveBlocklist } from "./settings.ts";
import { createSiteAccess, type SessionMemory } from "./site-access.ts";

/** Stored as approved by `tabIn`. */
const A = "https://a.example";
/** Never approved unless a test does it. */
const B = "https://b.example";
/** A third site, never approved. */
const C = "https://c.example";
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

describe("the file guard's listener", { timeout: 10000 }, () => {
  it("is added when the first session starts running, once, and stays", async () => {
    const { fake, access, groups, tabIn } = setup();
    assert.deepEqual(fake.webRequestRegistrations, []);
    await tabIn("s1");
    const registration = {
      event: "onHeadersReceived",
      filter: { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
      extraInfoSpec: ["blocking", "responseHeaders"],
    };
    assert.deepEqual(fake.webRequestRegistrations, [registration]);
    await tabIn("s2");
    access.endSession("s1");
    await groups.endSession("s1");
    access.endSession("s2");
    await groups.endSession("s2");
    assert.deepEqual(fake.webRequestRegistrations, [registration]);
    assert.deepEqual(fake.activeWebRequestRegistrations(), [registration]);
    // A session that runs again adds no second one.
    access.admit("s1");
    assert.deepEqual(fake.webRequestRegistrations, [registration]);
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
    assert.deepEqual(fake.webRequestRegistrations, [REGISTRATION]);
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
    assert.deepEqual(fake.webRequestRegistrations, [REGISTRATION]);
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
    assert.deepEqual(fake.webRequestRegistrations, [REGISTRATION]);
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
    assert.deepEqual(fake.webRequestRegistrations, [REGISTRATION]);
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

  it("is cancelled in an ended session's tab when the site was approved for that session only", async () => {
    const { access, groups, sessions, guard, tabIn, respond } = setup();
    const tab = await tabIn("s1");
    sessions.set("s1", { allowed: new Set([B]), refused: new Set(), closed: 0 });
    assert.equal(await verdict(respond({ tabId: tab.id })), "passed");
    access.endSession("s1");
    await groups.endSession("s1");
    assert.equal(await verdict(respond({ tabId: tab.id })), "cancelled");
    assert.deepEqual(guard.refusedSince(tab.id, 0), [B]);
    // A site allowed always still loads its files there.
    assert.equal(await verdict(respond({ tabId: tab.id, url: `${A}/export` })), "passed");
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

  it("is no session's when its opener is gone, and leaves no rejection unhandled", async () => {
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

  it("passes on no tie once it closed", async () => {
    const { fake, tabIn, respond } = setup();
    const opener = await tabIn("s1");
    const window = fake.openTab({ url: "about:blank" });
    opens(fake, opener, window);
    await flush();
    fake.removeTab(window.id);
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

/** The background as it starts again, over the same browser. */
function restart(fake: FakeBrowser, browser: BrowserApi = fake.browser) {
  const timers = createFakeTimers();
  const groups = createSessionGroups(browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser, groups, sessions, timers });
  const guard = createFileGuard({ browser, groups, access });
  return { groups, sessions, access, guard };
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
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  const guard = createFileGuard({ browser: fake.browser, groups, access });

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

  return { fake, groups, sessions, access, guard, tabIn, respond };
}
