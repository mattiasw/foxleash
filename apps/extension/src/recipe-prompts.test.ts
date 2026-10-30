import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Recipe, RecipeFields } from "@foxhand/protocol";
import type { MessageSender } from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakeBrowser,
  type FakePort,
  flush,
} from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { createRecipePrompts } from "./recipe-prompts.ts";
import { readRecipes } from "./recipes.ts";
import { createSessionGroups } from "./session-groups.ts";
import { createSiteAccess } from "./site-access.ts";

const RECIPE: RecipeFields = {
  name: "Receipt",
  description: "Download the latest receipt.",
  sites: ["https://shop.example"],
  steps: "Open https://shop.example/orders.\nClick Download receipt.",
};
const PAGE_URL =
  /^moz-extension:\/\/[0-9a-f-]+\/propose\.html\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED: Recipe = { ...RECIPE, steps: "Old steps.", savedAt: "2026-01-02T03:04:05.000Z" };
const BUDGET =
  "Foxhand shows no more recipe pages in this session after three that were discarded or closed without an answer. Start a new session to be asked again.";

describe("propose", { timeout: 10000 }, () => {
  it("opens one selected page in the session's group, drawing attention, and resolves with its tab", async () => {
    const { fake, groups, recipes } = setup();
    const { tabId } = await recipes.propose("s1", RECIPE);
    const tab = fake.tabs.get(tabId);
    assert.ok(tab !== undefined);
    assert.match(tab.url, PAGE_URL);
    assert.equal(tab.active, true);
    assert.equal(tab.discarded, false);
    const group = await groups.groupOf("s1");
    assert.equal(tab.groupId, group?.id);
    assert.deepEqual(fake.tabUpdates, [{ tabId, url: tab.url, active: true, loadReplace: true }]);
    assert.deepEqual(fake.windowUpdates, [{ windowId: tab.windowId, drawAttention: true }]);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    assert.equal(recipes.openPrompt("s2"), undefined);
  });

  it("creates the tab unloaded on its page, so the page loads only once recorded", async () => {
    const { fake, recipes } = setup();
    const created = recordCreates(fake);
    const { tabId } = await recipes.propose("s1", RECIPE);
    assert.deepEqual(created, [{ url: fake.tabs.get(tabId)?.url, active: false, discarded: true }]);
  });

  it("opens the page in the window of the session's group", async () => {
    const { fake, groups, recipes } = setup();
    const other = fake.openTab({ windowId: 2, url: "https://a.example/" });
    await groups.ensureGroup("s1", other);
    const created = recordCreates(fake);
    const { tabId } = await recipes.propose("s1", RECIPE);
    const url = fake.tabs.get(tabId)?.url;
    assert.deepEqual(created, [{ url, active: false, discarded: true, windowId: 2 }]);
    assert.equal(fake.tabs.get(tabId)?.windowId, 2);
    assert.equal(fake.tabs.get(tabId)?.groupId, other.groupId);
  });

  it("gives each page its own URL", async () => {
    const { fake, recipes } = setup();
    const first = await recipes.propose("s1", RECIPE);
    const second = await recipes.propose("s2", RECIPE);
    assert.notEqual(fake.tabs.get(first.tabId)?.url, fake.tabs.get(second.tabId)?.url);
  });

  it("still opens the page when Firefox cannot draw attention to the window", async () => {
    const { fake, recipes } = setup();
    fake.browser.windows.update = async () => {
      throw new Error("No window");
    };
    const { tabId } = await recipes.propose("s1", RECIPE);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
  });

  it("refuses a second page while one is open, naming its tab", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await recipes.propose("s1", RECIPE);
    const created = recordCreates(fake);
    await assert.rejects(recipes.propose("s1", RECIPE), {
      code: "recipe_prompt_open",
      message: `Foxhand is still showing the user a recipe page in tab ${tabId}. Try again after the user has answered there.`,
    });
    assert.deepEqual(created, []);
  });

  it("opens one page of two parallel proposals, closing the other's tab", async () => {
    const { fake, recipes } = setup();
    const tabs = fake.tabs.size;
    const results = await Promise.allSettled([
      recipes.propose("s1", RECIPE),
      recipes.propose("s1", RECIPE),
    ]);
    const opened = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    assert.equal(opened.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(refused[0]?.reason instanceof ToolError);
    assert.equal(refused[0].reason.code, "recipe_prompt_open");
    await flush();
    assert.equal(fake.tabs.size, tabs + 1);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId: opened[0]?.value.tabId });
  });

  it("refuses while the session's site prompt is open, and the site prompt while the page is", async () => {
    const { fake, access, recipes } = setup();
    const tab = fake.openTab({ active: true });
    await access.ask("s1", "https://a.example/", tab.id);
    const created = recordCreates(fake);
    await assert.rejects(recipes.propose("s1", RECIPE), {
      code: "approval_pending",
      message: `Foxhand is waiting for the user to answer in tab ${tab.id} whether to allow https://a.example. Try again after the user has answered.`,
    });
    assert.deepEqual(created, []);
    const { tabId } = await recipes.propose("s2", RECIPE);
    const pending = `Foxhand is waiting for the user to answer in tab ${tabId} whether to save a recipe. Try again after the user has answered.`;
    await assert.rejects(access.check("s2", "https://b.example/"), {
      code: "approval_pending",
      message: pending,
    });
    const other = fake.openTab();
    await assert.rejects(access.ask("s2", "https://b.example/", other.id), {
      code: "approval_pending",
      message: pending,
    });
    assert.equal(access.openPrompt("s2"), undefined);
  });

  it("refuses when a site prompt opened while the page's tab was created, closing that tab", async () => {
    const { fake, access, recipes } = setup();
    const tab = fake.openTab({ active: true });
    const held = Promise.withResolvers<void>();
    const create = fake.browser.tabs.create;
    fake.browser.tabs.create = async (properties) => {
      await held.promise;
      return create(properties);
    };
    const proposing = recipes.propose("s1", RECIPE);
    let settled = false;
    proposing.catch(() => {
      settled = true;
    });
    await access.ask("s1", "https://a.example/", tab.id);
    // The refusal waits until Firefox has removed the page's tab.
    const removal = Promise.withResolvers<void>();
    const remove = fake.browser.tabs.remove;
    fake.browser.tabs.remove = async (tabIds) => {
      await removal.promise;
      return remove(tabIds);
    };
    held.resolve();
    await pageTab(fake);
    for (let turn = 0; turn < 10; turn += 1) await flush();
    assert.equal(settled, false);
    removal.resolve();
    await assert.rejects(proposing, {
      code: "approval_pending",
      message: `Foxhand is waiting for the user to answer in tab ${tab.id} whether to allow https://a.example. Try again after the user has answered.`,
    });
    assert.equal(recipes.openPrompt("s1"), undefined);
    assert.deepEqual(
      [...fake.tabs.values()].filter(({ url }) => url.includes("propose.html")),
      [],
    );
  });

  it("rejects and keeps no prompt, charging nothing, when the page cannot be loaded", async () => {
    const { fake, recipes } = setup();
    const update = fake.browser.tabs.update;
    let failures = 0;
    fake.browser.tabs.update = async (tabId, properties) => {
      if (properties.loadReplace === true && failures < 3) {
        failures += 1;
        throw new Error("Invalid tab ID");
      }
      return update(tabId, properties);
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(recipes.propose("s1", RECIPE), /Invalid tab ID/);
      assert.equal(recipes.openPrompt("s1"), undefined);
    }
    assert.deepEqual(
      [...fake.tabs.values()].filter(({ url }) => url.includes("propose.html")),
      [],
    );
    const { tabId } = await recipes.propose("s1", RECIPE);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
  });

  it("ends a page that connected before its group failed, and forgets it without charging", async () => {
    const { fake, recipes } = setup();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const held = Promise.withResolvers<void>();
      const group = fake.browser.tabs.group;
      fake.browser.tabs.group = async () => {
        fake.browser.tabs.group = group;
        await held.promise;
        throw new Error("No group");
      };
      const proposing = recipes.propose("s1", RECIPE);
      const tabId = await pageTab(fake);
      const page = connect(fake, tabId);
      held.resolve();
      await assert.rejects(proposing, /No group/);
      assert.deepEqual(page.posted, [{ type: "ended" }]);
      assert.equal(recipes.openPrompt("s1"), undefined);
      assert.equal(fake.tabs.has(tabId), false);
    }
    const opened = await recipes.propose("s1", RECIPE);
    assert.deepEqual(recipes.openPrompt("s1"), opened);
  });

  it("drops a page that connected before it loaded once its tab navigates away, and leaves the tab to the user", async () => {
    const { fake, recipes } = setup();
    const release = holdGroups(fake);
    const proposing = recipes.propose("s1", RECIPE);
    const tabId = await pageTab(fake);
    const page = connect(fake, tabId);
    fake.pushState(tabId, "https://a.example/");
    assert.equal(recipes.openPrompt("s1"), undefined);
    assert.deepEqual(page.posted, [{ type: "ended" }]);
    release();
    assert.deepEqual(await proposing, { tabId });
    assert.equal(fake.tabs.get(tabId)?.url, "https://a.example/");
    assert.deepEqual(fake.tabUpdates, []);
  });

  it("leaves a page answered before it loaded as it is", async () => {
    const { fake, recipes } = setup();
    const release = holdGroups(fake);
    const proposing = recipes.propose("s1", RECIPE);
    const tabId = await pageTab(fake);
    const page = connect(fake, tabId);
    page.deliver({ type: "answer", answer: "discard" });
    assert.deepEqual(page.posted, [{ type: "done", answer: "discarded" }]);
    release();
    assert.deepEqual(await proposing, { tabId });
    assert.deepEqual(fake.tabUpdates, []);
    assert.deepEqual(page.posted, [{ type: "done", answer: "discarded" }]);
  });

  it("keeps a tab the user took over when its group then fails", async () => {
    const { fake, recipes } = setup();
    const held = Promise.withResolvers<void>();
    const group = fake.browser.tabs.group;
    fake.browser.tabs.group = async () => {
      fake.browser.tabs.group = group;
      await held.promise;
      throw new Error("No group");
    };
    const proposing = recipes.propose("s1", RECIPE);
    const tabId = await pageTab(fake);
    connect(fake, tabId);
    fake.navigateByUser(tabId, "https://a.example/");
    held.resolve();
    await assert.rejects(proposing, /No group/);
    await flush();
    assert.equal(fake.tabs.get(tabId)?.url, "https://a.example/");
  });

  it("forgets a page whose tab closed before it loaded, without charging", async () => {
    const { fake, recipes } = setup();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const release = holdGroups(fake);
      const proposing = recipes.propose("s1", RECIPE);
      const tabId = await pageTab(fake);
      fake.removeTab(tabId);
      assert.equal(recipes.openPrompt("s1"), undefined);
      release();
      await assert.rejects(proposing);
    }
    const { tabId } = await recipes.propose("s1", RECIPE);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
  });
});

describe("the propose page", { timeout: 10000 }, () => {
  it("gets the proposal on ready", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await recipes.propose("s1", RECIPE);
    const page = connect(fake, tabId);
    page.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(page.posted, [{ type: "propose", fields: RECIPE }]);
  });

  it("gets the stored version of a name that is stored", async () => {
    const { fake, recipes } = setup();
    await seed(fake, STORED, { ...STORED, name: "Other" });
    const { page } = await shown(fake, recipes);
    assert.deepEqual(page.posted, [{ type: "propose", fields: RECIPE, current: STORED }]);
  });

  it("gets a reload problem and no proposal when the recipes cannot be read", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await recipes.propose("s1", RECIPE);
    const get = fake.browser.storage.local.get;
    fake.browser.storage.local.get = async () => {
      fake.browser.storage.local.get = get;
      throw new Error("Storage is unavailable");
    };
    const page = connect(fake, tabId);
    page.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(page.posted, [
      {
        type: "problems",
        problems: [
          { text: "Firefox could not read the stored recipes. Reload the page to try again." },
        ],
      },
    ]);
    page.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(page.posted[1], { type: "propose", fields: RECIPE });
  });

  it("posts no proposal to a page that closed or was replaced while the recipes were read", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await recipes.propose("s1", RECIPE);
    const reads = holdReads(fake);
    const replaced = connect(fake, tabId);
    replaced.deliver({ type: "ready" });
    const newer = connect(fake, tabId);
    reads.release();
    await flush();
    assert.deepEqual(replaced.posted, []);
    const second = holdReads(fake);
    newer.deliver({ type: "ready" });
    fake.removeTab(tabId);
    second.release();
    await flush();
    assert.deepEqual(newer.posted, [{ type: "ended" }]);
  });

  it("answers ready again after a reload, from the reloaded page", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    await fake.browser.tabs.reload(tabId);
    await flush();
    page.drop();
    const reloaded = connect(fake, tabId);
    reloaded.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(reloaded.posted, [{ type: "propose", fields: RECIPE }]);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
  });

  it("ignores messages from an older page once a newer one connected, and from a gone one", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    const newer = connect(fake, tabId);
    page.deliver({ type: "ready" });
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    page.deliver({ type: "answer", answer: "discard" });
    await flush();
    assert.equal(page.posted.length, 1);
    newer.drop();
    newer.deliver({ type: "answer", answer: "discard" });
    await flush();
    assert.deepEqual(newer.posted, []);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    assert.deepEqual(await readRecipes(fake.browser), []);
  });

  it("ends a page from another URL, tab or extension, and leaves another page's port alone", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await recipes.propose("s1", RECIPE);
    const url = fake.tabs.get(tabId)?.url ?? "";
    const other = fake.openTab();
    const senders: MessageSender[] = [
      { id: "other@example.org", url, tab: { id: tabId } },
      { url, tab: { id: tabId } },
      { id: FAKE_EXTENSION_ID, url: `${url}#`, tab: { id: tabId } },
      { id: FAKE_EXTENSION_ID, url: url.replace(/id=.*/, "id=x"), tab: { id: tabId } },
      { id: FAKE_EXTENSION_ID, url, tab: { id: other.id } },
      { id: FAKE_EXTENSION_ID, url },
      { id: FAKE_EXTENSION_ID, tab: { id: tabId } },
    ];
    for (const sender of senders) {
      const page = fake.connectPage("recipe", sender);
      page.deliver({ type: "ready" });
      page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
      await flush();
      assert.deepEqual(page.posted, [{ type: "ended" }], JSON.stringify(sender));
      assert.equal(page.disconnected, true);
    }
    const named = fake.connectPage("other", { id: FAKE_EXTENSION_ID, url, tab: { id: tabId } });
    named.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(named.posted, []);
    assert.equal(named.disconnected, false);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    assert.deepEqual(await readRecipes(fake.browser), []);
  });

  it("ignores messages that are not a ready or a valid answer", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    for (const message of [
      null,
      "ready",
      [],
      { type: "answer" },
      { type: "answer", answer: "saved" },
      { type: "answer", answer: "save" },
      { type: "answer", answer: "save", fields: RECIPE },
      { type: "answer", answer: "save", fields: "x", shown: NEW },
      { type: "answer", answer: "save", fields: RECIPE, shown: [] },
      { type: "answer", answer: "save", fields: RECIPE, shown: { name: "Receipt" } },
      { type: "answer", answer: "save", fields: RECIPE, shown: { name: 1, savedAt: null } },
      { type: "answer", answer: "save", fields: RECIPE, shown: { name: "Receipt", savedAt: 1 } },
      { type: "answer", answer: "save", fields: RECIPE, shown: { name: "Other", savedAt: null } },
      { type: "other" },
    ]) {
      page.deliver(message);
    }
    await flush();
    assert.equal(page.posted.length, 1);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    assert.deepEqual(await readRecipes(fake.browser), []);
  });
});

describe("saving", { timeout: 10000 }, () => {
  it("stores the edited recipe with savedAt and tells the page", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    const edited = { ...RECIPE, steps: "Edited steps.", sites: "https://shop.example/a\n" };
    page.deliver({ type: "answer", answer: "save", fields: edited, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
    const stored = (await fake.browser.storage.local.get(null))["recipe:Receipt"];
    assert.ok(stored !== null && typeof stored === "object" && "savedAt" in stored);
    assert.equal(typeof stored.savedAt, "string");
    assert.deepEqual(await readRecipes(fake.browser), [
      { ...RECIPE, steps: "Edited steps.", savedAt: stored.savedAt },
    ]);
    assert.equal(recipes.openPrompt("s1"), undefined);
    assert.equal(recipes.isBlankPage(fake.tabs.get(tabId)?.url ?? ""), true);
  });

  it("shows a stored name that looks the same as the recipe updated, and saves over it", async () => {
    const { fake, recipes } = setup();
    const stored = { ...STORED, name: "Coffee ☕️" };
    await seed(fake, stored);
    const proposed = { ...RECIPE, name: "Coffee ☕" };
    const { page } = await shown(fake, recipes, "s1", proposed);
    const fields = { ...proposed, name: stored.name };
    assert.deepEqual(page.posted, [{ type: "propose", fields, current: stored }]);
    page.deliver({
      type: "answer",
      answer: "save",
      fields,
      shown: { name: stored.name, savedAt: stored.savedAt },
    });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
    assert.deepEqual(
      (await readRecipes(fake.browser)).map(({ name, steps }) => [name, steps]),
      [[stored.name, RECIPE.steps]],
    );
  });

  it("prefers the stored recipe of exactly the proposed name over one that looks the same", async () => {
    const { fake, recipes } = setup();
    const plain = { ...STORED, name: "Coffee ☕" };
    const exact = { ...STORED, name: "Coffee ☕️", steps: "Exact steps." };
    await seed(fake, plain, exact);
    const proposed = { ...RECIPE, name: exact.name };
    const { page } = await shown(fake, recipes, "s1", proposed);
    assert.deepEqual(page.posted, [{ type: "propose", fields: proposed, current: exact }]);
  });

  it("updates a stored recipe shown to the user", async () => {
    const { fake, recipes } = setup();
    await seed(fake, STORED);
    const { page } = await shown(fake, recipes);
    const shownToken = { name: STORED.name, savedAt: STORED.savedAt };
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: shownToken });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
    assert.equal((await readRecipes(fake.browser))[0]?.steps, RECIPE.steps);
  });

  it("saves a renamed proposal as a new recipe and keeps the stored one", async () => {
    const { fake, recipes } = setup();
    await seed(fake, STORED);
    const { page } = await shown(fake, recipes);
    const renamed = { ...RECIPE, name: "Receipt 2" };
    const token = { name: STORED.name, savedAt: STORED.savedAt };
    page.deliver({ type: "answer", answer: "save", fields: renamed, shown: token });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
    assert.deepEqual(
      (await readRecipes(fake.browser)).map(({ name }) => name),
      ["Receipt", "Receipt 2"],
    );
  });

  it("posts the problems of invalid edits, stores nothing, and saves once they are fixed", async () => {
    const { fake, recipes } = setup();
    const { page } = await shown(fake, recipes);
    const invalid = { name: " ", description: RECIPE.description, sites: "ftp://x", steps: 3 };
    page.deliver({ type: "answer", answer: "save", fields: invalid, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), {
      type: "problems",
      problems: [
        { field: "name", text: "Give the recipe a name." },
        { field: "sites", text: "Line 1: this is not an http or https address.", line: 1 },
        { field: "steps", text: "The steps must be text." },
      ],
    });
    assert.deepEqual(await readRecipes(fake.browser), []);
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
  });

  it("reads only the edits' own fields", async () => {
    const { fake, recipes } = setup();
    const { page } = await shown(fake, recipes);
    const inherited = Object.assign(Object.create(RECIPE), {});
    page.deliver({ type: "answer", answer: "save", fields: inherited, shown: NEW });
    await flush();
    const posted = page.posted.at(-1);
    assert.ok(posted !== null && typeof posted === "object" && "type" in posted);
    assert.equal(posted.type, "problems");
    assert.deepEqual(await readRecipes(fake.browser), []);
  });

  it("names the stored recipe a rename lands on, and keeps the page", async () => {
    const { fake, recipes } = setup();
    await seed(fake, { ...STORED, name: "Taken" });
    const { tabId, page } = await shown(fake, recipes);
    page.deliver({
      type: "answer",
      answer: "save",
      fields: { ...RECIPE, name: "Taken" },
      shown: NEW,
    });
    await flush();
    assert.deepEqual(page.posted.at(-1), {
      type: "problems",
      problems: [{ field: "name", text: "A recipe named Taken exists." }],
    });
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    await saveAgain(fake, page);
  });

  it("names a stored name that looks the same", async () => {
    const { fake, recipes } = setup();
    await seed(fake, { ...STORED, name: "Ta‍ken" });
    const { page } = await shown(fake, recipes);
    page.deliver({
      type: "answer",
      answer: "save",
      fields: { ...RECIPE, name: "Taken" },
      shown: NEW,
    });
    await flush();
    assert.deepEqual(page.posted.at(-1), {
      type: "problems",
      problems: [{ field: "name", text: "A recipe named Ta‍ken exists." }],
    });
  });

  it("posts the current version when another writer saved the name meanwhile", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    await seed(fake, STORED);
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "changed", current: STORED });
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    assert.equal((await readRecipes(fake.browser))[0]?.steps, STORED.steps);
    const token = { name: STORED.name, savedAt: STORED.savedAt };
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: token });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
    assert.equal((await readRecipes(fake.browser))[0]?.steps, RECIPE.steps);
  });

  it("posts changed without a version when the shown recipe was deleted meanwhile", async () => {
    const { fake, recipes } = setup();
    await seed(fake, STORED);
    const { page } = await shown(fake, recipes);
    await fake.browser.storage.local.remove("recipe:Receipt");
    const token = { name: STORED.name, savedAt: STORED.savedAt };
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: token });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "changed" });
    assert.deepEqual(await readRecipes(fake.browser), []);
    await saveAgain(fake, page);
  });

  it("says how many recipes Foxhand keeps when storage is full", async () => {
    const { fake, recipes } = setup();
    await seed(
      fake,
      ...Array.from({ length: 100 }, (_, index) => ({ ...STORED, name: `R${index}` })),
    );
    const { tabId, page } = await shown(fake, recipes);
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), {
      type: "problems",
      problems: [
        { text: "Foxhand keeps at most 100 recipes. Delete one in Foxhand's settings first." },
      ],
    });
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    await fake.browser.storage.local.remove("recipe:R0");
    await saveAgain(fake, page);
  });

  it("asks to try again when storage cannot be written", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    fake.failNextSet();
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), {
      type: "problems",
      problems: [{ text: "Firefox could not save the recipe. Try again." }],
    });
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    await saveAgain(fake, page);
  });

  it("ignores a second save or a discard while the first save is out", async () => {
    const { fake, recipes } = setup();
    const { page } = await shown(fake, recipes);
    const writes = holdWrites(fake);
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    page.deliver({ type: "answer", answer: "discard" });
    await flush();
    assert.equal(writes.calls(), 1);
    writes.release();
    await flush();
    assert.deepEqual(page.posted.slice(1), [{ type: "done", answer: "saved" }]);
  });

  it("keeps what was stored when the page closes while saving, without charging", async () => {
    const { fake, recipes } = setup();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { tabId, page } = await shown(fake, recipes, "s1", { ...RECIPE, name: `R${attempt}` });
      const writes = holdWrites(fake);
      const token = { name: `R${attempt}`, savedAt: null };
      page.deliver({
        type: "answer",
        answer: "save",
        fields: { ...RECIPE, name: `R${attempt}` },
        shown: token,
      });
      await flush();
      fake.removeTab(tabId);
      assert.deepEqual(page.posted.at(-1), { type: "ended" });
      writes.release();
      await flush();
      assert.deepEqual(page.posted.at(-1), { type: "ended" });
    }
    assert.equal((await readRecipes(fake.browser)).length, 3);
    await recipes.propose("s1", RECIPE);
  });

  it("does not post a storage failure to a page closed while saving", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    const writes = holdWrites(fake);
    fake.failNextSet();
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    await flush();
    fake.removeTab(tabId);
    writes.release();
    await flush();
    assert.deepEqual(page.posted.slice(1), [{ type: "ended" }]);
  });
});

describe("discarding and closing", { timeout: 10000 }, () => {
  it("discards without storing, tells the page, and charges the budget", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    page.deliver({ type: "answer", answer: "discard" });
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "discarded" });
    assert.deepEqual(await readRecipes(fake.browser), []);
    assert.equal(recipes.openPrompt("s1"), undefined);
    assert.equal(recipes.isBlankPage(fake.tabs.get(tabId)?.url ?? ""), true);
    await spend(fake, recipes, 2);
    await assert.rejects(recipes.propose("s1", RECIPE), {
      code: "recipe_prompt_refused",
      message: BUDGET,
    });
    await recipes.propose("s2", RECIPE);
  });

  it("drops the page when its tab closes, charging the budget once the page connected", async () => {
    const { fake, recipes } = setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { tabId } = await recipes.propose("s1", RECIPE);
      fake.removeTab(tabId);
      assert.equal(recipes.openPrompt("s1"), undefined);
    }
    const { tabId, page } = await shown(fake, recipes);
    fake.removeTab(tabId);
    assert.deepEqual(page.posted.at(-1), { type: "ended" });
    assert.equal(recipes.openPrompt("s1"), undefined);
    await spend(fake, recipes, 2);
    await assert.rejects(recipes.propose("s1", RECIPE), { code: "recipe_prompt_refused" });
  });

  it("drops the page when its tab navigates away after showing it, but not on a reload", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    await fake.browser.tabs.reload(tabId);
    await flush();
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
    fake.navigateByUser(tabId, "https://a.example/");
    assert.deepEqual(page.posted.at(-1), { type: "ended" });
    assert.equal(recipes.openPrompt("s1"), undefined);
    await spend(fake, recipes, 2);
    await assert.rejects(recipes.propose("s1", RECIPE), { code: "recipe_prompt_refused" });
  });

  it("ignores another URL before the page committed, and commits on a complete load of it", async () => {
    const { fake, recipes } = setup();
    const release = holdGroups(fake);
    const proposing = recipes.propose("s1", RECIPE);
    const tabId = await pageTab(fake);
    const tab = fake.tabs.get(tabId);
    assert.ok(tab !== undefined);
    const url = tab.url;
    // A late URL event of the page the tab replaces.
    fake.pushState(tabId, "about:blank");
    assert.notEqual(recipes.openPrompt("s1"), undefined);
    fake.emitStatus(tabId, "complete");
    fake.pushState(tabId, "https://a.example/");
    assert.notEqual(recipes.openPrompt("s1"), undefined);
    tab.url = url;
    fake.emitStatus(tabId, "complete");
    fake.pushState(tabId, "https://a.example/");
    assert.equal(recipes.openPrompt("s1"), undefined);
    release();
    await proposing;
    assert.equal(recipes.openPrompt("s1"), undefined);
  });

  it("commits a page on its own URL event", async () => {
    const { fake, recipes } = setup();
    const release = holdGroups(fake);
    const proposing = recipes.propose("s1", RECIPE);
    const tabId = await pageTab(fake);
    const url = fake.tabs.get(tabId)?.url ?? "";
    fake.pushState(tabId, url);
    fake.pushState(tabId, "https://a.example/");
    assert.equal(recipes.openPrompt("s1"), undefined);
    release();
    await proposing;
    assert.equal(recipes.openPrompt("s1"), undefined);
  });

  it("ignores events of other tabs", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await shown(fake, recipes);
    const other = fake.openTab();
    fake.navigateByUser(other.id, "https://a.example/");
    fake.removeTab(other.id);
    assert.deepEqual(recipes.openPrompt("s1"), { tabId });
  });
});

describe("endSession", { timeout: 10000 }, () => {
  it("detaches the open page, which still saves, and keeps its group open", async () => {
    const { fake, groups, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    const url = fake.tabs.get(tabId)?.url ?? "";
    recipes.endSession("s1");
    await groups.endSession("s1");
    assert.equal(fake.tabs.has(tabId), true);
    assert.equal(recipes.openPrompt("s1"), undefined);
    assert.equal(recipes.isBlankPage(url), false);
    page.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "propose", fields: RECIPE });
    page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
    await flush();
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
    assert.equal((await readRecipes(fake.browser)).length, 1);
    assert.equal(recipes.isBlankPage(url), true);
    await groups.endSession("s1");
    assert.equal(fake.tabs.has(tabId), false);
  });

  it("lets a reloaded detached page connect again", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes);
    recipes.endSession("s1");
    page.drop();
    const reloaded = connect(fake, tabId);
    reloaded.deliver({ type: "ready" });
    await flush();
    assert.deepEqual(reloaded.posted, [{ type: "propose", fields: RECIPE }]);
  });

  it("charges no budget for a detached page's discard or close, and forgets the session's", async () => {
    const { fake, recipes } = setup();
    await spend(fake, recipes, 2);
    const first = await shown(fake, recipes);
    recipes.endSession("s1");
    first.page.deliver({ type: "answer", answer: "discard" });
    assert.deepEqual(first.page.posted.at(-1), { type: "done", answer: "discarded" });
    await spend(fake, recipes, 2);
    const second = await shown(fake, recipes);
    recipes.endSession("s1");
    fake.removeTab(second.tabId);
    assert.deepEqual(second.page.posted.at(-1), { type: "ended" });
    await spend(fake, recipes, 2);
    const third = await shown(fake, recipes);
    recipes.endSession("s1");
    fake.navigateByUser(third.tabId, "https://a.example/");
    assert.deepEqual(third.page.posted.at(-1), { type: "ended" });
    await spend(fake, recipes, 2);
    await recipes.propose("s1", RECIPE);
  });

  it("lets the session open a new page beside a detached one", async () => {
    const { fake, recipes } = setup();
    const { tabId } = await shown(fake, recipes);
    recipes.endSession("s1");
    const next = await recipes.propose("s1", RECIPE);
    assert.notEqual(next.tabId, tabId);
    assert.deepEqual(recipes.openPrompt("s1"), next);
  });

  it("ends a session without a page", () => {
    const { recipes } = setup();
    recipes.endSession("s1");
    assert.equal(recipes.openPrompt("s1"), undefined);
  });
});

describe("isBlankPage", { timeout: 10000 }, () => {
  it("holds only for a propose page that no open or detached prompt shows", async () => {
    const { fake, recipes } = setup();
    const base = fake.browser.runtime.getURL("propose.html");
    assert.equal(recipes.isBlankPage(`${base}?id=unknown`), true);
    assert.equal(recipes.isBlankPage(base), true);
    for (const url of [
      fake.browser.runtime.getURL("approve.html?id=1"),
      fake.browser.runtime.getURL("options.html"),
      "moz-extension://other/propose.html?id=1",
      "about:blank",
      "https://a.example/propose.html",
    ]) {
      assert.equal(recipes.isBlankPage(url), false, url);
    }
    const { tabId } = await recipes.propose("s1", RECIPE);
    const url = fake.tabs.get(tabId)?.url ?? "";
    assert.equal(recipes.isBlankPage(url), false);
    fake.removeTab(tabId);
    assert.equal(recipes.isBlankPage(url), true);
  });

  it("treats __proto__ as an ordinary session", async () => {
    const { fake, recipes } = setup();
    const { tabId, page } = await shown(fake, recipes, "__proto__");
    assert.deepEqual(recipes.openPrompt("__proto__"), { tabId });
    assert.equal(recipes.openPrompt("constructor"), undefined);
    recipes.endSession("__proto__");
    page.deliver({ type: "answer", answer: "discard" });
    assert.deepEqual(page.posted.at(-1), { type: "done", answer: "discarded" });
  });
});

const NEW = { name: RECIPE.name, savedAt: null };

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser, undefined, (url) => recipes.isBlankPage(url));
  const access = createSiteAccess({
    browser: fake.browser,
    groups,
    sessions: new Map(),
    timers,
    otherPrompt: (session) => recipes.openPrompt(session),
  });
  const recipes = createRecipePrompts({ browser: fake.browser, groups, access });
  // Keeps the window open, so a group of only blank tabs can close.
  fake.openTab({ url: "https://user.example/" });
  return { fake, groups, access, recipes };
}

type Recipes = ReturnType<typeof setup>["recipes"];

/** The page in `tabId` connecting from the URL that tab shows. */
function connect(fake: FakeBrowser, tabId: number): FakePort {
  return fake.connectPage("recipe", {
    id: FAKE_EXTENSION_ID,
    url: fake.tabs.get(tabId)?.url ?? "",
    tab: { id: tabId },
  });
}

/** Proposes and connects its page, which has had its proposal. */
async function shown(
  fake: FakeBrowser,
  recipes: Recipes,
  session = "s1",
  recipe = RECIPE,
): Promise<{ tabId: number; page: FakePort }> {
  const { tabId } = await recipes.propose(session, recipe);
  const page = connect(fake, tabId);
  page.deliver({ type: "ready" });
  await flush();
  assert.equal(page.posted.length, 1);
  return { tabId, page };
}

/** Discards `count` connected pages of session s1. */
async function spend(fake: FakeBrowser, recipes: Recipes, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const { page } = await shown(fake, recipes);
    page.deliver({ type: "answer", answer: "discard" });
  }
}

/** Saves the proposal as a new recipe from the page, which must still be open. */
async function saveAgain(fake: FakeBrowser, page: FakePort): Promise<void> {
  const before = (await readRecipes(fake.browser)).length;
  page.deliver({ type: "answer", answer: "save", fields: RECIPE, shown: NEW });
  await flush();
  assert.deepEqual(page.posted.at(-1), { type: "done", answer: "saved" });
  assert.equal((await readRecipes(fake.browser)).length, before + 1);
}

/** The propose page's tab once it exists, other than `except`. */
async function pageTab(fake: FakeBrowser, except?: number): Promise<number> {
  for (let turn = 0; turn < 50; turn += 1) {
    const tab = [...fake.tabs.values()].find(
      ({ id, url }) => id !== except && url.includes("propose.html"),
    );
    if (tab !== undefined) return tab.id;
    await flush();
  }
  assert.fail("no propose page tab");
}

/** Records the properties of every `tabs.create` call from now on. */
function recordCreates(fake: FakeBrowser): unknown[] {
  const created: unknown[] = [];
  const create = fake.browser.tabs.create;
  fake.browser.tabs.create = (properties) => {
    created.push(properties);
    return create(properties);
  };
  return created;
}

/** Holds the next `storage.local.get` until `release` runs. */
function holdReads(fake: FakeBrowser): { release(): void } {
  const held = Promise.withResolvers<void>();
  const get = fake.browser.storage.local.get;
  fake.browser.storage.local.get = async (keys) => {
    fake.browser.storage.local.get = get;
    await held.promise;
    return get(keys);
  };
  return { release: () => held.resolve() };
}

/** Holds `tabs.group` until the returned release runs. */
function holdGroups(fake: FakeBrowser): () => void {
  const held = Promise.withResolvers<void>();
  const group = fake.browser.tabs.group;
  fake.browser.tabs.group = async (options) => {
    await held.promise;
    return group(options);
  };
  return () => {
    fake.browser.tabs.group = group;
    held.resolve();
  };
}

async function seed(fake: FakeBrowser, ...stored: Recipe[]): Promise<void> {
  await fake.browser.storage.local.set(
    Object.fromEntries(stored.map((recipe) => [`recipe:${recipe.name}`, recipe])),
  );
}

/** Replaces `storage.local.set` with one that waits for `release`. */
function holdWrites(fake: FakeBrowser): { release(): void; calls(): number } {
  const held = Promise.withResolvers<void>();
  const set = fake.browser.storage.local.set;
  let calls = 0;
  fake.browser.storage.local.set = async (items) => {
    calls += 1;
    await held.promise;
    fake.browser.storage.local.set = set;
    return set(items);
  };
  return { release: () => held.resolve(), calls: () => calls };
}
