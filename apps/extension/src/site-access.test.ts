import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimePort, Tab } from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakeBrowser,
  type FakePort,
  flush,
} from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { grantSite, readSettings } from "./settings.ts";
import {
  APPROVAL_WAIT_MS,
  type Approval,
  createSiteAccess,
  type SessionMemory,
  type SessionState,
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
        "Foxhand does not act on https://www.paypal.com: it is on Foxhand's blocklist, which by default lists common financial and health sites.",
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
        { code: "invalid_url", message: "Foxhand acts only on http and https URLs." },
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
const REFUSED = "The user did not allow Foxhand on https://a.example in this session.";
const BUDGET =
  "Foxhand asks no more in this session after three refused or closed prompts. Start a new session to be asked again.";
const PENDING =
  "Foxhand is waiting for the user to answer in tab 1 whether to allow https://a.example. Try again after the user has answered.";

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

describe("ask", () => {
  it("loads a prompt page into the tab, brings it to the front and draws attention", async () => {
    const { fake, access, tab, ask } = setup();
    fake.openTab({ active: true });
    const { answer, promptUrl } = await ask();
    assert.match(promptUrl, PROMPT_URL);
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

  it("reports the prompt shown once it asked Firefox to draw attention", async () => {
    const { fake, access, tab } = setup();
    const held = Promise.withResolvers<void>();
    fake.browser.windows.update = () => held.promise;
    let shown = false;
    const asking = access.ask("s1", "https://a.example/", tab.id).then(() => {
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

  it("rejects and keeps no prompt when the prompt page cannot be loaded", async () => {
    const { fake, access, timers, tab } = setup();
    fake.browser.tabs.update = async () => {
      throw new Error("Invalid tab ID");
    };
    await assert.rejects(access.ask("s1", "https://a.example/", tab.id), /Invalid tab ID/);
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(timers.pending(), 0);
    assert.deepEqual(await access.check("s1", "https://b.example/"), { decision: "ask" });
  });

  it("keeps the newer prompt when an older one fails to load after being closed", async () => {
    const { fake, access, tab, ask } = setup();
    const failing = Promise.withResolvers<never>();
    const update = fake.browser.tabs.update;
    fake.browser.tabs.update = () => failing.promise;
    const first = access.ask("s1", "https://a.example/", tab.id);
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
      access.ask("s1", "https://a.example/", tab.id),
      access.ask("s1", "https://b.example/", other.id),
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
    const approval = await access.ask("s1", "https://a.example/", tab.id);
    await approval.answer;
    assert.deepEqual(fake.tabUpdates, []);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("refuses a site blocked meanwhile without showing anything", async () => {
    const { fake, access, tab } = setup();
    assert.deepEqual(await access.check("s1", "https://a.example/"), { decision: "ask" });
    await fake.browser.storage.local.set({ blocklist: ["a.example"] });
    await assert.rejects(access.ask("s1", "https://a.example/", tab.id), {
      code: "site_blocked",
    });
    assert.deepEqual(fake.tabUpdates, []);
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("refuses a refused site and a spent budget without showing anything", async () => {
    const { fake, access, sessions, tab } = setup();
    sessions.set("s1", { allowed: new Set(), refused: new Set(["https://a.example"]), closed: 0 });
    await assert.rejects(access.ask("s1", "https://a.example/", tab.id), {
      code: "site_refused",
      message: REFUSED,
    });
    sessions.set("s1", { allowed: new Set(), refused: new Set(), closed: 3 });
    await assert.rejects(access.ask("s1", "https://b.example/", tab.id), {
      code: "site_refused",
      message: BUDGET,
    });
    assert.deepEqual(fake.tabUpdates, []);
  });

  it("refuses a URL with no site", async () => {
    const { access, tab } = setup();
    await assert.rejects(access.ask("s1", "about:blank", tab.id), { code: "invalid_url" });
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
      fake.connectPage("other", { id: FAKE_EXTENSION_ID, url: promptUrl, tab: { id: tab.id } }),
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
    createSiteAccess({ browser: fake.browser, sessions: new Map(), timers: createFakeTimers() });
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
      `Foxhand is still asking the user in tab ${tab.id} whether to allow https://a.example. Tell the user to answer there, then call navigate with tab ${tab.id} and action reload.`,
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
    assert.equal(fake.tabUpdates.length, updates);
    assert.equal(fake.tabs.get(tab.id)?.active, true);
    assert.deepEqual(fake.windowUpdates, [{ windowId: 1, drawAttention: true }]);
    assert.equal(access.openPrompt("s1")?.waiting, true);
    await assert.rejects(access.ask("s1", "https://a.example/", other.id), {
      code: "approval_pending",
    });
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
  });

  it("refuses another site, or a second waiting request, on the prompt's tab", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    await assert.rejects(access.ask("s1", "https://a.example/", tab.id), {
      code: "approval_pending",
      message: PENDING,
    });
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    await grantSite(fake.browser, "https://b.example");
    await assert.rejects(access.ask("s1", "https://b.example/", tab.id), {
      code: "approval_pending",
    });
  });

  it("reports a join once it asked Firefox to draw attention", async () => {
    const { fake, access, timers, tab, ask } = setup();
    await ask();
    connect(fake, tab.id);
    timers.advance(APPROVAL_WAIT_MS);
    const held = Promise.withResolvers<void>();
    fake.browser.windows.update = () => held.promise;
    let joined = false;
    const joining = access.ask("s1", "https://a.example/", tab.id).then(() => {
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
      const approval = await access.ask("s1", "https://a.example/", tab.id);
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

function siteOfUrl(url: string): string {
  return new URL(url).origin;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ToolError && error.code === code,
  );
}

function setup() {
  const fake = createFakeBrowser();
  const sessions: SessionMemory = new Map();
  const timers = createFakeTimers();
  const access = createSiteAccess({ browser: fake.browser, sessions, timers });
  const tab = fake.openTab({ active: true });

  /** Asks in `tabId` and returns the approval with the prompt page's URL. */
  async function ask(
    session = "s1",
    url = "https://a.example/page",
    tabId = tab.id,
  ): Promise<{ approval: Approval; answer: Tracked; promptUrl: string }> {
    const approval = await access.ask(session, url, tabId);
    return { approval, answer: track(approval.answer), promptUrl: fake.tabs.get(tabId)?.url ?? "" };
  }

  return { fake, sessions, access, timers, tab, ask };
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
