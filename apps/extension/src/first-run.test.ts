import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createFakeBrowser, flush } from "./fake-browser.ts";
import { watchInstall } from "./first-run.ts";

describe("first-run page", { timeout: 10000 }, () => {
  for (const temporary of [undefined, true]) {
    it(`opens the welcome page, selected, on an install (temporary ${temporary})`, async (t) => {
      const { fake } = setup(t);
      fake.emitInstalled(
        temporary === undefined ? { reason: "install" } : { reason: "install", temporary },
      );
      await flush();
      assert.deepEqual(openTabs(fake), [
        { url: fake.browser.runtime.getURL("welcome.html"), active: true },
      ]);
    });
  }

  for (const reason of ["update", "browser_update", "shared_module_update"]) {
    it(`opens nothing on ${reason}`, async (t) => {
      const { fake } = setup(t);
      fake.emitInstalled({ reason });
      await flush();
      assert.deepEqual(openTabs(fake), []);
    });
  }

  it("listens from the call on, so an install event at load is not missed", (t) => {
    const { fake } = setup(t);
    fake.emitInstalled({ reason: "install" });
    assert.equal(fake.tabs.size, 1);
  });

  it("logs a page Firefox could not open, and throws nothing", async (t) => {
    const fake = createFakeBrowser();
    const warn = t.mock.method(console, "warn", () => {});
    fake.browser.tabs.create = async () => {
      throw new Error("tabs unavailable");
    };
    watchInstall({ browser: fake.browser });
    fake.emitInstalled({ reason: "install" });
    await flush();
    assert.deepEqual(
      warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0]))),
      [{ event: "open_welcome_failed", error: "Error: tabs unavailable" }],
    );
  });
});

function setup(t: TestContext) {
  const fake = createFakeBrowser();
  t.mock.method(console, "warn", () => {});
  watchInstall({ browser: fake.browser });
  return { fake };
}

function openTabs(fake: ReturnType<typeof createFakeBrowser>) {
  return [...fake.tabs.values()].map((tab) => ({ url: tab.url, active: tab.active }));
}
