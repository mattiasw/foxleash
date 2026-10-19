import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DEFAULT_BLOCKLIST } from "./default-blocklist.ts";
import { createFakeBrowser } from "./fake-browser.ts";
import {
  effectiveBlocklist,
  grantSite,
  onSettingsChanged,
  readSettings,
  revokeSite,
  SITE_KEY_PREFIX,
  saveBlocklist,
} from "./settings.ts";

const GRANT = { grantedAt: "2026-01-02T03:04:05.000Z" };

describe("readSettings", () => {
  it("returns the stored sites, sorted, from one read of everything", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set({
      "site:https://b.example": GRANT,
      "site:http://127.0.0.1:4567": GRANT,
      "site:https://a.example": GRANT,
    });
    const get = t.mock.method(fake.browser.storage.local, "get");
    assert.deepEqual(await readSettings(fake.browser), {
      sites: ["http://127.0.0.1:4567", "https://a.example", "https://b.example"],
      blocklist: undefined,
    });
    assert.deepEqual(
      get.mock.calls.map((call) => call.arguments),
      [[null]],
    );
    assert.deepEqual(warnings(), []);
  });

  it("returns no sites from empty storage", async (t) => {
    const { fake } = setup(t);
    assert.deepEqual(await readSettings(fake.browser), { sites: [], blocklist: undefined });
  });

  it("ignores each malformed key with one warning naming it", async (t) => {
    const { fake, warnings } = setup(t);
    const malformed: Record<string, unknown> = {
      "https://a.example": GRANT,
      "Site:https://a.example": GRANT,
      "site:": GRANT,
      "site:https://Example.com": GRANT,
      "site:https://example.com/": GRANT,
      "site:https://example.com/path": GRANT,
      "site:https://example.com#top": GRANT,
      "site:https://example.com.": GRANT,
      "site:https://example.com:443": GRANT,
      "site:file:///etc": GRANT,
      "site:not a site": GRANT,
      "site:https://string.example": "2026-01-02T03:04:05.000Z",
      "site:https://null.example": null,
      "site:https://array.example": ["2026-01-02T03:04:05.000Z"],
      "site:https://empty.example": {},
      "site:https://number.example": { grantedAt: 1 },
      Blocklist: [],
    };
    await fake.browser.storage.local.set({ ...malformed, "site:https://kept.example": GRANT });
    assert.deepEqual(await readSettings(fake.browser), {
      sites: ["https://kept.example"],
      blocklist: undefined,
    });
    assert.deepEqual(
      warnings(),
      Object.keys(malformed).map((key) => ({ event: "ignored_setting", key })),
    );
  });

  it("reads a site whose host is __proto__ and an own __proto__ key", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set(
      JSON.parse('{"__proto__": {"grantedAt": "x"}, "site:https://__proto__": {"grantedAt": "x"}}'),
    );
    assert.deepEqual(await readSettings(fake.browser), {
      sites: ["https://__proto__"],
      blocklist: undefined,
    });
    assert.deepEqual(warnings(), [{ event: "ignored_setting", key: "__proto__" }]);
  });

  it("never reads grantedAt from Object.prototype", async (t) => {
    const { fake, warnings } = setup(t);
    const prototype: Record<string, unknown> = Object.prototype as Record<string, unknown>;
    t.after(() => {
      delete prototype.grantedAt;
    });
    await fake.browser.storage.local.set({ "site:https://a.example": {} });
    prototype.grantedAt = "2026-01-02T03:04:05.000Z";
    const settings = await readSettings(fake.browser).finally(() => {
      delete prototype.grantedAt;
    });
    assert.deepEqual(settings, { sites: [], blocklist: undefined });
    assert.deepEqual(warnings(), [{ event: "ignored_setting", key: "site:https://a.example" }]);
  });

  it("fails when storage cannot be read", async (t) => {
    const { fake } = setup(t);
    fake.browser.storage.local.get = async () => {
      throw new Error("storage is unavailable");
    };
    await assert.rejects(readSettings(fake.browser), /storage is unavailable/);
  });
});

describe("the stored blocklist", () => {
  it("is undefined when none is stored, and the built-in list applies", async (t) => {
    const { fake, warnings } = setup(t);
    const settings = await readSettings(fake.browser);
    assert.equal(settings.blocklist, undefined);
    assert.equal(effectiveBlocklist(settings), DEFAULT_BLOCKLIST);
    assert.deepEqual(warnings(), []);
  });

  it("is read beside the site grants and replaces the built-in list", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set({
      blocklist: ["paypal.com"],
      "site:https://a.example": GRANT,
    });
    const settings = await readSettings(fake.browser);
    assert.deepEqual(settings, { sites: ["https://a.example"], blocklist: ["paypal.com"] });
    assert.deepEqual(effectiveBlocklist(settings), ["paypal.com"]);
    assert.deepEqual(warnings(), []);
  });

  it("is normalized, with duplicates dropped in first order", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set({
      blocklist: [" PAYPAL.com. ", "paypal.com", "chase.com"],
    });
    assert.deepEqual((await readSettings(fake.browser)).blocklist, ["paypal.com", "chase.com"]);
    assert.deepEqual(warnings(), []);
  });

  it("blocks nothing when it is stored empty", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set({ blocklist: [] });
    const settings = await readSettings(fake.browser);
    assert.deepEqual(settings.blocklist, []);
    assert.deepEqual(effectiveBlocklist(settings), []);
    assert.deepEqual(warnings(), []);
  });

  for (const value of ["paypal.com", null, {}, [1], ["paypal.com", 2]]) {
    it(`is ignored with one warning when it is ${JSON.stringify(value)}`, async (t) => {
      const { fake, warnings } = setup(t);
      await fake.browser.storage.local.set({ blocklist: value });
      const settings = await readSettings(fake.browser);
      assert.equal(settings.blocklist, undefined);
      assert.equal(effectiveBlocklist(settings), DEFAULT_BLOCKLIST);
      assert.deepEqual(warnings(), [{ event: "ignored_setting", key: "blocklist" }]);
    });
  }

  it("drops each entry that is not a domain with a warning and keeps the rest", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set({
      blocklist: ["paypal.com", "*.chase.com", "paypal.com\nevil.com", "venmo.com"],
    });
    const { blocklist } = await readSettings(fake.browser);
    assert.deepEqual(blocklist, ["paypal.com", "venmo.com"]);
    assert.deepEqual(warnings(), [
      {
        event: "ignored_blocklist_entry",
        index: 1,
        reason:
          "Write the domain without a wildcard or a leading dot: a domain already covers its subdomains.",
      },
      {
        event: "ignored_blocklist_entry",
        index: 2,
        reason: "This is not a domain; write one such as example.com.",
      },
    ]);
  });

  it("falls back to the built-in list when no entry is a domain", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set({ blocklist: ["*.paypal.com", "https://chase.com"] });
    const settings = await readSettings(fake.browser);
    assert.equal(settings.blocklist, undefined);
    assert.equal(effectiveBlocklist(settings), DEFAULT_BLOCKLIST);
    assert.deepEqual(warnings(), [
      {
        event: "ignored_blocklist_entry",
        index: 0,
        reason:
          "Write the domain without a wildcard or a leading dot: a domain already covers its subdomains.",
      },
      {
        event: "ignored_blocklist_entry",
        index: 1,
        reason: "Write the domain without http:// or https://: it is blocked on both.",
      },
      { event: "ignored_setting", key: "blocklist" },
    ]);
  });

  it("is ignored with one warning when the array has holes", async (t) => {
    const { fake, warnings } = setup(t);
    const sparse: unknown[] = new Array(2);
    sparse[1] = "paypal.com";
    await fake.browser.storage.local.set({ blocklist: sparse });
    const settings = await readSettings(fake.browser);
    assert.equal(settings.blocklist, undefined);
    assert.deepEqual(warnings(), [{ event: "ignored_setting", key: "blocklist" }]);
  });
});

describe("grantSite and revokeSite", () => {
  it("write and remove one key per site", async (t) => {
    const { fake } = setup(t);
    const set = t.mock.method(fake.browser.storage.local, "set");
    const remove = t.mock.method(fake.browser.storage.local, "remove");
    const before = Date.now();
    await grantSite(fake.browser, "https://a.example");
    await grantSite(fake.browser, "https://b.example");
    assert.equal(set.mock.callCount(), 2);
    const stored = await fake.browser.storage.local.get(null);
    assert.deepEqual(Object.keys(stored), ["site:https://a.example", "site:https://b.example"]);
    const grant = stored["site:https://a.example"];
    assert.ok(typeof grant === "object" && grant !== null && "grantedAt" in grant);
    assert.deepEqual(Object.keys(grant), ["grantedAt"]);
    assert.equal(typeof grant.grantedAt, "string");
    const grantedAt = String(grant.grantedAt);
    assert.equal(new Date(grantedAt).toISOString(), grantedAt);
    assert.ok(Date.parse(grantedAt) >= before && Date.parse(grantedAt) <= Date.now());

    await revokeSite(fake.browser, "https://a.example");
    assert.deepEqual(
      remove.mock.calls.map((call) => call.arguments),
      [["site:https://a.example"]],
    );
    assert.deepEqual(await readSettings(fake.browser), {
      sites: ["https://b.example"],
      blocklist: undefined,
    });
  });

  it("use the key prefix site:", () => {
    assert.equal(SITE_KEY_PREFIX, "site:");
  });
});

describe("saveBlocklist", () => {
  it("stores the patterns, which readSettings then returns", async (t) => {
    const { fake } = setup(t);
    await saveBlocklist(fake.browser, ["127.0.0.1", "paypal.com"]);
    assert.deepEqual(await fake.browser.storage.local.get(null), {
      blocklist: ["127.0.0.1", "paypal.com"],
    });
    const settings = await readSettings(fake.browser);
    assert.deepEqual(settings.blocklist, ["127.0.0.1", "paypal.com"]);
    assert.deepEqual(effectiveBlocklist(settings), ["127.0.0.1", "paypal.com"]);
  });

  it("removes the key for the built-in set, in any order and with duplicates", async (t) => {
    const { fake } = setup(t);
    const remove = t.mock.method(fake.browser.storage.local, "remove");
    const set = t.mock.method(fake.browser.storage.local, "set");
    const builtIn = [...DEFAULT_BLOCKLIST].reverse();
    builtIn.push(DEFAULT_BLOCKLIST[0] ?? "");
    await saveBlocklist(fake.browser, builtIn);
    assert.deepEqual(await fake.browser.storage.local.get(null), {});
    assert.equal(set.mock.callCount(), 0);

    await fake.browser.storage.local.set({ blocklist: ["127.0.0.1"] });
    await saveBlocklist(fake.browser, builtIn);
    assert.deepEqual(await fake.browser.storage.local.get(null), {});
    assert.deepEqual(
      remove.mock.calls.map((call) => call.arguments),
      [["blocklist"], ["blocklist"]],
    );
    const settings = await readSettings(fake.browser);
    assert.equal(settings.blocklist, undefined);
    assert.deepEqual(effectiveBlocklist(settings), DEFAULT_BLOCKLIST);
  });

  it("stores an empty list, which blocks nothing", async (t) => {
    const { fake } = setup(t);
    await saveBlocklist(fake.browser, []);
    assert.deepEqual(await fake.browser.storage.local.get(null), { blocklist: [] });
    const settings = await readSettings(fake.browser);
    assert.deepEqual(settings.blocklist, []);
    assert.deepEqual(effectiveBlocklist(settings), []);
  });

  it("stores a subset or a superset of the built-in list", async (t) => {
    const { fake } = setup(t);
    const subset = DEFAULT_BLOCKLIST.slice(1);
    await saveBlocklist(fake.browser, subset);
    assert.deepEqual(await fake.browser.storage.local.get(null), { blocklist: subset });
    const superset = [...DEFAULT_BLOCKLIST, "127.0.0.1"];
    await saveBlocklist(fake.browser, superset);
    assert.deepEqual(await fake.browser.storage.local.get(null), { blocklist: superset });
  });
});

describe("onSettingsChanged", () => {
  it("calls the listener for every change to local storage", async (t) => {
    const { fake } = setup(t);
    let calls = 0;
    onSettingsChanged(fake.browser, () => {
      calls += 1;
    });
    await grantSite(fake.browser, "https://a.example");
    assert.equal(calls, 1);
    await grantSite(fake.browser, "https://a.example");
    assert.equal(calls, 2);
    await revokeSite(fake.browser, "https://a.example");
    assert.equal(calls, 3);
    await revokeSite(fake.browser, "https://a.example");
    assert.equal(calls, 3);
  });

  it("does not call the listener for another storage area", (t) => {
    const { fake } = setup(t);
    let calls = 0;
    onSettingsChanged(fake.browser, () => {
      calls += 1;
    });
    fake.emitStorageChanged("sync");
    fake.emitStorageChanged("session");
    assert.equal(calls, 0);
    fake.emitStorageChanged("local");
    assert.equal(calls, 1);
  });
});

describe("the fake's storage", () => {
  it("reports old and new values, and stores copies", async () => {
    const fake = createFakeBrowser();
    const changes: unknown[] = [];
    fake.browser.storage.onChanged.addListener((change, areaName) =>
      changes.push([change, areaName]),
    );
    const value = { grantedAt: "a" };
    await fake.browser.storage.local.set({ x: value, y: 1 });
    value.grantedAt = "changed";
    await fake.browser.storage.local.set({ x: { grantedAt: "b" } });
    await fake.browser.storage.local.remove("y");
    assert.deepEqual(changes, [
      [{ x: { newValue: { grantedAt: "a" } }, y: { newValue: 1 } }, "local"],
      [{ x: { oldValue: { grantedAt: "a" }, newValue: { grantedAt: "b" } } }, "local"],
      [{ y: { oldValue: 1 } }, "local"],
    ]);
    const stored = await fake.browser.storage.local.get(null);
    stored.x = "mutated";
    assert.deepEqual(await fake.browser.storage.local.get(null), { x: { grantedAt: "b" } });
  });
});

function setup(t: TestContext) {
  const fake = createFakeBrowser();
  const warn = t.mock.method(console, "warn", () => {});

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { fake, warnings };
}
