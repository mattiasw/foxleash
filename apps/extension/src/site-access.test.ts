import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageSender, RuntimePort, Tab } from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakeBrowser,
  type FakePort,
  flush,
} from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { createSessionGroups, type SessionGroups } from "./session-groups.ts";
import { grantSite, readSettings } from "./settings.ts";
import {
  APPROVAL_WAIT_MS,
  type Approval,
  createSiteAccess,
  portShowsPage,
  type SessionMemory,
  type SessionState,
  type SiteAccess,
} from "./site-access.ts";

describe("view", () => {
  it("reads storage once per call and sees a later grant in the next view", async (t) => {
    const { fake, access } = setup();
    const get = t.mock.method(fake.browser.storage.local, "get");
    const before = await access.view("s1");
    assert.equal(get.mock.callCount(), 1);
    await grantSite(fake.browser, "https://a.example");
    const after = await access.view("s1");
    assert.equal(get.mock.callCount(), 2);
    assert.equal(before.allowed("https://a.example/"), false);
    assert.equal(after.allowed("https://a.example/"), true);
    after.allowed("https://b.example/");
    after.tabInfo(tab({ url: "https://a.example/" }));
    assert.equal(get.mock.callCount(), 2);
  });

  it("rejects when storage cannot be read", async () => {
    const { fake, access } = setup();
    fake.browser.storage.local.get = async () => {
      throw new Error("storage is unavailable");
    };
    await assert.rejects(access.view("s1"), /storage is unavailable/);
  });
});

describe("allowed", () => {
  it("allows a stored site and a site granted for the session", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://stored.example");
    sessions.set("s1", state(["http://127.0.0.1:4567"]));
    const view = await access.view("s1");
    assert.equal(view.allowed("https://stored.example/any/path?q=1"), true);
    assert.equal(view.allowed("https://STORED.example.:443/"), true);
    assert.equal(view.allowed("http://127.0.0.1:4567/a"), true);
  });

  it("refuses other sites, another session's grant and pages that are not websites", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://stored.example");
    sessions.set("s2", state(["https://other.example"]));
    const view = await access.view("s1");
    for (const url of [
      "http://stored.example/",
      "https://stored.example:8443/",
      "https://sub.stored.example/",
      "https://other.example/",
      "about:blank",
      "file:///etc/passwd",
      "moz-extension://abc/options.html",
      "",
      "not a url",
    ]) {
      assert.equal(view.allowed(url), false, url);
    }
  });

  it("treats __proto__ as an ordinary session id", async () => {
    const { access, sessions } = setup();
    sessions.set("__proto__", state(["https://a.example"]));
    assert.equal((await access.view("__proto__")).allowed("https://a.example/"), true);
    assert.equal((await access.view("constructor")).allowed("https://a.example/"), false);
  });
});

describe("tabInfo", () => {
  it("shows a tab on an allowed site in full once it has loaded", async () => {
    const { fake, access } = setup();
    await grantSite(fake.browser, "https://a.example");
    const view = await access.view("s1");
    const info = view.tabInfo(tab({ url: "https://a.example/inbox?id=7", title: "Inbox" }));
    assert.deepEqual(info, {
      id: 3,
      url: "https://a.example/inbox?id=7",
      title: "Inbox",
      active: true,
    });
    assert.deepEqual(Object.keys(info).sort(), ["active", "id", "title", "url"]);
  });

  it("hides the title of a tab on an allowed site while it loads", async () => {
    const { fake, access } = setup();
    await grantSite(fake.browser, "https://a.example");
    const view = await access.view("s1");
    assert.deepEqual(view.tabInfo(tab({ url: "https://a.example/", status: "loading" })), {
      id: 3,
      url: "https://a.example/",
      title: "",
      active: true,
    });
    const { status: _status, ...noStatus } = tab({ url: "https://a.example/" });
    assert.equal(view.tabInfo(noStatus).title, "");
  });

  it("reports an empty title for an allowed tab Firefox gives none", async () => {
    const { fake, access } = setup();
    await grantSite(fake.browser, "https://a.example");
    const view = await access.view("s1");
    const { title: _title, ...untitled } = tab({ url: "https://a.example/" });
    assert.equal(view.tabInfo(untitled).title, "");
  });

  it("redacts every other tab to its site or scheme, with no title", async () => {
    const { fake, access } = setup();
    await grantSite(fake.browser, "https://a.example");
    const view = await access.view("s1");
    const cases: [string | undefined, string][] = [
      ["https://b.example/inbox?id=7#top", "https://b.example"],
      ["http://a.example/", "http://a.example"],
      ["https://example.com../", "https:"],
      ["about:blank", "about:blank"],
      ["about:config", "about:"],
      ["file:///home/user/secret.txt", "file:"],
      ["moz-extension://abc/options.html", "moz-extension:"],
      ["data:text/html,<p>x</p>", "data:"],
      ["not a url", ""],
      [undefined, ""],
    ];
    for (const [url, redacted] of cases) {
      const { url: _url, ...rest } = tab({ title: "Secret" });
      const info = view.tabInfo(url === undefined ? rest : { ...rest, url });
      assert.deepEqual(info, { id: 3, url: redacted, title: "", active: true }, String(url));
      assert.deepEqual(Object.keys(info).sort(), ["active", "id", "title", "url"]);
    }
  });

  it("can be passed to map without its view", async () => {
    const { fake, access } = setup();
    await grantSite(fake.browser, "https://a.example");
    const { tabInfo } = await access.view("s1");
    assert.deepEqual(
      [tab({ url: "https://a.example/x" }), tab({ url: "https://b.example/x" })]
        .map(tabInfo)
        .map(({ url }) => url),
      ["https://a.example/x", "https://b.example"],
    );
  });
});

describe("blocked", () => {
  it("blocks a built-in pattern and its subdomains, and nothing else", async () => {
    const { access } = setup();
    const view = await access.view("s1");
    assert.equal(view.blocked("https://www.paypal.com/"), true);
    assert.equal(view.blocked("http://paypal.com:8080/x"), true);
    for (const url of [
      "https://a.example/",
      "https://notpaypal.com/",
      "about:blank",
      "file:///home/user/paypal.com",
      "",
    ]) {
      assert.equal(view.blocked(url), false, url);
    }
  });

  it("uses a stored blocklist instead of the built-in one", async () => {
    const { fake, access } = setup();
    await fake.browser.storage.local.set({ blocklist: ["chase.com"] });
    const view = await access.view("s1");
    assert.equal(view.blocked("https://www.chase.com/"), true);
    assert.equal(view.blocked("https://www.paypal.com/"), false);
  });

  it("wins over a stored grant and a session grant", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://www.paypal.com");
    sessions.set("s1", state(["https://venmo.com"]));
    const view = await access.view("s1");
    for (const url of ["https://www.paypal.com/inbox", "https://venmo.com/inbox"]) {
      assert.equal(view.allowed(url), false, url);
      const info = view.tabInfo(tab({ url, title: "Secret" }));
      assert.deepEqual(info, { id: 3, url: siteOfUrl(url), title: "", active: true });
    }
  });
});

describe("check", () => {
  it("refuses a blocked site, naming it and the blocklist", async () => {
    const { access } = setup();
    await assert.rejects(access.check("s1", "https://www.paypal.com/x?y=1"), {
      code: "site_blocked",
      message:
        "Foxleash does not act on https://www.paypal.com: it is on Foxleash's blocklist, which by default lists common financial and health sites.",
    });
  });

  it("refuses a blocked site even when it is granted", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://www.paypal.com");
    sessions.set("s1", state(["https://venmo.com"]));
    await rejectsWith(access.check("s1", "https://www.paypal.com/"), "site_blocked");
    await rejectsWith(access.check("s1", "https://venmo.com/"), "site_blocked");
  });

  it("allows a stored or session grant and asks for an unapproved site", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://stored.example");
    sessions.set("s1", state(["https://session.example"]));
    assert.deepEqual(await access.check("s1", "https://stored.example/a"), {
      decision: "allowed",
    });
    assert.deepEqual(await access.check("s1", "https://session.example/a"), {
      decision: "allowed",
    });
    assert.deepEqual(await access.check("s1", "https://other.example/a"), { decision: "ask" });
    assert.deepEqual(await access.check("s2", "https://session.example/a"), { decision: "ask" });
  });

  it("refuses a URL with no site without reading storage", async (t) => {
    const { fake, access } = setup();
    const get = t.mock.method(fake.browser.storage.local, "get");
    for (const url of ["http://./", "about:blank", "file:///etc/passwd", ""]) {
      await assert.rejects(
        access.check("s1", url),
        { code: "invalid_url", message: "Foxleash acts only on http and https URLs." },
        url,
      );
    }
    assert.equal(get.mock.callCount(), 0);
  });

  it("reads storage once per call and changes nothing", async (t) => {
    const { fake, access, sessions } = setup();
    sessions.set("s1", state(["https://session.example"]));
    const get = t.mock.method(fake.browser.storage.local, "get");
    const set = t.mock.method(fake.browser.storage.local, "set");
    const remove = t.mock.method(fake.browser.storage.local, "remove");
    await access.check("s1", "https://other.example/");
    assert.equal(get.mock.callCount(), 1);
    await rejectsWith(access.check("s1", "https://www.paypal.com/"), "site_blocked");
    assert.equal(get.mock.callCount(), 2);
    assert.equal(set.mock.callCount(), 0);
    assert.equal(remove.mock.callCount(), 0);
    assert.deepEqual([...sessions], [["s1", state(["https://session.example"])]]);
  });

  it("rejects when storage cannot be read", async () => {
    const { fake, access } = setup();
    fake.browser.storage.local.get = async () => {
      throw new Error("storage is unavailable");
    };
    await assert.rejects(access.check("s1", "https://a.example/"), /storage is unavailable/);
  });
});

const PROMPT_URL =
  /^moz-extension:\/\/[0-9a-f-]+\/approve\.html\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFUSED = "The user did not allow Foxleash on https://a.example in this session.";
const BUDGET =
  "Foxleash asks no more in this session after three refused or closed prompts. The user can forget those answers in Foxleash's settings, or start a new session, to be asked again.";
const PENDING =
  "Foxleash is waiting for the user to answer in tab 1 whether to allow https://a.example. Try again after the user has answered.";

describe("check with prompts", () => {
  it("refuses a site the session refused, and any site once the budget is spent", async () => {
    const { access, sessions } = setup();
    sessions.set("s1", { allowed: new Set(), refused: new Set(["https://a.example"]), closed: 0 });
    await assert.rejects(access.check("s1", "https://a.example/x"), {
      code: "site_refused",
      message: REFUSED,
    });
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "ask" });
    sessions.set("s1", { allowed: new Set(), refused: new Set(["https://a.example"]), closed: 2 });
    await assert.rejects(access.check("s1", "https://b.example/"), {
      code: "site_refused",
      message: BUDGET,
    });
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 2 });
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "ask" });
    assert.deepEqual(await access.check("s2", "https://b.example/"), { decision: "ask" });
  });

  it("still allows an approved site after the budget is spent", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://b.example");
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 3 });
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "allowed" });
  });

  it("joins the open prompt for its site once no request waits, and refuses otherwise", async () => {
    const { access, timers, fake, tab, ask } = setup();
    await ask();
    await assert.rejects(access.check("s1", "https://a.example/other"), {
      code: "approval_pending",
      message: PENDING,
    });
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    assert.deepEqual(await access.check("s1", "https://a.example/other"), {
      decision: "join",
      tabId: tab.id,
    });
    await assert.rejects(access.check("s1", "https://b.example/"), {
      code: "approval_pending",
      message: PENDING,
    });
    assert.deepEqual(await access.check("s2", "https://b.example/"), { decision: "ask" });
  });
});

describe("beside a recipe page", () => {
  const RECIPE_PENDING =
    "Foxleash is waiting for the user to answer in tab 9 whether to save a recipe. Try again after the user has answered.";

  it("refuses to check or ask for an unapproved site while the session's recipe page is open", async () => {
    const fake = createFakeBrowser();
    const sessions: SessionMemory = new Map();
    let page: { tabId: number; question: string } | undefined = {
      tabId: 9,
      question: "whether to save a recipe",
    };
    const access = createSiteAccess({
      browser: fake.browser,
      groups: createSessionGroups(fake.browser),
      sessions,
      timers: createFakeTimers(),
      otherPrompt: (session) => (session === "s1" ? page : undefined),
    });
    const tab = fake.openTab({ active: true });
    await assert.rejects(access.check("s1", "https://b.example/"), {
      code: "approval_pending",
      message: RECIPE_PENDING,
    });
    await assert.rejects(
      access.ask("s1", "https://b.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "approval_pending",
        message: RECIPE_PENDING,
      },
    );
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(fake.tabUpdates, []);
    assert.deepEqual(await access.check("s2", "https://b.example/"), { decision: "ask" });
    page = undefined;
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "ask" });
  });

  it("names what the recipe page asks", async () => {
    const fake = createFakeBrowser();
    const access = createSiteAccess({
      browser: fake.browser,
      groups: createSessionGroups(fake.browser),
      sessions: new Map(),
      timers: createFakeTimers(),
      otherPrompt: () => ({ tabId: 9, question: "whether to allow the recipe's sites" }),
    });
    await assert.rejects(access.check("s1", "https://b.example/"), {
      code: "approval_pending",
      message:
        "Foxleash is waiting for the user to answer in tab 9 whether to allow the recipe's sites. Try again after the user has answered.",
    });
  });

  it("still answers for allowed, blocked and refused sites while the recipe page is open", async () => {
    const fake = createFakeBrowser();
    const sessions: SessionMemory = new Map();
    const access = createSiteAccess({
      browser: fake.browser,
      groups: createSessionGroups(fake.browser),
      sessions,
      timers: createFakeTimers(),
      otherPrompt: () => ({ tabId: 9, question: "whether to save a recipe" }),
    });
    const tab = fake.openTab({ active: true });
    await grantSite(fake.browser, "https://b.example");
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "allowed" });
    assert.equal(
      (
        await access.ask("s1", "https://b.example/", tab.id, {
          generation: access.generation("s1"),
        })
      ).promptInTab,
      false,
    );
    await fake.browser.storage.local.set({ blocklist: ["c.example"] });
    await assert.rejects(access.check("s1", "https://c.example/"), { code: "site_blocked" });
    sessions.set("s1", { allowed: new Set(), refused: new Set(["https://a.example"]), closed: 0 });
    await assert.rejects(access.check("s1", "https://a.example/"), {
      code: "site_refused",
      message: REFUSED,
    });
    await assert.rejects(
      access.ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "site_refused",
        message: REFUSED,
      },
    );
    assert.deepEqual(fake.tabUpdates, []);
  });
});

describe("portShowsPage", () => {
  it("holds only for this extension's page of that name, at exactly that URL, in that tab", () => {
    const url = "moz-extension://8a7f9c1e/propose.html?id=1";
    const exact = { id: FAKE_EXTENSION_ID, url, tab: { id: 4 } };
    assert.equal(portShowsPage(port("recipe", exact), FAKE_EXTENSION_ID, "recipe", url, 4), true);
    const others: [string, MessageSender | undefined][] = [
      ["approve", exact],
      ["recipe", { ...exact, id: "other@example.org" }],
      ["recipe", { url, tab: { id: 4 } }],
      ["recipe", { ...exact, url: `${url}#` }],
      ["recipe", { id: FAKE_EXTENSION_ID, tab: { id: 4 } }],
      ["recipe", { ...exact, tab: { id: 5 } }],
      ["recipe", { id: FAKE_EXTENSION_ID, url }],
      ["recipe", undefined],
    ];
    for (const [name, sender] of others) {
      assert.equal(
        portShowsPage(port(name, sender), FAKE_EXTENSION_ID, "recipe", url, 4),
        false,
        JSON.stringify([name, sender]),
      );
    }
  });

  function port(name: string, sender: MessageSender | undefined): RuntimePort {
    const ignored = { addListener: () => {}, removeListener: () => {} };
    const base = {
      name,
      postMessage: () => {},
      disconnect: () => {},
      onMessage: ignored,
      onDisconnect: ignored,
      error: null,
    };
    return sender === undefined ? base : { ...base, sender };
  }
});

describe("ask", () => {
  it("loads a prompt page into the tab, brings it to the front and draws attention", async () => {
    const { fake, access, tab, ask } = setup();
    fake.openTab({ active: true });
    const { approval, answer, promptUrl } = await ask();
    assert.match(promptUrl, PROMPT_URL);
    assert.equal(approval.promptInTab, true);
    assert.deepEqual(fake.tabUpdates, [{ tabId: tab.id, url: promptUrl, active: true }]);
    assert.equal(fake.tabs.get(tab.id)?.active, true);
    assert.deepEqual(fake.windowUpdates, [{ windowId: 1, drawAttention: true }]);
    assert.deepEqual(access.openPrompt("s1"), {
      tabId: tab.id,
      site: "https://a.example",
      url: "https://a.example/page",
      waiting: true,
    });
    assert.equal(answer.state, "pending");
    assert.equal(access.openPrompt("s2"), undefined);
  });

  it("gives each prompt its own page URL", async () => {
    const { fake, ask } = setup();
    const other = fake.openTab();
    const first = await ask("s1");
    const second = await ask("s2", "https://a.example/page", other.id);
    assert.notEqual(first.promptUrl, second.promptUrl);
  });

  it("makes a new prompt URL for a tab to be created on, recording nothing", () => {
    const { fake, access } = setup();
    const first = access.newPromptUrl();
    const second = access.newPromptUrl();
    assert.match(first, PROMPT_URL);
    assert.ok(first.startsWith(`${fake.browser.runtime.getURL("approve.html")}?id=`));
    assert.match(second, PROMPT_URL);
    assert.notEqual(first, second);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(fake.tabUpdates, []);
  });

  it("loads the prompt in place of the entry of a tab created unloaded on its URL", async () => {
    const { fake, access } = setup();
    const promptUrl = access.newPromptUrl();
    const created = await fake.browser.tabs.create({
      url: promptUrl,
      active: false,
      discarded: true,
    });
    const approval = await access.ask("s1", "https://a.example/page", created.id, {
      generation: access.generation("s1"),
      promptUrl,
    });
    assert.equal(approval.promptInTab, true);
    assert.deepEqual(fake.tabUpdates, [
      { tabId: created.id, url: promptUrl, active: true, loadReplace: true },
    ]);
    const tab = fake.tabs.get(created.id);
    assert.equal(tab?.active, true);
    assert.equal(tab?.discarded, false);
    assert.deepEqual(tab?.history, [promptUrl]);
    assert.deepEqual(fake.windowUpdates, [{ windowId: 1, drawAttention: true }]);
    assert.deepEqual(access.openPrompt("s1"), {
      tabId: created.id,
      site: "https://a.example",
      url: "https://a.example/page",
      waiting: true,
    });
    const answer = track(approval.answer);
    const page = connect(fake, created.id, promptUrl);
    page.deliver({ type: "ready" });
    assert.deepEqual(page.posted, [
      { type: "prompt", site: "https://a.example", url: "https://a.example/page" },
    ]);
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(answer.state, "resolved");
  });

  it("ends a page that connected from the prompt URL before the prompt, and attaches it after", async () => {
    const { fake, access } = setup();
    const promptUrl = access.newPromptUrl();
    const created = await fake.browser.tabs.create({
      url: promptUrl,
      active: false,
      discarded: true,
    });
    const early = connect(fake, created.id, promptUrl);
    assert.deepEqual(early.posted, [{ type: "ended" }]);
    assert.equal(early.disconnected, true);
    await access.ask("s1", "https://a.example/page", created.id, {
      generation: access.generation("s1"),
      promptUrl,
    });
    const reloaded = connect(fake, created.id, promptUrl);
    reloaded.deliver({ type: "ready" });
    assert.deepEqual(reloaded.posted, [
      { type: "prompt", site: "https://a.example", url: "https://a.example/page" },
    ]);
    assert.equal(reloaded.disconnected, false);
  });

  it("shows one prompt of two parallel requests on tabs created unloaded on their prompts", async () => {
    const { fake, access } = setup();
    const firstUrl = access.newPromptUrl();
    const secondUrl = access.newPromptUrl();
    const [first, second] = await Promise.all(
      [firstUrl, secondUrl].map((url) =>
        fake.browser.tabs.create({ url, active: false, discarded: true }),
      ),
    );
    assert.ok(first && second);
    const generation = access.generation("s1");
    const results = await Promise.allSettled([
      access.ask("s1", "https://a.example/", first.id, { generation, promptUrl: firstUrl }),
      access.ask("s1", "https://b.example/", second.id, { generation, promptUrl: secondUrl }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.ok(results[1].status === "rejected");
    assert.ok(results[1].reason instanceof ToolError);
    assert.equal(results[1].reason.code, "approval_pending");
    assert.deepEqual(fake.tabUpdates, [
      { tabId: first.id, url: firstUrl, active: true, loadReplace: true },
    ]);
    assert.equal(fake.tabs.get(second.id)?.discarded, true);
    assert.equal(access.openPrompt("s1")?.tabId, first.id);
  });

  it("reports the prompt shown once it asked Firefox to draw attention", async () => {
    const { fake, access, tab } = setup();
    const held = Promise.withResolvers<void>();
    fake.browser.windows.update = () => held.promise;
    let shown = false;
    const asking = access
      .ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") })
      .then(() => {
        shown = true;
      });
    await flush();
    assert.equal(shown, false);
    held.resolve();
    await asking;
    assert.equal(shown, true);
  });

  it("still asks when Firefox cannot draw attention to the window", async () => {
    const { fake, access, ask } = setup();
    fake.browser.windows.update = async () => {
      throw new Error("No window");
    };
    await ask();
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });

  it("brings the session's own window to the front for a prompt shown there", async () => {
    const { fake, access, groups } = setup();
    const { tab, promptUrl } = await ownWindowPrompt(fake, access, groups);
    const user = fake.currentWindowId;
    assert.notEqual(tab.windowId, user);
    await access.ask("s1", "https://a.example/page", tab.id, {
      generation: access.generation("s1"),
      promptUrl,
    });
    assert.deepEqual(fake.windowUpdates, [{ windowId: tab.windowId, focused: true }]);
    assert.equal(fake.currentWindowId, tab.windowId);
  });

  it("only draws attention to the session's own window for a request joining its prompt", async () => {
    const { fake, access, groups, timers } = setup();
    const { tab, promptUrl } = await ownWindowPrompt(fake, access, groups);
    await access.ask("s1", "https://a.example/page", tab.id, {
      generation: access.generation("s1"),
      promptUrl,
    });
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const other = await groups.createTab("s1", { url: "about:blank", active: false });
    const updates = fake.tabUpdates.length;
    const joined = await access.ask("s1", "https://a.example/other", other.id, {
      generation: access.generation("s1"),
    });
    assert.equal(joined.promptInTab, false);
    assert.deepEqual(fake.windowUpdates, [
      { windowId: tab.windowId, focused: true },
      { windowId: tab.windowId, drawAttention: true },
    ]);
    assert.equal(fake.tabUpdates.length, updates);
  });

  it("still asks when Firefox cannot bring the session's own window to the front", async () => {
    const { fake, access, groups } = setup();
    const { tab, promptUrl } = await ownWindowPrompt(fake, access, groups);
    fake.browser.windows.update = async () => {
      throw new Error("No window");
    };
    await access.ask("s1", "https://a.example/page", tab.id, {
      generation: access.generation("s1"),
      promptUrl,
    });
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });

  /** A prompt tab made as tab_open makes it, with the session's window on. */
  async function ownWindowPrompt(
    fake: FakeBrowser,
    access: SiteAccess,
    groups: SessionGroups,
  ): Promise<{ tab: Tab; promptUrl: string }> {
    await fake.browser.storage.local.set({ sessionWindow: true });
    const promptUrl = access.newPromptUrl();
    const tab = await groups.createTab("s1", { url: promptUrl, active: false, discarded: true });
    await groups.ensureGroup("s1", tab);
    return { tab, promptUrl };
  }

  it("rejects and keeps no prompt when the prompt page cannot be loaded", async () => {
    const { fake, access, timers, tab } = setup();
    fake.browser.tabs.update = async () => {
      throw new Error("Invalid tab ID");
    };
    await assert.rejects(
      access.ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") }),
      /Invalid tab ID/,
    );
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(timers.pending(), 0);
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "ask" });
  });

  it("keeps the newer prompt when an older one fails to load after being closed", async () => {
    const { fake, access, tab, ask } = setup();
    const failing = Promise.withResolvers<never>();
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = () => failing.promise;
    const first = access.ask("s1", "https://a.example/", tab.id, {
      generation: access.generation("s1"),
    });
    await flush();
    fake.removeTab(tab.id);
    fake.browser.tabs.update = update;
    const other = fake.openTab();
    await ask("s1", "https://b.example/", other.id);
    failing.reject(new Error("Invalid tab ID"));
    await assert.rejects(first, /Invalid tab ID/);
    assert.equal(access.openPrompt("s1")?.site, "https://b.example");
  });

  it("shows one prompt and refuses the other of two parallel requests", async () => {
    const { fake, access, tab } = setup();
    const other = fake.openTab();
    const results = await Promise.allSettled([
      access.ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") }),
      access.ask("s1", "https://b.example/", other.id, { generation: access.generation("s1") }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.ok(results[1].status === "rejected");
    assert.ok(results[1].reason instanceof ToolError);
    assert.equal(results[1].reason.code, "approval_pending");
    assert.equal(fake.tabUpdates.length, 1);
    assert.equal(fake.tabs.get(other.id)?.url, "about:blank");
  });

  it("shows nothing for a site approved meanwhile", async () => {
    const { fake, access, tab } = setup();
    await grantSite(fake.browser, "https://a.example");
    const approval = await access.ask("s1", "https://a.example/", tab.id, {
      generation: access.generation("s1"),
    });
    await approval.answer;
    assert.equal(approval.promptInTab, false);
    assert.deepEqual(fake.tabUpdates, []);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("refuses a site blocked meanwhile without showing anything", async () => {
    const { fake, access, tab } = setup();
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "ask" });
    await fake.browser.storage.local.set({ blocklist: ["a.example"] });
    await assert.rejects(
      access.ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "site_blocked",
      },
    );
    assert.deepEqual(fake.tabUpdates, []);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("refuses a refused site and a spent budget without showing anything", async () => {
    const { fake, access, sessions, tab } = setup();
    sessions.set("s1", { allowed: new Set(), refused: new Set(["https://a.example"]), closed: 0 });
    await assert.rejects(
      access.ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "site_refused",
        message: REFUSED,
      },
    );
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 3 });
    await assert.rejects(
      access.ask("s1", "https://b.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "site_refused",
        message: BUDGET,
      },
    );
    assert.deepEqual(fake.tabUpdates, []);
  });

  it("refuses a URL with no site", async () => {
    const { access, tab } = setup();
    await assert.rejects(
      access.ask("s1", "about:blank", tab.id, { generation: access.generation("s1") }),
      { code: "invalid_url" },
    );
  });
});

describe("prompt page", () => {
  it("answers ready with the site and URL", async () => {
    const { fake, tab, ask } = setup();
    await ask("s1", "https://a.example/page?q=1");
    const page = connect(fake, tab.id);
    page.deliver({ type: "ready", id: "x" });
    assert.deepEqual(page.posted, [
      { type: "prompt", site: "https://a.example", url: "https://a.example/page?q=1" },
    ]);
    assert.equal(page.disconnected, false);
  });

  it("ends every page that is not this extension's exact prompt URL in the prompt's tab", async () => {
    const { fake, access, tab, ask } = setup();
    const other = fake.openTab();
    const { promptUrl } = await ask();
    const prefix = promptUrl.slice(0, -1);
    const otherId = promptUrl.replace(/id=.*/, `id=${crypto.randomUUID()}`);
    const pages = [
      fake.connectPage("approve", { id: "other@example.org", url: promptUrl, tab: { id: tab.id } }),
      fake.connectPage("approve", { url: promptUrl, tab: { id: tab.id } }),
      fake.connectPage("approve", { id: FAKE_EXTENSION_ID, tab: { id: tab.id } }),
      fake.connectPage("approve", { id: FAKE_EXTENSION_ID, url: promptUrl }),
      fake.connectPage("approve", { id: FAKE_EXTENSION_ID, url: promptUrl, tab: { id: other.id } }),
      connect(fake, tab.id, prefix),
      connect(fake, tab.id, otherId),
      connect(fake, tab.id, `${promptUrl}#`),
      connect(fake, tab.id, `${promptUrl}&id=x`),
    ];
    const noSender = fake.connectPage("approve", { id: FAKE_EXTENSION_ID });
    for (const page of [...pages, noSender]) {
      page.deliver({ type: "ready" });
      page.deliver({ type: "answer", answer: "always" });
      assert.deepEqual(page.posted, [{ type: "ended" }]);
      assert.equal(page.disconnected, true);
    }
    assert.equal(access.openPrompt("s1")?.waiting, true);
    assert.deepEqual((await readSettings(fake.browser)).sites, []);
  });

  it("leaves another page's port alone, even from the prompt URL in the prompt's tab", async () => {
    const { fake, access, tab, ask } = setup();
    const { promptUrl } = await ask();
    for (const name of ["other", "recipe"]) {
      const page = fake.connectPage(name, {
        id: FAKE_EXTENSION_ID,
        url: promptUrl,
        tab: { id: tab.id },
      });
      page.deliver({ type: "ready" });
      page.deliver({ type: "answer", answer: "always" });
      await flush();
      assert.deepEqual(page.posted, [], name);
      assert.equal(page.disconnected, false, name);
    }
    assert.equal(access.openPrompt("s1")?.waiting, true);
    assert.deepEqual((await readSettings(fake.browser)).sites, []);
  });

  it("ends a page of a prompt that has been answered", async () => {
    const { fake, tab, ask } = setup();
    const { promptUrl } = await ask();
    connect(fake, tab.id).deliver({ type: "answer", answer: "once" });
    const late = connect(fake, tab.id, promptUrl);
    assert.deepEqual(late.posted, [{ type: "ended" }]);
    assert.equal(late.disconnected, true);
  });

  it("survives a refused page whose port can neither be posted to nor disconnected", () => {
    const fake = createFakeBrowser();
    const listeners: ((port: RuntimePort) => void)[] = [];
    fake.browser.runtime.onConnect = {
      addListener: (listener) => listeners.push(listener),
      removeListener: () => {},
    };
    createSiteAccess({
      browser: fake.browser,
      groups: createSessionGroups(fake.browser),
      sessions: new Map(),
      timers: createFakeTimers(),
    });
    const gone = () => {
      throw new Error("Attempt to postMessage on disconnected port");
    };
    const port: RuntimePort = {
      name: "approve",
      postMessage: gone,
      disconnect: gone,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {}, removeListener: () => {} },
      error: null,
    };
    assert.equal(listeners.length, 1);
    for (const listener of listeners) assert.doesNotThrow(() => listener(port));
  });

  it("ignores messages that are not a ready or a valid answer", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    for (const message of [
      null,
      "ready",
      [],
      { type: "answer" },
      { type: "answer", answer: "yes" },
      { type: "answer", answer: ["once"] },
      { type: "other" },
    ]) {
      page.deliver(message);
    }
    await flush();
    assert.deepEqual(page.posted, []);
    assert.equal(answer.state, "pending");
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });

  it("keeps the prompt when its page disconnects, and attaches the reloaded page", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const first = connect(fake, tab.id);
    first.drop();
    assert.equal(access.openPrompt("s1")?.waiting, true);
    const second = connect(fake, tab.id);
    second.deliver({ type: "ready" });
    assert.equal(second.posted.length, 1);
    first.deliver({ type: "answer", answer: "no" });
    first.deliver({ type: "ready" });
    await flush();
    assert.equal(answer.state, "pending");
    assert.equal(first.posted.length, 0);
    second.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(answer.state, "resolved");
  });

  it("ignores answers from an older page once a newer one attached", async () => {
    const { fake, tab, ask } = setup();
    const { answer } = await ask();
    const first = connect(fake, tab.id);
    connect(fake, tab.id);
    first.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(answer.state, "pending");
  });

  it("settles the request when posting to the page throws", async () => {
    const { fake, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    page.disconnected = true;
    page.deliver({ type: "ready" });
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(answer.state, "resolved");
  });
});

describe("answers", () => {
  it("allows the site for this session only on Allow this session", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(answer.state, "resolved");
    assert.deepEqual(page.posted, [{ type: "done", answer: "once", loadsHere: true, late: false }]);
    assert.equal(page.disconnected, false);
    assert.deepEqual(sessions.get("s1"), state(["https://a.example"]));
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(await access.check("s1", "https://a.example/other"), { decision: "allowed" });
    assert.deepEqual(await access.check("s2", "https://a.example/"), { decision: "ask" });
    assert.deepEqual((await readSettings(fake.browser)).sites, []);
    assert.equal(fake.tabs.get(tab.id)?.url.startsWith("moz-extension:"), true);
  });

  it("stores the grant before settling on Always allow, without session memory", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    const writes = holdWrites(fake);
    page.deliver({ type: "answer", answer: "always" });
    await flush();
    assert.equal(answer.state, "pending");
    assert.deepEqual(page.posted, []);
    writes.release();
    await flush();
    assert.equal(answer.state, "resolved");
    assert.deepEqual(page.posted, [
      { type: "done", answer: "always", loadsHere: true, late: false },
    ]);
    assert.deepEqual((await readSettings(fake.browser)).sites, ["https://a.example"]);
    assert.equal(sessions.get("s1"), undefined);
    assert.deepEqual(await access.check("s2", "https://a.example/"), { decision: "allowed" });
  });

  it("refuses the site for the session on Don't allow", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    page.deliver({ type: "answer", answer: "no" });
    await flush();
    assertRejected(answer, "site_refused", REFUSED);
    assert.deepEqual(page.posted, [{ type: "done", answer: "no", loadsHere: false, late: false }]);
    assert.deepEqual(sessions.get("s1")?.refused, new Set(["https://a.example"]));
    assert.equal(access.openPrompt("s1"), undefined);
    await assert.rejects(access.check("s1", "https://a.example/"), { code: "site_refused" });
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "ask" });
    assert.equal(fake.tabs.get(tab.id)?.url.startsWith("moz-extension:"), true);
  });

  it("fails the request and keeps the question open when the grant cannot be stored", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    fake.failNextSet();
    page.deliver({ type: "answer", answer: "always" });
    await flush();
    assertRejected(
      answer,
      "settings_write_failed",
      `Firefox could not save the user's answer to always allow https://a.example. The question is still open in tab ${tab.id}.`,
    );
    assert.deepEqual(page.posted, [{ type: "error" }]);
    assert.deepEqual(access.openPrompt("s1"), {
      tabId: tab.id,
      site: "https://a.example",
      url: "https://a.example/page",
      waiting: false,
    });
    page.deliver({ type: "answer", answer: "always" });
    await flush();
    assert.deepEqual(page.posted[1], {
      type: "done",
      answer: "always",
      loadsHere: false,
      late: true,
    });
    assert.deepEqual((await readSettings(fake.browser)).sites, ["https://a.example"]);
  });

  it("does not post an error when the page is gone as the write fails", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    fake.failNextSet();
    page.deliver({ type: "answer", answer: "always" });
    page.drop();
    await flush();
    assertRejected(answer, "settings_write_failed");
    assert.deepEqual(page.posted, []);
    assert.equal(access.openPrompt("s1")?.waiting, false);
  });

  it("ignores a second answer while the first is saved", async () => {
    const { fake, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    const writes = holdWrites(fake);
    page.deliver({ type: "answer", answer: "always" });
    page.deliver({ type: "answer", answer: "always" });
    page.deliver({ type: "answer", answer: "no" });
    writes.release();
    await flush();
    assert.equal(writes.calls(), 1);
    assert.equal(answer.state, "resolved");
    assert.equal(page.posted.length, 1);
  });

  it("keeps a timely answer in time while a slow grant is saved", async () => {
    const { fake, timers, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    const writes = holdWrites(fake);
    page.deliver({ type: "answer", answer: "always" });
    timers.advance(APPROVAL_WAIT_MS * 2);
    writes.release();
    await flush();
    assert.equal(answer.state, "resolved");
  });

  it("keeps the stored grant when the prompt closes while it is saved", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    const writes = holdWrites(fake);
    page.deliver({ type: "answer", answer: "always" });
    fake.removeTab(tab.id);
    writes.release();
    await flush();
    assertRejected(answer, "approval_closed");
    assert.deepEqual((await readSettings(fake.browser)).sites, ["https://a.example"]);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(page.posted, [{ type: "ended" }]);
  });

  it("does nothing more when the prompt closes while a failing grant is saved", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    fake.failNextSet();
    page.deliver({ type: "answer", answer: "always" });
    fake.removeTab(tab.id);
    await flush();
    assertRejected(answer, "approval_closed");
    assert.deepEqual(page.posted, [{ type: "ended" }]);
    assert.equal(access.openPrompt("s1"), undefined);
  });
});

describe("waiting for the answer", () => {
  it("fails the request after the wait, naming the tab and the retry, and keeps the prompt", async () => {
    const { fake, access, timers, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS - 1);
    await flush();
    assert.equal(answer.state, "pending");
    timers.advance(1);
    await flush();
    assertRejected(
      answer,
      "approval_timeout",
      `Foxleash is still asking the user in tab ${tab.id} whether to allow https://a.example. Tell the user to answer there, then make the same tab_open or navigate call again; if the user closed that tab, call tab_open with the page's URL instead.`,
    );
    assert.deepEqual(access.openPrompt("s1"), {
      tabId: tab.id,
      site: "https://a.example",
      url: "https://a.example/page",
      waiting: false,
    });
    assert.deepEqual(page.posted, []);
  });

  it("records a late answer like a timely one", async () => {
    const { fake, access, sessions, timers, tab, ask } = setup();
    await ask();
    const page = connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.deepEqual(page.posted, [{ type: "done", answer: "once", loadsHere: false, late: true }]);
    assert.deepEqual(sessions.get("s1")?.allowed, new Set(["https://a.example"]));
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("drops a prompt whose page never showed when the wait ends, without counting it", async () => {
    const { access, sessions, timers, ask } = setup();
    const { answer } = await ask();
    timers.advance(APPROVAL_WAIT_MS);
    await flush();
    assertRejected(answer, "approval_closed");
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(sessions.get("s1")?.closed ?? 0, 0);
  });

  it("joins a request from another tab once the earlier one timed out", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    const page = connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const other = fake.openTab({ windowId: 2, active: true });
    const updates = fake.tabUpdates.length;
    fake.windowUpdates.length = 0;
    const joined = await ask("s1", "https://a.example/other", other.id);
    assert.equal(joined.approval.promptInTab, false);
    assert.equal(fake.tabUpdates.length, updates);
    assert.equal(fake.tabs.get(tab.id)?.active, true);
    assert.deepEqual(fake.windowUpdates, [{ windowId: 1, drawAttention: true }]);
    assert.equal(access.openPrompt("s1")?.waiting, true);
    await assert.rejects(
      access.ask("s1", "https://a.example/", other.id, { generation: access.generation("s1") }),
      {
        code: "approval_pending",
      },
    );
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(joined.answer.state, "resolved");
    assert.deepEqual(page.posted, [
      { type: "done", answer: "once", loadsHere: false, late: false },
    ]);
  });

  it("joins a request on the prompt's own tab, which then loads there", async () => {
    const { fake, timers, tab, ask } = setup();
    await ask();
    const page = connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const joined = await ask("s1", "https://a.example/page");
    assert.equal(joined.approval.promptInTab, true);
    page.deliver({ type: "answer", answer: "no" });
    await flush();
    assertRejected(joined.answer, "site_refused");
    assert.deepEqual(page.posted, [{ type: "done", answer: "no", loadsHere: false, late: false }]);
  });

  it("times out a joined request too", async () => {
    const { fake, timers, tab, ask } = setup();
    await ask();
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const joined = await ask("s1", "https://a.example/page");
    timers.advance(APPROVAL_WAIT_MS);
    await flush();
    assertRejected(joined.answer, "approval_timeout");
  });

  it("joins on the prompt's tab even when the site was approved meanwhile", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    await grantSite(fake.browser, "https://a.example");
    const joined = await ask("s1", "https://a.example/page");
    await flush();
    assert.equal(joined.answer.state, "pending");
    assert.equal(access.openPrompt("s1")?.waiting, true);
    const other = fake.openTab();
    const elsewhere = await ask("s1", "https://a.example/page", other.id);
    await flush();
    assert.equal(elsewhere.answer.state, "resolved");
    assert.equal(elsewhere.approval.promptInTab, false);
  });

  it("refuses another site, or a second waiting request, on the prompt's tab", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    await assert.rejects(
      access.ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "approval_pending",
        message: PENDING,
      },
    );
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    await grantSite(fake.browser, "https://b.example");
    await assert.rejects(
      access.ask("s1", "https://b.example/", tab.id, { generation: access.generation("s1") }),
      {
        code: "approval_pending",
      },
    );
  });

  it("reports a join once it asked Firefox to draw attention", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const held = Promise.withResolvers<void>();
    fake.browser.windows.update = () => held.promise;
    let joined = false;
    const joining = access
      .ask("s1", "https://a.example/", tab.id, { generation: access.generation("s1") })
      .then(() => {
        joined = true;
      });
    await flush();
    assert.equal(joined, false);
    held.resolve();
    await joining;
    assert.equal(joined, true);
  });

  it("joins even when the prompt's tab cannot be found to draw attention", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    fake.browser.tabs.get = async () => {
      throw new Error("Invalid tab ID");
    };
    await ask("s1", "https://a.example/page");
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });
});

describe("closing a prompt", () => {
  it("fails the request when the user closes the prompt's tab", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    fake.removeTab(tab.id);
    await flush();
    assertRejected(
      answer,
      "approval_closed",
      `The question whether to allow https://a.example in tab ${tab.id} was closed without an answer.`,
    );
    assert.deepEqual(page.posted, [{ type: "ended" }]);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(sessions.get("s1")?.closed, 1);
    assert.equal(sessions.get("s1")?.refused.size, 0);
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "ask" });
  });

  it("counts a closed prompt only once its page connected", async () => {
    const { fake, sessions, tab, ask } = setup();
    await ask();
    fake.removeTab(tab.id);
    assert.equal(sessions.get("s1"), undefined);
  });

  it("does not count a prompt closed while its answer is saved", async () => {
    const { fake, sessions, tab, ask } = setup();
    await ask();
    const page = connect(fake, tab.id);
    holdWrites(fake);
    page.deliver({ type: "answer", answer: "always" });
    fake.removeTab(tab.id);
    assert.equal(sessions.get("s1"), undefined);
  });

  it("spends the budget after three refused or closed prompts", async () => {
    const { fake, access, tab, ask } = setup();
    await ask("s1", "https://a.example/");
    connect(fake, tab.id).deliver({ type: "answer", answer: "no" });
    for (const site of ["https://b.example/", "https://c.example/"]) {
      const next = fake.openTab();
      await ask("s1", site, next.id);
      connect(fake, next.id);
      fake.removeTab(next.id);
    }
    await assert.rejects(access.check("s1", "https://d.example/"), {
      code: "site_refused",
      message: BUDGET,
    });
    assert.deepEqual(await access.check("s2", "https://d.example/"), { decision: "ask" });
  });

  it("drops the prompt when the tab leaves the prompt page after showing it", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const { answer, promptUrl } = await ask();
    connect(fake, tab.id);
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    assert.deepEqual(fake.tabs.get(tab.id)?.history.slice(-2), [promptUrl, "https://b.example/"]);
    await fake.browser.tabs.goBack(tab.id);
    assert.equal(fake.tabs.get(tab.id)?.url, promptUrl);
    assertRejected(answer, "approval_closed");
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(sessions.get("s1")?.closed, 1);
  });

  it("keeps the prompt through a reload of its page", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    connect(fake, tab.id);
    await fake.browser.tabs.reload(tab.id);
    await flush();
    assert.equal(answer.state, "pending");
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });

  it("ignores URL changes before the prompt page committed", async () => {
    const { fake, access, tab, ask } = setup();
    fake.browser.tabs.update = async (tabId) => fake.browser.tabs.get(tabId);
    const { answer } = await ask();
    // A late event of the page the prompt replaces, completing on that page.
    fake.navigateByUser(tab.id, "https://old.example/");
    await flush();
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    assert.equal(answer.state, "pending");
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });

  it("commits the prompt on its URL event, on a complete load of it, or when its page connects", async () => {
    const commits: ((fake: FakeBrowser, tabId: number, promptUrl: string) => void)[] = [
      (fake, tabId, promptUrl) => fake.navigateByUser(tabId, promptUrl),
      (fake, tabId, promptUrl) => {
        const tab = fake.tabs.get(tabId);
        assert.ok(tab);
        tab.url = promptUrl;
        fake.emitStatus(tabId, "complete");
      },
      (fake, tabId, promptUrl) => {
        connect(fake, tabId, promptUrl);
      },
    ];
    for (const commit of commits) {
      const { fake, access, tab } = setup();
      let promptUrl = "";
      fake.browser.tabs.update = async (tabId, properties) => {
        promptUrl = properties.url ?? "";
        return fake.browser.tabs.get(tabId);
      };
      const approval = await access.ask("s1", "https://a.example/", tab.id, {
        generation: access.generation("s1"),
      });
      const answer = track(approval.answer);
      fake.emitStatus(tab.id, "complete");
      commit(fake, tab.id, promptUrl);
      await flush();
      assert.equal(answer.state, "pending");
      fake.navigateByUser(tab.id, "https://b.example/");
      await flush();
      assertRejected(answer, "approval_closed");
    }
  });

  it("drops the prompts of two sessions in one tab", async () => {
    const { fake, tab, ask } = setup();
    const first = await ask("s1");
    const second = await ask("s2", "https://b.example/");
    fake.removeTab(tab.id);
    await flush();
    assertRejected(first.answer, "approval_closed");
    assertRejected(second.answer, "approval_closed");
  });

  it("ignores events of other tabs", async () => {
    const { fake, access, ask } = setup();
    const other = fake.openTab();
    await ask();
    fake.navigateByUser(other.id, "https://b.example/");
    fake.removeTab(other.id);
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });
});

describe("askedUrl", () => {
  it("names what an answered prompt asked about while its tab shows it, to its session only", async () => {
    const { fake, access, tab, ask } = setup();
    await ask();
    const page = connect(fake, tab.id);
    assert.equal(access.askedUrl("s1", await fake.browser.tabs.get(tab.id)), undefined);
    page.deliver({ type: "answer", answer: "no" });
    await flush();
    const shown = await fake.browser.tabs.get(tab.id);
    assert.equal(access.askedUrl("s1", shown), "https://a.example/page");
    assert.equal(access.askedUrl("s2", shown), undefined);
    assert.equal(access.askedUrl("s1", { ...shown, url: "https://a.example/page" }), undefined);
    const other = fake.openTab({ url: shown.url ?? "" });
    assert.equal(access.askedUrl("s1", await fake.browser.tabs.get(other.id)), undefined);
    await fake.browser.tabs.reload(tab.id);
    await flush();
    assert.equal(access.askedUrl("s1", shown), "https://a.example/page");
    fake.navigateByUser(tab.id, "https://b.example/");
    assert.equal(access.askedUrl("s1", shown), undefined);
  });

  it("forgets an answered prompt when its tab closes", async () => {
    const { fake, access, tab, ask } = setup();
    await ask();
    connect(fake, tab.id).deliver({ type: "answer", answer: "once" });
    await flush();
    const shown = await fake.browser.tabs.get(tab.id);
    assert.equal(access.askedUrl("s1", shown), "https://a.example/page");
    fake.removeTab(tab.id);
    assert.equal(access.askedUrl("s1", shown), undefined);
  });
});

describe("endSession", () => {
  it("forgets the session's answers and closes its open prompt without counting", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    sessions.set("s1", {
      allowed: new Set(["https://b.example"]),
      refused: new Set(["https://c.example"]),
      closed: 1,
    });
    sessions.set("s2", state(["https://b.example"]));
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    access.endSession("s1");
    await flush();
    assertRejected(answer, "approval_closed");
    assert.deepEqual(page.posted, [{ type: "ended" }]);
    assert.equal(sessions.has("s1"), false);
    assert.equal(sessions.has("s2"), true);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.deepEqual(await access.check("s1", "https://c.example/"), { decision: "ask" });
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(sessions.has("s1"), false);
  });

  it("tells onWithdraw of each site the session allowed", () => {
    const withdrawn: [string, string][] = [];
    const { access, sessions } = setup((session, site) => withdrawn.push([session, site]));
    sessions.set("s1", {
      allowed: new Set(["https://a.example", "https://b.example"]),
      refused: new Set(["https://c.example"]),
      closed: 1,
    });
    sessions.set("s2", state(["https://d.example"]));
    access.endSession("s1");
    access.endSession("s3");
    assert.deepEqual(withdrawn, [
      ["s1", "https://a.example"],
      ["s1", "https://b.example"],
    ]);
  });

  it("tells onWithdraw only once the session and its prompt are gone", async () => {
    const seen: { site: string; prompt: boolean; session: boolean }[] = [];
    const { access, sessions, ask } = setup((session, site) =>
      seen.push({
        site,
        prompt: access.openPrompt(session) !== undefined,
        session: sessions.has(session),
      }),
    );
    sessions.set("s1", {
      allowed: new Set(["https://b.example"]),
      refused: new Set(["https://c.example"]),
      closed: 1,
    });
    await ask();
    access.endSession("s1");
    sessions.set("s2", state(["https://b.example"]));
    access.forget("s2", "https://b.example");
    assert.deepEqual(seen, [
      { site: "https://b.example", prompt: false, session: false },
      { site: "https://b.example", prompt: false, session: false },
    ]);
  });

  it("shows no prompt for an ask that was checking when its session ended", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const shown = fake.tabs.get(tab.id)?.url;
    sessions.set("s1", state(["https://b.example"]));
    const asked = ask();
    access.endSession("s1");
    await assert.rejects(asked, {
      code: "approval_closed",
      message: "The session ended before Foxleash could ask whether to allow https://a.example.",
    });
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(fake.tabs.get(tab.id)?.url, shown);
    assert.equal(sessions.has("s1"), false);
    // A session that reconnects with the id is asked; another session's end refuses nothing.
    const again = ask();
    access.endSession("s2");
    await again;
    assert.equal(access.openPrompt("s1")?.site, "https://a.example");
  });

  it("refuses an ask whose request was dispatched before its session ended", async () => {
    const { fake, access, sessions, tab } = setup();
    const shown = fake.tabs.get(tab.id)?.url;
    const url = "https://a.example/page";
    sessions.set("s1", state(["https://b.example"]));
    const generation = access.generation("s1");
    assert.deepEqual(await access.check("s1", url), { decision: "ask" });
    access.endSession("s1");
    await assert.rejects(access.ask("s1", url, tab.id, { generation }), {
      code: "approval_closed",
      message: "The session ended before Foxleash could ask whether to allow https://a.example.",
    });
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(fake.tabs.get(tab.id)?.url, shown);
    assert.equal(sessions.has("s1"), false);
    await access.ask("s1", url, tab.id, { generation: access.generation("s1") });
    assert.equal(access.openPrompt("s1")?.site, "https://a.example");
  });

  it("does not join a prompt the reconnected session opened from a request dispatched before the end", async () => {
    const { fake, access, groups, timers, tab, ask } = setup();
    const old = access.generation("s1");
    access.endSession("s1");
    await ask("s1", "https://a.example/page");
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const reconnected = access.openPrompt("s1");
    assert.deepEqual(reconnected, {
      tabId: tab.id,
      site: "https://a.example",
      url: "https://a.example/page",
      waiting: false,
    });
    const other = await groups.createTab("s1", { url: "about:blank", active: false });
    const updates = fake.tabUpdates.length;
    fake.windowUpdates.length = 0;
    const closed = {
      code: "approval_closed",
      message: "The session ended before Foxleash could ask whether to allow https://a.example.",
    };
    await assert.rejects(
      access.ask("s1", "https://a.example/other", other.id, { generation: old }),
      closed,
    );
    await assert.rejects(
      access.ask("s1", "https://a.example/page", tab.id, { generation: old }),
      closed,
    );
    assert.deepEqual(access.openPrompt("s1"), reconnected);
    assert.equal(fake.tabs.get(other.id)?.url, "about:blank");
    assert.equal(fake.tabUpdates.length, updates);
    assert.deepEqual(fake.windowUpdates, []);
    const joined = await access.ask("s1", "https://a.example/other", other.id, {
      generation: access.generation("s1"),
    });
    assert.equal(joined.promptInTab, false);
    assert.equal(access.openPrompt("s1")?.waiting, true);
  });

  it("counts each end of a session", () => {
    const { access } = setup();
    assert.equal(access.generation("unknown"), 0);
    access.endSession("s1");
    access.endSession("s1");
    assert.equal(access.generation("s1"), 2);
    assert.equal(access.generation("s2"), 0);
  });

  it("ends a session without a prompt", () => {
    const { access, sessions } = setup();
    sessions.set("s1", state([]));
    access.endSession("s1");
    access.endSession("s3");
    assert.equal(sessions.size, 0);
  });

  it("keeps __proto__ an ordinary session id for answers", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    await ask("__proto__");
    connect(fake, tab.id).deliver({ type: "answer", answer: "once" });
    await flush();
    assert.deepEqual(sessions.get("__proto__"), state(["https://a.example"]));
    assert.deepEqual(await access.check("constructor", "https://a.example/"), {
      decision: "ask",
    });
  });
});

describe("sessionAnswers", () => {
  it("lists each session's answers with its tab count, in the order the sessions answered", async () => {
    const { fake, access, sessions, groups, tab } = setup();
    sessions.set("s2", {
      allowed: new Set(["https://c.example", "https://a.example"]),
      refused: new Set(["https://d.example", "https://b.example"]),
      closed: 2,
    });
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 1 });
    sessions.set("s3", { allowed: new Set(), refused: new Set(["https://e.example"]), closed: 0 });
    await groups.ensureGroup("s2", tab);
    await groups.ensureGroup("s2", fake.openTab());
    await groups.ensureGroup("s1", fake.openTab());
    assert.deepEqual(await access.sessionAnswers(), [
      {
        session: "s2",
        label: "session with 2 tabs",
        allowed: ["https://a.example", "https://c.example"],
        refused: ["https://b.example", "https://d.example"],
        closed: 2,
        stopped: false,
      },
      {
        session: "s1",
        label: "session with 1 tab",
        allowed: [],
        refused: [],
        closed: 1,
        stopped: false,
      },
      {
        session: "s3",
        label: "session with no tabs",
        allowed: [],
        refused: ["https://e.example"],
        closed: 0,
        stopped: false,
      },
    ]);
  });

  it("leaves out sessions that hold no answer", async () => {
    const { access, sessions } = setup();
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 0 });
    sessions.set("s2", state(["https://a.example"]));
    assert.deepEqual(
      (await access.sessionAnswers()).map((entry) => entry.session),
      ["s2"],
    );
  });

  it("labels a session whose group was closed, or whose tabs cannot be read, as having no tabs", async () => {
    const { fake, access, sessions, groups, tab } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const groupId = await groups.ensureGroup("s1", tab);
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => {
      throw new Error("tabs are unavailable");
    };
    assert.equal((await access.sessionAnswers())[0]?.label, "session with no tabs");
    fake.browser.tabs.query = query;
    assert.equal((await access.sessionAnswers())[0]?.label, "session with 1 tab");
    fake.closeGroup(groupId);
    assert.equal((await access.sessionAnswers())[0]?.label, "session with no tabs");
  });

  it("shows the answers as they were when it was called", async () => {
    const { access, sessions } = setup();
    const held: SessionState = { allowed: new Set(), refused: new Set(), closed: 1 };
    sessions.set("s1", held);
    const listed = access.sessionAnswers();
    held.closed = 3;
    held.allowed.add("https://a.example");
    assert.deepEqual(await listed, [
      {
        session: "s1",
        label: "session with no tabs",
        allowed: [],
        refused: [],
        closed: 1,
        stopped: false,
      },
    ]);
  });
});

describe("forget", () => {
  it("tells onWithdraw once when it forgets an allowed site, and only then", () => {
    const withdrawn: [string, string][] = [];
    const { access, sessions } = setup((session, site) => withdrawn.push([session, site]));
    sessions.set("s1", {
      allowed: new Set(["https://a.example"]),
      refused: new Set(["https://b.example"]),
      closed: 1,
    });
    access.forget("s1", "https://b.example");
    access.forget("s1", "closed");
    access.forget("s1", "https://c.example");
    access.forget("s2", "https://a.example");
    assert.deepEqual(withdrawn, []);
    access.forget("s1", "https://a.example");
    access.forget("s1", "https://a.example");
    assert.deepEqual(withdrawn, [["s1", "https://a.example"]]);
  });

  it("tells every listener, in the order added, of each allowed site that ends", () => {
    const told: string[] = [];
    const { access, sessions } = setup((session, site) => told.push(`first ${session} ${site}`));
    access.onWithdraw((session, site) => told.push(`second ${session} ${site}`));
    sessions.set("s1", {
      allowed: new Set(["https://a.example", "https://b.example"]),
      refused: new Set(["https://c.example"]),
      closed: 1,
    });
    access.forget("s1", "https://c.example");
    access.forget("s1", "closed");
    access.forget("s1", "https://a.example");
    sessions.set("s1", {
      allowed: new Set(["https://b.example"]),
      refused: new Set(["https://d.example"]),
      closed: 2,
    });
    access.endSession("s1");
    assert.deepEqual(told, [
      "first s1 https://a.example",
      "second s1 https://a.example",
      "first s1 https://b.example",
      "second s1 https://b.example",
    ]);
  });

  it("forgets an allowed site, so the session is asked again and its tabs are redacted", async () => {
    const { access, sessions } = setup();
    sessions.set("s1", state(["https://a.example", "https://b.example"]));
    access.forget("s1", "https://a.example");
    assert.deepEqual(sessions.get("s1"), state(["https://b.example"]));
    const current = await access.view("s1");
    assert.equal(current.allowed("https://a.example/"), false);
    assert.equal(current.tabInfo(tab({ url: "https://a.example/x" })).title, "");
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "ask" });
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "allowed" });
  });

  it("forgets a refused site, so the session is asked for it again", async () => {
    const { access, sessions } = setup();
    sessions.set("s1", {
      allowed: new Set(),
      refused: new Set(["https://a.example", "https://b.example"]),
      closed: 0,
    });
    access.forget("s1", "https://a.example");
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "ask" });
    await assert.rejects(access.check("s1", "https://b.example/"), { code: "site_refused" });
  });

  it("restores a spent budget by forgetting one refusal or the closed prompts", async () => {
    const { access, sessions } = setup();
    sessions.set("s1", {
      allowed: new Set(),
      refused: new Set(["https://a.example", "https://b.example"]),
      closed: 1,
    });
    await assert.rejects(access.check("s1", "https://c.example/"), { message: BUDGET });
    access.forget("s1", "https://a.example");
    assert.deepEqual(await access.check("s1", "https://c.example/"), { decision: "ask" });

    sessions.set("s2", { allowed: new Set(), refused: new Set(), closed: 3 });
    await assert.rejects(access.check("s2", "https://c.example/"), { message: BUDGET });
    access.forget("s2", "closed");
    assert.deepEqual(sessions.get("s2"), undefined);
    assert.deepEqual(await access.check("s2", "https://c.example/"), { decision: "ask" });
  });

  it("asks a session again whose prompts were answered and closed", async () => {
    const { fake, access, tab, ask } = setup();
    await ask("s1", "https://a.example/");
    connect(fake, tab.id).deliver({ type: "answer", answer: "no" });
    for (const site of ["https://b.example/", "https://c.example/"]) {
      const next = fake.openTab();
      await ask("s1", site, next.id);
      connect(fake, next.id);
      fake.removeTab(next.id);
    }
    await assert.rejects(access.check("s1", "https://d.example/"), { message: BUDGET });
    access.forget("s1", "closed");
    assert.deepEqual(await access.check("s1", "https://d.example/"), { decision: "ask" });
    await rejectsWith(access.check("s1", "https://a.example/"), "site_refused");
    access.forget("s1", "https://a.example");
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "ask" });
  });

  it("keeps the session's other answers and drops its entry once it holds none", () => {
    const { access, sessions } = setup();
    sessions.set("s1", {
      allowed: new Set(["https://a.example"]),
      refused: new Set(["https://b.example"]),
      closed: 2,
    });
    access.forget("s1", "closed");
    assert.deepEqual(sessions.get("s1"), {
      allowed: new Set(["https://a.example"]),
      refused: new Set(["https://b.example"]),
      closed: 0,
    });
    access.forget("s1", "https://b.example");
    assert.deepEqual(sessions.get("s1"), state(["https://a.example"]));
    access.forget("s1", "https://c.example");
    assert.deepEqual(sessions.get("s1"), state(["https://a.example"]));
    access.forget("s1", "https://a.example");
    assert.equal(sessions.has("s1"), false);
  });

  it("does nothing for an unknown session and never allows a site", async () => {
    const { access, sessions } = setup();
    access.forget("s1", "https://a.example");
    access.forget("s1", "closed");
    assert.equal(sessions.size, 0);
    sessions.set("s2", { allowed: new Set(), refused: new Set(), closed: 1 });
    access.forget("s2", "https://a.example");
    assert.deepEqual(sessions.get("s2"), {
      allowed: new Set(),
      refused: new Set(),
      closed: 1,
    });
    assert.deepEqual(await access.check("s2", "https://a.example/"), { decision: "ask" });
  });
});

describe("siteStates", () => {
  it("gives each site its state, blocked before allowed and refused, allowed before refused", async () => {
    const { fake, access, sessions } = setup();
    await fake.browser.storage.local.set({ blocklist: ["b.example", "e.example"] });
    await grantSite(fake.browser, "https://a.example");
    await grantSite(fake.browser, "https://b.example");
    sessions.set("s1", {
      allowed: new Set(["https://c.example", "https://e.example"]),
      refused: new Set(["https://a.example", "https://b.example", "https://d.example"]),
      closed: 0,
    });
    const sites = [
      "https://f.example",
      "https://a.example",
      "https://b.example",
      "https://c.example",
      "https://d.example",
      "https://e.example",
    ];
    const states = await access.siteStates("s1", sites);
    assert.deepEqual(
      [...states],
      [
        ["https://f.example", "askable"],
        ["https://a.example", "allowed"],
        ["https://b.example", "blocked"],
        ["https://c.example", "allowed"],
        ["https://d.example", "refused"],
        ["https://e.example", "blocked"],
      ],
    );
  });

  it("changes nothing, and creates no entry for a session without answers", async () => {
    const { fake, access, sessions } = setup();
    const stored = await fake.browser.storage.local.get(null);
    const states = await access.siteStates("s1", ["https://a.example"]);
    assert.deepEqual([...states], [["https://a.example", "askable"]]);
    assert.equal(sessions.has("s1"), false);
    assert.deepEqual(await fake.browser.storage.local.get(null), stored);
  });
});

describe("allowForSession", () => {
  it("allows the askable sites for the session only, each once, and stores nothing", async () => {
    const { fake, access, sessions } = setup();
    await fake.browser.storage.local.set({ blocklist: ["b.example"] });
    await grantSite(fake.browser, "https://c.example");
    sessions.set("s1", {
      allowed: new Set(),
      refused: new Set(["https://d.example"]),
      closed: 0,
    });
    const stored = await fake.browser.storage.local.get(null);
    const granted = await access.allowForSession(
      "s1",
      [
        "https://e.example",
        "https://b.example",
        "https://c.example",
        "https://d.example",
        "https://a.example",
        "https://e.example",
      ],
      () => true,
    );
    assert.deepEqual(granted, ["https://e.example", "https://a.example"]);
    assert.deepEqual(sessions.get("s1"), {
      allowed: new Set(["https://e.example", "https://a.example"]),
      refused: new Set(["https://d.example"]),
      closed: 0,
    });
    assert.deepEqual(await fake.browser.storage.local.get(null), stored);
    assert.equal((await readSettings(fake.browser)).sites.includes("https://a.example"), false);
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "allowed" });
    assert.deepEqual(await access.check("s2", "https://a.example/"), { decision: "ask" });
  });

  it("never allows a string that is not exactly an http or https site", async () => {
    const { access, sessions } = setup();
    const granted = await access.allowForSession(
      "s1",
      ["javascript:alert(1)", "https://a.example/path", "HTTPS://A.EXAMPLE", "a.example", ""],
      () => true,
    );
    assert.deepEqual(granted, []);
    assert.equal(sessions.has("s1"), false);
  });

  it("allows nothing when the session ended while the settings were read", async () => {
    const { fake, access, sessions } = setup();
    let open = true;
    const held = Promise.withResolvers<void>();
    const get = fake.browser.storage.local.get;
    fake.browser.storage.local.get = async (keys) => {
      await held.promise;
      return get(keys);
    };
    const granting = access.allowForSession("s1", ["https://a.example"], () => open);
    await flush();
    access.endSession("s1");
    open = false;
    held.resolve();
    assert.deepEqual(await granting, []);
    assert.equal(sessions.has("s1"), false);
  });

  it("rejects, allowing nothing, when the settings cannot be read", async () => {
    const { fake, access, sessions } = setup();
    fake.browser.storage.local.get = async () => {
      throw new Error("Storage is gone");
    };
    await assert.rejects(
      access.allowForSession("s1", ["https://a.example"], () => true),
      /Storage is gone/,
    );
    assert.equal(sessions.has("s1"), false);
  });
});

describe("refuseIfStoppedAsking", () => {
  it("refuses once the session's refused and closed prompts reach three", () => {
    const { access, sessions } = setup();
    access.refuseIfStoppedAsking("s1");
    assert.equal(sessions.has("s1"), false);
    sessions.set("s1", {
      allowed: new Set(["https://c.example"]),
      refused: new Set(["https://a.example"]),
      closed: 1,
    });
    access.refuseIfStoppedAsking("s1");
    sessions.set("s1", { allowed: new Set(), refused: new Set(["https://a.example"]), closed: 2 });
    assert.throws(() => access.refuseIfStoppedAsking("s1"), {
      code: "site_refused",
      message: BUDGET,
    });
    access.refuseIfStoppedAsking("s2");
  });
});

describe("messages from the settings page", () => {
  it("answers the settings page with the session answers and forgets on request", async () => {
    const { fake, sessions } = setup();
    sessions.set("s1", {
      allowed: new Set(["https://a.example"]),
      refused: new Set(["https://b.example"]),
      closed: 0,
    });
    assert.deepEqual(await fake.sendMessage({ type: "session_answers" }, settingsPage(fake)), [
      {
        session: "s1",
        label: "session with no tabs",
        allowed: ["https://a.example"],
        refused: ["https://b.example"],
        closed: 0,
        stopped: false,
      },
    ]);
    const forgot = fake.sendMessage(
      { type: "forget", session: "s1", site: "https://b.example" },
      settingsPage(fake),
    );
    assert.equal(await forgot, true);
    assert.deepEqual(sessions.get("s1"), state(["https://a.example"]));
  });

  it("answers through runtime.sendMessage, which sends as the settings page", async () => {
    const { fake, sessions } = setup();
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 2 });
    assert.equal(
      await fake.browser.runtime.sendMessage({ type: "forget", session: "s1", site: "closed" }),
      true,
    );
    assert.equal(sessions.has("s1"), false);
    assert.equal(await fake.browser.runtime.sendMessage({ type: "unknown" }), undefined);
  });

  it("listens from the moment it is created", () => {
    const fake = createFakeBrowser();
    createSiteAccess({
      browser: fake.browser,
      groups: createSessionGroups(fake.browser),
      sessions: new Map(),
      timers: createFakeTimers(),
    });
    assert.notEqual(fake.sendMessage({ type: "session_answers" }, settingsPage(fake)), undefined);
  });

  it("does not answer any other sender", async () => {
    const { fake, sessions } = setup();
    const options = fake.browser.runtime.getURL("options.html");
    const senders: MessageSender[] = [
      { id: "other@example.org", url: options },
      { url: options },
      { id: FAKE_EXTENSION_ID },
      { id: FAKE_EXTENSION_ID, url: `${fake.browser.runtime.getURL("approve.html")}?id=x` },
      { id: FAKE_EXTENSION_ID, url: "https://a.example/options.html" },
      { id: FAKE_EXTENSION_ID, url: `${options}?x` },
      { id: FAKE_EXTENSION_ID, url: `${options}#x` },
      { id: FAKE_EXTENSION_ID, url: options, tab: { id: 1 } },
    ];
    for (const sender of senders.slice(0, -1)) {
      sessions.set("s1", state(["https://a.example"]));
      assert.equal(fake.sendMessage({ type: "session_answers" }, sender), undefined);
      const forget = { type: "forget", session: "s1", site: "https://a.example" };
      assert.equal(fake.sendMessage(forget, sender), undefined);
      assert.deepEqual(sessions.get("s1"), state(["https://a.example"]), JSON.stringify(sender));
    }
    // The settings page in a tab is still the settings page.
    assert.notEqual(fake.sendMessage({ type: "session_answers" }, senders.at(-1) ?? {}), undefined);
  });

  it("does not answer messages it does not know", async () => {
    const { fake, sessions } = setup();
    sessions.set("s1", state(["https://a.example"]));
    const messages: unknown[] = [
      { type: "answers" },
      { type: "Session_answers" },
      "session_answers",
      null,
      42,
      ["session_answers"],
      { type: "forget", session: 1, site: "https://a.example" },
      { type: "forget", session: "s1", site: ["https://a.example"] },
      { type: "forget", session: "s1" },
      { type: "forget", site: "https://a.example" },
    ];
    for (const message of messages) {
      assert.equal(
        fake.sendMessage(message, settingsPage(fake)),
        undefined,
        JSON.stringify(message),
      );
    }
    assert.deepEqual(sessions.get("s1"), state(["https://a.example"]));
  });
});

function siteOfUrl(url: string): string {
  return new URL(url).origin;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ToolError && error.code === code,
  );
}

function setup(onWithdraw?: (session: string, site: string) => void) {
  const fake = createFakeBrowser();
  const sessions: SessionMemory = new Map();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  if (onWithdraw !== undefined) access.onWithdraw(onWithdraw);
  const tab = fake.openTab({ active: true });

  /** Asks in `tabId` and returns the approval with the prompt page's URL. */
  async function ask(
    session = "s1",
    url = "https://a.example/page",
    tabId = tab.id,
  ): Promise<{ approval: Approval; answer: Tracked; promptUrl: string }> {
    const generation = access.generation(session);
    const approval = await access.ask(session, url, tabId, { generation });
    return { approval, answer: track(approval.answer), promptUrl: fake.tabs.get(tabId)?.url ?? "" };
  }

  return { fake, sessions, access, timers, groups, tab, ask };
}

function settingsPage(fake: FakeBrowser): MessageSender {
  return { id: FAKE_EXTENSION_ID, url: fake.browser.runtime.getURL("options.html") };
}

function tab(fields: Partial<Tab>): Tab {
  return { id: 3, windowId: 1, active: true, title: "Title", status: "complete", ...fields };
}

function state(allowed: string[]): SessionState {
  return { allowed: new Set(allowed), refused: new Set(), closed: 0 };
}

interface Tracked {
  state: "pending" | "resolved" | "rejected";
  error: unknown;
}

function track(promise: Promise<void>): Tracked {
  const tracked: Tracked = { state: "pending", error: undefined };
  promise.then(
    () => {
      tracked.state = "resolved";
    },
    (error: unknown) => {
      tracked.state = "rejected";
      tracked.error = error;
    },
  );
  return tracked;
}

/** The prompt page in `tabId` connecting from `url`, the page that tab shows by default. */
function connect(fake: FakeBrowser, tabId: number, url?: string): FakePort {
  return fake.connectPage("approve", {
    id: FAKE_EXTENSION_ID,
    url: url ?? fake.tabs.get(tabId)?.url ?? "",
    tab: { id: tabId },
  });
}

function assertRejected(tracked: Tracked, code: string, message?: string): void {
  assert.equal(tracked.state, "rejected");
  assert.ok(tracked.error instanceof ToolError);
  assert.equal(tracked.error.code, code);
  if (message !== undefined) assert.equal(tracked.error.message, message);
}

/** Replaces `storage.local.set` with one that waits for `release`. */
function holdWrites(fake: FakeBrowser): { release(): void; calls(): number } {
  const held = Promise.withResolvers<void>();
  const set = fake.browser.storage.local.set;
  let calls = 0;
  fake.browser.storage.local.set = async (items) => {
    calls += 1;
    await held.promise;
    return set(items);
  };
  return { release: () => held.resolve(), calls: () => calls };
}

describe("onGrant", () => {
  /** The grants each listener heard, with whether the prompt was closed and the answer settled then. */
  function listen(access: SiteAccess, answer?: () => Tracked): string[] {
    const heard: string[] = [];
    access.onGrant((session, site) => {
      const open = access.openPrompt(session) !== undefined;
      heard.push(`${session} ${site} open:${open} answer:${answer?.().state ?? "-"}`);
    });
    return heard;
  }

  it("tells of a site a prompt answered once allows, after the prompt is settled", async () => {
    const { fake, access, tab, ask } = setup();
    const { answer } = await ask();
    const heard = listen(access, () => answer);
    connect(fake, tab.id).deliver({ type: "answer", answer: "once" });
    assert.deepEqual(heard, ["s1 https://a.example open:false answer:pending"]);
    await flush();
    assert.equal(answer.state, "resolved");
  });

  it("tells of a site an answer always allows once it is saved, and of nothing before", async () => {
    const { fake, access, tab, ask } = setup();
    await ask();
    const heard = listen(access);
    const writes = holdWrites(fake);
    connect(fake, tab.id).deliver({ type: "answer", answer: "always" });
    await flush();
    assert.deepEqual(heard, []);
    writes.release();
    await flush();
    assert.deepEqual(heard, ["s1 https://a.example open:false answer:-"]);
  });

  it("tells of nothing for a refusal, a closed prompt, a failed save or a site already allowed", async () => {
    const refused = setup();
    await refused.ask();
    const heard = listen(refused.access);
    connect(refused.fake, refused.tab.id).deliver({ type: "answer", answer: "no" });
    await flush();

    const dropped = setup();
    await dropped.ask();
    dropped.access.onGrant((session, site) => heard.push(`${session} ${site}`));
    const writes = holdWrites(dropped.fake);
    connect(dropped.fake, dropped.tab.id).deliver({ type: "answer", answer: "always" });
    dropped.fake.removeTab(dropped.tab.id);
    writes.release();
    await flush();

    const failed = setup();
    await failed.ask();
    failed.access.onGrant((session, site) => heard.push(`${session} ${site}`));
    failed.fake.failNextSet();
    connect(failed.fake, failed.tab.id).deliver({ type: "answer", answer: "always" });
    await flush();

    const again = setup();
    await again.ask();
    again.access.onGrant((session, site) => heard.push(`${session} ${site}`));
    again.sessions.set("s1", state(["https://a.example"]));
    connect(again.fake, again.tab.id).deliver({ type: "answer", answer: "once" });
    await flush();
    assert.deepEqual(heard, []);
  });

  it("tells of each site allowForSession allows, and of none when it allows nothing", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://c.example");
    sessions.set("s1", state(["https://d.example"]));
    const heard: string[] = [];
    access.onGrant((session, site) => heard.push(`first ${session} ${site}`));
    access.onGrant((session, site) => heard.push(`second ${session} ${site}`));
    const granted = await access.allowForSession(
      "s1",
      ["https://a.example", "https://c.example", "https://d.example", "https://b.example"],
      () => true,
    );
    assert.deepEqual(granted, ["https://a.example", "https://b.example"]);
    assert.deepEqual(heard, [
      "first s1 https://a.example",
      "second s1 https://a.example",
      "first s1 https://b.example",
      "second s1 https://b.example",
    ]);
    assert.deepEqual(await access.allowForSession("s2", ["https://e.example"], () => false), []);
    assert.equal(heard.length, 4);
  });

  it("tells of nothing when a session's answer is forgotten or the session ends", () => {
    const { access, sessions } = setup();
    const heard = listen(access);
    sessions.set("s1", state(["https://a.example"]));
    access.forget("s1", "https://a.example");
    sessions.set("s2", state(["https://a.example"]));
    access.endSession("s2");
    assert.deepEqual(heard, []);
  });
});

const STOPPED =
  "The user stopped this agent session in Firefox. Foxleash refuses every tool call of this session from now on: stop the browser task and tell the user.";

describe("stop", () => {
  it("refuses every gate of the session, on sites allowed always and for the session", async () => {
    const { fake, access, sessions, tab } = setup();
    await grantSite(fake.browser, "https://a.example");
    sessions.set("s1", state(["https://b.example"]));
    access.stop("s1");
    assert.equal(access.stopped("s1"), true);
    await assert.rejects(access.view("s1"), { code: "session_stopped", message: STOPPED });
    for (const site of ["https://a.example", "https://b.example"]) {
      const url = `${site}/page`;
      await rejectsWith(access.check("s1", url), "session_stopped");
      await rejectsWith(
        access.ask("s1", url, tab.id, { generation: access.generation("s1") }),
        "session_stopped",
      );
      await rejectsWith(access.siteStates("s1", [site]), "session_stopped");
      await rejectsWith(
        access.allowForSession("s1", [site], () => true),
        "session_stopped",
      );
    }
    await rejectsWith(access.check("s1", "https://c.example/"), "session_stopped");
    assert.throws(() => access.refuseIfStoppedAsking("s1"), {
      code: "session_stopped",
      message: STOPPED,
    });
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(fake.tabs.get(tab.id)?.url, tab.url);
    assert.equal(sessions.has("s1"), false);
  });

  it("rejects the request on its open prompt with session_stopped and ends the page, uncounted", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    const { answer } = await ask();
    const page = connect(fake, tab.id);
    access.stop("s1");
    await flush();
    assertRejected(answer, "session_stopped", STOPPED);
    assert.deepEqual(page.posted, [{ type: "ended" }]);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(sessions.has("s1"), false);
    // A page connecting later finds no prompt.
    assert.deepEqual(connect(fake, tab.id).posted, [{ type: "ended" }]);
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(sessions.has("s1"), false);
  });

  it("forgets the session's answers, tells onWithdraw of each site it allowed, then onStop", async () => {
    const heard: string[] = [];
    const { access, sessions, ask } = setup((session, site) => {
      const open = access.openPrompt(session) !== undefined;
      heard.push(`withdraw ${session} ${site} prompt:${open} answers:${sessions.has(session)}`);
    });
    access.onStop((session) => heard.push(`stop ${session}`));
    await ask("s1", "https://d.example/");
    sessions.set("s1", {
      allowed: new Set(["https://a.example", "https://b.example"]),
      refused: new Set(["https://c.example"]),
      closed: 1,
    });
    sessions.set("s2", state(["https://e.example"]));
    access.stop("s1");
    assert.deepEqual(heard, [
      "withdraw s1 https://a.example prompt:false answers:false",
      "withdraw s1 https://b.example prompt:false answers:false",
      "stop s1",
    ]);
    assert.equal(sessions.has("s1"), false);
    assert.deepEqual(sessions.get("s2"), state(["https://e.example"]));
  });

  it("tells each onStop listener once, in the order added, and a second stop tells nothing", async () => {
    const { fake, access, sessions } = setup();
    const heard: string[] = [];
    access.onStop((session) => heard.push(`first ${session}`));
    access.onStop((session) => heard.push(`second ${session}`));
    access.stop("s1");
    assert.deepEqual(heard, ["first s1", "second s1"]);
    sessions.set("s1", state(["https://a.example"]));
    assert.equal(await fake.sendMessage({ type: "stop", session: "s1" }, settingsPage(fake)), true);
    assert.deepEqual(heard, ["first s1", "second s1"]);
    assert.deepEqual(sessions.get("s1"), state(["https://a.example"]));
    access.stop("s2");
    assert.deepEqual(heard, ["first s1", "second s1", "first s2", "second s2"]);
  });

  it("leaves another session's access and open prompt alone", async () => {
    const { fake, access, sessions, tab, ask } = setup();
    await grantSite(fake.browser, "https://a.example");
    sessions.set("s2", state(["https://b.example"]));
    const { answer } = await ask("s2", "https://c.example/");
    const page = connect(fake, tab.id);
    access.stop("s1");
    await flush();
    assert.equal(access.stopped("s2"), false);
    const view = await access.view("s2");
    assert.equal(view.allowed("https://a.example/"), true);
    assert.equal(view.allowed("https://b.example/"), true);
    assert.deepEqual(await access.check("s2", "https://a.example/"), { decision: "allowed" });
    assert.equal(access.openPrompt("s2")?.site, "https://c.example");
    assert.equal(answer.state, "pending");
    assert.deepEqual(page.posted, []);
    access.admit("s2");
    access.refuseIfStoppedAsking("s2");
    page.deliver({ type: "answer", answer: "once" });
    await flush();
    assert.equal(answer.state, "resolved");
  });

  it("keeps a session stopped after it ends, so the same id is refused again", async () => {
    const { access, sessions } = setup();
    access.admit("s1");
    access.stop("s1");
    access.endSession("s1");
    assert.equal(access.stopped("s1"), true);
    assert.throws(() => access.admit("s1"), { code: "session_stopped", message: STOPPED });
    await rejectsWith(access.view("s1"), "session_stopped");
    assert.equal(sessions.has("s1"), false);
  });

  it("brings no window to the front for its prompt page loading when the stop came", async () => {
    const { fake, access, tab } = setup();
    const held = Promise.withResolvers<void>();
    const update = fake.browser.tabs.update;
    let loading = false;
    fake.browser.tabs.update = async (tabId, properties) => {
      const updated = await update(tabId, properties);
      loading = true;
      await held.promise;
      return updated;
    };
    const asking = access.ask("s1", "https://a.example/page", tab.id, {
      generation: access.generation("s1"),
    });
    while (!loading) await flush();
    access.stop("s1");
    held.resolve();
    const approval = await asking;
    const answer = track(approval.answer);
    await flush();
    assert.equal(approval.promptInTab, true);
    assertRejected(answer, "session_stopped", STOPPED);
    assert.deepEqual(fake.windowUpdates, []);
  });

  it("refuses a view whose settings read was under way when the stop came", async () => {
    const { fake, access } = setup();
    await grantSite(fake.browser, "https://a.example");
    const held = Promise.withResolvers<void>();
    const get = fake.browser.storage.local.get;
    fake.browser.storage.local.get = async (keys) => {
      await held.promise;
      return get(keys);
    };
    const viewing = access.view("s1");
    const checking = access.check("s1", "https://a.example/");
    const other = access.view("s2");
    await flush();
    access.stop("s1");
    held.resolve();
    await rejectsWith(viewing, "session_stopped");
    await rejectsWith(checking, "session_stopped");
    assert.equal((await other).allowed("https://a.example/"), true);
  });
});

describe("admit", () => {
  it("lists running sessions in the order they started, numbered, before other sessions", async () => {
    const { access, sessions, groups, tab } = setup();
    sessions.set("s3", state(["https://a.example"]));
    access.admit("s1");
    access.admit("s2");
    access.admit("s1");
    sessions.set("s2", state(["https://b.example"]));
    await groups.ensureGroup("s2", tab);
    assert.deepEqual(await access.sessionAnswers(), [
      {
        session: "s1",
        label: "session 1 with no tabs",
        allowed: [],
        refused: [],
        closed: 0,
        stopped: false,
      },
      {
        session: "s2",
        label: "session 2 with 1 tab",
        allowed: ["https://b.example"],
        refused: [],
        closed: 0,
        stopped: false,
      },
      {
        session: "s3",
        label: "session with no tabs",
        allowed: ["https://a.example"],
        refused: [],
        closed: 0,
        stopped: false,
      },
    ]);
  });

  it("lists a stopped session with no answers until it ends, and a reconnect with the next number", async () => {
    const { access, sessions } = setup();
    access.admit("s1");
    access.admit("s2");
    sessions.set("s1", state(["https://a.example"]));
    access.stop("s1");
    const listed = await access.sessionAnswers();
    assert.deepEqual(listed[0], {
      session: "s1",
      label: "session 1 with no tabs",
      allowed: [],
      refused: [],
      closed: 0,
      stopped: true,
    });
    access.endSession("s1");
    access.endSession("s2");
    assert.deepEqual(await access.sessionAnswers(), []);
    assert.throws(() => access.admit("s1"), { code: "session_stopped" });
    access.admit("s2");
    assert.deepEqual(
      (await access.sessionAnswers()).map(({ label, stopped }) => [label, stopped]),
      [
        ["session 3 with no tabs", true],
        ["session 4 with no tabs", false],
      ],
    );
  });

  it("refuses a session the user stopped before it ever sent a request", async () => {
    const { access } = setup();
    access.stop("__proto__");
    assert.throws(() => access.admit("__proto__"), { code: "session_stopped" });
    assert.deepEqual(
      (await access.sessionAnswers()).map(({ session, label, stopped }) => [
        session,
        label,
        stopped,
      ]),
      [["__proto__", "session 1 with no tabs", true]],
    );
  });
});

describe("running", () => {
  it("is true from a session's admit until its end, also while it is stopped", () => {
    const { access } = setup();
    assert.equal(access.running("s1"), false);
    access.admit("s1");
    assert.equal(access.running("s1"), true);
    assert.equal(access.running("s2"), false);
    access.stop("s1");
    assert.equal(access.running("s1"), true);
    access.endSession("s1");
    assert.equal(access.running("s1"), false);
    access.admit("s2");
    access.endSession("s2");
    access.admit("s2");
    assert.equal(access.running("s2"), true);
  });

  it("tells onRunningChange, in the order added, each time a session starts or stops running", () => {
    const { access } = setup();
    const calls: [string, string, boolean][] = [];
    access.onRunningChange((session) => calls.push(["first", session, access.running(session)]));
    access.onRunningChange((session) => calls.push(["second", session, access.running(session)]));
    access.admit("s1");
    access.admit("s1");
    access.endSession("never-started");
    access.endSession("s1");
    access.endSession("s1");
    access.admit("s1");
    assert.deepEqual(calls, [
      ["first", "s1", true],
      ["second", "s1", true],
      ["first", "s1", false],
      ["second", "s1", false],
      ["first", "s1", true],
      ["second", "s1", true],
    ]);
  });

  it("tells onRunningChange of a stopped session's admit before refusing it", () => {
    const { access } = setup();
    const calls: [string, boolean][] = [];
    access.onRunningChange((session) => calls.push([session, access.running(session)]));
    access.stop("s1");
    assert.throws(() => access.admit("s1"), { code: "session_stopped" });
    assert.throws(() => access.admit("s1"), { code: "session_stopped" });
    assert.deepEqual(calls, [["s1", true]]);
  });

  it("tells onRunningChange of a session's end after onWithdraw", () => {
    const events: string[] = [];
    const { access, sessions } = setup((session, site) =>
      events.push(`withdraw ${session} ${site}`),
    );
    access.onRunningChange((session) =>
      events.push(`running ${session} ${access.running(session)}`),
    );
    access.admit("s1");
    sessions.set("s1", state(["https://a.example"]));
    access.endSession("s1");
    assert.deepEqual(events, [
      "running s1 true",
      "withdraw s1 https://a.example",
      "running s1 false",
    ]);
  });
});

describe("stop messages from the settings page", () => {
  it("stops a session on the settings page's request", async () => {
    const { fake, access } = setup();
    assert.equal(await fake.sendMessage({ type: "stop", session: "s1" }, settingsPage(fake)), true);
    assert.equal(access.stopped("s1"), true);
    assert.equal(await fake.browser.runtime.sendMessage({ type: "stop", session: "s2" }), true);
    assert.equal(access.stopped("s2"), true);
    assert.equal(access.stopped("s3"), false);
  });

  it("does not stop a session for any other sender", () => {
    const { fake, access } = setup();
    const options = fake.browser.runtime.getURL("options.html");
    const senders: MessageSender[] = [
      { id: "other@example.org", url: options },
      { url: options },
      { id: FAKE_EXTENSION_ID },
      { id: FAKE_EXTENSION_ID, url: `${fake.browser.runtime.getURL("approve.html")}?id=x` },
      { id: FAKE_EXTENSION_ID, url: "https://a.example/options.html" },
      { id: FAKE_EXTENSION_ID, url: `${options}?x` },
      { id: FAKE_EXTENSION_ID, url: `${options}#x` },
      { id: FAKE_EXTENSION_ID, url: "https://a.example/", tab: { id: 1 } },
    ];
    for (const sender of senders) {
      assert.equal(fake.sendMessage({ type: "stop", session: "s1" }, sender), undefined);
      assert.equal(access.stopped("s1"), false, JSON.stringify(sender));
    }
  });

  it("ignores a malformed stop", () => {
    const { fake, access } = setup();
    const messages: unknown[] = [
      { type: "stop" },
      { type: "stop", session: 1 },
      { type: "stop", session: ["s1"] },
      { type: "Stop", session: "s1" },
      { type: "stopped", session: "s1" },
      { session: "s1" },
      "stop",
    ];
    for (const message of messages) {
      assert.equal(
        fake.sendMessage(message, settingsPage(fake)),
        undefined,
        JSON.stringify(message),
      );
    }
    assert.equal(access.stopped("s1"), false);
    assert.equal(access.stopped("undefined"), false);
  });
});
