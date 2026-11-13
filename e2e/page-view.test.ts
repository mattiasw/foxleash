import assert from "node:assert/strict";
import { after, before, describe, type TestContext, test } from "node:test";
import { PAGE_VIEW_MAX_CHARS } from "@foxleash/protocol";
import {
  type FixtureServer,
  startFixtureServer,
  TITLES,
  VIEW_ADDED_TEXT,
  VIEW_LARGE_STATUS,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  type ToolResult,
  tabOf,
  untrustedContent,
  viewItemsOf,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
const TREE_HEADER = "The page, as read_page shows it:";
const CHANGES_HEADER =
  "What changed in the page since this session's last view of it: + added, - removed; unmarked lines show where.";
const UNCHANGED =
  "Nothing changed in the page since this session's last view of it, which another agent of this session may have got; read_page shows the page whole.";
const SITE_ONLY =
  "The tab shows a site this session may not act on, so the view holds only that site:";
const READ_FROM_START =
  "read_page reads at most 50,000 characters of this page's tree, so the view comes from their start; read_page with find searches all of it.";

// One Firefox for the file: the tests run in order, each in a tab of its own.
describe("the view of the page that results end with, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let opened = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      await harness.startFirefox(EXTENSION_DIST);
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

  test("tab_open of a small page ends with its whole tree, as read_page shows it", async (t) => {
    const { tabId, result } = await openShop();
    const view = viewItemsOf(result);
    assert.deepEqual(view.own, [TREE_HEADER], result.texts.join("\n"));
    assert.equal(view.framed.length, 1);
    const tree = view.framed[0] ?? "";
    diagnose(t, "a new page", tree);
    assert.match(tree, /heading "Brass desk lamp"/);
    assert.match(tree, /button "Add to cart"/);
    assert.match(tree, /status/);
    const read = await harness.call(session, "read_page", { tabId });
    assert.equal(read.isError, false, read.text);
    assert.equal(tree, untrustedContent(read.text));
  });

  test("a click that changes the page ends with the lines that changed, in place", async (t) => {
    const { tabId, tree } = await openShop();
    const result = await harness.call(session, "click", {
      tabId,
      ref: refOf(tree, 'button "Add to cart"'),
    });
    assert.equal(result.isError, false, result.text);
    const view = viewItemsOf(result);
    assert.deepEqual(view.own, [CHANGES_HEADER], result.texts.join("\n"));
    const lines = view.framed[0] ?? "";
    diagnose(t, "the changes after Add to cart", lines);
    const shown = lines.split("\n");
    for (const line of shown) assert.match(line, /^(\+ |- | {2})/, lines);
    assert.ok(
      shown.some((line) => line.startsWith("+ ") && line.includes(VIEW_ADDED_TEXT)),
      lines,
    );
    assert.ok(
      shown.some((line) => line.startsWith("- ") && line.includes("Cart (0)")),
      lines,
    );
    assert.ok(
      shown.some((line) => line.startsWith("+ ") && line.includes("Cart (1)")),
      lines,
    );
    assert.ok(shown.length <= 12, lines);
  });

  test("a click that changes nothing ends with one line saying so", async (t) => {
    const { tabId, tree } = await openShop();
    const ref = refOf(tree, 'button "Compare"');
    // The first click can move the focus, which the tree shows.
    await harness.ok(session, "click", { tabId, ref });
    const { value: result, ms } = await timed(() => harness.call(session, "click", { tabId, ref }));
    const { ms: bare } = await timed(() =>
      harness.call(session, "click", { tabId, ref, view: false }),
    );
    t.diagnostic(`a click that changes nothing: ${ms} ms with its view, ${bare} ms without`);
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(viewItemsOf(result), { own: [UNCHANGED], framed: [] });
  });

  test("a page past the budget gets the lines that matter most, and how to read the rest", async (t) => {
    opened += 1;
    const url = fixtures.url(`/view-large?tab=${opened}`);
    const result = await harness.call(session, "tab_open", { url });
    assert.equal(result.isError, false, result.text);
    assert.equal(tabOf(parseResult(result.text)).title, TITLES.viewLarge);
    const view = viewItemsOf(result);
    const tree = view.framed[0] ?? "";
    diagnose(t, "a page past the budget", tree);
    assert.equal(view.framed.length, 1);
    assert.ok(tree.length <= PAGE_VIEW_MAX_CHARS, `${tree.length} characters`);
    assert.match(tree, new RegExp(`heading "${TITLES.viewLarge}"`));
    assert.match(tree, /heading "Rows"/);
    assert.ok(tree.includes(VIEW_LARGE_STATUS), tree);
    assert.match(tree, /textbox "Name"/);
    assert.match(tree, /button "Filter"/);
    assert.match(tree, /^ *… [0-9,]+ lines?$/m);
    assert.equal(view.own[0], TREE_HEADER);
    const [, leftOut, cut, ...rest] = view.own;
    assert.match(leftOut ?? "", /^The view leaves out [0-9,]+ lines of the page; /);
    assert.equal(cut, READ_FROM_START);
    assert.deepEqual(rest, []);
  });

  test("view false leaves the view out of navigate and of an act", async () => {
    const { tabId } = await openShop();
    const moved = await harness.call(session, "navigate", {
      tabId,
      url: fixtures.url(`/view-shop?moved=${opened}`),
      view: false,
    });
    assert.equal(moved.isError, false, moved.text);
    assert.equal(moved.texts.length, 1, moved.texts.join("\n"));
    const read = await harness.call(session, "read_page", { tabId });
    const clicked = await harness.call(session, "click", {
      tabId,
      ref: refOf(untrustedContent(read.text) ?? "", 'button "Add to cart"'),
      view: false,
    });
    assert.equal(clicked.isError, false, clicked.text);
    assert.equal(clicked.texts.length, 1, clicked.texts.join("\n"));
  });

  test("a tab an act took to a site that is not approved shows that site alone", async (t) => {
    const { tabId, tree } = await openShop();
    const other = `http://localhost:${fixtures.port}`;
    const result = await harness.call(session, "click", {
      tabId,
      ref: refOf(tree, 'link "Partner offer"'),
    });
    assert.equal(result.isError, false, result.text);
    const clicked = parseResult(result.text);
    assert.deepEqual(
      (clicked as { after?: unknown }).after,
      { element: { role: "link", name: "Partner offer" }, page: "loaded", url: other },
      result.texts.join("\n"),
    );
    const view = viewItemsOf(result);
    diagnose(t, "a site that is not approved", view.framed.join("\n"));
    assert.deepEqual(view, { own: [SITE_ONLY], framed: [other] });
    for (const text of result.texts) assert.ok(!text.includes(TITLES.a), text);
  });

  /** Opens the shop page in a new tab, under a query of its own, with its view. */
  async function openShop(): Promise<{ tabId: number; tree: string; result: ToolResult }> {
    opened += 1;
    const url = fixtures.url(`/view-shop?tab=${opened}`);
    const result = await harness.call(session, "tab_open", { url });
    assert.equal(result.isError, false, result.text);
    const tab = tabOf(parseResult(result.text));
    assert.equal(tab.title, TITLES.viewShop, `unexpected tab ${JSON.stringify(tab)}`);
    return { tabId: tab.id, tree: viewItemsOf(result).framed[0] ?? "", result };
  }
});

/** Emits the size of a view, for the record of what views cost. */
function diagnose(t: TestContext, what: string, text: string): void {
  t.diagnostic(`${what}: ${text.length} characters, ${text.split("\n").length} lines`);
}

/** The call's value and how long the whole MCP call took, in whole ms. */
async function timed<T>(call: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await call();
  return { value, ms: Math.round(performance.now() - start) };
}

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}
