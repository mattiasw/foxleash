import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import type { ProbeCheck } from "@foxhand/protocol";
import type { Firefox } from "./firefox.ts";
import { type FixtureServer, PROBE_SECRET, startFixtureServer } from "./fixture-server.ts";
import { CHECKOUT, createHarness, EXTENSION_DIST, type Harness } from "./harness.ts";

const run = promisify(execFile);
const MAIN = join(CHECKOUT, "apps", "server", "src", "main.ts");
// The probe takes about 20 s per page at most; this bounds a run that hangs.
const PROBE_KILL_MS = 90_000;

// One Firefox for the file: the probe runs once, and the tests read its report and the page.
describe("foxhand probe, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let out = "";
  let json = "";
  let markdown = "";
  let checks: ProbeCheck[] = [];
  let pageContext = "";

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      const session = await harness.connect();
      await harness.waitUntilReady(session);
      const dir = join(harness.root, "probe-out");
      mkdirSync(dir);
      out = join(dir, "report");
      const { stdout } = await run(
        process.execPath,
        [MAIN, "probe", "--out", out, fixtures.url("/probe")],
        { env: harness.env, cwd: dir, timeout: PROBE_KILL_MS, killSignal: "SIGKILL" },
      );
      assert.equal(stdout, `${out}.json\n${out}.md\n`);
      json = readFileSync(`${out}.json`, "utf8");
      markdown = readFileSync(`${out}.md`, "utf8");
      const report: unknown = JSON.parse(json);
      checks = checksOf(report);
      const page = (await firefox.contexts()).find(({ url }) =>
        url.startsWith(fixtures.url("/probe")),
      );
      assert.ok(page !== undefined, "the probed page has no tab");
      pageContext = page.context;
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("synthetic Tab does not move focus, and the failure depends on isTrusted", () => {
    assert.deepEqual(pick(find("tab_focus", "probe", "tab_keydown")), {
      outcome: "no_effect",
      delivered: true,
      trustedOnly: true,
    });
    assert.equal(find("tab_focus", "probe", "focus_call").outcome, "worked");
  });

  test("synthetic Enter does not submit the form, and requestSubmit does", () => {
    const enter = find("enter_in_form", "probe", "enter_keydown");
    assert.equal(enter.outcome, "no_effect");
    assert.equal(enter.trustedOnly, true);
    assert.equal(find("enter_in_form", "probe", "request_submit").outcome, "worked");
  });

  test("the native value setter types into the probe's input", () => {
    assert.equal(find("type_input", "probe", "native_setter").outcome, "worked");
  });

  test("a synthetic click flips the page's disclosure toggle, which ends as it was", async () => {
    assert.equal(find("click_button", "site", "click_event").outcome, "worked");
    assert.equal(
      await firefox.evaluate(
        pageContext,
        `document.getElementById("toggle").getAttribute("aria-expanded")`,
      ),
      "false",
    );
    const toggles = await firefox.evaluate(pageContext, "window.toggles");
    assert.ok(typeof toggles === "number" && toggles >= 2 && toggles % 2 === 0, String(toggles));
  });

  test("each link click changes the hash, which the probe sets back", () => {
    for (const [target, strategy] of [
      ["probe", "click_event"],
      ["probe", "pointer_sequence"],
      ["site", "click_event"],
    ] as const) {
      const { outcome, detail } = find("click_link", target, strategy);
      assert.deepEqual([outcome, detail], ["worked", "restored"], `${target} ${strategy}`);
    }
  });

  test("the page's input, location and server are as before", async () => {
    assert.equal(
      await firefox.evaluate(pageContext, `document.getElementById("site-input").value`),
      PROBE_SECRET,
    );
    assert.equal(await firefox.evaluate(pageContext, "location.hash"), "");
    assert.equal(fixtures.hits("/probe-submit"), 0);
  });

  test("the probe skips a one-time code field, and toggles in a link or a form", async () => {
    assert.equal(await firefox.evaluate(pageContext, "window.codeInputs"), 0);
    assert.equal(fixtures.hits("/probe-nav"), 0);
  });

  test("the probe's own events stop before the page's bubble-phase listeners", async () => {
    assert.equal(await firefox.evaluate(pageContext, "window.escaped"), 0);
  });

  test("no page text reaches either report", () => {
    assert.ok(checks.length > 0);
    assert.equal(json.includes(PROBE_SECRET), false);
    assert.equal(markdown.includes(PROBE_SECRET), false);
  });

  function find(check: string, target: string, strategy: string): ProbeCheck {
    const found = checks.find(
      (entry) => entry.check === check && entry.target === target && entry.strategy === strategy,
    );
    assert.ok(found !== undefined, `no ${check} ${target} ${strategy} in ${json}`);
    return found;
  }
});

function pick({ outcome, delivered, trustedOnly }: ProbeCheck): Partial<ProbeCheck> {
  return { outcome, delivered, trustedOnly };
}

function checksOf(report: unknown): ProbeCheck[] {
  assert.ok(typeof report === "object" && report !== null && "pages" in report);
  const { pages } = report;
  assert.ok(Array.isArray(pages) && pages.length === 1, JSON.stringify(pages));
  const [page]: unknown[] = pages;
  assert.ok(
    typeof page === "object" && page !== null && "checks" in page && Array.isArray(page.checks),
    JSON.stringify(page),
  );
  // The server validated every check before it wrote the report.
  return page.checks as ProbeCheck[];
}
