import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
/** The other site's export that answers only a user it knows, and the redirect to it. */
const EXPORT = "/foreign/export.csv";
const TO_EXPORT = "/foreign/go/export.csv";
/**
 * How long Firefox gets to save a file after the other site answered, before a test takes the
 * download folder to be as it stays. A load Foxleash reported stopping needs no such wait.
 */
const SAVE_WAIT_MS = 1500;

interface Page {
  tabId: number;
  context: string;
  tree: string;
}

// One Firefox for the file: the tests run in order and share its download folder and its cache.
describe("a file from a site the session may not act on, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  /** The same server under another site. */
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
      // The folder Firefox saves in is an upload folder, as ~/Downloads is by default.
      session = await harness.connect({ FOXLEASH_UPLOAD_DIRS: harness.downloads });
      await harness.waitUntilReady(session);
      // The user signs in to the other site in a tab of their own, where two of its exports
      // have been loaded before, so Firefox's cache holds them.
      await firefox.closeContext(await firefox.openContext(`${other}/foreign/login`));
      for (const path of ["/foreign/cached.csv", "/foreign/revalidated.csv"]) {
        const context = await firefox.openContext(`${other}/foreign/warm?path=${path}`);
        await pollUntil(
          async () =>
            (await firefox.evaluate(context, "document.title")) === TITLES.foreignWarmed
              ? true
              : undefined,
          PAGE_TIMEOUT_MS,
          `the other site's page to have fetched ${path}`,
        );
        await firefox.closeContext(context);
        assert.equal(fixtures.hits(path), 1, path);
      }
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

  describe("while the other site is not approved", () => {
    threeWays();

    test("tab_open of an address that redirects to the other site's file fails at once and leaves no tab", async () => {
      const tabs = await tabIds();
      const files = listed();
      const hits = fixtures.hits(EXPORT);
      const started = Date.now();
      const text = await harness.refused(session, "tab_open", { url: fixtures.url(TO_EXPORT) });
      const elapsed = Date.now() - started;
      // The tab it made, whose id the message names, is gone.
      const message = (untrustedContent(text) ?? "").replace(/^Tab [0-9]+'s /, "Tab N's ");
      assert.ok(fixtures.hits(EXPORT) > hits, "the other site was not asked for its file");
      await assertNothingSaved(files, message === refusal("N"));
      assert.equal(message, refusal("N"));
      assert.ok(elapsed < 10_000, `tab_open took ${elapsed} ms`);
      assert.deepEqual(await tabIds(), tabs);
    });

    for (const [name, line, path] of [
      ["a link with the download attribute", 'link "Export as a download"', EXPORT],
      ["a CSV sent with no Content-Disposition", 'link "Plain export"', "/foreign/plain.csv"],
      [
        "an answer with two Content-Type headers",
        'link "Two types export"',
        "/foreign/two-types.csv",
      ],
      [
        "a file Firefox asks the other site about again",
        'link "Revalidated export"',
        "/foreign/revalidated.csv",
      ],
    ] as const) {
      test(`a click that ends in ${name} saves nothing, and its result says so`, async () => {
        const page = await openLinks();
        const files = listed();
        const hits = fixtures.hits(path);
        const result = await click(page, line);
        await answered(path, hits);
        await assertNothingSaved(files, stoppedIn(result));
        assert.deepEqual(result.refusedFiles, [other]);
        await close(page);
      });
    }

    test("a click that ends in a file Firefox takes from its cache saves nothing, and its result says so", async () => {
      const page = await openLinks();
      const files = listed();
      const hits = fixtures.hits("/foreign/cached.csv");
      const redirects = fixtures.hits("/foreign/go/cached.csv");
      const result = await click(page, 'link "Cached export"');
      await answered("/foreign/go/cached.csv", redirects);
      await assertNothingSaved(files, stoppedIn(result));
      assert.deepEqual(result.refusedFiles, [other]);
      // Firefox asked the other site nothing: the file it stopped came from its cache.
      assert.equal(fixtures.hits("/foreign/cached.csv"), hits);
      await close(page);
    });

    test("a frame on the other site's file saves nothing", async () => {
      const files = listed();
      const hits = fixtures.hits("/foreign/public.csv");
      const tab = tabOf(
        await harness.ok(session, "tab_open", { url: fixtures.url("/foreign/frame") }),
      );
      await answered("/foreign/public.csv", hits);
      await assertNothingSaved(files, false);
      await harness.ok(session, "tab_close", { tabId: tab.id });
    });

    test("a click that opens a tab on the other site's file saves nothing, and its result says so", async () => {
      await firefox.allowPopups(fixtures.site);
      try {
        const page = await openLinks();
        const files = listed();
        const hits = fixtures.hits(EXPORT);
        const result = await click(page, 'link "Export in a new tab"');
        await answered(EXPORT, hits);
        await assertNothingSaved(files, stoppedIn(result));
        assert.deepEqual(result.refusedFiles, [other]);
        const { openedTabs } = result;
        assert.ok(
          Array.isArray(openedTabs) && openedTabs.length === 1,
          `expected one opened tab, got ${JSON.stringify(result)}`,
        );
        // Firefox leaves the tab open, blank, when its load was stopped.
        for (const tabId of openedTabs) await harness.ok(session, "tab_close", { tabId });
        await close(page);
      } finally {
        await firefox.resetPopups(fixtures.site);
      }
    });

    test("a click that opens a window on the other site's file saves nothing, and its result says so", async () => {
      await firefox.allowPopups(fixtures.site);
      try {
        const page = await openPage("/foreign/windows");
        const files = listed();
        const hits = fixtures.hits(EXPORT);
        const tabs = await tabIds();
        const result = await click(page, 'button "Export in a window"');
        await answered(EXPORT, hits);
        await assertNothingSaved(files, stoppedIn(result));
        assert.deepEqual(result.refusedFiles, [other]);
        // The window is out of the agent's reach.
        assert.equal("openedTabs" in result, false, JSON.stringify(result));
        assert.deepEqual(await tabIds(), tabs);
        await closeWindow(page.context);
        await close(page);
      } finally {
        await firefox.resetPopups(fixtures.site);
      }
    });

    test("a page that opens a window on the other site's file by itself saves nothing", async () => {
      await firefox.allowPopups(fixtures.site);
      try {
        const files = listed();
        const hits = fixtures.hits(EXPORT);
        const url = fixtures.url("/foreign/window-script");
        const tab = tabOf(await harness.ok(session, "tab_open", { url }));
        await answered(EXPORT, hits);
        // No act and no load waits here, so no result reports the stop.
        await assertNothingSaved(files, false);
        const found = (await firefox.contexts()).find((context) => context.url === url);
        assert.ok(found !== undefined, `no tab shows ${url}`);
        // A page the other site sent, such as its answer to a request without the cookie, would
        // have taken the window to that site, where the opener cannot read its address.
        assert.equal(
          await firefox.evaluate(found.context, "window.popup.location.href"),
          "about:blank",
        );
        await closeWindow(found.context);
        await harness.ok(session, "tab_close", { tabId: tab.id });
      } finally {
        await firefox.resetPopups(fixtures.site);
      }
    });

    test("a window on a file of the approved site itself still saves it", async () => {
      await firefox.allowPopups(fixtures.site);
      try {
        const page = await openPage("/foreign/windows");
        const before = listed();
        const result = await click(page, 'button "Own file in a window"');
        const saved = await pollUntil(
          async () => {
            const files = listed();
            if (files.some((name) => name.endsWith(".part"))) return undefined;
            const name = files.find((entry) => !before.includes(entry));
            // Firefox reserves the name with an empty file before it writes the .part one.
            if (name === undefined) return undefined;
            return readFileSync(join(harness.downloads, name), "utf8") === "data"
              ? name
              : undefined;
          },
          PAGE_TIMEOUT_MS,
          "a new file in the download folder",
        );
        assert.equal("refusedFiles" in result, false, JSON.stringify(result));
        // The folder's last check counts on the file a later test saves.
        rmSync(join(harness.downloads, saved));
        await closeWindow(page.context);
        await close(page);
      } finally {
        await firefox.resetPopups(fixtures.site);
      }
    });

    test("a link to a file of the approved site itself still saves it", async () => {
      const page = await openLinks();
      const result = await click(page, 'link "Own file"');
      await pollUntil(
        async () => (listed().includes("data.bin") ? true : undefined),
        PAGE_TIMEOUT_MS,
        "data.bin in the download folder",
      );
      assert.equal("refusedFiles" in result, false, JSON.stringify(result));
      await close(page);
    });

    test("navigate to an address that redirects to a page of the other site still loads it, shown as its site only", async () => {
      const page = await openLinks();
      await harness.ok(session, "navigate", {
        tabId: page.tabId,
        url: fixtures.url("/foreign/go/page"),
      });
      const shown = await pollUntil(
        async () => {
          const tab = tabsOf(await harness.ok(session, "tabs_list")).find(
            ({ id }) => id === page.tabId,
          );
          return tab?.url === other ? tab : undefined;
        },
        PAGE_TIMEOUT_MS,
        `tab ${page.tabId} to show ${other}`,
      );
      assert.equal(shown.title, "");
      assert.equal(await firefox.evaluate(page.context, "document.title"), TITLES.foreignPage);
      await close(page);
    });
  });

  describe("while the other site is approved and on the blocklist", () => {
    before(
      async () => {
        // Approved, so that only the blocklist can be what stops its file.
        await harness.seedSettings({
          [`site:${other}`]: { grantedAt: new Date().toISOString() },
          blocklist: ["localhost"],
        });
      },
      { timeout: 60_000 },
    );

    threeWays();
  });

  test("the download folder ends up holding only the approved site's own file", async () => {
    // A stop that Foxleash reported was checked at once, and each later test took the folder as
    // it found it: a file whose load was not stopped after all has arrived by now.
    await sleep(SAVE_WAIT_MS);
    assert.deepEqual(listed(), ["data.bin"]);
  });

  /** The three ways a page of the approved site gets the other site's file loaded in its tab. */
  function threeWays(): void {
    test("a click on a link that redirects to the other site's file saves nothing, and its result says so", async () => {
      const page = await openLinks();
      const files = listed();
      const hits = fixtures.hits(EXPORT);
      const result = await click(page, 'link "Export"');
      await answered(EXPORT, hits);
      await assertNothingSaved(files, stoppedIn(result));
      assert.deepEqual(result.refusedFiles, [other]);
      await assertNothingToUpload(page);
      await close(page);
    });

    test("navigate to an address that redirects to the other site's file fails at once and saves nothing", async () => {
      const page = await openLinks();
      const files = listed();
      const hits = fixtures.hits(EXPORT);
      const started = Date.now();
      const text = await harness.refused(session, "navigate", {
        tabId: page.tabId,
        url: fixtures.url(TO_EXPORT),
      });
      const elapsed = Date.now() - started;
      const message = untrustedContent(text);
      assert.ok(fixtures.hits(EXPORT) > hits, "the other site was not asked for its file");
      await assertNothingSaved(files, message === refusal(page.tabId));
      assert.equal(message, refusal(page.tabId));
      assert.ok(elapsed < 10_000, `navigate took ${elapsed} ms`);
      // The tab kept its page.
      await assertNothingToUpload(page);
      await close(page);
    });

    test("a page that moves on to the other site's file by itself saves nothing", async () => {
      const files = listed();
      const hits = fixtures.hits(EXPORT);
      const url = fixtures.url("/foreign/script");
      const tab = tabOf(await harness.ok(session, "tab_open", { url }));
      await answered(EXPORT, hits);
      // No act and no load waits here, so no result reports the stop.
      await assertNothingSaved(files, false);
      const shown = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tab.id);
      assert.equal(shown?.url, url);
      const page = await openLinks();
      await assertNothingToUpload(page);
      await close(page);
      await harness.ok(session, "tab_close", { tabId: tab.id });
    });
  }

  /** A tab of the session on the approved site's page of links, with the page as read_page shows it. */
  async function openLinks(): Promise<Page> {
    return openPage("/foreign/links");
  }

  /** A tab of the session on that page of the approved site, with the page as read_page shows it. */
  async function openPage(path: string): Promise<Page> {
    opened += 1;
    const url = fixtures.url(`${path}?tab=${opened}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    const read = await harness.call(session, "read_page", { tabId: tab.id });
    assert.equal(read.isError, false, read.text);
    return { tabId: tab.id, context: found.context, tree: untrustedContent(read.text) ?? "" };
  }

  /** Clicks the link and returns the result's after. */
  async function click(page: Page, line: string): Promise<Record<string, unknown>> {
    const result = await harness.ok(session, "click", {
      tabId: page.tabId,
      ref: refOf(page.tree, line),
      view: false,
    });
    assert.ok(isRecord(result) && isRecord(result.after), JSON.stringify(result));
    return result.after;
  }

  /** Whether the act's result says Foxleash stopped the other site's file. */
  function stoppedIn(result: Record<string, unknown>): boolean {
    return isDeepStrictEqual(result.refusedFiles, [other]);
  }

  /** Waits until the server was asked for `path` again since it had `hits` requests for it. */
  async function answered(path: string, hits: number): Promise<void> {
    await pollUntil(
      async () => (fixtures.hits(path) > hits ? true : undefined),
      PAGE_TIMEOUT_MS,
      `a request for ${path}`,
    );
  }

  /**
   * The download folder holds what it held: called once the load ran its course, which is at once
   * when Foxleash reported stopping it, and SAVE_WAIT_MS after the other site's answer otherwise.
   */
  async function assertNothingSaved(files: string[], stopped: boolean): Promise<void> {
    if (!stopped) await sleep(SAVE_WAIT_MS);
    assert.deepEqual(listed(), files);
  }

  /** upload_file finds no export to hand to the approved site's page, which received no file. */
  async function assertNothingToUpload(page: Page): Promise<void> {
    const text = await harness.refused(session, "upload_file", {
      tabId: page.tabId,
      ref: refOf(page.tree, 'button "Statement"'),
      paths: [join(harness.downloads, "export.csv")],
    });
    assert.ok(text.includes("does not exist."), text);
    assert.equal(await firefox.evaluate(page.context, "JSON.stringify(window.received)"), "[]");
  }

  /**
   * Closes the window that the page in `context` opened and keeps in window.popup. A window whose
   * load was stopped stays open on a blank page; one whose load became a download may have closed
   * itself.
   */
  async function closeWindow(context: string): Promise<void> {
    await firefox.evaluate(context, "window.popup.close(); true");
    await pollUntil(
      async () =>
        (await firefox.evaluate(context, "window.popup.closed")) === true ? true : undefined,
      PAGE_TIMEOUT_MS,
      "the window to close",
    );
  }

  async function close(page: Page): Promise<void> {
    await harness.ok(session, "tab_close", { tabId: page.tabId });
  }

  /** What navigate and tab_open say when the tab's load ended in the other site's file. */
  function refusal(tab: number | string): string {
    return `Tab ${tab}'s load ended in a file from ${other}, a site this session may not act on. Foxleash stopped it; nothing was saved. To get the file, the site must be approved first: tab_open or navigate to it asks the user, unless it is on the blocklist.`;
  }

  async function tabIds(): Promise<number[]> {
    return tabsOf(await harness.ok(session, "tabs_list")).map(({ id }) => id);
  }

  function listed(): string[] {
    return readdirSync(harness.downloads).sort();
  }
});

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}
