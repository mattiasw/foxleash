import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createFakeBrowser, type FakeBrowser, flush } from "./fake-browser.ts";
import { createIndicator } from "./indicator.ts";
import { createSessionGroups } from "./session-groups.ts";

const TITLE_ON = "Foxleash: an agent session can use this tab";

describe("indicator", { timeout: 10000 }, () => {
  it("shows ON on a tab added to a session's group", async () => {
    const { fake, groups } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    await groups.ensureGroup("s1", tab);
    await flush();
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });

  it("shows no badge on a tab opened outside any group", async () => {
    const { fake } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    await flush();
    assert.equal(fake.badgeText.get(tab.id), "");
    assert.equal(fake.badgeTitle.get(tab.id), "Foxleash");
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
    assert.equal(fake.badgeText.get(tab.id), "");
    assert.equal(fake.badgeTitle.get(tab.id), "Foxleash");
    assert.equal(fake.groups.has(groupId), false);
  });

  it("shows no badge on a tab in a group the user made, even one titled Foxleash", async () => {
    const { fake } = setup();
    const tab = fake.openTab({ url: "https://example.com/" });
    const groupId = await fake.browser.tabs.group({ tabIds: [tab.id] });
    await fake.browser.tabGroups.update(groupId, { title: "Foxleash", color: "orange" });
    await flush();
    assert.equal(fake.tabs.get(tab.id)?.groupId, groupId);
    assert.equal(fake.badgeText.get(tab.id), "");
    assert.equal(fake.badgeTitle.get(tab.id), "Foxleash");
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
    assert.equal(fake.badgeText.get(tab.id), "");
    await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    await flush();
    assert.equal(fake.badgeText.get(tab.id), "ON");
    assert.equal(fake.badgeTitle.get(tab.id), TITLE_ON);
  });
});

/** Wires the indicator as background.ts does; `before` runs on the fake first. */
function setup(before: (fake: FakeBrowser) => void = () => {}) {
  const fake = createFakeBrowser();
  before(fake);
  const groups = createSessionGroups(fake.browser, (id) => indicator.refresh(id));
  const indicator = createIndicator({ browser: fake.browser, groups });
  return { fake, groups, indicator };
}

function captureWarnings(t: TestContext): () => unknown[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}
