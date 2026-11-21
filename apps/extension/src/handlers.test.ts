import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_NETWORK_LIMIT,
  MAX_NETWORK_HEADER,
  MAX_NETWORK_PATTERN,
  MAX_NETWORK_TYPES,
  type MethodName,
  PROTOCOL_VERSION,
  type ProbeResult,
  type Result,
  type TabInfo,
} from "@foxleash/protocol";
import { createActSettle, MIN_SETTLE_MS } from "./act-settle.ts";
import type {
  BrowserApi,
  BrowserWindow,
  FrameDetails,
  RequestDetails,
  Tab,
  TabChangeInfo,
} from "./browser-api.ts";
import type { LiveRecording } from "./console-recording.ts";
import {
  type CssCall,
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakeBrowser,
  type FakePort,
  type FakeTab,
  type FakeTimers,
  flush,
  ONE_PIXEL_PNG,
  type WindowUpdate,
} from "./fake-browser.ts";
import { createFileGuard } from "./file-guard.ts";
import {
  BLANK_RELOAD_TIMEOUT_MS,
  CAPTURE_TIMEOUT_MS,
  CLOSE_CONFIRM_TIMEOUT_MS,
  createHandlers,
  type HandlerDeps,
  HISTORY_RELOAD_TIMEOUT_MS,
  HISTORY_REQUEST_TIMEOUT_MS,
  KEPT_GRACE_MS,
  KNOWN_DOCUMENTS_PER_TAB,
  NAVIGATION_WAIT_MS,
  PROBE_CUTOFF_MS,
  PROBE_TIMEOUT_MS,
  READ_CONSOLE_TIMEOUT_MS,
  RESIZE_POLL_MS,
  RESIZE_WAIT_MS,
  refuseIfEnded,
  SCREENSHOT_TIMEOUT_MS,
  ToolError,
  VIEW_READ_MS,
  VIEW_START_LIMIT_MS,
} from "./handlers.ts";
import { createLoadHops } from "./load-hops.ts";
import { createNetworkLog, type NetworkReadOptions } from "./network-log.ts";
import { PAGE_INJECTION_MS, PAGE_REPLY_MS } from "./page-scripts.ts";
import { READ_PAGE_MAX_CHARS } from "./page-tree.ts";
import { createPageViews } from "./page-view.ts";
import { createRecipePrompts, type RecipePrompts } from "./recipe-prompts.ts";
import { FIELD_MASK_CSS, FRAME_HIDE_CSS, INPUT_MASK_CSS } from "./screenshot.ts";
import { answerAs } from "./served-protocols.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite } from "./settings.ts";
import {
  APPROVAL_WAIT_MS,
  createSiteAccess,
  type OpenPrompt,
  type SessionMemory,
  type SessionState,
} from "./site-access.ts";
import { createTabNavigations } from "./tab-navigations.ts";
import { createUploads } from "./uploads.ts";
import { WAIT_POLL_MS } from "./wait-for.ts";
import {
  LOAD_AFTER_READY_MS,
  LOAD_GRACE_MS,
  LOAD_TIMEOUT_MS,
  SIGN_IN_GRACE_MS,
} from "./wait-for-load.ts";

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

const PROMPT_URL = /^moz-extension:\/\/[0-9a-f-]+\/approve\.html\?id=[0-9a-f-]{36}$/;

describe("tab_open", { timeout: 10000 }, () => {
  it("opens the url in a new active tab in an orange group titled Foxleash", async () => {
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
      title: "Foxleash",
      color: "orange",
    });
    assert.equal(fake.tabs.get(1)?.active, false);
  });

  it("creates the tab unloaded on an approved page, loads it in the group, then selects it", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://example.com");
    fake.commitOnCreate = false;
    const creates = recordCreates(fake);
    const atUpdate: unknown[] = [];
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      const tab = fake.tabs.get(tabId);
      atUpdate.push({ groupId: tab?.groupId, discarded: tab?.discarded, status: tab?.status });
      return update(tabId, properties);
    };
    let opened: TabInfo | undefined;
    open("s1", "https://example.com/a").then((tab) => {
      opened = tab;
    });
    await flush();
    assert.ok(opened, "waited for something besides the page's load");
    assert.equal(timers.pending(), 0);
    assert.deepEqual(creates, [{ url: "https://example.com/a", active: false, discarded: true }]);
    const groupId = groupIdOf(fake, opened.id);
    assert.deepEqual(atUpdate, [
      { groupId, discarded: true, status: "complete" },
      { groupId, discarded: false, status: "complete" },
    ]);
    assert.deepEqual(opened, {
      id: opened.id,
      url: "https://example.com/a",
      title: "Title of https://example.com/a",
      active: true,
    });
    const tab = fake.tabs.get(opened.id);
    assert.deepEqual(
      { history: tab?.history, index: tab?.index, discarded: tab?.discarded, status: tab?.status },
      { history: ["https://example.com/a"], index: 0, discarded: false, status: "complete" },
    );
    assert.deepEqual(fake.tabUpdates, [
      { tabId: opened.id, url: "https://example.com/a", loadReplace: true },
      { tabId: opened.id, active: true },
    ]);
  });

  it("creates the unloaded tab in the window of the session's group", async () => {
    const { fake, open, grant } = setup();
    await grant("https://example.com");
    await open("s1");
    fake.currentWindowId = 2;
    const creates = recordCreates(fake);
    await open("s1", "https://example.com/a");
    assert.deepEqual(creates, [
      { url: "https://example.com/a", active: false, discarded: true, windowId: 1 },
    ]);
  });

  it("watches commits for an approved page only during its load and closes the tab it could not group", async () => {
    const { fake, access, open, grant } = setup();
    await grant("https://example.com");
    // The file guard listens from the first running session on.
    access.admit("s1");
    const before = fake.committedListenerCount();
    const during: number[] = [];
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      during.push(fake.committedListenerCount());
      return create(properties);
    };
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      during.push(fake.committedListenerCount());
      return update(tabId, properties);
    };
    const first = await open("s1", "https://example.com/");
    assert.deepEqual(during, [before, before + 1, before]);
    assert.equal(fake.committedListenerCount(), before);
    fake.browser.tabGroups.update = async () => {
      throw new Error("No group with id: 2");
    };
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    await assert.rejects(open("s2", "https://example.com/"), /No group with id/);
    assert.deepEqual([...fake.tabs.keys()], [first.id]);
    assert.deepEqual(fake.tabUpdates, [
      { tabId: first.id, url: "https://example.com/", loadReplace: true },
      { tabId: first.id, active: true },
    ]);
  });

  it("closes the tab when its page does not load", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://example.com");
    const first = await open("s1", "https://example.com/");
    const get = fake.browser.tabs.get;
    // A response that loads no page, as a 204 or a URL Firefox downloads.
    fake.browser.tabs.update = async (tabId) => {
      fake.emitStatus(tabId, "loading");
      fake.emitStatus(tabId, "complete");
      return get(tabId);
    };
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    const opening = open("s1", "https://example.com/file");
    opening.catch(() => {});
    for (let turn = 0; turn < 50 && timers.pending() === 0; turn += 1) await flush();
    timers.advance(LOAD_TIMEOUT_MS);
    await assert.rejects(opening, { code: "navigation_timeout" });
    assert.deepEqual([...fake.tabs.keys()], [first.id]);
  });

  it("closes the tab when its page with a fragment does not load", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://example.com");
    const first = await open("s1", "https://example.com/");
    restoreThenLoadNothing(fake);
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    const opening = open("s1", "https://example.com/file#x");
    opening.catch(() => {});
    for (let turn = 0; turn < 50 && timers.pending() === 0; turn += 1) await flush();
    timers.advance(LOAD_TIMEOUT_MS);
    await assert.rejects(opening, { code: "navigation_timeout" });
    assert.deepEqual([...fake.tabs.keys()], [first.id]);
  });

  it("keeps a tab in the window when tab_close runs while tab_open removes the tab it could not group", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://example.com");
    const first = await open("s1");
    const refusal = new Error("No group with id: 2");
    const grouping = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    fake.browser.tabs.group = async () => {
      grouping.resolve();
      await held.promise;
      throw refusal;
    };
    const opening = call("s1", "tab_open", { url: "https://example.com/" });
    await grouping.promise;
    assert.deepEqual(await call("s1", "tab_close", { tabId: first.id }), { tabs: [] });
    held.resolve();
    await assert.rejects(opening, (error: unknown) => error === refusal);
    const kept = [...fake.tabs.values()];
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0]?.id, first.id);
    assert.equal(kept[0]?.groupId, -1);
    assert.equal(kept[0]?.discarded, true);
    assert.equal(kept[0]?.active, false);
  });

  it("has the fake create a discarded tab unloaded and load it only once selected", async () => {
    const { fake } = setup();
    const commits: string[] = [];
    fake.browser.webNavigation.onCommitted.addListener((details) => {
      commits.push(details.url);
    });
    const shown = fake.openTab({ active: true });
    const created = await fake.browser.tabs.create({
      url: "https://example.com/",
      active: false,
      discarded: true,
    });
    await flush();
    assert.deepEqual(created, {
      id: created.id,
      windowId: 1,
      active: false,
      url: "https://example.com/",
      title: "https://example.com/",
      status: "complete",
      discarded: true,
      groupId: -1,
    });
    await fake.browser.tabs.update(shown.id, { active: true });
    await flush();
    assert.deepEqual(commits, []);
    await fake.browser.tabs.update(created.id, { active: true });
    await flush();
    assert.deepEqual(commits, ["https://example.com/"]);
    assert.equal(fake.tabs.get(created.id)?.discarded, false);
  });

  it("has the fake refuse a discarded tab that is active or on an about: URL", async () => {
    const { fake } = setup();
    await assert.rejects(
      fake.browser.tabs.create({ url: "https://example.com/", active: true, discarded: true }),
      { message: "Active tabs cannot be created and discarded." },
    );
    await assert.rejects(
      fake.browser.tabs.create({ url: "about:blank", active: false, discarded: true }),
      { message: 'Cannot create a discarded new tab or "about" urls.' },
    );
    assert.equal(fake.tabs.size, 0);
  });

  it("returns the opened page when a blank load completes before it", async () => {
    const { fake, open, grant } = setup();
    await grant("https://example.com");
    reportBlankLoadInUnloaded(fake);
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
    assert.equal(fake.groups.get(group)?.title, "Foxleash");
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
      message: "Foxleash opens only http and https URLs, or about:blank.",
    });
  });

  it("refuses an address starting with / and says what to do instead", async () => {
    const { fake, call } = setup();
    for (const url of ["/x", "/", "/\\evil.example"]) {
      await assert.rejects(call("s1", "tab_open", { url }), {
        code: "invalid_url",
        message:
          "tab_open needs a whole http or https URL. An address starting with / from read_page is on the site of the page it was read from: put that site in front of it, or use navigate in that page's tab.",
      });
    }
    await assert.rejects(call("s1", "tab_open", { url: "//a.example/x" }), {
      code: "invalid_url",
      message: "Foxleash opens only http and https URLs, or about:blank.",
    });
    assert.equal(fake.tabs.size, 0);
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

  it("opens a tab without a url without waiting for a commit", async () => {
    const { fake, timers, open } = setup();
    fake.commitOnCreate = false;
    let opened: TabInfo | undefined;
    open("s1").then((tab) => {
      opened = tab;
    });
    await flush();
    assert.equal(opened?.url, "about:blank");
    assert.equal(timers.pending(), 0);
  });

  it("creates the prompt's unloaded tab in the window of the session's group", async () => {
    const { fake, call, open, page, promptOf } = setup();
    await open("s1");
    fake.currentWindowId = 2;
    const creates = recordCreates(fake);
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    const promptUrl = fake.tabs.get((await promptOf("s1")).tabId)?.url ?? "";
    assert.match(promptUrl, PROMPT_URL);
    assert.deepEqual(creates, [{ url: promptUrl, active: false, discarded: true, windowId: 1 }]);
    shown.deliver({ type: "answer", answer: "once" });
    await opened;
  });

  it("removes the prompt's tab it could not group and shows nothing in it", async () => {
    const { fake, call, access } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    fake.browser.tabGroups.update = async () => {
      throw new Error("No group with id: 1");
    };
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    await assert.rejects(
      call("s1", "tab_open", { url: "https://a.example/x" }),
      /No group with id/,
    );
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(fake.tabUpdates, []);
  });
});

describe("tab_open with each session in its own window", { timeout: 10000 }, () => {
  it("opens an approved page unloaded in a new window, groups and loads it, then selects it", async () => {
    const { fake, open, grant } = setup();
    await grant("https://example.com");
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ active: true });
    fake.commitOnCreate = false;
    const creates = recordCreates(fake);
    const atUpdate: unknown[] = [];
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      const tab = fake.tabs.get(tabId);
      atUpdate.push({ groupId: tab?.groupId, discarded: tab?.discarded });
      return update(tabId, properties);
    };
    const tab = await open("s1", "https://example.com/a");
    await flush();
    assert.deepEqual(fake.windowCreations, [{ url: "about:blank", focused: false }]);
    const windowId = fake.tabs.get(tab.id)?.windowId;
    assert.notEqual(windowId, user.windowId);
    assert.deepEqual(creates, [
      { url: "https://example.com/a", active: false, discarded: true, windowId },
    ]);
    const groupId = groupIdOf(fake, tab.id);
    assert.equal(fake.groups.get(groupId)?.windowId, windowId);
    assert.deepEqual(atUpdate, [
      { groupId, discarded: true },
      { groupId, discarded: false },
    ]);
    assert.deepEqual(fake.tabUpdates, [
      { tabId: tab.id, url: "https://example.com/a", loadReplace: true },
      { tabId: tab.id, active: true },
    ]);
    assert.deepEqual(tabsIn(fake, windowId), [tab.id]);
    assert.equal(fake.tabs.get(user.id)?.active, true);
    const second = await open("s1", "https://example.com/b");
    assert.equal(fake.tabs.get(second.id)?.windowId, windowId);
    assert.equal(fake.windowCreations.length, 1);
  });

  it("opens a blank tab as the new window's own tab, in the group", async () => {
    const { fake, open } = setup();
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ active: true });
    const creates = recordCreates(fake);
    const tab = await open("s1");
    await flush();
    const windowId = fake.tabs.get(tab.id)?.windowId;
    assert.notEqual(windowId, user.windowId);
    assert.deepEqual(creates, []);
    assert.deepEqual(tabsIn(fake, windowId), [tab.id]);
    assert.equal(fake.groups.get(groupIdOf(fake, tab.id))?.windowId, windowId);
    assert.equal(fake.tabs.get(user.id)?.active, true);
  });

  it("opens the approval prompt in a new window and loads the page there once answered", async () => {
    const { fake, call, page, promptOf } = setup();
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ active: true });
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    await flush();
    const { tabId } = await promptOf("s1");
    const windowId = fake.tabs.get(tabId)?.windowId;
    assert.notEqual(windowId, user.windowId);
    assert.equal(fake.groups.get(groupIdOf(fake, tabId))?.windowId, windowId);
    assert.deepEqual(tabsIn(fake, windowId), [tabId]);
    shown.deliver({ type: "answer", answer: "once" });
    const result = await opened;
    assert.ok("tab" in result);
    assert.equal(result.tab.id, tabId);
    assert.equal(result.tab.url, "https://a.example/x");
    assert.equal(fake.tabs.get(user.id)?.active, true);
  });

  it("closes the new window when the session's first page does not load", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://example.com");
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ active: true });
    const get = fake.browser.tabs.get;
    fake.browser.tabs.update = async (tabId) => {
      fake.emitStatus(tabId, "loading");
      fake.emitStatus(tabId, "complete");
      return get(tabId);
    };
    const opening = open("s1", "https://example.com/file");
    opening.catch(() => {});
    for (let turn = 0; turn < 50 && timers.pending() === 0; turn += 1) await flush();
    timers.advance(LOAD_TIMEOUT_MS);
    await assert.rejects(opening, { code: "navigation_timeout" });
    await flush();
    assert.equal(fake.windowRemovals.length, 1);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
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

  it("returns the new page when a background tab starts loading it after the grace", async () => {
    const { fake, timers, navigate, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    const background = fake.openTab({ url: "https://a.example/issue" });
    background.groupId = groupIdOf(fake, tab.id);
    const update = fake.browser.tabs.update;
    const get = fake.browser.tabs.get;
    fake.browser.tabs.update = async (tabId, properties) => {
      timers.setTimeout(() => {
        void update(tabId, properties);
      }, LOAD_GRACE_MS + 500);
      return get(tabId);
    };
    let done = false;
    const navigated = navigate("s1", {
      tabId: background.id,
      url: "https://b.example/search?q=x",
    }).finally(() => {
      done = true;
    });
    for (let turn = 0; turn < 50 && timers.pending() < 2; turn += 1) await flush();
    timers.advance(LOAD_GRACE_MS);
    await flush();
    assert.equal(done, false);
    timers.advance(500);
    assert.deepEqual(await navigated, {
      id: background.id,
      url: "https://b.example/search?q=x",
      title: "Title of https://b.example/search?q=x",
      active: false,
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

  it("goes back, forward and reloads", async (t) => {
    const context = setup();
    const { fake, navigate, open, grant } = context;
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    await navigate("s1", { tabId: tab.id, url: "https://b.example/" });
    assert.equal(
      (await pastRequestWait(context, { tabId: tab.id, action: "back" })).url,
      "https://a.example/",
    );
    assert.equal(
      (await pastRequestWait(context, { tabId: tab.id, action: "forward" })).url,
      "https://b.example/",
    );
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    fakeTab.title = "Before reload";
    const reload = t.mock.method(fake.browser.tabs, "reload");
    const updates = fake.tabUpdates.length;
    const reloaded = await navigate("s1", { tabId: tab.id, action: "reload" });
    assert.deepEqual(reloaded, {
      ...tab,
      url: "https://b.example/",
      title: "Title of https://b.example/",
    });
    assert.deepEqual(reload.mock.calls[0]?.arguments, [tab.id, { bypassCache: true }]);
    assert.equal(fake.tabUpdates.length, updates);
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
      [{ tabId: 1, url: "file:///x" }, "Foxleash navigates only to http and https URLs."],
    ];
    for (const [params, message] of messages) {
      await assert.rejects(call("s1", "navigate", params), { message });
    }
  });

  it("accepts tab id 0", async () => {
    const { call } = setup();
    await rejectsWith(call("s1", "navigate", { tabId: 0, action: "reload" }), "tab_not_found");
  });

  describe("an address starting with /", () => {
    const LEAVES =
      "An address starting with / must stay on the site the tab shows; give the whole URL.";
    const NOT_WEB =
      "navigate takes an address starting with / only in a tab that shows an http or https page; give the whole URL.";

    it("loads it on the site the tab shows", async () => {
      const { fake, navigate, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/start?x=1#top");
      for (const [path, url] of [
        ["/path?q#f", "https://a.example/path?q#f"],
        ["/", "https://a.example/"],
        ["/wiki/Foo?x=1#y", "https://a.example/wiki/Foo?x=1#y"],
        ["/a b", "https://a.example/a%20b"],
        ["/..//evil.example/x", "https://a.example//evil.example/x"],
      ] as const) {
        assert.equal((await navigate("s1", { tabId: tab.id, url: path })).url, url, path);
        assert.deepEqual(fake.tabUpdates.at(-1), { tabId: tab.id, url }, path);
      }
    });

    it("keeps the port and leaves out a user name in the tab's address", async () => {
      const { fake, navigate, open, grant } = setup();
      await grant("http://a.example:8080");
      const tab = await open("s1", "http://a.example:8080/");
      fake.navigateByUser(tab.id, "http://user:secret@a.example:8080/start");
      await flush();
      assert.equal(
        (await navigate("s1", { tabId: tab.id, url: "/next" })).url,
        "http://a.example:8080/next",
      );
      assert.deepEqual(fake.tabUpdates.at(-1), {
        tabId: tab.id,
        url: "http://a.example:8080/next",
      });
    });

    it("asks about the resolved address on a site the session may not act on yet", async () => {
      const { fake, call, open, page, promptOf } = setup();
      const tab = await open("s1");
      fake.navigateByUser(tab.id, "https://c.example/start");
      await flush();
      const navigated = call("s1", "navigate", { tabId: tab.id, url: "/next?q=1" });
      const shown = await page("s1");
      const prompt = await promptOf("s1");
      assert.equal(prompt.url, "https://c.example/next?q=1");
      assert.equal(prompt.site, "https://c.example");
      shown.deliver({ type: "answer", answer: "once" });
      const result = await navigated;
      assert.ok("tab" in result);
      assert.equal(result.tab.url, "https://c.example/next?q=1");
    });

    it("refuses one that the URL parser takes to another site", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const updates = fake.tabUpdates.length;
      for (const url of [
        "/\\evil.example/x",
        "/\\\\evil.example",
        "/\t/evil.example/x",
        "/\n/evil.example/x",
        "/\t\\evil.example",
        "/\r/evil.example",
      ]) {
        await assert.rejects(
          call("s1", "navigate", { tabId: tab.id, url }),
          { code: "invalid_url", message: LEAVES },
          JSON.stringify(url),
        );
      }
      assert.equal(fake.tabUpdates.length, updates);
      assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/");
    });

    it("refuses one in a tab that does not show an http or https page", async (t) => {
      const { fake, call, open } = setup();
      const tab = await open("s1");
      for (const url of ["about:blank", "file:///home/x.html"]) {
        fake.navigateByUser(tab.id, url);
        await flush();
        await assert.rejects(call("s1", "navigate", { tabId: tab.id, url: "/x" }), {
          code: "invalid_url",
          message: NOT_WEB,
        });
      }
      const get = fake.browser.tabs.get;
      t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
        const { url: _url, ...rest } = await get(tabId);
        return rest;
      });
      await assert.rejects(call("s1", "navigate", { tabId: tab.id, url: "/x" }), {
        code: "invalid_url",
        message: NOT_WEB,
      });
    });

    it("takes a tab whose host ends in a dot on that same host", async () => {
      const { fake, navigate, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.navigateByUser(tab.id, "https://a.example./start");
      await flush();
      assert.equal(
        (await navigate("s1", { tabId: tab.id, url: "/next" })).url,
        "https://a.example./next",
      );
    });

    it("refuses one for a tab outside the group, or no tab, before looking at the address", async () => {
      const { fake, call } = setup();
      const outside = fake.openTab({ url: "https://a.example/" });
      await rejectsWith(
        call("s1", "navigate", { tabId: outside.id, url: "/x" }),
        "tab_not_in_group",
      );
      const blank = fake.openTab({ url: "about:blank" });
      await rejectsWith(call("s1", "navigate", { tabId: blank.id, url: "/x" }), "tab_not_in_group");
      await rejectsWith(
        call("s1", "navigate", { tabId: 99, url: "/\\evil.example" }),
        "tab_not_found",
      );
    });

    it("refuses every other relative address as before", async () => {
      const { call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      for (const url of ["//b.example/x", "path", "example.com", "?q", "#f", " /x", "\\x", ""]) {
        await assert.rejects(
          call("s1", "navigate", { tabId: tab.id, url }),
          { code: "invalid_url", message: "Foxleash navigates only to http and https URLs." },
          url,
        );
      }
    });
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
    const context = setup();
    const { navigate, open, sessions } = context;
    sessions.set("s1", state(["https://a.example", "https://b.example"]));
    const tab = await open("s1", "https://a.example/secret");
    await navigate("s1", { tabId: tab.id, url: "https://b.example/" });
    sessions.get("s1")?.allowed.delete("https://a.example");
    assert.deepEqual(await pastRequestWait(context, { tabId: tab.id, action: "back" }), {
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
    "Foxleash does not act on https://www.paypal.com: it is on Foxleash's blocklist, which by default lists common financial and health sites.";

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
        "Foxleash does not act on https://a.example: it is on Foxleash's blocklist, which by default lists common financial and health sites.",
    });
    assert.equal(reload.mock.callCount(), 0);
  });

  it("reloads about:blank with no check, reading the settings only for the result", async (t) => {
    const { fake, navigate, open } = setup();
    const tab = await open("s1");
    const reload = t.mock.method(fake.browser.tabs, "reload");
    const get = t.mock.method(fake.browser.storage.local, "get");
    const updates = fake.tabUpdates.length;
    assert.equal((await navigate("s1", { tabId: tab.id, action: "reload" })).url, "about:blank");
    assert.equal(reload.mock.callCount(), 1);
    assert.equal(fake.tabUpdates.length, updates);
    assert.deepEqual(reload.mock.calls[0]?.arguments, [tab.id, { bypassCache: true }]);
    assert.equal(get.mock.callCount(), 1);
  });

  it("refuses to reload a tab that shows a page that is not a website, naming only the tab", async (t) => {
    const { fake, call, open } = setup();
    const tab = await open("s1");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    const reload = t.mock.method(fake.browser.tabs, "reload");
    const message = `Foxleash acts only on http and https pages, and tab ${tab.id} shows another kind of page.`;
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
      message: "Foxleash opens only http and https URLs, or about:blank.",
    });
    assert.equal(fake.tabs.size, 0);
    const tab = await open("s1");
    await assert.rejects(call("s1", "navigate", { tabId: tab.id, url: "http://./" }), {
      code: "invalid_url",
      message: "Foxleash navigates only to http and https URLs.",
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
    const context = setup();
    const { fake, navigate, open, grant } = context;
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/x");
    await navigate("s1", { tabId: tab.id, url: "https://b.example/y" });
    await fake.browser.storage.local.set({ blocklist: ["a.example", "b.example"] });
    assert.deepEqual(await pastRequestWait(context, { tabId: tab.id, action: "back" }), {
      ...tab,
      url: "https://a.example",
      title: "",
    });
    assert.deepEqual(await pastRequestWait(context, { tabId: tab.id, action: "forward" }), {
      ...tab,
      url: "https://b.example",
      title: "",
    });
  });
});

describe("navigate back and forward to a page Firefox loads again", { timeout: 10000 }, () => {
  it("loads its address again after going back, and returns the loaded tab", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const fakeTab = context.fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    const update = context.fake.browser.tabs.update;
    context.fake.browser.tabs.update = async (tabId, properties) => {
      // The user selects another tab while the load runs.
      fakeTab.active = false;
      return update(tabId, properties);
    };
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    assert.deepEqual(await context.navigate("s1", { tabId: tab.id, action: "back" }), {
      ...tab,
      active: false,
    });
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("loads its address again after going forward", async () => {
    const context = setup();
    const tab = await historyTab(context);
    await pastRequestWait(context, { tabId: tab.id, action: "back" });
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://b.example/b")]);
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "forward" })).url,
      "https://b.example/b",
    );
    assert.deepEqual(steps, [
      ["forward", tab.id],
      ["load", tab.id, { url: "https://b.example/b", loadReplace: true }],
    ]);
  });

  it("goes forward again after the load that followed going back", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, (tabId) => [
      pageRequest(
        tabId,
        context.fake.tabs.get(tabId)?.url === "https://b.example/b"
          ? "https://a.example/a"
          : "https://b.example/b",
      ),
    ]);
    await context.navigate("s1", { tabId: tab.id, action: "back" });
    // Otherwise going forward would wait for a load that never comes.
    assert.ok(context.fake.tabs.get(tab.id)?.history.includes("https://b.example/b"));
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "forward" })).url,
      "https://b.example/b",
    );
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
      ["forward", tab.id],
      ["load", tab.id, { url: "https://b.example/b", loadReplace: true }],
    ]);
  });

  it("reloads when Firefox reports the page's request after its commit", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(
      context.fake,
      () => [],
      (tabId) => [pageRequest(tabId, "https://a.example/a")],
    );
    assert.equal(
      (await pastRequestWait(context, { tabId: tab.id, action: "back" })).url,
      "https://a.example/a",
    );
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("waits for the page's request reported after its load completed, and reloads as it comes", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    const timers = context.timers.pending();
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    context.timers.advance(HISTORY_REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(done, false);
    // A request that started after the commit is not the page's own and decides nothing.
    send(context.fake, [pageRequest(tab.id, "https://a.example/next", "GET", 1000)]);
    await flush();
    assert.equal(done, false);
    send(context.fake, [pageRequest(tab.id, "https://a.example/a")]);
    await flush();
    assert.equal(done, true);
    assert.equal((await result).url, "https://a.example/a");
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
    assert.equal(context.timers.pending(), timers);
  });

  it("reloads nothing when the page's request does not come within the wait", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    context.timers.advance(HISTORY_REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(done, false);
    context.timers.advance(1);
    assert.deepEqual(await result, tab);
    send(context.fake, [pageRequest(tab.id, "https://a.example/a")]);
    await flush();
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("matches the page's request to its commit by start time, not by the order reported", async () => {
    const cases: [
      string,
      (tabId: number) => RequestDetails[],
      (tabId: number) => RequestDetails[],
    ][] = [
      [
        "an earlier request reported after the page's own",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 40),
          pageRequest(tabId, "https://a.example/other", "GET", 30),
        ],
        () => [],
      ],
      [
        "the page's request started as it committed, reported before the commit",
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 50)],
        () => [],
      ],
      [
        "the page's request started as it committed, reported after the commit",
        () => [],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 50)],
      ],
    ];
    for (const [label, before, after] of cases) {
      const context = setup();
      const tab = await historyTab(context);
      const steps = recordSteps(context.fake, before, after);
      const emitCommitted = context.fake.emitCommitted;
      context.fake.emitCommitted = (details) => emitCommitted({ ...details, timeStamp: 50 });
      await pastRequestWait(context, { tabId: tab.id, action: "back" });
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
        ],
        label,
      );
    }
  });

  it("does not reload after a top-level non-GET started from the page's request on, or reported after it", async () => {
    const cases: [
      string,
      (tabId: number) => RequestDetails[],
      (tabId: number) => RequestDetails[],
    ][] = [
      [
        "a top-level POST started before it, reported after it and before the commit",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
          pageRequest(tabId, "https://b.example/send", "POST", 1),
        ],
        () => [],
      ],
      [
        "a top-level POST started before it, reported after it and the commit",
        () => [],
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
          pageRequest(tabId, "https://b.example/send", "POST", 1),
        ],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, before, after] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, before, after);
        assert.deepEqual(
          await pastRequestWait(context, { tabId: tab.id, action: "back" }),
          tab,
          `${label}, ${shown}`,
        );
        assert.deepEqual(steps, [["back", tab.id]], `${label}, ${shown}`);
      }
    }
  });

  it("does not reload after a top-level non-GET that started by the commit, whatever was reported around it", async () => {
    const cases: [
      string,
      (tabId: number) => RequestDetails[],
      (tabId: number) => RequestDetails[],
    ][] = [
      [
        "a POST after the commit, then one between the page's request and the commit, both reported before the commit",
        (tabId) => [
          pageRequest(tabId, "https://b.example/send", "POST", 60),
          pageRequest(tabId, "https://b.example/old", "POST", 40),
        ],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 2)],
      ],
      [
        "a POST started before the page's request, then one after the commit, both reported after it",
        () => [],
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
          pageRequest(tabId, "https://b.example/old", "POST", 1),
          pageRequest(tabId, "https://b.example/send", "POST", 60),
        ],
      ],
      [
        "a POST after the commit, then one started before the page's request, both reported after it",
        () => [],
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
          pageRequest(tabId, "https://b.example/send", "POST", 60),
          pageRequest(tabId, "https://b.example/old", "POST", 1),
        ],
      ],
      [
        "the page's own request a POST started in the commit's millisecond",
        () => [],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "POST", 50)],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, before, after] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, before, after);
        const emitCommitted = context.fake.emitCommitted;
        context.fake.emitCommitted = (details) => emitCommitted({ ...details, timeStamp: 50 });
        assert.deepEqual(
          await pastRequestWait(context, { tabId: tab.id, action: "back" }),
          tab,
          `${label}, ${shown}`,
        );
        assert.deepEqual(steps, [["back", tab.id]], `${label}, ${shown}`);
      }
    }
  });

  it("loads with GET after a top-level non-GET that started after the commit and one before the page's request, and reloads no address with a fragment after them", async () => {
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      const context = setup();
      const tab = await historyTab(context, shown);
      const steps = recordSteps(
        context.fake,
        (tabId) => [
          pageRequest(tabId, "https://b.example/send", "POST", 60),
          pageRequest(tabId, "https://b.example/old", "POST", 1),
        ],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 2)],
      );
      const emitCommitted = context.fake.emitCommitted;
      context.fake.emitCommitted = (details) => emitCommitted({ ...details, timeStamp: 50 });
      const loaded = await pastRequestWait(context, { tabId: tab.id, action: "back" });
      assertGetLoadOnlyWithoutFragment(steps, loaded, tab, shown);
    }
  });

  it("loads with GET after a top-level POST the page sends once it committed, and reloads no address with a fragment after one", async () => {
    const cases: [
      string,
      (tabId: number) => RequestDetails[],
      (tabId: number) => RequestDetails[],
    ][] = [
      [
        "the page's request reported before the commit, the POST after it",
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 2)],
        (tabId) => [pageRequest(tabId, "https://a.example/send", "POST", 60)],
      ],
      [
        "both reported after the commit, the POST first",
        () => [],
        (tabId) => [
          pageRequest(tabId, "https://a.example/send", "POST", 60),
          pageRequest(tabId, "https://a.example/a", "GET", 2),
        ],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, before, after] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, before, after);
        const emitCommitted = context.fake.emitCommitted;
        context.fake.emitCommitted = (details) => emitCommitted({ ...details, timeStamp: 50 });
        const loaded = await pastRequestWait(context, { tabId: tab.id, action: "back" });
        assertGetLoadOnlyWithoutFragment(steps, loaded, tab, `${label}, ${shown}`);
      }
    }
  });

  it("does not reload when the page's own POST commits during the step", async () => {
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const reportedFirst of [true, false]) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const fakeTab = context.fake.tabs.get(tab.id);
        assert.ok(fakeTab);
        const commitTime = lastCommitTime(context.fake);
        const steps = recordSteps(context.fake, (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
        ]);
        const result = shown.includes("#")
          ? "https://a.example/result#top"
          : "https://a.example/result";
        const goBack = context.fake.browser.tabs.goBack;
        context.fake.browser.tabs.goBack = (tabId) => {
          const stepped = goBack(tabId);
          // The page sends its form with POST after it committed, and the result commits.
          const posted = pageRequest(tabId, "https://a.example/result", "POST", commitTime() + 1);
          if (reportedFirst) send(context.fake, [posted]);
          fakeTab.url = result;
          context.fake.emitCommitted({
            tabId,
            frameId: 0,
            url: result,
            timeStamp: commitTime() + 2,
          });
          if (!reportedFirst) send(context.fake, [posted]);
          return stepped;
        };
        const label = `${shown}, POST reported ${reportedFirst ? "before" : "after"} its commit`;
        const loaded = await pastRequestWait(context, { tabId: tab.id, action: "back" });
        assert.equal(loaded.url, result, label);
        assert.deepEqual(steps, [["back", tab.id]], label);
      }
    }
  });

  it("loads with GET after a frame non-GET started from the page's request on, or reported after it, and reloads no address with a fragment after one", async () => {
    const cases: [
      string,
      (tabId: number) => RequestDetails[],
      (tabId: number) => RequestDetails[],
    ][] = [
      [
        "a frame POST started as the page's request did, reported before it",
        (tabId) => [frameRequest(tabId, "https://f.example/form", "POST", 2)],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 2)],
      ],
      [
        "a frame POST started after the page's request, reported before it",
        (tabId) => [frameRequest(tabId, "https://f.example/form", "POST", 3)],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 2)],
      ],
      [
        "a frame POST started before it, then one started after it, both reported before it",
        (tabId) => [
          frameRequest(tabId, "https://f.example/form", "POST", 3),
          frameRequest(tabId, "https://f.example/old", "POST", 1),
        ],
        (tabId) => [pageRequest(tabId, "https://a.example/a", "GET", 2)],
      ],
      [
        "a frame POST started before it, reported after it and before the commit",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
          frameRequest(tabId, "https://f.example/form", "POST", 1),
        ],
        () => [],
      ],
      [
        "a frame POST started before it, reported after it and the commit",
        () => [],
        (tabId) => [
          pageRequest(tabId, "https://a.example/a", "GET", 2),
          frameRequest(tabId, "https://f.example/form", "POST", 1),
        ],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, before, after] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, before, after);
        const loaded = await pastRequestWait(context, { tabId: tab.id, action: "back" });
        if (shown.includes("#")) {
          assert.deepEqual(loaded, tab, `${label}, ${shown}`);
          assert.deepEqual(steps, [["back", tab.id]], `${label}, ${shown}`);
        } else {
          assert.deepEqual(
            steps,
            [
              ["back", tab.id],
              ["load", tab.id, { url: shown, loadReplace: true }],
            ],
            `${label}, ${shown}`,
          );
        }
      }
    }
  });

  it("does not reload a page kept in memory, and reads nothing more for it", async (t) => {
    const cases: [string, (tabId: number) => RequestDetails[]][] = [
      ["no request", () => []],
      // A parallel navigate's request for another page, which the step superseded. One for the
      // page's own address looks like the page loaded again, and reloads it (ADR 0025).
      ["a superseded request", (tabId) => [pageRequest(tabId, "https://a.example/other")]],
    ];
    for (const [label, requests] of cases) {
      const context = setup();
      const tab = await historyTab(context);
      // Firefox reports the commit of a page it takes from the back-forward cache, and no request.
      const steps = recordSteps(context.fake, requests);
      const get = t.mock.method(context.fake.browser.storage.local, "get");
      assert.deepEqual(
        await pastRequestWait(context, { tabId: tab.id, action: "back" }),
        tab,
        label,
      );
      assert.deepEqual(steps, [["back", tab.id]], label);
      assert.equal(get.mock.callCount(), 1, label);
      get.mock.restore();
    }
  });

  it("answers after a short grace for a page kept in memory, and reloads nothing", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    const timers = context.timers.pending();
    const moves: [string, string][] = [
      ["back", "https://a.example/a"],
      ["forward", "https://b.example/b"],
    ];
    for (const [action, url] of moves) {
      let done = false;
      const result = context.navigate("s1", { tabId: tab.id, action }).finally(() => {
        done = true;
      });
      await flush();
      context.timers.advance(KEPT_GRACE_MS - 1);
      await flush();
      assert.equal(done, false, action);
      context.timers.advance(1);
      await flush();
      assert.equal(done, true, action);
      assert.equal((await result).url, url, action);
      assert.equal(context.timers.pending(), timers, action);
    }
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["forward", tab.id],
    ]);
  });

  it("does not reload a page kept in memory on a request for its own address", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    // A navigate to the page's own address, which the step replaced.
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    context.timers.advance(KEPT_GRACE_MS);
    await flush();
    assert.equal(done, true);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("still waits for and reloads a page that committed a new document", async () => {
    const context = setup();
    context.fake.modelDocuments(() => false);
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
      "https://a.example/a",
    );
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);

    const late = setup();
    late.fake.modelDocuments(() => false);
    const lateTab = await historyTab(late);
    const lateSteps = recordSteps(late.fake, () => []);
    const timers = late.timers.pending();
    let done = false;
    const result = late.navigate("s1", { tabId: lateTab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    late.timers.advance(HISTORY_REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(done, false);
    send(late.fake, [pageRequest(lateTab.id, "https://a.example/a")]);
    await flush();
    assert.equal(done, true);
    assert.equal((await result).url, "https://a.example/a");
    assert.deepEqual(lateSteps, [
      ["back", lateTab.id],
      ["load", lateTab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
    assert.equal(late.timers.pending(), timers);
  });

  it("starts the grace of a page kept in memory once the step's load completes, not at its commit", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    const stepBack = context.fake.browser.tabs.goBack;
    context.fake.browser.tabs.goBack = (tabId) => {
      const stepped = stepBack(tabId);
      // Firefox reports the load complete a grace after the commit.
      context.timers.advance(KEPT_GRACE_MS);
      return stepped;
    };
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    assert.equal(done, false);
    context.timers.advance(KEPT_GRACE_MS);
    await flush();
    assert.equal(done, true);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("loads again a page kept in memory that reloads itself within the grace", async () => {
    const orders: [
      string,
      number,
      (fake: FakeBrowser, tabId: number, reload: Reload, lastCommit: () => number) => void,
    ][] = [
      [
        "its request reported before its commit, decided at the end of the wait",
        HISTORY_REQUEST_TIMEOUT_MS,
        (fake, tabId, reload, lastCommit) => {
          send(fake, [pageRequest(tabId, "https://a.example/a", "GET", lastCommit() + 1)]);
          reload(tabId);
        },
      ],
      [
        "its request reported after its commit",
        0,
        (fake, tabId, reload, lastCommit) => {
          reload(tabId);
          send(fake, [pageRequest(tabId, "https://a.example/a", "GET", lastCommit())]);
        },
      ],
    ];
    for (const [label, wait, reloadItself] of orders) {
      const context = setup();
      context.fake.modelDocuments(() => true);
      const tab = await historyTab(context);
      const { reload } = context.fake.browser.tabs;
      const steps = recordSteps(context.fake, () => []);
      const lastCommit = lastCommitTime(context.fake);
      let done = false;
      const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
        done = true;
      });
      await flush();
      assert.equal(done, false, label);
      // The page's location.reload() on pageshow.
      reloadItself(context.fake, tab.id, reload, lastCommit);
      await flush();
      if (wait > 0) {
        assert.equal(done, false, label);
        context.timers.advance(wait);
        await flush();
      }
      assert.equal(done, true, label);
      assert.equal((await result).url, "https://a.example/a", label);
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
        ],
        label,
      );
    }
  });

  it("waits for a request after a page kept in memory begins a navigation within the grace", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    context.timers.advance(KEPT_GRACE_MS - 1);
    context.fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "https://a.example/a" });
    await flush();
    context.timers.advance(HISTORY_REQUEST_TIMEOUT_MS - KEPT_GRACE_MS);
    await flush();
    assert.equal(done, false);
    context.timers.advance(1);
    await flush();
    assert.equal(done, true);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("does not end the grace of a page kept in memory on a request alone, or on another frame or tab", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    const lastCommit = lastCommitTime(context.fake);
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    send(context.fake, [pageRequest(tab.id, "https://a.example/a", "GET", lastCommit())]);
    context.fake.emitBeforeNavigate({ tabId: tab.id, frameId: 1, url: "https://f.example/" });
    context.fake.emitBeforeNavigate({ tabId: tab.id + 1, frameId: 0, url: "https://c.example/" });
    context.fake.emitCommitted({ tabId: tab.id, frameId: 1, url: "https://f.example/" });
    await flush();
    context.timers.advance(KEPT_GRACE_MS - 1);
    await flush();
    assert.equal(done, false);
    context.timers.advance(1);
    await flush();
    assert.equal(done, true);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("decides on the last of the step's commits, not on an earlier one kept in memory", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    const { reload } = context.fake.browser.tabs;
    const steps = recordSteps(context.fake, () => []);
    const lastCommit = lastCommitTime(context.fake);
    const stepBack = context.fake.browser.tabs.goBack;
    context.fake.browser.tabs.goBack = (tabId) => {
      const stepped = stepBack(tabId);
      // The page restored from memory reloads itself before the step's load completes.
      send(context.fake, [pageRequest(tabId, "https://a.example/a", "GET", lastCommit())]);
      reload(tabId);
      return stepped;
    };
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
      "https://a.example/a",
    );
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("waits for a commit's own request, also after a request for its address", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const tab = await historyTab(context);
    // A navigate to the page's own address, which the step replaced.
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const lastCommit = lastCommitTime(context.fake);
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    // Within the grace the page sends a form to its own address with POST, reported late.
    context.fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "https://a.example/a" });
    context.fake.emitCommitted({
      tabId: tab.id,
      frameId: 0,
      url: "https://a.example/a",
      documentId: "posted",
    });
    context.fake.setFrames(tab.id, [{ frameId: 0, documentId: "posted" }]);
    await flush();
    assert.equal(done, false);
    send(context.fake, [pageRequest(tab.id, "https://a.example/a", "POST", lastCommit())]);
    await flush();
    assert.equal(done, true);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("gives a page kept in memory that the page shown goes back to a grace of its own", async () => {
    const shownFirst: [string, (url: string) => boolean][] = [
      ["kept in memory", () => true],
      ["loaded again, its request not reported", (url) => url === "https://z.example/z"],
    ];
    for (const [shown, keptInMemory] of shownFirst) {
      for (const reloadsItself of [true, false]) {
        const label = `${shown}, z reloads itself: ${reloadsItself}`;
        const context = setup();
        context.fake.modelDocuments(keptInMemory);
        const tab = await threePageTab(context);
        const { goBack, reload } = context.fake.browser.tabs;
        const steps = recordSteps(context.fake, () => []);
        const lastCommit = lastCommitTime(context.fake);
        let done = false;
        const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
          done = true;
        });
        await flush();
        context.timers.advance(KEPT_GRACE_MS - 50);
        // The page shown calls history.back(): z, kept in memory, shows.
        await goBack(tab.id);
        await flush();
        // Past the grace of the page the step showed, not of z.
        context.timers.advance(KEPT_GRACE_MS - 1);
        await flush();
        assert.equal(done, false, label);
        if (reloadsItself) {
          // On pageshow.
          reload(tab.id);
          send(context.fake, [pageRequest(tab.id, "https://z.example/z", "GET", lastCommit())]);
        } else {
          context.timers.advance(1);
        }
        await flush();
        assert.equal(done, true, label);
        if (reloadsItself) assert.equal((await result).url, "https://z.example/z", label);
        assert.deepEqual(
          steps,
          reloadsItself
            ? [
                ["back", tab.id],
                ["load", tab.id, { url: "https://z.example/z", loadReplace: true }],
              ]
            : [["back", tab.id]],
          label,
        );
      }
    }
  });

  it("reloads a page loaded again that commits once more while navigate reads the tab", async () => {
    const context = setup();
    context.fake.modelDocuments(() => false);
    const tab = await historyTab(context);
    const { reload } = context.fake.browser.tabs;
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const lastCommit = lastCommitTime(context.fake);
    const get = context.fake.browser.tabs.get;
    context.fake.browser.tabs.get = async (tabId) => {
      if (context.fake.tabs.get(tabId)?.url === "https://a.example/a" && steps.length === 1) {
        // After the frames were read, the page reloads itself: a new document again.
        send(context.fake, [pageRequest(tabId, "https://a.example/a", "GET", lastCommit() + 1)]);
        reload(tabId);
      }
      return get(tabId);
    };
    await context.navigate("s1", { tabId: tab.id, action: "back" });
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("reloads a page that reloads itself after the tab's frames named the page it went back to", async () => {
    const context = setup();
    context.fake.modelDocuments((url) => url === "https://z.example/z");
    const tab = await threePageTab(context);
    const { goBack, reload } = context.fake.browser.tabs;
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const lastCommit = lastCommitTime(context.fake);
    const getAllFrames = context.fake.browser.webNavigation.getAllFrames;
    context.fake.browser.webNavigation.getAllFrames = async (details) => {
      if (context.fake.tabs.get(details.tabId)?.url !== "https://a.example/a") {
        return getAllFrames(details);
      }
      // The page loaded again goes back: z, kept in memory, shows and commits; the frames name it.
      await goBack(details.tabId);
      const frames = await getAllFrames(details);
      // Then z reloads itself on pageshow before the check.
      send(context.fake, [
        pageRequest(details.tabId, "https://z.example/z", "GET", lastCommit() + 1),
      ]);
      await reload(details.tabId);
      return frames;
    };
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
      "https://z.example/z",
    );
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://z.example/z", loadReplace: true }],
    ]);
  });

  it("gives a page kept in memory that the tab reaches while navigate reads it a grace of its own", async () => {
    for (const reloadsItself of [true, false]) {
      const label = `z reloads itself: ${reloadsItself}`;
      const context = setup();
      context.fake.modelDocuments((url) => url === "https://z.example/z");
      const tab = await threePageTab(context);
      const { goBack, reload } = context.fake.browser.tabs;
      // The step loads a.example/a again with its request: decided at once.
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
      ]);
      const lastCommit = lastCommitTime(context.fake);
      const get = context.fake.browser.tabs.get;
      let wentBack = false;
      context.fake.browser.tabs.get = async (tabId) => {
        if (!wentBack && steps.length === 1) {
          // Before the check, the page loaded again goes back: z shows from memory.
          wentBack = true;
          await goBack(tabId);
        }
        return get(tabId);
      };
      let done = false;
      const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
        done = true;
      });
      await flush();
      assert.equal(wentBack, true, label);
      assert.equal(done, false, label);
      if (reloadsItself) {
        // On pageshow, within z's grace.
        reload(tab.id);
        send(context.fake, [pageRequest(tab.id, "https://z.example/z", "GET", lastCommit())]);
        await flush();
        assert.equal((await result).url, "https://z.example/z", label);
      } else {
        context.timers.advance(KEPT_GRACE_MS - 1);
        await flush();
        assert.equal(done, false, label);
        context.timers.advance(1);
        await flush();
      }
      assert.equal(done, true, label);
      assert.deepEqual(
        steps,
        reloadsItself
          ? [
              ["back", tab.id],
              ["load", tab.id, { url: "https://z.example/z", loadReplace: true }],
            ]
          : [["back", tab.id]],
        label,
      );
    }
  });

  it("decides twice at most, when the tab commits again while navigate reads it", async () => {
    const context = setup();
    context.fake.modelDocuments((url) => url === "https://z.example/z");
    const tab = await threePageTab(context);
    const { goBack, goForward, reload } = context.fake.browser.tabs;
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const lastCommit = lastCommitTime(context.fake);
    const timers = context.timers.pending();
    const get = context.fake.browser.tabs.get;
    let reads = 0;
    context.fake.browser.tabs.get = async (tabId) => {
      if (steps.length === 1) {
        reads += 1;
        // Before each check the tab moves on: back to z, kept in memory, then forward to
        // a.example/a, loaded again and its request not reported.
        if (reads === 1) await goBack(tabId);
        if (reads === 2) await goForward(tabId);
      }
      return get(tabId);
    };
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    assert.equal(done, false);
    // z reloads itself within its grace, which decides the second time.
    reload(tab.id);
    send(context.fake, [pageRequest(tab.id, "https://z.example/z", "GET", lastCommit())]);
    await flush();
    assert.equal(reads, 2);
    assert.equal(done, true);
    await result;
    assert.deepEqual(steps, [["back", tab.id]]);
    assert.equal(context.timers.pending(), timers);
  });

  it("does not reload a page restored from memory, without a commit, after the step's commit", async () => {
    const context = setup();
    context.fake.modelDocuments((url) => url === "https://z.example/z");
    const tab = await threePageTab(context);
    const { goBack } = context.fake.browser.tabs;
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const stepBack = context.fake.browser.tabs.goBack;
    context.fake.browser.tabs.goBack = (tabId) => {
      // The step loads the page again, whose inline script calls history.back().
      const stepped = stepBack(tabId);
      withoutCommitOf(context.fake, "https://z.example/z", () => goBack(tabId));
      return stepped;
    };
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
      "https://z.example/z",
    );
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("does not reload a page restored from memory, without a commit, after a racing load", async () => {
    const context = setup();
    context.fake.modelDocuments((url) => url === "https://a.example/a");
    const tab = await threePageTab(context);
    const { reload } = context.fake.browser.tabs;
    const steps = recordSteps(context.fake, () => []);
    const stepBack = context.fake.browser.tabs.goBack;
    context.fake.browser.tabs.goBack = (tabId) => {
      // The page left loads again first, then the step restores its page from memory.
      send(context.fake, [pageRequest(tabId, "https://b.example/b")]);
      reload(tabId);
      return withoutCommitOf(context.fake, "https://a.example/a", () => stepBack(tabId));
    };
    assert.equal(
      (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
      "https://a.example/a",
    );
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("reloads when the tab's frames cannot be read or name no document from before the step", async () => {
    const frames: [string, () => Promise<FrameDetails[] | null>][] = [
      [
        "rejected",
        async () => {
          throw new Error("No tab with id");
        },
      ],
      ["null", async () => null],
      ["no top frame", async () => [{ frameId: 1, documentId: "frame-document" }]],
      ["a top frame without a document", async () => [{ frameId: 0 }]],
      // The page's own next document, its commit not reported yet.
      ["a top document not heard of", async () => [{ frameId: 0, documentId: "unheard" }]],
    ];
    for (const [label, getAllFrames] of frames) {
      const context = setup();
      context.fake.modelDocuments(() => false);
      const tab = await historyTab(context);
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
      ]);
      context.fake.browser.webNavigation.getAllFrames = getAllFrames;
      await context.navigate("s1", { tabId: tab.id, action: "back" });
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
        ],
        label,
      );
    }
  });

  it("reloads after a commit without a document id, whatever document the frames name", async () => {
    const context = setup();
    context.fake.modelDocuments(() => false);
    const committed: string[] = [];
    context.fake.browser.webNavigation.onCommitted.addListener(({ frameId, documentId }) => {
      if (frameId === 0 && documentId !== undefined) committed.push(documentId);
    });
    const tab = await historyTab(context);
    const [first] = committed;
    assert.ok(first !== undefined);
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const { emitCommitted } = context.fake;
    context.fake.emitCommitted = ({ tabId, frameId, url }) =>
      emitCommitted({ tabId, frameId, url });
    context.fake.setFrames(tab.id, [{ frameId: 0, documentId: first }]);
    await context.navigate("s1", { tabId: tab.id, action: "back" });
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("stops watching navigations once it answered, for a page kept in memory or loaded again", async () => {
    const cases: [string, boolean][] = [
      ["kept in memory", true],
      ["loaded again", false],
    ];
    for (const [label, kept] of cases) {
      const context = setup();
      context.fake.modelDocuments(() => kept);
      const tab = await historyTab(context);
      recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
      const listeners = context.fake.beforeNavigateListenerCount();
      await pastRequestWait(context, { tabId: tab.id, action: "back" });
      assert.equal(context.fake.beforeNavigateListenerCount(), listeners, label);
    }
  });

  it("drops the document the tab committed least recently, not the one it first committed", async () => {
    const context = setup();
    context.fake.modelDocuments(() => true);
    const committed: string[] = [];
    context.fake.browser.webNavigation.onCommitted.addListener(({ frameId, documentId }) => {
      if (frameId === 0 && documentId !== undefined) committed.push(documentId);
    });
    const tab = await historyTab(context);
    const [first] = committed;
    assert.ok(first !== undefined);
    const extra = (index: number) =>
      context.fake.emitCommitted({
        tabId: tab.id,
        frameId: 0,
        url: "https://b.example/x",
        documentId: `extra-${index}`,
      });
    for (let index = 0; index < KNOWN_DOCUMENTS_PER_TAB - 2; index += 1) extra(index);
    // Firefox shows a.example/a from memory again, then the tab commits one document more.
    context.fake.emitCommitted({
      tabId: tab.id,
      frameId: 0,
      url: "https://a.example/a",
      documentId: first,
    });
    extra(KNOWN_DOCUMENTS_PER_TAB);
    const steps = recordSteps(context.fake, () => []);
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    context.timers.advance(KEPT_GRACE_MS);
    await flush();
    assert.equal(done, true);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("remembers the tab's last top-level web documents only, up to the bound", async () => {
    const cases: [string, number, boolean][] = [
      ["one document too many", KNOWN_DOCUMENTS_PER_TAB - 1, false],
      ["up to the bound", KNOWN_DOCUMENTS_PER_TAB - 2, true],
    ];
    for (const [label, extra, kept] of cases) {
      const context = setup();
      context.fake.modelDocuments(() => true);
      const tab = await historyTab(context);
      // historyTab committed a.example/a and b.example/b; none of these counts.
      context.fake.emitCommitted({
        tabId: tab.id,
        frameId: 0,
        url: "about:blank",
        documentId: "blank",
      });
      context.fake.emitCommitted({
        tabId: tab.id,
        frameId: 1,
        url: "https://f.example/",
        documentId: "frame",
      });
      context.fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://b.example/no-id" });
      context.fake.emitCommitted({
        tabId: tab.id + 1,
        frameId: 0,
        url: "https://c.example/",
        documentId: "other-tab",
      });
      for (let index = 0; index < extra; index += 1) {
        context.fake.emitCommitted({
          tabId: tab.id,
          frameId: 0,
          url: "https://b.example/x",
          documentId: `extra-${index}`,
        });
      }
      const steps = recordSteps(context.fake, () => []);
      let done = false;
      const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
        done = true;
      });
      await flush();
      context.timers.advance(KEPT_GRACE_MS);
      await flush();
      assert.equal(done, kept, label);
      context.timers.advance(HISTORY_REQUEST_TIMEOUT_MS - KEPT_GRACE_MS);
      assert.deepEqual(await result, tab, label);
      assert.deepEqual(steps, [["back", tab.id]], label);
    }
  });

  it("does not wait for a request after going back to a page off the web", async () => {
    const context = setup();
    await context.grant("https://a.example");
    const tab = await context.open("s1");
    await context.navigate("s1", { tabId: tab.id, url: "https://a.example/a" });
    const steps = recordSteps(context.fake, () => []);
    assert.deepEqual(await context.navigate("s1", { tabId: tab.id, action: "back" }), tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("does not reload when going back has nowhere to go", async () => {
    const context = setup();
    const tab = await context.open("s1");
    const steps = recordSteps(context.fake, () => []);
    const result = context.navigate("s1", { tabId: tab.id, action: "back" });
    await flush();
    context.timers.advance(1000);
    assert.deepEqual(await result, tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("does not reload after a top-level request that loaded no document", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, () => []);
    context.fake.browser.tabs.goBack = async (tabId) => {
      steps.push(["back", tabId]);
      // A response that shows nothing, such as a 204 or a download, leaves the tab where it was.
      send(context.fake, [pageRequest(tabId, "https://b.example/b")]);
    };
    const result = context.navigate("s1", { tabId: tab.id, action: "back" });
    await flush();
    context.timers.advance(1000);
    assert.equal((await result).url, "https://b.example/b");
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("loads the address a page moved to while it loaded, and reloads one with a fragment unless a frame sent a POST", async () => {
    const moves: [string, (tabId: number) => RequestDetails[], (tabId: number) => unknown[][]][] = [
      [
        "https://a.example/a?moved",
        () => [],
        (tabId) => [["load", tabId, { url: "https://a.example/a?moved", loadReplace: true }]],
      ],
      [
        "https://a.example/a#moved",
        () => [],
        (tabId) => [["reload", tabId, { bypassCache: true }]],
      ],
      [
        "https://a.example/a?moved",
        (tabId) => [frameRequest(tabId, "https://f.example/form", "POST")],
        (tabId) => [["load", tabId, { url: "https://a.example/a?moved", loadReplace: true }]],
      ],
      [
        "https://a.example/a#moved",
        (tabId) => [frameRequest(tabId, "https://f.example/form", "POST")],
        () => [],
      ],
    ];
    for (const [moved, frames, load] of moves) {
      const context = setup();
      const tab = await historyTab(context);
      const fakeTab = context.fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
        ...frames(tabId),
      ]);
      const goBack = context.fake.browser.tabs.goBack;
      context.fake.browser.tabs.goBack = (tabId) => {
        const stepped = goBack(tabId);
        // The page's history.replaceState, before its load completes.
        fakeTab.url = moved;
        return stepped;
      };
      const label = `${moved}, ${frames(tab.id).length} frame POST`;
      assert.equal(
        (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
        moved,
        label,
      );
      assert.deepEqual(steps, [["back", tab.id], ...load(tab.id)], label);
    }
  });

  it("does not reload after a top-level request that is not a GET", async () => {
    const cases: [string, (tabId: number) => RequestDetails[]][] = [
      ["a top-level POST", (tabId) => [pageRequest(tabId, "https://a.example/a", "POST")]],
      [
        "a top-level POST after the GET",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a"),
          pageRequest(tabId, "https://a.example/a", "POST"),
        ],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, requests] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, requests);
        assert.deepEqual(
          await context.navigate("s1", { tabId: tab.id, action: "back" }),
          tab,
          `${label}, ${shown}`,
        );
        assert.deepEqual(steps, [["back", tab.id]], `${label}, ${shown}`);
      }
    }
  });

  it("loads with GET after a frame request that is not a GET, and reloads no address with a fragment after one", async () => {
    const cases: [string, (tabId: number) => RequestDetails[]][] = [
      [
        "a frame POST",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a"),
          frameRequest(tabId, "https://f.example/form", "POST"),
        ],
      ],
      [
        "an <object> frame POST",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a"),
          { ...frameRequest(tabId, "https://f.example/form", "POST"), type: "object" },
        ],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, requests] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, requests);
        const loaded = await context.navigate("s1", { tabId: tab.id, action: "back" });
        if (shown.includes("#")) {
          assert.deepEqual(loaded, tab, `${label}, ${shown}`);
          assert.deepEqual(steps, [["back", tab.id]], `${label}, ${shown}`);
        } else {
          assert.deepEqual(
            steps,
            [
              ["back", tab.id],
              ["load", tab.id, { url: shown, loadReplace: true }],
            ],
            `${label}, ${shown}`,
          );
        }
      }
    }
  });

  it("does not reload after only a frame request, or a top-level one in another tab", async () => {
    const cases: [string, (tabId: number) => RequestDetails[]][] = [
      ["a frame GET", (tabId) => [frameRequest(tabId, "https://a.example/frame")]],
      ["another tab", (tabId) => [pageRequest(tabId + 1, "https://a.example/a")]],
    ];
    for (const [label, requests] of cases) {
      const context = setup();
      const tab = await historyTab(context);
      const steps = recordSteps(context.fake, requests);
      assert.deepEqual(
        await pastRequestWait(context, { tabId: tab.id, action: "back" }),
        tab,
        label,
      );
      assert.deepEqual(steps, [["back", tab.id]], label);
    }
  });

  it("reloads despite a POST that is not a page or frame load, or one in another tab", async () => {
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      const context = setup();
      const tab = await historyTab(context, shown);
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
        { ...pageRequest(tabId, "https://a.example/api", "POST"), type: "xmlhttprequest" },
        pageRequest(tabId + 1, "https://c.example/", "POST"),
        frameRequest(tabId + 1, "https://f.example/form", "POST"),
      ]);
      await context.navigate("s1", { tabId: tab.id, action: "back" });
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          shown.includes("#")
            ? ["reload", tab.id, { bypassCache: true }]
            : ["load", tab.id, { url: shown, loadReplace: true }],
        ],
        shown,
      );
    }
  });

  it("reloads despite a frame's commit, or one in another tab, after the page's", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const goBack = context.fake.browser.tabs.goBack;
    context.fake.browser.tabs.goBack = (tabId) => {
      const stepped = goBack(tabId);
      context.fake.emitCommitted({ tabId, frameId: 1, url: "https://f.example/frame" });
      context.fake.emitCommitted({ tabId: tabId + 1, frameId: 0, url: "https://c.example/" });
      return stepped;
    };
    await context.navigate("s1", { tabId: tab.id, action: "back" });
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("reloads despite a POST that came before the page's own request", async () => {
    const cases: [string, (tabId: number) => RequestDetails[]][] = [
      [
        "a top-level POST the step replaced",
        (tabId) => [
          pageRequest(tabId, "https://b.example/send", "POST"),
          pageRequest(tabId, "https://a.example/a", "GET", 2),
        ],
      ],
      [
        "a frame POST of the page left",
        (tabId) => [
          frameRequest(tabId, "https://f.example/form", "POST"),
          pageRequest(tabId, "https://a.example/a", "GET", 2),
        ],
      ],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, requests] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const steps = recordSteps(context.fake, requests);
        await context.navigate("s1", { tabId: tab.id, action: "back" });
        assert.deepEqual(
          steps,
          [
            ["back", tab.id],
            shown.includes("#")
              ? ["reload", tab.id, { bypassCache: true }]
              : ["load", tab.id, { url: shown, loadReplace: true }],
          ],
          `${label}, ${shown}`,
        );
      }
    }
  });

  it("does not reload a page on a site the session may not act on, and redacts it", async () => {
    const changes: [string, (context: ReturnType<typeof setup>) => Promise<void>][] = [
      ["not approved", ({ fake }) => revokeSite(fake.browser, "https://a.example")],
      ["blocked", ({ fake }) => fake.browser.storage.local.set({ blocklist: ["a.example"] })],
    ];
    for (const [label, change] of changes) {
      const context = setup();
      const tab = await historyTab(context);
      await change(context);
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
      ]);
      assert.deepEqual(
        await context.navigate("s1", { tabId: tab.id, action: "back" }),
        { ...tab, url: "https://a.example", title: "" },
        label,
      );
      assert.deepEqual(steps, [["back", tab.id]], label);
    }
  });

  it("does not reload when the last top-level request before the commit was for another page", async () => {
    const cases: [string, (tabId: number) => RequestDetails[]][] = [
      [
        "started in the same millisecond, reported later",
        (tabId) => [
          pageRequest(tabId, "https://a.example/a"),
          pageRequest(tabId, "https://a.example/other"),
        ],
      ],
      [
        "started later, reported earlier",
        (tabId) => [
          pageRequest(tabId, "https://a.example/other", "GET", 2),
          pageRequest(tabId, "https://a.example/a"),
        ],
      ],
    ];
    for (const [label, requests] of cases) {
      const context = setup();
      const tab = await historyTab(context);
      const steps = recordSteps(context.fake, requests);
      assert.deepEqual(
        await pastRequestWait(context, { tabId: tab.id, action: "back" }),
        tab,
        label,
      );
      assert.deepEqual(steps, [["back", tab.id]], label);
    }
  });

  it("loads when only the fragment differs between the request and the commit, and reloads an address with a fragment without the cache", async () => {
    const cases: [string, string][] = [
      ["https://a.example/a#top", "https://a.example/a"],
      ["https://a.example/a#", "https://a.example/a"],
      ["https://a.example/a", "https://a.example/a#top"],
    ];
    for (const [shown, requested] of cases) {
      const context = setup();
      const tab = await historyTab(context, shown);
      const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, requested)]);
      assert.equal((await context.navigate("s1", { tabId: tab.id, action: "back" })).url, shown);
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          // Loading an address with a fragment over its document loads no document.
          shown.includes("#")
            ? ["reload", tab.id, { bypassCache: true }]
            : ["load", tab.id, { url: shown, loadReplace: true }],
        ],
        shown,
      );
    }
  });

  it("does not reload a tab that left the session's group during the step", async () => {
    const moves: [string, (fake: FakeBrowser, tab: Tab) => void][] = [
      ["to another group", (_fake, tab) => Object.assign(tab, { groupId: 999 })],
      [
        "out of its emptied group",
        (fake, tab) => {
          fake.groups.delete(tab.groupId ?? -1);
          tab.groupId = -1;
        },
      ],
    ];
    for (const [label, move] of moves) {
      const context = setup();
      const tab = await historyTab(context);
      const fakeTab = context.fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      const steps = recordSteps(context.fake, (tabId) => {
        move(context.fake, fakeTab);
        return [pageRequest(tabId, "https://a.example/a")];
      });
      assert.equal(
        (await context.navigate("s1", { tabId: tab.id, action: "back" })).url,
        "https://a.example/a",
        label,
      );
      assert.deepEqual(steps, [["back", tab.id]], label);
    }
  });

  it("does not reload over the session's prompt shown in the tab during the step", async (t) => {
    const context = setup();
    const tab = await historyTab(context);
    let stepped = false;
    const openPrompt = context.access.openPrompt;
    t.mock.method(context.access, "openPrompt", (session: string) =>
      stepped ? { tabId: tab.id, site: "https://c.example" } : openPrompt(session),
    );
    const steps = recordSteps(context.fake, (tabId) => {
      stepped = true;
      return [pageRequest(tabId, "https://a.example/a")];
    });
    assert.deepEqual(await context.navigate("s1", { tabId: tab.id, action: "back" }), tab);
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("loads with GET after a top-level POST sent once the step's load completed, and reloads no address with a fragment after one", async () => {
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      const context = setup();
      const tab = await historyTab(context, shown);
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
      ]);
      sendOnLookup(
        context,
        (tabId) => pageRequest(tabId, "https://a.example/a", "POST", 1000),
        shown,
      );
      const loaded = await context.navigate("s1", { tabId: tab.id, action: "back" });
      assertGetLoadOnlyWithoutFragment(steps, loaded, tab, shown);
    }
  });

  it("loads with GET after a frame POST sent once the step's load completed, and reloads no address with a fragment after one", async () => {
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      const context = setup();
      const tab = await historyTab(context, shown);
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
      ]);
      sendOnLookup(
        context,
        (tabId) => frameRequest(tabId, "https://f.example/form", "POST", 1000),
        shown,
      );
      const loaded = await context.navigate("s1", { tabId: tab.id, action: "back" });
      if (shown.includes("#")) {
        assert.deepEqual(loaded, tab, shown);
        assert.deepEqual(steps, [["back", tab.id]], shown);
      } else {
        assert.deepEqual(
          steps,
          [
            ["back", tab.id],
            ["load", tab.id, { url: shown, loadReplace: true }],
          ],
          shown,
        );
      }
    }
  });

  it("does not turn the load into a reload after a POST reported once it started", async () => {
    const cases: [string, (tabId: number) => RequestDetails][] = [
      ["a frame POST", (tabId) => frameRequest(tabId, "https://f.example/form", "POST", 1000)],
      ["a top-level POST", (tabId) => pageRequest(tabId, "https://a.example/a", "POST", 1000)],
    ];
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      for (const [label, late] of cases) {
        const context = setup();
        const tab = await historyTab(context, shown);
        const { reload, update } = context.fake.browser.tabs;
        context.fake.browser.tabs.update = async (tabId, properties) => {
          send(context.fake, [late(tabId)]);
          return update(tabId, properties);
        };
        context.fake.browser.tabs.reload = async (tabId, properties) => {
          send(context.fake, [late(tabId)]);
          return reload(tabId, properties);
        };
        const steps = recordSteps(context.fake, (tabId) => [
          pageRequest(tabId, "https://a.example/a"),
        ]);
        const loaded = await context.navigate("s1", { tabId: tab.id, action: "back" });
        assert.equal(loaded.url, shown, `${label}, ${shown}`);
        assert.deepEqual(
          steps,
          [
            ["back", tab.id],
            shown.includes("#")
              ? ["reload", tab.id, { bypassCache: true }]
              : ["load", tab.id, { url: shown, loadReplace: true }],
          ],
          `${label}, ${shown}`,
        );
      }
    }
  });

  it("reloads despite a top-level GET sent once the step's load completed", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    // A download or a 204, which loads no document.
    sendOnLookup(context, (tabId) =>
      pageRequest(tabId, "https://a.example/export.csv", "GET", 1000),
    );
    await context.navigate("s1", { tabId: tab.id, action: "back" });
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("stops watching requests as the load starts, and when the history step fails", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const listeners: [string, number, number][] = [];
    const committed = context.fake.committedListenerCount();
    // The listeners that hear every request, such as the file guard's.
    const always = send(context.fake, [frameRequest(tab.id, "https://a.example/f")]);
    const note = (label: string, tabId: number) => {
      const requests = send(context.fake, [frameRequest(tabId, "https://a.example/f")]) - always;
      listeners.push([label, requests, context.fake.committedListenerCount() - committed]);
    };
    const update = context.fake.browser.tabs.update;
    context.fake.browser.tabs.update = async (tabId, properties) => {
      note("load", tabId);
      return update(tabId, properties);
    };
    recordSteps(context.fake, (tabId) => {
      note("back", tabId);
      return [pageRequest(tabId, "https://a.example/a")];
    });
    await context.navigate("s1", { tabId: tab.id, action: "back" });
    note("returned", tab.id);
    context.fake.browser.tabs.goForward = async (tabId) => {
      note("forward", tabId);
      throw new Error("No such tab");
    };
    await assert.rejects(context.navigate("s1", { tabId: tab.id, action: "forward" }), {
      message: "No such tab",
    });
    note("failed", tab.id);
    // The commit listener at the load is the load's own wait's, which waits for its commit.
    assert.deepEqual(listeners, [
      ["back", 1, 1],
      ["load", 0, 1],
      ["returned", 0, 0],
      ["forward", 1, 1],
      ["failed", 0, 0],
    ]);
  });

  it("loads with GET a page whose load its timeout cut off, and reloads no address with a fragment then", async () => {
    for (const shown of ["https://a.example/a", "https://a.example/a#top"]) {
      const context = setup();
      const tab = await historyTab(context, shown);
      const fakeTab = context.fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      const steps = recordSteps(context.fake, () => []);
      // The load commits and never completes, as with a script that never arrives.
      context.fake.browser.tabs.goBack = async (tabId) => {
        steps.push(["back", tabId]);
        send(context.fake, [pageRequest(tabId, "https://a.example/a")]);
        Object.assign(fakeTab, { url: shown, status: "loading" });
        context.fake.emitCommitted({ tabId, frameId: 0, url: shown });
      };
      const result = context.navigate("s1", { tabId: tab.id, action: "back" });
      await flush();
      context.timers.advance(LOAD_GRACE_MS);
      await flush();
      context.timers.advance(LOAD_TIMEOUT_MS);
      const loaded = await result;
      if (shown.includes("#")) {
        assert.deepEqual(loaded, { ...tab, title: "" }, shown);
        assert.deepEqual(steps, [["back", tab.id]], shown);
      } else {
        assert.deepEqual(loaded, { ...tab, title: `Title of ${shown}` }, shown);
        assert.deepEqual(
          steps,
          [
            ["back", tab.id],
            ["load", tab.id, { url: shown, loadReplace: true }],
          ],
          shown,
        );
      }
    }
  });

  it("answers below the host's request timeout when each wait runs to its end", async () => {
    // The step's load completes just before its timeout, or its timeout cuts it off.
    for (const completes of [true, false]) {
      const context = setup();
      const tab = await historyTab(context);
      const fakeTab = context.fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      const steps: unknown[][] = [];
      const ended = completes
        ? LOAD_GRACE_MS + LOAD_TIMEOUT_MS - 1
        : LOAD_GRACE_MS + LOAD_TIMEOUT_MS;
      // Its request is reported just before navigate stops waiting for it.
      const reported = ended + HISTORY_REQUEST_TIMEOUT_MS - 1;
      context.fake.browser.tabs.goBack = async (tabId) => {
        steps.push(["back", tabId]);
        Object.assign(fakeTab, { url: "https://a.example/a", status: "loading" });
        context.fake.emitCommitted({ tabId, frameId: 0, url: "https://a.example/a" });
        if (completes) {
          context.timers.setTimeout(() => context.fake.emitStatus(tabId, "complete"), ended);
        }
        context.timers.setTimeout(() => {
          send(context.fake, [pageRequest(tabId, "https://a.example/a")]);
        }, reported);
      };
      // The load never completes.
      context.fake.browser.tabs.update = async (tabId, properties) => {
        steps.push(["load", tabId, properties]);
        fakeTab.status = "loading";
        return { ...fakeTab };
      };
      let done = false;
      const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
        done = true;
      });
      let elapsed = 0;
      while (!done && elapsed < 120_000) {
        await flush();
        await flush();
        context.timers.advance(500);
        elapsed += 500;
      }
      const label = completes ? "completed" : "cut off";
      assert.equal((await result).url, "https://a.example/a", label);
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
        ],
        label,
      );
      // Then the load's grace and timeout.
      assert.ok(
        elapsed >= reported + LOAD_GRACE_MS + HISTORY_RELOAD_TIMEOUT_MS,
        `${label}: answered after ${elapsed} ms`,
      );
      assert.ok(elapsed < 60_000, `${label}: answered after ${elapsed} ms`);
    }
  });

  it("answers after going back only once the load of the address committed, not at an earlier complete", async () => {
    for (const commits of [true, false]) {
      const context = setup();
      const tab = await historyTab(context);
      const fakeTab = context.fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      let began = false;
      // The load begins, and Firefox reports a complete before its commit, as for the abort of a
      // load the step's timeout cut off, or a load the page stops.
      context.fake.browser.tabs.update = async (tabId, properties) => {
        began = true;
        beginNavigation(context.fake, tabId, properties.url ?? "");
        context.fake.emitStatus(tabId, "complete");
        return { ...fakeTab };
      };
      const steps = recordSteps(context.fake, (tabId) => [
        pageRequest(tabId, "https://a.example/a"),
      ]);
      let done = false;
      const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
        done = true;
      });
      for (let turn = 0; turn < 50 && !began; turn += 1) await flush();
      await flush();
      const label = commits ? "commits" : "no commit";
      assert.ok(began, label);
      assert.equal(done, false, label);
      if (commits) {
        context.timers.advance(HISTORY_RELOAD_TIMEOUT_MS - 1);
        // A redirect's commit counts as the load's.
        landNavigation(context.fake, tab.id, "https://a.example/redirected");
        await flush();
        assert.equal(done, false, label);
        context.fake.emitStatus(tab.id, "complete");
      } else {
        context.timers.advance(HISTORY_RELOAD_TIMEOUT_MS - 1);
        await flush();
        assert.equal(done, false, label);
        context.timers.advance(1);
      }
      assert.equal(
        (await result).url,
        commits ? "https://a.example/redirected" : "https://a.example/a",
        label,
      );
      assert.deepEqual(
        steps,
        [
          ["back", tab.id],
          ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
        ],
        label,
      );
    }
  });

  it("does not count for wait_for the end of a load after going back that navigate returned during", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const fakeTab = context.fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    // The load begins and never completes within its wait.
    context.fake.browser.tabs.update = async (tabId) => {
      beginNavigation(context.fake, tabId, "https://a.example/a");
      return { ...fakeTab };
    };
    let done = false;
    const result = context.navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    let elapsed = 0;
    while (!done && elapsed < 120_000) {
      await flush();
      await flush();
      context.timers.advance(500);
      elapsed += 500;
    }
    assert.equal((await result).url, "https://a.example/a");
    const waiting = context.call("s1", "wait_for", {
      tabId: tab.id,
      navigation: true,
      timeoutMs: 2000,
    });
    await flush();
    fakeTab.status = "complete";
    context.fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/a" });
    await flush();
    context.timers.advance(2000);
    await rejectsWith(waiting, "wait_timeout");
  });

  it("leaves the reload action and a url navigate as they were", async (t) => {
    const context = setup();
    const tab = await historyTab(context);
    const { reload, update } = context.fake.browser.tabs;
    const reloads = t.mock.method(context.fake.browser.tabs, "reload", async (tabId: number) => {
      send(context.fake, [pageRequest(tabId, "https://b.example/b")]);
      return reload(tabId, { bypassCache: true });
    });
    const updates: unknown[][] = [];
    context.fake.browser.tabs.update = async (tabId, properties) => {
      if (properties.url !== undefined) {
        updates.push([tabId, properties]);
        send(context.fake, [pageRequest(tabId, properties.url)]);
      }
      return update(tabId, properties);
    };
    await context.navigate("s1", { tabId: tab.id, action: "reload" });
    assert.equal(reloads.mock.callCount(), 1);
    assert.deepEqual(updates, []);
    await context.navigate("s1", { tabId: tab.id, url: "https://a.example/c" });
    assert.equal(reloads.mock.callCount(), 1);
    assert.deepEqual(updates, [[tab.id, { url: "https://a.example/c" }]]);
  });
});

describe("navigate reload that Firefox lands on about:blank", { timeout: 10000 }, () => {
  it("loads the page in place of the blank entry and returns the tab on the page", async () => {
    const { fake, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    const history = [...(fake.tabs.get(tab.id)?.history ?? [])];
    const reloads = reloadToBlank(fake);
    const updates = fake.tabUpdates.length;
    assert.deepEqual(await navigate("s1", { tabId: tab.id, action: "reload" }), tab);
    assert.deepEqual(reloads, [[tab.id, { bypassCache: true }]]);
    assert.deepEqual(fake.tabUpdates.slice(updates), [
      { tabId: tab.id, url: "https://a.example/page", loadReplace: true },
    ]);
    assert.deepEqual(fake.tabs.get(tab.id)?.history, history);
  });

  it("loads nothing in place of the blank when the tab may no longer get the page", async () => {
    const cases: [string, (context: ReturnType<typeof setup>, tab: FakeTab) => void][] = [
      ["approval withdrawn", ({ sessions }) => sessions.set("s1", state([]))],
      [
        "site blocked",
        ({ fake }) => {
          void fake.browser.storage.local.set({ blocklist: ["a.example"] });
        },
      ],
      ["moved to another group", (_context, tab) => Object.assign(tab, { groupId: 999 })],
      [
        "moved out of its emptied group",
        ({ fake }, tab) => {
          fake.groups.delete(tab.groupId);
          tab.groupId = -1;
        },
      ],
      [
        "moved on to another page",
        (_context, tab) => Object.assign(tab, { url: "https://a.example/other" }),
      ],
      // A load started meanwhile, not yet committed.
      ["loading again", (_context, tab) => Object.assign(tab, { status: "loading" })],
    ];
    for (const [label, change] of cases) {
      const context = setup();
      const { fake, navigate, open, sessions } = context;
      sessions.set("s1", state(["https://a.example"]));
      const tab = await open("s1", "https://a.example/page");
      const fakeTab = fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      const reloads = reloadToBlank(fake, () => change(context, fakeTab));
      const updates = fake.tabUpdates.length;
      const url = label === "moved on to another page" ? "https://a.example/other" : "about:blank";
      await navigate("s1", { tabId: tab.id, action: "reload" });
      assert.deepEqual(reloads, [[tab.id, { bypassCache: true }]], label);
      assert.deepEqual(fake.tabUpdates.slice(updates), [], label);
      assert.equal(fakeTab.url, url, label);
    }
  });

  it("loads nothing in place of the blank once the session's prompt is in the tab", async (t) => {
    const { fake, access, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    let landed = false;
    const openPrompt = access.openPrompt;
    t.mock.method(access, "openPrompt", (session: string) =>
      landed ? { tabId: tab.id, site: "https://c.example" } : openPrompt(session),
    );
    reloadToBlank(fake, () => {
      landed = true;
    });
    const updates = fake.tabUpdates.length;
    await navigate("s1", { tabId: tab.id, action: "reload" });
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
    assert.equal(fake.tabs.get(tab.id)?.url, "about:blank");
  });

  it("loads nothing in place of the blank when the reload's wait timed out first", async () => {
    const { fake, timers, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    let reloads = 0;
    // The reload never completes.
    fake.browser.tabs.reload = async (tabId) => {
      reloads += 1;
      fakeTab.url = "about:blank";
      fake.emitStatus(tabId, "loading");
    };
    const updates = fake.tabUpdates.length;
    const reloaded = navigate("s1", { tabId: tab.id, action: "reload" });
    for (let turn = 0; turn < 50 && reloads === 0; turn += 1) await flush();
    assert.equal(reloads, 1);
    timers.advance(LOAD_TIMEOUT_MS);
    // It completes on about:blank just after the wait gave up.
    fakeTab.status = "complete";
    await reloaded;
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
    assert.equal(fakeTab.url, "about:blank");
  });

  it("returns the tab as it is when the page's load in place of the blank does not complete", async () => {
    const { fake, timers, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    reloadToBlank(fake);
    const updates: unknown[] = [];
    const get = fake.browser.tabs.get;
    // The load commits and never completes.
    fake.browser.tabs.update = async (tabId, properties) => {
      updates.push({ tabId, ...properties });
      fake.emitStatus(tabId, "loading");
      fake.emitCommitted({ tabId, frameId: 0, url: "https://a.example/page" });
      return get(tabId);
    };
    let done = false;
    const reloaded = navigate("s1", { tabId: tab.id, action: "reload" }).finally(() => {
      done = true;
    });
    for (let turn = 0; turn < 50 && updates.length === 0; turn += 1) await flush();
    assert.deepEqual(updates, [
      { tabId: tab.id, url: "https://a.example/page", loadReplace: true },
    ]);
    timers.advance(BLANK_RELOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(done, false);
    timers.advance(1);
    for (let turn = 0; turn < 50 && !done; turn += 1) await flush();
    assert.equal(done, true);
    assert.equal(fake.tabs.get(tab.id)?.status, "loading");
    await reloaded;
  });

  it("fails when the page's load in place of the blank never commits", async () => {
    const { fake, timers, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    reloadToBlank(fake);
    const updates: unknown[] = [];
    const get = fake.browser.tabs.get;
    fake.browser.tabs.update = async (tabId, properties) => {
      updates.push({ tabId, ...properties });
      fake.emitStatus(tabId, "loading");
      return get(tabId);
    };
    let done = false;
    const reloaded = navigate("s1", { tabId: tab.id, action: "reload" }).finally(() => {
      done = true;
    });
    reloaded.catch(() => {});
    for (let turn = 0; turn < 50 && updates.length === 0; turn += 1) await flush();
    assert.deepEqual(updates, [
      { tabId: tab.id, url: "https://a.example/page", loadReplace: true },
    ]);
    timers.advance(BLANK_RELOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(done, false);
    timers.advance(1);
    await assert.rejects(reloaded, {
      code: "navigation_timeout",
      message: `Tab ${tab.id} did not load a page from that URL within 20 seconds.`,
    });
  });
});

describe("navigate reload of a tab Firefox unloaded", { timeout: 10000 }, () => {
  it("loads the page in place of the reload, then reloads it once it is loaded again", async (t) => {
    const { fake, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    fakeTab.discarded = true;
    const history = [...fakeTab.history];
    const updates = fake.tabUpdates.length;
    const reload = t.mock.method(fake.browser.tabs, "reload");
    assert.deepEqual(await navigate("s1", { tabId: tab.id, action: "reload" }), tab);
    assert.equal(reload.mock.callCount(), 0);
    assert.deepEqual(fake.tabUpdates.slice(updates), [
      { tabId: tab.id, url: "https://a.example/page", loadReplace: true },
    ]);
    assert.equal(fakeTab.discarded, false);
    assert.deepEqual(fakeTab.history, history);
    const reloaded = fake.tabUpdates.length;
    await navigate("s1", { tabId: tab.id, action: "reload" });
    assert.deepEqual(
      reload.mock.calls.map((made) => made.arguments),
      [[tab.id, { bypassCache: true }]],
    );
    assert.deepEqual(fake.tabUpdates.slice(reloaded), []);
  });

  it("loads the page after the answer in place of the reload", async (t) => {
    const { fake, call, open, timeOut } = setup();
    const other = await open("s1");
    const otherTab = fake.tabs.get(other.id);
    assert.ok(otherTab);
    otherTab.url = "https://a.example/page";
    otherTab.history = ["https://a.example/page"];
    otherTab.discarded = true;
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    const shown = await timeOut("s1");
    await first;
    const reload = t.mock.method(fake.browser.tabs, "reload");
    const updates = fake.tabUpdates.length;
    const reloaded = call("s1", "navigate", { tabId: other.id, action: "reload" });
    await flush();
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
    shown.deliver({ type: "answer", answer: "once" });
    const result = await reloaded;
    assert.ok("tab" in result);
    // The prompt's tab is the active one.
    assert.deepEqual(result.tab, {
      id: other.id,
      url: "https://a.example/page",
      title: "Title of https://a.example/page",
      active: false,
    });
    assert.equal(reload.mock.callCount(), 0);
    assert.deepEqual(fake.tabUpdates.slice(updates), [
      { tabId: other.id, url: "https://a.example/page", loadReplace: true },
    ]);
    assert.equal(otherTab.discarded, false);
    assert.deepEqual(otherTab.history, ["https://a.example/page"]);
  });
});

describe("a load whose page is ready before it completes", { timeout: 10000 }, () => {
  it("answers navigate to a URL 0.4 s after the page's DOM is ready, with the tab as it is then", async () => {
    const { fake, timers, navigate, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    loadUntilReady(fake);
    let done = false;
    const navigated = navigate("s1", { tabId: tab.id, url: "https://b.example/" }).finally(() => {
      done = true;
    });
    await flush();
    assert.equal(loadsOf(fake, "https://b.example/"), 1);
    timers.advance(LOAD_AFTER_READY_MS - 1);
    await flush();
    assert.equal(done, false);
    timers.advance(1);
    assert.deepEqual(await navigated, {
      id: tab.id,
      url: "https://b.example/",
      title: "",
      active: true,
    });
    // The result leaves out the title of a tab still loading.
    assert.equal(fake.tabs.get(tab.id)?.title, "Interim title");
    assert.equal(fake.tabs.get(tab.id)?.status, "loading");
  });

  it("does not count the load navigate answered early as a navigation for wait_for", async () => {
    const { fake, timers, call, navigate, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    loadUntilReady(fake);
    const navigated = navigate("s1", { tabId: tab.id, url: "https://b.example/" });
    await flush();
    timers.advance(LOAD_AFTER_READY_MS);
    await navigated;
    completeLoad(fake, tab.id);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await assert.rejects(waiting, { code: "wait_timeout" });
  });

  it("does not count the load navigate answered early when it ends during a wait_for", async () => {
    const { fake, timers, call, navigate, open, grant } = setup();
    await grant("https://a.example");
    await grant("https://b.example");
    const tab = await open("s1", "https://a.example/");
    loadUntilReady(fake);
    const navigated = navigate("s1", { tabId: tab.id, url: "https://b.example/" });
    await flush();
    timers.advance(LOAD_AFTER_READY_MS);
    await navigated;
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    completeLoad(fake, tab.id);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://b.example/" });
    await flush();
    timers.advance(2000);
    await assert.rejects(waiting, { code: "wait_timeout" });
  });

  it("does not count the load tab_open answered early when it ends during a wait_for", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://example.com");
    loadUntilReady(fake);
    const opening = open("s1", "https://example.com/a");
    await flush();
    timers.advance(LOAD_AFTER_READY_MS);
    const tab = await opening;
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    completeLoad(fake, tab.id);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://example.com/a" });
    await flush();
    timers.advance(2000);
    await assert.rejects(waiting, { code: "wait_timeout" });
  });

  it("counts the load of a navigation a click began when it ends during a wait_for", async () => {
    const { fake, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s1", tab.id, call, replyWith);
    beginNavigation(fake, tab.id, "https://a.example/next");
    landNavigation(fake, tab.id, "https://a.example/next");
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    completeLoad(fake, tab.id);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/next" });
    const result = await waiting;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/next");
  });

  it("counts the load of a navigation under way when a wait_for starts, with no action before", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    beginNavigation(fake, tab.id, "https://a.example/next");
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    landNavigation(fake, tab.id, "https://a.example/next");
    completeLoad(fake, tab.id);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/next" });
    const result = await waiting;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/next");
  });

  it("counts the load of a navigation that was ready before a wait_for starts, with no action before", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    beginNavigation(fake, tab.id, "https://a.example/next");
    landNavigation(fake, tab.id, "https://a.example/next");
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    completeLoad(fake, tab.id);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/next" });
    const result = await waiting;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/next");
  });

  it("does not count the load tab_open answered early after a prompt when it ends during a wait_for", async () => {
    const { fake, timers, call, page } = setup();
    loadUntilReady(fake);
    const opening = call("s1", "tab_open", { url: "https://a.example/x" });
    (await page("s1")).deliver({ type: "answer", answer: "once" });
    await flush();
    timers.advance(LOAD_AFTER_READY_MS);
    const opened = await opening;
    assert.ok("tab" in opened);
    const waiting = call("s1", "wait_for", {
      tabId: opened.tab.id,
      navigation: true,
      timeoutMs: 2000,
    });
    await flush();
    completeLoad(fake, opened.tab.id);
    fake.emitCompleted({ tabId: opened.tab.id, frameId: 0, url: "https://a.example/x" });
    await flush();
    timers.advance(2000);
    await assert.rejects(waiting, { code: "wait_timeout" });
  });

  it("answers tab_open 0.4 s after the page's DOM is ready, grouped before its load, selected after", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://example.com");
    loadUntilReady(fake);
    const groupsAtLoad: (number | undefined)[] = [];
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      if (properties.url !== undefined) groupsAtLoad.push(fake.tabs.get(tabId)?.groupId);
      return update(tabId, properties);
    };
    let opened: TabInfo | undefined;
    open("s1", "https://example.com/a").then((tab) => {
      opened = tab;
    });
    await flush();
    assert.equal(loadsOf(fake, "https://example.com/a"), 1);
    timers.advance(LOAD_AFTER_READY_MS - 1);
    await flush();
    assert.equal(opened, undefined);
    const [load] = fake.tabUpdates;
    assert.ok(load);
    assert.deepEqual(fake.tabUpdates, [
      { tabId: load.tabId, url: "https://example.com/a", loadReplace: true },
    ]);
    assert.deepEqual(groupsAtLoad, [groupIdOf(fake, load.tabId)]);
    timers.advance(1);
    await flush();
    assert.deepEqual(opened, {
      id: load.tabId,
      url: "https://example.com/a",
      title: "",
      active: true,
    });
    assert.deepEqual(fake.tabUpdates.at(-1), { tabId: load.tabId, active: true });
  });

  it("answers tab_open after an approval prompt 0.4 s after the page's DOM is ready", async () => {
    const { fake, timers, call, page } = setup();
    loadUntilReady(fake);
    let done = false;
    const opened = call("s1", "tab_open", { url: "https://a.example/x" }).finally(() => {
      done = true;
    });
    (await page("s1")).deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(loadsOf(fake, "https://a.example/x"), 1);
    timers.advance(LOAD_AFTER_READY_MS - 1);
    await flush();
    assert.equal(done, false);
    timers.advance(1);
    const result = await opened;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/x");
    assert.equal(result.tab.title, "");
  });

  it("waits for the whole page going back, and still loads again the page Firefox loaded again", async () => {
    const context = setup();
    const { fake, timers, navigate } = context;
    const tab = await historyTab(context);
    const steps: unknown[][] = [];
    fake.browser.tabs.goBack = async (tabId) => {
      steps.push(["back", tabId]);
      const shown = fake.tabs.get(tabId);
      assert.ok(shown);
      shown.index -= 1;
      const url = shown.history[shown.index] ?? "";
      send(fake, [pageRequest(tabId, url)]);
      beginNavigation(fake, tabId, url);
      landNavigation(fake, tabId, url);
    };
    const { reload, update } = fake.browser.tabs;
    fake.browser.tabs.reload = async (tabId, properties) => {
      steps.push(["reload", tabId, properties]);
      return reload(tabId, properties);
    };
    fake.browser.tabs.update = async (tabId, properties) => {
      steps.push(["load", tabId, properties]);
      return update(tabId, properties);
    };
    let done = false;
    const result = navigate("s1", { tabId: tab.id, action: "back" }).finally(() => {
      done = true;
    });
    await flush();
    assert.deepEqual(steps, [["back", tab.id]]);
    timers.advance(LOAD_AFTER_READY_MS * 5);
    await flush();
    assert.equal(done, false);
    completeLoad(fake, tab.id);
    assert.equal((await result).url, "https://a.example/a");
    assert.deepEqual(steps, [
      ["back", tab.id],
      ["load", tab.id, { url: "https://a.example/a", loadReplace: true }],
    ]);
  });

  it("waits for the whole page on a reload", async () => {
    const { fake, timers, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    fake.browser.tabs.reload = async (tabId) => {
      beginNavigation(fake, tabId, "https://a.example/page");
      landNavigation(fake, tabId, "https://a.example/page");
    };
    await assertWaitsForComplete({ fake, timers }, tab.id, () =>
      navigate("s1", { tabId: tab.id, action: "reload" }),
    );
  });

  it("waits for the whole page on a reload of a tab Firefox unloaded", async () => {
    const { fake, timers, navigate, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    const shown = fake.tabs.get(tab.id);
    assert.ok(shown);
    shown.discarded = true;
    loadUntilReady(fake);
    await assertWaitsForComplete({ fake, timers }, tab.id, () =>
      navigate("s1", { tabId: tab.id, action: "reload" }),
    );
    assert.equal(loadsOf(fake, "https://a.example/page"), 2);
  });

  it("waits for the whole page on a reload that went through an approval prompt", async () => {
    const { fake, timers, call, open, sessions, page } = setup();
    sessions.set("s1", state(["https://b.example"]));
    const tab = await open("s1", "https://b.example/page");
    sessions.set("s1", state([]));
    loadUntilReady(fake);
    await assertWaitsForComplete({ fake, timers }, tab.id, async () => {
      const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
      (await page("s1")).deliver({ type: "answer", answer: "once" });
      const result = await reloaded;
      assert.ok("tab" in result);
      return result.tab;
    });
    assert.deepEqual(fake.tabUpdates.at(-1), {
      tabId: tab.id,
      url: "https://b.example/page",
      loadReplace: true,
    });
  });
});

describe("a load that commits nothing into a tab Firefox unloaded", { timeout: 10000 }, () => {
  for (const [name, params] of [
    ["navigate of its fragment URL", { url: "https://a.example/file#x" }],
    ["navigate reload", { action: "reload" }],
  ] as const) {
    it(`fails with navigation_timeout on ${name}`, async () => {
      const { fake, timers, call, open, sessions } = setup();
      sessions.set("s1", state(["https://a.example"]));
      const tab = await open("s1", "https://a.example/file#x");
      await open("s1", "https://a.example/");
      const fakeTab = fake.tabs.get(tab.id);
      assert.ok(fakeTab);
      fakeTab.discarded = true;
      restoreThenLoadNothing(fake);
      const navigated = call("s1", "navigate", { tabId: tab.id, ...params });
      navigated.catch(() => {});
      for (let turn = 0; turn < 50 && fakeTab.discarded; turn += 1) await flush();
      assert.equal(fakeTab.discarded, false, "the load did not start");
      timers.advance(LOAD_TIMEOUT_MS);
      await assert.rejects(navigated, { code: "navigation_timeout" });
    });
  }

  it("fails with navigation_timeout on a load of its fragment URL after the answer", async () => {
    const { fake, timers, call, open, timeOut } = setup();
    const other = await open("s1");
    const otherTab = fake.tabs.get(other.id);
    assert.ok(otherTab);
    otherTab.url = "https://a.example/file#x";
    otherTab.history = ["https://a.example/file#x"];
    otherTab.discarded = true;
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    const shown = await timeOut("s1");
    await first;
    restoreThenLoadNothing(fake);
    const navigated = call("s1", "navigate", { tabId: other.id, url: "https://a.example/file#x" });
    navigated.catch(() => {});
    await flush();
    assert.equal(otherTab.discarded, true, "loaded before the answer");
    shown.deliver({ type: "answer", answer: "once" });
    for (let turn = 0; turn < 50 && otherTab.discarded; turn += 1) await flush();
    assert.equal(otherTab.discarded, false, "the load did not start");
    timers.advance(LOAD_TIMEOUT_MS);
    await assert.rejects(navigated, { code: "navigation_timeout" });
  });
});

describe("a load that ends in a file the file guard refuses", { timeout: 10000 }, () => {
  it("fails tab_open at once, and closes the tab it made", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://a.example");
    const first = await open("s1", "https://a.example/");
    const loads = loadNothing(fake);
    const opening = open("s1", "https://a.example/export");
    opening.catch(() => {});
    const tabId = await begun(loads);
    assert.notEqual(tabId, first.id);
    await assertFileRefused(fake, timers, tabId, opening);
    await flush();
    assert.deepEqual([...fake.tabs.keys()], [first.id]);
  });

  it("fails navigate to a URL at once, and keeps the tab", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const loads = loadNothing(fake);
    const navigated = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/export" });
    navigated.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertFileRefused(fake, timers, tab.id, navigated);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/");
  });

  it("fails navigate reload at once", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const loads: number[] = [];
    // The reloaded address now redirects to the file.
    fake.browser.tabs.reload = async (tabId) => {
      loads.push(tabId);
      fake.emitStatus(tabId, "loading");
    };
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertFileRefused(fake, timers, tab.id, reloaded);
  });

  it("fails navigate reload of a tab Firefox unloaded at once", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/page");
    await open("s1", "https://a.example/");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    fakeTab.discarded = true;
    const loads = loadNothing(fake);
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertFileRefused(fake, timers, tab.id, reloaded);
  });

  it("fails the load in place of a blank that a reload landed on at once", async () => {
    const { fake, timers, call, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    reloadToBlank(fake);
    const loads = loadNothing(fake);
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertFileRefused(fake, timers, tab.id, reloaded);
  });

  it("fails the load of the address a step back did not load again at once", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const loads = loadNothing(context.fake);
    recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const stepped = context.call("s1", "navigate", { tabId: tab.id, action: "back" });
    stepped.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertFileRefused(context.fake, context.timers, tab.id, stepped);
  });

  it("fails the load that follows the user's approval at once", async () => {
    const { fake, timers, call, open, page } = setup();
    const tab = await open("s1");
    const navigated = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/export" });
    navigated.catch(() => {});
    const shown = await page("s1");
    const loads = loadNothing(fake);
    shown.deliver({ type: "answer", answer: "once" });
    assert.equal(await begun(loads), tab.id);
    await assertFileRefused(fake, timers, tab.id, navigated);
  });

  it("lists the file's site in the result of the act it was refused during", async () => {
    const { fake, timers, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const clicked = { ref: "a2", x: 1, y: 2 };
    replyWith(async (type) => {
      if (type === "page_changes") return { state: "current", changes: 0, quietMs: 500 };
      // The click follows a link of the page that redirects to another site's file.
      assert.deepEqual(await fileResponse(fake, tab.id), { cancel: true });
      return { ...clicked, watch: "w.1" };
    });
    const result = call("s1", "click", { tabId: tab.id, ref: "a2" });
    for (let turn = 0; turn < 50 && timers.pending() === 0; turn += 1) await flush();
    await flush();
    timers.advance(MIN_SETTLE_MS);
    assert.deepEqual(await result, {
      ...clicked,
      after: { page: "unchanged", refusedFiles: ["https://c.example"] },
    });
  });
});

describe("a load redirected to a site on the blocklist", { timeout: 10000 }, () => {
  it("fails tab_open at once, and closes the tab it made", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://a.example");
    const first = await open("s1", "https://a.example/");
    const loads = loadNothing(fake);
    const opening = open("s1", "https://a.example/go");
    opening.catch(() => {});
    const tabId = await begun(loads);
    assert.notEqual(tabId, first.id);
    await assertHopCancelled(fake, timers, tabId, opening);
    await flush();
    assert.deepEqual([...fake.tabs.keys()], [first.id]);
  });

  it("fails navigate to a URL at once, and keeps the tab on its page", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const loads = loadNothing(fake);
    const navigated = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/go" });
    navigated.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(fake, timers, tab.id, navigated);
    assert.deepEqual([...fake.tabs.keys()], [tab.id]);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/");
  });

  it("fails navigate reload at once", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const loads: number[] = [];
    fake.browser.tabs.reload = async (tabId) => {
      loads.push(tabId);
      fake.emitStatus(tabId, "loading");
    };
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(fake, timers, tab.id, reloaded);
  });

  it("fails navigate reload at once when Firefox sends its first request to a blocked site", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const loads = reloadNothing(fake);
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertFirstRequestCancelled(fake, timers, tab.id, reloaded);
  });

  it("lets navigate reload go on when its first request is the page itself", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const reload = fake.browser.tabs.reload;
    const answers: unknown[] = [];
    fake.browser.tabs.reload = async (tabId, properties) => {
      const first = { ...pageRequest(tabId, "https://a.example/"), requestId: "reload" };
      answers.push(...fake.emitWebRequest("onBeforeRequest", first));
      return reload(tabId, properties);
    };
    const result = await call("s1", "navigate", { tabId: tab.id, action: "reload" });
    assert.ok(answers.length > 0);
    assert.ok(answers.every((answer) => answer === undefined));
    assert.ok("tab" in result);
    assert.deepEqual(result.tab, tab);
  });

  it("fails navigate reload of a tab Firefox unloaded at once", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/page");
    await open("s1", "https://a.example/");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    fakeTab.discarded = true;
    const loads = loadNothing(fake);
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(fake, timers, tab.id, reloaded);
  });

  it("fails the load in place of a blank that a reload landed on at once", async () => {
    const { fake, timers, call, open, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const tab = await open("s1", "https://a.example/page");
    reloadToBlank(fake);
    const loads = loadNothing(fake);
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(fake, timers, tab.id, reloaded);
  });

  it("fails a step back at once", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const loads: number[] = [];
    context.fake.browser.tabs.goBack = async (tabId) => {
      loads.push(tabId);
      context.fake.emitStatus(tabId, "loading");
    };
    const stepped = context.call("s1", "navigate", { tabId: tab.id, action: "back" });
    stepped.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(context.fake, context.timers, tab.id, stepped);
  });

  it("fails the load of the address a step back did not load again at once", async () => {
    const context = setup();
    const tab = await historyTab(context);
    const loads = loadNothing(context.fake);
    recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const stepped = context.call("s1", "navigate", { tabId: tab.id, action: "back" });
    stepped.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(context.fake, context.timers, tab.id, stepped);
  });

  it("fails the reload of an address with a fragment a step back did not load again at once when its first request goes to a blocked site", async () => {
    const context = setup();
    const tab = await historyTab(context, "https://a.example/a#top");
    const steps = recordSteps(context.fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const loads = reloadNothing(context.fake);
    const stepped = context.call("s1", "navigate", { tabId: tab.id, action: "back" });
    stepped.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    assert.deepEqual(steps, [["back", tab.id]]);
    await assertFirstRequestCancelled(context.fake, context.timers, tab.id, stepped);
  });

  it("fails the load that follows the user's approval at once", async () => {
    const { fake, timers, call, open, page } = setup();
    const tab = await open("s1");
    const navigated = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/go" });
    navigated.catch(() => {});
    const shown = await page("s1");
    const loads = loadNothing(fake);
    shown.deliver({ type: "answer", answer: "once" });
    assert.equal(await begun(loads), tab.id);
    await assertHopCancelled(fake, timers, tab.id, navigated);
  });

  it("lets a redirect to a site that is only unapproved load, and returns that site only", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const update = fake.browser.tabs.update;
    const answers: unknown[] = [];
    fake.browser.tabs.update = async (tabId, properties) => {
      const first = { ...pageRequest(tabId, "https://a.example/go"), requestId: "load" };
      fake.emitWebRequest("onBeforeRequest", first);
      const hop = { ...first, url: "https://c.example/landing?id=7" };
      answers.push(...(await Promise.all(fake.emitWebRequest("onBeforeRequest", hop))));
      return update(tabId, { ...properties, url: hop.url });
    };
    const result = await call("s1", "navigate", { tabId: tab.id, url: "https://a.example/go" });
    assert.ok(answers.length > 0);
    assert.ok(answers.every((answer) => answer === undefined));
    assert.ok("tab" in result);
    assert.deepEqual(result.tab, {
      id: tab.id,
      url: "https://c.example",
      title: "",
      active: true,
    });
  });
});

describe("a load that waits on Firefox's sign-in dialog", { timeout: 10000 }, () => {
  it("fails tab_open on a sign-in, and keeps the tab without selecting it", async () => {
    const { fake, timers, open, grant } = setup();
    await grant("https://a.example");
    const first = await open("s1", "https://a.example/");
    const loads = loadNothing(fake);
    const opening = open("s1", "https://a.example/private");
    opening.catch(() => {});
    const tabId = await begun(loads);
    assert.notEqual(tabId, first.id);
    await assertSignInNeeded(fake, timers, tabId, opening);
    await flush();
    assert.deepEqual([...fake.tabs.keys()], [first.id, tabId]);
    assert.equal(fake.tabs.get(tabId)?.groupId, groupIdOf(fake, first.id));
    assert.deepEqual(selects(fake, tabId), []);
  });

  it("fails tab_open on a sign-in beside the session's open site prompt, and keeps the tab", async () => {
    const { fake, timers, call, access, open, grant, promptOf } = setup();
    await grant("https://a.example");
    const other = await open("s1");
    const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
    void asking.catch(() => {});
    await promptOf("s1");
    const loads = loadNothing(fake);
    const opening = call("s1", "tab_open", { url: "https://a.example/private" });
    opening.catch(() => {});
    const tabId = await begun(loads);
    await assertSignInNeeded(fake, timers, tabId, opening);
    await flush();
    assert.ok(fake.tabs.has(tabId));
    assert.equal(fake.tabs.get(tabId)?.groupId, groupIdOf(fake, other.id));
    assert.deepEqual(selects(fake, tabId), []);
    assert.equal(fake.tabs.get(other.id)?.active, true);
    assert.equal(access.openPrompt("s1")?.tabId, other.id);
  });

  it("fails tab_open of a site allowed meanwhile on a sign-in, and keeps the tab", async () => {
    const { fake, timers, call, grant } = setup();
    const user = fake.openTab({ url: "https://user.example/", active: true });
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      await grant("https://a.example");
      return create(properties);
    };
    const loads = loadNothing(fake);
    const opening = call("s1", "tab_open", { url: "https://a.example/private" });
    opening.catch(() => {});
    const tabId = await begun(loads);
    await assertSignInNeeded(fake, timers, tabId, opening);
    await flush();
    assert.deepEqual([...fake.tabs.keys()], [user.id, tabId]);
    assert.deepEqual(selects(fake, tabId), []);
    assert.equal(fake.tabs.get(user.id)?.active, true);
  });

  it("fails tab_open on a sign-in once the user allowed the site in its tab, and keeps the tab", async () => {
    const { fake, timers, call, page, promptOf } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    const opening = call("s1", "tab_open", { url: "https://a.example/private" });
    opening.catch(() => {});
    const shown = await page("s1");
    const { tabId } = await promptOf("s1");
    const loads = loadNothing(fake);
    shown.deliver({ type: "answer", answer: "once" });
    assert.equal(await begun(loads), tabId);
    await assertSignInNeeded(fake, timers, tabId, opening);
    await flush();
    assert.deepEqual([...fake.tabs.keys()], [user.id, tabId]);
  });

  it("fails navigate to a URL on a sign-in, and keeps the tab", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const loads = loadNothing(fake);
    const navigated = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/private" });
    navigated.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertSignInNeeded(fake, timers, tab.id, navigated);
    assert.ok(fake.tabs.has(tab.id));
  });

  it("fails navigate reload of a tab Firefox unloaded on a sign-in", async () => {
    const { fake, timers, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/private");
    await open("s1", "https://a.example/");
    const fakeTab = fake.tabs.get(tab.id);
    assert.ok(fakeTab);
    fakeTab.discarded = true;
    const loads = loadNothing(fake);
    const reloaded = call("s1", "navigate", { tabId: tab.id, action: "reload" });
    reloaded.catch(() => {});
    assert.equal(await begun(loads), tab.id);
    await assertSignInNeeded(fake, timers, tab.id, reloaded);
  });
});

/**
 * The tab's top-level response is a 401 Basic challenge and nothing commits, and `call` fails saying
 * so once `SIGN_IN_GRACE_MS` passed. No listener that hears it stops the request.
 */
async function assertSignInNeeded(
  fake: FakeBrowser,
  timers: { now(): number; advance(ms: number): void },
  tabId: number,
  call: Promise<unknown>,
): Promise<void> {
  const before = timers.now();
  const answers = fake.emitWebRequest("onHeadersReceived", {
    requestId: "sign-in",
    tabId,
    timeStamp: 1,
    frameId: 0,
    url: "https://a.example/private",
    type: "main_frame",
    statusCode: 401,
    responseHeaders: [
      { name: "Content-Type", value: "text/html; charset=utf-8" },
      { name: "WWW-Authenticate", value: 'Basic realm="a.example"' },
    ],
  });
  assert.deepEqual(answers, [undefined, undefined]);
  timers.advance(SIGN_IN_GRACE_MS);
  await assert.rejects(call, {
    code: "sign_in_needed",
    message: `Tab ${tabId} waits for the user to answer Firefox's sign-in dialog. Firefox shows the page once the user signs in or cancels; read the tab after that.`,
  });
  assert.equal(timers.now(), before + SIGN_IN_GRACE_MS);
}

/** The selects Foxleash made of the tab. */
function selects(fake: FakeBrowser, tabId: number): unknown[] {
  return fake.tabUpdates.filter((update) => update.tabId === tabId && update.active === true);
}

/**
 * Makes each load of a URL into a tab begin and commit nothing, as a load whose answer is a file
 * does; returns the ids of the tabs loaded so far.
 */
function loadNothing(fake: FakeBrowser): number[] {
  const loads: number[] = [];
  const { update, get } = fake.browser.tabs;
  fake.browser.tabs.update = async (tabId, properties) => {
    const tab = fake.tabs.get(tabId);
    if (properties.url === undefined || tab === undefined) return update(tabId, properties);
    loads.push(tabId);
    tab.discarded = false;
    fake.emitBeforeNavigate({ tabId, frameId: 0, url: properties.url });
    fake.emitStatus(tabId, "loading");
    return get(tabId);
  };
  return loads;
}

/** Makes each reload of a tab begin and commit nothing; returns the ids of the tabs reloaded. */
function reloadNothing(fake: FakeBrowser): number[] {
  const loads: number[] = [];
  fake.browser.tabs.reload = async (tabId) => {
    loads.push(tabId);
    fake.emitStatus(tabId, "loading");
  };
  return loads;
}

/** The tab whose load began, once one did. */
async function begun(loads: number[]): Promise<number> {
  for (let turn = 0; turn < 50 && loads.length === 0; turn += 1) await flush();
  const [tabId] = loads;
  assert.ok(tabId !== undefined, "no load began");
  assert.equal(loads.length, 1);
  return tabId;
}

/**
 * A file from a site no test approves answers the tab's top-frame load; the guard's answer. A load
 * wait of the tab also hears it, for a sign-in challenge, and answers nothing.
 */
function fileResponse(fake: FakeBrowser, tabId: number): unknown {
  const answers = fake.emitWebRequest("onHeadersReceived", {
    requestId: "file",
    tabId,
    timeStamp: 1,
    frameId: 0,
    url: "https://c.example/export.csv",
    type: "main_frame",
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "text/csv" },
      { name: "Content-Disposition", value: "attachment" },
    ],
  });
  const [answer, ...others] = answers;
  assert.ok(answers.length >= 1);
  assert.ok(others.every((other) => other === undefined));
  return answer;
}

/** The guard cancels the file, and `call` fails saying so with no time passed. */
async function assertFileRefused(
  fake: FakeBrowser,
  timers: { now(): number },
  tabId: number,
  call: Promise<unknown>,
): Promise<void> {
  const before = timers.now();
  assert.deepEqual(await fileResponse(fake, tabId), { cancel: true });
  await assert.rejects(call, {
    code: "file_refused",
    message: `Tab ${tabId}'s load ended in a file from https://c.example, a site this session may not act on. Foxleash stopped it; nothing was saved. To get the file, the site must be approved first: tab_open or navigate to it asks the user, unless it is on the blocklist.`,
  });
  assert.equal(timers.now(), before);
}

/**
 * The tab's top-level request, then a redirect hop of it to a blocklisted site: the hop is
 * cancelled, and `call` fails saying so, naming the site only, with no time passed.
 */
async function assertHopCancelled(
  fake: FakeBrowser,
  timers: { now(): number },
  tabId: number,
  call: Promise<unknown>,
): Promise<void> {
  const before = timers.now();
  const first = { ...pageRequest(tabId, "https://a.example/go"), requestId: "load" };
  assert.deepEqual(fake.emitWebRequest("onBeforeRequest", first).filter(Boolean), []);
  const answers = fake.emitWebRequest("onBeforeRequest", {
    ...first,
    url: "https://www.paypal.com/signin?return=1",
  });
  // A watch of an earlier load of the tab that saw no request, as no load of the fake sends one,
  // judges it too.
  const judged = await Promise.all(answers.filter(Boolean));
  assert.ok(judged.length > 0);
  assert.ok(judged.every((answer) => isDeepStrictEqual(answer, { cancel: true })));
  await assert.rejects(call, {
    code: "site_blocked",
    message: `Tab ${tabId}'s load was redirected to https://www.paypal.com, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`,
  });
  assert.equal(timers.now(), before);
}

/**
 * The tab's top-level request goes to a blocklisted site off the page's site, as Firefox sends a
 * reload after a cancelled hop: it is cancelled, and `call` fails as for a hop, with no time passed.
 */
async function assertFirstRequestCancelled(
  fake: FakeBrowser,
  timers: { now(): number },
  tabId: number,
  call: Promise<unknown>,
): Promise<void> {
  const before = timers.now();
  const first = {
    ...pageRequest(tabId, "https://www.paypal.com/signin?return=1"),
    requestId: "load",
  };
  const judged = await Promise.all(fake.emitWebRequest("onBeforeRequest", first).filter(Boolean));
  assert.ok(judged.length > 0);
  assert.ok(judged.every((answer) => isDeepStrictEqual(answer, { cancel: true })));
  await assert.rejects(call, {
    code: "site_blocked",
    message: `Tab ${tabId}'s load was redirected to https://www.paypal.com, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`,
  });
  assert.equal(timers.now(), before);
}

// Hosts the site prompt refuses to show as they are; request_sites refuses them too.
const NOT_PLAIN_URLS = [
  "https://accounts.google.com(verified-by-foxleash).evil.example/",
  "https://accounts.google.com,evil.example/",
  `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}/`,
];
const NOT_PLAIN =
  "Foxleash asks only about a site whose host is a domain name or an IP address, at most 253 characters long.";

describe("approval", { timeout: 10000 }, () => {
  it("creates the prompt's tab unloaded on the prompt, groups it, then loads the prompt and the page in its place", async () => {
    const { fake, call, page, promptOf } = setup();
    const creates = recordCreates(fake);
    const groupsAtUpdate: unknown[] = [];
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      groupsAtUpdate.push(fake.tabs.get(tabId)?.groupId);
      return update(tabId, properties);
    };
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    await flush();
    const { tabId } = await promptOf("s1");
    const tab = fake.tabs.get(tabId);
    assert.ok(tab);
    const promptUrl = tab.url;
    assert.match(promptUrl, PROMPT_URL);
    assert.deepEqual(creates, [{ url: promptUrl, active: false, discarded: true }]);
    assert.deepEqual(fake.tabUpdates, [{ tabId, url: promptUrl, active: true, loadReplace: true }]);
    assert.deepEqual(groupsAtUpdate, [groupIdOf(fake, tabId)]);
    assert.equal(tab.active, true);
    assert.equal(tab.discarded, false);
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
    shown.deliver({ type: "answer", answer: "once" });
    assert.deepEqual(await opened, {
      tab: {
        id: tabId,
        url: "https://a.example/x",
        title: "Title of https://a.example/x",
        active: true,
      },
    });
    assert.deepEqual(fake.tabUpdates.slice(1), [
      { tabId, url: "https://a.example/x", loadReplace: true },
    ]);
    assert.deepEqual(tab.history, ["https://a.example/x"]);
  });

  it("refuses tab_open of a site whose host the prompt cannot show as it is, creating no tab", async () => {
    const { fake, access, call } = setup();
    const creates = recordCreates(fake);
    for (const url of NOT_PLAIN_URLS) {
      await assert.rejects(
        call("s1", "tab_open", { url }),
        { code: "invalid_url", message: NOT_PLAIN },
        url,
      );
    }
    assert.deepEqual(creates, []);
    assert.deepEqual(fake.tabUpdates, []);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("refuses navigate to such a site by URL, path or reload, leaving the tab as it was", async () => {
    const { fake, access, call, open, grant } = setup();
    const site = "https://accounts.google.com(verified-by-foxleash).evil.example";
    await grant("https://a.example");
    await grant(site);
    const tab = await open("s1", "https://a.example/");
    const other = await open("s1", `${site}/x`);
    await revokeSite(fake.browser, site);
    const updates = fake.tabUpdates.length;
    for (const url of NOT_PLAIN_URLS) {
      await assert.rejects(
        call("s1", "navigate", { tabId: tab.id, url }),
        { code: "invalid_url", message: NOT_PLAIN },
        url,
      );
    }
    for (const params of [{ url: "/y" }, { action: "reload" }]) {
      await assert.rejects(
        call("s1", "navigate", { tabId: other.id, ...params }),
        { code: "invalid_url", message: NOT_PLAIN },
        JSON.stringify(params),
      );
    }
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
    assert.equal(fake.tabs.get(tab.id)?.url, "https://a.example/");
    assert.equal(fake.tabs.get(other.id)?.url, `${site}/x`);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("refuses navigate to such a site on the tab of a prompt the user answered, opening no prompt", async () => {
    const { fake, access, call, open, grant, timeOut } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const first = assert.rejects(
      call("s1", "navigate", { tabId: tab.id, url: "https://b.example/x" }),
      { code: "approval_timeout" },
    );
    const shown = await timeOut("s1");
    await first;
    shown.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(access.openPrompt("s1"), undefined);
    const promptUrl = fake.tabs.get(tab.id)?.url;
    assert.match(promptUrl ?? "", PROMPT_URL);
    const updates = fake.tabUpdates.length;
    for (const url of NOT_PLAIN_URLS) {
      const refused = assert.rejects(
        call("s1", "navigate", { tabId: tab.id, url }),
        { code: "invalid_url", message: NOT_PLAIN },
        url,
      );
      await flush();
      // Checked before awaiting the call, so a new prompt fails the test instead of hanging it.
      assert.equal(access.openPrompt("s1"), undefined, url);
      await refused;
    }
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
    assert.equal(fake.tabs.get(tab.id)?.url, promptUrl);
  });

  it("does not select the prompt's tab again when the user selected another tab after answering", async () => {
    const { fake, call, page, promptOf } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    const { tabId } = await promptOf("s1");
    shown.deliver({ type: "answer", answer: "once" });
    for (const tab of fake.tabs.values()) tab.active = tab.id === user.id;
    const result = await opened;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/x");
    assert.equal(result.tab.active, false);
    assert.deepEqual(fake.tabUpdates.at(-1), {
      tabId,
      url: "https://a.example/x",
      loadReplace: true,
    });
    assert.equal(fake.tabs.get(user.id)?.active, true);
  });

  it("removes the prompt's tab and loads nothing in it when the request ends before a prompt", async () => {
    const cases: [string, (context: ReturnType<typeof setup>) => Promise<unknown>, RegExp][] = [
      [
        "site_refused",
        async ({ sessions }) => {
          sessions.set("s1", {
            allowed: new Set(),
            refused: new Set(["https://a.example"]),
            closed: 0,
          });
        },
        /did not allow Foxleash on https:\/\/a\.example/,
      ],
      [
        "site_blocked",
        ({ fake }) => fake.browser.storage.local.set({ blocklist: ["a.example"] }),
        /blocklist/,
      ],
      [
        "site_refused",
        async ({ sessions }) => {
          sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 3 });
        },
        /asks no more in this session/,
      ],
    ];
    for (const [code, change, message] of cases) {
      const context = setup();
      const { fake, call, access } = context;
      const user = fake.openTab({ url: "https://user.example/" });
      const create = fake.browser.tabs.create;
      fake.browser.tabs.create = async (properties) => {
        await change(context);
        return create(properties);
      };
      await assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
        code,
        message,
      });
      assert.deepEqual([...fake.tabs.keys()], [user.id], code);
      assert.deepEqual(fake.tabUpdates, [], code);
      assert.equal(access.openPrompt("s1"), undefined, code);
    }
  });

  it("loads the page in the unloaded tab, then selects it, when the site was allowed meanwhile", async () => {
    const { fake, call, access, grant } = setup();
    const user = fake.openTab({ url: "https://user.example/", active: true });
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      await grant("https://a.example");
      return create(properties);
    };
    const result = await call("s1", "tab_open", { url: "https://a.example/x" });
    assert.ok("tab" in result);
    const tabId = result.tab.id;
    assert.deepEqual(result.tab, {
      id: tabId,
      url: "https://a.example/x",
      title: "Title of https://a.example/x",
      active: true,
    });
    assert.deepEqual(fake.tabUpdates, [
      { tabId, url: "https://a.example/x", loadReplace: true },
      { tabId, active: true },
    ]);
    assert.deepEqual(fake.tabs.get(tabId)?.history, ["https://a.example/x"]);
    assert.equal(fake.tabs.get(user.id)?.active, false);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("removes the tab of a site allowed meanwhile when its page cannot be loaded", async () => {
    const { fake, call, access, grant } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      await grant("https://a.example");
      return create(properties);
    };
    const ask = access.ask;
    access.ask = async (session, url, tabId, options) => {
      const approval = await ask(session, url, tabId, options);
      fake.ungroup(tabId);
      return approval;
    };
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    await assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "tab_not_in_group",
    });
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
  });

  it("keeps the prompt's tab when a parallel navigate showed its own prompt in it", async () => {
    for (const allowedMeanwhile of [false, true]) {
      const { fake, call, access, grant, sessions, promptOf, page } = setup();
      // Not the window's last tab, which is never removed.
      fake.openTab({ url: "https://user.example/" });
      if (allowedMeanwhile) {
        const create = fake.browser.tabs.create;
        fake.browser.tabs.create = async (properties) => {
          await grant("https://a.example");
          return create(properties);
        };
      }
      let navigating: ReturnType<typeof call> | undefined;
      const showOther = async (tabId: number) => {
        navigating = call("s1", "navigate", { tabId, url: "https://b.example/y" });
        await promptOf("s1");
      };
      const ask = access.ask;
      access.ask = async (session, url, tabId, options) => {
        if (url !== "https://a.example/x") return ask(session, url, tabId, options);
        if (!allowedMeanwhile) await showOther(tabId);
        const approval = await ask(session, url, tabId, options);
        if (allowedMeanwhile) await showOther(tabId);
        return approval;
      };
      const label = `allowed meanwhile: ${allowedMeanwhile}`;
      await assert.rejects(
        call("s1", "tab_open", { url: "https://a.example/x" }),
        { code: "approval_pending" },
        label,
      );
      const prompt = access.openPrompt("s1");
      assert.ok(prompt, label);
      assert.equal(prompt.site, "https://b.example", label);
      assert.ok(fake.tabs.has(prompt.tabId), label);
      assert.equal(sessions.get("s1")?.closed ?? 0, 0, label);
      (await page("s1")).deliver({ type: "answer", answer: "once" });
      const result = await navigating;
      assert.ok(result !== undefined && "tab" in result, label);
      assert.deepEqual(result.tab, {
        id: prompt.tabId,
        url: "https://b.example/y",
        title: "Title of https://b.example/y",
        active: true,
      });
    }
  });

  it("leaves a tab it opens unselected while the session's site prompt is open", async () => {
    for (const url of ["https://a.example/x", undefined]) {
      const { fake, call, open, grant, promptOf } = setup();
      await grant("https://a.example");
      const other = await open("s1");
      const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
      void asking.catch(() => {});
      await promptOf("s1");
      const label = `url: ${url}`;
      const result = await call("s1", "tab_open", url === undefined ? {} : { url });
      assert.ok("tab" in result, label);
      assert.equal(result.tab.url, url ?? "about:blank", label);
      assert.equal(result.tab.active, false, label);
      assert.equal(fake.tabs.get(result.tab.id)?.active, false, label);
      assert.equal(fake.tabs.get(other.id)?.active, true, label);
      assert.equal(fake.tabs.get(result.tab.id)?.groupId, groupIdOf(fake, other.id), label);
    }
  });

  it("leaves a blank tab unselected when a prompt was shown while the tab was being created", async () => {
    const { fake, call, access, open, promptOf } = setup();
    const other = await open("s1");
    let asking: ReturnType<typeof call> | undefined;
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      if (properties.url === "about:blank" && asking === undefined) {
        asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
        void asking.catch(() => {});
        await promptOf("s1");
      }
      return create(properties);
    };
    const result = await call("s1", "tab_open", {});
    assert.ok("tab" in result);
    assert.equal(result.tab.active, false);
    assert.equal(fake.tabs.get(result.tab.id)?.active, false);
    assert.equal(fake.tabs.get(other.id)?.active, true);
    assert.equal(access.openPrompt("s1")?.tabId, other.id);
  });

  it("leaves a tab it opens unselected while the session's recipe page is open", async () => {
    const { fake, call } = setup();
    const proposed = await call("s1", "recipe_propose", {
      name: "Receipt",
      description: "Download the latest receipt.",
      sites: ["https://shop.example"],
      steps: "Open https://shop.example/orders.",
    });
    assert.ok("tabId" in proposed);
    const result = await call("s1", "tab_open", {});
    assert.ok("tab" in result);
    assert.equal(result.tab.active, false);
    assert.equal(fake.tabs.get(result.tab.id)?.active, false);
    assert.equal(fake.tabs.get(proposed.tabId)?.active, true);
  });

  it("leaves a tab of a site allowed meanwhile unselected when a prompt opened in another tab", async () => {
    const { fake, call, access, open, grant, promptOf } = setup();
    const other = await open("s1");
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      await grant("https://a.example");
      return create(properties);
    };
    let asking: ReturnType<typeof call> | undefined;
    const ask = access.ask;
    access.ask = async (session, url, tabId, options) => {
      const approval = await ask(session, url, tabId, options);
      if (url === "https://a.example/x") {
        asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
        void asking.catch(() => {});
        await promptOf("s1");
      }
      return approval;
    };
    const result = await call("s1", "tab_open", { url: "https://a.example/x" });
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/x");
    assert.equal(result.tab.active, false);
    assert.equal(fake.tabs.get(result.tab.id)?.active, false);
    assert.equal(fake.tabs.get(other.id)?.active, true);
    assert.equal(access.openPrompt("s1")?.tabId, other.id);
  });

  it("loads nothing in a tab that left the session's group while the answer's load read the settings", async () => {
    const { fake, call, page, promptOf } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    const shown = await page("s1");
    const { tabId } = await promptOf("s1");
    const get = fake.browser.storage.local.get;
    fake.browser.storage.local.get = async (keys) => {
      const stored = await get(keys);
      fake.ungroup(tabId);
      return stored;
    };
    shown.deliver({ type: "answer", answer: "once" });
    await assert.rejects(opened, { code: "tab_not_in_group" });
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
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
    assert.deepEqual(fake.tabs.get(tab.id)?.history, ["https://a.example/", "https://b.example/y"]);
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

  it("refuses the prompt of a tab_open that was running when its session ended", async () => {
    const { fake, call, access, sessions, promptOf } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const opening = assert.rejects(call("s1", "tab_open", { url: "https://a.example/page" }), {
      code: "session_ended",
      message: "The session ended before Foxleash could finish the request.",
    });
    access.endSession("s1");
    await flush();
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(promptLoads(fake, 0), 0);
    await opening;
    assert.equal(sessions.get("s1"), undefined);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
    assert.deepEqual(await access.check("s1", "https://a.example/other"), { decision: "ask" });
    // The session reconnecting with the id is asked.
    const again = call("s1", "tab_open", { url: "https://a.example/page" });
    assert.equal((await promptOf("s1")).site, "https://a.example");
    access.endSession("s1");
    await assert.rejects(again, { code: "approval_closed" });
  });

  it("refuses the prompt of a navigate that was running when its session ended", async () => {
    const { fake, call, access, sessions, open, promptOf } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await open("s1", "https://b.example/");
    const updates = fake.tabUpdates.length;
    const navigating = assert.rejects(
      call("s1", "navigate", { tabId: tab.id, url: "https://a.example/" }),
      {
        code: "approval_closed",
        message: "The session ended before Foxleash could ask whether to allow https://a.example.",
      },
    );
    access.endSession("s1");
    await flush();
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(promptLoads(fake, updates), 0);
    await navigating;
    assert.equal(fake.tabs.get(tab.id)?.url, "https://b.example/");
    assert.equal(fake.tabUpdates.length, updates);
    // The session reconnecting with the id is asked.
    const again = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/" });
    assert.equal((await promptOf("s1")).site, "https://a.example");
    access.endSession("s1");
    await assert.rejects(again, { code: "approval_closed" });
  });

  it("refuses the prompt of a navigate on an answered prompt that was running when its session ended", async () => {
    const { fake, call, access, page } = setup();
    const opened = call("s1", "tab_open", { url: "https://a.example/x" });
    (await page("s1")).deliver({ type: "answer", answer: "no" });
    await assert.rejects(opened, { code: "site_refused" });
    const [tab] = fake.tabs.values();
    assert.ok(tab);
    const shown = tab.url;
    assert.match(shown, PROMPT_URL);
    const updates = fake.tabUpdates.length;
    const navigating = assert.rejects(
      call("s1", "navigate", { tabId: tab.id, url: "https://b.example/" }),
      {
        code: "approval_closed",
        message: "The session ended before Foxleash could ask whether to allow https://b.example.",
      },
    );
    access.endSession("s1");
    await flush();
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(promptLoads(fake, updates), 0);
    await navigating;
    assert.equal(fake.tabs.get(tab.id)?.url, shown);
    assert.equal(fake.tabUpdates.length, updates);
  });

  it("refuses to join, from a tab_open running when its session ended, the reconnected session's prompt", async () => {
    const { fake, call, access, timeOut } = setup();
    fake.openTab({ url: "https://user.example/" });
    const check = access.check;
    // What the reconnected session left once its prompt timed out.
    let reconnected:
      | Promise<{ prompt: OpenPrompt | undefined; tabs: number; updates: number }>
      | undefined;
    let first = true;
    access.check = async (session, url) => {
      if (first) {
        first = false;
        access.endSession("s1");
        reconnected = (async () => {
          const timedOut = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
            code: "approval_timeout",
          });
          await timeOut("s1");
          await timedOut;
          return {
            prompt: access.openPrompt("s1"),
            tabs: fake.tabs.size,
            updates: fake.tabUpdates.length,
          };
        })();
        await reconnected;
      }
      return check(session, url);
    };
    const opening = assert.rejects(call("s1", "tab_open", { url: "https://a.example/page" }), {
      code: "approval_closed",
      message: "The session ended before Foxleash could ask whether to allow https://a.example.",
    });
    await flush();
    const before = await reconnected;
    assert.ok(before);
    assert.equal(before.prompt?.waiting, false);
    await flush();
    assert.deepEqual(access.openPrompt("s1"), before.prompt);
    await opening;
    assert.deepEqual(access.openPrompt("s1"), before.prompt);
    assert.equal(fake.tabs.size, before.tabs);
    assert.equal(fake.tabUpdates.length, before.updates);
  });

  it("refuses to join, from a navigate running when its session ended, the reconnected session's prompt in its tab", async () => {
    const { fake, call, access, sessions, open, timeOut } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await open("s1", "https://b.example/");
    const get = fake.browser.tabs.get;
    // What the reconnected session left once its prompt timed out.
    let reconnected:
      | Promise<{ prompt: OpenPrompt | undefined; tabs: number; updates: number }>
      | undefined;
    let first = true;
    fake.browser.tabs.get = async (tabId) => {
      if (first) {
        first = false;
        access.endSession("s1");
        reconnected = (async () => {
          const timedOut = assert.rejects(
            call("s1", "navigate", { tabId: tab.id, url: "https://a.example/x" }),
            { code: "approval_timeout" },
          );
          await timeOut("s1");
          await timedOut;
          return {
            prompt: access.openPrompt("s1"),
            tabs: fake.tabs.size,
            updates: fake.tabUpdates.length,
          };
        })();
        await reconnected;
      }
      return get(tabId);
    };
    const navigating = assert.rejects(
      call("s1", "navigate", { tabId: tab.id, url: "https://a.example/page" }),
      {
        code: "approval_closed",
        message: "The session ended before Foxleash could ask whether to allow https://a.example.",
      },
    );
    await flush();
    const before = await reconnected;
    assert.ok(before);
    assert.equal(before.prompt?.tabId, tab.id);
    assert.equal(before.prompt?.waiting, false);
    const shown = fake.tabs.get(tab.id)?.url;
    assert.match(shown ?? "", PROMPT_URL);
    await flush();
    assert.deepEqual(access.openPrompt("s1"), before.prompt);
    await navigating;
    assert.deepEqual(access.openPrompt("s1"), before.prompt);
    assert.equal(fake.tabs.get(tab.id)?.url, shown);
    assert.equal(fake.tabUpdates.length, before.updates);
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
    assert.deepEqual(fake.tabs.get(tabId)?.history, ["https://a.example/x"]);
  });

  it("opens the page with tab_open again after a prompt answered after its call timed out, with its tab closed or left open", async () => {
    for (const closed of [true, false]) {
      const { fake, access, call, timeOut, promptOf } = setup();
      const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
        code: "approval_timeout",
      });
      const shown = await timeOut("s1");
      await first;
      const { tabId } = await promptOf("s1");
      const promptUrl = fake.tabs.get(tabId)?.url;
      assert.ok(promptUrl?.includes("approve.html"), `prompt tab url: ${promptUrl}`);
      shown.deliver({ type: "answer", answer: "once" });
      await flush();
      if (closed) fake.removeTab(tabId);
      const retry = call("s1", "tab_open", { url: "https://a.example/x" });
      await flush();
      // Checked before awaiting the call, so a second prompt fails the test instead of hanging it.
      assert.equal(access.openPrompt("s1"), undefined, `closed: ${closed}`);
      const result = await retry;
      assert.ok("tab" in result);
      assert.notEqual(result.tab.id, tabId);
      assert.equal(result.tab.url, "https://a.example/x");
      assert.equal(loadsOf(fake, "https://a.example/x"), 1);
      if (closed) assert.equal(fake.tabs.has(tabId), false);
      else assert.equal(fake.tabs.get(tabId)?.url, promptUrl);
    }
  });

  it("opens the page with tab_open after the blank tab of a navigate's prompt answered late is closed", async () => {
    const { fake, access, call, open, timeOut, promptOf } = setup();
    const tab = await open("s1");
    const params = { tabId: tab.id, url: "https://a.example/x" };
    const first = assert.rejects(call("s1", "navigate", params), { code: "approval_timeout" });
    const shown = await timeOut("s1");
    await first;
    assert.equal((await promptOf("s1")).tabId, tab.id);
    shown.deliver({ type: "answer", answer: "once" });
    await flush();
    fake.removeTab(tab.id);
    await assert.rejects(call("s1", "navigate", params), { code: "tab_not_found" });
    const retry = call("s1", "tab_open", { url: "https://a.example/x" });
    await flush();
    // Checked before awaiting the call, so a second prompt fails the test instead of hanging it.
    assert.equal(access.openPrompt("s1"), undefined);
    const result = await retry;
    assert.ok("tab" in result);
    assert.notEqual(result.tab.id, tab.id);
    assert.equal(result.tab.url, "https://a.example/x");
    assert.equal(loadsOf(fake, "https://a.example/x"), 1);
  });

  it("loads the same navigate in place of a prompt answered after its call timed out", async () => {
    const { fake, call, open, grant, timeOut } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const params = { tabId: tab.id, url: "https://b.example/x" };
    const first = assert.rejects(call("s1", "navigate", params), { code: "approval_timeout" });
    const shown = await timeOut("s1");
    await first;
    shown.deliver({ type: "answer", answer: "once" });
    await flush();
    const result = await call("s1", "navigate", params);
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://b.example/x");
    assert.deepEqual(fake.tabUpdates.at(-1), { ...params, loadReplace: true });
    assert.deepEqual(fake.tabs.get(tab.id)?.history, ["https://a.example/", "https://b.example/x"]);
  });

  it("takes the same navigate to a path again after its call timed out, before or after the answer", async () => {
    for (const late of [false, true]) {
      const { fake, call, open, grant, timeOut } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      await revokeSite(fake.browser, "https://a.example");
      const params = { tabId: tab.id, url: "/x" };
      const first = assert.rejects(call("s1", "navigate", params), { code: "approval_timeout" });
      const shown = await timeOut("s1");
      await first;
      if (late) {
        shown.deliver({ type: "answer", answer: "once" });
        await flush();
      }
      const retry = call("s1", "navigate", params);
      await flush();
      if (!late) {
        assert.equal(loadsOf(fake, "https://a.example/x"), 0);
        await assert.rejects(call("s1", "navigate", params), { code: "approval_pending" });
        shown.deliver({ type: "answer", answer: "once" });
      }
      const result = await retry;
      assert.ok("tab" in result);
      assert.equal(result.tab.url, "https://a.example/x", `late: ${late}`);
      assert.deepEqual(fake.tabs.get(tab.id)?.history, [
        "https://a.example/",
        "https://a.example/x",
      ]);
    }
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
      message: `Foxleash is waiting for the user to answer in tab ${tab.id} whether to allow https://b.example. Try again after the user has answered.`,
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
      message: `Foxleash is waiting for the user to answer in tab ${tab.id} whether to allow https://b.example. Try again after the user has answered.`,
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
    const message = `Foxleash is waiting for the user to answer in tab ${tabId} whether to allow https://a.example. Try again after the user has answered.`;
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
      assert.deepEqual(
        reload.mock.calls.map((made) => made.arguments),
        moved ? [] : [[other.id, { bypassCache: true }]],
      );
      assert.equal(loadsOf(fake, "https://a.example/page"), moved ? 1 : 0);
      reload.mock.restore();
    }
  });

  it("loads the page after the answer in place of an about:blank its reload landed on", async () => {
    const { fake, call, open, timeOut } = setup();
    const other = await open("s1");
    const otherTab = fake.tabs.get(other.id);
    assert.ok(otherTab);
    otherTab.url = "https://a.example/page";
    otherTab.history = ["https://a.example/page"];
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    const shown = await timeOut("s1");
    await first;
    const reloads = reloadToBlank(fake);
    const updates = fake.tabUpdates.length;
    const reloaded = call("s1", "navigate", { tabId: other.id, action: "reload" });
    await flush();
    shown.deliver({ type: "answer", answer: "once" });
    const result = await reloaded;
    assert.ok("tab" in result);
    // The prompt's tab is the active one.
    assert.deepEqual(result.tab, {
      id: other.id,
      url: "https://a.example/page",
      title: "Title of https://a.example/page",
      active: false,
    });
    assert.deepEqual(reloads, [[other.id, { bypassCache: true }]]);
    assert.deepEqual(fake.tabUpdates.slice(updates), [
      { tabId: other.id, url: "https://a.example/page", loadReplace: true },
    ]);
    assert.deepEqual(otherTab.history, ["https://a.example/page"]);
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
        "Foxleash does not act on https://a.example: it is on Foxleash's blocklist, which by default lists common financial and health sites.",
    });
    assert.equal(loadsOf(fake, "https://a.example/x"), 0);
  });

  it("removes the new tab when the prompt cannot be shown in it", async () => {
    const { fake, call } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
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
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
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

  it("keeps a tab in the window when tab_close runs while tab_open removes the tab it could not show the prompt in", async () => {
    const { fake, call, open } = setup();
    const first = await open("s1");
    const refusal = new Error("Invalid tab ID");
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      if (properties.active === true) throw refusal;
      return update(tabId, properties);
    };
    const asked = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      if (!tabIds.includes(first.id)) {
        asked.resolve();
        await held.promise;
      }
      return remove(tabIds);
    };
    const opening = call("s1", "tab_open", { url: "https://a.example/" });
    await asked.promise;
    const closed = await call("s1", "tab_close", { tabId: first.id }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    held.resolve();
    await assert.rejects(opening, (error: unknown) => error === refusal);
    assert.deepEqual([...fake.tabs.keys()], [first.id]);
    assert.ok(closed instanceof ToolError);
    assert.equal(closed.code, "last_tab");
  });

  it("still fails with the prompt's error when the new tab is gone before its removal", async () => {
    const { fake, call } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    const refusal = new Error("Invalid tab ID");
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      if (properties.active === true) {
        fake.removeTab(tabId);
        throw refusal;
      }
      return update(tabId, properties);
    };
    await assert.rejects(
      call("s1", "tab_open", { url: "https://a.example/" }),
      (error: unknown) => error === refusal,
    );
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
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
      message: `Foxleash is waiting for the user to answer in tab ${prompt.tabId} whether to allow https://a.example. Try again after the user has answered.`,
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
        message: `Foxleash acts only on http and https pages, and tab ${tab.id} shows another kind of page.`,
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
      message: `Foxleash is not allowed on https://a.example in this session; call navigate with tab ${tab.id} and action reload to ask the user.`,
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
        "Foxleash does not act on https://www.paypal.com: it is on Foxleash's blocklist, which by default lists common financial and health sites.",
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
      message: `Foxleash could not run its input probe in tab ${tab.id}.`,
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

describe("tab_select", { timeout: 10000 }, () => {
  it("makes a tab of the group the active one of its window, without focusing the window", async () => {
    const { fake, call, open } = setup();
    const first = await open("s1");
    const second = await open("s1");
    assert.equal(fake.tabs.get(second.id)?.active, true);
    assert.deepEqual(await call("s1", "tab_select", { tabId: first.id }), {
      tab: { ...first, active: true },
    });
    assert.equal(fake.tabs.get(first.id)?.active, true);
    assert.equal(fake.tabs.get(second.id)?.active, false);
    assert.deepEqual(fake.windowUpdates, []);
  });

  it("refuses a tab outside the group, another session's tab, a missing tab and a bad id", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const user = fake.openTab({ url: "https://user.example/" });
    const other = await open("s2");
    for (const tabId of [user.id, other.id]) {
      await assert.rejects(call("s1", "tab_select", { tabId }), {
        code: "tab_not_in_group",
        message: `Tab ${tabId} is not in this session's tab group; open a tab with tab_open first.`,
      });
    }
    await assert.rejects(call("s1", "tab_select", { tabId: 99 }), {
      code: "tab_not_found",
      message: "Tab 99 does not exist.",
    });
    for (const tabId of [undefined, -1, 1.5, "1"]) {
      await assert.rejects(call("s1", "tab_select", tabId === undefined ? {} : { tabId }), {
        code: "invalid_params",
        message: "tab_select needs a tab id that is a whole number of 0 or more.",
      });
    }
    assert.equal(fake.tabs.get(user.id)?.active, false);
    assert.equal(fake.tabs.get(other.id)?.active, true);
    assert.deepEqual(fake.windowUpdates, []);
  });

  it("refuses another tab while the session's site prompt is open, but selects the prompt's", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    await grant("https://a.example");
    const approved = await open("s1", "https://a.example/");
    const other = await open("s1");
    const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
    void asking.catch(() => {});
    const prompt = await promptOf("s1");
    assert.equal(prompt.tabId, other.id);
    await assert.rejects(call("s1", "tab_select", { tabId: approved.id }), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${other.id} whether to allow https://b.example. Try again after the user has answered.`,
    });
    assert.equal(fake.tabs.get(other.id)?.active, true);
    assert.equal(fake.tabs.get(approved.id)?.active, false);
    const selected = await call("s1", "tab_select", { tabId: other.id });
    assert.ok("tab" in selected);
    assert.equal(selected.tab.active, true);
  });

  it("refuses a tab when the prompt was shown while the tab's group was being read", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    await grant("https://a.example");
    const approved = await open("s1", "https://a.example/");
    const other = await open("s1");
    const get = fake.browser.tabGroups.get;
    let armed = true;
    fake.browser.tabGroups.get = async (groupId) => {
      if (armed) {
        armed = false;
        const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
        void asking.catch(() => {});
        await promptOf("s1");
      }
      return get(groupId);
    };
    await assert.rejects(call("s1", "tab_select", { tabId: approved.id }), {
      code: "approval_pending",
    });
    assert.equal(armed, false);
    assert.equal(fake.tabs.get(other.id)?.active, true);
    assert.equal(fake.tabs.get(approved.id)?.active, false);
  });

  it("refuses another tab while the session's recipe page is open, but selects the page's", async () => {
    const { fake, call, open } = setup();
    const tab = await open("s1");
    const proposed = await call("s1", "recipe_propose", {
      name: "Receipt",
      description: "Download the latest receipt.",
      sites: ["https://shop.example"],
      steps: "Open https://shop.example/orders.",
    });
    assert.ok("tabId" in proposed);
    const pageTab = proposed.tabId;
    assert.equal(fake.tabs.get(pageTab)?.active, true);
    await assert.rejects(call("s1", "tab_select", { tabId: tab.id }), {
      code: "recipe_prompt_open",
      message: `Foxleash is still asking the user in tab ${pageTab} whether to save a recipe. Try again after the user has answered there.`,
    });
    assert.equal(fake.tabs.get(pageTab)?.active, true);
    assert.equal(fake.tabs.get(tab.id)?.active, false);
    const selected = await call("s1", "tab_select", { tabId: pageTab });
    assert.ok("tab" in selected);
    assert.equal(fake.tabs.get(pageTab)?.active, true);
  });

  it("selects another tab again once the prompt is answered or its tab closed", async () => {
    for (const ending of ["answered", "closed"]) {
      const { fake, call, open, grant, page, promptOf } = setup();
      await grant("https://a.example");
      const approved = await open("s1", "https://a.example/");
      const other = await open("s1");
      const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
      void asking.catch(() => {});
      await promptOf("s1");
      if (ending === "answered") (await page("s1")).deliver({ type: "answer", answer: "once" });
      else fake.removeTab(other.id);
      await asking.catch(() => {});
      const selected = await call("s1", "tab_select", { tabId: approved.id });
      assert.ok("tab" in selected, ending);
      assert.equal(selected.tab.active, true, ending);
      assert.equal(fake.tabs.get(approved.id)?.active, true, ending);
    }
  });
});

describe("tab_close", { timeout: 10000 }, () => {
  it("closes a tab of the group and returns the tabs left in it", async () => {
    const { fake, call, open } = setup();
    const first = await open("s1");
    const second = await open("s1");
    assert.deepEqual(await call("s1", "tab_close", { tabId: first.id }), { tabs: [second] });
    assert.equal(fake.tabs.has(first.id), false);
  });

  it("refuses a tab outside the group, another session's tab and a bad id", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const user = fake.openTab({ url: "https://user.example/" });
    const other = await open("s2");
    for (const tabId of [user.id, other.id]) {
      await rejectsWith(call("s1", "tab_close", { tabId }), "tab_not_in_group");
      assert.equal(fake.tabs.has(tabId), true);
    }
    await assert.rejects(call("s1", "tab_close", { tabId: -1 }), {
      code: "invalid_params",
      message: "tab_close needs a tab id that is a whole number of 0 or more.",
    });
  });

  it("refuses a tab that left the group before its close ran", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const tab = await open("s1");
    const get = fake.browser.tabs.get;
    let reads = 0;
    fake.browser.tabs.get = async (tabId) => {
      reads += 1;
      // The user drags the tab out of the group after the handler first read it.
      if (tabId === tab.id && reads === 2) fake.ungroup(tab.id);
      return get(tabId);
    };
    await rejectsWith(call("s1", "tab_close", { tabId: tab.id }), "tab_not_in_group");
    assert.equal(reads, 2);
    assert.equal(fake.tabs.has(tab.id), true);
  });

  it("refuses the tab where the session's prompt asks the user", async () => {
    const { fake, call, open, timeOut, promptOf } = setup();
    await open("s1");
    const first = assert.rejects(call("s1", "tab_open", { url: "https://a.example/x" }), {
      code: "approval_timeout",
    });
    await timeOut("s1");
    await first;
    const { tabId } = await promptOf("s1");
    await assert.rejects(call("s1", "tab_close", { tabId }), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${tabId} whether to allow https://a.example. Try again after the user has answered.`,
    });
    assert.equal(fake.tabs.has(tabId), true);
  });

  it("refuses the only tab of a window", async () => {
    const { fake, call, open } = setup();
    const tab = await open("s1");
    await assert.rejects(call("s1", "tab_close", { tabId: tab.id }), {
      code: "last_tab",
      message: `Tab ${tab.id} is the last tab in its window, and closing it would close the window.`,
    });
    assert.equal(fake.tabs.has(tab.id), true);
  });

  it("closes only one of a window's two tabs closed at once", async () => {
    const { fake, call, open } = setup();
    const first = await open("s1");
    const second = await open("s1");
    const results = await Promise.allSettled([
      call("s1", "tab_close", { tabId: first.id }),
      call("s1", "tab_close", { tabId: second.id }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"],
    );
    const refused = results[1];
    assert.ok(refused?.status === "rejected" && refused.reason instanceof ToolError);
    assert.equal(refused.reason.code, "last_tab");
    assert.deepEqual([...fake.tabs.keys()], [second.id]);
  });

  it("returns no tabs after closing the group's last tab in a window with the user's tab", async () => {
    const { fake, call, open } = setup();
    const user = fake.openTab({ url: "https://user.example/" });
    const tab = await open("s1");
    assert.deepEqual(await call("s1", "tab_close", { tabId: tab.id }), { tabs: [] });
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("refuses with close_needs_confirm once CLOSE_CONFIRM_TIMEOUT_MS passes while Firefox holds the removal, and closes another session's tab meanwhile", async () => {
    const { fake, timers, call, open } = setup();
    const held = await open("s1");
    await open("s1");
    fake.currentWindowId = 3;
    const other = await open("s2");
    const otherKept = await open("s2");
    const before = timers.pending();
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = (tabIds) =>
      tabIds.includes(held.id) ? new Promise<void>(() => {}) : remove(tabIds);
    let settled = false;
    const closing = call("s1", "tab_close", { tabId: held.id });
    const settle = () => {
      settled = true;
    };
    closing.then(settle, settle);
    await flush();
    assert.deepEqual(await call("s2", "tab_close", { tabId: other.id }), { tabs: [otherKept] });
    assert.equal(settled, false);
    timers.advance(CLOSE_CONFIRM_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false);
    timers.advance(1);
    await assert.rejects(closing, {
      code: "close_needs_confirm",
      message: `Tab ${held.id}'s page asked the user to confirm leaving it. Firefox closes the tab when the user chooses to leave the page, and keeps it open if they choose to stay.`,
    });
    assert.equal(fake.tabs.has(held.id), true);
    assert.equal(timers.pending(), before);
  });

  it("answers with Firefox's error when it refuses the removal within CLOSE_CONFIRM_TIMEOUT_MS", async () => {
    const { fake, timers, call, open } = setup();
    const first = await open("s1");
    await open("s1");
    const before = timers.pending();
    const refusal = new Error("Invalid tab ID");
    fake.browser.tabs.remove = () => Promise.reject(refusal);
    await assert.rejects(
      call("s1", "tab_close", { tabId: first.id }),
      (error: unknown) => error === refusal,
    );
    assert.equal(timers.pending(), before);
    assert.equal(fake.tabs.has(first.id), true);
  });

  it("refuses with close_declined when the user chooses to stay on the page", async () => {
    const { fake, timers, call, open } = setup();
    const kept = await open("s1");
    await open("s1");
    const before = timers.pending();
    fake.browser.tabs.remove = async () => {};
    await assert.rejects(call("s1", "tab_close", { tabId: kept.id }), {
      code: "close_declined",
      message: `Tab ${kept.id} is still open: its page asked the user to confirm leaving it, and the user chose to stay.`,
    });
    assert.equal(timers.pending(), before);
    assert.equal(fake.tabs.has(kept.id), true);
  });

  it("closes the window's other tab after the user chose to stay on a page", async () => {
    const { fake, call, open } = setup();
    const kept = await open("s1");
    const other = await open("s1");
    const windowId = fake.tabs.get(kept.id)?.windowId;
    assert.deepEqual(
      [...fake.tabs.values()].filter((tab) => tab.windowId === windowId).map((tab) => tab.id),
      [kept.id, other.id],
    );
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async () => {};
    await rejectsWith(call("s1", "tab_close", { tabId: kept.id }), "close_declined");
    fake.browser.tabs.remove = remove;
    const closed = await call("s1", "tab_close", { tabId: other.id });
    assert.ok("tabs" in closed);
    assert.deepEqual(
      closed.tabs.map((tab) => tab.id),
      [kept.id],
    );
    assert.equal(fake.tabs.has(other.id), false);
  });

  it("leaves no rejection unhandled, and closes the sibling, when Firefox refuses the removal after the bound", async () => {
    const { fake, timers, call, open } = setup();
    const first = await open("s1");
    const second = await open("s1");
    const remove = fake.browser.tabs.remove;
    const { promise: removal, reject } = Promise.withResolvers<void>();
    fake.browser.tabs.remove = () => removal;
    const closing = call("s1", "tab_close", { tabId: first.id });
    await flush();
    timers.advance(CLOSE_CONFIRM_TIMEOUT_MS);
    await rejectsWith(closing, "close_needs_confirm");
    reject(new Error("Invalid tab ID"));
    await flush();
    fake.browser.tabs.remove = remove;
    const closed = await call("s1", "tab_close", { tabId: second.id });
    assert.ok("tabs" in closed);
    assert.deepEqual(
      closed.tabs.map((tab) => tab.id),
      [first.id],
    );
    assert.equal(fake.tabs.has(second.id), false);
  });
});

describe("resize_window", { timeout: 10000 }, () => {
  it("refuses a session with no group", async () => {
    const { fake, call } = setup();
    await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), {
      code: "no_session_group",
      message: "This session has no tab group yet; open a tab with tab_open first.",
    });
    assert.deepEqual(fake.windowUpdates, []);
  });

  it("refuses sizes that are not whole numbers from 100 to 10,000", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    for (const bad of [99, 10_001, 1.5, "800", undefined]) {
      for (const size of [
        { width: bad, height: 700 },
        { width: 900, height: bad },
      ]) {
        const params = Object.fromEntries(
          Object.entries(size).filter(([, value]) => value !== undefined),
        );
        await assert.rejects(call("s1", "resize_window", params), {
          code: "invalid_params",
          message: "resize_window needs width and height to be whole numbers from 100 to 10,000.",
        });
      }
    }
    assert.deepEqual(fake.windowUpdates, []);
  });

  it("sizes the group's window in its normal state and returns the size Firefox reports", async () => {
    const { fake, timers, call, open } = setup();
    fake.currentWindowId = 3;
    await open("s1");
    assert.deepEqual(await call("s1", "resize_window", { width: 100, height: 10_000 }), {
      width: 100,
      height: 10_000,
    });
    assert.deepEqual(fake.windowUpdates, [
      { windowId: 3, state: "normal", width: 100, height: 10_000 },
    ]);
    reportAfterUpdate(fake, [{ width: 880, height: 650 }]);
    const resize = track(timers, () => call("s1", "resize_window", { width: 900, height: 700 }));
    assert.equal(await resize.run(), "waiting");
    timers.advance(RESIZE_POLL_MS);
    assert.equal(await resize.run(), "settled");
    assert.deepEqual(await resize.started, { width: 880, height: 650 });
  });

  it("fails with Firefox's error when it does not resize the window", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const refusal = new Error("Invalid window state");
    let refused = false;
    fake.browser.windows.update = () => {
      refused = true;
      return Promise.reject(refusal);
    };
    let asked = false;
    fake.browser.windows.get = async (windowId) => {
      if (refused) asked = true;
      return { id: windowId, width: 900, height: 700 };
    };
    await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), refusal);
    assert.equal(refused, true);
    assert.equal(asked, false);
  });

  it("reads the size once and waits for nothing when the window takes the size at once", async () => {
    const { fake, timers, call, open } = setup();
    await open("s1");
    const { get, update } = fake.browser.windows;
    let updated = false;
    let reads = 0;
    fake.browser.windows.update = async (windowId, info) => {
      await update(windowId, info);
      updated = true;
    };
    fake.browser.windows.get = async (windowId) => {
      if (updated) reads += 1;
      return get(windowId);
    };
    const baseline = timers.pending();
    assert.deepEqual(await call("s1", "resize_window", { width: 900, height: 700 }), {
      width: 900,
      height: 700,
    });
    assert.equal(reads, 1);
    assert.equal(timers.pending(), baseline);
    assert.equal(timers.now(), 0);
  });

  it("waits for the window to take the size while Firefox still reports the old one", async () => {
    const { fake, timers, call, open } = setup();
    fake.currentWindowId = 3;
    await open("s1");
    fake.windowSizes.set(3, { width: 1280, height: 1271 });
    reportAfterUpdate(fake, [
      { width: 1280, height: 1271 },
      { width: 1280, height: 1271 },
      { width: 1000, height: 700 },
    ]);
    const resize = track(timers, () => call("s1", "resize_window", { width: 1000, height: 700 }));
    assert.equal(await resize.run(), "waiting");
    timers.advance(RESIZE_POLL_MS);
    assert.equal(await resize.run(), "waiting");
    timers.advance(RESIZE_POLL_MS);
    assert.equal(await resize.run(), "settled");
    assert.deepEqual(await resize.started, { width: 1000, height: 700 });
    assert.equal(timers.now(), 2 * RESIZE_POLL_MS);
    assert.equal(timers.pending(), resize.baseline);
  });

  it("waits while only one of the window's width and height has changed", async () => {
    for (const halfway of [
      { width: 1000, height: 1271 },
      { width: 1280, height: 700 },
    ]) {
      const { fake, timers, call, open } = setup();
      fake.currentWindowId = 3;
      await open("s1");
      fake.windowSizes.set(3, { width: 1280, height: 1271 });
      reportAfterUpdate(fake, [halfway, halfway, { width: 1000, height: 700 }]);
      const resize = track(timers, () => call("s1", "resize_window", { width: 1000, height: 700 }));
      assert.equal(await resize.run(), "waiting");
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "waiting", JSON.stringify(halfway));
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "settled", JSON.stringify(halfway));
      assert.deepEqual(await resize.started, { width: 1000, height: 700 });
    }
  });

  it("waits while the size Firefox reports is still changing", async () => {
    for (const { first, last } of [
      { first: { width: 1200, height: 700 }, last: { width: 1100, height: 700 } },
      { first: { width: 1000, height: 800 }, last: { width: 1000, height: 750 } },
    ]) {
      const { fake, timers, call, open } = setup();
      fake.currentWindowId = 3;
      await open("s1");
      fake.windowSizes.set(3, { width: 1280, height: 1271 });
      reportAfterUpdate(fake, [first, last]);
      const resize = track(timers, () => call("s1", "resize_window", { width: 1000, height: 700 }));
      assert.equal(await resize.run(), "waiting");
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "waiting", JSON.stringify(last));
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "settled", JSON.stringify(last));
      assert.deepEqual(await resize.started, last);
    }
  });

  it("returns a size that differs from the one asked for once it has held for one poll", async () => {
    const cases = [
      {
        before: { width: 1280, height: 800 },
        asked: { width: 1000, height: 700 },
        took: { width: 1200, height: 700 },
      },
      {
        before: { width: 1280, height: 1271 },
        asked: { width: 1280, height: 700 },
        took: { width: 1280, height: 900 },
      },
    ];
    for (const { before, asked, took } of cases) {
      const { fake, timers, call, open } = setup();
      fake.currentWindowId = 3;
      await open("s1");
      fake.windowSizes.set(3, before);
      reportAfterUpdate(fake, [before, took]);
      const resize = track(timers, () => call("s1", "resize_window", asked));
      assert.equal(await resize.run(), "waiting");
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "waiting", JSON.stringify(asked));
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "settled", JSON.stringify(asked));
      assert.deepEqual(await resize.started, took);
      assert.equal(timers.pending(), resize.baseline);
    }
  });

  it("returns the size Firefox reports once it has waited RESIZE_WAIT_MS", async () => {
    const { fake, timers, call, open } = setup();
    fake.currentWindowId = 3;
    await open("s1");
    fake.windowSizes.set(3, { width: 1280, height: 1271 });
    reportAfterUpdate(fake, [{ width: 1280, height: 1271 }]);
    const resize = track(timers, () => call("s1", "resize_window", { width: 1000, height: 700 }));
    for (let poll = 1; poll < RESIZE_WAIT_MS / RESIZE_POLL_MS; poll += 1) {
      assert.equal(await resize.run(), "waiting", `poll ${poll}`);
      timers.advance(RESIZE_POLL_MS);
    }
    assert.equal(await resize.run(), "waiting");
    timers.advance(RESIZE_POLL_MS);
    assert.equal(await resize.run(), "settled");
    assert.deepEqual(await resize.started, { width: 1280, height: 1271 });
    assert.equal(timers.now(), RESIZE_WAIT_MS);
    assert.equal(timers.pending(), resize.baseline);
  });

  it("fails when Firefox reports no width or height while the window takes its size", async () => {
    for (const reported of [{ height: 700 }, { width: 1000 }]) {
      const { fake, timers, call, open } = setup();
      await open("s1");
      reportAfterUpdate(fake, [{ width: 1280, height: 800 }, reported]);
      const resize = track(timers, () => call("s1", "resize_window", { width: 1000, height: 700 }));
      assert.equal(await resize.run(), "waiting");
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "settled");
      await assert.rejects(resize.started, {
        code: "resize_failed",
        message: "Firefox did not report the window's new size.",
      });
      assert.equal(timers.pending(), resize.baseline);
    }
  });

  it("returns a size that held for one poll when Firefox did not report the size before", async () => {
    const unknown: ((windowId: number) => Promise<BrowserWindow>)[] = [
      () => Promise.reject(new Error("No window")),
      async (windowId) => ({ id: windowId }),
    ];
    for (const [index, before] of unknown.entries()) {
      const { fake, timers, call, open } = setup();
      await open("s1");
      let reads = 0;
      fake.browser.windows.get = async (windowId) => {
        reads += 1;
        return reads === 1 ? before(windowId) : { id: windowId, width: 1200, height: 700 };
      };
      const resize = track(timers, () => call("s1", "resize_window", { width: 1000, height: 700 }));
      assert.equal(await resize.run(), "waiting", `case ${index}`);
      timers.advance(RESIZE_POLL_MS);
      assert.equal(await resize.run(), "settled", `case ${index}`);
      assert.deepEqual(await resize.started, { width: 1200, height: 700 });
    }
  });

  it("fails when Firefox reports no width or height", async () => {
    for (const reported of [{ height: 700 }, { width: 900 }]) {
      const { fake, call, open } = setup();
      await open("s1");
      fake.browser.windows.get = async (windowId) => ({ id: windowId, ...reported });
      await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), {
        code: "resize_failed",
        message: "Firefox did not report the window's new size.",
      });
    }
  });

  it("refuses while the session's site prompt is open, wherever it is shown", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    await grant("https://a.example");
    await open("s1", "https://a.example/");
    const other = await open("s1");
    const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
    void asking.catch(() => {});
    const prompt = await promptOf("s1");
    assert.equal(prompt.tabId, other.id);
    // The user drags the prompt's tab out of the session's group.
    fake.ungroup(other.id);
    await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${other.id} whether to allow https://b.example. Try again after the user has answered.`,
    });
    assert.deepEqual(resizes(fake), []);
  });

  it("refuses while the session's recipe page is open", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const proposed = await call("s1", "recipe_propose", {
      name: "Receipt",
      description: "Download the latest receipt.",
      sites: ["https://shop.example"],
      steps: "Open https://shop.example/orders.",
    });
    assert.ok("tabId" in proposed);
    await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), {
      code: "recipe_prompt_open",
      message: `Foxleash is still asking the user in tab ${proposed.tabId} whether to save a recipe. Try again after the user has answered there.`,
    });
    assert.deepEqual(resizes(fake), []);
  });

  it("refuses when the prompt was shown while the session's group was being read", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    await grant("https://a.example");
    await open("s1", "https://a.example/");
    const other = await open("s1");
    const get = fake.browser.tabGroups.get;
    let armed = true;
    fake.browser.tabGroups.get = async (groupId) => {
      if (armed) {
        armed = false;
        const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
        void asking.catch(() => {});
        await promptOf("s1");
      }
      return get(groupId);
    };
    await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), {
      code: "approval_pending",
    });
    assert.equal(armed, false);
    assert.deepEqual(resizes(fake), []);
  });

  it("refuses when the prompt was shown while the window's size was being read", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    await grant("https://a.example");
    await open("s1", "https://a.example/");
    const other = await open("s1");
    const get = fake.browser.windows.get;
    let armed = true;
    fake.browser.windows.get = async (windowId) => {
      if (armed) {
        armed = false;
        const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
        void asking.catch(() => {});
        await promptOf("s1");
      }
      return get(windowId);
    };
    await assert.rejects(call("s1", "resize_window", { width: 900, height: 700 }), {
      code: "approval_pending",
    });
    assert.equal(armed, false);
    assert.deepEqual(resizes(fake), []);
  });

  it("resizes again once the prompt is answered or its tab closed", async () => {
    for (const ending of ["answered", "closed"]) {
      const { fake, call, open, grant, page, promptOf } = setup();
      fake.currentWindowId = 3;
      await grant("https://a.example");
      await open("s1", "https://a.example/");
      const other = await open("s1");
      const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
      void asking.catch(() => {});
      await promptOf("s1");
      if (ending === "answered") (await page("s1")).deliver({ type: "answer", answer: "once" });
      else fake.removeTab(other.id);
      await asking.catch(() => {});
      assert.deepEqual(
        await call("s1", "resize_window", { width: 900, height: 700 }),
        { width: 900, height: 700 },
        ending,
      );
      assert.deepEqual(
        resizes(fake),
        [{ windowId: 3, state: "normal", width: 900, height: 700 }],
        ending,
      );
    }
  });

  it("resizes for another session while one session's prompt is open", async () => {
    const { fake, call, open, grant, promptOf } = setup();
    fake.currentWindowId = 3;
    await grant("https://a.example");
    await open("s1", "https://a.example/");
    const other = await open("s1");
    await open("s2");
    const asking = call("s1", "navigate", { tabId: other.id, url: "https://b.example/" });
    void asking.catch(() => {});
    await promptOf("s1");
    assert.deepEqual(await call("s2", "resize_window", { width: 900, height: 700 }), {
      width: 900,
      height: 700,
    });
    assert.deepEqual(resizes(fake), [{ windowId: 3, state: "normal", width: 900, height: 700 }]);
  });

  // Showing a question draws attention to its window; only an update with a size resizes it.
  function resizes(fake: FakeBrowser): WindowUpdate[] {
    return fake.windowUpdates.filter((update) => update.width !== undefined);
  }

  /** After windows.update, windows.get answers these sizes in turn, then the last one again. */
  function reportAfterUpdate(
    fake: FakeBrowser,
    sizes: { width?: number; height?: number }[],
  ): void {
    const { get, update } = fake.browser.windows;
    let updated = false;
    let reads = 0;
    fake.browser.windows.update = async (windowId, info) => {
      await update(windowId, info);
      updated = true;
    };
    fake.browser.windows.get = async (windowId) => {
      if (!updated) return get(windowId);
      const size = sizes[Math.min(reads, sizes.length - 1)];
      reads += 1;
      return { id: windowId, ...size };
    };
  }

  /** Starts a call, and runs it until it waits on a timer or settles. */
  function track<T>(timers: FakeTimers, start: () => Promise<T>) {
    const baseline = timers.pending();
    let settled = false;
    const started = start();
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return {
      started,
      baseline,
      async run(): Promise<"settled" | "waiting" | "stuck"> {
        for (let turn = 0; turn < 50 && !settled && timers.pending() === baseline; turn += 1) {
          await flush();
        }
        if (settled) return "settled";
        return timers.pending() > baseline ? "waiting" : "stuck";
      },
    };
  }
});

describe("wait_for", { timeout: 10000 }, () => {
  it("refuses bad conditions and timeouts before asking the page", async () => {
    const { call, open, pageCalls, fake } = setup();
    const tab = await open("s1");
    const listeners = fake.navigationListenerCount();
    const cases: [Record<string, unknown>, string][] = [
      [{}, "wait_for needs exactly one of text, selector or navigation."],
      [
        { text: "a", selector: "#b" },
        "wait_for needs exactly one of text, selector or navigation.",
      ],
      [
        { text: "a", navigation: true },
        "wait_for needs exactly one of text, selector or navigation.",
      ],
      [
        { selector: "#b", navigation: true },
        "wait_for needs exactly one of text, selector or navigation.",
      ],
      [{ navigation: false }, "wait_for needs navigation to be true."],
      [{ navigation: "true" }, "wait_for needs navigation to be true."],
      [{ text: "" }, "wait_for needs text to be 1 to 1,000 characters."],
      [{ text: "a".repeat(1001) }, "wait_for needs text to be 1 to 1,000 characters."],
      [{ text: 1 }, "wait_for needs text to be 1 to 1,000 characters."],
      [{ selector: "" }, "wait_for needs selector to be 1 to 1,000 characters."],
      [{ selector: "a".repeat(1001) }, "wait_for needs selector to be 1 to 1,000 characters."],
      [
        { text: "a", timeoutMs: 99 },
        "wait_for needs timeoutMs to be a whole number from 100 to 30,000.",
      ],
      [
        { text: "a", timeoutMs: 30_001 },
        "wait_for needs timeoutMs to be a whole number from 100 to 30,000.",
      ],
      [
        { text: "a", timeoutMs: 1.5 },
        "wait_for needs timeoutMs to be a whole number from 100 to 30,000.",
      ],
      [
        { text: "a", timeoutMs: "1000" },
        "wait_for needs timeoutMs to be a whole number from 100 to 30,000.",
      ],
      [
        { navigation: true, timeoutMs: 99 },
        "wait_for needs timeoutMs to be a whole number from 100 to 30,000.",
      ],
    ];
    for (const [params, message] of cases) {
      await assert.rejects(call("s1", "wait_for", { tabId: tab.id, ...params }), {
        code: "invalid_params",
        message,
      });
    }
    await assert.rejects(call("s1", "wait_for", { tabId: -1, text: "a" }), {
      code: "invalid_params",
      message: "wait_for needs a tab id that is a whole number of 0 or more.",
    });
    assert.deepEqual(pageCalls, []);
    assert.equal(fake.navigationListenerCount(), listeners);
  });

  it("refuses a selector that could test a value attribute, and asks about the rest", async () => {
    const { call, open, pageCalls, replyWith } = setup();
    const tab = await open("s1");
    replyWith(async () => true);
    const refused = [
      "[value]",
      "[VALUE]",
      'input[type=password][value^="a"]',
      "[v\\61 lue]",
      "[v\\61\tlue]",
      "[v\\61\nlue]",
      "[v\\61\r\nlue]",
      "[v\\61\flue]",
      "[v\\000061lue]",
      "[\\76 alue]",
      "[va\\lue]",
      "[val\\\nue]",
      "[value\\]",
      "[*|value]",
      ":has([value])",
      ".value[name=q]",
      "[ng-reflect-value]",
      "[value][ng-reflect-model]",
    ];
    for (const selector of refused) {
      await assert.rejects(
        call("s1", "wait_for", { tabId: tab.id, selector }),
        {
          code: "invalid_params",
          message:
            'wait_for does not take a selector that contains both "[" and "value", since it could test what a password field holds.',
        },
        JSON.stringify(selector),
      );
    }
    const ngReflect = [
      'input[type=password][ng-reflect-model^="a"]',
      "[NG-REFLECT-MODEL]",
      "[ng\\-reflect-model]",
      "[\\6e g-reflect-model]",
      "[*|ng-reflect-model]",
      "form:has([ng-reflect-model])",
    ];
    for (const selector of ngReflect) {
      await assert.rejects(
        call("s1", "wait_for", { tabId: tab.id, selector }),
        {
          code: "invalid_params",
          message:
            'wait_for does not take a selector that contains both "[" and "ng-reflect", since Angular can copy field values into those attributes.',
        },
        JSON.stringify(selector),
      );
    }
    assert.deepEqual(pageCalls, []);
    const asked = [
      'input[name="q"]',
      "[v\\61l]",
      "[data-val]",
      "[\\0]",
      "[\\110000]",
      "[\\d800]",
      ".total-value",
      "#value",
      ".ng-reflect-note",
      "[ng-model]",
    ];
    for (const selector of asked) {
      await call("s1", "wait_for", { tabId: tab.id, selector });
    }
    assert.deepEqual(
      pageCalls.map(({ type, params }) => [type, params]),
      asked.map((selector) => ["wait_for", { selector }]),
    );
  });

  it("returns the tab once the page shows the text, asking with the text only", async () => {
    const { call, open, pageCalls, replyWith } = setup();
    const tab = await open("s1");
    replyWith(async () => true);
    assert.deepEqual(await call("s1", "wait_for", { tabId: tab.id, text: "Saved", extra: 1 }), {
      tab,
    });
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: tab.id, type: "wait_for", params: { text: "Saved" } },
    ]);
  });

  it("waits 10 seconds unless told otherwise, then fails", async () => {
    const { call, open, replyWith, timers } = setup();
    const tab = await open("s1");
    replyWith(async () => false);
    let settled = false;
    const waiting = call("s1", "wait_for", { tabId: tab.id, text: "Saved" });
    waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    timers.advance(9_999);
    await flush();
    assert.equal(settled, false);
    timers.advance(1);
    await assert.rejects(waiting, {
      code: "wait_timeout",
      message: `Tab ${tab.id} did not show that text within 10 seconds.`,
    });
    const short = call("s1", "wait_for", { tabId: tab.id, selector: "#done", timeoutMs: 1000 });
    await flush();
    timers.advance(1000);
    await assert.rejects(short, {
      code: "wait_timeout",
      message: `Tab ${tab.id} did not show an element matching that selector within 1 second.`,
    });
    const shortest = call("s1", "wait_for", { tabId: tab.id, text: "a", timeoutMs: 100 });
    await flush();
    timers.advance(100);
    await assert.rejects(shortest, {
      code: "wait_timeout",
      message: `Tab ${tab.id} did not show that text within 0.1 seconds.`,
    });
    assert.equal(timers.pending(), 0);
  });

  it("passes the page's refusal on at once", async () => {
    const { call, open, replyWith, pageCalls } = setup();
    const tab = await open("s1");
    const refusal = new ToolError("site_not_approved", "Not approved.");
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(call("s1", "wait_for", { tabId: tab.id, text: "a" }), (error) => {
      return error === refusal;
    });
    assert.equal(pageCalls.length, 1);
  });

  it("refuses the tab once it left the group before the page showed the text", async () => {
    const { fake, call, open, replyWith, timers } = setup();
    await open("s1");
    const tab = await open("s1");
    replyWith(async () => false);
    const waiting = call("s1", "wait_for", { tabId: tab.id, text: "Saved" });
    await flush();
    fake.ungroup(tab.id);
    replyWith(async () => true);
    timers.advance(250);
    await rejectsWith(waiting, "tab_not_in_group");
  });

  it("returns the tab after the next navigation, redacted on a site not approved", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const listeners = fake.navigationListenerCount();
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true });
    await flush();
    fake.navigateByUser(tab.id, "https://a.example/next");
    assert.deepEqual(await waiting, {
      tab: { ...tab, url: "https://a.example/next", title: "Title of https://a.example/next" },
    });
    const away = call("s1", "wait_for", { tabId: tab.id, navigation: true });
    await flush();
    fake.navigateByUser(tab.id, "https://b.example/secret");
    assert.deepEqual(await away, {
      tab: { ...tab, url: "https://b.example", title: "" },
    });
    assert.equal(fake.navigationListenerCount(), listeners);
  });

  it("returns the tab after the page changes its address with the History API", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 30_000 });
    await flush();
    fake.pushState(tab.id, "https://a.example/step-2");
    assert.deepEqual(await waiting, { tab: { ...tab, url: "https://a.example/step-2" } });
  });

  it("fails a navigation wait when the tab closes or nothing happens in time", async () => {
    const { fake, call, open, timers } = setup();
    await open("s1");
    const tab = await open("s1");
    const listeners = fake.navigationListenerCount();
    const timedOut = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await assert.rejects(timedOut, {
      code: "wait_timeout",
      message: `Tab ${tab.id} did not finish a navigation within 2 seconds.`,
    });
    const closed = call("s1", "wait_for", { tabId: tab.id, navigation: true });
    await flush();
    fake.removeTab(tab.id);
    await assert.rejects(closed, {
      code: "tab_not_found",
      message: `Tab ${tab.id} does not exist.`,
    });
    assert.equal(fake.navigationListenerCount(), listeners);
    assert.equal(timers.pending(), 0);
  });

  it("refuses a navigation wait on a tab outside the group, removing its listeners", async () => {
    const { fake, call, open } = setup();
    await open("s1");
    const user = fake.openTab({ url: "https://user.example/" });
    const removed = fake.removedListenerCount();
    const listeners = fake.navigationListenerCount();
    await rejectsWith(
      call("s1", "wait_for", { tabId: user.id, navigation: true }),
      "tab_not_in_group",
    );
    assert.equal(fake.navigationListenerCount(), listeners);
    assert.equal(fake.removedListenerCount(), removed);
  });

  it("returns at once for a navigation that finished since the session's last act, once", async () => {
    const { fake, call, open, grant, replyWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s1", tab.id, call, replyWith);
    fake.navigateByUser(tab.id, "https://a.example/next");
    await flush();
    assert.deepEqual(await call("s1", "wait_for", { tabId: tab.id, navigation: true }), {
      tab: { ...tab, url: "https://a.example/next", title: "Title of https://a.example/next" },
    });
    const again = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await assert.rejects(again, {
      code: "wait_timeout",
      message: `Tab ${tab.id} did not finish a navigation within 2 seconds.`,
    });
  });

  it("does not return again for a navigation a wait already returned for", async () => {
    const { fake, call, open, grant, replyWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s1", tab.id, call, replyWith);
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true });
    await flush();
    fake.navigateByUser(tab.id, "https://a.example/next");
    const result = await waiting;
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/next");
    const again = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await rejectsWith(again, "wait_timeout");
  });

  it("does not count navigate's own load, but a navigation after navigate returned", async () => {
    const { fake, call, open, grant, navigate, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await navigate("s1", { tabId: tab.id, url: "https://a.example/other" });
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/other" });
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await rejectsWith(waiting, "wait_timeout");
    await navigate("s1", { tabId: tab.id, url: "https://a.example/again" });
    fake.navigateByUser(tab.id, "https://a.example/next");
    await flush();
    assert.deepEqual(await call("s1", "wait_for", { tabId: tab.id, navigation: true }), {
      tab: { ...tab, url: "https://a.example/next", title: "Title of https://a.example/next" },
    });
  });

  it("marks navigate's end also when navigate fails after the group check", async () => {
    const { fake, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await rejectsWith(
      call("s1", "navigate", { tabId: tab.id, url: "/\\evil.example/x" }),
      "invalid_url",
    );
    fake.navigateByUser(tab.id, "https://a.example/next");
    await flush();
    const result = await call("s1", "wait_for", { tabId: tab.id, navigation: true });
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/next");
  });

  it("returns at once for a History API change since the session's last act", async () => {
    const { fake, call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s1", tab.id, call, replyWith);
    fake.pushState(tab.id, "https://a.example/step-2");
    assert.deepEqual(await call("s1", "wait_for", { tabId: tab.id, navigation: true }), {
      tab: { ...tab, url: "https://a.example/step-2" },
    });
  });

  it("keeps another session's act in the tab from moving this session's mark", async () => {
    const { fake, call, open, grant, replyWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s2", tab.id, call, replyWith);
    fake.navigateByUser(tab.id, "https://a.example/next");
    await flush();
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await rejectsWith(waiting, "wait_timeout");
    await click("s1", tab.id, call, replyWith);
    fake.navigateByUser(tab.id, "https://a.example/again");
    await flush();
    await click("s2", tab.id, call, replyWith);
    const result = await call("s1", "wait_for", { tabId: tab.id, navigation: true });
    assert.ok("tab" in result);
    assert.equal(result.tab.url, "https://a.example/again");
  });

  it("waits for a navigation under way, though an earlier one finished since the act", async () => {
    const { fake, call, open, grant, replyWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s1", tab.id, call, replyWith);
    fake.navigateByUser(tab.id, "https://a.example/next");
    await flush();
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: "https://a.example/redirect" });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://a.example/redirect" });
    let done = false;
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true }).finally(() => {
      done = true;
    });
    await flush();
    assert.equal(done, false);
    fake.emitCompleted({ tabId: tab.id, frameId: 0, url: "https://a.example/redirect" });
    const result = await waiting;
    assert.ok("tab" in result);
    assert.equal(result.tab.id, tab.id);
    const again = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    await rejectsWith(again, "wait_timeout");
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

  it("refuses a bad find or role with its sentence before asking the page", async () => {
    const { call, pageCalls } = setup();
    const find = "read_page needs find to be text that is not only spaces.";
    const role = "read_page needs role to be a role name, such as link or heading.";
    const cases: [Record<string, unknown>, string][] = [
      [{ find: "" }, find],
      [{ find: " \n\u0085" }, find],
      [{ find: 5 }, find],
      [{ find: "a", role: 4 }, role],
      [{ find: "a", role: "" }, role],
      [{ role: " \u0085" }, role],
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
    const { call, pageCalls, replyWith } = setup();
    await call("s1", "read_page", { tabId: 3 });
    await call("s2", "read_page", {
      tabId: 0,
      filter: "interactive",
      depth: 2,
      ref: "0a1b2c3d-4",
      extra: true,
    });
    replyWith(async () => ({
      tree: "",
      truncated: false,
      found: { shown: 0, matches: 0, searched: 0 },
    }));
    await call("s1", "read_page", { tabId: 3, find: " Link ", role: "LINK" });
    await call("s1", "read_page", { tabId: 3, find: "a" });
    await call("s1", "read_page", { tabId: 3, role: "link" });
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: 3, type: "read_page", params: { filter: "all" } },
      {
        session: "s2",
        tabId: 0,
        type: "read_page",
        params: { filter: "interactive", depth: 2, ref: "0a1b2c3d-4" },
      },
      {
        session: "s1",
        tabId: 3,
        type: "read_page",
        params: { filter: "all", find: " Link ", role: "LINK" },
      },
      { session: "s1", tabId: 3, type: "read_page", params: { filter: "all", find: "a" } },
      { session: "s1", tabId: 3, type: "read_page", params: { filter: "all", role: "link" } },
    ]);
    assert.deepEqual(Object.keys(pageCalls[0]?.params ?? {}), ["filter"]);
    assert.deepEqual(Object.keys(pageCalls[3]?.params ?? {}), ["filter", "find"]);
    assert.deepEqual(Object.keys(pageCalls[4]?.params ?? {}), ["filter", "role"]);
  });

  it("returns with find the tree, whether it was cut and the counts, as a fresh object", async () => {
    const { call, replyWith } = setup();
    const found = { shown: 1, matches: 3, searched: 40, extra: "page text" };
    replyWith(async () => ({ tree: "main\n  link", truncated: true, found, extra: 1 }));
    const result = await call("s1", "read_page", { tabId: 3, find: "link" });
    assert.deepEqual(result, {
      tree: "main\n  link",
      truncated: true,
      found: { shown: 1, matches: 3, searched: 40 },
    });
    assert.ok(typeof result === "object" && result !== null);
    assert.notEqual(Reflect.get(result, "found"), found);
    replyWith(async () => ({
      tree: "",
      truncated: false,
      found: { shown: 0, matches: 0, searched: 7 },
    }));
    assert.deepEqual(await call("s1", "read_page", { tabId: 3, find: "nothing" }), {
      tree: "",
      truncated: false,
      found: { shown: 0, matches: 0, searched: 7 },
    });
  });

  it("returns with role and no find the tree, whether it was cut and the counts", async () => {
    const { call, replyWith } = setup();
    const found = { shown: 1, matches: 3, searched: 40, extra: "page text" };
    replyWith(async () => ({ tree: "main\n  iframe", truncated: true, found, extra: 1 }));
    assert.deepEqual(await call("s1", "read_page", { tabId: 3, role: "iframe" }), {
      tree: "main\n  iframe",
      truncated: true,
      found: { shown: 1, matches: 3, searched: 40 },
    });
    for (const reply of [
      { tree: "main", truncated: false },
      { tree: "main", truncated: false, found: { shown: 0, matches: 0, searched: 3 } },
    ]) {
      replyWith(async () => reply);
      await assert.rejects(call("s1", "read_page", { tabId: 3, role: "iframe" }), {
        code: "page_error",
        message: "Foxleash could not complete the request in the page in tab 3.",
      });
    }
  });

  it("refuses with find a reply whose counts it cannot read as page_error", async () => {
    const { call, replyWith } = setup();
    const replies: unknown[] = [
      { tree: "main", truncated: false },
      { tree: "main", truncated: false, found: null },
      { tree: "main", truncated: false, found: { shown: "1", matches: 1, searched: 1 } },
      { tree: "main", truncated: false, found: { shown: 2, matches: 1, searched: 3 } },
      { tree: "main", truncated: false, found: { shown: 0, matches: 0, searched: 3 } },
      { tree: "", truncated: true, found: { shown: 0, matches: 0, searched: 3 } },
      { tree: "", truncated: false, found: { shown: 3, matches: 3, searched: 3 } },
      { tree: "main", truncated: false, found: { shown: 0, matches: 9, searched: 9 } },
      Object.assign(Object.create({ found: { shown: 1, matches: 1, searched: 1 } }), {
        tree: "main",
        truncated: false,
      }),
    ];
    for (const reply of replies) {
      replyWith(async () => reply);
      await assert.rejects(call("s1", "read_page", { tabId: 3, find: "main" }), {
        code: "page_error",
        message: "Foxleash could not complete the request in the page in tab 3.",
      });
    }
  });

  it("asks the page with finds for each find's answer and returns them as fresh objects", async () => {
    const { call, pageCalls, replyWith } = setup();
    const found = { shown: 1, matches: 3, searched: 40, extra: "page text" };
    const second = { tree: "", truncated: false, found: { shown: 0, matches: 0, searched: 40 } };
    const third = {
      tree: "main\n  heading",
      truncated: false,
      found: { ...found, shown: 2, matches: 2 },
    };
    replyWith(async () => ({
      tree: "main\n  link",
      truncated: true,
      found,
      finds: [{ ...second, extra: 1 }, third],
      extra: 1,
    }));
    const finds = [
      { find: "b", other: true },
      { find: "c", role: "heading" },
    ];
    const result = await call("s1", "read_page", { tabId: 3, find: "link", depth: 2, finds });
    assert.deepEqual(pageCalls, [
      {
        session: "s1",
        tabId: 3,
        type: "read_page",
        params: {
          filter: "all",
          depth: 2,
          find: "link",
          finds: [{ find: "b" }, { find: "c", role: "heading" }],
        },
      },
    ]);
    assert.deepEqual(result, {
      tree: "main\n  link",
      truncated: true,
      found: { shown: 1, matches: 3, searched: 40 },
      finds: [
        second,
        {
          tree: "main\n  heading",
          truncated: false,
          found: { shown: 2, matches: 2, searched: 40 },
        },
      ],
    });
    assert.ok(typeof result === "object" && result !== null);
    const parts: unknown = Reflect.get(result, "finds");
    assert.ok(Array.isArray(parts));
    assert.deepEqual(Object.keys(parts[0]), ["tree", "truncated", "found"]);
    assert.notEqual(parts[1], third);
    assert.notEqual(Reflect.get(parts[1], "found"), third.found);
  });

  it("refuses bad finds with their sentence before asking the page", async () => {
    const { call, pageCalls } = setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ finds: [{ find: "b" }] }, "read_page takes finds only together with find or role."],
      [
        { find: "a", finds: [{}] },
        "read_page needs each entry of finds to have a find, a role or both.",
      ],
      [{ find: "a", finds: [] }, "read_page needs finds to be a list of 1 to 18 entries."],
      [
        { find: "a", finds: [{ find: " " }] },
        "read_page needs each entry of finds to have a find that is text that is not only spaces.",
      ],
      [
        { find: "a", finds: [{ find: "b", role: "" }] },
        "read_page needs each entry of finds to have a role name as its role, such as link or heading.",
      ],
    ];
    for (const [options, message] of cases) {
      await assert.rejects(call("s1", "read_page", { tabId: 3, ...options }), {
        code: "invalid_params",
        message,
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("refuses with finds a reply whose finds it cannot read as page_error", async () => {
    const { call, replyWith } = setup();
    const found = { shown: 1, matches: 1, searched: 1 };
    const part = { tree: "main", truncated: false, found };
    const withFinds = (finds: unknown): unknown => ({ ...part, finds });
    const replies: unknown[] = [
      part,
      withFinds(null),
      withFinds(part),
      withFinds([]),
      withFinds([part]),
      withFinds([part, part, part]),
      // biome-ignore lint/suspicious/noSparseArray: a hole in the reply is a case of its own
      withFinds([part, ,]),
      withFinds([part, null]),
      withFinds([part, "main"]),
      withFinds([part, { tree: 1, truncated: false, found }]),
      withFinds([part, { tree: "a".repeat(READ_PAGE_MAX_CHARS + 1), truncated: true, found }]),
      withFinds([part, { tree: "main", found }]),
      withFinds([part, { tree: "main", truncated: false }]),
      withFinds([part, { tree: "main", truncated: false, found: { ...found, shown: 2 } }]),
      withFinds([
        part,
        Object.assign(Object.create({ found }), { tree: "main", truncated: false }),
      ]),
      Object.assign(Object.create({ finds: [part, part] }), part),
    ];
    for (const [index, reply] of replies.entries()) {
      replyWith(async () => reply);
      await assert.rejects(
        call("s1", "read_page", { tabId: 3, find: "main", finds: [{ find: "a" }, { find: "b" }] }),
        {
          code: "page_error",
          message: "Foxleash could not complete the request in the page in tab 3.",
        },
        String(index),
      );
    }
  });

  it("passes on no counts without find", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({
      tree: "main",
      truncated: false,
      found: { shown: 1, matches: 1, searched: 1 },
    }));
    const result = await call("s1", "read_page", { tabId: 3 });
    assert.deepEqual(result, { tree: "main", truncated: false });
    assert.ok(typeof result === "object" && result !== null);
    assert.deepEqual(Object.keys(result), ["tree", "truncated"]);
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
        message: "Foxleash could not complete the request in the page in tab 3.",
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

  it("refuses a bad offset with its sentence before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const offset of [-1, 1.5, "10", null, 2 ** 53, Number.NaN]) {
      await assert.rejects(call("s1", "get_page_text", { tabId: 3, offset }), {
        code: "invalid_params",
        message: "get_page_text needs offset to be a whole number of 0 or more.",
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("asks the page with maxChars and offset, the defaults when none are given", async () => {
    const { call, pageCalls, replyWith } = setup();
    replyWith(async () => text);
    await call("s1", "get_page_text", { tabId: 3 });
    await call("s2", "get_page_text", { tabId: 0, maxChars: 40, extra: true });
    await call("s3", "get_page_text", { tabId: 4, offset: 7, extra: true });
    assert.deepEqual(pageCalls, [
      {
        session: "s1",
        tabId: 3,
        type: "get_page_text",
        params: { maxChars: 50_000, offset: 0 },
      },
      { session: "s2", tabId: 0, type: "get_page_text", params: { maxChars: 40, offset: 0 } },
      {
        session: "s3",
        tabId: 4,
        type: "get_page_text",
        params: { maxChars: 50_000, offset: 7 },
      },
    ]);
  });

  it("returns only the five fields of the page's text", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ ...text, nextOffset: 3, extra: "page text" }));
    assert.deepEqual(await call("s1", "get_page_text", { tabId: 3 }), text);
  });

  it("gives a truncated reply its own next offset, after the request's offset", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ ...text, truncated: true, nextOffset: 1 }));
    assert.deepEqual(await call("s1", "get_page_text", { tabId: 3, offset: 5 }), {
      ...text,
      truncated: true,
      nextOffset: 14,
    });
  });

  it("refuses a truncated reply when the next offset would not be a safe integer", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ ...text, truncated: true }));
    await assert.rejects(
      call("s1", "get_page_text", { tabId: 3, offset: Number.MAX_SAFE_INTEGER }),
      {
        code: "page_error",
        message: "Foxleash could not complete the request in the page in tab 3.",
      },
    );
  });

  it("cuts a reply over maxChars again and marks it cut", async () => {
    const { call, replyWith } = setup();
    replyWith(async () => ({ ...text, main: "a".repeat(8), rest: "b".repeat(8) }));
    assert.deepEqual(await call("s1", "get_page_text", { tabId: 3, maxChars: 10 }), {
      ...text,
      main: "a".repeat(8),
      rest: "bb",
      truncated: true,
      nextOffset: 10,
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
        message: "Foxleash could not complete the request in the page in tab 3.",
      });
    }
  });

  it("passes the page's refusal through unchanged", async () => {
    const { call, replyWith } = setup();
    const refusal = new ToolError("site_not_approved", "Foxleash is not allowed on that site.");
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(
      call("s1", "get_page_text", { tabId: 3 }),
      (error: unknown) => error === refusal,
    );
  });
});

describe("read_console", { timeout: 10000 }, () => {
  const message = { level: "warn", kind: "console", text: "careful", time: 1000 };
  const recorded = { recording: true, messages: [message], dropped: 2 };
  const live = { since: 900 };
  const since = { ...recorded, since: live.since };

  it("refuses a tab id that is not a whole number of 0 or more before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const tabId of [undefined, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
      await assert.rejects(call("s1", "read_console", tabId === undefined ? {} : { tabId }), {
        code: "invalid_params",
        message: "read_console needs a tab id that is a whole number of 0 or more.",
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("asks the page with no parameters and returns its records while recording is live", async () => {
    const { call, pageCalls, replyWith, liveWith } = setup();
    const asked: [string, number][] = [];
    liveWith((session, tabId) => {
      asked.push([session, tabId]);
      return live;
    });
    replyWith(async () => recorded);
    assert.deepEqual(await call("s1", "read_console", { tabId: 3, extra: true }), since);
    assert.deepEqual(await call("s2", "read_console", { tabId: 0 }), since);
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: 3, type: "read_console", params: {} },
      { session: "s2", tabId: 0, type: "read_console", params: {} },
    ]);
    assert.deepEqual(asked, [
      ["s1", 3],
      ["s1", 3],
      ["s2", 0],
      ["s2", 0],
    ]);
  });

  it("returns the page's result rebuilt, with its texts cut again", async () => {
    const { call, replyWith, liveWith } = setup();
    const long = { ...message, text: "a".repeat(1001), extra: "page text" };
    replyWith(async () => ({ ...recorded, messages: [long], extra: true }));
    liveWith(() => live);
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), {
      ...since,
      messages: [{ ...message, text: "a".repeat(1000) }],
    });
  });

  it("returns no records without a live recording, or when it changed during the read", async () => {
    const { call, replyWith, liveWith, pageCalls } = setup();
    replyWith(async () => recorded);
    const none = { recording: false, messages: [], dropped: 0 };
    liveWith(() => undefined);
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), none);
    const answers = [{ since: 1 }, { since: 1 }];
    liveWith(() => answers.shift());
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), none);
    const before = { since: 2 };
    const later = [before, undefined];
    liveWith(() => later.shift());
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), none);
    const after = [undefined, { since: 3 }];
    liveWith(() => after.shift());
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), none);
    liveWith((session) => (session === "s2" ? before : undefined));
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), none);
    assert.deepEqual(await call("s2", "read_console", { tabId: 3 }), { ...recorded, since: 2 });
    assert.equal(pageCalls.length, 6);
  });

  it("gives since from the live recording, never from the page, and none when not recording", async () => {
    const { call, replyWith, liveWith } = setup();
    liveWith(() => live);
    replyWith(async () => ({ ...recorded, since: 5 }));
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), since);
    const unrecorded = { recording: false, messages: [], dropped: 0 };
    replyWith(async () => ({ ...unrecorded, since: 5 }));
    assert.deepEqual(await call("s1", "read_console", { tabId: 3 }), unrecorded);
  });

  it("refuses a reply it cannot read as page_error, recording or not", async () => {
    const { call, replyWith, liveWith } = setup();
    const replies: unknown[] = [
      undefined,
      null,
      [],
      { ...recorded, recording: "yes" },
      { ...recorded, messages: [{ ...message, level: "fatal" }] },
      { ...recorded, dropped: -1 },
      Object.create(recorded),
    ];
    for (const answer of [() => live, () => undefined]) {
      liveWith(answer);
      for (const reply of replies) {
        replyWith(async () => reply);
        await assert.rejects(call("s1", "read_console", { tabId: 3 }), {
          code: "page_error",
          message: "Foxleash could not complete the request in the page in tab 3.",
        });
      }
    }
  });

  it("passes the page's refusal through unchanged", async () => {
    const { call, replyWith } = setup();
    const refusal = new ToolError("site_not_approved", "Foxleash is not allowed on that site.");
    replyWith(() => Promise.reject(refusal));
    await assert.rejects(
      call("s1", "read_console", { tabId: 3 }),
      (error: unknown) => error === refusal,
    );
  });

  it("returns the records of the page a navigation under way brings", async () => {
    const { fake, call, open, grant, replyWith, liveWith, pageCalls, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timersBefore = timers.pending();
    // As live-documents.ts does, a commit in the top frame replaces the tab's recording.
    let current = { since: 1 };
    fake.browser.webNavigation.onCommitted.addListener(({ frameId }) => {
      if (frameId === 0) current = { since: 2 };
    });
    liveWith(() => current);
    replyWith(async () => recorded);
    beginNavigation(fake, tab.id, "https://a.example/next");
    const read = call("s1", "read_console", { tabId: tab.id });
    await flush();
    assert.deepEqual(pageCalls, []);
    landNavigation(fake, tab.id, "https://a.example/next");
    assert.deepEqual(await read, { ...recorded, since: 2 });
    assert.equal(timers.pending(), timersBefore);
  });

  it("fails with page_changed, not as unrecorded, when a navigation began during the read", async () => {
    const { fake, call, open, grant, replyWith, liveWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    let current = { since: 1 };
    fake.browser.webNavigation.onCommitted.addListener(({ frameId }) => {
      if (frameId === 0) current = { since: 2 };
    });
    liveWith(() => current);
    replyWith(async () => {
      // The next page lands while the read runs, and answers.
      beginNavigation(fake, tab.id, "https://a.example/next");
      landNavigation(fake, tab.id, "https://a.example/next");
      return recorded;
    });
    await assert.rejects(call("s1", "read_console", { tabId: tab.id }), {
      code: "page_changed",
      message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
    });
  });

  it("answers within READ_CONSOLE_TIMEOUT_MS, its wait for a navigation included", async () => {
    assert.equal(READ_CONSOLE_TIMEOUT_MS, 50_000);
    const { fake, call, open, grant, replyWith, liveWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const timersBefore = timers.pending();
    liveWith(() => live);
    // The page never answers.
    replyWith(() => new Promise(() => {}));
    beginNavigation(fake, tab.id, "https://a.example/next");
    let settled = false;
    const read = call("s1", "read_console", { tabId: tab.id });
    read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    timers.advance(NAVIGATION_WAIT_MS - 1);
    landNavigation(fake, tab.id, "https://a.example/next");
    await flush();
    timers.advance(READ_CONSOLE_TIMEOUT_MS - NAVIGATION_WAIT_MS);
    await flush();
    assert.equal(settled, false);
    timers.advance(1);
    await assert.rejects(read, {
      code: "page_timeout",
      message: `Foxleash did not finish reading the console of tab ${tab.id} in time; try again.`,
    });
    assert.equal(timers.pending(), timersBefore);
  });
});

describe("read_network", { timeout: 10000 }, () => {
  const SITE = "https://a.example";
  const recorded: Result<"read_network"> = {
    recording: true,
    requests: [
      {
        url: `${SITE}/api`,
        method: "GET",
        type: "xmlhttprequest",
        startTime: 1000,
        requestHeaders: [],
        responseHeaders: [],
      },
    ],
    truncated: false,
  };

  async function approvedTab(context: ReturnType<typeof setup>): Promise<TabInfo> {
    await context.grant(SITE);
    return context.open("s1", `${SITE}/page`);
  }

  it("refuses a tab id that is not a whole number of 0 or more before reading", async () => {
    const context = setup();
    await approvedTab(context);
    for (const tabId of [undefined, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
      await assert.rejects(
        context.call("s1", "read_network", tabId === undefined ? {} : { tabId }),
        {
          code: "invalid_params",
          message: "read_network needs a tab id that is a whole number of 0 or more.",
        },
      );
    }
    assert.deepEqual(context.networkReads, []);
  });

  it("takes 0 as a tab id", async () => {
    const { call } = setup();
    await rejectsWith(call("s1", "read_network", { tabId: 0 }), "tab_not_found");
  });

  it("refuses a pattern that is not text of at most 1,000 characters", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    for (const pattern of [1, null, ["a"], "a".repeat(MAX_NETWORK_PATTERN + 1)]) {
      await assert.rejects(context.call("s1", "read_network", { tabId: tab.id, pattern }), {
        code: "invalid_params",
        message: "read_network needs pattern to be text of at most 1,000 characters.",
      });
    }
    assert.deepEqual(context.networkReads, []);
  });

  it("refuses a limit that is not a whole number from 1 to 500", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    for (const limit of [0, 501, 1.5, "10", null, Number.NaN, -1]) {
      await assert.rejects(context.call("s1", "read_network", { tabId: tab.id, limit }), {
        code: "invalid_params",
        message: "read_network needs limit to be a whole number from 1 to 500.",
      });
    }
    assert.deepEqual(context.networkReads, []);
  });

  it("reads the gated site's requests with the pattern and limit, or the default limit", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    context.networkWith(recorded);
    const longest = "a".repeat(MAX_NETWORK_PATTERN);
    assert.equal(await context.call("s1", "read_network", { tabId: tab.id }), recorded);
    assert.equal(
      await context.call("s1", "read_network", { tabId: tab.id, pattern: longest, limit: 500 }),
      recorded,
    );
    await context.call("s1", "read_network", {
      tabId: tab.id,
      pattern: "",
      limit: 1,
      extra: true,
    });
    await context.call("s1", "read_network", {
      tabId: tab.id,
      pattern: undefined,
      limit: undefined,
    });
    const unset = { failed: false, headers: false, body: false, responseBody: false };
    assert.deepEqual(context.networkReads, [
      {
        session: "s1",
        tabId: tab.id,
        site: SITE,
        options: { ...unset, limit: DEFAULT_NETWORK_LIMIT },
      },
      {
        session: "s1",
        tabId: tab.id,
        site: SITE,
        options: { ...unset, pattern: longest, limit: 500 },
      },
      { session: "s1", tabId: tab.id, site: SITE, options: { ...unset, pattern: "", limit: 1 } },
      {
        session: "s1",
        tabId: tab.id,
        site: SITE,
        options: { ...unset, limit: DEFAULT_NETWORK_LIMIT },
      },
    ]);
    assert.equal(DEFAULT_NETWORK_LIMIT, 100);
  });

  it("refuses types that are not a list of 1 to 20 texts of 1 to 1,000 characters", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    const holed = ["script", "image"];
    delete holed[0];
    const sparse: unknown[] = new Array(2);
    sparse[1] = "script";
    const refused: unknown[] = [
      "script",
      null,
      1,
      { 0: "script", length: 1 },
      [],
      Array.from({ length: MAX_NETWORK_TYPES + 1 }, () => "script"),
      ["script", 1],
      ["script", null],
      [""],
      ["a".repeat(MAX_NETWORK_HEADER + 1)],
      // 1,002 UTF-16 units in 501 code points.
      ["\u{1F600}".repeat(501)],
      holed,
      sparse,
    ];
    for (const types of refused) {
      await assert.rejects(context.call("s1", "read_network", { tabId: tab.id, types }), {
        code: "invalid_params",
        message:
          "read_network needs types to be a list of 1 to 20 resource types, each text of 1 to 1,000 characters.",
      });
    }
    assert.deepEqual(context.networkReads, []);
  });

  it("refuses failed, headers, body and responseBody that are not true or false", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    for (const key of ["failed", "headers", "body", "responseBody"]) {
      for (const value of ["true", 1, 0, null]) {
        await assert.rejects(context.call("s1", "read_network", { tabId: tab.id, [key]: value }), {
          code: "invalid_params",
          message: `read_network needs ${key} to be true or false.`,
        });
      }
    }
    assert.deepEqual(context.networkReads, []);
  });

  it("passes types, failed, headers, body and responseBody through when given", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    context.networkWith(recorded);
    const types = ["script", "xmlhttprequest"];
    const most = Array.from({ length: MAX_NETWORK_TYPES }, (_, index) =>
      String(index).padEnd(MAX_NETWORK_HEADER, "t"),
    );
    await context.call("s1", "read_network", {
      tabId: tab.id,
      pattern: "/api",
      types,
      failed: true,
      limit: 3,
      headers: true,
      body: true,
      responseBody: true,
    });
    await context.call("s1", "read_network", {
      tabId: tab.id,
      failed: false,
      headers: false,
      body: false,
      responseBody: false,
    });
    await context.call("s1", "read_network", { tabId: tab.id, types: most });
    await context.call("s1", "read_network", { tabId: tab.id, headers: true });
    await context.call("s1", "read_network", { tabId: tab.id, types: ["a"] });
    await context.call("s1", "read_network", { tabId: tab.id, body: true });
    await context.call("s1", "read_network", { tabId: tab.id, responseBody: true });
    const [all, unset, longest, withHeaders, shortest, withBody, withResponseBody] =
      context.networkReads;
    assert.deepEqual(all?.options, {
      pattern: "/api",
      types,
      failed: true,
      headers: true,
      body: true,
      responseBody: true,
      limit: 3,
    });
    assert.notEqual(all?.options.types, types);
    assert.deepEqual(unset?.options, {
      failed: false,
      headers: false,
      body: false,
      responseBody: false,
      limit: DEFAULT_NETWORK_LIMIT,
    });
    assert.deepEqual(longest?.options, {
      types: most,
      failed: false,
      headers: false,
      body: false,
      responseBody: false,
      limit: DEFAULT_NETWORK_LIMIT,
    });
    assert.deepEqual(withHeaders?.options, {
      failed: false,
      headers: true,
      body: false,
      responseBody: false,
      limit: DEFAULT_NETWORK_LIMIT,
    });
    assert.deepEqual(shortest?.options, {
      types: ["a"],
      failed: false,
      headers: false,
      body: false,
      responseBody: false,
      limit: DEFAULT_NETWORK_LIMIT,
    });
    assert.deepEqual(withBody?.options, {
      failed: false,
      headers: false,
      body: true,
      responseBody: false,
      limit: DEFAULT_NETWORK_LIMIT,
    });
    assert.deepEqual(withResponseBody?.options, {
      failed: false,
      headers: false,
      body: false,
      responseBody: true,
      limit: DEFAULT_NETWORK_LIMIT,
    });
  });

  it("reads params as own fields only", async () => {
    const context = setup();
    const tab = await approvedTab(context);
    const inherited = {
      pattern: 1,
      limit: 0,
      types: ["script"],
      failed: true,
      headers: true,
      body: true,
      responseBody: true,
    };
    const params = Object.assign(Object.create(inherited), { tabId: tab.id });
    await context.call("s1", "read_network", params);
    assert.deepEqual(context.networkReads, [
      {
        session: "s1",
        tabId: tab.id,
        site: SITE,
        options: {
          failed: false,
          headers: false,
          body: false,
          responseBody: false,
          limit: DEFAULT_NETWORK_LIMIT,
        },
      },
    ]);
  });

  it("passes the gate's refusals through without reading", async () => {
    const context = setup();
    const { fake, call, open, grant, promptOf } = context;
    const tab = await approvedTab(context);
    await rejectsWith(call("s1", "read_network", { tabId: 99 }), "tab_not_found");
    const outside = fake.openTab({ url: `${SITE}/` });
    await rejectsWith(call("s1", "read_network", { tabId: outside.id }), "tab_not_in_group");
    await rejectsWith(call("s2", "read_network", { tabId: tab.id }), "tab_not_in_group");
    const other = await open("s1");
    const cases: [string, string][] = [
      ["about:blank", "page_not_web"],
      ["https://b.example/x", "site_not_approved"],
      ["https://www.paypal.com/", "site_blocked"],
    ];
    await grant("https://www.paypal.com");
    for (const [url, code] of cases) {
      fake.navigateByUser(other.id, url);
      await flush();
      await rejectsWith(call("s1", "read_network", { tabId: other.id }), code, url);
    }
    const opened = call("s3", "tab_open", { url: "https://c.example/" });
    const prompt = await promptOf("s3");
    await rejectsWith(call("s3", "read_network", { tabId: prompt.tabId }), "approval_pending");
    void opened.catch(() => {});
    assert.deepEqual(context.networkReads, []);
  });

  describe("from a server of a served protocol, with the real network log", () => {
    const sent = [
      { name: "Cookie", value: "session=secret-1" },
      { name: "Accept", value: "*/*" },
    ];
    const received = [
      { name: "Set-Cookie", value: "a=secret-2" },
      { name: "Content-Type", value: "text/plain" },
    ];
    const request = {
      url: `${SITE}/api`,
      method: "GET",
      type: "xmlhttprequest",
      startTime: 1000,
      durationMs: 50,
      status: 200,
      fromCache: false,
    };

    /** An approved tab whose page made one request with headers in both directions. */
    async function recordedTab(context: ReturnType<typeof setup>): Promise<TabInfo> {
      const tab = await approvedTab(context);
      await flush();
      const { fake } = context;
      const details = { requestId: "q1", tabId: tab.id };
      fake.emitWebRequest("onBeforeRequest", {
        ...details,
        timeStamp: 1000,
        frameId: 0,
        url: `${SITE}/api`,
        method: "GET",
        type: "xmlhttprequest",
        documentUrl: `${SITE}/page`,
      });
      fake.emitWebRequest("onSendHeaders", { ...details, timeStamp: 1001, requestHeaders: sent });
      fake.emitWebRequest("onCompleted", {
        ...details,
        timeStamp: 1050,
        statusCode: 200,
        fromCache: false,
        responseHeaders: received,
      });
      return tab;
    }

    it(`answers protocol ${PROTOCOL_VERSION} without headers unless it asks for them`, async () => {
      const context = setup({ networkLog: true });
      const tab = await recordedTab(context);
      const result = await context.callAs(PROTOCOL_VERSION, "s1", "read_network", {
        tabId: tab.id,
        pattern: "/api",
        limit: 10,
      });
      assert.deepEqual(result, {
        recording: true,
        since: 1,
        requests: [request],
        truncated: false,
      });
    });
  });
});

describe("the tools that act in the page", { timeout: 10000 }, () => {
  const REF = "b4";
  const TARGET_REF = "b9";
  const tools: {
    method: "click" | "hover" | "scroll" | "drag" | "type" | "press_key" | "fill_form";
    params: Record<string, unknown>;
    options: Record<string, unknown>;
    bad: [Record<string, unknown>, string];
    reply: Record<string, unknown>;
    badReplies: unknown[];
  }[] = [
    {
      method: "click",
      params: { ref: REF, extra: true },
      options: { ref: REF, button: "left", doubleClick: false },
      bad: [
        { ref: REF, x: 1, y: 2 },
        "click needs either ref or both x and y, not both and not neither.",
      ],
      reply: { ref: REF, x: 10, y: 20.5 },
      badReplies: [
        { ref: "1", x: 10, y: 20 },
        { ref: "0a1b2c3d-4", x: 10, y: 20 },
        { ref: REF, x: -1, y: 0 },
        { ref: REF, x: 1 },
      ],
    },
    {
      method: "hover",
      params: { x: 3, y: 4 },
      options: { x: 3, y: 4 },
      bad: [{}, "hover needs either ref or both x and y, not both and not neither."],
      reply: { ref: REF, x: 3, y: 4 },
      badReplies: [{ ref: REF, x: 3, y: Number.NaN }, Object.create({ ref: REF, x: 3, y: 4 })],
    },
    {
      method: "scroll",
      params: { direction: "down", amount: 300 },
      options: { direction: "down", amount: 300 },
      bad: [{ amount: 300 }, "scroll takes amount only with a direction."],
      reply: { scrollLeft: 0, scrollTop: 300, moved: true },
      badReplies: [
        { scrollLeft: 0, scrollTop: 300 },
        { ref: "x", scrollLeft: 0, scrollTop: 0, moved: true },
      ],
    },
    {
      method: "drag",
      params: { ref: REF, targetX: 5, targetY: 6 },
      options: { ref: REF, targetX: 5, targetY: 6 },
      bad: [
        { ref: REF },
        "drag needs either targetRef or both targetX and targetY for the end, not both and not neither.",
      ],
      reply: { ref: REF, targetRef: TARGET_REF, mode: "html5", dropped: false },
      badReplies: [{ ref: REF, targetRef: TARGET_REF, mode: "native", dropped: true }],
    },
    {
      method: "type",
      params: { ref: REF, text: "hello", extra: true },
      options: { ref: REF, text: "hello" },
      bad: [{ ref: REF, text: "" }, "type needs text to be a string of 1 to 50000 characters."],
      reply: { outcome: "typed", method: "native_setter" },
      badReplies: [
        { outcome: "typed", method: "key_events" },
        { outcome: "failed", method: "exec_command" },
        Object.create({ outcome: "typed", method: "exec_command" }),
      ],
    },
    {
      method: "press_key",
      params: { key: "Shift+Tab", ref: REF },
      options: { key: "Shift+Tab", ref: REF },
      bad: [{ key: 13 }, "press_key needs key to be a string."],
      reply: { action: "focus_moved", prevented: false },
      badReplies: [
        { action: "navigated", prevented: false },
        { action: "none", prevented: "no" },
        { action: "none" },
      ],
    },
    {
      method: "fill_form",
      params: { fields: [{ ref: REF, value: "hello", extra: true }], extra: true },
      options: { fields: [{ ref: REF, value: "hello" }] },
      bad: [{ fields: [] }, "fill_form needs fields to be a list of 1 to 50 fields."],
      reply: { fields: [{ ref: REF, ok: true, outcome: "typed" }] },
      badReplies: [
        { fields: [{ ref: TARGET_REF, ok: true, outcome: "typed" }] },
        { fields: [] },
        { fields: [{ ref: REF, ok: false, code: "page_changed", message: "Gone." }] },
      ],
    },
  ];

  it("refuses a tab id that is not a whole number of 0 or more before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const { method, params } of tools) {
      for (const tabId of [undefined, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
        await assert.rejects(
          call("s1", method, tabId === undefined ? params : { ...params, tabId }),
          {
            code: "invalid_params",
            message: `${method} needs a tab id that is a whole number of 0 or more.`,
          },
        );
      }
    }
    assert.deepEqual(pageCalls, []);
  });

  it("refuses bad options with their sentence before asking the page", async () => {
    const { call, pageCalls } = setup();
    for (const { method, bad } of tools) {
      const [params, message] = bad;
      await assert.rejects(call("s1", method, { tabId: 3, ...params }), {
        code: "invalid_params",
        message,
      });
    }
    assert.deepEqual(pageCalls, []);
  });

  it("asks the page with the parsed options and returns only the result's fields", async () => {
    for (const { method, params, options, reply } of tools) {
      const { call, pageCalls, replyWith } = setup();
      replyWith(async () => ({ ...reply, extra: "page" }));
      assert.deepEqual(await call("s2", method, { tabId: 0, ...params }), {
        ...reply,
        after: UNKNOWN,
      });
      assert.deepEqual(pageCalls, [{ session: "s2", tabId: 0, type: method, params: options }]);
    }
  });

  it("waits for the page after the act and adds what followed, leaving no timer behind", async () => {
    for (const { method, params, reply } of tools) {
      const { call, pageCalls, replyWith, timers } = setup();
      const pending = timers.pending();
      replyWith(async (type) =>
        type === "page_changes"
          ? { state: "current", changes: 2, quietMs: 500 }
          : { ...reply, watch: "w.1", element: { role: "button", name: "Go" } },
      );
      const result = call("s2", method, { tabId: 0, ...params });
      await flush();
      timers.advance(MIN_SETTLE_MS);
      assert.deepEqual(await result, {
        ...reply,
        after: { element: { role: "button", name: "Go" }, page: "changed" },
      });
      assert.deepEqual(
        pageCalls.map(({ type, params }) => [type, params]),
        [
          [method, pageCalls[0]?.params],
          ["page_changes", { watch: "w.1" }],
          ["page_changes", { watch: "w.1" }],
        ],
      );
      assert.equal(timers.pending(), pending, method);
    }
  });

  it("leaves no timer behind when the page refuses the act or its reply", async () => {
    for (const { method, params } of tools) {
      const { call, replyWith, timers } = setup();
      const pending = timers.pending();
      replyWith(() => Promise.reject(new ToolError("stale_ref", "Old.")));
      await assert.rejects(call("s1", method, { tabId: 3, ...params }), { code: "stale_ref" });
      replyWith(async () => "done");
      await assert.rejects(call("s1", method, { tabId: 3, ...params }), { code: "page_error" });
      assert.equal(timers.pending(), pending, method);
    }
  });

  it("marks the act, so wait_for returns at once for a navigation that finished after it", async () => {
    for (const { method, params, reply } of tools) {
      const { fake, call, open, grant, replyWith } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      replyWith(async () => reply);
      await call("s1", method, { tabId: tab.id, ...params });
      fake.navigateByUser(tab.id, "https://a.example/next");
      await flush();
      const result = await call("s1", "wait_for", { tabId: tab.id, navigation: true });
      assert.ok("tab" in result, method);
      assert.equal(result.tab.url, "https://a.example/next", method);
    }
  });

  it("refuses a reply it cannot read as page_error", async () => {
    for (const { method, params, badReplies } of tools) {
      const { call, replyWith } = setup();
      for (const reply of [undefined, null, "done", [], ...badReplies]) {
        replyWith(async () => reply);
        await assert.rejects(call("s1", method, { tabId: 3, ...params }), {
          code: "page_error",
          message: "Foxleash could not complete the request in the page in tab 3.",
        });
      }
    }
  });

  it("sends press_key without a ref when none is given, and refuses a key it cannot read", async () => {
    const { call, pageCalls, replyWith } = setup();
    replyWith(async () => ({ action: "submitted", prevented: false }));
    assert.deepEqual(await call("s1", "press_key", { tabId: 4, key: "enter" }), {
      action: "submitted",
      prevented: false,
      after: UNKNOWN,
    });
    await assert.rejects(call("s1", "press_key", { tabId: 4, key: "Shift+Shift+a" }), {
      code: "invalid_params",
      message:
        "press_key takes only Shift, Control (or Ctrl), Alt and Meta before the key, each at most once and joined with +, such as Control+Shift+a.",
    });
    assert.deepEqual(pageCalls, [
      { session: "s1", tabId: 4, type: "press_key", params: { key: "enter" } },
    ]);
  });

  it("passes the page's refusal through unchanged", async () => {
    for (const { method, params } of tools) {
      const { call, replyWith } = setup();
      const refusal = new ToolError(
        "element_covered",
        `Element ${REF} is covered at its visible centre by element ${TARGET_REF} (div); close or act on that element first.`,
      );
      replyWith(() => Promise.reject(refusal));
      await assert.rejects(
        call("s1", method, { tabId: 3, ...params }),
        (error: unknown) => error === refusal,
      );
    }
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
      message: `Foxleash could not complete the request in the page in tab ${tab.id}.`,
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
    const committed = fake.committedListenerCount();
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
        message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
      });
      assert.equal(fake.listenerCount(), listeners, away);
      assert.equal(fake.committedListenerCount(), committed, away);
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
      message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
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
      message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
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
    const committed = fake.committedListenerCount();
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
    assert.equal(fake.committedListenerCount(), committed);
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

  describe("a frame showing Firefox's error page", () => {
    const FAILED = "https://b.example/frame?x=1&y=a+b";
    const ERROR_PAGE =
      "about:neterror?e=xfoBlocked&u=https%3A//b.example/frame%3Fx%3D1%26y%3Da+b&c=UTF-8&d=x";
    const MISSING = new Error("Missing host permission for the tab or frames");

    async function refusedWithNoImage(
      { fake, call }: ReturnType<typeof setup>,
      tabId: number,
      frameIds: number[],
    ): Promise<void> {
      await assert.rejects(call("s1", "screenshot", { tabId }), {
        code: "screenshot_failed",
        message: `Firefox could not take a screenshot of tab ${tabId}.`,
      });
      await flush();
      assert.deepEqual(fake.captures, []);
      assertMaskedAndRemoved(fake.cssCalls, tabId, frameIds);
    }

    it("is passed over when Firefox reported the frame's document as its error page", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, { frameId: 9, documentId: "err", url: FAILED }]);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 9, documentId: "err", url: ERROR_PAGE });
      fake.failInsertCSS(9, MISSING);
      assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
      await flush();
      assert.equal(fake.captures.length, 1);
      assertMaskedAndRemoved(fake.cssCalls, tab.id, [0, 9]);
    });

    it("refuses when no error page was reported for the frame", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      context.fake.setFrames(tab.id, [0, { frameId: 9, documentId: "err", url: FAILED }]);
      context.fake.failInsertCSS(9, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 9]);
    });

    it("refuses when the error page was another document than the frame shows now", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      context.fake.setFrames(tab.id, [0, { frameId: 9, documentId: "next", url: FAILED }]);
      context.fake.emitDOMContentLoaded({
        tabId: tab.id,
        frameId: 9,
        documentId: "err",
        url: ERROR_PAGE,
      });
      context.fake.failInsertCSS(9, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 9]);
    });

    it("refuses when the URL that failed is not the one the frame shows", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      // The error page's address arrived with the id of the document the frame loaded next.
      context.fake.setFrames(tab.id, [
        0,
        { frameId: 9, documentId: "err", url: "https://c.example/pay" },
      ]);
      context.fake.emitDOMContentLoaded({
        tabId: tab.id,
        frameId: 9,
        documentId: "err",
        url: ERROR_PAGE,
      });
      context.fake.failInsertCSS(9, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 9]);
    });

    it("refuses a frame whose document Firefox reported with its own address", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      const pdf = "https://b.example/doc.pdf";
      context.fake.setFrames(tab.id, [0, { frameId: 9, documentId: "pdf", url: pdf }]);
      context.fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 9, documentId: "pdf", url: pdf });
      context.fake.failInsertCSS(9, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 9]);
    });

    for (const [missing, frame] of [
      ["a document id", { frameId: 9, url: FAILED }],
      ["an address", { frameId: 9, documentId: "err" }],
    ] as const) {
      it(`refuses a frame listed without ${missing}`, async () => {
        const context = setup();
        await context.grant("https://a.example");
        const tab = await context.open("s1", "https://a.example/");
        context.fake.setFrames(tab.id, [0, frame]);
        context.fake.emitDOMContentLoaded({
          tabId: tab.id,
          frameId: 9,
          documentId: "err",
          url: ERROR_PAGE,
        });
        context.fake.failInsertCSS(9, MISSING);
        await refusedWithNoImage(context, tab.id, [0, 9]);
      });
    }

    it("refuses when the error page was reported in another tab", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      context.fake.setFrames(tab.id, [0, { frameId: 9, documentId: "err", url: FAILED }]);
      context.fake.emitDOMContentLoaded({
        tabId: tab.id + 1,
        frameId: 9,
        documentId: "err",
        url: ERROR_PAGE,
      });
      context.fake.failInsertCSS(9, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 9]);
    });

    it("refuses when the top frame refuses the sheet, error page or not", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      context.fake.setFrames(tab.id, [{ frameId: 0, documentId: "err", url: FAILED }, 5]);
      context.fake.emitDOMContentLoaded({
        tabId: tab.id,
        frameId: 0,
        documentId: "err",
        url: ERROR_PAGE,
      });
      context.fake.failInsertCSS(0, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 5]);
    });

    it("refuses when another frame refuses the sheet", async () => {
      const context = setup();
      await context.grant("https://a.example");
      const tab = await context.open("s1", "https://a.example/");
      context.fake.setFrames(tab.id, [0, { frameId: 9, documentId: "err", url: FAILED }, 5]);
      context.fake.emitDOMContentLoaded({
        tabId: tab.id,
        frameId: 9,
        documentId: "err",
        url: ERROR_PAGE,
      });
      context.fake.failInsertCSS(9, MISSING);
      context.fake.failInsertCSS(5, MISSING);
      await refusedWithNoImage(context, tab.id, [0, 9, 5]);
    });

    it("refuses when the top document refuses the input mask", async () => {
      const { fake, call, open, grant, replyWith } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, { frameId: 9, documentId: "err", url: FAILED }]);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 9, documentId: "err", url: ERROR_PAGE });
      fake.failInsertCSS(9, MISSING);
      replyWith(async () => ({ revealed: true }));
      const insertCSS = fake.browser.scripting.insertCSS;
      fake.browser.scripting.insertCSS = async (injection) => {
        await insertCSS(injection);
        if (injection.css.startsWith(INPUT_MASK_CSS)) throw MISSING;
      };
      await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
        code: "screenshot_failed",
        message: `Firefox could not take a screenshot of tab ${tab.id}.`,
      });
      await flush();
      assert.deepEqual(fake.captures, []);
      const inserts = fake.cssCalls.filter((css) => css.method === "insertCSS");
      assert.deepEqual(
        inserts.map((css) => css.frameIds),
        [[0], [9], [0]],
      );
      assert.deepEqual(fake.cssCalls, [
        ...inserts,
        ...inserts.map((css) => ({ ...css, method: "removeCSS" })),
      ]);
    });

    it("still times out when the frame's sheet never goes in", async () => {
      const { fake, call, open, grant, timers } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [{ frameId: 9, documentId: "err", url: FAILED }, 0]);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 9, documentId: "err", url: ERROR_PAGE });
      const release = fake.holdNextInsertCSS();
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      timers.advance(CAPTURE_TIMEOUT_MS);
      await assert.rejects(shot, {
        code: "page_timeout",
        message: `Firefox did not take the screenshot of tab ${tab.id} in time; try again.`,
      });
      await flush();
      assert.deepEqual(fake.captures, []);
      const [held, top] = fake.cssCalls;
      assert.deepEqual(held?.frameIds, [9]);
      assert.deepEqual(fake.cssCalls, [held, top, { ...top, method: "removeCSS" }]);
      release();
      await flush();
      assert.deepEqual(fake.cssCalls.slice(3), [{ ...held, method: "removeCSS" }]);
    });
  });

  describe("another add-on's frame", () => {
    const ADDON = "moz-extension://0b5e2f4c-1d2e-4f3a-9b8c-7d6e5f4a3b2c/infield.html";
    const MISSING = new Error("Missing host permission for the tab or frames");
    const FAILED = "https://b.example/frame";
    const ERROR_PAGE = "about:neterror?e=xfoBlocked&u=https%3A//b.example/frame&c=UTF-8&d=x";
    const SUBFRAME: FrameDetails = {
      frameId: 5,
      documentId: "page",
      url: "https://b.example/",
      parentFrameId: 0,
    };

    function addonFrame(frameId: number, parentFrameId: number): FrameDetails {
      return { frameId, documentId: `addon-${frameId}`, url: ADDON, parentFrameId };
    }

    /** Exactly these sheets went in, in this order, each with the screenshot's marker, and each was removed. */
    function assertSheets(
      calls: CssCall[],
      tabId: number,
      sheets: readonly (readonly [number, string])[],
    ): void {
      const inserts = calls.filter((css) => css.method === "insertCSS");
      const marker = inserts[0]?.css.slice(FIELD_MASK_CSS.length) ?? "";
      assert.match(marker, /^\/\* [0-9a-f-]{36} \*\/\n$/);
      assert.deepEqual(
        inserts,
        sheets.map(([frameId, css]) => ({
          method: "insertCSS",
          tabId,
          frameIds: [frameId],
          css: css + marker,
          origin: "USER",
        })),
      );
      const removals = calls.slice(inserts.length);
      assert.deepEqual(
        removals.map((css) => JSON.stringify(css)).sort(),
        inserts.map((css) => JSON.stringify({ ...css, method: "removeCSS" })).sort(),
      );
    }

    /** Whether each insertion, in call order, was taken or refused, once it settles. */
    function insertOutcomes(fake: FakeBrowser): string[] {
      const outcomes: string[] = [];
      const insertCSS = fake.browser.scripting.insertCSS;
      fake.browser.scripting.insertCSS = (injection) => {
        const index = outcomes.push("pending") - 1;
        const insert = insertCSS(injection);
        insert.then(
          () => {
            outcomes[index] = "taken";
          },
          () => {
            outcomes[index] = "refused";
          },
        );
        return insert;
      };
      return outcomes;
    }

    async function refused({ fake, call }: ReturnType<typeof setup>, tabId: number) {
      await assert.rejects(call("s1", "screenshot", { tabId }), {
        code: "screenshot_failed",
        message: `Firefox could not take a screenshot of tab ${tabId}.`,
      });
      await flush();
      assert.deepEqual(fake.captures, []);
    }

    it("is captured with its document's frames hidden when it refuses the sheet", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, addonFrame(7, 0), SUBFRAME]);
      fake.failInsertCSS(7, MISSING);
      const release = fake.holdNextCapture();
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      assert.equal(fake.captures.length, 1);
      const atCapture = structuredClone(fake.cssCalls);
      release();
      assert.deepEqual(await shot, { data: PNG });
      await flush();
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [5, FIELD_MASK_CSS],
        [0, FRAME_HIDE_CSS],
      ]);
      // Every sheet was in before the capture, and none was removed before it.
      assert.deepEqual(atCapture, fake.cssCalls.slice(0, 4));
    });

    it("passes over a page frame inside it that refuses the sheet", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, addonFrame(7, 0), { ...SUBFRAME, frameId: 8, parentFrameId: 7 }]);
      fake.failInsertCSS(7, MISSING);
      fake.failInsertCSS(8, MISSING);
      assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
      await flush();
      assert.equal(fake.captures.length, 1);
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [8, FIELD_MASK_CSS],
        [0, FRAME_HIDE_CSS],
      ]);
    });

    it("hides the frames of a subframe that holds it in that subframe only", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      // A frame id listed as a number hangs from the top frame.
      fake.setFrames(tab.id, [0, 5, addonFrame(7, 5)]);
      fake.failInsertCSS(7, MISSING);
      assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
      await flush();
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [5, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [5, FRAME_HIDE_CSS],
      ]);
    });

    it("refuses when the frame hiding sheet does not go in", async () => {
      const context = setup();
      const { fake, grant, open } = context;
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, addonFrame(7, 0)]);
      fake.failInsertCSS(0, MISSING, FRAME_HIDE_CSS);
      fake.failInsertCSS(7, MISSING);
      const outcomes = insertOutcomes(fake);
      await refused(context, tab.id);
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [0, FRAME_HIDE_CSS],
      ]);
      assert.deepEqual(outcomes, ["taken", "refused", "refused"]);
    });

    it("refuses when the frame hiding sheet does not go into a subframe showing an error page", async () => {
      const context = setup();
      const { fake, grant, open } = context;
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const failed = { frameId: 5, documentId: "err", url: FAILED, parentFrameId: 0 };
      fake.setFrames(tab.id, [0, failed, addonFrame(7, 5)]);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 5, documentId: "err", url: ERROR_PAGE });
      fake.failInsertCSS(5, MISSING, FRAME_HIDE_CSS);
      fake.failInsertCSS(7, MISSING);
      const outcomes = insertOutcomes(fake);
      await refused(context, tab.id);
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [5, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [5, FRAME_HIDE_CSS],
      ]);
      // Only the hiding sheet was refused in the frame showing its error page.
      assert.deepEqual(outcomes, ["taken", "taken", "refused", "refused"]);
    });

    it("still refuses a web page frame beside it that refuses the sheet", async () => {
      const context = setup();
      const { fake, grant, open } = context;
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, addonFrame(7, 0), SUBFRAME]);
      fake.failInsertCSS(7, MISSING);
      fake.failInsertCSS(5, MISSING);
      await refused(context, tab.id);
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [5, FIELD_MASK_CSS],
        [0, FRAME_HIDE_CSS],
      ]);
    });

    it("still refuses a frame of Foxleash's own pages that refuses the sheet, hiding nothing", async () => {
      const context = setup();
      const { fake, grant, open } = context;
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const own = fake.browser.runtime.getURL("prompt.html");
      fake.setFrames(tab.id, [0, { frameId: 7, documentId: "own", url: own, parentFrameId: 0 }]);
      fake.failInsertCSS(7, MISSING);
      await refused(context, tab.id);
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
      ]);
    });

    it("hides nothing in a page with only web page frames", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, SUBFRAME, { ...SUBFRAME, frameId: 6, parentFrameId: 5 }]);
      assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
      await flush();
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [5, FIELD_MASK_CSS],
        [6, FIELD_MASK_CSS],
      ]);
    });

    it("refuses, inserting nothing, when its parent is not listed", async () => {
      const context = setup();
      const { fake, grant, open } = context;
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, addonFrame(7, 4)]);
      await refused(context, tab.id);
      assert.deepEqual(fake.cssCalls, []);
    });

    it("passes over an error page frame beside it too", async () => {
      const { fake, call, open, grant } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const failed = { frameId: 9, documentId: "err", url: FAILED, parentFrameId: 0 };
      fake.setFrames(tab.id, [0, failed, addonFrame(7, 0)]);
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 9, documentId: "err", url: ERROR_PAGE });
      fake.failInsertCSS(9, MISSING);
      fake.failInsertCSS(7, MISSING);
      assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
      await flush();
      assertSheets(fake.cssCalls, tab.id, [
        [0, FIELD_MASK_CSS],
        [9, FIELD_MASK_CSS],
        [7, FIELD_MASK_CSS],
        [0, FRAME_HIDE_CSS],
      ]);
    });

    it("times out when the frame hiding sheet never goes in", async () => {
      const { fake, call, open, grant, timers } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      fake.setFrames(tab.id, [0, addonFrame(7, 0)]);
      fake.failInsertCSS(7, MISSING);
      const release = fake.holdNextInsertCSS(FRAME_HIDE_CSS);
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      timers.advance(CAPTURE_TIMEOUT_MS);
      await assert.rejects(shot, {
        code: "page_timeout",
        message: `Firefox did not take the screenshot of tab ${tab.id} in time; try again.`,
      });
      await flush();
      assert.deepEqual(fake.captures, []);
      const [top, addon, hide] = fake.cssCalls;
      assert.ok(hide?.css.startsWith(FRAME_HIDE_CSS));
      // Every sheet but the held one is gone; that one goes once it settles.
      assert.deepEqual(
        fake.cssCalls
          .slice(3)
          .map((css) => JSON.stringify(css))
          .sort(),
        [top, addon].map((css) => JSON.stringify({ ...css, method: "removeCSS" })).sort(),
      );
      release();
      await flush();
      assert.deepEqual(fake.cssCalls.slice(5), [{ ...hide, method: "removeCSS" }]);
    });
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
    const committed = fake.committedListenerCount();
    const release = fake.holdNextRemoveCSS();
    assert.deepEqual(await call("s1", "screenshot", { tabId: tab.id }), { data: PNG });
    assert.equal(fake.committedListenerCount(), committed);
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
      message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
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
      message: `Foxleash could not complete the request in the page in tab ${tab.id}.`,
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
      const committed = fake.committedListenerCount();
      const release = hold(ctx);
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      fake.emitCommitted({ tabId: tab.id, frameId: 3, url: "https://ads.example/next" });
      release();
      await assert.rejects(shot, {
        code: "page_changed",
        message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
      });
      assert.equal(fake.committedListenerCount(), committed);
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
      message: `Foxleash did not finish the screenshot of tab ${tab.id} in time; try again.`,
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
      message: `Foxleash did not finish the screenshot of tab ${tab.id} in time; try again.`,
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
        `The page in tab ${tabId} changed while Foxleash was working in it; try again.`,
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
        `The page in tab ${tabId} changed while Foxleash was working in it; try again.`,
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

  describe("waits for a navigation under way", () => {
    const NEXT = "https://a.example/next";

    it("before its first gate, then captures the page the navigation brings", async () => {
      const { fake, call, open, grant, pageCalls, timers } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const timersBefore = timers.pending();
      beginNavigation(fake, tab.id, NEXT);
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      timers.advance(NAVIGATION_WAIT_MS - 1);
      await flush();
      assert.deepEqual(pageCalls, []);
      assert.deepEqual(fake.captures, []);
      assert.deepEqual(fake.cssCalls, []);
      landNavigation(fake, tab.id, NEXT);
      assert.deepEqual(await shot, { data: PNG });
      assert.equal(fake.captures.length, 1);
      assert.equal(pageCalls.length, 2);
      assert.equal(timers.pending(), timersBefore);
    });

    it("fails with page_loading when the tab is still loading at the bound", async () => {
      const { fake, call, open, grant, pageCalls, timers } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const timersBefore = timers.pending();
      const listeners = fake.listenerCount();
      beginNavigation(fake, tab.id, NEXT);
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
      timers.advance(NAVIGATION_WAIT_MS - 1);
      await flush();
      assert.equal(settled, false);
      timers.advance(1);
      await assert.rejects(shot, {
        code: "page_loading",
        message: `Tab ${tab.id} is still loading a page; try again.`,
      });
      assert.deepEqual(pageCalls, []);
      assert.deepEqual(fake.captures, []);
      assert.equal(timers.pending(), timersBefore);
      assert.equal(fake.listenerCount(), listeners);
    });

    it("waits once when the first gate meets the swap of a navigation that began during it", async (t) => {
      const { fake, call, open, grant, pageCalls } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const listeners = fake.listenerCount();
      const committed = fake.committedListenerCount();
      const get = fake.browser.tabs.get;
      let gets = 0;
      t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
        gets += 1;
        // The first is the group check before any wait; the second, the first gate's.
        if (gets === 2) {
          beginNavigation(fake, tabId, NEXT);
          swapDocument(fake, tabId);
        }
        return get(tabId);
      });
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      assert.deepEqual(pageCalls, []);
      landNavigation(fake, tab.id, NEXT);
      assert.deepEqual(await shot, { data: PNG });
      assert.equal(fake.captures.length, 1);
      assert.equal(fake.listenerCount(), listeners);
      assert.equal(fake.committedListenerCount(), committed);
    });

    it("refuses a second swap at its first gate", async (t) => {
      const { fake, call, open, grant, pageCalls } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const listeners = fake.listenerCount();
      const committed = fake.committedListenerCount();
      const get = fake.browser.tabs.get;
      let gets = 0;
      t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
        gets += 1;
        // The first is the group check before any wait; the second, the first gate's.
        if (gets === 2) {
          beginNavigation(fake, tabId, NEXT);
          swapDocument(fake, tabId);
        }
        return get(tabId);
      });
      const shot = call("s1", "screenshot", { tabId: tab.id });
      await flush();
      landNavigation(fake, tab.id, NEXT);
      // The page's own script moves on as soon as it is parsed.
      beginNavigation(fake, tab.id, "https://a.example/last");
      swapDocument(fake, tab.id);
      await rejectsWith(shot, "page_not_web");
      assert.deepEqual(pageCalls, []);
      assert.deepEqual(fake.captures, []);
      assert.equal(fake.listenerCount(), listeners);
      assert.equal(fake.committedListenerCount(), committed);
    });

    it("checks the group the same way whether or not a tab outside it is loading", async (t) => {
      const { fake, call, open } = setup();
      await open("s1");
      const outside = fake.openTab({ url: "https://a.example/" });
      const get = t.mock.method(fake.browser.tabs, "get");
      await rejectsWith(call("s1", "screenshot", { tabId: outside.id }), "tab_not_in_group");
      const idle = get.mock.callCount();
      beginNavigation(fake, outside.id, NEXT);
      await rejectsWith(call("s1", "screenshot", { tabId: outside.id }), "tab_not_in_group");
      assert.equal(get.mock.callCount(), 2 * idle);
    });

    it("refuses a tab outside the session's group, or one that does not exist, without waiting", async () => {
      const { fake, call, open, grant, pageCalls, timers } = setup();
      await grant("https://a.example");
      const tab = await open("s1", "https://a.example/");
      const other = await open("s2", "https://a.example/");
      const outside = fake.openTab({ url: "https://a.example/" });
      const timersBefore = timers.pending();
      for (const tabId of [tab.id, other.id, outside.id, 99]) beginNavigation(fake, tabId, NEXT);
      for (const [session, tabId, code] of [
        ["s1", other.id, "tab_not_in_group"],
        ["s1", outside.id, "tab_not_in_group"],
        ["s2", tab.id, "tab_not_in_group"],
        ["s1", 99, "tab_not_found"],
      ] as const) {
        await rejectsWith(call(session, "screenshot", { tabId }), code, `${session} ${tabId}`);
      }
      assert.deepEqual(pageCalls, []);
      assert.deepEqual(fake.captures, []);
      assert.equal(timers.pending(), timersBefore);
    });
  });
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
        "upload_chunk got a chunk out of order; Foxleash expected chunk 0 of that upload.",
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
  const REF = "b5";

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
      after: UNKNOWN,
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

  it("waits for the page after the upload and adds what followed, leaving no timer behind", async () => {
    const { call, pageCalls, replyWith, timers } = setup();
    const pending = timers.pending();
    replyWith(async (type) =>
      type === "page_changes"
        ? { state: "current", changes: 0, quietMs: 500 }
        : { target: "input", watch: "w.1", element: { role: "button", name: "Browse…" } },
    );
    const result = call("s1", "upload_file", {
      tabId: 0,
      ref: REF,
      upload: "none",
      files: [{ name: "empty.txt", type: "text/plain", size: 0 }],
    });
    await flush();
    timers.advance(MIN_SETTLE_MS);
    assert.deepEqual(await result, {
      target: "input",
      files: [{ name: "empty.txt", size: 0 }],
      after: { element: { role: "button", name: "Browse…" }, page: "unchanged" },
    });
    assert.deepEqual(
      pageCalls.map(({ type }) => type),
      ["upload_file", "page_changes", "page_changes"],
    );
    assert.equal(timers.pending(), pending);
    replyWith(async () => ({ target: "elsewhere" }));
    await call("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
    await assert.rejects(call("s1", "upload_file", valid()), { code: "page_error" });
    assert.equal(timers.pending(), pending);
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
    assert.deepEqual(result, {
      target: "input",
      files: [{ name: "empty.txt", size: 0 }],
      after: UNKNOWN,
    });
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
    assert.deepEqual(result, { target: "input", files: [{ name, size: 0 }], after: UNKNOWN });
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
          message: `The files of upload_file add up to ${size} bytes, but Foxleash holds ${held} for that upload.`,
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
      message: "The files of upload_file add up to 1 bytes, but Foxleash holds 0 for that upload.",
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
      message: "The files of upload_file add up to 1 bytes, but Foxleash holds 0 for that upload.",
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
          message: "Foxleash could not complete the request in the page in tab 3.",
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

describe("download", { timeout: 10000 }, () => {
  const BAD_NAME =
    "download needs filename to be a plain file name such as receipt.pdf: at most 200 bytes in UTF-8, no slash or backslash, no control or formatting characters, not starting with a dot.";

  it("refuses a URL that is not http or https before saving", async () => {
    const { call, saves } = setup();
    for (const url of ["ftp://a.example/x", "file:///etc/passwd", "not a url", "about:blank"]) {
      await assert.rejects(call("s1", "download", { url, filename: "x.pdf" }), {
        code: "invalid_url",
        message: "Foxleash downloads only http and https URLs.",
      });
    }
    assert.deepEqual(saves, []);
  });

  it("refuses an address starting with / and says what to do instead", async () => {
    const { call, saves } = setup();
    for (const url of ["/x.pdf", "/"]) {
      await assert.rejects(call("s1", "download", { url, filename: "x.pdf" }), {
        code: "invalid_url",
        message:
          "download needs a whole http or https URL. An address starting with / from read_page is on the site of the page it was read from: put that site in front of it.",
      });
    }
    await assert.rejects(call("s1", "download", { url: "//a.example/x", filename: "x.pdf" }), {
      code: "invalid_url",
      message: "Foxleash downloads only http and https URLs.",
    });
    assert.deepEqual(saves, []);
  });

  it("refuses a url that is not a string", async () => {
    const { call, saves } = setup();
    for (const params of [{ filename: "x.pdf" }, { url: 1, filename: "x.pdf" }]) {
      await assert.rejects(call("s1", "download", params), {
        code: "invalid_params",
        message: "download needs url to be a string.",
      });
    }
    assert.deepEqual(saves, []);
  });

  it("refuses a filename that is not a plain file name before saving", async () => {
    const { call, saves } = setup();
    for (const filename of [undefined, 1, "", "a/b.pdf", ".x.pdf"]) {
      const params = filename === undefined ? {} : { filename };
      await assert.rejects(call("s1", "download", { url: "https://a.example/x", ...params }), {
        code: "invalid_params",
        message: BAD_NAME,
      });
    }
    assert.deepEqual(saves, []);
  });

  it("saves the parsed URL under the name, for the session, and returns the result", async () => {
    const { call, saves } = setup();
    const result = await call("s1", "download", {
      url: "HTTPS://A.example/x",
      filename: "receipt.pdf",
    });
    assert.deepEqual(saves, [
      { session: "s1", url: "https://a.example/x", filename: "receipt.pdf", generation: 0 },
    ]);
    assert.deepEqual(result, { path: "/downloads/receipt.pdf", bytes: 3 });
  });

  it("passes the generation read on arrival", async () => {
    const { call, saves, access } = setup();
    access.endSession("s1");
    await call("s1", "download", { url: "https://a.example/x", filename: "receipt.pdf" });
    assert.deepEqual(
      saves.map(({ generation }) => generation),
      [1],
    );
  });
});

describe("the view of the page that results end with", { timeout: 10000 }, () => {
  const SITE = "https://a.example";
  const TREE = 'main\n heading "Shop" [a1]\n button "Add" [a2]\n status';
  const ADDED = 'main\n heading "Shop" [a1]\n button "Add" [a2]\n status\n  text "Added"';
  const CLICKED = { ref: "a2", x: 1, y: 2 };
  const READ = { session: "s1", type: "read_page", params: { filter: "all" } };

  /**
   * A tab on SITE in s1's group whose document is live, opened without a view; the page answers
   * read_page with `tree`, wait_for with true and anything else with CLICKED.
   */
  async function viewed() {
    const context = setup({ pageViews: true });
    await context.grant(SITE);
    const page = { tree: TREE, truncated: false };
    context.replyWith(async (type) => {
      if (type === "read_page") return { ...page };
      return type === "wait_for" ? true : CLICKED;
    });
    const tab = await context.open("s1", `${SITE}/`);
    await flush();
    assert.ok(context.views.document(tab.id) !== undefined);
    const click = (params: Record<string, unknown> = {}) =>
      context.callWithView("s1", "click", { tabId: tab.id, ref: "a2", ...params });
    return { ...context, tab, page, click };
  }

  /** The reads of the page a view made, as the page was asked for them. */
  function reads(pageCalls: readonly PageCall[]): PageCall[] {
    return pageCalls.filter(({ type }) => type === "read_page");
  }

  it("ends tab_open, navigate and wait_for with the tree, read as read_page reads it", async () => {
    const { grant, callWithView, replyWith, pageCalls } = setup({ pageViews: true });
    await grant(SITE);
    replyWith(async (type) => (type === "read_page" ? { tree: TREE, truncated: false } : true));
    const tree = { kind: "tree", tree: TREE, omitted: 0, truncated: false };
    const opened = await callWithView("s1", "tab_open", { url: `${SITE}/` });
    assert.ok("tab" in opened && "view" in opened);
    assert.deepEqual(opened.view, tree);
    const tabId = opened.tab.id;
    assert.deepEqual(pageCalls, [{ ...READ, tabId }]);
    const moved = await callWithView("s1", "navigate", { tabId, url: `${SITE}/next` });
    assert.ok("view" in moved);
    assert.deepEqual(moved.view, tree);
    await flush();
    const waited = await callWithView("s1", "wait_for", { tabId, selector: "main" });
    assert.ok("view" in waited);
    assert.deepEqual(waited.view, { kind: "unchanged", truncated: false });
    assert.deepEqual(
      pageCalls.map(({ type }) => type),
      ["read_page", "read_page", "wait_for", "read_page"],
    );
  });

  it("ends an act with the lines that changed since the last view, or a line saying none did", async () => {
    const { click, page, timers } = await viewed();
    const pending = timers.pending();
    assert.deepEqual(await click(), {
      ...CLICKED,
      after: UNKNOWN,
      view: { kind: "tree", tree: TREE, omitted: 0, truncated: false },
    });
    page.tree = ADDED;
    assert.deepEqual((await click()) as unknown, {
      ...CLICKED,
      after: UNKNOWN,
      view: { kind: "changes", lines: '  main\n   status\n+   text "Added"', truncated: false },
    });
    assert.deepEqual(((await click()) as { view?: unknown }).view, {
      kind: "unchanged",
      truncated: false,
    });
    assert.equal(timers.pending(), pending);
  });

  it("ends upload_file with a view, after what followed the upload", async () => {
    const { callWithView, tab, replyWith, page } = await viewed();
    replyWith(async (type) => (type === "read_page" ? { ...page } : { target: "input" }));
    assert.deepEqual(
      await callWithView("s1", "upload_file", {
        tabId: tab.id,
        ref: "a2",
        upload: "none",
        files: [{ name: "empty.txt", type: "text/plain", size: 0 }],
      }),
      {
        target: "input",
        files: [{ name: "empty.txt", size: 0 }],
        after: UNKNOWN,
        view: { kind: "tree", tree: TREE, omitted: 0, truncated: false },
      },
    );
  });

  it("leaves the view out with view false: nothing is read or recorded", async () => {
    const { click, pageCalls, tab, callWithView } = await viewed();
    assert.deepEqual(await click({ view: false }), { ...CLICKED, after: UNKNOWN });
    const blank = await callWithView("s1", "tab_open", { view: false });
    assert.deepEqual(Object.keys(blank), ["tab"]);
    for (const [method, params] of [
      ["navigate", { tabId: tab.id, url: `${SITE}/next`, view: false }],
      ["wait_for", { tabId: tab.id, selector: "main", view: false }],
    ] as const) {
      assert.deepEqual(Object.keys(await callWithView("s1", method, params)), ["tab"], method);
    }
    assert.deepEqual(reads(pageCalls), []);
    await flush();
    assert.equal(((await click({ view: true })) as { view?: { kind: string } }).view?.kind, "tree");
  });

  it("refuses a view that is not true or false before anything acts", async () => {
    const { callWithView, pageCalls, fake, uploads } = setup({ pageViews: true });
    const tabs = fake.tabs.size;
    const tools: [MethodName, Record<string, unknown>][] = [
      ["tab_open", {}],
      ["navigate", { tabId: 1, url: `${SITE}/` }],
      ["wait_for", { tabId: 1, text: "x" }],
      ["upload_file", { tabId: 1, ref: "a2", upload: "u1", files: [] }],
      ["click", { tabId: 1, ref: "a2" }],
      ["hover", { tabId: 1, ref: "a2" }],
      ["scroll", { tabId: 1, ref: "a2" }],
      ["drag", { tabId: 1, ref: "a2", targetRef: "a1" }],
      ["type", { tabId: 1, ref: "a2", text: "x" }],
      ["press_key", { tabId: 1, key: "Enter" }],
      ["fill_form", { tabId: 1, fields: [{ ref: "a2", value: "x" }] }],
    ];
    for (const [method, params] of tools) {
      for (const view of ["true", 1, null, {}]) {
        await callWithView("s1", "upload_chunk", { upload: "u1", index: 0, data: "AQ==" });
        await assert.rejects(callWithView("s1", method, { ...params, view }), {
          code: "invalid_params",
          message: `${method} needs view to be true or false.`,
        });
        // The upload's bytes are taken first, so a refused upload_file leaves nothing staged.
        assert.equal(uploads.take("s1", "u1") === undefined, method === "upload_file", method);
      }
    }
    assert.deepEqual(pageCalls, []);
    assert.equal(fake.tabs.size, tabs);
  });

  it("shows only the site of a page the session may not read, with no title, and forgets it", async () => {
    for (const code of ["site_not_approved", "site_blocked"]) {
      const { click, replyWith, page, fake, tab } = await viewed();
      await click();
      const tabInfo = fake.tabs.get(tab.id);
      assert.ok(tabInfo !== undefined);
      tabInfo.title = "Secret title";
      replyWith(async (type) => {
        if (type === "read_page") throw new ToolError(code, "Refused.");
        return CLICKED;
      });
      assert.deepEqual(((await click()) as { view?: unknown }).view, {
        kind: "site",
        url: `${SITE}/`,
      });
      replyWith(async (type) => (type === "read_page" ? { ...page } : CLICKED));
      // Forgotten: the next view is the whole tree again, not "nothing changed".
      assert.equal(((await click()) as { view?: { kind: string } }).view?.kind, "tree", code);
    }
  });

  it("shows a page on a site the user did not approve as its site alone", async () => {
    const { click, replyWith, fake } = await viewed();
    await revokeSite(fake.browser, SITE);
    replyWith(async (type) => {
      if (type === "read_page") throw new ToolError("site_not_approved", "Refused.");
      return CLICKED;
    });
    assert.deepEqual(((await click()) as { view?: unknown }).view, { kind: "site", url: SITE });
  });

  it("gives the unreadable line for a refused page whose tab left the session's group", async () => {
    const { click, replyWith, fake, tab } = await viewed();
    replyWith(async (type) => {
      if (type !== "read_page") return CLICKED;
      fake.ungroup(tab.id);
      throw new ToolError("site_not_approved", "Refused.");
    });
    assert.deepEqual(((await click()) as { view?: unknown }).view, {
      kind: "none",
      reason: "unreadable",
    });
  });

  it("shows, and does not record, a tree read while the tab has no live document", async () => {
    const { fake, open, callWithView, replyWith, views, sessions } = setup({ pageViews: true });
    replyWith(async (type) => (type === "read_page" ? { tree: TREE, truncated: false } : CLICKED));
    const tab = await open("s1");
    // Committed before its site was approved, and approved without any change that catches up.
    fake.navigateByUser(tab.id, `${SITE}/`);
    await flush();
    sessions.set("s1", state([SITE]));
    await flush();
    assert.equal(views.document(tab.id), undefined);
    for (let call = 0; call < 2; call += 1) {
      const result = await callWithView("s1", "click", { tabId: tab.id, ref: "a2" });
      assert.deepEqual((result as { view?: unknown }).view, {
        kind: "tree",
        tree: TREE,
        omitted: 0,
        truncated: false,
      });
    }
  });

  it("shows, and does not record, a tree read while the tab committed another document", async () => {
    const { click, replyWith, fake, tab, page } = await viewed();
    replyWith(async (type) => {
      if (type !== "read_page") return CLICKED;
      fake.navigateByUser(tab.id, `${SITE}/next`);
      return { ...page };
    });
    await click();
    replyWith(async (type) => (type === "read_page" ? { ...page } : CLICKED));
    await flush();
    assert.equal(((await click()) as { view?: { kind: string } }).view?.kind, "tree");
  });

  it("says a page that is not a web page has no tree, and forgets the last view", async () => {
    const { click, replyWith, page } = await viewed();
    await click();
    replyWith(async (type) => {
      if (type === "read_page") throw new ToolError("page_not_web", "Not a web page.");
      return CLICKED;
    });
    assert.deepEqual(((await click()) as { view?: unknown }).view, {
      kind: "none",
      reason: "not_web",
    });
    replyWith(async (type) => (type === "read_page" ? { ...page } : CLICKED));
    assert.equal(((await click()) as { view?: { kind: string } }).view?.kind, "tree");
  });

  it("keeps the act's result, and the last view, when the view's read fails", async () => {
    const { click, replyWith, page } = await viewed();
    await click();
    for (const failure of [
      () => Promise.reject(new ToolError("page_error", "Failed.")),
      () => Promise.reject(new Error("Gone.")),
      async () => ({ tree: 1, truncated: false }),
      async () => ({ tree: "x".repeat(READ_PAGE_MAX_CHARS + 1), truncated: false }),
      async () => ({ tree: TREE }),
      async () => Object.create({ tree: TREE, truncated: false }),
    ]) {
      replyWith((type) => (type === "read_page" ? failure() : Promise.resolve(CLICKED)));
      assert.deepEqual(await click(), {
        ...CLICKED,
        after: UNKNOWN,
        view: { kind: "none", reason: "unreadable" },
      });
    }
    replyWith(async (type) => (type === "read_page" ? { ...page } : CLICKED));
    assert.deepEqual(((await click()) as { view?: unknown }).view, {
      kind: "unchanged",
      truncated: false,
    });
  });

  it("stops waiting for the view's read after VIEW_READ_MS, leaving no timer behind", async () => {
    const { click, replyWith, timers } = await viewed();
    const pending = timers.pending();
    replyWith((type) => (type === "read_page" ? new Promise(() => {}) : Promise.resolve(CLICKED)));
    let done = false;
    const result = click().finally(() => {
      done = true;
    });
    await flush();
    timers.advance(VIEW_READ_MS - 1);
    await flush();
    assert.equal(done, false);
    timers.advance(1);
    assert.deepEqual(await result, {
      ...CLICKED,
      after: UNKNOWN,
      view: { kind: "none", reason: "unreadable" },
    });
    assert.equal(timers.pending(), pending);
  });

  it("reads no view once VIEW_START_LIMIT_MS of the call has passed", async () => {
    for (const [elapsed, kind] of [
      [VIEW_START_LIMIT_MS, "tree"],
      [VIEW_START_LIMIT_MS + 1, "none"],
    ] as const) {
      const { click, replyWith, timers, page, pageCalls } = await viewed();
      replyWith(async (type) => {
        if (type === "read_page") return { ...page };
        timers.advance(elapsed);
        return CLICKED;
      });
      assert.equal(((await click()) as { view?: { kind: string } }).view?.kind, kind);
      assert.equal(reads(pageCalls).length, kind === "tree" ? 1 : 0);
    }
  });

  it("gives no view once the act's tab closed, and no read while it loads another page", async () => {
    for (const closes of [true, false]) {
      const { click, replyWith, fake, tab, timers, pageCalls } = await viewed();
      replyWith(async () => {
        fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url: `${SITE}/next` });
        fake.emitStatus(tab.id, "loading");
        return CLICKED;
      });
      const result = click();
      await flush();
      if (closes) fake.removeTab(tab.id);
      else timers.advance(NAVIGATION_WAIT_MS);
      assert.deepEqual(
        await result,
        closes
          ? { ...CLICKED, after: { page: "closed" } }
          : { ...CLICKED, after: { page: "loading" }, view: { kind: "none", reason: "loading" } },
      );
      assert.deepEqual(reads(pageCalls), []);
    }
  });

  it("keeps the act's element, and the lines around it, in a view cut to its budget", async () => {
    const links = Array.from({ length: 1500 }, (_, index) => ` link "Item ${index}" [l${index}]`);
    links.splice(1000, 0, ' button "Act here" [b4]');
    links.splice(1200, 0, ' button "Drop here" [b9]');
    const big = ["main [m1]", ...links].join("\n");
    const acts: [MethodName, Record<string, unknown>, unknown, string[]][] = [
      ["click", { x: 1, y: 2 }, { ref: "b4", x: 1, y: 2 }, ["b4"]],
      ["hover", { ref: "b4" }, { ref: "b4", x: 1, y: 2 }, ["b4"]],
      ["scroll", { ref: "b4" }, { scrollLeft: 0, scrollTop: 0, moved: false }, ["b4"]],
      [
        "drag",
        { ref: "b4", targetX: 1, targetY: 2 },
        { ref: "b4", targetRef: "b9", mode: "pointer", dropped: false },
        ["b4", "b9"],
      ],
      ["type", { ref: "b4", text: "x" }, { outcome: "typed", method: "native_setter" }, ["b4"]],
      ["press_key", { ref: "b4", key: "Enter" }, { action: "none", prevented: false }, ["b4"]],
      [
        "fill_form",
        {
          fields: [
            { ref: "b4", value: "x" },
            { ref: "b9", value: "y" },
          ],
        },
        {
          fields: [
            { ref: "b4", ok: true, outcome: "typed" },
            { ref: "b9", ok: true, outcome: "typed" },
          ],
        },
        ["b4", "b9"],
      ],
    ];
    for (const [method, params, reply, refs] of acts) {
      const { callWithView, replyWith, tab } = await viewed();
      replyWith(async (type) => (type === "read_page" ? { tree: big, truncated: false } : reply));
      const result = await callWithView("s1", method, { tabId: tab.id, ...params });
      const view = (result as { view?: { kind: string; tree: string; omitted: number } }).view;
      assert.equal(view?.kind, "tree", method);
      assert.ok((view?.omitted ?? 0) > 0, method);
      const shown = view?.tree.split("\n") ?? [];
      for (const ref of refs) {
        const at = shown.findIndex((line) => line.endsWith(`[${ref}]`));
        assert.ok(at > 0, `${method} ${ref}`);
        // The lines around it come with it.
        assert.match(shown[at - 1] ?? "", /^ link "Item \d+"/, `${method} ${ref}`);
        assert.match(shown[at + 1] ?? "", /^ link "Item \d+"/, `${method} ${ref}`);
      }
    }
  });

  it("does not count the view's read as an act for wait_for navigation", async () => {
    const { click, replyWith, fake, tab, page, callWithView } = await viewed();
    replyWith(async (type) => {
      if (type === "read_page") return { ...page };
      // The act loads another page, which finishes before the view is read.
      fake.navigateByUser(tab.id, `${SITE}/next`);
      return CLICKED;
    });
    await click();
    const result = await callWithView("s1", "wait_for", {
      tabId: tab.id,
      navigation: true,
      view: false,
    });
    assert.ok("tab" in result);
    assert.equal(result.tab.url, `${SITE}/next`);
  });

  it("records a whole read_page as the last view; a part of the page or the other filter not", async () => {
    const found = { shown: 4, matches: 4, searched: 4 };
    for (const [params, recorded] of [
      [{}, true],
      [{ filter: "all" }, true],
      [{ filter: "interactive" }, false],
      [{ ref: "a1" }, false],
      [{ depth: 2 }, false],
      [{ find: "a" }, false],
      [{ find: "a", finds: [{ find: "b" }] }, false],
      [{ role: "link" }, false],
      [{ role: "link", finds: [{ role: "heading" }] }, false],
    ] as const) {
      const { call, click, replyWith, tab } = await viewed();
      const part = { tree: TREE, truncated: false, found };
      replyWith(async (type) => (type === "read_page" ? { ...part, finds: [part] } : CLICKED));
      await call("s1", "read_page", { tabId: tab.id, ...params });
      const view = ((await click()) as { view?: { kind: string } }).view;
      assert.equal(view?.kind, recorded ? "unchanged" : "tree", JSON.stringify(params));
    }
  });
});

interface PageCall {
  session: string;
  tabId: number;
  type: string;
  params: Record<string, unknown>;
}

type PageReply = (type: string) => Promise<unknown>;

describe("recipe_propose", { timeout: 10000 }, () => {
  const RECIPE = {
    name: "Receipt",
    description: "Download the latest receipt.",
    sites: ["https://shop.example"],
    steps: "Open https://shop.example/orders.",
  };

  /** Proposes RECIPE in session s1 and returns the page's tab. */
  async function proposed(env: ReturnType<typeof setup>): Promise<number> {
    const result = await env.call("s1", "recipe_propose", RECIPE);
    assert.ok("tabId" in result);
    return result.tabId;
  }

  /** The page in the tab connecting and asking for the proposal. */
  async function proposal(fake: FakeBrowser, tabId: number): Promise<unknown> {
    const page = fake.connectPage("recipe", {
      id: FAKE_EXTENSION_ID,
      url: fake.tabs.get(tabId)?.url ?? "",
      tab: { id: tabId },
    });
    page.deliver({ type: "ready" });
    await flush();
    return page.posted[0];
  }

  it("refuses a proposal with problems, naming each field, and opens no tab", async () => {
    const { fake, call, recipes } = setup();
    const tabs = fake.tabs.size;
    await assert.rejects(
      call("s1", "recipe_propose", {
        name: "",
        description: RECIPE.description,
        sites: ["https://a.example", "ftp://b.example"],
      }),
      {
        code: "invalid_params",
        message:
          "propose_recipe was refused: name: Give the recipe a name. sites: Line 2: this is not an http or https address. steps: The steps must be text.",
      },
    );
    await assert.rejects(call("s1", "recipe_propose", { ...RECIPE, steps: "a\u200bb" }), {
      code: "invalid_params",
      message:
        "propose_recipe was refused: steps: Line 1, column 2: U+200B (zero width space) is invisible; remove it.",
    });
    await assert.rejects(
      call("s1", "recipe_propose", {
        ...RECIPE,
        sites: ["https://a.example", "https://accounts.google.com,evil.example/"],
      }),
      {
        code: "invalid_params",
        message:
          "propose_recipe was refused: sites: Line 2: this address's host is not a domain name or an IP address.",
      },
    );
    assert.equal(fake.tabs.size, tabs);
    assert.equal(recipes.openPrompt("s1"), undefined);
  });

  it("reads only the request's own fields", async () => {
    const { call } = setup();
    const params = Object.assign(Object.create(RECIPE), {});
    await assert.rejects(call("s1", "recipe_propose", params), { code: "invalid_params" });
  });

  it("shows the normalized proposal, as an update of a stored recipe with the same name", async () => {
    const env = setup();
    const { fake, call } = env;
    const stored = { ...RECIPE, name: "OpenAI receipt", savedAt: "2026-01-02T03:04:05.000Z" };
    await fake.browser.storage.local.set({ "recipe:OpenAI receipt": stored });
    const result = await call("s1", "recipe_propose", {
      ...RECIPE,
      name: " OpenAI  receipt ",
      sites: ["https://shop.example/orders?id=1"],
    });
    assert.ok("tabId" in result);
    assert.deepEqual(await proposal(fake, result.tabId), {
      type: "propose",
      fields: { ...RECIPE, name: "OpenAI receipt" },
      current: stored,
    });
    assert.equal(fake.tabs.get(result.tabId)?.groupId, groupIdOf(fake, result.tabId));
    assert.equal((await env.list("s1")).length, 1);
  });

  it("keeps the page's tab from closing and from navigating", async () => {
    const env = setup();
    const { fake, call, grant } = env;
    fake.openTab();
    const tabId = await proposed(env);
    await grant("https://a.example");
    const keep = `Foxleash is asking the user in tab ${tabId} whether to save a recipe; leave that tab open.`;
    await assert.rejects(call("s1", "tab_close", { tabId }), {
      code: "recipe_prompt_open",
      message: keep,
    });
    await assert.rejects(call("s1", "navigate", { tabId, url: "https://a.example/" }), {
      code: "recipe_prompt_open",
      message: keep,
    });
    for (const action of ["back", "forward"]) {
      await assert.rejects(call("s1", "navigate", { tabId, action }), {
        code: "recipe_prompt_open",
        message: keep,
      });
    }
    await assert.rejects(call("s1", "navigate", { tabId, action: "reload" }), {
      code: "page_not_web",
    });
    await assert.rejects(call("s1", "navigate", { tabId, url: "https://b.example/" }), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${tabId} whether to save a recipe. Try again after the user has answered.`,
    });
    assert.equal(fake.tabs.has(tabId), true);
    assert.match(fake.tabs.get(tabId)?.url ?? "", /propose\.html\?id=/);
  });

  it("refuses tab_open on an unapproved site while the page is open, opening no tab", async () => {
    const env = setup();
    const { fake, call } = env;
    const tabId = await proposed(env);
    const tabs = fake.tabs.size;
    await assert.rejects(call("s1", "tab_open", { url: "https://b.example/" }), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${tabId} whether to save a recipe. Try again after the user has answered.`,
    });
    assert.equal(fake.tabs.size, tabs);
  });

  it("removes tab_open's new tab when a page opened before its prompt, and keeps the page", async () => {
    const env = setup();
    const { fake, call } = env;
    fake.openTab();
    // Holds the grouping of tab_open's tab, before its prompt is recorded.
    const held = Promise.withResolvers<void>();
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async (options) => {
      fake.browser.tabs.group = group;
      await held.promise;
      return group(options);
    };
    const opening = call("s1", "tab_open", { url: "https://b.example/" });
    let prompt: Tab | undefined;
    for (let turn = 0; turn < 50 && prompt === undefined; turn += 1) {
      await flush();
      prompt = [...fake.tabs.values()].find(({ url }) => url.includes("approve.html"));
    }
    assert.ok(prompt !== undefined);
    const proposing = env.call("s1", "recipe_propose", RECIPE);
    let page: { tabId: number } | undefined;
    for (let turn = 0; turn < 50 && page === undefined; turn += 1) {
      await flush();
      page = env.recipes.openPrompt("s1");
    }
    assert.ok(page !== undefined);
    const { tabId } = page;
    held.resolve();
    await proposing;
    await assert.rejects(opening, {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${tabId} whether to save a recipe. Try again after the user has answered.`,
    });
    await flush();
    assert.equal(fake.tabs.has(prompt.id), false);
    assert.equal(fake.tabs.has(tabId), true);
  });

  it("frees the session once the page's tab closes", async () => {
    const env = setup();
    const { fake, call } = env;
    const tabId = await proposed(env);
    await assert.rejects(call("s1", "recipe_propose", RECIPE), { code: "recipe_prompt_open" });
    fake.removeTab(tabId);
    const next = await proposed(env);
    assert.notEqual(next, tabId);
  });
});

describe("recipe_list", () => {
  it("gives the saved recipes sorted by name, without their steps, ignoring malformed ones", async (t) => {
    t.mock.method(console, "warn", () => {});
    const { fake, call } = setup();
    await fake.browser.storage.local.set({
      "recipe:b": savedRecipe("b"),
      "recipe:A": savedRecipe("A"),
      "recipe:a": savedRecipe("a"),
      "recipe:bad": { name: "bad" },
      "site:https://a.example": "always",
    });
    const result = await call("s1", "recipe_list");
    assert.deepEqual(result, {
      recipes: [summaryOf("a"), summaryOf("A"), summaryOf("b")],
    });
    assert.ok("recipes" in result);
    for (const entry of result.recipes) assert.equal(Object.hasOwn(entry, "steps"), false);
  });

  it("gives an empty list when no recipe is saved", async () => {
    const { call } = setup();
    assert.deepEqual(await call("s1", "recipe_list"), { recipes: [] });
  });
});

describe("recipe_get", () => {
  it("gives the saved recipe with its steps, for its name as a saved name is normalized", async () => {
    const { fake, call } = setup();
    const receipt = savedRecipe("Receipt");
    const cafe = savedRecipe("Caf\u00e9 order");
    await fake.browser.storage.local.set({
      "recipe:Receipt": receipt,
      [`recipe:${cafe.name}`]: cafe,
      "recipe:Other": savedRecipe("Other"),
    });
    for (const name of ["Receipt", "  Receipt  "]) {
      assert.deepEqual(await call("s1", "recipe_get", { name }), { recipe: receipt }, name);
    }
    for (const name of ["Cafe\u0301 order", "Caf\u00e9\u00a0order", "Caf\u00e9   order"]) {
      assert.deepEqual(await call("s1", "recipe_get", { name }), { recipe: cafe }, name);
    }
  });

  it("gives a recipe stored under a name that now normalizes otherwise, by that exact name", async () => {
    const { fake, call } = setup();
    const trimmed = savedRecipe("Receipt");
    const spaced = savedRecipe("Receipt ");
    const hidden = savedRecipe("Rec\u200beipt");
    await fake.browser.storage.local.set({
      [`recipe:${trimmed.name}`]: trimmed,
      [`recipe:${spaced.name}`]: spaced,
      [`recipe:${hidden.name}`]: hidden,
    });
    assert.deepEqual(await call("s1", "recipe_get", { name: "Receipt " }), { recipe: spaced });
    assert.deepEqual(await call("s1", "recipe_get", { name: "Rec\u200beipt" }), { recipe: hidden });
    assert.deepEqual(await call("s1", "recipe_get", { name: " Receipt" }), { recipe: trimmed });
  });

  it("refuses a name that matches no saved recipe, naming it normalized", async () => {
    const { fake, call } = setup();
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    const cases: [string, string][] = [
      ["Missing", "Missing"],
      ["  Missing  ", "Missing"],
      ["receipt", "receipt"],
    ];
    for (const [name, shown] of cases) {
      await assert.rejects(call("s1", "recipe_get", { name }), {
        code: "recipe_not_found",
        message: `No recipe named "${shown}" is saved. list_recipes names the saved ones.`,
      });
    }
  });

  it("refuses a name no recipe can have, naming it as given", async () => {
    const { fake, call } = setup();
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    for (const name of ["", "   ", "a".repeat(101), "Rec\u200beipt"]) {
      await assert.rejects(call("s1", "recipe_get", { name }), {
        code: "recipe_not_found",
        message: `No recipe named ${JSON.stringify(name)} is saved. list_recipes names the saved ones.`,
      });
    }
  });

  it("refuses a name that is not the request's own string", async () => {
    const { fake, call } = setup();
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    const params: Record<string, unknown>[] = [
      { name: 7 },
      { name: null },
      {},
      Object.create({ name: "Receipt" }),
    ];
    for (const given of params) {
      await assert.rejects(call("s1", "recipe_get", given), {
        code: "invalid_params",
        message: "get_recipe needs name to be a string.",
      });
    }
  });
});

describe("recipe_run", { timeout: 10000 }, () => {
  /** Calls recipe_run and waits until its run page is open; returns the call and the tab. */
  async function running(
    env: ReturnType<typeof setup>,
    name = "Receipt",
  ): Promise<{ result: Promise<unknown>; tabId: number }> {
    const result = env.call("s1", "recipe_run", { name });
    result.catch(() => {});
    for (let turn = 0; turn < 50; turn += 1) {
      const page = env.recipes.openPrompt("s1");
      if (page !== undefined) {
        await flush();
        return { result, tabId: page.tabId };
      }
      await flush();
    }
    assert.fail("no run page");
  }

  it("asks on the run page and resolves with the sites allowed for the session", async () => {
    const env = setup();
    const { fake, call } = env;
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    const { result, tabId } = await running(env);
    assert.match(fake.tabs.get(tabId)?.url ?? "", /run\.html\?id=/);
    const page = fake.connectPage("recipe", {
      id: FAKE_EXTENSION_ID,
      url: fake.tabs.get(tabId)?.url ?? "",
      tab: { id: tabId },
    });
    page.deliver({ type: "answer", answer: "allow" });
    assert.deepEqual(await result, {
      asked: true,
      allowed: ["https://shop.example"],
      blocked: [],
      refused: [],
    });
    const opened = await call("s1", "tab_open", { url: "https://shop.example/" });
    assert.ok("tab" in opened);
    assert.equal(opened.tab.url, "https://shop.example/");
  });

  it("keeps the run page's tab and refuses tab_open on an unapproved site while it is open", async () => {
    const env = setup();
    const { fake, call } = env;
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    fake.openTab();
    const { tabId } = await running(env);
    const tabs = fake.tabs.size;
    await assert.rejects(call("s1", "tab_open", { url: "https://b.example/" }), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer in tab ${tabId} whether to allow the recipe's sites. Try again after the user has answered.`,
    });
    assert.equal(fake.tabs.size, tabs);
    await assert.rejects(call("s1", "tab_close", { tabId }), {
      code: "recipe_prompt_open",
      message: `Foxleash is asking the user in tab ${tabId} whether to allow the recipe's sites; leave that tab open.`,
    });
    assert.equal(fake.tabs.has(tabId), true);
  });

  it("refuses a name that matches no saved recipe with get_recipe's words", async () => {
    const { fake, call } = setup();
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    for (const name of ["Missing", "  Missing  ", "receipt", "", "a".repeat(101)]) {
      const refusal = await call("s1", "recipe_get", { name }).then(
        () => assert.fail(name),
        (error: unknown) => error,
      );
      assert.ok(refusal instanceof ToolError);
      assert.equal(refusal.code, "recipe_not_found");
      await assert.rejects(call("s1", "recipe_run", { name }), {
        code: "recipe_not_found",
        message: refusal.message,
      });
    }
  });

  it("refuses a name that is not the request's own string", async () => {
    const { fake, call } = setup();
    await fake.browser.storage.local.set({ "recipe:Receipt": savedRecipe("Receipt") });
    const params: Record<string, unknown>[] = [
      { name: 7 },
      { name: null },
      {},
      Object.create({ name: "Receipt" }),
    ];
    for (const given of params) {
      await assert.rejects(call("s1", "recipe_run", given), {
        code: "invalid_params",
        message: "start_recipe needs name to be a string.",
      });
    }
    assert.equal(fake.tabs.size, 0);
  });
});

describe("sites_request", { timeout: 10000 }, () => {
  /** Records the sites each call hands to the recipe pages, which then answer nothing asked. */
  function recordRequests(env: ReturnType<typeof setup>): string[][] {
    const requested: string[][] = [];
    env.recipes.request = async (_session, sites) => {
      requested.push(sites);
      return { asked: false, allowed: [], blocked: [], refused: [] };
    };
    return requested;
  }

  it("asks on the run page and resolves with the sites allowed for the session", async () => {
    const { fake, call, recipes, grant } = setup();
    fake.openTab();
    await grant("https://a.example");
    const result = call("s1", "sites_request", { sites: ["https://shop.example/orders"] });
    let tabId: number | undefined;
    for (let turn = 0; turn < 50 && tabId === undefined; turn += 1) {
      tabId = recipes.openPrompt("s1")?.tabId;
      await flush();
    }
    assert.ok(tabId !== undefined);
    assert.match(fake.tabs.get(tabId)?.url ?? "", /run\.html\?id=/);
    const page = fake.connectPage("recipe", {
      id: FAKE_EXTENSION_ID,
      url: fake.tabs.get(tabId)?.url ?? "",
      tab: { id: tabId },
    });
    page.deliver({ type: "ready" });
    assert.deepEqual(page.posted, [
      { type: "sites", sites: [{ site: "https://shop.example", state: "askable" }] },
    ]);
    const keep = `Foxleash is asking the user in tab ${tabId} whether to allow the sites the agent asked for; leave that tab open.`;
    await assert.rejects(call("s1", "tab_close", { tabId }), {
      code: "recipe_prompt_open",
      message: keep,
    });
    await assert.rejects(call("s1", "navigate", { tabId, url: "https://a.example/" }), {
      code: "recipe_prompt_open",
      message: keep,
    });
    page.deliver({ type: "answer", answer: "allow" });
    assert.deepEqual(await result, {
      asked: true,
      allowed: ["https://shop.example"],
      blocked: [],
      refused: [],
    });
    const opened = await call("s1", "tab_open", { url: "https://shop.example/" });
    assert.ok("tab" in opened);
    assert.equal(opened.tab.url, "https://shop.example/");
  });

  it("reduces each entry to its site and collapses duplicates, in the agent's order", async () => {
    const env = setup();
    const requested = recordRequests(env);
    const given = [
      "https://b.example/x?y=1",
      " https://a.example ",
      "https://B.example:443/",
      "https://b.example.",
      "http://a.example:8080/",
      "https://a.example/z",
      "http://[::1]:8080/x",
      "http://2130706433/",
      `https://${"c".repeat(63)}.my_host-2.example`,
      "https://\u0430pple.com",
    ];
    assert.deepEqual(await env.call("s1", "sites_request", { sites: given }), {
      asked: false,
      allowed: [],
      blocked: [],
      refused: [],
    });
    assert.deepEqual(requested, [
      [
        "https://b.example",
        "https://a.example",
        "http://a.example:8080",
        "http://[::1]:8080",
        "http://127.0.0.1",
        `https://${"c".repeat(63)}.my_host-2.example`,
        "https://xn--pple-43d.com",
      ],
    ]);
  });

  it("takes at most 20 distinct sites, however many entries name them", async () => {
    const env = setup();
    const requested = recordRequests(env);
    const twenty = Array.from({ length: 20 }, (_, index) => `https://s${index}.example`);
    await env.call("s1", "sites_request", { sites: [...twenty, `${twenty[0]}/again`] });
    assert.deepEqual(requested, [twenty]);
    await assert.rejects(
      env.call("s1", "sites_request", { sites: [...twenty, "https://s20.example", ""] }),
      {
        code: "invalid_params",
        message: "request_sites was refused: it names more than 20 sites; ask for at most 20.",
      },
    );
    assert.equal(requested.length, 1);
  });

  it("refuses sites that are not a list, opening nothing", async () => {
    const env = setup();
    const requested = recordRequests(env);
    const params: Record<string, unknown>[] = [
      {},
      { sites: "https://a.example" },
      { sites: null },
      { sites: { 0: "https://a.example", length: 1 } },
      Object.create({ sites: ["https://a.example"] }),
    ];
    for (const given of params) {
      await assert.rejects(env.call("s1", "sites_request", given), {
        code: "invalid_params",
        message: "request_sites needs sites to be a list of addresses.",
      });
    }
    await assert.rejects(env.call("s1", "sites_request", { sites: [] }), {
      code: "invalid_params",
      message: "request_sites was refused: name at least one site, such as https://example.com.",
    });
    assert.deepEqual(requested, []);
    assert.equal(env.fake.tabs.size, 0);
  });

  it("refuses the first entry that is not a site, naming its place, before reading anything", async () => {
    const env = setup();
    const requested = recordRequests(env);
    const reads: unknown[] = [];
    const get = env.fake.browser.storage.local.get;
    env.fake.browser.storage.local.get = (keys) => {
      reads.push(keys);
      return get(keys);
    };
    const notAnAddress = "this is not an http or https address.";
    const holed: unknown[] = ["https://a.example"];
    holed[2] = "https://b.example";
    const cases: [unknown[], string][] = [
      [["https://a.example", ""], "entry 2: this entry is blank."],
      [[" \t "], "entry 1: this entry is blank."],
      [[7, ""], `entry 1: ${notAnAddress}`],
      [[null], `entry 1: ${notAnAddress}`],
      [holed, `entry 2: ${notAnAddress}`],
      [["file:///etc/passwd"], `entry 1: ${notAnAddress}`],
      [["javascript:alert(1)"], `entry 1: ${notAnAddress}`],
      [["about:blank"], `entry 1: ${notAnAddress}`],
      [["moz-extension://abc/run.html"], `entry 1: ${notAnAddress}`],
      [["a.example"], `entry 1: ${notAnAddress}`],
      [["https://a.exa\nmple"], `entry 1: ${notAnAddress}`],
      [["https://a.exa\tmple"], `entry 1: ${notAnAddress}`],
      [
        ["https://a.example", "https://user:pw@b.example/"],
        "entry 2: this address has a user name before the site; give the site only.",
      ],
      [["https://*.example"], "entry 1: this address has a wildcard; list each site."],
      [
        [`https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example`],
        "entry 1: this address's host is longer than 253 characters.",
      ],
      ...[
        "https://foxleash(checked),'safe'!click_allow{ok}.example",
        'https://"allow"=$safe;~ok`.example',
        `https://${"a".repeat(64)}.example`,
        "https://a..example",
        "https://.example",
      ].map((site): [unknown[], string] => [
        ["https://a.example", site],
        "entry 2: this address's host is not a domain name or an IP address.",
      ]),
    ];
    for (const [sites, problem] of cases) {
      await assert.rejects(env.call("s1", "sites_request", { sites }), {
        code: "invalid_params",
        message: `request_sites was refused: ${problem}`,
      });
    }
    assert.deepEqual(requested, []);
    assert.deepEqual(reads, []);
    assert.equal(env.fake.tabs.size, 0);
  });
});

function savedRecipe(name: string) {
  return {
    name,
    description: `What ${name} does`,
    sites: ["https://shop.example"],
    steps: `Steps of ${name}`,
    savedAt: "2026-10-01T08:00:00.000Z",
  };
}

function summaryOf(name: string) {
  const { description, sites, savedAt } = savedRecipe(name);
  return { name, description, sites, savedAt };
}

type Live = (session: string, tabId: number) => LiveRecording | undefined;

interface NetworkRead {
  session: string;
  tabId: number;
  site: string;
  options: NetworkReadOptions;
}

interface Save {
  session: string;
  url: string;
  filename: string;
  generation: number;
}

/**
 * The handlers on a fake browser. With `pageViews`, results end with real views of the page;
 * without, no view is read, so that no further live-documents check runs at each commit.
 * `networkLog` wires the real network log instead of one a test sets with `networkWith`.
 */
function setup({
  pageViews = false,
  networkLog = false,
}: {
  pageViews?: boolean;
  networkLog?: boolean;
} = {}) {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser, undefined, (url) => recipes.isBlankPage(url));
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({
    browser: fake.browser,
    groups,
    sessions,
    timers,
    otherPrompt: (session) => recipes.openPrompt(session),
  });
  const recipes: RecipePrompts = createRecipePrompts({
    browser: fake.browser,
    groups,
    access,
    timers,
  });
  const probe = async function probe(_site: string): Promise<ProbeResult | null> {
    return null;
  };
  const uploads = createUploads(timers);
  const pageCalls: PageCall[] = [];
  let pageReply: PageReply = defaultReply;
  const pages = {
    async request(
      session: string,
      tabId: number,
      type: string,
      params: Record<string, unknown>,
      generation: number,
      onSend?: () => void,
    ) {
      // As the real page scripts refuse, right before they send.
      refuseIfEnded(access, session, generation);
      pageCalls.push({ session, tabId, type, params });
      onSend?.();
      return pageReply(type);
    },
  };
  let live: Live = () => undefined;
  const recordings = {
    liveRecording: (session: string, tabId: number) => live(session, tabId),
  };
  const networkReads: NetworkRead[] = [];
  let networkResult: Result<"read_network"> = { recording: false, requests: [], truncated: false };
  const network = networkLog
    ? createNetworkLog({ browser: fake.browser, groups, access, now: () => timers.now() })
    : {
        read: (session: string, tabId: number, site: string, options: NetworkReadOptions) => {
          networkReads.push({ session, tabId, site, options });
          return networkResult;
        },
        requestsSince: () => ({ begun: 0, open: 0 }),
      };
  const saves: Save[] = [];
  const downloads = {
    save: async (session: string, url: string, filename: string, generation: number) => {
      saves.push({ session, url, filename, generation });
      return { path: `/downloads/${filename}`, bytes: 3 };
    },
  };
  const navigations = createTabNavigations({ browser: fake.browser, timers });
  const files = createFileGuard({
    // Its own copy of tabs: a test that replaces a tabs method counts the handlers' calls, not
    // the lookups the guard makes for each page load.
    browser: { ...fake.browser, tabs: { ...fake.browser.tabs } },
    groups,
    access,
    now: () => timers.now(),
  });
  // Its own clock: a wait that saw no request, as every load of the fake is, leaves a timer that
  // would count among the handlers' pending ones.
  const hopTimers = createFakeTimers();
  const hops = createLoadHops({ browser: fake.browser, access, timers: hopTimers });
  const settle = createActSettle({
    browser: fake.browser,
    groups,
    access,
    timers,
    navigations,
    network,
    files,
    pages,
    now: () => 0,
  });
  const views = pageViews ? createPageViews({ browser: fake.browser, groups, access }) : NO_VIEWS;
  const handleRequest = createHandlers({
    browser: fake.browser,
    groups,
    timers,
    access,
    probe,
    pages,
    navigations,
    uploads,
    recordings,
    network,
    files,
    hops,
    downloads,
    recipes,
    settle,
    views,
    now: () => timers.now(),
  });
  let requests = 0;
  /** A request as the server sends it: its result ends with a view unless view is false. */
  const callWithView = (
    session: string,
    method: MethodName,
    params: Record<string, unknown> = {},
  ) => handleRequest({ type: "request", id: `r${++requests}`, session, method, params });
  /** A request with the view left out, unless its params say otherwise. */
  const call = (session: string, method: MethodName, params: Record<string, unknown> = {}) =>
    callWithView(session, method, withoutView(method, params));
  /** A request as a server of `protocol` sends it, answered as the extension answers it. */
  const callAs = (
    protocol: number,
    session: string,
    method: MethodName,
    params: Record<string, unknown>,
  ) =>
    answerAs(
      protocol,
      { type: "request", id: `r${++requests}`, session, method, params },
      handleRequest,
    );

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

  /** What the console recordings answer from now on. */
  function liveWith(answer: Live): void {
    live = answer;
  }

  /** What the network log answers from now on. */
  function networkWith(result: Result<"read_network">): void {
    networkResult = result;
  }

  return {
    fake,
    timers,
    sessions,
    access,
    groups,
    recipes,
    probe,
    uploads,
    views,
    pageCalls,
    replyWith,
    liveWith,
    networkReads,
    networkWith,
    saves,
    call,
    callWithView,
    callAs,
    open,
    list,
    navigate,
    grant,
    promptOf,
    page,
    timeOut,
  };
}

/** Views for handlers whose tests leave them out: nothing is read or recorded. */
const NO_VIEWS: HandlerDeps<number>["views"] = {
  document: () => undefined,
  view: () => assert.fail("a view was built without pageViews"),
  record: () => {},
  forget: () => {},
};

/** The tools whose results end with a view of the page. */
const VIEW_TOOLS: readonly string[] = [
  "tab_open",
  "navigate",
  "wait_for",
  "upload_file",
  "click",
  "hover",
  "scroll",
  "drag",
  "type",
  "press_key",
  "fill_form",
] satisfies MethodName[];

/** The params with view false for a tool that ends with a view, unless they set view. */
function withoutView(method: MethodName, params: Record<string, unknown>): Record<string, unknown> {
  if (!VIEW_TOOLS.includes(method) || Object.hasOwn(params, "view")) return params;
  return { ...params, view: false };
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

/** What an act reports after a reply without a watch, as the fake content script's are. */
const UNKNOWN = { page: "unknown" };

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

/**
 * Makes loading a URL into a tab Firefox has not loaded first report a load that leaves it on
 * about:blank, as for a new tab's own blank load, and start the load of its page a turn later.
 */
function reportBlankLoadInUnloaded(fake: FakeBrowser): void {
  const update = fake.browser.tabs.update;
  fake.browser.tabs.update = async (tabId, properties) => {
    const tab = fake.tabs.get(tabId);
    if (properties.url !== undefined && tab?.discarded === true) {
      tab.url = "about:blank";
      fake.emitStatus(tabId, "loading");
      fake.emitStatus(tabId, "complete");
      await flush();
    }
    return update(tabId, properties);
  };
}

/**
 * Makes a load of a URL into a tab Firefox unloaded show no page, as a URL Firefox downloads: the
 * restore commits the tab's stored URL, then the requested navigation begins, loads and completes
 * without a commit.
 */
function restoreThenLoadNothing(fake: FakeBrowser): void {
  const update = fake.browser.tabs.update;
  fake.browser.tabs.update = async (tabId, properties) => {
    const tab = fake.tabs.get(tabId);
    if (properties.url === undefined || tab?.discarded !== true) return update(tabId, properties);
    fake.tabUpdates.push({ tabId, ...properties });
    tab.discarded = false;
    fake.emitCommitted({ tabId, frameId: 0, url: tab.url });
    tab.url = properties.url;
    fake.emitBeforeNavigate({ tabId, frameId: 0, url: properties.url });
    fake.emitStatus(tabId, "loading");
    fake.emitStatus(tabId, "complete");
    return fake.browser.tabs.get(tabId);
  };
}

function tabsIn(fake: FakeBrowser, windowId: number | undefined): number[] {
  return [...fake.tabs.values()].filter((tab) => tab.windowId === windowId).map((tab) => tab.id);
}

/** Records every `tabs.create` call's properties, in order. */
function recordCreates(fake: FakeBrowser): unknown[] {
  const creates: unknown[] = [];
  const create = fake.browser.tabs.create;
  fake.browser.tabs.create = async (properties) => {
    creates.push(properties);
    return create(properties);
  };
  return creates;
}

/**
 * Makes a reload load about:blank, as when Firefox reloads an about:blank entry it kept after the
 * page, and calls `landed` once that load has completed. Returns the reloads made.
 */
function reloadToBlank(fake: FakeBrowser, landed: () => void = () => {}): unknown[][] {
  const reloads: unknown[][] = [];
  fake.browser.tabs.reload = async (tabId, properties) => {
    reloads.push([tabId, properties]);
    const tab = fake.tabs.get(tabId);
    assert.ok(tab);
    tab.url = "about:blank";
    tab.history[tab.index] = "about:blank";
    fake.emitStatus(tabId, "loading");
    queueMicrotask(() => {
      tab.title = "New Tab";
      fake.emitStatus(tabId, "complete");
      landed();
    });
  };
  return reloads;
}

function loadsOf(fake: { tabUpdates: { url?: string }[] }, url: string): number {
  return fake.tabUpdates.filter((update) => update.url === url).length;
}

/** How many tab updates since the `from`th loaded a prompt page. */
function promptLoads(fake: { tabUpdates: { url?: string }[] }, from: number): number {
  return fake.tabUpdates.slice(from).filter(({ url }) => PROMPT_URL.test(url ?? "")).length;
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

/** A session's tab on https://b.example/b, which it reached from `first`; both sites approved. */
async function historyTab(
  { open, navigate, grant }: ReturnType<typeof setup>,
  first = "https://a.example/a",
): Promise<TabInfo> {
  await grant("https://a.example");
  await grant("https://b.example");
  const tab = await open("s1", first);
  await navigate("s1", { tabId: tab.id, url: "https://b.example/b" });
  return tab;
}

/** A session's tab on https://b.example/b, after z.example/z and a.example/a; all approved. */
async function threePageTab({ open, navigate, grant }: ReturnType<typeof setup>): Promise<TabInfo> {
  await grant("https://z.example");
  await grant("https://a.example");
  await grant("https://b.example");
  const tab = await open("s1", "https://z.example/z");
  await navigate("s1", { tabId: tab.id, url: "https://a.example/a" });
  await navigate("s1", { tabId: tab.id, url: "https://b.example/b" });
  return tab;
}

type Reload = BrowserApi["tabs"]["reload"];

/** Runs `load` with the fake's commits of `url` dropped, as Firefox can show a page it kept. */
function withoutCommitOf<T>(fake: FakeBrowser, url: string, load: () => T): T {
  const { emitCommitted } = fake;
  fake.emitCommitted = (details) => {
    if (details.url !== url) emitCommitted(details);
  };
  try {
    return load();
  } finally {
    fake.emitCommitted = emitCommitted;
  }
}

/** Gives the `timeStamp` of the last top-level commit reported from now on, 0 before one. */
function lastCommitTime(fake: FakeBrowser): () => number {
  let last = 0;
  fake.browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) last = details.timeStamp;
  });
  return () => last;
}

/**
 * Makes the tabs' history steps send the requests `requests` returns as they start, and those
 * `after` returns once they committed, before their load completes. Records each history step,
 * each reload with its options and each load of a URL with its properties, in order.
 */
function recordSteps(
  fake: FakeBrowser,
  requests: (tabId: number) => RequestDetails[],
  after: (tabId: number) => RequestDetails[] = () => [],
): unknown[][] {
  const steps: unknown[][] = [];
  const { goBack, goForward, reload, update } = fake.browser.tabs;
  fake.browser.tabs.goBack = async (tabId) => {
    steps.push(["back", tabId]);
    send(fake, requests(tabId));
    const stepped = goBack(tabId);
    send(fake, after(tabId));
    return stepped;
  };
  fake.browser.tabs.goForward = async (tabId) => {
    steps.push(["forward", tabId]);
    send(fake, requests(tabId));
    const stepped = goForward(tabId);
    send(fake, after(tabId));
    return stepped;
  };
  fake.browser.tabs.reload = async (tabId, properties) => {
    steps.push(["reload", tabId, properties]);
    return reload(tabId, properties);
  };
  fake.browser.tabs.update = async (tabId, properties) => {
    if (properties.url !== undefined) steps.push(["load", tabId, properties]);
    return update(tabId, properties);
  };
  return steps;
}

/**
 * Navigates in the session "s1" and moves the clock past `navigate`'s wait for the request of a
 * history step's commit, which the fake's own steps do not report.
 */
async function pastRequestWait(
  { navigate, timers }: ReturnType<typeof setup>,
  params: Record<string, unknown>,
): Promise<TabInfo> {
  const result = navigate("s1", params);
  await flush();
  timers.advance(HISTORY_REQUEST_TIMEOUT_MS);
  return result;
}

/**
 * Asserts that going back to `shown` loaded it again with GET when it has no fragment, and loaded
 * nothing and returned `tab` when it has one.
 */
function assertGetLoadOnlyWithoutFragment(
  steps: unknown[][],
  loaded: TabInfo,
  tab: TabInfo,
  label: string,
): void {
  assert.deepEqual(loaded, tab, label);
  if (tab.url?.includes("#")) {
    assert.deepEqual(steps, [["back", tab.id]], label);
  } else {
    assert.deepEqual(
      steps,
      [
        ["back", tab.id],
        ["load", tab.id, { url: tab.url, loadReplace: true }],
      ],
      label,
    );
  }
}

/**
 * Sends the request `late` returns from each `tabs.get` once the tab shows `url`, as after its
 * step loaded, the last thing `navigate` awaits before it reloads.
 */
function sendOnLookup(
  { fake }: ReturnType<typeof setup>,
  late: (tabId: number) => RequestDetails,
  url = "https://a.example/a",
): void {
  const get = fake.browser.tabs.get;
  fake.browser.tabs.get = async (tabId) => {
    if (fake.tabs.get(tabId)?.url === url) send(fake, [late(tabId)]);
    return get(tabId);
  };
}

/**
 * Makes the tabs' loads of a web URL from now on stop once the page's DOM is ready, as for a page
 * whose images still load; `completeLoad` finishes one. The tab's title is then an interim one.
 */
function loadUntilReady(fake: FakeBrowser): void {
  const update = fake.browser.tabs.update;
  fake.browser.tabs.update = async (tabId, properties) => {
    const tab = fake.tabs.get(tabId);
    const { url } = properties;
    if (tab === undefined || url === undefined || !url.startsWith("https:")) {
      return update(tabId, properties);
    }
    fake.tabUpdates.push({ tabId, ...properties });
    tab.discarded = false;
    tab.title = "Interim title";
    beginNavigation(fake, tabId, url);
    landNavigation(fake, tabId, url);
    return fake.browser.tabs.get(tabId);
  };
}

/** The load in the tab completes: its images and frames have loaded. */
function completeLoad(fake: FakeBrowser, tabId: number): void {
  const tab = fake.tabs.get(tabId);
  assert.ok(tab);
  tab.title = `Title of ${tab.url}`;
  fake.emitStatus(tabId, "complete");
}

/**
 * Runs `load`, whose page stops once its DOM is ready, and asserts it answers only once the load
 * completes, with the completed page.
 */
async function assertWaitsForComplete(
  { fake, timers }: Pick<ReturnType<typeof setup>, "fake" | "timers">,
  tabId: number,
  load: () => Promise<TabInfo>,
): Promise<void> {
  let done = false;
  const loaded = load().finally(() => {
    done = true;
  });
  for (let turn = 0; turn < 5; turn += 1) await flush();
  assert.equal(fake.tabs.get(tabId)?.status, "loading");
  timers.advance(LOAD_AFTER_READY_MS * 5);
  await flush();
  assert.equal(done, false);
  completeLoad(fake, tabId);
  const tab = await loaded;
  assert.equal(tab.title, `Title of ${tab.url}`);
}

/** Firefox begins a navigation of the tab's top frame; the tab still shows its page. */
function beginNavigation(fake: FakeBrowser, tabId: number, url: string): void {
  fake.emitBeforeNavigate({ tabId, frameId: 0, url });
  if (fake.tabs.has(tabId)) fake.emitStatus(tabId, "loading");
}

/** The tab shows about:blank, as while Firefox swaps the new document in. */
function swapDocument(fake: FakeBrowser, tabId: number): void {
  const shown = fake.tabs.get(tabId);
  if (shown !== undefined) shown.url = "about:blank";
}

/** The navigation's document commits and is parsed. */
function landNavigation(fake: FakeBrowser, tabId: number, url: string): void {
  const shown = fake.tabs.get(tabId);
  if (shown !== undefined) shown.url = url;
  fake.emitCommitted({ tabId, frameId: 0, url });
  fake.emitDOMContentLoaded({ tabId, frameId: 0, url });
}

/** Fires each request's onBeforeRequest; returns how many listeners the last one reached. */
function send(fake: FakeBrowser, requests: RequestDetails[]): number {
  let reached = 0;
  for (const request of requests) reached = fake.emitWebRequest("onBeforeRequest", request).length;
  return reached;
}

function pageRequest(tabId: number, url: string, method = "GET", timeStamp = 1): RequestDetails {
  return {
    requestId: `${method} ${url}`,
    tabId,
    frameId: 0,
    url,
    method,
    type: "main_frame",
    timeStamp,
  };
}

function frameRequest(tabId: number, url: string, method = "GET", timeStamp = 1): RequestDetails {
  return {
    requestId: `${method} ${url}`,
    tabId,
    frameId: 1,
    url,
    method,
    type: "sub_frame",
    timeStamp,
  };
}

/** A click in the tab that the page answers. */
async function click(
  session: string,
  tabId: number,
  call: ReturnType<typeof setup>["call"],
  replyWith: (reply: PageReply) => void,
): Promise<void> {
  replyWith(async () => ({ ref: "b4", x: 1, y: 2 }));
  await call(session, "click", { tabId, ref: "b4" });
}

describe("a stopped session", { timeout: 10000 }, () => {
  const STOPPED = {
    code: "session_stopped",
    message:
      "The user stopped this agent session in Firefox. Foxleash refuses every tool call of this session from now on: stop the browser task and tell the user.",
  };

  it("is refused on arrival, also by tools that reach no site gate, and another session is not", async () => {
    const { fake, access, call, open, grant, pageCalls } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const other = await open("s2", "https://a.example/");
    access.stop("s1");
    await assert.rejects(call("s1", "tab_close", { tabId: tab.id }), STOPPED);
    assert.equal(fake.tabs.has(tab.id), true);
    await assert.rejects(call("s1", "recipe_list"), STOPPED);
    await assert.rejects(call("s1", "tabs_list"), STOPPED);
    await assert.rejects(call("s1", "read_page", { tabId: tab.id }), STOPPED);
    await assert.rejects(call("s1", "tab_open", { url: "https://a.example/b" }), STOPPED);
    assert.deepEqual(pageCalls, []);
    assert.deepEqual(await call("s2", "read_page", { tabId: other.id }), {
      tree: "",
      truncated: false,
    });
    assert.deepEqual(await call("s2", "recipe_list"), { recipes: [] });
    assert.equal(pageCalls.length, 1);
  });

  it("returns nothing a page tool got when the stop came while it was under way", async () => {
    const { access, call, open, grant, replyWith, pageCalls } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const held = Promise.withResolvers<unknown>();
    replyWith(() => held.promise);
    const reading = call("s1", "read_page", { tabId: tab.id });
    while (pageCalls.length === 0) await flush();
    access.stop("s1");
    held.resolve({ tree: "secret", truncated: false });
    await assert.rejects(reading, STOPPED);
  });

  it("reports the stop for a call that failed for another reason after it", async () => {
    const { access, call, open, grant, replyWith, pageCalls } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const held = Promise.withResolvers<unknown>();
    replyWith(() => held.promise);
    const reading = call("s1", "read_page", { tabId: tab.id });
    while (pageCalls.length === 0) await flush();
    access.stop("s1");
    held.reject(new ToolError("page_changed", "The page changed."));
    await assert.rejects(reading, STOPPED);
  });

  it("keeps another failure of a session that is not stopped", async () => {
    const { call, open, grant, replyWith } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    replyWith(async () => {
      throw new ToolError("page_changed", "The page changed.");
    });
    await assert.rejects(call("s1", "read_page", { tabId: tab.id }), { code: "page_changed" });
  });

  it("rejects a tab_open waiting on its site prompt at once", async () => {
    const { fake, access, call, promptOf } = setup();
    const opening = call("s1", "tab_open", { url: "https://a.example/" });
    const { tabId } = await promptOf("s1");
    access.stop("s1");
    await assert.rejects(opening, STOPPED);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(fake.tabs.has(tabId), true);
  });
});

describe("a request whose session ends while it runs", { timeout: 10000 }, () => {
  /** Ends the session right after the next gate check of `context`, which still answers. */
  function endAfterCheck(context: ReturnType<typeof setup>, session: string): void {
    const { access } = context;
    const check = access.check;
    access.check = async (checked, url) => {
      const decision = await check(checked, url);
      access.endSession(session);
      return decision;
    };
  }

  it("opens no tab when the session ends during tab_open's gate check", async () => {
    const context = setup();
    const { fake, call, grant } = context;
    await grant("https://a.example");
    const creates = recordCreates(fake);
    endAfterCheck(context, "s1");
    await rejectsWith(call("s1", "tab_open", { url: "https://a.example/" }), "session_ended");
    assert.deepEqual(creates, []);
    assert.equal(loadsOf(fake, "https://a.example/"), 0);
  });

  it("removes the new tab, unloaded, when the session ends before tab_open's load", async () => {
    const { fake, access, call, grant } = setup();
    await grant("https://a.example");
    const user = fake.openTab({ url: "https://user.example/" });
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async (options) => {
      const grouped = await group(options);
      access.endSession("s1");
      return grouped;
    };
    await rejectsWith(call("s1", "tab_open", { url: "https://a.example/" }), "session_ended");
    assert.equal(loadsOf(fake, "https://a.example/"), 0);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("starts no load when the session ends during navigate's gate check", async () => {
    const context = setup();
    const { fake, call, open, grant } = context;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    endAfterCheck(context, "s1");
    await rejectsWith(
      call("s1", "navigate", { tabId: tab.id, url: "https://a.example/next" }),
      "session_ended",
    );
    assert.equal(loadsOf(fake, "https://a.example/next"), 0);
  });

  it("starts no load when the session ends after the user answered navigate's prompt", async () => {
    const { fake, access, call, open, page } = setup();
    const tab = await open("s1");
    const navigating = call("s1", "navigate", { tabId: tab.id, url: "https://a.example/" });
    const shown = await page("s1");
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async (tabId) => {
      access.endSession("s1");
      return get(tabId);
    };
    shown.deliver({ type: "answer", answer: "once" });
    await rejectsWith(navigating, "session_ended");
    assert.equal(loadsOf(fake, "https://a.example/"), 0);
  });

  it("loads nothing in place of the blank when the session ends during a reload", async () => {
    const { fake, access, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/page");
    const reloads = reloadToBlank(fake, () => access.endSession("s1"));
    const updates = fake.tabUpdates.length;
    await rejectsWith(call("s1", "navigate", { tabId: tab.id, action: "reload" }), "session_ended");
    assert.deepEqual(reloads, [[tab.id, { bypassCache: true }]]);
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
  });

  it("loads nothing again after going back when the session ends before that load", async () => {
    const context = setup();
    const { fake, access, call } = context;
    const tab = await historyTab(context);
    const steps = recordSteps(fake, (tabId) => [pageRequest(tabId, "https://a.example/a")]);
    const getAllFrames = fake.browser.webNavigation.getAllFrames;
    fake.browser.webNavigation.getAllFrames = async (details) => {
      access.endSession("s1");
      return getAllFrames(details);
    };
    await rejectsWith(call("s1", "navigate", { tabId: tab.id, action: "back" }), "session_ended");
    assert.deepEqual(steps, [["back", tab.id]]);
  });

  it("selects no tab when the session ends during tab_select's reads", async () => {
    const { fake, access, call, open } = setup();
    const first = await open("s1");
    await open("s1");
    const updates = fake.tabUpdates.length;
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async (tabId) => {
      access.endSession("s1");
      return get(tabId);
    };
    await rejectsWith(call("s1", "tab_select", { tabId: first.id }), "session_ended");
    assert.deepEqual(fake.tabUpdates.slice(updates), []);
    assert.equal(fake.tabs.get(first.id)?.active, false);
  });

  /** Ends the session right after `tabs.group` grouped a tab, as when it ends during ensureGroup. */
  function endAfterGroup(context: ReturnType<typeof setup>, reconnect = false): void {
    const { fake, access } = context;
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async (options) => {
      const grouped = await group(options);
      access.endSession("s1");
      if (reconnect) access.admit("s1");
      return grouped;
    };
  }

  it("closes the blank tab when the session ends while tab_open groups it", async () => {
    const context = setup();
    const { fake, call } = context;
    const user = fake.openTab({ url: "https://user.example/" });
    endAfterGroup(context);
    await rejectsWith(call("s1", "tab_open"), "session_ended");
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("closes only the blank tab when the session's group holds a page", async () => {
    const context = setup();
    const { fake, call, open, grant } = context;
    await grant("https://a.example");
    const user = fake.openTab({ url: "https://user.example/" });
    const page = await open("s1", "https://a.example/");
    const groupId = groupIdOf(fake, page.id);
    endAfterGroup(context);
    await rejectsWith(call("s1", "tab_open"), "session_ended");
    assert.deepEqual([...fake.tabs.keys()], [user.id, page.id]);
    assert.equal(groupIdOf(fake, page.id), groupId);
  });

  it("closes the session's own window when the session ends while tab_open groups its blank tab", async () => {
    const context = setup();
    const { fake, call } = context;
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ active: true });
    endAfterGroup(context);
    await rejectsWith(call("s1", "tab_open"), "session_ended");
    assert.equal(fake.windowCreations.length, 1);
    assert.equal(fake.windowRemovals.length, 1);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("has closed the blank tab when it answers, for a session that reconnected too", async () => {
    const context = setup();
    const { fake, call } = context;
    const user = fake.openTab({ url: "https://user.example/" });
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await flush();
      return remove(tabIds);
    };
    endAfterGroup(context, true);
    await rejectsWith(call("s1", "tab_open"), "session_ended");
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("leaves the own window of a session that reconnected with the same id", async () => {
    const context = setup();
    const { fake, call } = context;
    await fake.browser.storage.local.set({ sessionWindow: true });
    fake.openTab({ active: true });
    endAfterGroup(context, true);
    await rejectsWith(call("s1", "tab_open"), "session_ended");
    assert.equal(fake.windowCreations.length, 1);
    assert.deepEqual(fake.windowRemovals, []);
  });

  it("opens no tab or window when the session ends during the gate check of a site to ask about", async () => {
    const context = setup();
    const { fake, access, call } = context;
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ url: "https://user.example/" });
    const creates = recordCreates(fake);
    endAfterCheck(context, "s1");
    await rejectsWith(call("s1", "tab_open", { url: "https://a.example/" }), "session_ended");
    assert.deepEqual(creates, []);
    assert.deepEqual(fake.windowCreations, []);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  /**
   * Ends the session in tab_open's next read of the session's group or of the settings, once the
   * gate check of `url`, when it has one, answered: inside `createTab`, before it calls Firefox.
   */
  function endInCreate(
    context: ReturnType<typeof setup>,
    read: "group" | "settings",
    url: string | undefined,
  ): void {
    const { fake, access } = context;
    let armed = url === undefined;
    const check = access.check;
    access.check = async (checked, checkedUrl) => {
      const decision = await check(checked, checkedUrl);
      armed = true;
      return decision;
    };
    const end = () => {
      if (!armed) return;
      armed = false;
      access.endSession("s1");
    };
    if (read === "group") {
      const get = fake.browser.tabGroups.get;
      fake.browser.tabGroups.get = (groupId) => {
        end();
        return get(groupId);
      };
    } else {
      const get = fake.browser.storage.local.get;
      fake.browser.storage.local.get = (keys) => {
        end();
        return get(keys);
      };
    }
  }

  /** tab_open's three ways to a new tab: blank, on an allowed page, on a site prompt. */
  const OPENED = [undefined, "https://a.example/", "https://b.example/"];

  it("opens no tab when the session ends while tab_open reads the session's group", async () => {
    for (const url of OPENED) {
      const context = setup();
      const { fake, call, open, grant } = context;
      await grant("https://a.example");
      await open("s1");
      const creates = recordCreates(fake);
      endInCreate(context, "group", url);
      await rejectsWith(
        call("s1", "tab_open", url === undefined ? {} : { url }),
        "session_ended",
        String(url),
      );
      assert.deepEqual(creates, [], String(url));
    }
  });

  it("opens no tab or window when the session ends while tab_open reads the settings", async () => {
    for (const url of OPENED) {
      const context = setup();
      const { fake, call, grant } = context;
      await grant("https://a.example");
      await fake.browser.storage.local.set({ sessionWindow: true });
      const user = fake.openTab({ url: "https://user.example/" });
      const creates = recordCreates(fake);
      endInCreate(context, "settings", url);
      await rejectsWith(
        call("s1", "tab_open", url === undefined ? {} : { url }),
        "session_ended",
        String(url),
      );
      assert.deepEqual(creates, [], String(url));
      assert.deepEqual(fake.windowCreations, [], String(url));
      assert.deepEqual([...fake.tabs.keys()], [user.id], String(url));
    }
  });

  it("closes the session's own window when the session ends while Firefox opens it for tab_open", async () => {
    const { fake, access, groups, call } = setup();
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ url: "https://user.example/", active: true });
    const create = fake.browser.windows.create;
    fake.browser.windows.create = async (createData) => {
      const window = await create(createData);
      // As the background script ends a session.
      access.endSession("s1");
      groups.endSession("s1").catch(() => {});
      return window;
    };
    await rejectsWith(call("s1", "tab_open"), "session_ended");
    await flush();
    assert.equal(fake.windowCreations.length, 1);
    assert.equal(fake.windowRemovals.length, 1);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("closes the session's own window when the session ends while Firefox makes tab_open's tab in it", async () => {
    const { fake, access, groups, call, grant } = setup();
    await grant("https://a.example");
    await fake.browser.storage.local.set({ sessionWindow: true });
    const user = fake.openTab({ url: "https://user.example/", active: true });
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      const tab = await create(properties);
      // As the background script ends a session.
      access.endSession("s1");
      groups.endSession("s1").catch(() => {});
      return tab;
    };
    await rejectsWith(call("s1", "tab_open", { url: "https://a.example/" }), "session_ended");
    await flush();
    assert.equal(fake.windowCreations.length, 1);
    assert.equal(fake.windowRemovals.length, 1);
    assert.deepEqual([...fake.tabs.keys()], [user.id]);
  });

  it("selects no tab when the session ends during tab_open's load", async () => {
    const { fake, access, call, grant } = setup();
    await grant("https://a.example");
    const user = fake.openTab({ url: "https://user.example/", active: true });
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      const updated = await update(tabId, properties);
      if (properties.url !== undefined) access.endSession("s1");
      return updated;
    };
    await rejectsWith(call("s1", "tab_open", { url: "https://a.example/" }), "session_ended");
    const opened = [...fake.tabs.keys()].filter((id) => id !== user.id);
    assert.equal(opened.length, 1);
    const [tabId] = opened;
    assert.ok(tabId !== undefined);
    assert.deepEqual(
      fake.tabUpdates.filter((each) => each.active === true),
      [],
    );
    assert.equal(fake.tabs.get(user.id)?.active, true);
    groupIdOf(fake, tabId);
  });

  it("resizes no window when the session ends while resize_window reads its group", async () => {
    const { fake, access, call, open } = setup();
    await open("s1");
    const updates = fake.windowUpdates.length;
    const get = fake.browser.tabGroups.get;
    fake.browser.tabGroups.get = async (groupId) => {
      access.endSession("s1");
      return get(groupId);
    };
    await rejectsWith(call("s1", "resize_window", { width: 900, height: 700 }), "session_ended");
    assert.deepEqual(fake.windowUpdates.slice(updates), []);
  });

  it("resizes no window when the session ends while resize_window reads the window's size", async () => {
    const { fake, access, call, open } = setup();
    await open("s1");
    const updates = fake.windowUpdates.length;
    const get = fake.browser.windows.get;
    fake.browser.windows.get = async (windowId) => {
      access.endSession("s1");
      return get(windowId);
    };
    await rejectsWith(call("s1", "resize_window", { width: 900, height: 700 }), "session_ended");
    assert.deepEqual(fake.windowUpdates.slice(updates), []);
  });

  it("closes no tab when the session ends right before tab_close removes it", async () => {
    const { fake, access, call, open } = setup();
    const first = await open("s1");
    await open("s1");
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async (info) => {
      access.endSession("s1");
      return query(info);
    };
    await rejectsWith(call("s1", "tab_close", { tabId: first.id }), "session_ended");
    assert.equal(fake.tabs.has(first.id), true);
  });

  it("leaves the navigation unspent when the session ends during a navigation wait", async () => {
    const { fake, access, call, open, grant, replyWith, timers } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    await click("s1", tab.id, call, replyWith);
    const waiting = call("s1", "wait_for", { tabId: tab.id, navigation: true });
    await flush();
    access.endSession("s1");
    fake.navigateByUser(tab.id, "https://a.example/next");
    await rejectsWith(waiting, "session_ended");
    // The navigation no wait returned for counts for the next wait at once.
    const again = call("s1", "wait_for", { tabId: tab.id, navigation: true, timeoutMs: 2000 });
    await flush();
    timers.advance(2000);
    assert.deepEqual(await again, {
      tab: { ...tab, url: "https://a.example/next", title: "Title of https://a.example/next" },
    });
  });

  it("runs no probe when the session ends during probe_input's gate", async () => {
    const { fake, access, call, open, grant } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async (tabId) => {
      access.endSession("s1");
      return get(tabId);
    };
    await rejectsWith(call("s1", "probe_input", { tabId: tab.id }), "session_ended");
    assert.deepEqual(fake.injections, []);
  });

  /** Ends the session when the page receives `ending`, which it answers with `reply`. */
  function endOn(context: ReturnType<typeof setup>, ending: string, reply: unknown): void {
    context.replyWith(async (type) => {
      if (type !== ending) return defaultReply(type);
      context.access.endSession("s1");
      return reply;
    });
  }

  it("returns a click sent before the end, with an unreadable view and no read", async () => {
    const context = setup();
    const { callWithView, open, grant, pageCalls } = context;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const clicked = { ref: "a2", x: 1, y: 2 };
    endOn(context, "click", clicked);
    assert.deepEqual(await callWithView("s1", "click", { tabId: tab.id, ref: "a2" }), {
      ...clicked,
      after: UNKNOWN,
      view: { kind: "none", reason: "unreadable" },
    });
    assert.deepEqual(
      pageCalls.map(({ type }) => type),
      ["click"],
    );
  });

  it("returns an upload sent before the end, with an unreadable view and no read", async () => {
    const context = setup();
    const { callWithView, open, grant, pageCalls } = context;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    endOn(context, "upload_file", { target: "input" });
    assert.deepEqual(
      await callWithView("s1", "upload_file", {
        tabId: tab.id,
        ref: "a2",
        upload: "none",
        files: [{ name: "empty.txt", type: "text/plain", size: 0 }],
      }),
      {
        target: "input",
        files: [{ name: "empty.txt", size: 0 }],
        after: UNKNOWN,
        view: { kind: "none", reason: "unreadable" },
      },
    );
    assert.deepEqual(
      pageCalls.map(({ type }) => type),
      ["upload_file"],
    );
  });

  it("stops a wait for text at the first poll after the end, before its timeout", async () => {
    const context = setup();
    const { call, open, timers, pageCalls } = context;
    const tab = await open("s1");
    endOn(context, "wait_for", false);
    const waiting = call("s1", "wait_for", { tabId: tab.id, text: "Saved" });
    await flush();
    timers.advance(WAIT_POLL_MS);
    await rejectsWith(waiting, "session_ended");
    assert.deepEqual(
      pageCalls.map(({ type }) => type),
      ["wait_for"],
    );
  });

  it("captures nothing when the session ends during a screenshot's element read", async () => {
    const context = setup();
    const { fake, call, open, grant, pageCalls } = context;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    endOn(context, "element_rect", {
      rect: { left: 10, top: 20, width: 120, height: 80 },
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0 },
    });
    await rejectsWith(
      call("s1", "screenshot", { tabId: tab.id, ref: "0a1b2c3d-4" }),
      "session_ended",
    );
    assert.deepEqual(
      pageCalls.map(({ type }) => type),
      ["element_rect"],
    );
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("hides nothing and captures nothing when the session ends after a screenshot's last page read", async () => {
    const context = setup();
    const { fake, call, open, grant } = context;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    endOn(context, "password_fields", { revealed: false });
    await assert.rejects(call("s1", "screenshot", { tabId: tab.id }), {
      code: "session_ended",
      message: "The session ended before Foxleash could finish the request.",
    });
    assert.deepEqual(fake.cssCalls, []);
    assert.deepEqual(fake.captures, []);
  });

  it("captures nothing and takes its masks out when the session ends while they go in", async () => {
    const context = setup();
    const { fake, access, call, open, grant, replyWith } = context;
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    // Revealed, so no page read follows the capture to refuse it.
    replyWith(async (type) =>
      type === "password_fields" ? { revealed: true } : defaultReply(type),
    );
    const insert = fake.browser.scripting.insertCSS;
    fake.browser.scripting.insertCSS = async (injection) => {
      access.endSession("s1");
      return insert(injection);
    };
    await rejectsWith(call("s1", "screenshot", { tabId: tab.id }), "session_ended");
    await flush();
    assert.deepEqual(fake.captures, []);
    const methods = fake.cssCalls.map(({ method }) => method);
    assert.ok(methods.includes("insertCSS"));
    assert.equal(
      methods.filter((method) => method === "removeCSS").length,
      methods.filter((method) => method === "insertCSS").length,
    );
  });

  it("asks the page nothing when the session ends while read_console waits for its tab", async () => {
    const { fake, access, call, open, pageCalls } = setup();
    const tab = await open("s1");
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async (tabId) => {
      access.endSession("s1");
      return get(tabId);
    };
    await rejectsWith(call("s1", "read_console", { tabId: tab.id }), "session_ended");
    assert.deepEqual(pageCalls, []);
  });

  it("returns a navigate whose load began before the end, with an unreadable view and no read", async () => {
    const { fake, access, callWithView, open, grant, pageCalls } = setup();
    await grant("https://a.example");
    const tab = await open("s1", "https://a.example/");
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = async (tabId, properties) => {
      const updated = await update(tabId, properties);
      access.endSession("s1");
      return updated;
    };
    const result = await callWithView("s1", "navigate", {
      tabId: tab.id,
      url: "https://a.example/next",
    });
    assert.ok("tab" in result && "view" in result);
    assert.equal(result.tab.url, "https://a.example/next");
    assert.deepEqual(result.view, { kind: "none", reason: "unreadable" });
    assert.deepEqual(pageCalls, []);
  });
});
