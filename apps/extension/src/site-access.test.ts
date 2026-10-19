import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tab } from "./browser-api.ts";
import { createFakeBrowser } from "./fake-browser.ts";
import { grantSite } from "./settings.ts";
import { createSiteAccess, type SessionMemory } from "./site-access.ts";

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
    sessions.set("s1", { allowed: new Set(["http://127.0.0.1:4567"]) });
    const view = await access.view("s1");
    assert.equal(view.allowed("https://stored.example/any/path?q=1"), true);
    assert.equal(view.allowed("https://STORED.example.:443/"), true);
    assert.equal(view.allowed("http://127.0.0.1:4567/a"), true);
  });

  it("refuses other sites, another session's grant and pages that are not websites", async () => {
    const { fake, access, sessions } = setup();
    await grantSite(fake.browser, "https://stored.example");
    sessions.set("s2", { allowed: new Set(["https://other.example"]) });
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
    sessions.set("__proto__", { allowed: new Set(["https://a.example"]) });
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

function setup() {
  const fake = createFakeBrowser();
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, sessions });
  return { fake, sessions, access };
}

function tab(fields: Partial<Tab>): Tab {
  return { id: 3, windowId: 1, active: true, title: "Title", status: "complete", ...fields };
}
