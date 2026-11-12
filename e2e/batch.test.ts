import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([0-9a-f]{8}-[1-9][0-9]*)";

interface Page {
  url: string;
  tabId: number;
  context: string;
  tree: string;
}

// One Firefox for the file; each test acts in a tab of its own.
describe("batch in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let other = "";
  let opened = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      other = `http://localhost:${fixtures.port}`;
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
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
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("a batch clicks, types and reads the page, returning every step's result", async () => {
    const act = await open("/act", TITLES.act);
    const toggle = refOf(act.tree, 'button "Toggle"');
    const field = refOf(act.tree, 'textbox "Field"');
    const result = await harness.call(session, "batch", {
      steps: [
        { tool: "click", args: { tabId: act.tabId, ref: toggle } },
        { tool: "type", args: { tabId: act.tabId, ref: field, text: "Batch text" } },
        { tool: "read_page", args: { tabId: act.tabId } },
      ],
    });
    assert.equal(result.isError, false, result.texts.join("\n"));
    const [first, clicked, second, typed, third, read, ...rest] = result.texts;
    assert.deepEqual(rest, []);
    assert.equal(first, "Step 1 of 3, click: ok");
    assert.equal(record(parseResult(clicked ?? "")).ref, toggle);
    assert.equal(second, "Step 2 of 3, type: ok");
    assert.equal(record(parseResult(typed ?? "")).outcome, "typed");
    assert.equal(third, "Step 3 of 3, read_page: ok");
    const tree = untrustedContent(read ?? "") ?? "";
    assert.match(tree, new RegExp(`button "Toggle" \\[${toggle}\\] expanded=true`));
    assert.match(tree, new RegExp(`textbox "Field" \\[${field}\\][^\\n]* value="Batch text"`));
    assert.equal(
      await evaluate(act, 'document.getElementById("toggle").getAttribute("aria-expanded")'),
      "true",
    );
    assert.equal(await evaluate(act, 'document.getElementById("field").value'), "Batch text");
  });

  test("a batch stops at a step on a site the user has not approved", async () => {
    const act = await open("/act", TITLES.act);
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/act-redirect") }),
    );
    // tab_open can return before the tab shows the redirect target.
    await pollUntil(
      async () => {
        const listed = tabsOf(await harness.ok(session, "tabs_list")).find(
          ({ id }) => id === tab.id,
        );
        if (listed !== undefined && URL.parse(listed.url)?.origin === other) return listed;
        throw new Error(`tab ${tab.id} is listed as ${JSON.stringify(listed?.url)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${tab.id} to show ${other}`,
    );
    await evaluate(act, "window.log.length = 0");
    const result = await harness.call(session, "batch", {
      steps: [
        { tool: "click", args: { tabId: act.tabId, ref: refOf(act.tree, 'button "Fixed"') } },
        { tool: "click", args: { tabId: tab.id, x: 70, y: 25 } },
        { tool: "click", args: { tabId: act.tabId, ref: refOf(act.tree, 'button "Toggle"') } },
      ],
    });
    assert.equal(result.isError, true);
    const [first, , second, refused = "", notRun, ...rest] = result.texts;
    assert.deepEqual(rest, []);
    assert.equal(first, "Step 1 of 3, click: ok");
    assert.equal(second, "Step 2 of 3, click: failed");
    assert.ok(refused.includes(`Foxleash is not allowed on ${other} in this session`), refused);
    assert.equal(notRun, "Step 3 (click) was not run because step 2 failed.");
    assert.deepEqual(await clicksIn(act), ["click:fixed:1"]);
    assert.equal(
      await evaluate(act, 'document.getElementById("toggle").getAttribute("aria-expanded")'),
      "false",
    );
    const found = (await firefox.contexts()).find(({ url }) => url === `${other}/act`);
    assert.ok(found !== undefined, "no tab shows the act page on the other site");
    assert.deepEqual(
      JSON.parse(String(await firefox.evaluate(found.context, "JSON.stringify(window.log)"))),
      [],
    );
  });

  /** Opens a fixture page in a new tab, under a query of its own, and reads it. */
  async function open(path: string, title: string): Promise<Page> {
    opened += 1;
    const url = fixtures.url(`${path}?tab=${opened}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    const read = await harness.call(session, "read_page", { tabId: tab.id });
    assert.equal(read.isError, false, read.text);
    return { url, tabId: tab.id, context: found.context, tree: untrustedContent(read.text) ?? "" };
  }

  /** The page's value of a JavaScript expression, through JSON. */
  async function evaluate(page: Page, expression: string): Promise<unknown> {
    const json = await firefox.evaluate(page.context, `JSON.stringify(${expression}) ?? "null"`);
    return JSON.parse(String(json));
  }

  async function clicksIn(page: Page): Promise<unknown> {
    const log = await evaluate(page, "window.log");
    assert.ok(Array.isArray(log));
    return log.filter((entry) => typeof entry === "string" && /^(click|dblclick):/.test(entry));
  }
});

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
