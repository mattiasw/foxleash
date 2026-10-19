import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeBrowser, type FakeTab } from "./fake-browser.ts";
import { createSessionGroups } from "./session-groups.ts";

const BLANK = ["about:blank", "about:newtab", "about:home"];

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
});

function setup() {
  const fake = createFakeBrowser();
  const groups = createSessionGroups(fake.browser);
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
