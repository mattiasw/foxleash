import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ACT_QUIET_MS, ACT_SETTLE_CAP_MS } from "@foxleash/protocol";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  SETTLE_SLOW_MS,
  SETTLE_SLOW_TEXT,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  tabOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
/** An act on a quiet page answers well within this. */
const QUIET_ACT_MS = 400;
/** How far past the cap an act on a page that never goes quiet may answer. */
const CAP_SLACK_MS = 500;

interface Page {
  url: string;
  tabId: number;
  context: string;
  tree: string;
}

// One Firefox for the file: the tests run in order, each on a page of its own.
describe("acts wait for the page to settle in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let opened = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
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

  for (const hidden of [false, true]) {
    const where = hidden ? "in a tab that is not selected" : "in the selected tab";

    test(`a click that changes nothing answers unchanged quickly, ${where}`, async (t) => {
      const page = await settlePage(hidden);
      const ref = refOf(page.tree, 'button "Quiet"');
      const { value, ms } = await timed(() =>
        harness.ok(session, "click", { tabId: page.tabId, ref, view: false }),
      );
      t.diagnostic(`quiet click ${where}: ${ms} ms`);
      assert.deepEqual(afterOf(value), {
        element: { role: "button", name: "Quiet" },
        page: "unchanged",
      });
      assert.ok(ms >= ACT_QUIET_MS, `${ms} ms`);
      assert.ok(ms < QUIET_ACT_MS, `${ms} ms`);
    });

    test(`a click whose request answers later answers changed, and a read in the batch sees it, ${where}`, async (t) => {
      const page = await settlePage(hidden);
      const ref = refOf(page.tree, 'button "Slow"');
      const { value: result, ms } = await timed(() =>
        harness.call(session, "batch", {
          steps: [
            { tool: "click", args: { tabId: page.tabId, ref } },
            { tool: "read_page", args: { tabId: page.tabId } },
          ],
        }),
      );
      t.diagnostic(`click with a ${SETTLE_SLOW_MS} ms request, then read_page, ${where}: ${ms} ms`);
      assert.equal(result.isError, false, result.texts.join("\n"));
      const [, clicked, , read] = result.texts;
      const settled = afterOf(parseResult(clicked ?? ""));
      assert.equal(settled.page, "changed", JSON.stringify(settled));
      assert.deepEqual(settled.element, { role: "button", name: "Slow" });
      assert.ok(Number(settled.requests) >= 1, JSON.stringify(settled));
      assert.ok((untrustedContent(read ?? "") ?? "").includes(SETTLE_SLOW_TEXT), String(read));
    });

    test(`a click on a same-site link answers loaded with the new page's address, ${where}`, async (t) => {
      const page = await settlePage(hidden);
      const ref = refOf(page.tree, 'link "Next page"');
      const { value, ms } = await timed(() =>
        harness.ok(session, "click", { tabId: page.tabId, ref }),
      );
      t.diagnostic(`link click ${where}: ${ms} ms`);
      assert.deepEqual(afterOf(value), {
        element: { role: "link", name: "Next page" },
        page: "loaded",
        url: fixtures.url("/settle-next"),
      });
    });

    test(`a click on a page that never goes quiet answers unsettled at the cap, ${where}`, async (t) => {
      const page = await settlePage(hidden);
      const ref = refOf(page.tree, 'button "Ticker"');
      try {
        const { value, ms } = await timed(() =>
          harness.ok(session, "click", { tabId: page.tabId, ref, view: false }),
        );
        t.diagnostic(`click on a never-quiet page ${where}: ${ms} ms`);
        const settled = afterOf(value);
        assert.equal(settled.page, "unsettled", JSON.stringify(settled));
        assert.ok(ms >= ACT_SETTLE_CAP_MS, `${ms} ms`);
        assert.ok(ms < ACT_SETTLE_CAP_MS + CAP_SLACK_MS, `${ms} ms`);
      } finally {
        await harness.ok(session, "tab_close", { tabId: page.tabId });
      }
    });

    test(`a batch does not click at a point after a step loaded another page, ${where}`, async () => {
      const page = await settlePage(hidden);
      const result = await harness.call(session, "batch", {
        steps: [
          { tool: "click", args: { tabId: page.tabId, ref: refOf(page.tree, 'link "Next page"') } },
          { tool: "click", args: { tabId: page.tabId, x: 10, y: 10 } },
        ],
      });
      assert.equal(result.isError, true);
      const [first, clicked, notRun, ...rest] = result.texts;
      assert.deepEqual(rest, []);
      assert.equal(first, "Step 1 of 2, click: ok");
      assert.equal(afterOf(parseResult(clicked ?? "")).page, "loaded");
      assert.equal(
        notRun,
        `Step 2 (click) was not run because step 1 loaded another page in tab ${page.tabId}, and step 2 aims at a point or at the focused element chosen before that page was seen; read the page, then act.`,
      );
    });
  }

  /**
   * Opens the settle page in a new tab and reads it; when `hidden`, then opens another tab in the
   * group, which Firefox selects, and waits until the settle page is hidden.
   */
  async function settlePage(hidden: boolean): Promise<Page> {
    const page = await open("/settle", TITLES.settle);
    if (!hidden) return page;
    opened += 1;
    await harness.ok(session, "tab_open", { url: fixtures.url(`/a?tab=${opened}`) });
    await pollUntil(
      async () => {
        const state = await firefox.evaluate(page.context, "document.visibilityState");
        if (state === "hidden") return state;
        throw new Error(`the settle page is ${String(state)}`);
      },
      PAGE_TIMEOUT_MS,
      "the settle page to be hidden",
    );
    return page;
  }

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
});

/** The call's value and how long the whole MCP call took, in whole ms. */
async function timed<T>(call: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await call();
  return { value, ms: Math.round(performance.now() - start) };
}

/** The after of an act's result. */
function afterOf(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value) && isRecord(value.after), `no after in ${JSON.stringify(value)}`);
  return value.after;
}

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}
