import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createFakeBrowser, type FakeBrowser, flush } from "./fake-browser.ts";
import { createIndicator } from "./indicator.ts";
import { createSessionGroups } from "./session-groups.ts";

const TITLE_ON = "Foxleash: an agent session can use this tab";
const TITLE_STOPPED = "Foxleash: the agent session of this tab was stopped";
const TITLE_TOO_OLD =
  "Foxleash: the program on this computer is too old for this add-on. Open the settings to see what to do.";
const TITLE_ADDON_OLDER =
  "Foxleash: this add-on is older than the program on this computer. Open the settings to see what to do.";

describe("indicator", { timeout: 10000 }, () => {
  it("shows ON on a tab added to a session's group", async () => {
    const { fake, groups } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    await groups.ensureGroup("s1", tab);
    await flush();
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });

  it("leaves a tab opened outside any group to the global badge and title", async () => {
    const { fake } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    await flush();
    assert.equal(fake.badgeText.has(tab.id), false);
    assert.equal(fake.badgeTitle.has(tab.id), false);
  });

  it("shows ON again after a navigation cleared it", async () => {
    const seen: { text: string | undefined; title: string | undefined }[] = [];
    const { fake, groups } = setup((fake) => {
      fake.browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === "loading") {
          seen.push({ text: fake.badgeText.get(tabId), title: fake.badgeTitle.get(tabId) });
        }
      });
    });
    const tab = fake.openTab({ url: "https://example.com/" });
    await groups.ensureGroup("s1", tab);
    await flush();
    await fake.browser.tabs.update(tab.id, { url: "https://example.com/next" });
    await flush();
    assert.deepEqual(seen, [{ text: undefined, title: undefined }]);
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });

  it("removes the badge from a tab the user takes out of the group", async () => {
    const { fake, groups } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    const groupId = await groups.ensureGroup("s1", tab);
    await flush();
    fake.ungroup(tab.id);
    await flush();
    assert.equal(fake.badgeText.has(tab.id), false);
    assert.equal(fake.badgeTitle.has(tab.id), false);
    assert.equal(fake.groups.has(groupId), false);
  });

  it("shows no badge on a tab in a group the user made, even one titled Foxleash", async () => {
    const { fake } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    const groupId = await fake.browser.tabs.group({ tabIds: [tab.id] });
    await fake.browser.tabGroups.update(groupId, { title: "Foxleash", color: "orange" });
    await flush();
    assert.equal(fake.tabs.get(tab.id)?.groupId, groupId);
    assert.equal(fake.badgeText.has(tab.id), false);
    assert.equal(fake.badgeTitle.has(tab.id), false);
  });

  it("shows ON on a tab created in a session's group", async () => {
    const { fake, groups } = setup();
    const groupId = await groups.ensureGroup("s1", fake.openTab({ url: "https://example.com/" }));
    const tab = fake.openTab({ url: "https://example.com/opened", groupId });
    await flush();
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });

  it("opens the settings on a click and logs a failure to open them", async (t) => {
    const { fake } = setup();
    const warnings = captureWarnings(t);
    const tab = fake.openTab({ url: "https://example.com/", active: true });
    fake.clickAction(tab.id);
    await flush();
    assert.equal(fake.optionsPageOpened, 1);
    assert.deepEqual(warnings(), []);

    fake.browser.runtime.openOptionsPage = async () => {
      throw new Error("no settings");
    };
    fake.clickAction(tab.id);
    await flush();
    assert.deepEqual(warnings(), [{ event: "open_settings_failed", error: "Error: no settings" }]);
  });

  it("logs a refresh of a closed tab instead of rejecting", async (t) => {
    const { fake, indicator } = setup();
    const warnings = captureWarnings(t);
    const tab = fake.openTab({ url: "https://example.com/" });
    fake.tabs.delete(tab.id);
    await indicator.refresh(tab.id);
    assert.deepEqual(warnings(), [
      { event: "indicator_failed", tabId: tab.id, error: `Error: Invalid tab ID: ${tab.id}` },
    ]);
  });

  it("resolves a refresh once the badge and title are written", async () => {
    const { fake, indicator } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    let release = () => {};
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.browser.action.setTitle = () => written;
    let settled = false;
    const refreshing = indicator.refresh(tab.id).then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    release();
    await refreshing;
  });

  it("logs badge writes that fail because the tab closed, once", async (t) => {
    const { fake, groups } = setup((fake) => {
      fake.browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.groupId === -1) fake.tabs.delete(tabId);
      });
    });
    const warnings = captureWarnings(t);
    const tab = fake.openTab({ url: "https://example.com/" });
    await groups.ensureGroup("s1", tab);
    await flush();
    fake.ungroup(tab.id);
    await flush();
    assert.deepEqual(warnings(), [
      { event: "indicator_failed", tabId: tab.id, error: `Error: Invalid tab ID: ${tab.id}` },
    ]);
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });

  it("shows ON on a tab the user moves into a session's group", async () => {
    const { fake, groups } = setup();
    const groupId = await groups.ensureGroup("s1", fake.openTab({ url: "https://example.com/" }));
    const tab = fake.openTab({ url: "https://user.example/" });
    await flush();
    assert.equal(fake.badgeText.has(tab.id), false);
    await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    await flush();
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });

  it("turns ON off on every tab of a stopped session, and keeps it on another's", async (t) => {
    const { fake, groups, indicator, stopped } = setup();
    const warnings = captureWarnings(t);
    const first = fake.openTab({ url: "https://example.com/" });
    const groupId = await groups.ensureGroup("s1", first);
    const second = fake.openTab({ url: "https://example.com/second", groupId });
    const other = fake.openTab({ url: "https://example.com/other" });
    await groups.ensureGroup("s2", other);
    await flush();
    stopped.add("s1");
    await indicator.refreshSession("s1");
    for (const tab of [first, second]) {
      assert.equal(fake.badgeText.get(tab.id), "");
      assert.equal(fake.badgeTitle.get(tab.id), TITLE_STOPPED);
    }
    assert.equal(fake.badgeText.get(other.id), "ON");
    assert.equal(fake.badgeTitle.get(other.id), TITLE_ON);

    // A navigation shows the tab again from its group, still stopped.
    await fake.browser.tabs.update(first.id, { url: "https://example.com/next" });
    const opened = fake.openTab({ url: "https://example.com/opened", groupId });
    await flush();
    for (const tab of [first, opened]) {
      assert.equal(fake.badgeText.get(tab.id), "");
      assert.equal(fake.badgeTitle.get(tab.id), TITLE_STOPPED);
    }
    assert.deepEqual(warnings(), []);
  });

  it("refreshes nothing for a session whose group is gone, without a warning", async (t) => {
    const { fake, groups, indicator, stopped } = setup();
    const warnings = captureWarnings(t);
    const tab = fake.openTab({ url: "https://example.com/" });
    await groups.ensureGroup("s1", tab);
    await flush();
    fake.ungroup(tab.id);
    await flush();
    stopped.add("s1");
    let queried = false;
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = (info) => {
      queried = true;
      return query(info);
    };
    await indicator.refreshSession("s1");
    await indicator.refreshSession("never-started");
    assert.equal(queried, false);
    assert.equal(fake.badgeTitle.has(tab.id), false);
    assert.deepEqual(warnings(), []);
  });

  it("resolves a session's refresh once every tab's badge and title are written", async () => {
    const { fake, groups, indicator } = setup();
    await groups.ensureGroup("s1", fake.openTab({ url: "https://example.com/" }));
    await flush();
    const written = Promise.withResolvers<void>();
    fake.browser.action.setTitle = () => written.promise;
    let settled = false;
    const refreshing = indicator.refreshSession("s1").then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    written.resolve();
    await refreshing;
  });

  it("logs a failed refresh of a session's tabs instead of rejecting", async (t) => {
    const { fake, groups, indicator, stopped } = setup();
    const warnings = captureWarnings(t);
    const tab = fake.openTab({ url: "https://example.com/" });
    await groups.ensureGroup("s1", tab);
    await flush();
    stopped.add("s1");
    fake.browser.tabs.query = async () => {
      throw new Error("no tabs");
    };
    await indicator.refreshSession("s1");
    assert.deepEqual(warnings(), [
      { event: "indicator_failed", session: "s1", error: "Error: no tabs" },
    ]);
    assert.equal(fake.badgeText.get(tab.id), "ON");
  });

  for (const [state, title] of [
    ["too_old", TITLE_TOO_OLD],
    ["addon_older", TITLE_ADDON_OLDER],
  ] as const) {
    it(`shows ! and names the program's state ${state} on the whole button`, async () => {
      const { fake, groups, indicator } = setup();
      const tab = fake.openTab({ url: "https://example.com/" });
      await groups.ensureGroup("s1", tab);
      await flush();
      await indicator.showProgram(state);
      assert.equal(fake.globalBadgeText, "!");
      assert.equal(fake.globalBadgeTitle, title);
      assert.equal(fake.badgeText.get(tab.id), "ON");
      assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
    });
  }

  for (const state of ["connected", "missing", "checking"] as const) {
    it(`clears the button's notice when the program is ${state}`, async () => {
      const { fake, indicator } = setup();
      await indicator.showProgram("too_old");
      await indicator.showProgram(state);
      assert.equal(fake.globalBadgeText, "");
      assert.equal(fake.globalBadgeTitle, null);
    });
  }

  it("logs a failed notice on the button instead of rejecting", async (t) => {
    const { fake, indicator } = setup();
    const warnings = captureWarnings(t);
    fake.browser.action.setBadgeText = async () => {
      throw new Error("no badge");
    };
    await indicator.showProgram("too_old");
    assert.deepEqual(warnings(), [
      { event: "indicator_failed", state: "too_old", error: "Error: no badge" },
    ]);
  });
});

/** Wires the indicator as background.ts does; `before` runs on the fake first. */
function setup(before: (fake: FakeBrowser) => void = () => {}) {
  const fake = createFakeBrowser();
  before(fake);
  const groups = createSessionGroups(fake.browser, (id) => indicator.refresh(id));
  const stopped = new Set<string>();
  const indicator = createIndicator({
    browser: fake.browser,
    groups,
    stopped: (session) => stopped.has(session),
  });
  return { fake, groups, indicator, stopped };
}

function captureWarnings(t: TestContext): () => unknown[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}
