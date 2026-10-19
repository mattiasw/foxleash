import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MethodName, TabInfo } from "@foxhand/protocol";
import type { Tab } from "./browser-api.ts";
import { createFakeBrowser, createFakeTimers, flush } from "./fake-browser.ts";
import { createHandlers, ToolError } from "./handlers.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite } from "./settings.ts";
import { createSiteAccess, type SessionMemory } from "./site-access.ts";

describe("tabs_list", { timeout: 10000 }, () => {
  it("returns only the tabs in the session's group", async () => {
    const { fake, list, open } = setup();
    fake.openTab({ url: "https://user.example/" });
    const first = await open("s1", "https://a.example/");
    const second = await open("s1");
    await open("s2", "https://other.example/");
    // The other session's tab opened last, so it is the active one.
    assert.deepEqual(await list("s1"), [
      { ...first, active: false },
      { ...second, active: false },
    ]);
  });

  it("returns no tabs when the session has no group, whatever else is open", async () => {
    const { fake, list, open } = setup();
    fake.openTab({ url: "https://user.example/" });
    await open("s2");
    assert.deepEqual(await list("s1"), []);
  });

  it("returns no tabs once the user closed the session's group", async () => {
    const { fake, list, open } = setup();
    const tab = await open("s1");
    fake.closeGroup(groupIdOf(fake, tab.id));
    assert.deepEqual(await list("s1"), []);
  });

  it("includes a tab the user moved into the session's group", async () => {
    const { fake, list, open } = setup();
    const tab = await open("s1");
    const moved = fake.openTab({ url: "https://moved.example/" });
    moved.groupId = groupIdOf(fake, tab.id);
    assert.deepEqual(
      (await list("s1")).map(({ id }) => id),
      [tab.id, moved.id],
    );
  });
});

describe("tab_open", { timeout: 10000 }, () => {
  it("opens the url in a new active tab in an orange group titled Foxhand", async () => {
    const { fake, open, grant } = setup();
    await grant("https://example.com");
    fake.openTab({ active: true });
    const tab = await open("s1", "https://example.com/path?q=1");
    assert.deepEqual(tab, {
      id: 2,
      url: "https://example.com/path?q=1",
      title: "Title of https://example.com/path?q=1",
      active: true,
    });
    const group = groupIdOf(fake, tab.id);
    assert.deepEqual(fake.groups.get(group), {
      id: group,
      windowId: 1,
      title: "Foxhand",
      color: "orange",
    });
    assert.equal(fake.tabs.get(1)?.active, false);
  });

  it("returns only the tab's id, url, title and active state", async () => {
    const { open } = setup();
    const tab = await open("s1", "https://example.com/");
    assert.deepEqual(Object.keys(tab).sort(), ["active", "id", "title", "url"]);
  });

  it("opens the parsed URL, so what was checked is what is opened", async () => {
    const { fake, open, grant } = setup();
    await grant("https://example.com");
    const tab = await open("s1", "HTTPS://EXAMPLE.com:443/a/../b");
    assert.equal(tab.url, "https://example.com/b");
    assert.equal(fake.tabs.get(tab.id)?.url, "https://example.com/b");
  });

  it("opens an http URL", async () => {
    const { open, grant } = setup();
    await grant("http://example.com");
    assert.equal((await open("s1", "http://example.com/")).url, "http://example.com/");
  });

  it("opens about:blank without a url and for exactly about:blank", async () => {
    const { fake, open } = setup();
    for (const url of [undefined, "about:blank"]) {
      const tab = await open("s1", url);
      assert.deepEqual(tab, {
        id: tab.id,
        url: "about:blank",
        title: "",
        active: true,
      });
      assert.notEqual(fake.tabs.get(tab.id)?.groupId, -1);
    }
  });

  it("reuses the session's group and opens in its window", async () => {
    const { fake, open } = setup();
    const first = await open("s1");
    fake.currentWindowId = 2;
    const second = await open("s1", "https://example.com/");
    assert.equal(fake.groups.size, 1);
    assert.equal(groupIdOf(fake, second.id), groupIdOf(fake, first.id));
    assert.equal(fake.tabs.get(second.id)?.windowId, 1);
  });

  it("gives two sessions two groups", async () => {
    const { fake, open } = setup();
    const first = await open("s1");
    const second = await open("s2");
    assert.equal(fake.groups.size, 2);
    assert.notEqual(groupIdOf(fake, first.id), groupIdOf(fake, second.id));
  });

  it("makes one group for two concurrent calls of one session", async () => {
    const { fake, open } = setup();
    const [first, second] = await Promise.all([
      open("s1", "https://a.example/"),
      open("s1", "https://b.example/"),
    ]);
    assert.equal(fake.groups.size, 1);
    assert.equal(groupIdOf(fake, first.id), groupIdOf(fake, second.id));
  });

  it("recreates a group the user closed", async () => {
    const { fake, open } = setup();
    const first = await open("s1");
    const closed = groupIdOf(fake, first.id);
    fake.closeGroup(closed);
    const second = await open("s1");
    const group = groupIdOf(fake, second.id);
    assert.notEqual(group, closed);
    assert.equal(fake.groups.get(group)?.title, "Foxhand");
  });

  it("creates a new group when the user closes the group while the tab joins it", async () => {
    const { fake, open } = setup();
    const first = await open("s1");
    const closed = groupIdOf(fake, first.id);
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async (options) => {
      if (options.groupId !== undefined) fake.closeGroup(options.groupId);
      return group(options);
    };
    const second = await open("s1", "https://example.com/");
    const created = groupIdOf(fake, second.id);
    assert.notEqual(created, closed);
    assert.equal(fake.groups.get(created)?.color, "orange");
    assert.equal(fake.groups.size, 1);
  });

  it("creates the group in the tab's window when another window gets focus", async () => {
    const { fake, open } = setup();
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      const tab = await create(properties);
      fake.currentWindowId = 2;
      return tab;
    };
    const tab = await open("s1");
    assert.equal(fake.tabs.get(tab.id)?.windowId, 1);
    assert.equal(fake.groups.get(groupIdOf(fake, tab.id))?.windowId, 1);
  });

  it("refuses URLs other than http, https and exactly about:blank", async () => {
    const { fake, call } = setup();
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "about:config",
      "ABOUT:BLANK",
      "about:blank#x",
      "moz-extension://abc/page.html",
      "blob:https://example.com/0b2c",
      "view-source:https://example.com/",
      "ftp://example.com/",
      "not a url",
      "",
    ]) {
      await rejectsWith(call("s1", "tab_open", { url }), "invalid_url", url);
    }
    assert.equal(fake.tabs.size, 0);
  });

  it("names the allowed URLs without echoing the refused one", async () => {
    const { call } = setup();
    await assert.rejects(call("s1", "tab_open", { url: "file:///secret" }), {
      message: "Foxhand opens only http and https URLs, or about:blank.",
    });
  });

  it("refuses a url that is not a string", async () => {
    const { call } = setup();
    for (const url of [1, null, ["https://example.com/"]]) {
      await rejectsWith(call("s1", "tab_open", { url }), "invalid_params", String(url));
    }
  });

  it("ignores params it does not take", async () => {
    const { open, call, grant } = setup();
    await grant("https://example.com");
    await open("s1");
    const result = await call("s1", "tab_open", { url: "https://example.com/", extra: 1 });
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://example.com/");
  });

  it("never reads url from Object.prototype", async (t) => {
    const { fake, open } = setup();
    const prototype: Record<string, unknown> = Object.prototype as Record<string, unknown>;
    prototype.url = "https://polluted.example/";
    t.after(() => {
      delete prototype.url;
    });
    const tab = await open("s1");
    delete prototype.url;
    assert.equal(tab.url, "about:blank");
    assert.deepEqual(
      [...fake.tabs.values()].map(({ url }) => url),
      ["about:blank"],
    );
  });
});

describe("navigate", { timeout: 10000 }, () => {
  it("loads a url in a tab of the session's group", async () => {
    const { navigate, open, grant } = setup();
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    assert.deepEqual(await navigate("s1", { tabId: tab.id, url: "https://b.example/" }), {
      id: tab.id,
      url: "https://b.example/",
      title: "Title of https://b.example/",
      active: true,
    });
  });

  it("goes back, forward and reloads", async () => {
    const { fake, navigate, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    await navigate("s1", { tabId: tab.id, url: "https://b.example/" });
    assert.equal(
      (await navigate("s1", { tabId: tab.id, action: "back" })).url,
      "https://a.example/",
    );
    assert.equal(
      (await navigate("s1", { tabId: tab.id, action: "forward" })).url,
      "https://b.example/",
    );
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    fakeTab.title = "Before reload";
    const reloaded = await navigate("s1", { tabId: tab.id, action: "reload" });
    assert.deepEqual(reloaded, {
      ...tab,
      url: "https://b.example/",
      title: "Title of https://b.example/",
    });
  });

  it("returns the tab after the grace when going back has nowhere to go", async () => {
    const { timers, call, open } = setup();
    const tab = await open("s1");
    let done = false;
    const result = call("s1", "navigate", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    assert.equal(done, false);
    timers.advance(1000);
    assert.deepEqual(await result, { tab });
  });

  it("refuses a tab in no group, also when the session has a group", async () => {
    const { fake, call, open } = setup();
    const outside = fake.openTab({ url: "https://user.example/" });
    await rejectsWith(
      call("s1", "navigate", { tabId: outside.id, action: "reload" }),
      "tab_not_in_group",
    );
    await open("s1");
    await assert.rejects(call("s1", "navigate", { tabId: outside.id, url: "https://b.example/" }), {
      code: "tab_not_in_group",
      message: `Tab ${outside.id} is not in this session's tab group; open a tab with tab_open first.`,
    });
    assert.equal(fake.tabs.get(outside.id)?.url, "https://user.example/");
  });

  it("refuses a tab without a group id when the session has no group", async () => {
    const { fake, call } = setup();
    fake.browser.tabs.get = async (tabId) => ({ id: tabId, windowId: 1, active: true });
    await rejectsWith(call("s1", "navigate", { tabId: 5, action: "reload" }), "tab_not_in_group");
  });

  it("refuses a tab in another session's group", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const other = await open("s2", "https://other.example/");
    await rejectsWith(
      call("s1", "navigate", { tabId: other.id, url: "https://b.example/" }),
      "tab_not_in_group",
    );
    assert.equal(fake.tabs.get(other.id)?.url, "https://other.example/");
  });

  it("refuses an unknown tab", async () => {
    const { call, open } = setup();
    await open("s1");
    await assert.rejects(call("s1", "navigate", { tabId: 999, action: "reload" }), {
      code: "tab_not_found",
      message: "Tab 999 does not exist.",
    });
  });

  it("refuses a tab whose lookup throws synchronously as not found", async () => {
    const { fake, call } = setup();
    fake.browser.tabs.get = () => {
      throw new Error("Type error for parameter tabId");
    };
    await rejectsWith(call("s1", "navigate", { tabId: 7, action: "reload" }), "tab_not_found");
  });

  it("refuses invalid params", async () => {
    const { call, open } = setup();
    const tab = await open("s1");
    const cases: Record<string, unknown>[] = [
      { url: "https://b.example/" },
      { tabId: "1", url: "https://b.example/" },
      { tabId: 1.5, url: "https://b.example/" },
      { tabId: -1, url: "https://b.example/" },
      { tabId: 2 ** 53, url: "https://b.example/" },
      { tabId: Number.NaN, url: "https://b.example/" },
      { tabId: tab.id, url: "https://b.example/", action: "reload" },
      { tabId: tab.id },
      { tabId: tab.id, action: "stop" },
      { tabId: tab.id, action: "constructor" },
      { tabId: tab.id, url: 1 },
    ];
    for (const params of cases) {
      await rejectsWith(call("s1", "navigate", params), "invalid_params", JSON.stringify(params));
    }
  });

  it("says which params are wrong", async () => {
    const { call } = setup();
    const messages: [Record<string, unknown>, string][] = [
      [{ tabId: -1 }, "navigate needs a tab id that is a whole number of 0 or more."],
      [
        { tabId: 1, url: "https://b.example/", action: "back" },
        "navigate takes either url or action, not both.",
      ],
      [{ tabId: 1 }, "navigate needs a url or an action."],
      [{ tabId: 1, action: "stop" }, "action must be back, forward or reload."],
      [{ tabId: 1, url: 1 }, "navigate needs url to be a string."],
      [{ tabId: 1, url: "file:///x" }, "Foxhand navigates only to http and https URLs."],
    ];
    for (const [params, message] of messages) {
      await assert.rejects(call("s1", "navigate", params), { message });
    }
  });

  it("accepts tab id 0", async () => {
    const { call } = setup();
    await rejectsWith(call("s1", "navigate", { tabId: 0, action: "reload" }), "tab_not_found");
  });

  it("refuses URLs other than http and https", async () => {
    const { call, open } = setup();
    const tab = await open("s1");
    for (const url of ["about:blank", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      await rejectsWith(call("s1", "navigate", { tabId: tab.id, url }), "invalid_url", url);
    }
  });

  it("never reads tabId, url or action from Object.prototype", async (t) => {
    const { fake, call, open } = setup();
    const tab = await open("s1");
    const prototype: Record<string, unknown> = Object.prototype as Record<string, unknown>;
    t.after(() => {
      for (const key of ["tabId", "url", "action"]) delete prototype[key];
    });
    const cases: [string, unknown, Record<string, unknown>][] = [
      ["tabId", tab.id, { action: "reload" }],
      ["url", "https://polluted.example/", { tabId: tab.id }],
      ["action", "reload", { tabId: tab.id }],
    ];
    for (const [key, value, params] of cases) {
      prototype[key] = value;
      const result = call("s1", "navigate", params);
      await rejectsWith(result, "invalid_params", key).finally(() => {
        delete prototype[key];
      });
    }
    prototype.url = "https://polluted.example/";
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    await reloaded.finally(() => {
      delete prototype.url;
    });
    assert.equal(fake.tabs.get(tab.id)?.url, "about:blank");
  });
});

describe("sessions", { timeout: 10000 }, () => {
  it("treats __proto__ and constructor as ordinary session ids", async () => {
    const { fake, list, open } = setup();
    const first = await open("__proto__", "https://a.example/");
    const second = await open("constructor", "https://b.example/");
    assert.equal(fake.groups.size, 2);
    assert.deepEqual(
      (await list("__proto__")).map(({ id }) => id),
      [first.id],
    );
    assert.deepEqual(
      (await list("constructor")).map(({ id }) => id),
      [second.id],
    );
    assert.deepEqual(await list("toString"), []);
  });

  it("still groups a session's next tab after one failed to join", async () => {
    const { fake, list, open } = setup();
    const group = fake.browser.tabs.group;
    let calls = 0;
    fake.browser.tabs.group = async (options) => {
      calls += 1;
      if (calls === 1) throw new Error("Invalid tab ID");
      return group(options);
    };
    const [first, second] = await Promise.allSettled([open("s1"), open("s1")]);
    assert.equal(first.status, "rejected");
    assert.ok(second.status === "fulfilled");
    assert.deepEqual(
      (await list("s1")).map(({ id }) => id),
      [second.value.id],
    );
  });

  it("keeps a new group when a lookup of the closed one fails late", async () => {
    const { fake, call, list, open } = setup();
    const first = await open("s1");
    fake.closeGroup(groupIdOf(fake, first.id));
    const get = fake.browser.tabGroups.get;
    const late = Promise.withResolvers<never>();
    fake.browser.tabGroups.get = () => late.promise;
    const listing = call("s1", "tabs_list");
    fake.browser.tabGroups.get = get;
    const second = await open("s1");
    late.reject(new Error("No group"));
    assert.deepEqual(await listing, { tabs: [] });
    assert.deepEqual(
      (await list("s1")).map(({ id }) => id),
      [second.id],
    );
  });

  it("forgets a closed group, so a later group with the same id is not the session's", async () => {
    const { fake, list, open } = setup();
    const tab = await open("s1");
    const closed = groupIdOf(fake, tab.id);
    fake.closeGroup(closed);
    assert.deepEqual(await list("s1"), []);
    fake.groups.set(closed, { id: closed, windowId: 1 });
    fake.openTab({ url: "https://user.example/", groupId: closed });
    assert.deepEqual(await list("s1"), []);
  });

  it("keeps a session's tabs in one group while an earlier failed call settles", async () => {
    const { fake, list, open } = setup();
    const group = fake.browser.tabs.group;
    const held = Promise.withResolvers<void>();
    let calls = 0;
    fake.browser.tabs.group = async (options) => {
      calls += 1;
      if (calls === 1) throw new Error("Invalid tab ID");
      if (calls === 2) await held.promise;
      return group(options);
    };
    const first = open("s1");
    const second = open("s1");
    await assert.rejects(first);
    await flush();
    const third = open("s1");
    await flush();
    held.resolve();
    const tabs = await Promise.all([second, third]);
    assert.equal(fake.groups.size, 1);
    assert.deepEqual(
      (await list("s1")).map(({ id }) => id),
      tabs.map(({ id }) => id),
    );
  });

  it("fails tab_open when Firefox cannot title the new group", async () => {
    const { fake, open } = setup();
    fake.browser.tabGroups.update = async () => {
      throw new Error("No group with id: 1");
    };
    await assert.rejects(open("s1"), /No group with id/);
  });

  it("reports an empty url and title for a tab Firefox gives none", async () => {
    const { fake, list, open } = setup();
    const tab = await open("s1");
    fake.browser.tabs.query = async () => [{ id: tab.id, windowId: 1, active: true }];
    assert.deepEqual(await list("s1"), [{ id: tab.id, url: "", title: "", active: true }]);
  });
});

describe("site access", { timeout: 10000 }, () => {
  it("shows a tab the user moved in from an unapproved site only as its site", async () => {
    const { fake, list, open } = setup();
    const tab = await open("s1");
    const moved = fake.openTab({ url: "https://moved.example:8443/inbox?id=7#top" });
    moved.groupId = groupIdOf(fake, tab.id);
    const listed = await list("s1");
    assert.deepEqual(listed[1], {
      id: moved.id,
      url: "https://moved.example:8443",
      title: "",
      active: false,
    });
  });

  it("opens an unapproved site and returns only its site, with the same keys", async () => {
    const { fake, open } = setup();
    const tab = await open("s1", "https://example.com/path?q=1");
    assert.deepEqual(tab, { id: tab.id, url: "https://example.com", title: "", active: true });
    assert.deepEqual(Object.keys(tab).sort(), ["active", "id", "title", "url"]);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://example.com/path?q=1");
  });

  it("navigates to an unapproved site and returns only its site", async () => {
    const { navigate, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    assert.deepEqual(await navigate("s1", { tabId: tab.id, url: "https://b.example/secret" }), {
      id: tab.id,
      url: "https://b.example",
      title: "",
      active: true,
    });
  });

  it("shows a site granted for a session in full to that session only", async () => {
    const { list, open, sessions } = setup();
    sessions.set("s1", { allowed: new Set(["https://a.example"]) });
    const first = await open("s1", "https://a.example/page");
    assert.deepEqual(first, {
      id: first.id,
      url: "https://a.example/page",
      title: "Title of https://a.example/page",
      active: true,
    });
    const second = await open("s2", "https://a.example/page");
    assert.deepEqual(second, { id: second.id, url: "https://a.example", title: "", active: true });
    assert.deepEqual(
      (await list("s2")).map(({ url }) => url),
      ["https://a.example"],
    );
  });

  it("hides the title of an approved tab that is still loading", async () => {
    const { fake, list, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.emitStatus(tab.id, "loading");
    assert.deepEqual(await list("s1"), [{ ...tab, title: "" }]);
  });

  it("fails the call instead of showing tabs when the settings cannot be read", async () => {
    const { fake, call, open } = setup();
    await open("s1", "https://a.example/");
    fake.browser.storage.local.get = async () => {
      throw new Error("storage is unavailable");
    };
    await assert.rejects(call("s1", "tabs_list"), /storage is unavailable/);
  });
});

describe("blocklist", { timeout: 10000 }, () => {
  const BLOCKED =
    "Foxhand does not act on https://www.paypal.com: it is on Foxhand's blocklist, which by default lists common financial and health sites.";

  it("refuses to open a blocked site before it creates a tab", async (t) => {
    const { fake, call } = setup();
    const create = t.mock.method(fake.browser.tabs, "create");
    const update = t.mock.method(fake.browser.tabs, "update");
    await assert.rejects(call("s1", "tab_open", { url: "https://www.paypal.com/signin" }), {
      code: "site_blocked",
      message: BLOCKED,
    });
    assert.equal(create.mock.callCount(), 0);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(fake.tabs.size, 0);
    assert.equal(fake.groups.size, 0);
  });

  it("refuses to open a blocked site the user approved, in a session with a group", async (t) => {
    const { fake, call, open, grant, sessions } = setup();
    await grant("https://www.paypal.com");
    sessions.set("s1", { allowed: new Set(["https://www.paypal.com"]) });
    await open("s1");
    const create = t.mock.method(fake.browser.tabs, "create");
    const update = t.mock.method(fake.browser.tabs, "update");
    await assert.rejects(call("s1", "tab_open", { url: "https://www.paypal.com/" }), {
      code: "site_blocked",
      message: BLOCKED,
    });
    assert.equal(create.mock.callCount(), 0);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(fake.tabs.size, 1);
  });

  it("refuses to navigate a tab to a blocked site", async (t) => {
    const { fake, call, open, grant } = setup();
    await grant("https://www.paypal.com");
    const tab = await open("s1", "https://a.example/");
    const update = t.mock.method(fake.browser.tabs, "update");
    await assert.rejects(
      call("s1", "navigate", { tabId: tab.id, url: "https://www.paypal.com/" }),
      {
        code: "site_blocked",
        message: BLOCKED,
      },
    );
    assert.equal(update.mock.callCount(), 0);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/");
  });

  it("refuses to reload a tab whose site became blocked", async (t) => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await fake.browser.storage.local.set({ blocklist: ["a.example"] });
    const reload = t.mock.method(fake.browser.tabs, "reload");
    await assert.rejects(call("s1", "navigate", { tabId: tab.id, action: "reload" }), {
      code: "site_blocked",
      message:
        "Foxhand does not act on https://a.example: it is on Foxhand's blocklist, which by default lists common financial and health sites.",
    });
    assert.equal(reload.mock.callCount(), 0);
  });

  it("reloads about:blank with no check, reading the settings only for the result", async (t) => {
    const { fake, navigate, open } = setup();
    const tab = await open("s1");
    const reload = t.mock.method(fake.browser.tabs, "reload");
    const get = t.mock.method(fake.browser.storage.local, "get");
    assert.equal((await navigate("s1", { tabId: tab.id, action: "reload" })).url, "about:blank");
    assert.equal(reload.mock.callCount(), 1);
    assert.equal(get.mock.callCount(), 1);
  });

  it("refuses to reload a tab that shows a page that is not a website, naming only the tab", async (t) => {
    const { fake, call, open } = setup();
    const tab = await open("s1");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    const reload = t.mock.method(fake.browser.tabs, "reload");
    const message = `Foxhand acts only on http and https pages, and tab ${tab.id} shows another kind of page.`;
    for (const url of ["file:///home/u/secret.txt", "about:newtab", "about:blank#x"]) {
      fakeTab.url = url;
      const error = await call("s1", "navigate", { tabId: tab.id, action: "reload" }).then(
        () => assert.fail(`reloaded ${url}`),
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof ToolError, url);
      assert.deepEqual(
        { code: error.code, message: error.message },
        { code: "page_not_web", message },
      );
      assert.equal(/secret|file/.test(error.message), false);
    }
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async (tabId) => {
      const { url: _url, ...rest } = await get(tabId);
      return rest;
    };
    await assert.rejects(call("s1", "navigate", { tabId: tab.id, action: "reload" }), {
      code: "page_not_web",
      message,
    });
    assert.equal(reload.mock.callCount(), 0);
  });

  it("refuses a web URL that has no site before it opens anything", async () => {
    const { fake, call, open } = setup();
    await assert.rejects(call("s1", "tab_open", { url: "http://./" }), {
      code: "invalid_url",
      message: "Foxhand opens only http and https URLs, or about:blank.",
    });
    assert.equal(fake.tabs.size, 0);
    const tab = await open("s1");
    await assert.rejects(call("s1", "navigate", { tabId: tab.id, url: "http://./" }), {
      code: "invalid_url",
      message: "Foxhand navigates only to http and https URLs.",
    });
    assert.equal(fake.tabs.get(tab.id)?.url, "about:blank");
  });

  it("shows a tab moved in from a blocked, approved site only as its site", async () => {
    const { fake, list, open, grant } = setup();
    await grant("https://www.paypal.com");
    const tab = await open("s1");
    const moved = fake.openTab({ url: "https://www.paypal.com/activity" });
    moved.groupId = groupIdOf(fake, tab.id);
    assert.deepEqual((await list("s1"))[1], {
      id: moved.id,
      url: "https://www.paypal.com",
      title: "",
      active: false,
    });
  });

  it("goes back and forward onto a blocked site, showing only its site", async () => {
    const { fake, navigate, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/x");
    await navigate("s1", { tabId: tab.id, url: "https://b.example/y" });
    await fake.browser.storage.local.set({ blocklist: ["a.example", "b.example"] });
    assert.deepEqual(await navigate("s1", { tabId: tab.id, action: "back" }), {
      ...tab,
      url: "https://a.example",
      title: "",
    });
    assert.deepEqual(await navigate("s1", { tabId: tab.id, action: "forward" }), {
      ...tab,
      url: "https://b.example",
      title: "",
    });
  });
});

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, sessions });
  const handleRequest = createHandlers({ browser: fake.browser, groups, timers, access });
  let requests = 0;
  const call = (session: string, method: MethodName, params: Record<string, unknown> = {}) =>
    handleRequest({ type: "request", id: `r${++requests}`, session, method, params });

  async function open(session: string, url?: string): Promise<TabInfo> {
    const result = await call(session, "tab_open", url === undefined ? {} : { url });
    assert.ok("tab" in result);
    return result.tab;
  }

  async function list(session: string): Promise<TabInfo[]> {
    const result = await call(session, "tabs_list");
    assert.ok("tabs" in result);
    return result.tabs;
  }

  async function navigate(session: string, params: Record<string, unknown>): Promise<TabInfo> {
    const result = await call(session, "navigate", params);
    assert.ok("tab" in result);
    return result.tab;
  }

  function grant(site: string): Promise<void> {
    return grantSite(fake.browser, site);
  }

  return { fake, timers, sessions, call, open, list, navigate, grant };
}

function groupIdOf(fake: { tabs: Map<number, Tab> }, tabId: number): number {
  const groupId = fake.tabs.get(tabId)?.groupId;
  assert.ok(groupId !== undefined && groupId !== -1, `tab ${tabId} is in no group`);
  return groupId;
}

async function rejectsWith(promise: Promise<unknown>, code: string, label?: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ToolError && error.code === code,
    label,
  );
}
