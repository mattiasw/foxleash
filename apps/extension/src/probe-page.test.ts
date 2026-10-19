import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import vm from "node:vm";

// Read, not imported: everything past the start needs a real page, so the end-to-end tests
// cover it. Firefox runs only the function's own text, so that is all each test runs.
const MODULE = stripTypeScriptTypes(
  readFileSync(new URL("./probe-page.ts", import.meta.url), "utf8"),
).replace("export async function probePage", "async function probePage");
const FUNCTION = String(vm.runInNewContext(`${MODULE}\nprobePage.toString();`));
const TOUCHED = "the probe touched the page";
const LATER = Date.now() + 3_600_000;

describe("probePage's start", () => {
  for (const href of [
    "https://b.example/x",
    "https://sub.a.example/",
    "https://a.example:8443/",
    "http://a.example/",
  ]) {
    it(`returns null on ${href} without touching the page`, async () => {
      assert.equal(await probeAt(href, "https://a.example", LATER), null);
    });
  }

  for (const href of [
    "https://a.example/x?q#h",
    "https://a.example./x",
    "https://a.example:443/",
  ]) {
    it(`goes on to the page on ${href}`, async () => {
      await assert.rejects(probeAt(href, "https://a.example", LATER), { message: TOUCHED });
    });
  }

  it("throws without touching the page when it starts at its cutoff", async () => {
    await assert.rejects(probeAt("https://a.example/", "https://a.example", Date.now()), {
      name: "TypeError",
      message: "the probe started after its cutoff",
    });
  });
});

/** Runs the probe in a global whose `location` is `href` and whose `document` must not be read. */
function probeAt(href: string, site: string, cutoff: number): Promise<unknown> {
  const untouchable = new Proxy(
    {},
    {
      get() {
        throw new Error(TOUCHED);
      },
    },
  );
  const context = vm.createContext({ location: new URL(href), document: untouchable });
  const probePage: unknown = vm.runInContext(`(${FUNCTION})`, context);
  assert.equal(typeof probePage, "function");
  return (probePage as (site: string, cutoff: number) => Promise<unknown>)(site, cutoff);
}
