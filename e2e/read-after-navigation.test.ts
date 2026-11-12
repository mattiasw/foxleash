import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  type FixtureServer,
  NAV_TARGET_TEXT,
  type NavigationVariant,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([0-9a-f]{8}-[1-9][0-9]*)";
// Without the wait, the old page or an error came back in 6 to 8 of 8 tries: one pass is not
// enough to tell.
const REPEAT = 5;
const VARIANTS: readonly NavigationVariant[] = [
  { store: "cache", delay: 0 },
  { store: "cache", delay: 400 },
  { store: "nostore", delay: 0 },
  { store: "nostore", delay: 400 },
];
// Far below the 10 s a read would wait for a navigation that never ends.
const PROMPT_MS = 3000;

interface Read {
  isError: boolean;
  text: string;
  tree: string;
}

// One Firefox for the file; each call is made as soon as the previous one returned.
describe("reads right after a navigation in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;

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

  for (const variant of VARIANTS) {
    const name = nameOf(variant);

    test(`read_page right after a click on a link returns the new page (${name})`, async () => {
      const tabId = await openTab();
      for (let repetition = 1; repetition <= REPEAT; repetition += 1) {
        const start = await showStart(tabId, variant, repetition);
        await harness.ok(session, "click", {
          tabId,
          ref: refOf(start.tree, 'link "Go to target"'),
        });
        assertTarget(await read(tabId), `${name}, repetition ${repetition}`);
      }
    });

    test(`a batch of a click and read_page reads the new page (${name})`, async () => {
      const tabId = await openTab();
      for (let repetition = 1; repetition <= REPEAT; repetition += 1) {
        const label = `${name}, repetition ${repetition}`;
        const start = await showStart(tabId, variant, repetition);
        const ref = refOf(start.tree, 'link "Go to target"');
        const result = await harness.call(session, "batch", {
          steps: [
            { tool: "click", args: { tabId, ref } },
            { tool: "read_page", args: { tabId } },
          ],
        });
        assertTarget(stepRead(result.isError, result.texts, 2), label);
      }
    });

    test(`a batch that submits a form with Enter, waits for main and reads, reads the new page (${name})`, async () => {
      const tabId = await openTab();
      for (let repetition = 1; repetition <= REPEAT; repetition += 1) {
        const label = `${name}, repetition ${repetition}`;
        const start = await showStart(tabId, variant, repetition);
        const ref = refOf(start.tree, 'textbox "Search"');
        const result = await harness.call(session, "batch", {
          steps: [
            { tool: "type", args: { tabId, ref, text: "query" } },
            { tool: "press_key", args: { tabId, key: "Enter" } },
            { tool: "wait_for", args: { tabId, selector: "main" } },
            { tool: "read_page", args: { tabId } },
          ],
        });
        assertTarget(stepRead(result.isError, result.texts, 4), label);
      }
    });

    test(`wait_for a text only the new page has, right after a click, finds it (${name})`, async () => {
      const tabId = await openTab();
      for (let repetition = 1; repetition <= REPEAT; repetition += 1) {
        const label = `${name}, repetition ${repetition}`;
        const start = await showStart(tabId, variant, repetition);
        await harness.ok(session, "click", {
          tabId,
          ref: refOf(start.tree, 'link "Go to target"'),
        });
        const waited = await harness.call(session, "wait_for", { tabId, text: NAV_TARGET_TEXT });
        assert.equal(waited.isError, false, `${label}: wait_for returned:\n${waited.text}`);
        assertTarget(await read(tabId), label);
      }
    });
  }

  for (const delay of [0, 400] as const) {
    const variant: NavigationVariant = { store: "cache", delay };
    const name = nameOf(variant);

    test(`read_page right after a click on a page still loading returns the new page (${name})`, async () => {
      const tabId = await openTab();
      for (let repetition = 1; repetition <= REPEAT; repetition += 1) {
        const label = `${name}, repetition ${repetition}`;
        const start = await showStart(tabId, variant, repetition);
        await harness.ok(session, "click", {
          tabId,
          ref: refOf(start.tree, 'link "Go to middle"'),
        });
        // Read at DOM ready, while the middle page's image still loads.
        const middle = await read(tabId);
        assert.ok(
          !middle.isError && middle.tree.includes(`heading "${TITLES.navMiddle}"`),
          `${label}: the middle page's read returned:\n${middle.text}`,
        );
        await harness.ok(session, "click", {
          tabId,
          ref: refOf(middle.tree, 'link "Go to target"'),
        });
        assertTarget(await read(tabId), label);
      }
    });
  }

  test("a fragment link, pushState, a 204 and a download do not hold the next read", async () => {
    const variant: NavigationVariant = { store: "nostore", delay: 0 };
    const tabId = await openTab();
    let repetition = 0;
    for (const line of [
      'link "Jump down"',
      'button "Push state"',
      'link "No content"',
      'link "Save data"',
    ]) {
      repetition += 1;
      const start = await showStart(tabId, variant, repetition);
      await harness.ok(session, "click", { tabId, ref: refOf(start.tree, line) });
      const started = Date.now();
      const shown = await read(tabId);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < PROMPT_MS, `${line}: read_page took ${elapsed} ms`);
      assertStart(shown, line);
    }
  });

  // A no-cache page can come back from memory, with no DOMContentLoaded; a no-store one loads again.
  for (const store of ["cache", "nostore"] as const) {
    test(`going back does not hold the next read (${store})`, async () => {
      const variant: NavigationVariant = { store, delay: 0 };
      const tabId = await openTab();
      const start = await showStart(tabId, variant, 1);
      await harness.ok(session, "click", { tabId, ref: refOf(start.tree, 'link "Go to target"') });
      assertTarget(await read(tabId), `${store}, before going back`);
      await harness.ok(session, "navigate", { tabId, action: "back" });
      const started = Date.now();
      const shown = await read(tabId);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < PROMPT_MS, `${store}: read_page after back took ${elapsed} ms`);
      assertStart(shown, `${store}, after going back`);
    });
  }

  async function openTab(): Promise<number> {
    return tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") })).id;
  }

  /** Loads the start page of the variant in the tab, under a query of its own, and reads it. */
  async function showStart(
    tabId: number,
    { delay, store }: NavigationVariant,
    repetition: number,
  ): Promise<Read> {
    const url = fixtures.url(`/nav/start?delay=${delay}&store=${store}&n=${repetition}`);
    await harness.ok(session, "navigate", { tabId, url });
    const start = await read(tabId);
    assertStart(start, `loading ${url}`);
    return start;
  }

  async function read(tabId: number): Promise<Read> {
    const result = await harness.call(session, "read_page", { tabId });
    return {
      isError: result.isError,
      text: result.text,
      tree: untrustedContent(result.text) ?? "",
    };
  }
});

function nameOf({ store, delay }: NavigationVariant): string {
  return `${store}, ${delay} ms`;
}

/** The read of a batch's step `step` (from 1), whose result follows the step's header. */
function stepRead(isError: boolean, texts: string[], step: number): Read {
  const text = texts[2 * step - 1] ?? "";
  const header = texts[2 * step - 2] ?? "";
  return {
    isError: isError || !header.endsWith(": ok"),
    text: texts.join("\n"),
    tree: untrustedContent(text) ?? "",
  };
}

function assertTarget(read: Read, label: string): void {
  assert.ok(
    !read.isError &&
      read.tree.includes(`heading "${TITLES.navTarget}"`) &&
      read.tree.includes(NAV_TARGET_TEXT) &&
      !read.tree.includes(`heading "${TITLES.navStart}"`),
    `${label}: the read returned:\n${read.text}`,
  );
}

function assertStart(read: Read, label: string): void {
  assert.ok(
    !read.isError && read.tree.includes(`heading "${TITLES.navStart}"`),
    `${label}: the read returned:\n${read.text}`,
  );
}

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}
