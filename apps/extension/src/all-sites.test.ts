import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mayReachAllSites } from "./all-sites.ts";
import { createFakeBrowser } from "./fake-browser.ts";

describe("mayReachAllSites", () => {
  it("answers what Firefox answers for all websites, asking only about them", async () => {
    const fake = createFakeBrowser();
    fake.grantedOrigins.add("https://a.example/*");
    assert.equal(await mayReachAllSites(fake.browser), true);
    fake.allUrls = false;
    assert.equal(await mayReachAllSites(fake.browser), false);
    assert.deepEqual(fake.permissionChecks, [["<all_urls>"], ["<all_urls>"]]);
  });

  it("answers no when Firefox's answer rejects", async (t) => {
    const fake = createFakeBrowser();
    t.mock.method(fake.browser.permissions, "contains", () =>
      Promise.reject(new Error("permissions unavailable")),
    );
    assert.equal(await mayReachAllSites(fake.browser), false);
  });

  it("answers no when asking Firefox throws", async (t) => {
    const fake = createFakeBrowser();
    t.mock.method(fake.browser.permissions, "contains", () => {
      throw new Error("permissions unavailable");
    });
    assert.equal(await mayReachAllSites(fake.browser), false);
  });
});
