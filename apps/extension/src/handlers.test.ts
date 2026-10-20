import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MethodName, ProbeResult, TabInfo } from "@foxhand/protocol";
import type { Tab, TabChangeInfo } from "./browser-api.ts";
import {
  type CssCall,
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakeBrowser,
  type FakePort,
  flush,
  ONE_PIXEL_PNG,
} from "./fake-browser.ts";
import {
  CAPTURE_TIMEOUT_MS,
  createHandlers,
  PROBE_CUTOFF_MS,
  PROBE_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  ToolError,
} from "./handlers.ts";
import { PAGE_INJECTION_MS, PAGE_REPLY_MS } from "./page-scripts.ts";
import { READ_PAGE_MAX_CHARS } from "./page-tree.ts";
import { FIELD_MASK_CSS, INPUT_MASK_CSS } from "./screenshot.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite } from "./settings.ts";
import {
  APPROVAL_WAIT_MS,
  createSiteAccess,
  type OpenPrompt,
  type SessionMemory,
  type SessionState,
} from "./site-access.ts";
import { createUploads } from "./uploads.ts";

describe("tabs_list", { timeout: 10000 }, () => {
  it("returns only the tabs in the session's group", async () => {
    const { fake, list, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://other.example");
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

  it("returns the opened page when the blank tab's own load completes after it", async () => {
    const { fake, open, grant } = setup();
    await grant("https://example.com");
    reportBlankLoadBefore(fake, "https://example.com/path");
    const tab = await open("s1", "https://example.com/path");
    assert.deepEqual(tab, {
      id: tab.id,
      url: "https://example.com/path",
      title: "Title of https://example.com/path",
      active: true,
    });
  });

  it("returns only the tab's id, url, title and active state", async () => {
    const { open, grant } = setup();
    await grant("https://example.com");
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
    const { fake, open, grant } = setup();
    await grant("https://example.com");
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
    const { fake, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
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
    const { fake, open, grant } = setup();
    await grant("https://example.com");
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
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    assert.deepEqual(await navigate("s1", { tabId: tab.id, url: "https://b.example/" }), {
      id: tab.id,
      url: "https://b.example/",
      title: "Title of https://b.example/",
      active: true,
    });
  });

  it("returns the loaded page when a blank tab's own load completes after the navigation", async () => {
    const { fake, navigate, open, grant } = setup();
    const tab = await open("s1");
    await grant("https://b.example");
    reportBlankLoadBefore(fake, "https://b.example/");
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
    const { fake, call, open, grant } = setup();
    await grant("https://other.example");
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
    const { fake, list, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
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

  it("returns only the site of a page that redirected to an unapproved site", async () => {
    const { fake, open, grant } = setup();
    await grant("https://a.example");
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = (tabId, properties) =>
      update(tabId, { ...properties, url: "https://b.example/landing?id=7" });
    const tab = await open("s1", "https://a.example/path?q=1");
    assert.deepEqual(tab, { id: tab.id, url: "https://b.example", title: "", active: true });
    assert.deepEqual(Object.keys(tab).sort(), ["active", "id", "title", "url"]);
  });

  it("goes back onto a site the session may no longer see and returns only its site", async () => {
    const { navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example", "https://b.example"]));
    const tab = await open("s1", "https://a.example/secret");
    await navigate("s1", { tabId: tab.id, url: "https://b.example/" });
    sessions.get("s1")?.allowed.delete("https://a.example");
    assert.deepEqual(await navigate("s1", { tabId: tab.id, action: "back" }), {
      id: tab.id,
      url: "https://a.example",
      title: "",
      active: true,
    });
  });

  it("shows a site granted for a session in full to that session only", async () => {
    const { fake, list, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const first = await open("s1", "https://a.example/page");
    assert.deepEqual(first, {
      id: first.id,
      url: "https://a.example/page",
      title: "Title of https://a.example/page",
      active: true,
    });
    const blank = await open("s2");
    const moved = fake.tabs.get(first.id);
    assert.ok(moved);
    moved.groupId = groupIdOf(fake, blank.id);
    assert.deepEqual(
      (await list("s2")).map(({ url }) => url),
      ["https://a.example", "about:blank"],
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
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
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
    sessions.set("s1", state(["https://www.paypal.com"]));
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
    await grant("https://a.example");
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

describe("approval", { timeout: 10000 }, () => {
  it("loads nothing before the answer, then replaces the prompt with the page", async () => {
    const { fake, call, page } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    await flush();
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
    const [tab] = fake.tabs.values();
    assert.ok(tab);
    assert.match(tab.url, /^moz-extension:\/\/.*\/approve\.html\?id=/);
    assert.equal(tab.active, true);
    assert.notEqual(tab.groupId, -1);
    shown.deliver({ type: "answer", answer: "once" });
    assert.deepEqual(await opened, {
      tab: {
        id: tab.id,
        url: "https://a.example/x",
        title: "Title of https://a.example/x",
        active: true,
      },
    });
    assert.deepEqual(fake.tabUpdates.at(-1), {
      tabId: tab.id,
      url: "https://a.example/x",
      loadReplace: true,
    });
    assert.deepEqual(tab.history, ["about:blank", "https://a.example/x"]);
  });

  it("asks before navigating a tab to an unapproved site", async () => {
    const { fake, call, open, page, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const navigated = call("s1", "navigate", { tabId: tab.id, url: "https://b.example/y" });
    const shown = await page("s1");
    await flush();
    assert.equal(loadsOf(fake, "https://b.example/y"), 0);
    shown.deliver({ type: "answer", answer: "once" });
    const result = await navigated;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://b.example/y");
    assert.deepEqual(fake.tabs.get(tab.id)?.history, [
      "about:blank",
      "https://a.example/",
      "https://b.example/y",
    ]);
  });

  it("keeps a tab refused by Don't allow on the prompt page", async () => {
    const { fake, call, page } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    (await page("s1")).deliver({ type: "answer", answer: "no" });
    await assert.rejects(opened, { code: "site_refused" });
    const [tab] = fake.tabs.values();
    assert.match(tab?.url ?? "", /^moz-extension:/);
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
    await assert.rejects(call("s1", "tab_open", { url: "https://a.example/" }), {
      code: "site_refused",
    });
    assert.equal(fake.tabs.size, 1);
  });

  it("opens one prompt and removes the other tab of two parallel tab_open calls", async () => {
    const { fake, call, page } = setup();
    const [first, second] = [
      call("s1", "tab_open", { url: "https://a.example/" }),
      call("s1", "tab_open", { url: "https://b.example/" }),
    ];
    await assert.rejects(second, { code: "approval_pending" });
    const shown = await page("s1");
    assert.equal(fake.tabs.size, 1);
    shown.deliver({ type: "answer", answer: "once" });
    const result = await first;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/");
  });

  it("joins the open prompt with tab_open for its site, creating no tab", async () => {
    const { fake, call, timeOut, promptOf } = setup();
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    const shown = await timeOut("s1");
    await first;
    const { tabId } = await promptOf("s1");
    const retry = call("s1", "tab_open", { url: "https://a.example/y" });
    await flush();
    assert.equal(fake.tabs.size, 1);
    shown.deliver({ type: "answer", answer: "once" });
    const result = await retry;
    assert.ok("tab" in result);
    assert.deepEqual(result.tab, {
      id: tabId,
      url: "https://a.example/y",
      title: "Title of https://a.example/y",
      active: true,
    });
    assert.equal(fake.tabs.size, 1);
  });

  it("joins on the prompt's tab with a url on its site or a reload, and loads in place", async () => {
    for (const [params, loaded] of [
      [{ url: "https://a.example/y" }, "https://a.example/y"],
      [{ action: "reload" }, "https://a.example/x"],
    ] as const) {
      const { fake, call, timeOut, promptOf } = setup();
      const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
        code: "approval_timeout",
      });
      const shown = await timeOut("s1");
      await first;
      const { tabId } = await promptOf("s1");
      const retry = call("s1", "navigate", { tabId, ...params });
      await flush();
      assert.equal(loadsOf(fake, loaded), 0, loaded);
      shown.deliver({ type: "answer", answer: "always" });
      const result = await retry;
      assert.ok("tab" in result);
      assert.equal(result.tab.url, loaded);
      assert.deepEqual(fake.tabUpdates.at(-1), { tabId, url: loaded, loadReplace: true });
    }
  });

  it("reloads a prompt answered after its call timed out by loading what it asked about", async () => {
    const { fake, call, timeOut, promptOf } = setup();
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    const shown = await timeOut("s1");
    await first;
    const { tabId } = await promptOf("s1");
    shown.deliver({ type: "answer", answer: "once" });
    const result = await call("s1", "navigate", { tabId, action: "reload" });
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/x");
    assert.deepEqual(fake.tabUpdates.at(-1), {
      tabId,
      url: "https://a.example/x",
      loadReplace: true,
    });
    assert.deepEqual(fake.tabs.get(tabId)?.history, ["about:blank", "https://a.example/x"]);
  });

  it("refuses a reload of a prompt answered with Don't allow, staying on it", async () => {
    const { fake, call, page, promptOf } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const { tabId } = await promptOf("s1");
    (await page("s1")).deliver({ type: "answer", answer: "no" });
    await assert.rejects(opened, { code: "site_refused" });
    await assert.rejects(call("s1", "navigate", { tabId, action: "reload" }), {
      code: "site_refused",
    });
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
    assert.match(fake.tabs.get(tabId)?.url ?? "", /^moz-extension:/);
  });

  it("keeps a prompt that a parallel request showed in the tab while a navigate was checked", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const get = fake.browser.storage.local.get;
    const held = Promise.withResolvers<void>();
    let reads = 0;
    fake.browser.storage.local.get = async (keys) => {
      reads += 1;
      if (reads === 1) await held.promise;
      return get(keys);
    };
    const approved = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/b" });
    await flush();
    assert.equal(reads, 1);
    const asking = call("s1", "navigate", { tabId: tab.id, url: "https://b.example/" });
    const prompt = await promptOf("s1");
    held.resolve();
    await assert.rejects(approved, {
      code: "approval_pending",
      message: `Foxhand is waiting for the user to answer in tab ${tab.id} whether to allow https://b.example. Try again after the user has answered.`,
    });
    assert.equal(prompt.tabId, tab.id);
    assert.equal(loadsOf(fake, "https://a.example/b"), 0);
    assert.match(fake.tabs.get(tab.id)?.url ?? "", /^moz-extension:/);
    void asking.catch(() => {});
  });

  it("keeps a prompt that a parallel request showed in the tab while an answered load waited", async () => {
    const { fake, call, open, page, promptOf, sessions } = setup();
    const tab = await open("s1");
    const answered = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/x" });
    const first = await page("s1");
    const get = fake.browser.storage.local.get;
    const held = Promise.withResolvers<void>();
    let holding = true;
    fake.browser.storage.local.get = async (keys) => {
      if (holding) {
        holding = false;
        await held.promise;
      }
      return get(keys);
    };
    first.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(holding, false);
    const asking = call("s1", "navigate", { tabId: tab.id, url: "https://b.example/" });
    const second = await promptOf("s1");
    await page("s1");
    held.resolve();
    await assert.rejects(answered, {
      code: "approval_pending",
      message: `Foxhand is waiting for the user to answer in tab ${tab.id} whether to allow https://b.example. Try again after the user has answered.`,
    });
    assert.equal(second.site, "https://b.example");
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
    assert.equal(sessions.get("s1")?.closed, 0);
    assert.deepEqual(sessions.get("s1")?.allowed, new Set(["https://a.example"]));
    assert.equal(fake.tabs.get(tab.id)?.url.startsWith("moz-extension:"), true);
    void asking.catch(() => {});
  });

  it("refuses every other request on the prompt's tab while it asks", async () => {
    const { fake, call, page, timeOut, promptOf, grant } = setup();
    await grant("https://b.example");
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    await page("s1");
    const { tabId } = await promptOf("s1");
    const message = `Foxhand is waiting for the user to answer in tab ${tabId} whether to allow https://a.example. Try again after the user has answered.`;
    const refusals: Record<string, unknown>[] = [
      { url: "https://a.example/y" },
      { action: "reload" },
      { action: "back" },
      { action: "forward" },
      { url: "https://b.example/" },
    ];
    for (const params of refusals) {
      await assert.rejects(call("s1", "navigate", { tabId, ...params }), {
        code: "approval_pending",
        message,
      });
    }
    await timeOut("s1");
    await first;
    for (const params of refusals.slice(2)) {
      await assert.rejects(call("s1", "navigate", { tabId, ...params }), {
        code: "approval_pending",
      });
    }
    assert.match(fake.tabs.get(tabId)?.url ?? "", /^moz-extension:/);
  });

  it("loads a navigate joined from another tab there, without replacing its history", async () => {
    const { fake, call, open, timeOut, promptOf } = setup();
    const blank = await open("s1");
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    const shown = await timeOut("s1");
    await first;
    const prompt = await promptOf("s1");
    const joined = call("s1", "navigate", { tabId: blank.id, url: "https://a.example/y" });
    await flush();
    assert.equal(loadsOf(fake, "https://a.example/y"), 0);
    shown.deliver({ type: "answer", answer: "once" });
    const result = await joined;
    assert.ok("tab" in result);
    assert.equal(result.tab.id, blank.id);
    assert.deepEqual(fake.tabUpdates.at(-1), {
      tabId: blank.id,
      url: "https://a.example/y",
      loadReplace: false,
    });
    assert.match(fake.tabs.get(prompt.tabId)?.url ?? "", /^moz-extension:/);
  });

  it("reloads after a prompt by loading the same URL in place of the prompt", async () => {
    const { fake, call, open, sessions, page } = setup();
    sessions.set("s1", state(["https://b.example"]));
    const tab = await open("s1", "https://b.example/page");
    sessions.set("s1", state([]));
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    (await page("s1")).deliver({ type: "answer", answer: "once" });
    const result = await reloaded;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://b.example/page");
    assert.deepEqual(fake.tabUpdates.at(-1), {
      tabId: tab.id,
      url: "https://b.example/page",
      loadReplace: true,
    });
  });

  it("reloads a tab joined to a prompt elsewhere only while it still shows the gated URL", async (t) => {
    for (const moved of [false, true]) {
      const { fake, call, open, timeOut } = setup();
      const other = await open("s1");
      const otherTab = fake.tabs.get(other.id);
      assert.ok(otherTab);
      otherTab.url = "https://a.example/page";
      const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
        code: "approval_timeout",
      });
      const shown = await timeOut("s1");
      await first;
      const reload = t.mock.method(fake.browser.tabs, "reload");
      const reloaded = call("s1", "navigate", { tabId: other.id, action: "reload" });
      await flush();
      if (moved) otherTab.url = "https://c.example/";
      shown.deliver({ type: "answer", answer: "once" });
      const result = await reloaded;
      assert.ok("tab" in result);
      assert.equal(result.tab.url, "https://a.example/page");
      assert.equal(reload.mock.callCount(), moved ? 0 : 1);
      assert.equal(loadsOf(fake, "https://a.example/page"), moved ? 1 : 0);
      reload.mock.restore();
    }
  });

  it("refuses to load after the answer when the tab left the session's group, keeping the answer", async () => {
    const { fake, call, sessions, page, promptOf } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    const { tabId } = await promptOf("s1");
    fake.ungroup(tabId);
    shown.deliver({ type: "answer", answer: "once" });
    await assert.rejects(opened, {
      code: "tab_not_in_group",
      message: `Tab ${tabId} is not in this session's tab group; open a tab with tab_open first.`,
    });
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
    assert.deepEqual(sessions.get("s1")?.allowed, new Set(["https://a.example"]));
  });

  it("refuses to load after the answer a site blocked while the prompt was open", async () => {
    const { fake, call, page } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    await fake.browser.storage.local.set({ blocklist: ["a.example"] });
    shown.deliver({ type: "answer", answer: "once" });
    await assert.rejects(opened, {
      code: "site_blocked",
      message:
        "Foxhand does not act on https://a.example: it is on Foxhand's blocklist, which by default lists common financial and health sites.",
    });
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
  });

  it("removes the new tab when the prompt cannot be shown in it", async () => {
    const { fake, call } = setup();
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      if (properties.active === true) throw new Error("Invalid tab ID");
      return update(tabId, properties);
    };
    await assert.rejects(call("s1", "tab_open", { url: "https://a.example/" }), /Invalid tab ID/);
    assert.equal(fake.tabs.size, 0);
  });

  it("still fails with the refusal when the new tab cannot be removed", async () => {
    const { fake, call } = setup();
    fake.browser.tabs.remove = async () => {
      throw new Error("Invalid tab ID");
    };
    const first = call("s1", "tab_open", { url: "https://a.example/" });
    await assert.rejects(call("s1", "tab_open", { url: "https://b.example/" }), {
      code: "approval_pending",
    });
    assert.equal(fake.tabs.size, 2);
    void first.catch(() => {});
  });
});

describe("probe_input", { timeout: 10000 }, () => {
  const RESULT: ProbeResult = {
    userAgent: "Mozilla/5.0 Firefox/150.0",
    checks: [
      {
        check: "tab_focus",
        target: "probe",
        element: "input type=text",
        strategy: "tab_keydown",
        outcome: "no_effect",
        delivered: true,
        trustedOnly: true,
        detail: "focus did not move",
      },
    ],
  };

  for (const tabId of ["1", -1, 1.5, undefined]) {
    it(`refuses the tab id ${String(tabId)}`, async () => {
      const { fake, call, open } = setup();
      await open("s1");
      await assert.rejects(call("s1", "probe_input", tabId === undefined ? {} : { tabId }), {
        code: "invalid_params",
        message: "probe_input needs a tab id that is a whole number of 0 or more.",
      });
      assert.deepEqual(fake.injections, []);
    });
  }

  it("takes 0 as a tab id", async () => {
    const { call, open } = setup();
    await open("s1");
    await assert.rejects(call("s1", "probe_input", { tabId: 0 }), { code: "tab_not_found" });
  });

  it("refuses a tab that does not exist", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    await assert.rejects(call("s1", "probe_input", { tabId: 99 }), {
      code: "tab_not_found",
      message: "Tab 99 does not exist.",
    });
    assert.deepEqual(fake.injections, []);
  });

  it("refuses a tab outside the session's group, on an allowed site", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    await open("s1", "https://a.example/");
    const outside = fake.openTab({ url: "https://a.example/" });
    await rejectsWith(call("s1", "probe_input", { tabId: outside.id }), "tab_not_in_group");
    await rejectsWith(call("s2", "probe_input", { tabId: outside.id }), "tab_not_in_group");
    assert.deepEqual(fake.injections, []);
  });

  it("refuses the tab that shows the session's open prompt", async () => {
    const { fake, call, promptOf } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/" });
    const prompt = await promptOf("s1");
    await assert.rejects(call("s1", "probe_input", { tabId: prompt.tabId }), {
      code: "approval_pending",
      message: `Foxhand is waiting for the user to answer in tab ${prompt.tabId} whether to allow https://a.example. Try again after the user has answered.`,
    });
    assert.deepEqual(fake.injections, []);
    void opened.catch(() => {});
  });

  for (const url of ["about:blank", "moz-extension://abc/options.html", "file:///home/x.html"]) {
    it(`refuses a tab that shows ${url}`, async () => {
      const { fake, call, open } = setup();
      const tab = await open("s1");
      fake.navigateByUser(tab.id, url);
      await flush();
      await assert.rejects(call("s1", "probe_input", { tabId: tab.id }), {
        code: "page_not_web",
        message: `Foxhand acts only on http and https pages, and tab ${tab.id} shows another kind of page.`,
      });
      assert.deepEqual(fake.injections, []);
    });
  }

  it("refuses an unapproved site without asking", async (t) => {
    const { fake, call, open, access } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, "https://a.example/x");
    await flush();
    const update = t.mock.method(fake.browser.tabs, "update");
    await assert.rejects(call("s1", "probe_input", { tabId: tab.id }), {
      code: "site_not_approved",
      message: `Foxhand is not allowed on https://a.example in this session; call navigate with tab ${tab.id} and action reload to ask the user.`,
    });
    await flush();
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/x");
    assert.deepEqual(fake.injections, []);
  });

  it("refuses a blocklisted site, also when the user granted it", async () => {
    const { fake, call, open, grant } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, "https://www.paypal.com/");
    await flush();
    const blocked = {
      code: "site_blocked",
      message:
        "Foxhand does not act on https://www.paypal.com: it is on Foxhand's blocklist, which by default lists common financial and health sites.",
    };
    await assert.rejects(call("s1", "probe_input", { tabId: tab.id }), blocked);
    await grant("https://www.paypal.com");
    await assert.rejects(call("s1", "probe_input", { tabId: tab.id }), blocked);
    assert.deepEqual(fake.injections, []);
  });

  it("runs the bundled probe in the tab's isolated world and returns frame 0's result", async () => {
    const { fake, call, open, grant, probe, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/page");
    const timersBefore = timers.pending();
    fake.injectionResults = [
      { frameId: 4, result: { userAgent: "frame 4", checks: [] } },
      { frameId: 0, result: RESULT },
    ];
    const before = Date.now();
    assert.deepEqual(await call("s1", "probe_input", { tabId: tab.id }), RESULT);
    const after = Date.now();
    assert.equal(fake.injections.length, 1);
    const [injection] = fake.injections;
    assert.equal(injection?.func, probe);
    const cutoff = injection?.args?.[1];
    assert.ok(
      typeof cutoff === "number" &&
        cutoff >= before + PROBE_CUTOFF_MS &&
        cutoff <= after + PROBE_CUTOFF_MS,
      String(cutoff),
    );
    assert.deepEqual(injection, {
      tabId: tab.id,
      func: probe,
      args: ["https://a.example", cutoff],
      world: "ISOLATED",
    });
    assert.equal(timers.pending(), timersBefore);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/page");
  });

  it("fails once when Firefox refuses the injection, without its error text", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/secret-path");
    fake.failNextInjection(new Error("Missing host permission for https://a.example/secret-path"));
    await assert.rejects(call("s1", "probe_input", { tabId: tab.id }), {
      code: "probe_failed",
      message: `Foxhand could not run its input probe in tab ${tab.id}.`,
    });
    fake.injectionResults = [{ frameId: 0, result: RESULT }];
    assert.deepEqual(await call("s1", "probe_input", { tabId: tab.id }), RESULT);
  });

  const failures: {
    name: string;
    frames: { frameId: number; result?: unknown; error?: unknown }[];
  }[] = [
    { name: "an error in frame 0", frames: [{ frameId: 0, error: new Error("boom") }] },
    { name: "an error with a result", frames: [{ frameId: 0, result: RESULT, error: "boom" }] },
    { name: "no frame 0", frames: [{ frameId: 2, result: RESULT }] },
    { name: "no frames", frames: [] },
    { name: "an undefined result", frames: [{ frameId: 0 }] },
  ];
  for (const { name, frames } of failures) {
    it(`fails on ${name}`, async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.injectionResults = frames;
      await rejectsWith(call("s1", "probe_input", { tabId: tab.id }), "probe_failed", name);
    });
  }

  it("refuses when the probe finds the tab on another site", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.injectionResults = [{ frameId: 0, result: null }];
    await assert.rejects(call("s1", "probe_input", { tabId: tab.id }), {
      code: "site_not_approved",
      message: `Tab ${tab.id} no longer shows https://a.example.`,
    });
  });

  it("fails an injection that never settles once the probe timeout passes", async (t) => {
    const { fake, call, open, grant, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    t.mock.method(fake.browser.scripting, "executeScript", () => new Promise(() => {}));
    let settled = false;
    const probed = call("s1", "probe_input", { tabId: tab.id });
    probed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    timers.advance(PROBE_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false);
    timers.advance(1);
    await rejectsWith(probed, "probe_failed");
  });

  it("bounds the injection below the host's 60 s request timeout", () => {
    assert.equal(PROBE_TIMEOUT_MS, 30_000);
  });

  it("stops the probe acting 5 s before the injection timeout", () => {
    assert.equal(PROBE_TIMEOUT_MS - PROBE_CUTOFF_MS, 5_000);
  });
});

describe("read_page", { timeout: 10000 }, () => {
  it("refuses a tab id that is not a whole number of 0 or more before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const tabId of [undefined, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
      await assert.rejects(call("s1", "read_page", tabId === undefined ? {} : { tabId }), {
        code: "invalid_params",
        message: "read_page needs a tab id that is a whole number of 0 or more.",
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("refuses bad options with their sentence before asking the page", async () => {
    const { call, pageCalls } = setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ filter: "links" }, "read_page needs filter to be all or interactive."],
      [{ filter: 1 }, "read_page needs filter to be all or interactive."],
      [{ depth: 0 }, "read_page needs depth to be a whole number of 1 or more."],
      [{ depth: 1.5 }, "read_page needs depth to be a whole number of 1 or more."],
      [{ depth: "2" }, "read_page needs depth to be a whole number of 1 or more."],
      [{ ref: 7 }, "read_page needs ref to be a string."],
    ];
    for (const [options, message] of cases) {
      await assert.rejects(call("s1", "read_page", { tabId: 3, ...options }), {
        code: "invalid_params",
        message,
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("asks the page for read_page with only the options given", async () => {
    const { call, pageCalls } = setup();
    await call("s1", "read_page", { tabId: 3 });
    await call("s2", "read_page", {
      tabId: 0,
      filter: "interactive",
      depth: 2,
      ref: "0a1b2c3d-4",
      extra: true,
    });
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: 3, type: "read_page", params: { filter: "all" } },
      {
        session: "s2",
        tabId: 0,
        type: "read_page",
        params: { filter: "interactive", depth: 2, ref: "0a1b2c3d-4" },
      },
    ]);
    assert.deepEqual(Object.keys(pageCalls[0]?.params ?? {}), ["filter"]);
  });

  it("returns only the tree and whether it was cut", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ tree: "main [0a1b2c3d-1]", truncated: true, extra: "page text" }));
    assert.deepEqual(await call("s1", "read_page", { tabId: 3 }), {
      tree: "main [0a1b2c3d-1]",
      truncated: true,
    });
  });

  it("refuses a reply it cannot read as page_error", async () => {
    const { call, replyWith } = setup();
    const replies: unknown[] = [
      undefined,
      null,
      "tree",
      [],
      { tree: 1, truncated: false },
      { tree: "a" },
      { truncated: false },
      { tree: "a", truncated: "yes" },
      Object.create({ tree: "a", truncated: false }),
    ];
    for (const reply of replies) {
      replyWith(async () => reply);
      await assert.rejects(call("s1", "read_page", { tabId: 3 }), {
        code: "page_error",
        message: "Foxhand could not complete the request in the page in tab 3.",
      });
    }
  });

  it("refuses a tree longer than the cap as page_error", async () => {
    const { call, replyWith } = setup();
    const fits = "a".repeat(READ_PAGE_MAX_CHARS);
    replyWith(async () => ({ tree: fits, truncated: true }));
    assert.deepEqual(await call("s1", "read_page", { tabId: 3 }), { tree: fits, truncated: true });
    replyWith(async () => ({ tree: `${fits}a`, truncated: true }));
    await rejectsWith(call("s1", "read_page", { tabId: 3 }), "page_error");
  });

  it("passes the page's refusal through unchanged", async () => {
    const { call, replyWith } = setup();
    const refusal = new ToolError(
      "stale_ref",
      "Element 0a1b2c3d-4 is from a page the tab no longer shows.",
    );
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(
      call("s1", "read_page", { tabId: 3 }),
      (error: unknown) => error === refusal,
    );
  });
});

describe("get_page_text", { timeout: 10000 }, () => {
  const text = { source: "main", main: "Story", rest: "Menu", truncated: false, totalChars: 9 };

  it("refuses a tab id that is not a whole number of 0 or more before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const tabId of [undefined, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
      await assert.rejects(call("s1", "get_page_text", tabId === undefined ? {} : { tabId }), {
        code: "invalid_params",
        message: "get_page_text needs a tab id that is a whole number of 0 or more.",
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("refuses a bad maxChars with its sentence before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const maxChars of [0, 200_001, 1.5, "100", null]) {
      await assert.rejects(call("s1", "get_page_text", { tabId: 3, maxChars }), {
        code: "invalid_params",
        message: "get_page_text needs maxChars to be a whole number from 1 to 200000.",
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("asks the page with maxChars only, the default when none is given", async () => {
    const { call, pageCalls, replyWith } = setup();
    replyWith(async () => text);
    await call("s1", "get_page_text", { tabId: 3 });
    await call("s2", "get_page_text", { tabId: 0, maxChars: 40, extra: true });
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: 3, type: "get_page_text", params: { maxChars: 50_000 } },
      { session: "s2", tabId: 0, type: "get_page_text", params: { maxChars: 40 } },
    ]);
  });

  it("returns only the five fields of the page's text", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ ...text, extra: "page text" }));
    assert.deepEqual(await call("s1", "get_page_text", { tabId: 3 }), text);
  });

  it("cuts a reply over maxChars again and marks it cut", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ ...text, main: "a".repeat(8), rest: "b".repeat(8) }));
    assert.deepEqual(await call("s1", "get_page_text", { tabId: 3, maxChars: 10 }), {
      ...text,
      main: "a".repeat(8),
      rest: "bb",
      truncated: true,
    });
  });

  it("refuses a reply it cannot read as page_error", async () => {
    const { call, replyWith } = setup();
    const replies: unknown[] = [
      undefined,
      null,
      "text",
      [],
      { ...text, source: "header" },
      { ...text, main: 1 },
      { ...text, truncated: "no" },
      { ...text, totalChars: -1 },
      Object.create(text),
    ];
    for (const reply of replies) {
      replyWith(async () => reply);
      await assert.rejects(call("s1", "get_page_text", { tabId: 3 }), {
        code: "page_error",
        message: "Foxhand could not complete the request in the page in tab 3.",
      });
    }
  });

  it("passes the page's refusal through unchanged", async () => {
    const { call, replyWith } = setup();
    const refusal = new ToolError("site_not_approved", "Foxhand is not allowed on that site.");
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(
      call("s1", "get_page_text", { tabId: 3 }),
      (error: unknown) => error === refusal,
    );
  });
});

describe("screenshot", { timeout: 10000 }, () => {
  const PNG = ONE_PIXEL_PNG.slice("data:image/png;base64,".length);
  const BOX = {
    rect: { left: 10, top: 20, width: 120, height: 80 },
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 1500 },
  };
  const CHECK = { session: "s1", type: "password_fields", params: {} };
  /** The element's box for element_rect, and no revealed field for password_fields. */
  const boxReply =
    (box: unknown): PageReply =>
    async (type) =>
      type === "element_rect" ? box : { revealed: false };

  it("refuses a tab id that is not a whole number of 0 or more before anything else", async (t) => {
    const { fake, call, pageCalls } = setup();
    const get = t.mock.method(fake.browser.tabs, "get");
    for (const tabId of [undefined, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
      await assert.rejects(call("s1", "screenshot", tabId === undefined ? {} : { tabId }), {
        code: "invalid_params",
        message: "screenshot needs a tab id that is a whole number of 0 or more.",
      });
    }
    assert.equal(get.mock.callCount(), 0);
    assert.deepEqual(pageCalls, []);
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("takes 0 as a tab id", async () => {
    const { call, open } = setup();
    await open("s1");
    await assert.rejects(call("s1", "screenshot", { tabId: 0 }), { code: "tab_not_found" });
  });

  it("refuses a ref that is not a string before anything else", async (t) => {
    const { fake, call, open, grant, pageCalls } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const get = t.mock.method(fake.browser.tabs, "get");
    for (const ref of [7, null, undefined, {}, ["0a1b2c3d-1"]]) {
      await assert.rejects(call("s1", "screenshot", { tabId: tab.id, ref }), {
        code: "invalid_params",
        message: "screenshot needs ref to be a string.",
      });
    }
    assert.equal(get.mock.callCount(), 0);
    assert.deepEqual(pageCalls, []);
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("captures the tab's viewport as a PNG at scale 1 and returns its base64", async () => {
    const { fake, call, open, grant, pageCalls, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timersBefore = timers.pending();
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    assert.deepEqual(fake.captures, [{ tabId: tab.id, format: "png", scale: 1 }]);
    assert.deepEqual(pageCalls, [
      { ...CHECK, tabId: tab.id },
      { ...CHECK, tabId: tab.id },
    ]);
    assert.equal(timers.pending(), timersBefore);
  });

  it("captures the tab it names, also when another tab is active", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const first = await open("s1", "https://a.example/one");
    const second = await open("s1", "https://a.example/two");
    assert.equal(fake.tabs.get(first.id)?.active, false);
    assert.equal(fake.tabs.get(second.id)?.active, true);
    await call("s1", "screenshot", { tabId: first.id });
    assert.deepEqual(
      fake.captures.map((capture) => capture.tabId),
      [first.id],
    );
  });

  it("refuses a tab that does not exist or is outside the session's group", async () => {
    const { fake, call, open, grant, pageCalls } = setup();
    await grant("https://a.example");
    await open("s1", "https://a.example/");
    const outside = fake.openTab({ url: "https://a.example/" });
    await assert.rejects(call("s1", "screenshot", { tabId: 99 }), {
      code: "tab_not_found",
      message: "Tab 99 does not exist.",
    });
    await rejectsWith(call("s1", "screenshot", { tabId: outside.id }), "tab_not_in_group");
    await rejectsWith(
      call("s1", "screenshot", { tabId: outside.id, ref: "0a1b2c3d-1" }),
      "tab_not_in_group",
    );
    assert.deepEqual(pageCalls, []);
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("refuses the tab that shows the session's open prompt", async () => {
    const { fake, call, promptOf } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/" });
    const prompt = await promptOf("s1");
    await rejectsWith(call("s1", "screenshot", { tabId: prompt.tabId }), "approval_pending");
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
    void opened.catch(() => {});
  });

  it("refuses a page that is not on the web, an unapproved site and a blocked one", async () => {
    const { fake, call, open, grant, access } = setup();
    const tab = await open("s1");
    const cases: [string, string][] = [
      ["about:blank", "page_not_web"],
      ["moz-extension://abc/options.html", "page_not_web"],
      ["https://a.example/x", "site_not_approved"],
      ["https://www.paypal.com/", "site_blocked"],
    ];
    await grant("https://www.paypal.com");
    for (const [url, code] of cases) {
      fake.navigateByUser(tab.id, url);
      await flush();
      await rejectsWith(call("s1", "screenshot", { tabId: tab.id }), code, url);
    }
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("asks the page for the element's box, then captures it in page coordinates", async () => {
    const { fake, call, open, grant, pageCalls, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    let capturesAtRequest = -1;
    replyWith(async (type) => {
      if (type !== "element_rect") return { revealed: false };
      capturesAtRequest = fake.captures.length;
      return BOX;
    });
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id, ref: "0a1b2c3d-4" }), {
      data: PNG,
    });
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: tab.id, type: "element_rect", params: { ref: "0a1b2c3d-4" } },
      { ...CHECK, tabId: tab.id },
      { ...CHECK, tabId: tab.id },
    ]);
    assert.equal(capturesAtRequest, 0);
    assert.deepEqual(fake.captures, [
      {
        tabId: tab.id,
        format: "png",
        scale: 1,
        rect: { x: 10, y: 1520, width: 120, height: 80 },
      },
    ]);
  });

  it("refuses an element with no visible area, or a box it cannot read, without capturing", async () => {
    const { fake, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    replyWith(boxReply({ ...BOX, rect: { left: 0, top: 0, width: 0, height: 0 } }));
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id, ref: "0a1b2c3d-4" }), {
      code: "element_not_visible",
      message: `The element has no visible area in tab ${tab.id}.`,
    });
    replyWith(boxReply({ ...BOX, scroll: undefined }));
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id, ref: "0a1b2c3d-4" }), {
      code: "page_error",
      message: `Foxhand could not complete the request in the page in tab ${tab.id}.`,
    });
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("passes the page's refusal of the ref through unchanged", async () => {
    const { fake, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const refusal = new ToolError(
      "stale_ref",
      "Element 0a1b2c3d-4 is from a page the tab no longer shows.",
    );
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(
      call("s1", "screenshot", { tabId: tab.id, ref: "0a1b2c3d-4" }),
      (error: unknown) => error === refusal,
    );
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("fails without Firefox's error text when the capture is refused", async () => {
    const { fake, call, open, grant, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/secret-path");
    const timersBefore = timers.pending();
    fake.failNextCapture(new Error("Cannot capture https://a.example/secret-path"));
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
      code: "screenshot_failed",
      message: `Firefox could not take a screenshot of tab ${tab.id}.`,
    });
    assert.equal(timers.pending(), timersBefore);
    await flush();
    assert.equal(fake.captures.length, 1);
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0]);
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
  });

  it("refuses a capture that is not a PNG data URL", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.captureResult = "data:image/jpeg;base64,/9j/4AAQ";
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
      code: "screenshot_failed",
      message: `Firefox could not take a screenshot of tab ${tab.id}.`,
    });
  });

  it("fails a capture that never settles once CAPTURE_TIMEOUT_MS passes", async () => {
    const { fake, call, open, grant, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timersBefore = timers.pending();
    fake.holdNextCapture();
    let settled = false;
    const shot = call("s1", "screenshot", { tabId: tab.id });
    shot.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    assert.equal(fake.captures.length, 1);
    timers.advance(CAPTURE_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false);
    assert.deepEqual(
      fake.cssCalls.map((css) => css.method),
      ["insertCSS"],
    );
    timers.advance(1);
    await assert.rejects(shot, {
      code: "page_timeout",
      message: `Firefox did not take the screenshot of tab ${tab.id} in time; try again.`,
    });
    assert.equal(timers.pending(), timersBefore);
    await flush();
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0]);
    // Only that capture was held.
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
  });

  it("has a fake captureTab and getAllFrames that reject a tab Firefox does not know", async () => {
    const { fake } = setup();
    await assert.rejects(fake.browser.tabs.captureTab(99, { format: "png" }), {
      message: "Invalid tab ID: 99",
    });
    await assert.rejects(fake.browser.webNavigation.getAllFrames({ tabId: 99 }), {
      message: "Invalid tab ID: 99",
    });
  });

  it("bounds the capture and the whole screenshot below the host's 60 s timeout", () => {
    assert.equal(CAPTURE_TIMEOUT_MS, 20_000);
    assert.equal(SCREENSHOT_TIMEOUT_MS, 50_000);
    assert.ok(PAGE_INJECTION_MS + PAGE_REPLY_MS + CAPTURE_TIMEOUT_MS < 60_000);
    assert.ok(SCREENSHOT_TIMEOUT_MS < 60_000);
  });

  it("returns no data when the tab shows another site and comes back during the capture", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const listeners = fake.listenerCount();
    for (const away of ["https://c.example/", "about:blank"]) {
      const release = fake.holdNextCapture();
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      fake.navigateByUser(tab.id, away);
      await flush();
      fake.navigateByUser(tab.id, "https://a.example/");
      await flush();
      release();
      await assert.rejects(shot, {
        code: "page_changed",
        message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
      });
      assert.equal(fake.listenerCount(), listeners, away);
      assert.equal(fake.committedListenerCount(), 0, away);
    }
  });

  it("returns no data when the tab reports another site and back during the capture, with no commit", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const release = fake.holdNextCapture();
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    // Only tabs.onUpdated reports the visit, so the site watch alone must catch it.
    fake.pushState(tab.id, "https://c.example/");
    fake.pushState(tab.id, "https://a.example/");
    await flush();
    release();
    await assert.rejects(shot, {
      code: "page_changed",
      message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
    });
  });

  it("returns the data when the page changes its URL within its site during the capture", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const other = fake.openTab({ url: "https://a.example/" });
    const listeners = fake.listenerCount();
    const updates: TabChangeInfo[] = [];
    fake.browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (tabId === tab.id) updates.push(changeInfo);
    });
    const release = fake.holdNextCapture();
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    const indexBefore = fake.tabs.get(tab.id)?.index ?? -1;
    fake.pushState(tab.id, "https://a.example/next");
    // Another tab loading another site changes nothing for this one.
    fake.navigateByUser(other.id, "https://c.example/");
    await flush();
    release();
    assert.deepEqual(await shot, { data: PNG });
    assert.deepEqual(updates, [{ url: "https://a.example/next" }]);
    assert.deepEqual(
      [
        fake.tabs.get(tab.id)?.url,
        fake.tabs.get(tab.id)?.history.at(-1),
        fake.tabs.get(tab.id)?.index,
      ],
      ["https://a.example/next", "https://a.example/next", indexBefore + 1],
    );
    assert.equal(fake.listenerCount(), listeners + 1);
    await rejectsWith(call("s1", "screenshot", { tabId: 99 }), "tab_not_found");
    assert.equal(fake.listenerCount(), listeners + 1);
  });

  it("returns no data when the tab shows another site at the second gate before Firefox reports it", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    const release = fake.holdNextCapture();
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    const shown = fake.tabs.get(tab.id);
    assert.ok(shown !== undefined);
    // No tabs.onUpdated and no commit yet.
    shown.url = "https://b.example/";
    release();
    await assert.rejects(shot, {
      code: "page_changed",
      message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
    });
  });

  it("hides field text in every frame of the tab while it captures, then removes each sheet", async () => {
    const { fake, call, open, grant, pageCalls, replyWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.setFrames(tab.id, [0, 5, 9]);
    const seen: { css: number; captures: number }[] = [];
    replyWith(async () => {
      seen.push({ css: fake.cssCalls.length, captures: fake.captures.length });
      return { revealed: false };
    });
    let cssAtCapture = -1;
    const captureTab = fake.browser.tabs.captureTab;
    fake.browser.tabs.captureTab = (tabId, options) => {
      cssAtCapture = fake.cssCalls.length;
      return captureTab(tabId, options);
    };
    const timersBefore = timers.pending();
    const listeners = fake.listenerCount();
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    await flush();
    assert.deepEqual(pageCalls, [
      { ...CHECK, tabId: tab.id },
      { ...CHECK, tabId: tab.id },
    ]);
    // The first check before any sheet, the second after the capture.
    assert.equal(seen[0]?.css, 0);
    assert.equal(seen[1]?.captures, 1);
    assert.equal(cssAtCapture, 3);
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0, 5, 9]);
    assert.equal(timers.pending(), timersBefore);
    assert.equal(fake.committedListenerCount(), 0);
    assert.equal(fake.listenerCount(), listeners);
  });

  it("hides field text in every frame for an element screenshot too", async () => {
    const { fake, call, open, grant, pageCalls, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.setFrames(tab.id, [0, 4]);
    replyWith(boxReply(BOX));
    let cssAtCapture = -1;
    const captureTab = fake.browser.tabs.captureTab;
    fake.browser.tabs.captureTab = (tabId, options) => {
      cssAtCapture = fake.cssCalls.length;
      return captureTab(tabId, options);
    };
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id, ref: "0a1b2c3d-4" }), {
      data: PNG,
    });
    await flush();
    assert.deepEqual(
      pageCalls.map((page) => page.type),
      ["element_rect", "password_fields", "password_fields"],
    );
    assert.equal(cssAtCapture, 2);
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0, 4]);
  });

  it("refuses without Firefox's error text and captures nothing when a frame refuses the sheet", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/secret");
    fake.setFrames(tab.id, [0, 5, 9]);
    fake.failInsertCSS(9, new Error("Missing host permission for https://a.example/secret"));
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
      code: "screenshot_failed",
      message: `Firefox could not take a screenshot of tab ${tab.id}.`,
    });
    await flush();
    assert.deepEqual(fake.captures, []);
    // A refused insertion may still have reached other frames: every sheet is removed.
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0, 5, 9]);
    // Only that insertion was refused.
    fake.cssCalls.length = 0;
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
  });

  it("refuses a tab whose frames it cannot list, or whose list has no top frame", async (t) => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    for (const frames of [null, [5, 9], []]) {
      fake.setFrames(tab.id, frames);
      await assert.rejects(
        call("s1", "screenshot", { tabId: tab.id }),
        {
          code: "screenshot_failed",
          message: `Firefox could not take a screenshot of tab ${tab.id}.`,
        },
        JSON.stringify(frames),
      );
    }
    fake.setFrames(tab.id, [0]);
    t.mock.method(fake.browser.webNavigation, "getAllFrames", async () => {
      throw new Error("Invalid tab ID: https://a.example/");
    });
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
      code: "screenshot_failed",
      message: `Firefox could not take a screenshot of tab ${tab.id}.`,
    });
    await flush();
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("times out a sheet that never goes in, and never captures after that", async () => {
    const { fake, call, open, grant, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timersBefore = timers.pending();
    const release = fake.holdNextInsertCSS();
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    assert.equal(fake.cssCalls.length, 1);
    timers.advance(CAPTURE_TIMEOUT_MS);
    await assert.rejects(shot, {
      code: "page_timeout",
      message: `Firefox did not take the screenshot of tab ${tab.id} in time; try again.`,
    });
    assert.equal(timers.pending(), timersBefore);
    // Only that insertion was held.
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    await flush();
    assertMaskedAndRemoved(fake.cssCalls.splice(1), tab.id, [0]);
    assert.equal(fake.captures.length, 1);
    // No removal before its insertion settles.
    assert.equal(fake.cssCalls.length, 1);
    release();
    await flush();
    assert.equal(fake.captures.length, 1);
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0]);
  });

  it("removes each sheet once its own insertion settles, not held by another frame's", async () => {
    const { fake, call, open, grant, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.setFrames(tab.id, [5, 0]);
    const release = fake.holdNextInsertCSS();
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    timers.advance(CAPTURE_TIMEOUT_MS);
    await assert.rejects(shot, { code: "page_timeout" });
    await flush();
    const [held, top] = fake.cssCalls;
    assert.deepEqual(held?.frameIds, [5]);
    assert.deepEqual(top?.frameIds, [0]);
    // The top frame's sheet goes while frame 5 has still not taken its own.
    assert.deepEqual(fake.cssCalls, [held, top, { ...top, method: "removeCSS" }]);
    release();
    await flush();
    assert.deepEqual(fake.cssCalls.slice(3), [{ ...held, method: "removeCSS" }]);
  });

  it("returns the image without waiting for the sheets to go", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.setFrames(tab.id, [0, 5]);
    const removals = settledRemovals(fake);
    const listeners = fake.listenerCount();
    const release = fake.holdNextRemoveCSS();
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    assert.equal(fake.committedListenerCount(), 0);
    assert.equal(fake.listenerCount(), listeners);
    await flush();
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0, 5]);
    // Only the first removal is held.
    assert.deepEqual(removals, { fulfilled: 1, rejected: 0 });
    release();
    await flush();
    assert.deepEqual(removals, { fulfilled: 2, rejected: 0 });
  });

  it("returns the image, which was masked, when a sheet cannot be removed", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.setFrames(tab.id, [0, 5]);
    const removals = settledRemovals(fake);
    fake.failNextRemoveCSS(new Error("Invalid tab ID"));
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    await flush();
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0, 5]);
    assert.deepEqual(removals, { fulfilled: 1, rejected: 1 });
  });

  it("hides every input's text in the top document once the page revealed a password field", async () => {
    const { fake, call, open, grant, pageCalls, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    fake.setFrames(tab.id, [0, 5]);
    replyWith(async () => ({ revealed: true }));
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    await flush();
    // Revealed already: a second check could change nothing.
    assert.deepEqual(pageCalls, [{ ...CHECK, tabId: tab.id }]);
    const inserts = fake.cssCalls.filter((css) => css.method === "insertCSS");
    assert.deepEqual(
      inserts.map((css) => css.frameIds),
      [[0], [5], [0]],
    );
    assert.ok(inserts[0]?.css.startsWith(FIELD_MASK_CSS));
    assert.ok(inserts[1]?.css.startsWith(FIELD_MASK_CSS));
    assert.ok(inserts[2]?.css.startsWith(INPUT_MASK_CSS));
    assert.ok(inserts.every((css) => css.origin === "USER" && css.tabId === tab.id));
    assert.deepEqual(fake.cssCalls, [
      ...inserts,
      ...inserts.map((css) => ({ ...css, method: "removeCSS" })),
    ]);
  });

  it("returns no data when the page reveals a password field during the capture", async () => {
    const { fake, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    let checks = 0;
    replyWith(async () => {
      checks += 1;
      return { revealed: checks > 1 };
    });
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
      code: "page_changed",
      message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
    });
    await flush();
    assert.equal(checks, 2);
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0]);
  });

  it("refuses a password_fields reply it cannot read as page_error", async () => {
    const { fake, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const pageError = {
      code: "page_error",
      message: `Foxhand could not complete the request in the page in tab ${tab.id}.`,
    };
    for (const reply of [{}, { revealed: "true" }, Object.create({ revealed: false }), null]) {
      replyWith(async () => reply);
      await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), pageError);
    }
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
    let checks = 0;
    replyWith(async () => {
      checks += 1;
      return checks > 1 ? { revealed: 0 } : { revealed: false };
    });
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), pageError);
    assert.equal(fake.captures.length, 1);
  });

  const commitPoints: {
    name: string;
    hold: (ctx: ReturnType<typeof setup>) => () => void;
  }[] = [
    { name: "while the page is checked", hold: (ctx) => holdCheck(ctx, 1) },
    { name: "while a sheet goes in", hold: ({ fake }) => fake.holdNextInsertCSS() },
    { name: "while the tab is captured", hold: ({ fake }) => fake.holdNextCapture() },
    { name: "while the page is checked again", hold: (ctx) => holdCheck(ctx, 2) },
  ];
  for (const { name, hold } of commitPoints) {
    it(`returns no data when a frame loads a document ${name}`, async () => {
      const ctx = setup();
      const { fake, call, open, grant } = ctx;
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, 3]);
      const release = hold(ctx);
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      fake.emitCommitted({ tabId: tab.id, frameId: 3, url: "https://ads.example/next" });
      release();
      await assert.rejects(shot, {
        code: "page_changed",
        message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
      });
      assert.equal(fake.committedListenerCount(), 0);
    });
  }

  it("returns the data when a frame of another tab loads a document", async () => {
    const ctx = setup();
    const { fake, call, open, grant } = ctx;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const release = fake.holdNextCapture();
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    fake.emitCommitted({ tabId: tab.id + 1, frameId: 0, url: "https://a.example/" });
    release();
    assert.deepEqual(await shot, { data: PNG });
  });

  it("gives each of two screenshots of one tab its own sheets", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const shots = [
      call("s1", "screenshot", { tabId: tab.id }),
      call("s1", "screenshot", { tabId: tab.id }),
    ];
    assert.deepEqual(await Promise.all(shots), [{ data: PNG }, { data: PNG }]);
    await flush();
    const inserted = fake.cssCalls
      .filter((css) => css.method === "insertCSS")
      .map((css) => css.css);
    const removed = fake.cssCalls.filter((css) => css.method === "removeCSS").map((css) => css.css);
    assert.equal(inserted.length, 2);
    assert.notEqual(inserted[0], inserted[1]);
    assert.deepEqual([...removed].sort(), [...inserted].sort());
  });

  it("answers page_timeout once SCREENSHOT_TIMEOUT_MS passes, and stops there", async () => {
    const ctx = setup();
    const { fake, call, open, grant, timers } = ctx;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timeout = {
      code: "page_timeout",
      message: `Foxhand did not finish the screenshot of tab ${tab.id} in time; try again.`,
    };
    const timersBefore = timers.pending();
    holdCheck(ctx, 2);
    const late = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    assert.equal(fake.captures.length, 1);
    timers.advance(SCREENSHOT_TIMEOUT_MS - 1);
    await flush();
    timers.advance(1);
    await assert.rejects(late, timeout);
    await flush();
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0]);
    assert.equal(timers.pending(), timersBefore);

    fake.cssCalls.length = 0;
    fake.captures.length = 0;
    const release = holdCheck(ctx, 1);
    const early = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    timers.advance(SCREENSHOT_TIMEOUT_MS);
    await assert.rejects(early, timeout);
    // The page answering after the deadline masks and captures nothing.
    release();
    await flush();
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
    assert.equal(timers.pending(), timersBefore);
  });

  it("captures nothing once SCREENSHOT_TIMEOUT_MS passes while a sheet goes in", async () => {
    const ctx = setup();
    const { fake, call, open, grant, timers } = ctx;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timersBefore = timers.pending();
    const answer = holdCheck(ctx, 1);
    const shot = call("s1", "screenshot", { tabId: tab.id });
    await flush();
    timers.advance(SCREENSHOT_TIMEOUT_MS - 5_000);
    const release = fake.holdNextInsertCSS();
    answer();
    await flush();
    assert.equal(fake.cssCalls.length, 1);
    // Within CAPTURE_TIMEOUT_MS of the insertion, but past the whole screenshot's deadline.
    timers.advance(5_000);
    await assert.rejects(shot, {
      code: "page_timeout",
      message: `Foxhand did not finish the screenshot of tab ${tab.id} in time; try again.`,
    });
    release();
    await flush();
    assert.deepEqual(fake.captures, []);
    assertMaskedAndRemoved(fake.cssCalls, tab.id, [0]);
    assert.equal(timers.pending(), timersBefore);
  });

  const changes: {
    name: string;
    change: (ctx: ReturnType<typeof setup>, tabId: number) => Promise<void> | void;
    code: string;
    message?: (tabId: number) => string;
  }[] = [
    {
      name: "the tab moving to another approved site",
      change: ({ fake }, tabId) => fake.navigateByUser(tabId, "https://b.example/"),
      code: "page_changed",
      message: (tabId) =>
        `The page in tab ${tabId} changed while Foxhand was working in it; try again.`,
    },
    {
      name: "the tab moving to an unapproved site",
      change: ({ fake }, tabId) => fake.navigateByUser(tabId, "https://c.example/"),
      code: "site_not_approved",
    },
    {
      name: "the user revoking the site",
      change: ({ fake }) => revokeSite(fake.browser, "https://a.example"),
      code: "site_not_approved",
    },
    {
      name: "the tab reloading",
      change: ({ fake }, tabId) => fake.browser.tabs.reload(tabId),
      code: "page_changed",
      message: (tabId) =>
        `The page in tab ${tabId} changed while Foxhand was working in it; try again.`,
    },
    {
      name: "the tab leaving the session's group",
      change: ({ fake }, tabId) => fake.ungroup(tabId),
      code: "tab_not_in_group",
    },
    {
      name: "the tab closing",
      change: ({ fake }, tabId) => fake.removeTab(tabId),
      code: "tab_not_found",
    },
  ];
  for (const { name, change, code, message } of changes) {
    it(`returns no data after ${name} during the capture`, async () => {
      const ctx = setup();
      const { fake, call, open, grant } = ctx;
      await grant("https://a.example");
      await grant("https://b.example");
      const tab = await open("s1", "https://a.example/");
      const release = fake.holdNextCapture();
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      assert.equal(fake.captures.length, 1);
      await change(ctx, tab.id);
      await flush();
      release();
      await assert.rejects(
        shot,
        message === undefined ? { code } : { code, message: message(tab.id) },
      );
    });
  }
});

describe("upload_chunk", { timeout: 10000 }, () => {
  it("stages the chunk and returns the bytes staged for the upload", async () => {
    const { call, uploads } = setup();
    assert.deepEqual(await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQID" }), {
      received: 3,
    });
    assert.deepEqual(await call("s1", "upload_chunk", { upload: "u1", index: 1, data: "BA==" }), {
      received: 4,
    });
    assert.deepEqual(uploads.take("s1", "u1"), new Uint8Array([1, 2, 3, 4]));
  });

  it("refuses each invalid param, reading own fields only", async () => {
    const { call, uploads } = setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ index: 0, data: "AQID" }, "upload_chunk needs an upload id of 1 to 64 characters."],
      [
        { upload: 1, index: 0, data: "AQID" },
        "upload_chunk needs an upload id of 1 to 64 characters.",
      ],
      [
        { upload: "u1", data: "AQID" },
        "upload_chunk got a chunk out of order; Foxhand expected chunk 0 of that upload.",
      ],
      [{ upload: "u1", index: 0 }, "upload_chunk needs data to be base64."],
      [{ upload: "u1", index: 0, data: "A?ID" }, "upload_chunk needs data to be base64."],
      [
        Object.assign(Object.create({ upload: "u1", index: 0, data: "AQID" }), {}),
        "upload_chunk needs an upload id of 1 to 64 characters.",
      ],
    ];
    for (const [params, message] of cases) {
      await assert.rejects(call("s1", "upload_chunk", params), { code: "invalid_params", message });
    }
    assert.equal(uploads.take("s1", "u1"), undefined);
  });
});

describe("upload_file", { timeout: 10000 }, () => {
  const REF = "0a1b2c3d-5";

  it("hands each file its slice of the staged bytes, and answers from the request", async () => {
    const { call, pageCalls, replyWith } = setup();
    await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQIDBA==" });
    await call("s1", "upload_chunk", { upload: "u1", index: 1, data: "BQ==" });
    replyWith(async () => ({ target: "drop", files: [{ name: "page.txt", size: 99 }] }));
    const result = await call("s1", "upload_file", {
      tabId: 3,
      ref: REF,
      upload: "u1",
      files: [
        { name: "a.txt", type: "text/plain", size: 2 },
        { name: "empty", type: "", size: 0 },
        { name: "b.png", type: "image/png", size: 3 },
      ],
    });
    assert.deepEqual(result, {
      target: "drop",
      files: [
        { name: "a.txt", size: 2 },
        { name: "empty", size: 0 },
        { name: "b.png", size: 3 },
      ],
    });
    assert.deepEqual(pageCalls, [
      {
        session: "s1",
        tabId: 3,
        type: "upload_file",
        params: {
          ref: REF,
          files: [
            { name: "a.txt", type: "text/plain", bytes: new Uint8Array([1, 2]) },
            { name: "empty", type: "", bytes: new Uint8Array([]) },
            { name: "b.png", type: "image/png", bytes: new Uint8Array([3, 4, 5]) },
          ],
        },
      },
    ]);
  });

  it("takes nothing staged as no bytes, for empty files", async () => {
    const { call, pageCalls, replyWith } = setup();
    replyWith(async () => ({ target: "input" }));
    const result = await call("s1", "upload_file", {
      tabId: 0,
      ref: REF,
      upload: "never-sent",
      files: [{ name: "empty.txt", type: "text/plain", size: 0 }],
    });
    assert.deepEqual(result, { target: "input", files: [{ name: "empty.txt", size: 0 }] });
    assert.deepEqual(pageCalls[0]?.params.files, [
      { name: "empty.txt", type: "text/plain", bytes: new Uint8Array([]) },
    ]);
  });

  it("refuses an upload id that is not a string, and touches nothing staged", async () => {
    const { call, uploads, pageCalls } = setup();
    await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
    for (const upload of [undefined, 1]) {
      await assert.rejects(call("s1", "upload_file", { ...valid(), upload }), {
        code: "invalid_params",
        message: "upload_file needs upload to be a string.",
      });
    }
    assert.deepEqual(pageCalls, []);
    assert.deepEqual(uploads.take("s1", "u1"), new Uint8Array([1]));
  });

  it("refuses each other invalid param before asking the page, and drops the bytes", async () => {
    const { call, uploads, pageCalls } = setup();
    const name = (files: unknown) => ({ files });
    const file = { name: "a.txt", type: "text/plain", size: 1 };
    const cases: [Record<string, unknown>, string][] = [
      [{ tabId: undefined }, "upload_file needs a tab id that is a whole number of 0 or more."],
      [{ tabId: -1 }, "upload_file needs a tab id that is a whole number of 0 or more."],
      [{ tabId: 1.5 }, "upload_file needs a tab id that is a whole number of 0 or more."],
      [{ tabId: "3" }, "upload_file needs a tab id that is a whole number of 0 or more."],
      [{ ref: 5 }, "upload_file needs ref to be a string."],
      [{ ref: undefined }, "upload_file needs ref to be a string."],
      [name(undefined), "upload_file needs files to be a list of one or more files."],
      [name([]), "upload_file needs files to be a list of one or more files."],
      [name({ 0: file, length: 1 }), "upload_file needs files to be a list of one or more files."],
    ];
    const badName = "upload_file needs each file name to be 1 to 255 characters without a slash.";
    for (const value of [undefined, 1, "", "n".repeat(256), "a/b"]) {
      cases.push([name([{ ...file, name: value }]), badName]);
    }
    const badType = "upload_file needs each file type to be a string of at most 255 characters.";
    for (const value of [undefined, 1, "t".repeat(256)]) {
      cases.push([name([{ ...file, type: value }]), badType]);
    }
    const badSize = "upload_file needs each file size to be a whole number of 0 or more.";
    for (const value of [undefined, -1, 0.5, "1", 2 ** 53]) {
      cases.push([name([{ ...file, size: value }]), badSize]);
    }
    cases.push([name([null]), badName], [name([Object.create(file)]), badName]);
    for (const [change, message] of cases) {
      await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
      await assert.rejects(
        call("s1", "upload_file", { ...valid(), ...change }),
        { code: "invalid_params", message },
        JSON.stringify(change),
      );
      assert.equal(uploads.take("s1", "u1"), undefined, JSON.stringify(change));
    }
    assert.deepEqual(pageCalls, []);
  });

  it("accepts names and types at the length limit", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ target: "input" }));
    const name = "n".repeat(255);
    const result = await call("s1", "upload_file", {
      ...valid(),
      upload: "none",
      files: [{ name, type: "t".repeat(255), size: 0 }],
    });
    assert.deepEqual(result, { target: "input", files: [{ name, size: 0 }] });
  });

  it("refuses sizes that do not add up to the staged bytes, and drops them", async () => {
    const { call, uploads, pageCalls } = setup();
    for (const [size, held] of [
      [2, 1],
      [0, 1],
      [1, 0],
    ] as const) {
      if (held > 0) await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
      await assert.rejects(
        call("s1", "upload_file", {
          ...valid(),
          files: [{ name: "a.txt", type: "", size }],
        }),
        {
          code: "invalid_params",
          message: `The files of upload_file add up to ${size} bytes, but Foxhand holds ${held} for that upload.`,
        },
      );
      assert.equal(uploads.take("s1", "u1"), undefined);
    }
    assert.deepEqual(pageCalls, []);
  });

  it("finds only the bytes of its own session", async () => {
    const { call } = setup();
    await call("s2", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
    await assert.rejects(call("s1", "upload_file", valid()), {
      code: "invalid_params",
      message: "The files of upload_file add up to 1 bytes, but Foxhand holds 0 for that upload.",
    });
  });

  it("drops the bytes when the page request fails", async () => {
    const { call, replyWith } = setup();
    await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
    const refusal = new ToolError("invalid_target", "That file field is disabled.");
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(call("s1", "upload_file", valid()), (error: unknown) => error === refusal);
    replyWith(async () => ({ target: "input" }));
    await assert.rejects(call("s1", "upload_file", valid()), {
      code: "invalid_params",
      message: "The files of upload_file add up to 1 bytes, but Foxhand holds 0 for that upload.",
    });
  });

  it("refuses a reply without a target it knows as page_error", async () => {
    const { call, replyWith } = setup();
    for (const reply of [
      undefined,
      null,
      "input",
      ["input"],
      { target: "file" },
      {},
      Object.create({ target: "input" }),
    ]) {
      await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
      replyWith(async () => reply);
      await assert.rejects(
        call("s1", "upload_file", valid()),
        {
          code: "page_error",
          message: "Foxhand could not complete the request in the page in tab 3.",
        },
        String(reply),
      );
    }
  });

  function valid(): Record<string, unknown> {
    return {
      tabId: 3,
      ref: REF,
      upload: "u1",
      files: [{ name: "a.txt", type: "text/plain", size: 1 }],
    };
  }
});

interface PageCall {
  session: string;
  tabId: number;
  type: string;
  params: Record<string, unknown>;
}

type PageReply = (type: string) => Promise<unknown>;

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  const probe = async function probe(_site: string): Promise<ProbeResult | null> {
    return null;
  };
  const uploads = createUploads(timers);
  const pageCalls: PageCall[] = [];
  let pageReply: PageReply = defaultReply;
  const pages = {
    async request(session: string, tabId: number, type: string, params: Record<string, unknown>) {
      pageCalls.push({ session, tabId, type, params });
      return pageReply(type);
    },
  };
  const handleRequest = createHandlers({
    browser: fake.browser,
    groups,
    timers,
    access,
    probe,
    pages,
    uploads,
  });
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

  /** The session's open prompt, once its page has been loaded. */
  async function promptOf(session: string): Promise<OpenPrompt> {
    for (let turn = 0; turn < 50; turn += 1) {
      const prompt = access.openPrompt(session);
      if (prompt !== undefined) return prompt;
      await flush();
    }
    assert.fail(`session ${session} has no prompt`);
  }

  /** The prompt page of the session's open prompt connecting. */
  async function page(session: string): Promise<FakePort> {
    const { tabId } = await promptOf(session);
    return fake.connectPage("approve", {
      id: FAKE_EXTENSION_ID,
      url: fake.tabs.get(tabId)?.url ?? "",
      tab: { id: tabId },
    });
  }

  /** Lets the request on the session's prompt time out, leaving the prompt open. */
  async function timeOut(session: string): Promise<FakePort> {
    const shown = await page(session);
    timers.advance(APPROVAL_WAIT_MS);
    await flush();
    return shown;
  }

  /** What the fake content script answers from now on, by request type. */
  function replyWith(reply: PageReply): void {
    pageReply = reply;
  }

  return {
    fake,
    timers,
    sessions,
    access,
    probe,
    uploads,
    pageCalls,
    replyWith,
    call,
    open,
    list,
    navigate,
    grant,
    promptOf,
    page,
    timeOut,
  };
}

/**
 * Holds the reply to the `nth` password_fields request of the context's next screenshot until
 * the returned release runs; it then answers that no field was revealed.
 */
function holdCheck({ replyWith }: ReturnType<typeof setup>, nth: number): () => void {
  const { promise, resolve } = Promise.withResolvers<void>();
  let checks = 0;
  replyWith(async (type) => {
    if (type === "password_fields") {
      checks += 1;
      if (checks === nth) await promise;
    }
    return { revealed: false };
  });
  return () => resolve();
}

/** Counts the `scripting.removeCSS` calls from now on as they settle. */
function settledRemovals(fake: FakeBrowser): { fulfilled: number; rejected: number } {
  const counts = { fulfilled: 0, rejected: 0 };
  const removeCSS = fake.browser.scripting.removeCSS;
  fake.browser.scripting.removeCSS = (injection) => {
    const removal = removeCSS(injection);
    removal.then(
      () => {
        counts.fulfilled += 1;
      },
      () => {
        counts.rejected += 1;
      },
    );
    return removal;
  };
  return counts;
}

/** One field mask per frame inserted, then each removed with the same details. */
function assertMaskedAndRemoved(calls: CssCall[], tabId: number, frameIds: number[]): void {
  const inserts = calls.filter((css) => css.method === "insertCSS");
  assert.deepEqual(
    inserts.map((css) => css.frameIds),
    frameIds.map((frameId) => [frameId]),
  );
  for (const insert of inserts) {
    assert.equal(insert.tabId, tabId);
    assert.equal(insert.origin, "USER");
    assert.ok(insert.css.startsWith(FIELD_MASK_CSS), insert.css);
  }
  assert.deepEqual(calls, [
    ...inserts,
    ...inserts.map((insert) => ({ ...insert, method: "removeCSS" })),
  ]);
}

/** No remembered password field revealed for a screenshot, an empty tree for anything else. */
async function defaultReply(type: string): Promise<unknown> {
  return type === "password_fields" ? { revealed: false } : { tree: "", truncated: false };
}

/** Makes the navigation of a blank tab to `url` first report the blank tab's own load. */
function reportBlankLoadBefore(fake: FakeBrowser, url: string): void {
  const update = fake.browser.tabs.update;
  fake.browser.tabs.update = (tabId, properties) => {
    if (properties.url === url && fake.tabs.get(tabId)?.url === "about:blank") {
      fake.emitStatus(tabId, "loading");
      fake.emitStatus(tabId, "complete");
    }
    return update(tabId, properties);
  };
}

function loadsOf(fake: { tabUpdates: { url?: string }[] }, url: string): number {
  return fake.tabUpdates.filter((update) => update.url === url).length;
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

function state(allowed: string[]): SessionState {
  return { allowed: new Set(allowed), refused: new Set(), closed: 0 };
}
