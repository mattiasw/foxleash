import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ALL_WEBSITES_ACCESS_STEPS } from "@foxleash/protocol";
import { type Firefox, KEY, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  FOREIGN_SECRET,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  type ToolResult,
  tabOf,
  tabsOf,
} from "./harness.ts";

const REMOVE_ACCESS = 'browser.permissions.remove({ origins: ["<all_urls>"] })';
/** An address on the approved site that redirects to the other site's file. */
const TO_EXPORT = "/foreign/go/export.csv";
const EXPORT = "/foreign/export.csv";
const LOAD_REFUSED = `Foxleash needs access to all websites to load a page: without it, Firefox hides other sites' answers from Foxleash, so it could not stop a file from a site this session may not act on. Ask the user to ${ALL_WEBSITES_ACCESS_STEPS}. Firefox lists this access as optional, but Foxleash needs it. Nothing was loaded.`;

// One Firefox for this describe: the tests run in order and build on each other's tab.
describe("loads and page tools while Firefox withholds access to websites", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let tabId = -1;
  let settings = "";

  /** The page-tool refusal for the tab opened on the approved site. */
  function withheld(): string {
    return `Firefox has not given Foxleash access to this site, so Foxleash cannot read or act in the page in tab ${tabId}. Ask the user to open about:addons in Firefox, click Foxleash, then the Permissions tab, and under "Optional" turn on "Access your data for all websites". Firefox lists this access as optional, but Foxleash needs it.`;
  }

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      const other = `http://localhost:${fixtures.port}`;
      firefox = await harness.startFirefox(EXTENSION_DIST, { withholdSiteAccess: true });
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
      // The user signs in to the other site in a tab of their own, so its export answers.
      await firefox.closeContext(await firefox.openContext(`${other}/foreign/login`));
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

  test("tab_open of an address that leads to another site's file is refused at once, with nothing requested", async () => {
    await assertLoadRefused(() =>
      harness.call(session, "tab_open", { url: fixtures.url(TO_EXPORT) }),
    );
  });

  test("tab_open without a URL opens a tab, and navigate of it to that address is refused the same way", async () => {
    const blank = tabOf(await harness.ok(session, "tab_open"));
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.ok(
      tabs.some((listed) => listed.id === blank.id),
      JSON.stringify(tabs),
    );
    await assertLoadRefused(() =>
      harness.call(session, "navigate", { tabId: blank.id, url: fixtures.url(TO_EXPORT) }),
    );
  });

  test("the settings page warns while Firefox withholds access to all websites", async () => {
    settings = await harness.settingsPage();
    await waitFor('document.getElementById("website-access").hidden', false, "the warning shown");
    assert.equal(
      await firefox.evaluate(
        settings,
        'document.getElementById("website-access-steps").textContent',
      ),
      ALL_WEBSITES_ACCESS_STEPS,
    );
    await waitFor(
      'document.getElementById("website-access-status").textContent',
      "Firefox is not giving Foxleash access to all websites.",
      "the withheld announcement",
    );
  });

  test("the warning's button gives the access, hides the warning and announces it", async () => {
    await firefox.click(settings, "#website-access-give");
    await waitFor('document.getElementById("website-access").hidden', true, "the warning hidden");
    await waitFor(
      'document.getElementById("website-access-status").textContent',
      "Firefox now gives Foxleash access to all websites.",
      "the grant announcement",
    );
    assert.equal(
      await firefox.evaluate(settings, "document.activeElement?.id ?? null"),
      "website-access-status",
    );
  });

  test("tab_open loads the approved site with the access, and the warning shows again once it is removed", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    assert.equal(tab.title, TITLES.a);
    tabId = tab.id;
    await firefox.evaluate(settings, REMOVE_ACCESS);
    await waitFor('document.getElementById("website-access").hidden', false, "the warning shown");
  });

  for (const tool of ["get_page_text", "read_page", "screenshot"]) {
    test(`${tool} says Firefox withholds the site's access, naming neither the site nor the page`, async () => {
      const result = await harness.call(session, tool, { tabId });
      assert.equal(result.isError, true, result.text);
      assert.ok(result.text.includes(withheld()), result.text);
      assert.ok(!result.text.includes(fixtures.site), result.text);
      assert.ok(!result.text.includes(fixtures.url("/a")), result.text);
      assert.deepEqual(result.images, [], result.text);
    });
  }

  test("wait_for stops at once with the same refusal", async () => {
    const started = performance.now();
    const result = await harness.call(session, "wait_for", {
      tabId,
      text: "Never shown on this page",
      timeout: 10,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.isError, true, result.text);
    assert.ok(result.text.includes(withheld()), result.text);
    assert.ok(elapsed < 5_000, `wait_for took ${Math.round(elapsed)} ms`);
  });

  test("read_network says it cannot see the requests, naming neither the site nor the page", async () => {
    const result = await harness.call(session, "read_network", { tabId });
    assert.equal(result.isError, true, result.text);
    assert.ok(
      result.text.includes(
        `Foxleash needs access to all websites to see the requests of tab ${tabId}: without it, Firefox hides requests from Foxleash. Ask the user to ${ALL_WEBSITES_ACCESS_STEPS}. Firefox lists this access as optional, but Foxleash needs it.`,
      ),
      result.text,
    );
    assert.ok(!result.text.includes(fixtures.site), result.text);
    assert.ok(!result.text.includes(fixtures.url("/a")), result.text);
  });

  // The tests below end the withheld state, so they come last.
  test("the warning's button gives the access again and hides the warning", async () => {
    assert.equal(
      await firefox.evaluate(settings, 'document.getElementById("website-access").hidden'),
      false,
    );
    await firefox.click(settings, "#website-access-give");
    await waitFor('document.getElementById("website-access").hidden', true, "the warning hidden");
  });

  test("get_page_text reads the page once the access is given", async () => {
    const result = await harness.ok(session, "get_page_text", { tabId });
    assert.ok(JSON.stringify(result).includes(TITLES.a), JSON.stringify(result));
  });

  /**
   * The call fails well under the 30 s a load waits, with the load refusal, and neither the address
   * nor the file it redirects to was requested, so no file holding the other site's secret was saved.
   */
  async function assertLoadRefused(load: () => Promise<ToolResult>): Promise<void> {
    const hits = [fixtures.hits(TO_EXPORT), fixtures.hits(EXPORT)];
    const started = performance.now();
    const result = await load();
    const elapsed = performance.now() - started;
    assert.equal(result.isError, true, result.text);
    assert.ok(result.text.includes(LOAD_REFUSED), result.text);
    assert.ok(elapsed < 5_000, `the refusal took ${Math.round(elapsed)} ms`);
    assert.deepEqual([fixtures.hits(TO_EXPORT), fixtures.hits(EXPORT)], hits);
    const secrets = readdirSync(harness.downloads).filter((name) => {
      try {
        return readFileSync(join(harness.downloads, name), "utf8").includes(FOREIGN_SECRET);
      } catch {
        return false;
      }
    });
    assert.deepEqual(secrets, []);
  }

  async function waitFor(expression: string, expected: unknown, what: string): Promise<void> {
    await pollUntil(
      async () => {
        const value = await firefox.evaluate(settings, expression);
        if (value === expected) return true;
        throw new Error(`the page shows ${String(value)}`);
      },
      PAGE_TIMEOUT_MS,
      `${what}: ${String(expected)}`,
    );
  }
});

// One Firefox for this describe, started with the access withheld: the tests run in order and
// build on each other's pages.
describe("the approval pages while Firefox withholds access to all websites", () => {
  const WARNING_HIDDEN = 'document.getElementById("website-access").hidden';
  // Records whether the warning was hidden when the first answer button next stops answering.
  const WATCH_UNARM = `(() => {
    delete document.documentElement.dataset.warningHiddenAtUnarm;
    new MutationObserver((records, observer) => {
      observer.disconnect();
      document.documentElement.dataset.warningHiddenAtUnarm = String(${WARNING_HIDDEN});
    }).observe(document.querySelector("button[data-answer]"), {
      attributes: true,
      attributeFilter: ["aria-disabled"],
    });
  })()`;
  let harness: Harness;
  let prompted: FixtureServer;
  let requested: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let opening: Promise<ToolResult>;
  let requesting: Promise<ToolResult>;
  let prompt = "";
  let run = "";

  before(
    async () => {
      harness = createHarness();
      harness.install();
      prompted = await startFixtureServer();
      requested = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST, { withholdSiteAccess: true });
      session = await harness.connect();
      await harness.waitUntilReady(session);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        try {
          await prompted?.close();
        } finally {
          await requested?.close();
        }
      }
    },
    { timeout: 60_000 },
  );

  test("the site prompt shows the warning above its answers, and the answers still arm", async () => {
    opening = pending(harness.call(session, "tab_open", { url: prompted.url("/a") }));
    prompt = await harness.promptContext();
    await waitFor(prompt, WARNING_HIDDEN, false, "the warning shown");
    await assertWarningAboveAnswers(prompt);
    await harness.waitForArmed(prompt);
  });

  test("the warning's button on the site prompt hides it, unarms the answers and keeps focus on the page", async () => {
    await giveAccessFromWarning(prompt, 3);
  });

  test("losing the access shows the warning again on the site prompt and unarms the answers", async () => {
    await removeAccessShowsWarning(prompt, 3);
  });

  test("Tab from the heading through the warning's button onto the first answer, then Enter, answers", async () => {
    await firefox.evaluate(prompt, 'document.getElementById("heading").focus()');
    await harness.waitForArmed(prompt);
    await firefox.keys(prompt, [KEY.tab, KEY.tab, KEY.enter]);
    await pollUntil(
      async () => {
        const text = await firefox.evaluate(
          prompt,
          'document.getElementById("status").textContent',
        );
        if (typeof text === "string" && text.startsWith("Not allowed.")) return true;
        throw new Error(`the page shows ${String(text)}`);
      },
      PAGE_TIMEOUT_MS,
      "the prompt to say Not allowed.",
    );
    const result = await opening;
    assert.equal(result.isError, true, result.text);
  });

  test("the page asking for sites shows the warning above its answers, and the answers still arm", async () => {
    requesting = pending(harness.call(session, "request_sites", { sites: [requested.site] }));
    run = await harness.pageContext("run.html");
    await waitFor(run, WARNING_HIDDEN, false, "the warning shown");
    await assertWarningAboveAnswers(run);
    await harness.waitForArmed(run, 2);
  });

  test("on the page asking for sites, the warning's button and losing the access each unarm the answers", async () => {
    await giveAccessFromWarning(run, 2);
    await removeAccessShowsWarning(run, 2);
  });

  test("Don't allow on the page asking for sites still fails request_sites", async () => {
    await firefox.click(run, 'button[data-answer="no"]');
    const result = await requesting;
    assert.equal(result.isError, true, result.text);
  });

  async function waitFor(
    context: string,
    expression: string,
    expected: unknown,
    what: string,
  ): Promise<void> {
    await pollUntil(
      async () => {
        const value = await firefox.evaluate(context, expression);
        if (value === expected) return true;
        throw new Error(`the page shows ${String(value)}`);
      },
      PAGE_TIMEOUT_MS,
      `${what}: ${String(expected)}`,
    );
  }

  /** The warning and its status line come before the answers, and the status line is a live region. */
  async function assertWarningAboveAnswers(context: string): Promise<void> {
    assert.equal(
      await firefox.evaluate(
        context,
        'document.getElementById("website-access-steps").textContent',
      ),
      ALL_WEBSITES_ACCESS_STEPS,
    );
    for (const id of ["website-access", "website-access-status"]) {
      assert.notEqual(
        await firefox.evaluate(
          context,
          `document.getElementById(${JSON.stringify(id)}).compareDocumentPosition(document.getElementById("answers")) & Node.DOCUMENT_POSITION_FOLLOWING`,
        ),
        0,
        `#${id} comes before the answers`,
      );
    }
    assert.equal(
      await firefox.evaluate(
        context,
        'document.getElementById("website-access-status").getAttribute("role")',
      ),
      "status",
    );
  }

  /**
   * A trusted click in the page's own tab, which it already shows: only the page's reaction to the
   * request and to the warning hiding can unarm the answers.
   */
  async function giveAccessFromWarning(context: string, buttons: number): Promise<void> {
    await harness.hiddenChangeUnarms(
      context,
      "#website-access",
      async () => {
        await firefox.evaluate(context, WATCH_UNARM);
        await firefox.click(context, "#website-access-give");
      },
      buttons,
    );
    // Firefox's prompt may not take focus: the answers stop as soon as it is asked for.
    assert.equal(
      await firefox.evaluate(
        context,
        "document.documentElement.dataset.warningHiddenAtUnarm ?? null",
      ),
      "false",
      "the answers stopped answering only once the warning hid, not when Firefox was asked",
    );
    await waitFor(context, WARNING_HIDDEN, true, "the warning hidden");
    assert.equal(
      await firefox.evaluate(context, "document.activeElement?.id ?? null"),
      "website-access-status",
    );
    // A click on the warning's button never answers.
    assert.equal(
      await firefox.evaluate(context, 'document.getElementById("answers") !== null'),
      true,
    );
  }

  /** From script in the page itself, with no click and no tab switch. */
  async function removeAccessShowsWarning(context: string, buttons: number): Promise<void> {
    await harness.waitForArmed(context, buttons);
    await harness.hiddenChangeUnarms(
      context,
      "#website-access",
      () => firefox.evaluate(context, REMOVE_ACCESS),
      buttons,
    );
    await harness.waitForArmed(context, buttons);
  }
});

/**
 * Handles a tool call's failure now, so a test that fails before it awaits the call leaves no
 * unhandled rejection. Returns the same promise: a later `await` still sees the outcome.
 */
function pending<T>(call: Promise<T>): Promise<T> {
  call.catch(() => undefined);
  return call;
}
