import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { BrowserApi, Tab } from "./browser-api.ts";
import { createFakeBrowser, type FakeBrowser, type FakeTab, flush } from "./fake-browser.ts";
import {
  createSessionGroups,
  MAX_REMEMBERED_GROUPS,
  type SessionGroups,
} from "./session-groups.ts";
import { SESSION_GROUPS_KEY } from "./settings.ts";

const BLANK = ["about:blank", "about:newtab", "about:home"];
/** A createTab check that never refuses. */
const PASS = () => {};
/** A showPromptWindow predicate that always wants the update. */
const WANTED = () => true;

describe("endSession", { timeout: 10000 }, () => {
  it("closes a group of only blank tabs and leaves the tabs outside it", async () => {
    const { fake, groups, outside, open } = setup();
    const blank = [];
    for (const url of BLANK) blank.push(await open("s1", { url }));
    const group = await groups.groupOf("s1");
    assert.ok(group !== undefined);
    await groups.endSession("s1");
    for (const tab of blank) assert.equal(fake.tabs.has(tab.id), false, tab.url);
    assert.equal(fake.groups.has(group.id), false);
    assert.equal(fake.tabs.has(outside.id), true);
    assert.equal(await groups.groupOf("s1"), undefined);
  });

  it("keeps a group with a page, with every tab, as the session's group", async () => {
    const { fake, groups, open } = setup();
    const tabs = [
      await open("s1", { url: "about:blank" }),
      await open("s1", { url: "https://example.com/" }),
      await open("s1", { url: "about:newtab" }),
    ];
    const group = await groups.groupOf("s1");
    await groups.endSession("s1");
    for (const tab of tabs) assert.equal(fake.tabs.has(tab.id), true, tab.url);
    assert.ok(group !== undefined && fake.groups.has(group.id));
    assert.deepEqual(await groups.groupOf("s1"), group);
  });

  it("closes a group of blank tabs and this extension's prompt pages", async () => {
    const { fake, groups, open } = setup();
    const prompt = fake.browser.runtime.getURL("approve.html?id=1");
    const tabs = [await open("s1", { url: "about:blank" }), await open("s1", { url: prompt })];
    await groups.endSession("s1");
    for (const tab of tabs) assert.equal(fake.tabs.has(tab.id), false, tab.url);
  });

  it("keeps a group with a prompt page that is still loading, or another extension page", async () => {
    const cases: [string, string][] = [
      ["approve.html?id=1", "loading"],
      ["options.html", "complete"],
    ];
    for (const [path, status] of cases) {
      const { fake, groups, open } = setup();
      const tab = await open("s1", { url: fake.browser.runtime.getURL(path), status });
      await groups.endSession("s1");
      assert.equal(fake.tabs.has(tab.id), true, path);
    }
    const { fake, groups, open } = setup();
    const other = await open("s1", { url: "moz-extension://other/approve.html?id=1" });
    await groups.endSession("s1");
    assert.equal(fake.tabs.has(other.id), true);
  });

  it("lets blankPage decide for a Foxleash page, and counts the prompt page as blank without it", async () => {
    for (const blank of [true, false]) {
      const fake = createFakeBrowser();
      fake.openTab({ url: "https://user.example/" });
      const asked: string[] = [];
      const groups = createSessionGroups(fake.browser, undefined, (url) => {
        asked.push(url);
        return blank;
      });
      const page = fake.openTab({ url: fake.browser.runtime.getURL("propose.html?id=1") });
      const prompt = fake.openTab({ url: fake.browser.runtime.getURL("approve.html?id=1") });
      await groups.ensureGroup("s1", page);
      await groups.ensureGroup("s1", prompt);
      await groups.endSession("s1");
      assert.deepEqual(asked, [page.url]);
      assert.equal(fake.tabs.has(page.id), !blank, String(blank));
      assert.equal(fake.tabs.has(prompt.id), !blank, String(blank));
    }
  });

  it("keeps a blank tab that is still loading", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "about:newtab", status: "loading" });
    await groups.endSession("s1");
    assert.equal(fake.tabs.has(tab.id), true);
    assert.notEqual(await groups.groupOf("s1"), undefined);
  });

  for (const url of [
    "about:blank#x",
    "about:newtab?x",
    "about:blankx",
    "about:home/",
    "About:blank",
    "",
  ]) {
    it(`does not count ${JSON.stringify(url)} as blank`, async () => {
      const { fake, groups, open } = setup();
      const tab = await open("s1", { url });
      await groups.endSession("s1");
      assert.equal(fake.tabs.has(tab.id), true);
    });
  }

  it("does not count a tab Firefox reports without a url or a status as blank", async () => {
    for (const missing of ["url", "status"] as const) {
      const { fake, groups, open } = setup();
      const tab = await open("s1", { url: "about:blank" });
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async (queryInfo) =>
        (await query(queryInfo)).map((found) => {
          const { [missing]: _dropped, ...rest } = found;
          return rest;
        });
      await groups.endSession("s1");
      assert.equal(fake.tabs.has(tab.id), true, missing);
    }
  });

  it("keeps blank tabs that are all of their window's tabs", async () => {
    const fake = createFakeBrowser();
    const groups = createSessionGroups(fake.browser);
    fake.openTab({ url: "https://other-window.example/", windowId: 2 });
    const tabs = [fake.openTab({ url: "about:blank" }), fake.openTab({ url: "about:newtab" })];
    for (const tab of tabs) await groups.ensureGroup("s1", tab);
    await groups.endSession("s1");
    for (const tab of tabs) assert.equal(fake.tabs.has(tab.id), true, tab.url);
    assert.notEqual(await groups.groupOf("s1"), undefined);
  });

  it("keeps a window open when the sessions whose blank tabs fill it end at once", async () => {
    const fake = createFakeBrowser();
    const groups = createSessionGroups(fake.browser);
    const first = fake.openTab({ url: "about:blank" });
    const second = fake.openTab({ url: "about:newtab" });
    await groups.ensureGroup("s1", first);
    await groups.ensureGroup("s2", second);
    await Promise.all([groups.endSession("s1"), groups.endSession("s2")]);
    assert.equal(fake.tabs.has(first.id), false);
    assert.equal(fake.tabs.has(second.id), true);
    assert.notEqual(await groups.groupOf("s2"), undefined);
  });

  it("closes the next session's group after one that failed to close", async () => {
    const { fake, groups, open } = setup();
    const failing = await open("s1", { url: "about:blank" });
    const next = await open("s2", { url: "about:blank" });
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      if (tabIds.includes(failing.id)) throw new Error("remove failed");
      await remove(tabIds);
    };
    const failed = groups.endSession("s1");
    const ended = groups.endSession("s2");
    await assert.rejects(failed, /remove failed/);
    await ended;
    assert.equal(fake.tabs.has(failing.id), true);
    assert.equal(fake.tabs.has(next.id), false);
  });

  it("does nothing for an unknown session", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "about:blank" });
    await groups.endSession("s2");
    assert.equal(fake.tabs.has(tab.id), true);
  });

  it("does nothing for a group the user closed", async () => {
    const { fake, groups, outside, open } = setup();
    const tab = await open("s1", { url: "about:blank" });
    const group = await groups.groupOf("s1");
    assert.ok(group !== undefined);
    fake.closeGroup(group.id);
    let removed = 0;
    fake.browser.tabs.remove = async () => {
      removed += 1;
    };
    await groups.endSession("s1");
    assert.equal(removed, 0);
    assert.equal(fake.tabs.has(tab.id), false);
    assert.equal(fake.tabs.has(outside.id), true);
  });

  it("forgets a group left with no tabs and closes nothing", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "about:blank" });
    fake.tabs.delete(tab.id);
    let removed = 0;
    fake.browser.tabs.remove = async () => {
      removed += 1;
    };
    await groups.endSession("s1");
    assert.equal(removed, 0);
    assert.equal(await groups.groupOf("s1"), undefined);
  });

  it("keeps a group whose page joined it from another window", async () => {
    const { fake, groups, open } = setup();
    const blank = await open("s1", { url: "about:blank" });
    const page = fake.openTab({ url: "https://example.com/", windowId: 2 });
    await groups.ensureGroup("s1", page);
    await groups.endSession("s1");
    assert.equal(fake.tabs.has(blank.id), true);
    assert.equal(fake.tabs.has(page.id), true);
  });

  it("forgets the group once it closed the tabs, even if the group lives on", async () => {
    const { fake, groups, open } = setup();
    await open("s1", { url: "about:blank" });
    const group = await groups.groupOf("s1");
    assert.ok(group !== undefined);
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await remove(tabIds);
      // The user moved a tab into the group while Firefox closed the others.
      fake.groups.set(group.id, group);
      fake.openTab({ url: "https://user.example/moved", groupId: group.id });
    };
    await groups.endSession("s1");
    assert.equal(await groups.groupOf("s1"), undefined);
  });

  it("waits for an ensureGroup already running for the session", async () => {
    const { fake, groups, open } = setup();
    const blank = await open("s1", { url: "about:blank" });
    const page = fake.openTab({ url: "https://example.com/" });
    const adding = groups.ensureGroup("s1", page);
    await groups.endSession("s1");
    const id = await adding;
    assert.equal(fake.tabs.has(blank.id), true);
    assert.equal(fake.tabs.get(page.id)?.groupId, id);
    assert.equal((await groups.groupOf("s1"))?.id, id);
  });

  it("finishes before an ensureGroup that starts after it", async () => {
    const { fake, groups, open } = setup();
    const blank = await open("s1", { url: "about:blank" });
    const first = await groups.groupOf("s1");
    const page = fake.openTab({ url: "https://example.com/" });
    const ending = groups.endSession("s1");
    const id = await groups.ensureGroup("s1", page);
    await ending;
    assert.equal(fake.tabs.has(blank.id), false);
    assert.notEqual(id, first?.id);
    assert.equal(fake.tabs.get(page.id)?.groupId, id);
  });

  it("rejects when Firefox cannot close the tabs, and keeps the session usable", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "about:blank" });
    const group = await groups.groupOf("s1");
    fake.browser.tabs.remove = async () => {
      throw new Error("remove failed");
    };
    await assert.rejects(groups.endSession("s1"), /remove failed/);
    assert.equal(fake.tabs.has(tab.id), true);
    assert.deepEqual(await groups.groupOf("s1"), group);
    const page = fake.openTab({ url: "https://example.com/" });
    assert.equal(await groups.ensureGroup("s1", page), group?.id);
  });

  it("keeps a blank group whose window's only other tab is being removed", async () => {
    const { fake, groups, open } = setup();
    const page = await open("s2", { url: "https://example.com/", windowId: 2 });
    const blank = await open("s1", { url: "about:blank", windowId: 2 });
    const calls: number[][] = [];
    const { promise: held } = Promise.withResolvers<void>();
    fake.browser.tabs.remove = (tabIds) => {
      calls.push(tabIds);
      return held;
    };
    assert.ok((await groups.closeTab(page.id, () => {})) !== false);
    await groups.endSession("s1");
    assert.deepEqual(calls, [[page.id]]);
    assert.equal(fake.tabs.has(blank.id), true);
  });
});

describe("closeTab", { timeout: 10000 }, () => {
  it("removes the tab and resolves with the removal when its window has another tab", async () => {
    const { fake, groups, outside, open } = setup();
    const tab = await open("s1", { url: "https://example.com/" });
    const closing = await groups.closeTab(tab.id, () => {});
    assert.ok(closing !== false);
    await closing.removed;
    assert.equal(fake.tabs.has(tab.id), false);
    assert.equal(fake.tabs.has(outside.id), true);
  });

  it("resolves false and removes nothing for a window's only tab", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "https://example.com/", windowId: 2 });
    let checked = false;
    assert.equal(
      await groups.closeTab(tab.id, () => {
        checked = true;
      }),
      false,
    );
    assert.equal(fake.tabs.has(tab.id), true);
    assert.equal(checked, false);
  });

  it("closes only one of a window's two tabs closed at once", async () => {
    const { fake, groups, open } = setup();
    const first = await open("s1", { url: "https://a.example/", windowId: 2 });
    const second = await open("s1", { url: "https://b.example/", windowId: 2 });
    const closed = await Promise.all([
      groups.closeTab(first.id, () => {}),
      groups.closeTab(second.id, () => {}),
    ]);
    assert.deepEqual(
      closed.map((close) => close !== false),
      [true, false],
    );
    const [firstClosed] = closed;
    assert.ok(firstClosed);
    await firstClosed.removed;
    assert.deepEqual(
      [...fake.tabs.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id),
      [second.id],
    );
  });

  it("refuses a window's last other tab at once while another session's end is still removing its blank tab", async () => {
    const { fake, groups, open } = setup();
    const blank = await open("s1", { url: "about:blank", windowId: 2 });
    const page = await open("s2", { url: "https://example.com/", windowId: 2 });
    const remove = fake.browser.tabs.remove;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    let removals = 0;
    fake.browser.tabs.remove = async (tabIds) => {
      removals += 1;
      await held;
      return remove(tabIds);
    };
    const ending = groups.endSession("s1");
    for (let turn = 0; turn < 10 && removals === 0; turn += 1) await flush();
    assert.equal(removals, 1);
    assert.equal(await groups.closeTab(page.id, () => {}), false);
    assert.equal(fake.tabs.has(page.id), true);
    release();
    await ending;
    assert.equal(fake.tabs.has(blank.id), false);
    assert.equal(fake.tabs.has(page.id), true);
  });

  it("reads the tab and its window when its turn comes, not when it was asked", async () => {
    const { fake, groups, open } = setup();
    const blank = await open("s1", { url: "about:blank", windowId: 2 });
    const first = await open("s2", { url: "https://a.example/", windowId: 2 });
    const second = await open("s2", { url: "https://b.example/", windowId: 2 });
    await open("s2", { url: "https://c.example/", windowId: 2 });
    const query = fake.browser.tabs.query;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    let queries = 0;
    fake.browser.tabs.query = async (queryInfo) => {
      queries += 1;
      if (queries === 1) await held;
      return query(queryInfo);
    };
    const ending = groups.endSession("s1");
    for (let turn = 0; turn < 10 && queries === 0; turn += 1) await flush();
    assert.equal(queries, 1);
    const get = fake.browser.tabs.get;
    let reads = 0;
    fake.browser.tabs.get = (tabId) => {
      reads += 1;
      return get(tabId);
    };
    let checked: number | undefined;
    const closingFirst = groups.closeTab(first.id, () => {});
    const closingSecond = groups.closeTab(second.id, (tab) => {
      checked = tab.groupId;
    });
    await flush();
    assert.equal(reads, 0);
    const torn = fake.tabs.get(first.id);
    assert.ok(torn);
    torn.windowId = 3;
    fake.ungroup(second.id);
    release();
    await ending;
    assert.equal(await closingFirst, false);
    assert.equal(fake.tabs.has(first.id), true);
    const closedSecond = await closingSecond;
    assert.ok(closedSecond !== false);
    await closedSecond.removed;
    assert.equal(checked, -1);
    assert.equal(fake.tabs.has(blank.id), false);
  });

  it("hands back a removal that rejects when Firefox cannot remove the tab, and closes again later", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "https://example.com/" });
    const remove = fake.browser.tabs.remove;
    const refusal = new Error("Invalid tab ID");
    fake.browser.tabs.remove = () => Promise.reject(refusal);
    const refused = await groups.closeTab(tab.id, () => {});
    assert.ok(refused !== false);
    await assert.rejects(refused.removed, refusal);
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(tab.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.equal(fake.tabs.has(tab.id), false);
  });

  it("rejects with the check's error, removes nothing, and closes again later", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "https://example.com/" });
    const refusal = new Error("refused");
    await assert.rejects(
      groups.closeTab(tab.id, () => {
        throw refusal;
      }),
      (error: unknown) => error === refusal,
    );
    assert.equal(fake.tabs.has(tab.id), true);
    const closed = await groups.closeTab(tab.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.equal(fake.tabs.has(tab.id), false);
  });

  it("keeps a window's other tab while Firefox still holds the first one it was asked to remove", async () => {
    const { fake, groups, open } = setup();
    const first = await open("s1", { url: "https://a.example/", windowId: 2 });
    const second = await open("s1", { url: "https://b.example/", windowId: 2 });
    const { promise: held } = Promise.withResolvers<void>();
    fake.browser.tabs.remove = () => held;
    const closed = await Promise.all([
      groups.closeTab(first.id, () => {}),
      groups.closeTab(second.id, () => {}),
    ]);
    assert.deepEqual(
      closed.map((close) => close !== false),
      [true, false],
    );
    assert.equal(fake.tabs.has(second.id), true);
    fake.removeTab(first.id);
    assert.deepEqual(
      [...fake.tabs.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id),
      [second.id],
    );
  });

  it("refuses while a removal it started is pending, and counts again once Firefox removed the tab", async () => {
    const { fake, groups, open } = setup();
    const first = await open("s1", { url: "https://a.example/", windowId: 2 });
    const second = await open("s1", { url: "https://b.example/", windowId: 2 });
    const remove = fake.browser.tabs.remove;
    const { promise: held } = Promise.withResolvers<void>();
    fake.browser.tabs.remove = () => held;
    assert.ok((await groups.closeTab(first.id, () => {})) !== false);
    assert.equal(await groups.closeTab(second.id, () => {}), false);
    fake.removeTab(first.id);
    const third = await open("s1", { url: "https://c.example/", windowId: 2 });
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(second.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.deepEqual(
      [...fake.tabs.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id),
      [third.id],
    );
  });

  it("forgets a tab Firefox refused to remove, so its sibling still closes", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "https://a.example/", windowId: 2 });
    const b = await open("s1", { url: "https://b.example/", windowId: 2 });
    const remove = fake.browser.tabs.remove;
    const refusal = new Error("Invalid tab ID");
    fake.browser.tabs.remove = () => Promise.reject(refusal);
    const refused = await groups.closeTab(a.id, () => {});
    assert.ok(refused !== false);
    await assert.rejects(refused.removed, refusal);
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(b.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.equal(fake.tabs.has(b.id), false);
    assert.equal(fake.tabs.has(a.id), true);
    assert.equal(await groups.closeTab(a.id, () => {}), false);
  });

  it("still counts a tab whose first removal is pending when a second removal of it fails", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "about:blank", windowId: 2 });
    const b = fake.openTab({ url: "https://b.example/", windowId: 2 });
    const { promise: held } = Promise.withResolvers<void>();
    fake.browser.tabs.remove = () => held;
    assert.ok((await groups.closeTab(a.id, () => {})) !== false);
    const refusal = new Error("Cannot remove the tab");
    fake.browser.tabs.remove = () => Promise.reject(refusal);
    await assert.rejects(groups.endSession("s1"), refusal);
    fake.browser.tabs.remove = () => held;
    assert.equal(await groups.closeTab(b.id, () => {}), false);
  });

  it("counts a tab the user kept on its page as open again, so its window's other tab closes", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "https://a.example/", windowId: 2 });
    const b = await open("s1", { url: "https://b.example/", windowId: 2 });
    const remove = fake.browser.tabs.remove;
    // As Stay on a beforeunload prompt does: the removal resolves and the tab stays.
    fake.browser.tabs.remove = async () => {};
    const kept = await groups.closeTab(a.id, () => {});
    assert.ok(kept !== false);
    await kept.removed;
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(b.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.deepEqual(windowTabs(fake, 2), [a.id]);
  });

  it("hands back the same removal, asking Firefox nothing, while it checks whether the tab stayed", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "https://a.example/", windowId: 2 });
    await open("s1", { url: "https://b.example/", windowId: 2 });
    const asked: number[][] = [];
    let hold = false;
    fake.browser.tabs.remove = async (tabIds) => {
      asked.push(tabIds);
      hold = true;
    };
    const get = fake.browser.tabs.get;
    const { promise: answered, resolve: answer } = Promise.withResolvers<void>();
    let probes = 0;
    fake.browser.tabs.get = async (tabId) => {
      if (hold) {
        hold = false;
        probes += 1;
        await answered;
      }
      return get(tabId);
    };
    const first = await groups.closeTab(a.id, () => {});
    assert.ok(first !== false);
    for (let turn = 0; turn < 10 && probes === 0; turn += 1) await flush();
    assert.equal(probes, 1);
    const again = await groups.closeTab(a.id, () => {});
    assert.ok(again !== false);
    assert.equal(again.removed, first.removed);
    assert.deepEqual(asked, [[a.id]]);
    answer();
    await first.removed;
    assert.equal(fake.tabs.has(a.id), true);
  });

  it("keeps a window's other tab until every removal of a kept tab has ended", async () => {
    const { fake, groups, open } = setup();
    const b = await open("s1", { url: "about:blank", windowId: 2 });
    const x = fake.openTab({ url: "https://user.example/", windowId: 2 });
    const remove = fake.browser.tabs.remove;
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const asked: number[][] = [];
    fake.browser.tabs.remove = (tabIds) => {
      asked.push(tabIds);
      return asked.length === 1 ? first.promise : second.promise;
    };
    assert.ok((await groups.closeTab(b.id, () => {})) !== false);
    const ending = groups.endSession("s1");
    for (let turn = 0; turn < 10 && asked.length < 2; turn += 1) await flush();
    assert.deepEqual(asked, [[b.id], [b.id]]);
    first.resolve();
    await flush();
    assert.equal(await groups.closeTab(x.id, () => {}), false);
    second.resolve();
    await ending;
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(x.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.deepEqual(windowTabs(fake, 2), [b.id]);
  });

  it("counts a tab Firefox no longer finds once its removal resolved as gone until it is removed", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "https://a.example/", windowId: 2 });
    const b = await open("s1", { url: "https://b.example/", windowId: 2 });
    let asked = false;
    // The moment between Firefox removing the tab and onRemoved reaching the extension.
    fake.browser.tabs.remove = async () => {
      asked = true;
    };
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = (tabId) =>
      asked && tabId === a.id ? Promise.reject(new Error(`Invalid tab ID: ${tabId}`)) : get(tabId);
    const closed = await groups.closeTab(a.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.equal(await groups.closeTab(b.id, () => {}), false);
  });

  it("closes a tab in another window and ends another session while one removal never settles", async () => {
    const { fake, groups, open } = setup();
    const stuck = await open("s1", { url: "https://a.example/", windowId: 2 });
    await open("s1", { url: "https://b.example/", windowId: 2 });
    const elsewhere = await open("s2", { url: "https://c.example/", windowId: 3 });
    fake.openTab({ url: "https://user.example/", windowId: 3 });
    const blank = await open("s3", { url: "about:blank", windowId: 4 });
    fake.openTab({ url: "https://user.example/", windowId: 4 });
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = (tabIds) =>
      tabIds.includes(stuck.id) ? new Promise<void>(() => {}) : remove(tabIds);
    assert.ok((await groups.closeTab(stuck.id, () => {})) !== false);
    const closed = await groups.closeTab(elsewhere.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.equal(fake.tabs.has(elsewhere.id), false);
    await groups.endSession("s3");
    assert.equal(fake.tabs.has(blank.id), false);
    assert.equal(fake.tabs.has(stuck.id), true);
  });

  it("clears a tab whose removal Firefox rejects after closeTab resolved, so its sibling still closes", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "https://a.example/", windowId: 2 });
    const b = await open("s1", { url: "https://b.example/", windowId: 2 });
    const remove = fake.browser.tabs.remove;
    const { promise: held, reject } = Promise.withResolvers<void>();
    fake.browser.tabs.remove = () => held;
    const handle = await groups.closeTab(a.id, () => {});
    assert.ok(handle !== false);
    assert.equal(await groups.closeTab(b.id, () => {}), false);
    const refusal = new Error("Invalid tab ID");
    reject(refusal);
    await flush();
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(b.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    assert.equal(fake.tabs.has(b.id), false);
    assert.equal(fake.tabs.has(a.id), true);
    await assert.rejects(handle.removed, refusal);
  });

  it("asks Firefox nothing for a tab whose removal has not settled, and asks again once it has", async () => {
    const { fake, groups, open } = setup();
    const a = await open("s1", { url: "https://a.example/", windowId: 2 });
    await open("s1", { url: "https://b.example/", windowId: 2 });
    const { promise: held, resolve: stay } = Promise.withResolvers<void>();
    const asked: number[][] = [];
    fake.browser.tabs.remove = (tabIds) => {
      asked.push(tabIds);
      return held;
    };
    const first = await groups.closeTab(a.id, () => {});
    const again = await groups.closeTab(a.id, () => {});
    assert.ok(first !== false && again !== false);
    assert.equal(again.removed, first.removed);
    assert.deepEqual(asked, [[a.id]]);
    stay();
    await first.removed;
    assert.ok((await groups.closeTab(a.id, () => {})) !== false);
    assert.deepEqual(asked, [[a.id], [a.id]]);
    assert.equal(fake.tabs.has(a.id), true);
  });
});

describe("isSessionGroup", { timeout: 10000 }, () => {
  it("is true for a group ensureGroup made", async () => {
    const { groups, open } = setup();
    const tab = await open("s1", { url: "https://example.com/" });
    assert.equal(groups.isSessionGroup(tab.groupId), true);
  });

  it("is false for no group and for a group the user made", async () => {
    const { fake, groups, outside, open } = setup();
    await open("s1", { url: "https://example.com/" });
    const userGroup = await fake.browser.tabs.group({ tabIds: [outside.id] });
    assert.equal(groups.isSessionGroup(-1), false);
    assert.equal(groups.isSessionGroup(undefined), false);
    assert.equal(groups.isSessionGroup(userGroup), false);
  });

  it("is false after endSession closed a blank group", async () => {
    const { groups, open } = setup();
    const tab = await open("s1", { url: "about:blank" });
    await groups.endSession("s1");
    assert.equal(groups.isSessionGroup(tab.groupId), false);
  });

  it("is false once groupOf found that the user closed the group", async () => {
    const { fake, groups, open } = setup();
    const tab = await open("s1", { url: "https://example.com/" });
    fake.closeGroup(tab.groupId);
    assert.equal(await groups.groupOf("s1"), undefined);
    assert.equal(groups.isSessionGroup(tab.groupId), false);
  });
});

describe("sessionOf", { timeout: 10000 }, () => {
  it("names the session whose group it is", async () => {
    const { groups, open } = setup();
    const first = await open("s1", { url: "https://example.com/" });
    const second = await open("s2", { url: "https://example.com/" });
    assert.equal(groups.sessionOf(first.groupId), "s1");
    assert.equal(groups.sessionOf(second.groupId), "s2");
  });

  it("is undefined for no group and for a group the user made", async () => {
    const { fake, groups, outside, open } = setup();
    await open("s1", { url: "https://example.com/" });
    const userGroup = await fake.browser.tabs.group({ tabIds: [outside.id] });
    assert.equal(groups.sessionOf(-1), undefined);
    assert.equal(groups.sessionOf(undefined), undefined);
    assert.equal(groups.sessionOf(userGroup), undefined);
  });

  it("is undefined after endSession closed a blank group", async () => {
    const { groups, open } = setup();
    const tab = await open("s1", { url: "about:blank" });
    assert.equal(groups.sessionOf(tab.groupId), "s1");
    await groups.endSession("s1");
    assert.equal(groups.sessionOf(tab.groupId), undefined);
  });
});

describe("rememberedSessionOf", { timeout: 10000 }, () => {
  it("answers a group an earlier background created, which no other member knows", async () => {
    const { fake, open } = setup();
    const tab = await open("s1", { url: "https://example.com/" });
    const later = createSessionGroups(fake.browser);
    assert.equal(await later.rememberedSessionOf(tab.groupId), "s1");
    assert.equal(later.sessionOf(tab.groupId), undefined);
    assert.equal(later.isSessionGroup(tab.groupId), false);
    assert.equal(await later.groupOf("s1"), undefined);
    assert.equal(later.sessionOf(tab.groupId), undefined);
    assert.equal(later.isSessionGroup(tab.groupId), false);
  });

  it("answers a group this created and forgot", async () => {
    const { fake, groups, open } = setup();
    const { groupId } = await open("s1", { url: "https://example.com/" });
    fake.closeGroup(groupId);
    assert.equal(await groups.groupOf("s1"), undefined);
    assert.equal(groups.sessionOf(groupId), undefined);
    assert.equal(await groups.rememberedSessionOf(groupId), "s1");
  });

  it("answers from memory before the stored list, also once the group is forgotten", async () => {
    const { fake, groups, open } = setup();
    const { groupId } = await open("new", { url: "https://example.com/" });
    await fake.browser.storage.local.set({
      [SESSION_GROUPS_KEY]: [{ id: groupId, session: "old" }],
    });
    assert.equal(await groups.rememberedSessionOf(groupId), "new");
    fake.closeGroup(groupId);
    assert.equal(await groups.groupOf("new"), undefined);
    assert.equal(await groups.rememberedSessionOf(groupId), "new");
  });

  it("answers undefined for no group without reading storage", async () => {
    const { fake, groups } = setup();
    fake.failNextGet();
    assert.equal(await groups.rememberedSessionOf(undefined), undefined);
    assert.equal(await groups.rememberedSessionOf(-1), undefined);
    await assert.rejects(fake.browser.storage.local.get(null), /cannot be read/);
  });

  it("answers undefined for a group nothing created", async () => {
    const { fake, groups } = setup();
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: [{ id: 7, session: "old" }] });
    assert.equal(await groups.rememberedSessionOf(8), undefined);
  });

  it("reads the stored list once and keeps it", async () => {
    const fake = createFakeBrowser();
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: [{ id: 7, session: "old" }] });
    const groups = createSessionGroups(fake.browser);
    assert.equal(await groups.rememberedSessionOf(7), "old");
    fake.failNextGet();
    assert.equal(await groups.rememberedSessionOf(7), "old");
    await assert.rejects(fake.browser.storage.local.get(null), /cannot be read/);
  });

  it("answers from memory alone while the stored list cannot be read, and reads it again", async (t) => {
    const warned = warnings(t);
    const fake = createFakeBrowser();
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: [{ id: 7, session: "old" }] });
    const groups = createSessionGroups(fake.browser);
    const tab = fake.openTab();
    const id = await groups.ensureGroup("s1", tab);
    fake.failNextGet();
    // Two calls at once share the one read.
    assert.deepEqual(
      await Promise.all([
        groups.rememberedSessionOf(7),
        groups.rememberedSessionOf(7),
        groups.rememberedSessionOf(id),
      ]),
      [undefined, undefined, "s1"],
    );
    assert.deepEqual(warned(), [
      { event: "read_session_groups_failed", error: "Error: Storage cannot be read" },
    ]);
    assert.equal(await groups.rememberedSessionOf(7), "old");
  });

  it("counts a malformed stored list as empty, warns, and replaces it at the next group", async (t) => {
    const good = { id: 7, session: "old" };
    const malformed: [string, unknown][] = [
      ["a record", good],
      ["a string", JSON.stringify([good])],
      ["a list with a string", [good, "x"]],
      ["a list with null", [good, null]],
      ["a list with a list", [good, [8, "old"]]],
      // biome-ignore lint/suspicious/noSparseArray: a hole is what this case stores.
      ["a list with a hole", [good, , good]],
      ["a fractional id", [good, { id: 1.5, session: "old" }]],
      ["an id past the safe integers", [good, { id: 2 ** 53, session: "old" }]],
      ["an id that is a string", [good, { id: "8", session: "old" }]],
      ["a session that is no string", [good, { id: 8, session: 8 }]],
      ["no session", [good, { id: 8 }]],
    ];
    const warned = warnings(t);
    for (const [name, value] of malformed) {
      const seen = warned().length;
      const fake = createFakeBrowser();
      await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: value });
      const groups = createSessionGroups(fake.browser);
      assert.equal(await groups.rememberedSessionOf(7), undefined, name);
      assert.deepEqual(warned().slice(seen), [{ event: "ignored_session_groups" }], name);
      const id = await groups.ensureGroup("s1", fake.openTab());
      assert.deepEqual(await storedGroups(fake), [{ id, session: "s1" }], name);
    }
  });

  it("counts a stored entry whose id or session is inherited as malformed", async (t) => {
    const cases = [
      { own: { session: "old" }, inherited: { id: 8 } },
      { own: { id: 8 }, inherited: { session: "old" } },
    ];
    const warned = warnings(t);
    for (const { own, inherited } of cases) {
      const seen = warned().length;
      const fake = createFakeBrowser();
      const entry: unknown = Object.assign(Object.create(inherited), own);
      // Storage keeps no prototypes, so a value handed back with one is passed in directly.
      fake.browser.storage.local.get = async () => ({ [SESSION_GROUPS_KEY]: [entry] });
      const groups = createSessionGroups(fake.browser);
      assert.equal(await groups.rememberedSessionOf(8), undefined);
      assert.deepEqual(warned().slice(seen), [{ event: "ignored_session_groups" }]);
    }
  });
});

describe("the stored tab groups", { timeout: 10000 }, () => {
  it("hold each new group, oldest first, and no group a tab joined", async () => {
    const { fake, open } = setup();
    const first = await open("s1", { url: "https://example.com/" });
    await open("s1", { url: "https://example.com/next" });
    const second = await open("s2", { url: "https://example.com/" });
    assert.deepEqual(await storedGroups(fake), [
      { id: first.groupId, session: "s1" },
      { id: second.groupId, session: "s2" },
    ]);
  });

  it("hold the group by the time ensureGroup resolves, also when storage is slow", async () => {
    const { fake, groups } = setup();
    const get = fake.browser.storage.local.get;
    fake.browser.storage.local.get = async (keys) => {
      await flush();
      return get(keys);
    };
    const id = await groups.ensureGroup("s1", fake.openTab());
    fake.browser.storage.local.get = get;
    assert.deepEqual(await storedGroups(fake), [{ id, session: "s1" }]);
  });

  it("keep both groups when the first one's write is still under way as the second is made", async () => {
    const { fake, groups } = setup();
    const set = fake.browser.storage.local.set;
    const held = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    fake.browser.storage.local.set = async (items) => {
      fake.browser.storage.local.set = set;
      writing.resolve();
      await held.promise;
      return set(items);
    };
    const first = groups.ensureGroup("s1", fake.openTab());
    await writing.promise;
    const second = groups.ensureGroup("s2", fake.openTab());
    await flush();
    held.resolve();
    const ids = await Promise.all([first, second]);
    assert.deepEqual(await storedGroups(fake), [
      { id: ids[0], session: "s1" },
      { id: ids[1], session: "s2" },
    ]);
  });

  it("keep the stored order, this life's groups last, with no id twice and this life's session", async () => {
    const { fake, open } = setup();
    const first = await open("s1", { url: "https://example.com/" });
    await fake.browser.storage.local.set({
      [SESSION_GROUPS_KEY]: [
        { id: 50, session: "old" },
        { id: first.groupId, session: "stale" },
        { id: 51, session: "older" },
      ],
    });
    const second = await open("s2", { url: "https://example.com/" });
    assert.deepEqual(await storedGroups(fake), [
      { id: 50, session: "old" },
      { id: 51, session: "older" },
      { id: first.groupId, session: "s1" },
      { id: second.groupId, session: "s2" },
    ]);
  });

  it("are not shortened by a read that fails, and take the group at the next append", async (t) => {
    const warned = warnings(t);
    const { fake, open } = setup();
    const seeded = [
      { id: 50, session: "old" },
      { id: 51, session: "older" },
    ];
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: seeded });
    fake.failNextGet();
    const first = await open("s1", { url: "https://example.com/" });
    assert.equal(fake.groups.has(first.groupId), true);
    assert.deepEqual(await storedGroups(fake), seeded);
    assert.deepEqual(warned(), [
      { event: "remember_groups_failed", error: "Error: Storage cannot be read" },
    ]);
    const second = await open("s2", { url: "https://example.com/" });
    assert.deepEqual(await storedGroups(fake), [
      ...seeded,
      { id: first.groupId, session: "s1" },
      { id: second.groupId, session: "s2" },
    ]);
  });

  it("take a group whose write failed at the next append, and the group is made all the same", async (t) => {
    const warned = warnings(t);
    const { fake, groups, open } = setup();
    const tab = fake.openTab();
    fake.failNextSet();
    const id = await groups.ensureGroup("s1", tab);
    assert.equal(fake.tabs.get(tab.id)?.groupId, id);
    assert.equal(groups.sessionOf(id), "s1");
    assert.equal(await storedGroups(fake), undefined);
    assert.deepEqual(warned(), [
      { event: "remember_groups_failed", error: "Error: Storage is full" },
    ]);
    const second = await open("s2", { url: "https://example.com/" });
    assert.deepEqual(await storedGroups(fake), [
      { id, session: "s1" },
      { id: second.groupId, session: "s2" },
    ]);
  });

  it("leave no rejection unhandled when the new group's title cannot be set", async (t) => {
    warnings(t);
    const { fake, groups } = setup();
    fake.failNextSet();
    fake.browser.tabGroups.update = async () => {
      throw new Error("update failed");
    };
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", collect);
    try {
      await assert.rejects(groups.ensureGroup("s1", fake.openTab()), /update failed/);
      await flush();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", collect);
    }
  });

  it("drop the oldest group without a tab over the cap", async () => {
    const { fake, open } = setup();
    const seeded = entries(1001, MAX_REMEMBERED_GROUPS);
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: seeded });
    const tab = await open("s1", { url: "https://example.com/" });
    assert.equal(MAX_REMEMBERED_GROUPS, 200);
    assert.deepEqual(await storedGroups(fake), [
      ...seeded.slice(1),
      { id: tab.groupId, session: "s1" },
    ]);
  });

  it("keep every group that still has a tab, also over the cap", async () => {
    const { fake, open } = setup();
    const seeded = entries(1001, MAX_REMEMBERED_GROUPS);
    for (const { id } of seeded) fake.openTab({ groupId: id });
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: seeded });
    const tab = await open("s1", { url: "https://example.com/" });
    assert.deepEqual(await storedGroups(fake), [...seeded, { id: tab.groupId, session: "s1" }]);
  });

  it("drop only as many of the oldest groups without a tab as the cap needs", async () => {
    const { fake, open } = setup();
    const seeded = entries(1001, MAX_REMEMBERED_GROUPS + 1);
    for (const groupId of [1001, 1002, 1004]) fake.openTab({ groupId });
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: seeded });
    const tab = await open("s1", { url: "https://example.com/" });
    const kept = seeded.filter(({ id }) => id !== 1003 && id !== 1005);
    assert.deepEqual(await storedGroups(fake), [...kept, { id: tab.groupId, session: "s1" }]);
  });

  it("keep every group when the open tabs cannot be read", async (t) => {
    const warned = warnings(t);
    const fake = createFakeBrowser();
    const seeded = entries(1001, MAX_REMEMBERED_GROUPS);
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: seeded });
    const groups = createSessionGroups({
      ...fake.browser,
      tabs: {
        ...fake.browser.tabs,
        query: async () => {
          throw new Error("Tabs cannot be read");
        },
      },
    });
    const id = await groups.ensureGroup("s1", fake.openTab());
    assert.deepEqual(await storedGroups(fake), [...seeded, { id, session: "s1" }]);
    assert.deepEqual(warned(), [
      { event: "remember_groups_failed", error: "Error: Tabs cannot be read" },
    ]);
  });

  it("read no tabs at the cap", async (t) => {
    const warned = warnings(t);
    const fake = createFakeBrowser();
    const seeded = entries(1001, MAX_REMEMBERED_GROUPS - 1);
    await fake.browser.storage.local.set({ [SESSION_GROUPS_KEY]: seeded });
    let queries = 0;
    const groups = createSessionGroups({
      ...fake.browser,
      tabs: {
        ...fake.browser.tabs,
        query: (queryInfo) => {
          queries += 1;
          return fake.browser.tabs.query(queryInfo);
        },
      },
    });
    const id = await groups.ensureGroup("s1", fake.openTab());
    assert.deepEqual(await storedGroups(fake), [...seeded, { id, session: "s1" }]);
    assert.equal(queries, 0);
    assert.deepEqual(warned(), []);
  });
});

describe("onGrouped", { timeout: 10000 }, () => {
  it("runs for a tab joining a new and an existing group, with the group known", async () => {
    const calls: { tabId: number; known: boolean }[] = [];
    const { fake, groups, open } = setup(async (tabId) => {
      calls.push({ tabId, known: groups.isSessionGroup(fake.tabs.get(tabId)?.groupId) });
    });
    const first = await open("s1", { url: "https://example.com/" });
    const second = await open("s1", { url: "https://example.com/next" });
    assert.equal(second.groupId, first.groupId);
    assert.deepEqual(calls, [
      { tabId: first.id, known: true },
      { tabId: second.id, known: true },
    ]);
  });

  it("runs before the new group's title is set", async () => {
    const called: number[] = [];
    const { fake, groups } = setup(async (tabId) => {
      called.push(tabId);
    });
    fake.browser.tabGroups.update = async () => {
      throw new Error("update failed");
    };
    const tab = fake.openTab({ url: "https://example.com/" });
    await assert.rejects(groups.ensureGroup("s1", tab), /update failed/);
    assert.deepEqual(called, [tab.id]);
    assert.equal(groups.isSessionGroup(fake.tabs.get(tab.id)?.groupId), true);
  });

  it("is waited for on the new-group and the existing-group path", async () => {
    let release = () => {};
    const { fake, groups } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    for (const url of ["https://example.com/", "https://example.com/next"]) {
      let settled = false;
      const adding = groups.ensureGroup("s1", fake.openTab({ url }));
      adding.then(() => {
        settled = true;
      });
      await flush();
      assert.equal(settled, false, url);
      release();
      await adding;
    }
  });
});

const PAGE = { url: "https://example.com/", active: false, discarded: true };
const OTHER_PAGE = { url: "https://example.com/next", active: false, discarded: true };
const BLANK_TAB = { url: "about:blank", active: true };

describe("createTab", { timeout: 10000 }, () => {
  it("with the setting off, creates the tab as before, in the group's window once there is one", async () => {
    const { fake, groups, created } = await windowSetup({ on: false });
    const first = await groups.createTab("s1", PAGE, PASS);
    assert.equal(first.windowId, fake.currentWindowId);
    const other = fake.openTab({ url: "about:blank", windowId: 2 });
    await groups.ensureGroup("s2", other);
    const second = await groups.createTab("s2", PAGE, PASS);
    assert.equal(second.windowId, 2);
    assert.deepEqual(created, [PAGE, { ...PAGE, windowId: 2 }]);
    assert.deepEqual(fake.windowCreations, []);
  });

  it("with the setting on, opens a new window for a session's page tab, unloaded", async () => {
    const { fake, groups, created } = await windowSetup();
    const tab = await groups.createTab("s1", PAGE, PASS);
    assert.deepEqual(fake.windowCreations, [{ url: "about:blank", focused: false }]);
    assert.notEqual(tab.windowId, fake.currentWindowId);
    assert.equal(fake.tabs.get(tab.id)?.discarded, true);
    assert.deepEqual(created, [{ ...PAGE, windowId: tab.windowId }]);
    const groupId = await groups.ensureGroup("s1", tab);
    assert.equal(fake.groups.get(groupId)?.windowId, tab.windowId);
    const later = await groups.createTab("s1", OTHER_PAGE, PASS);
    assert.equal(later.windowId, tab.windowId);
    assert.equal(fake.windowCreations.length, 1);
  });

  it("gives a blank tab request the new window's own blank tab", async () => {
    const { fake, groups, created } = await windowSetup();
    const tab = await groups.createTab("s1", BLANK_TAB, PASS);
    assert.equal(fake.windowCreations.length, 1);
    assert.deepEqual(created, []);
    assert.deepEqual(windowTabs(fake, tab.windowId), [tab.id]);
    const groupId = await groups.ensureGroup("s1", tab);
    assert.equal(fake.groups.get(groupId)?.windowId, tab.windowId);
    const second = await groups.createTab("s1", BLANK_TAB, PASS);
    assert.notEqual(second.id, tab.id);
    assert.equal(second.windowId, tab.windowId);
  });

  it("opens one window for parallel first requests of a session", async () => {
    for (const requests of [
      [PAGE, OTHER_PAGE],
      [BLANK_TAB, PAGE],
      [PAGE, BLANK_TAB],
    ]) {
      const { fake, groups } = await windowSetup();
      const tabs = await Promise.all(
        requests.map((request) => groups.createTab("s1", request, PASS)),
      );
      assert.equal(fake.windowCreations.length, 1, JSON.stringify(requests));
      const windowId = tabs[0]?.windowId;
      assert.notEqual(windowId, fake.currentWindowId);
      for (const tab of tabs) assert.equal(tab.windowId, windowId);
      // A blank request takes the window's own tab.
      const expected = requests.includes(BLANK_TAB) ? 2 : 3;
      assert.equal(windowTabs(fake, windowId).length, expected, JSON.stringify(requests));
    }
  });

  it("opens one window for each session", async () => {
    const { fake, groups } = await windowSetup();
    const first = await groups.createTab("s1", PAGE, PASS);
    const second = await groups.createTab("s2", PAGE, PASS);
    assert.equal(fake.windowCreations.length, 2);
    assert.notEqual(first.windowId, second.windowId);
  });

  it("creates a new blank tab when the window's own tab was navigated or grouped", async () => {
    const changes: [string, (fake: FakeBrowser, tabId: number) => Promise<unknown>][] = [
      ["navigated", async (fake, tabId) => fake.navigateByUser(tabId, "https://typed.example/")],
      [
        "grouped",
        (fake, tabId) =>
          fake.browser.tabs.group({
            tabIds: [tabId],
            createProperties: { windowId: fake.tabs.get(tabId)?.windowId ?? -1 },
          }),
      ],
      ["closed", async (fake, tabId) => fake.removeTab(tabId)],
    ];
    for (const [name, change] of changes) {
      const { fake, groups } = await windowSetup();
      const page = await groups.createTab("s1", PAGE, PASS);
      const first = otherTab(fake, page);
      await change(fake, first);
      await flush();
      const blank = await groups.createTab("s1", BLANK_TAB, PASS);
      assert.notEqual(blank.id, first, name);
      assert.equal(blank.windowId, page.windowId, name);
    }
  });

  it("removes the window it opened when the tab cannot be created in it", async () => {
    const { fake, groups } = await windowSetup();
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async () => {
      throw new Error("create failed");
    };
    await assert.rejects(groups.createTab("s1", PAGE, PASS), /create failed/);
    assert.deepEqual(fake.windowRemovals, [100]);
    assert.deepEqual(windowTabs(fake, 100), []);
    fake.browser.tabs.create = create;
    const tab = await groups.createTab("s1", PAGE, PASS);
    assert.equal(tab.windowId, 101);
  });

  it("counts a window it gave up on as closing, so a session ending meanwhile keeps the last one", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    // Firefox takes a moment to close the window given up on.
    const held = Promise.withResolvers<void>();
    const remove = fake.browser.windows.remove;
    fake.browser.windows.remove = async (windowId) => {
      if (windowId !== blank.windowId) await held.promise;
      return remove(windowId);
    };
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async () => {
      fake.browser.tabs.create = create;
      throw new Error("create failed");
    };
    await assert.rejects(groups.createTab("s2", PAGE, PASS), /create failed/);
    await groups.endSession("s1");
    held.resolve();
    await flush();
    assert.deepEqual(windowTabs(fake, blank.windowId), [blank.id]);
  });

  it("keeps the window when a create in a window it opened earlier fails", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    fake.browser.tabs.create = async () => {
      throw new Error("create failed");
    };
    await assert.rejects(groups.createTab("s1", OTHER_PAGE, PASS), /create failed/);
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(page.id), true);
  });

  it("rejects when Firefox cannot open the window, or opens it without a tab", async () => {
    const { fake, groups } = await windowSetup();
    fake.failNextWindowCreate(new Error("no window"));
    await assert.rejects(groups.createTab("s1", PAGE, PASS), /no window/);
    const create = fake.browser.windows.create;
    fake.browser.windows.create = async (createData) => {
      const { tabs: _tabs, ...window } = await create(createData);
      return window;
    };
    await assert.rejects(groups.createTab("s1", PAGE, PASS), /without a tab/);
    assert.deepEqual(fake.windowRemovals, [100]);
    assert.deepEqual(windowTabs(fake, 100), []);
  });

  it("opens the tab as with the setting off when the settings cannot be read", async () => {
    const { fake, groups } = await windowSetup();
    fake.browser.storage.local.get = async () => {
      throw new Error("storage is unavailable");
    };
    const tab = await groups.createTab("s1", PAGE, PASS);
    assert.equal(tab.windowId, fake.currentWindowId);
    assert.deepEqual(fake.windowCreations, []);
  });

  it("keeps using the session's window after the setting is turned off", async () => {
    const { fake, groups } = await windowSetup();
    const first = await groups.createTab("s1", PAGE, PASS);
    await fake.browser.storage.local.remove("sessionWindow");
    const second = await groups.createTab("s1", OTHER_PAGE, PASS);
    assert.equal(second.windowId, first.windowId);
  });

  it("opens a new window once the user closed the session's window", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    fake.closeWindow(page.windowId);
    const next = await groups.createTab("s1", PAGE, PASS);
    assert.notEqual(next.windowId, page.windowId);
    assert.notEqual(next.windowId, fake.currentWindowId);
    assert.equal(fake.windowCreations.length, 2);
  });

  it("opens a new window once the session's group is gone and its first tab settled", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    fake.openTab({ url: "https://user.example/", windowId: page.windowId });
    fake.closeGroup(page.groupId ?? -1);
    const next = await groups.createTab("s1", PAGE, PASS);
    assert.notEqual(next.windowId, page.windowId);
    assert.equal(fake.windowCreations.length, 2);
  });

  it("creates in the group's window when a group was made while it read the setting", async () => {
    const { fake, groups, outside } = await windowSetup();
    assert.ok(outside !== undefined);
    const [tab] = await Promise.all([
      groups.createTab("s1", PAGE, PASS),
      groups.ensureGroup("s1", outside),
    ]);
    assert.equal(tab.windowId, fake.currentWindowId);
    assert.deepEqual(fake.windowCreations, []);
  });

  it("gives a blank tab request the window's own tab only once", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async () => {
      throw new Error("group failed");
    };
    await assert.rejects(groups.ensureGroup("s1", blank), /group failed/);
    fake.browser.tabs.group = group;
    const second = await groups.createTab("s1", BLANK_TAB, PASS);
    assert.notEqual(second.id, blank.id);
    assert.equal(second.windowId, blank.windowId);
  });

  it("forgets a window it gave up on before Firefox reports it closed", async () => {
    for (const failure of ["create", "first tab"]) {
      const { fake, groups } = await windowSetup();
      // Firefox closes the window later.
      fake.browser.windows.remove = async (windowId) => {
        fake.windowRemovals.push(windowId);
      };
      if (failure === "create") {
        const create = fake.browser.tabs.create;
        fake.browser.tabs.create = async () => {
          fake.browser.tabs.create = create;
          throw new Error("create failed");
        };
        await assert.rejects(groups.createTab("s1", PAGE, PASS), /create failed/);
      } else {
        const page = await groups.createTab("s1", PAGE, PASS);
        fake.removeTab(page.id);
        await flush();
      }
      assert.deepEqual(fake.windowRemovals, [100], failure);
      const next = await groups.createTab("s1", PAGE, PASS);
      assert.equal(next.windowId, 101, failure);
    }
  });

  it("opens a new window once the user closed a window holding only its own tab", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    const other = await groups.createTab("s2", PAGE, PASS);
    fake.browser.tabs.group = async () => {
      throw new Error("group failed");
    };
    await assert.rejects(groups.ensureGroup("s1", blank), /group failed/);
    fake.closeWindow(blank.windowId);
    const next = await groups.createTab("s1", BLANK_TAB, PASS);
    assert.notEqual(next.windowId, blank.windowId);
    assert.equal(fake.tabs.has(next.id), true);
    const later = await groups.createTab("s2", OTHER_PAGE, PASS);
    assert.equal(later.windowId, other.windowId);
  });

  it("creates in the group's window when the group moved out of the session's window", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    moveGroup(fake, page.groupId, fake.currentWindowId);
    const next = await groups.createTab("s1", OTHER_PAGE, PASS);
    assert.equal(next.windowId, fake.currentWindowId);
  });
});

describe("the session's window", { timeout: 10000 }, () => {
  it("loses its own first tab once another tab in it is selected", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    const first = otherTab(fake, page);
    await groups.ensureGroup("s1", page);
    await flush();
    assert.equal(fake.tabs.has(first), true);
    await fake.browser.tabs.update(page.id, { active: true });
    await flush();
    assert.equal(fake.tabs.has(first), false);
    assert.deepEqual(windowTabs(fake, page.windowId), [page.id]);
    assert.deepEqual(fake.windowRemovals, []);
  });

  it("loses its own first tab only for a select in its own window", async () => {
    const { fake, groups } = await windowSetup();
    const first = await groups.createTab("s1", PAGE, PASS);
    await groups.ensureGroup("s1", first);
    const starter = otherTab(fake, first);
    await openPage(groups, fake, "s2", PAGE);
    assert.equal(fake.tabs.has(starter), true);
    await fake.browser.tabs.update(first.id, { active: true });
    await flush();
    assert.equal(fake.tabs.has(starter), false);
  });

  it("keeps the session's own blank tab that could not be grouped when another tab is selected", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async () => {
      throw new Error("group failed");
    };
    await assert.rejects(groups.ensureGroup("s1", blank), /group failed/);
    fake.browser.tabs.group = group;
    const page = await openPage(groups, fake, "s1", PAGE);
    assert.equal(page.windowId, blank.windowId);
    assert.equal(fake.tabs.has(blank.id), true);
  });

  it("does not hand out its own first tab once a select is removing it", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    await groups.ensureGroup("s1", page);
    const starter = otherTab(fake, page);
    // The removal reads the window late, so the blank request runs first.
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async (queryInfo) => {
      await flush();
      return query(queryInfo);
    };
    const selecting = fake.browser.tabs.update(page.id, { active: true });
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await selecting;
    await flush();
    assert.notEqual(blank.id, starter);
    assert.equal(fake.tabs.has(blank.id), true);
  });

  it("keeps its own first tab when the user navigated it, and while it is the one selected", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    const first = otherTab(fake, page);
    const firstTab = fake.tabs.get(first);
    assert.ok(firstTab !== undefined);
    firstTab.active = false;
    await fake.browser.tabs.update(first, { active: true });
    await flush();
    assert.equal(fake.tabs.has(first), true);
    fake.navigateByUser(first, "https://typed.example/");
    await flush();
    await fake.browser.tabs.update(page.id, { active: true });
    await flush();
    assert.equal(fake.tabs.has(first), true);
  });

  it("closes when the session's first tab is removed and only its own tab is left", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    await groups.ensureGroup("s1", page);
    const closed = await groups.closeTab(page.id, () => {});
    assert.ok(closed);
    await closed.removed;
    await flush();
    assert.deepEqual(fake.windowRemovals, [page.windowId]);
    assert.deepEqual(windowTabs(fake, page.windowId), []);
    assert.equal(await groups.groupOf("s1"), undefined);
    const next = await groups.createTab("s1", PAGE, PASS);
    assert.notEqual(next.windowId, page.windowId);
  });

  it("is left to the user who took its own first tab over before the session's tab failed", async () => {
    for (const outside of [true, false]) {
      const { fake, groups } = await windowSetup({ outside });
      const page = await groups.createTab("s1", PAGE, PASS);
      await groups.ensureGroup("s1", page);
      const first = otherTab(fake, page);
      fake.navigateByUser(first, "https://mail.example/inbox");
      await flush();
      const closed = await groups.closeTab(page.id, () => {});
      assert.ok(closed);
      await closed.removed;
      await flush();
      assert.deepEqual(fake.windowRemovals, [], String(outside));
      assert.deepEqual(windowTabs(fake, page.windowId), [first], String(outside));
      const next = await groups.createTab("s1", OTHER_PAGE, PASS);
      assert.notEqual(next.windowId, page.windowId, String(outside));
      assert.equal(fake.windowCreations.length, 2, String(outside));
    }
  });

  it("stays while a tab the user kept on its page is in it", async () => {
    const { fake, groups } = await windowSetup();
    const a = await groups.createTab("s1", PAGE, PASS);
    const b = await groups.createTab("s1", OTHER_PAGE, PASS);
    await groups.ensureGroup("s1", a);
    await groups.ensureGroup("s1", b);
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async () => {};
    const kept = await groups.closeTab(a.id, () => {});
    assert.ok(kept !== false);
    await kept.removed;
    fake.browser.tabs.remove = remove;
    const closed = await groups.closeTab(b.id, () => {});
    assert.ok(closed !== false);
    await closed.removed;
    await flush();
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(a.id), true);
  });

  it("stays while another tab of the session is in it", async () => {
    const { fake, groups } = await windowSetup();
    const [page, other] = await Promise.all([
      groups.createTab("s1", PAGE, PASS),
      groups.createTab("s1", OTHER_PAGE, PASS),
    ]);
    assert.ok(page !== undefined && other !== undefined);
    fake.removeTab(page.id);
    await flush();
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(other.id), true);
  });

  it("stays when it is the last window, and still at session end", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const page = await groups.createTab("s1", PAGE, PASS);
    const first = otherTab(fake, page);
    fake.removeTab(page.id);
    await flush();
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(first), true);
    // A tab closed in another window does not close it either.
    const user = fake.openTab({ url: "https://user.example/" });
    fake.openTab({ url: "https://user.example/other" });
    fake.removeTab(user.id);
    await flush();
    assert.deepEqual(fake.windowRemovals, []);
    await groups.endSession("s1");
    assert.equal(fake.windowRemovals.length, 1);
  });

  it("is kept when it would close at once with another session's window that is the only other", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const page = await groups.createTab("s1", PAGE, PASS);
    const blank = await groups.createTab("s2", BLANK_TAB, PASS);
    await groups.ensureGroup("s2", blank);
    fake.removeTab(page.id);
    await groups.endSession("s2");
    await flush();
    assert.equal(fake.windowRemovals.length, 1);
    assert.equal(
      windowTabs(fake, page.windowId).length + windowTabs(fake, blank.windowId).length,
      1,
    );
  });

  it("counts its tabs as going when Firefox settles its removal as another window closes", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const windows: number[] = [];
    for (const session of ["s1", "s2", "s3"]) {
      const tab = await groups.createTab(session, BLANK_TAB, PASS);
      await groups.ensureGroup(session, tab);
      windows.push(tab.windowId);
    }
    const remove = fake.browser.windows.remove;
    // windows.remove settles once any window has closed: here before the second window closes.
    fake.browser.windows.remove = async (windowId) => {
      if (windowId !== windows[1]) return remove(windowId);
      fake.windowRemovals.push(windowId);
    };
    await groups.endSession("s1");
    await groups.endSession("s2");
    await groups.endSession("s3");
    await flush();
    assert.deepEqual(fake.windowRemovals, windows.slice(0, 2));
    assert.equal(windowTabs(fake, windows[2] ?? -1).length, 1);
  });

  it("holds the session's next request until Firefox has removed it", async () => {
    const { fake, groups } = await windowSetup();
    const held = Promise.withResolvers<void>();
    const remove = fake.browser.windows.remove;
    fake.browser.windows.remove = async (windowId) => {
      await held.promise;
      return remove(windowId);
    };
    const page = await groups.createTab("s1", PAGE, PASS);
    fake.removeTab(page.id);
    await flush();
    let settled = false;
    const next = groups.createTab("s1", PAGE, PASS).then((tab) => {
      settled = true;
      return tab;
    });
    await flush();
    assert.equal(settled, false);
    held.resolve();
    assert.notEqual((await next).windowId, page.windowId);
  });

  it("closes at session end once another window opened after its first tab failed", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const page = await groups.createTab("s1", PAGE, PASS);
    fake.removeTab(page.id);
    await flush();
    fake.openTab({ url: "https://user.example/" });
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, [page.windowId]);
  });

  it("waits for a queued close before a tab request uses the window", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    await groups.ensureGroup("s1", page);
    fake.removeTab(page.id);
    const next = await groups.createTab("s1", OTHER_PAGE, PASS);
    assert.deepEqual(fake.windowRemovals, [page.windowId]);
    assert.notEqual(next.windowId, page.windowId);
    assert.equal(fake.tabs.has(next.id), true);
  });
});

describe("endSession with the session's window", { timeout: 10000 }, () => {
  it("closes the window when it holds only blank tabs of the group", async () => {
    const { fake, groups, outside } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    const second = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", second);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, [blank.windowId]);
    assert.deepEqual(windowTabs(fake, blank.windowId), []);
    assert.equal(outside !== undefined && fake.tabs.has(outside.id), true);
    assert.equal(await groups.groupOf("s1"), undefined);
    assert.equal(groups.isSessionGroup(blank.groupId), false);
  });

  it("closes the window with its own first tab and the group's prompt page", async () => {
    const { fake, groups } = await windowSetup();
    const prompt = fake.browser.runtime.getURL("approve.html?id=1");
    const tab = await groups.createTab("s1", { url: prompt, active: false, discarded: true }, PASS);
    await groups.ensureGroup("s1", tab);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, [tab.windowId]);
  });

  it("closes the window holding only its own first tab", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    fake.browser.tabs.group = async () => {
      throw new Error("group failed");
    };
    await assert.rejects(groups.ensureGroup("s1", blank), /group failed/);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, [blank.windowId]);
  });

  it("keeps the window when it is the last one", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(blank.id), true);
  });

  it("keeps the window, and its group, when the group holds a page", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(page.id), true);
    assert.equal(fake.tabs.has(blank.id), true);
  });

  it("keeps the window, closing only the group's tabs, when it holds a tab outside the group", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    const user = fake.openTab({ url: "https://user.example/", windowId: blank.windowId });
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(blank.id), false);
    assert.equal(fake.tabs.has(user.id), true);
  });

  it("keeps the window when it holds a blank tab of the user's outside the group", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    const user = fake.openTab({ url: "about:newtab", windowId: blank.windowId });
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(user.id), true);
  });

  it("applies the usual rule to a group moved out of the session's window", async () => {
    const { fake, groups } = await windowSetup();
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    const groupId = fake.tabs.get(blank.id)?.groupId;
    assert.ok(groupId !== undefined);
    const sessionWindow = blank.windowId;
    fake.openTab({ url: "about:blank", windowId: sessionWindow });
    moveGroup(fake, groupId, fake.currentWindowId);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(blank.id), false);
    assert.equal(windowTabs(fake, sessionWindow).length, 1);
  });

  it("closes the window left with only its own first tab by a group moved out of it", async () => {
    const { fake, groups, outside } = await windowSetup();
    const prompt = fake.browser.runtime.getURL("approve.html?id=1");
    const tab = await groups.createTab("s1", { url: prompt, active: false, discarded: true }, PASS);
    const groupId = await groups.ensureGroup("s1", tab);
    const sessionWindow = tab.windowId;
    moveGroup(fake, groupId, fake.currentWindowId);
    assert.equal(windowTabs(fake, sessionWindow).length, 1);
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, [sessionWindow]);
    assert.deepEqual(windowTabs(fake, sessionWindow), []);
    assert.equal(fake.tabs.has(tab.id), false);
    assert.equal(outside !== undefined && fake.tabs.has(outside.id), true);
    assert.equal(await groups.groupOf("s1"), undefined);
  });

  it("forgets the window, so the session's next first tab opens a new one", async () => {
    const { fake, groups } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    const groupId = await groups.ensureGroup("s1", page);
    fake.openTab({ url: "https://user.example/", windowId: page.windowId });
    await groups.endSession("s1");
    assert.deepEqual(fake.windowRemovals, []);
    fake.closeGroup(groupId);
    const next = await groups.createTab("s1", PAGE, PASS);
    assert.notEqual(next.windowId, page.windowId);
  });

  it("settles together with a tab request queued beside it", async () => {
    const { fake, groups } = await windowSetup();
    const [tab] = await Promise.all([groups.createTab("s1", PAGE, PASS), groups.endSession("s1")]);
    assert.ok(tab !== undefined && fake.tabs.has(tab.id));
    const page = await groups.createTab("s2", PAGE, PASS);
    fake.removeTab(page.id);
    await Promise.all([groups.endSession("s2"), groups.createTab("s2", PAGE, PASS)]);
  });
});

describe("createTab's check", { timeout: 10000 }, () => {
  it("refuses before creating the tab in the group's window", async () => {
    const { fake, groups, created } = await windowSetup({ on: false });
    await groups.ensureGroup("s1", fake.openTab({ url: "about:blank", windowId: 2 }));
    await assert.rejects(groups.createTab("s1", PAGE, refuse), ENDED);
    assert.deepEqual(created, []);
  });

  it("refuses before creating the tab with the setting off", async () => {
    const { fake, groups, created } = await windowSetup({ on: false });
    await assert.rejects(groups.createTab("s1", PAGE, refuse), ENDED);
    assert.deepEqual(created, []);
    assert.deepEqual(fake.windowCreations, []);
  });

  it("refuses before opening the session's own window", async () => {
    for (const request of [PAGE, BLANK_TAB]) {
      const { fake, groups, created } = await windowSetup();
      await assert.rejects(groups.createTab("s1", request, refuse), ENDED);
      assert.deepEqual(fake.windowCreations, [], request.url);
      assert.deepEqual(created, [], request.url);
    }
  });

  it("refuses before creating the tab in the session's own window, and keeps the window", async () => {
    const { fake, groups, created } = await windowSetup();
    const page = await groups.createTab("s1", PAGE, PASS);
    await assert.rejects(groups.createTab("s1", OTHER_PAGE, refuse), ENDED);
    assert.deepEqual(created, [{ ...PAGE, windowId: page.windowId }]);
    assert.deepEqual(fake.windowRemovals, []);
    assert.equal(fake.tabs.has(page.id), true);
  });

  it("refuses before creating the tab in the group's window found after waiting its turn", async () => {
    const { fake, groups, created } = await windowSetup();
    const tab = fake.openTab({ url: "about:blank" });
    const grouped = groups.ensureGroup("s1", tab);
    await assert.rejects(groups.createTab("s1", PAGE, refuse), ENDED);
    await grouped;
    assert.deepEqual(created, []);
    assert.deepEqual(fake.windowCreations, []);
  });

  it("creates nothing once the session ends while the group is read", async () => {
    const { fake, groups, created } = await windowSetup({ on: false });
    await groups.ensureGroup("s1", fake.openTab({ url: "about:blank", windowId: 2 }));
    const session = ending();
    const get = fake.browser.tabGroups.get;
    fake.browser.tabGroups.get = (groupId) => {
      session.end();
      return get(groupId);
    };
    await assert.rejects(groups.createTab("s1", PAGE, session.check), ENDED);
    assert.deepEqual(created, []);
  });

  it("creates nothing once the session ends while the settings are read", async () => {
    for (const on of [false, true]) {
      const { fake, groups, created } = await windowSetup({ on });
      const session = ending();
      const get = fake.browser.storage.local.get;
      fake.browser.storage.local.get = (keys) => {
        session.end();
        return get(keys);
      };
      await assert.rejects(groups.createTab("s1", PAGE, session.check), ENDED);
      assert.deepEqual(created, [], `setting ${on}`);
      assert.deepEqual(fake.windowCreations, [], `setting ${on}`);
    }
  });

  it("creates nothing once the session ends while it waits for the session's grouping", async () => {
    const { fake, groups, created } = await windowSetup();
    const tab = fake.openTab({ url: "about:blank" });
    const grouped = groups.ensureGroup("s1", tab);
    const session = ending();
    const get = fake.browser.tabGroups.get;
    fake.browser.tabGroups.get = (groupId) => {
      session.end();
      return get(groupId);
    };
    await assert.rejects(groups.createTab("s1", PAGE, session.check), ENDED);
    await grouped;
    assert.deepEqual(created, []);
    assert.deepEqual(fake.windowCreations, []);
  });

  it("removes the window it opened when the session ends while Firefox opens it", async () => {
    for (const request of [PAGE, BLANK_TAB]) {
      const { fake, groups, created } = await windowSetup();
      const session = ending();
      const create = fake.browser.windows.create;
      fake.browser.windows.create = async (createData) => {
        const window = await create(createData);
        session.end();
        return window;
      };
      await assert.rejects(groups.createTab("s1", request, session.check), ENDED);
      assert.deepEqual(created, [], request.url);
      assert.deepEqual(fake.windowRemovals, [100], request.url);
      assert.deepEqual(windowTabs(fake, 100), [], request.url);
      fake.browser.windows.create = create;
      const tab = await groups.createTab("s1", request, PASS);
      assert.equal(tab.windowId, 101, request.url);
    }
  });

  it("removes the window it opened, with the tab, when the session ends while Firefox makes the tab", async () => {
    const { fake, groups } = await windowSetup();
    const session = ending();
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      const tab = await create(properties);
      session.end();
      return tab;
    };
    await assert.rejects(groups.createTab("s1", PAGE, session.check), ENDED);
    assert.deepEqual(fake.windowRemovals, [100]);
    assert.deepEqual(windowTabs(fake, 100), []);
    fake.browser.tabs.create = create;
    const tab = await groups.createTab("s1", PAGE, PASS);
    assert.equal(tab.windowId, 101);
  });

  it("counts the tab of a window it gave up on as closing, so a session ending meanwhile keeps the last window", async () => {
    const { fake, groups } = await windowSetup({ outside: false });
    const blank = await groups.createTab("s1", BLANK_TAB, PASS);
    await groups.ensureGroup("s1", blank);
    // Firefox takes a moment to close the window given up on.
    const held = Promise.withResolvers<void>();
    const remove = fake.browser.windows.remove;
    fake.browser.windows.remove = async (windowId) => {
      if (windowId !== blank.windowId) await held.promise;
      return remove(windowId);
    };
    const session = ending();
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      fake.browser.tabs.create = create;
      const tab = await create(properties);
      session.end();
      return tab;
    };
    await assert.rejects(groups.createTab("s2", PAGE, session.check), ENDED);
    await groups.endSession("s1");
    held.resolve();
    await flush();
    assert.deepEqual(windowTabs(fake, blank.windowId), [blank.id]);
  });

  it("hands back the tab in a window it did not open when the session ends while Firefox makes it", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    const session = ending();
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      const tab = await create(properties);
      session.end();
      return tab;
    };
    const tab = await groups.createTab("s1", OTHER_PAGE, session.check);
    assert.equal(tab.windowId, page.windowId);
    assert.deepEqual(fake.windowRemovals, []);
  });
});

describe("showPromptWindow", { timeout: 10000 }, () => {
  it("brings the session's own window to the front", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: page.windowId, focused: true }]);
    assert.equal(fake.currentWindowId, page.windowId);
  });

  it("restores the session's own window when Firefox reports it minimized", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    const get = fake.browser.windows.get;
    fake.browser.windows.get = async (windowId) => ({
      ...(await get(windowId)),
      state: "minimized",
    });
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [
      { windowId: page.windowId, focused: true, state: "normal" },
    ]);
  });

  it("only draws attention with the setting off", async () => {
    const { fake, groups } = await windowSetup({ on: false });
    const page = await openPage(groups, fake, "s1", PAGE);
    const user = fake.currentWindowId;
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: user, drawAttention: true }]);
    assert.equal(fake.currentWindowId, user);
  });

  it("only draws attention to a window that is not the session's own", async () => {
    const { fake, groups } = await windowSetup();
    const user = fake.currentWindowId;
    const page = await openPage(groups, fake, "s1", PAGE);
    assert.notEqual(page.windowId, user);
    await groups.showPromptWindow("s1", user, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: user, drawAttention: true }]);
    assert.equal(fake.currentWindowId, user);
  });

  it("only draws attention to another session's own window", async () => {
    const { fake, groups } = await windowSetup();
    const user = fake.currentWindowId;
    const first = await openPage(groups, fake, "s1", PAGE);
    const second = await openPage(groups, fake, "s2", PAGE);
    assert.notEqual(first.windowId, second.windowId);
    await groups.showPromptWindow("s1", second.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: second.windowId, drawAttention: true }]);
    assert.equal(fake.currentWindowId, user);
  });

  it("still brings the session's own window to the front after the setting is turned off", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    await fake.browser.storage.local.remove("sessionWindow");
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: page.windowId, focused: true }]);
  });

  it("only draws attention once the session ended", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    await groups.endSession("s1");
    assert.equal(fake.tabs.has(page.id), true);
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: page.windowId, drawAttention: true }]);
  });

  it("resolves when Firefox cannot update the window", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    const asked: unknown[] = [];
    fake.browser.windows.update = async (windowId, updateInfo) => {
      asked.push({ windowId, ...updateInfo });
      throw new Error("No window with id");
    };
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    await groups.showPromptWindow("s1", fake.currentWindowId, WANTED);
    assert.deepEqual(asked, [
      { windowId: page.windowId, focused: true },
      { windowId: fake.currentWindowId, drawAttention: true },
    ]);
  });

  it("asks nothing when the update is no longer wanted", async () => {
    for (const on of [false, true]) {
      const { fake, groups } = await windowSetup({ on });
      const page = await openPage(groups, fake, "s1", PAGE);
      await groups.showPromptWindow("s1", page.windowId, () => false);
      assert.deepEqual(fake.windowUpdates, [], `setting ${on}`);
    }
  });

  it("asks nothing when the update stops being wanted while the window is read", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    let wanted = true;
    const get = fake.browser.windows.get;
    fake.browser.windows.get = (windowId) => {
      wanted = false;
      return get(windowId);
    };
    await groups.showPromptWindow("s1", page.windowId, () => wanted);
    assert.deepEqual(fake.windowUpdates, []);
  });

  it("brings the session's own window to the front when Firefox cannot read it", async () => {
    const { fake, groups } = await windowSetup();
    const page = await openPage(groups, fake, "s1", PAGE);
    fake.browser.windows.get = async () => {
      throw new Error("No window with id");
    };
    await groups.showPromptWindow("s1", page.windowId, WANTED);
    assert.deepEqual(fake.windowUpdates, [{ windowId: page.windowId, focused: true }]);
  });
});

describe("windowInFront", { timeout: 10000 }, () => {
  it("is true for the focused window and false for any other", async () => {
    const fake = createFakeBrowser();
    const groups = createSessionGroups(fake.browser);
    fake.openTab({ url: "https://user.example/", active: true });
    fake.openTab({ url: "https://user.example/a", windowId: 2 });
    assert.equal(await groups.windowInFront(1), true);
    assert.equal(await groups.windowInFront(2), false);
    fake.currentWindowId = 2;
    assert.equal(await groups.windowInFront(1), false);
    assert.equal(await groups.windowInFront(2), true);
  });

  it("is true when Firefox reports no focus or cannot read the window", async () => {
    const fake = createFakeBrowser();
    const groups = createSessionGroups(fake.browser);
    fake.browser.windows.get = async (windowId) => ({ id: windowId });
    assert.equal(await groups.windowInFront(2), true);
    fake.browser.windows.get = async () => {
      throw new Error("No window with id");
    };
    assert.equal(await groups.windowInFront(2), true);
  });
});

describe("the fake's windows", { timeout: 10000 }, () => {
  it("reports a window focused in windows.get as in getAll, unless the desktop refuses focus", async () => {
    const fake = createFakeBrowser();
    fake.openTab({ url: "https://user.example/", active: true });
    fake.openTab({ url: "https://user.example/a", windowId: 2 });
    assert.equal((await fake.browser.windows.get(1)).focused, true);
    assert.equal((await fake.browser.windows.get(2)).focused, false);
    fake.focusRefused = true;
    await fake.browser.windows.update(2, { focused: true });
    assert.deepEqual(fake.windowUpdates, [{ windowId: 2, focused: true }]);
    assert.equal(fake.currentWindowId, 1);
    assert.equal((await fake.browser.windows.get(2)).focused, false);
    fake.focusRefused = false;
    await fake.browser.windows.update(2, { focused: true });
    assert.equal(fake.currentWindowId, 2);
    assert.equal((await fake.browser.windows.get(2)).focused, true);
  });

  it("opens a window on one selected tab, and lists every window with its tabs", async () => {
    const fake = createFakeBrowser();
    const user = fake.openTab({ url: "https://user.example/", active: true });
    const activated: unknown[] = [];
    fake.browser.tabs.onActivated.addListener((info) => activated.push(info));
    const window = await fake.browser.windows.create({ url: "about:blank", focused: false });
    const tab = window.tabs?.[0];
    assert.ok(tab !== undefined);
    assert.deepEqual(window, { id: 100, focused: false, tabs: [tab] });
    assert.deepEqual(
      [tab.windowId, tab.url, tab.active, tab.groupId],
      [100, "about:blank", true, -1],
    );
    assert.deepEqual(activated, [{ tabId: tab.id, windowId: 100 }]);
    await fake.browser.tabs.update(tab.id, { active: true });
    assert.equal(activated.length, 1);
    const all = await fake.browser.windows.getAll({ windowTypes: ["normal"], populate: true });
    assert.deepEqual(
      all.map(({ id, focused, tabs }) => ({ id, focused, tabs: tabs?.map(({ id }) => id) })),
      [
        { id: 1, focused: true, tabs: [user.id] },
        { id: 100, focused: false, tabs: [tab.id] },
      ],
    );
  });

  it("closes a window with its tabs and groups, and tells which removals close a window", async () => {
    const fake = createFakeBrowser();
    const removed: unknown[] = [];
    const windows: number[] = [];
    fake.browser.tabs.onRemoved.addListener((tabId, info) => removed.push({ tabId, ...info }));
    fake.browser.windows.onRemoved.addListener((windowId) => windows.push(windowId));
    const kept = fake.openTab({ url: "https://user.example/" });
    const grouped = fake.openTab({ url: "https://user.example/a" });
    const groupId = await fake.browser.tabs.group({ tabIds: [grouped.id] });
    fake.closeGroup(groupId);
    const window = await fake.browser.windows.create({ url: "about:blank", focused: false });
    const first = window.tabs?.[0]?.id ?? -1;
    const page = fake.openTab({ url: "https://user.example/b", windowId: 100 });
    const pageGroup = await fake.browser.tabs.group({
      tabIds: [page.id],
      createProperties: { windowId: 100 },
    });
    fake.removeTab(kept.id);
    await fake.browser.windows.remove(100);
    assert.deepEqual(removed, [
      { tabId: grouped.id, windowId: 1, isWindowClosing: false },
      { tabId: kept.id, windowId: 1, isWindowClosing: false },
      { tabId: first, windowId: 100, isWindowClosing: true },
      { tabId: page.id, windowId: 100, isWindowClosing: true },
    ]);
    assert.deepEqual(windows, [100]);
    assert.equal(fake.groups.has(pageGroup), false);
    assert.deepEqual(fake.windowRemovals, [100]);
    await assert.rejects(fake.browser.windows.remove(100), /Invalid window ID: 100/);
  });
});

const ENDED = new Error("The session ended.");

function refuse(): void {
  throw ENDED;
}

/** A createTab check that passes until `end` is called. */
function ending(): { check: () => void; end: () => void } {
  let ended = false;
  return {
    check: () => {
      if (ended) throw ENDED;
    },
    end: () => {
      ended = true;
    },
  };
}

async function windowSetup({ on = true, outside = true } = {}) {
  const fake = createFakeBrowser();
  const groups = createSessionGroups(fake.browser);
  const userTab = outside
    ? fake.openTab({ url: "https://user.example/", active: true })
    : undefined;
  if (on) await fake.browser.storage.local.set({ sessionWindow: true });
  const created: Parameters<BrowserApi["tabs"]["create"]>[0][] = [];
  const create = fake.browser.tabs.create;
  fake.browser.tabs.create = (properties) => {
    created.push(properties);
    return create(properties);
  };
  return { fake, groups, created, outside: userTab };
}

/** Creates, groups and selects a session's page tab, as tab_open does. */
async function openPage(
  groups: SessionGroups,
  fake: FakeBrowser,
  session: string,
  properties: typeof PAGE,
): Promise<Tab> {
  const tab = await groups.createTab(session, properties, PASS);
  await groups.ensureGroup(session, tab);
  await fake.browser.tabs.update(tab.id, { url: properties.url, loadReplace: true });
  const selected = await fake.browser.tabs.update(tab.id, { active: true });
  await flush();
  return selected;
}

function windowTabs(fake: FakeBrowser, windowId: number | undefined): number[] {
  return [...fake.tabs.values()].filter((tab) => tab.windowId === windowId).map((tab) => tab.id);
}

/** The window's tab that is not `tab`: its own first tab. */
function otherTab(fake: FakeBrowser, tab: Tab): number {
  const other = windowTabs(fake, tab.windowId).find((id) => id !== tab.id);
  assert.ok(other !== undefined);
  return other;
}

function moveGroup(fake: FakeBrowser, groupId: number | undefined, windowId: number): void {
  const group = fake.groups.get(groupId ?? -1);
  assert.ok(group !== undefined);
  group.windowId = windowId;
  for (const tab of fake.tabs.values()) if (tab.groupId === groupId) tab.windowId = windowId;
}

/** What is stored under the remembered groups' key. */
async function storedGroups(fake: FakeBrowser): Promise<unknown> {
  return (await fake.browser.storage.local.get(null))[SESSION_GROUPS_KEY];
}

/** `count` stored groups with ids from `first` on, each of its own session. */
function entries(first: number, count: number): { id: number; session: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: first + index,
    session: `s${first + index}`,
  }));
}

/** Collects what is logged with console.warn, parsed. */
function warnings(t: TestContext): () => unknown[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}

function setup(onGrouped?: (tabId: number) => Promise<void>) {
  const fake = createFakeBrowser();
  const groups = createSessionGroups(fake.browser, onGrouped);
  const outside = fake.openTab({ url: "https://user.example/" });

  async function open(
    session: string,
    properties: Partial<Omit<FakeTab, "id" | "history" | "index">>,
  ): Promise<FakeTab> {
    const tab = fake.openTab(properties);
    await groups.ensureGroup(session, tab);
    return tab;
  }

  return { fake, groups, outside, open };
}
