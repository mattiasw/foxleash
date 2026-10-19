import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createFakeBrowser } from "./fake-browser.ts";
import {
  grantSite,
  onSettingsChanged,
  readSettings,
  revokeSite,
  SITE_KEY_PREFIX,
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
    });
    assert.deepEqual(
      get.mock.calls.map((call) => call.arguments),
      [[null]],
    );
    assert.deepEqual(warnings(), []);
  });

  it("returns no sites from empty storage", async (t) => {
    const { fake } = setup(t);
    assert.deepEqual(await readSettings(fake.browser), { sites: [] });
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
      blocklist: [],
    };
    await fake.browser.storage.local.set({ ...malformed, "site:https://kept.example": GRANT });
    assert.deepEqual(await readSettings(fake.browser), { sites: ["https://kept.example"] });
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
    assert.deepEqual(await readSettings(fake.browser), { sites: ["https://__proto__"] });
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
    assert.deepEqual(settings, { sites: [] });
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
    assert.deepEqual(await readSettings(fake.browser), { sites: ["https://b.example"] });
  });

  it("use the key prefix site:", () => {
    assert.equal(SITE_KEY_PREFIX, "site:");
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
