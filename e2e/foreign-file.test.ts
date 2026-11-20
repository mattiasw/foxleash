import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, describe, type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
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
/** The answers of the other site's service worker: passed on to the network, and built by it. */
const WORKER_ANSWERS = [
  ["passed on", "sw/export.csv"],
  ["built", "sw/built.csv"],
] as const;
/** What the server is asked for when the worker passes a load of the export on. */
const WORKER_EXPORT = "/foreign/sw/export.csv";
/** How many upload_file calls the retry test makes, and over how long at least. */
const RETRY_UPLOADS = 50;
const RETRY_MS = 60_000;
/** The reason upload_file gives for a file saved or changed a moment ago. */
const FRESH_REASON = "was saved or changed a moment ago";
/** How long a failure message waits for each read of what a tab or frame shows. */
const DIAGNOSTIC_READ_MS = 5_000;
/**
 * A page's own address and load state, its fixture flags, and when its document became
 * interactive and its load event started, in ms since the epoch (null when not yet).
 */
const PAGE_STATE = `(() => {
  const navigation = performance.getEntriesByType("navigation")[0];
  const at = (moment) => (moment ? Math.round(performance.timeOrigin + moment) : null);
  return JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    saved: window.saved === true,
    removed: window.removed === true,
    interactiveAt: at(navigation?.domInteractive),
    loadAt: at(navigation?.loadEventStart),
  });
})()`;

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
      // The other site has a service worker, which answers loads below /foreign/sw/.
      const setup = await firefox.openContext(`${other}/foreign/worker-setup`);
      await pollUntil(
        async () =>
          (await firefox.evaluate(setup, "document.title")) === TITLES.foreignWorkerReady
            ? true
            : undefined,
        PAGE_TIMEOUT_MS,
        "the other site's service worker to be active",
      );
      await firefox.closeContext(setup);
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
        const saved = await newFile(before, "data");
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

    for (const [answer, to] of WORKER_ANSWERS) {
      test(`a page that moves on to a file its service worker ${answer} saves nothing`, async (t) => {
        const watch = watchFolder(t);
        const files = listed();
        const hits = fixtures.hits(WORKER_EXPORT);
        const url = fixtures.url(`/foreign/script?to=${to}`);
        const tab = tabOf(await harness.ok(session, "tab_open", { url }));
        const found = (await firefox.contexts()).find((context) => context.url === url);
        assert.ok(found !== undefined, `no tab shows ${url}`);
        await pollUntil(
          async () =>
            (await firefox.evaluate(found.context, "window.moved === true")) === true
              ? true
              : undefined,
          PAGE_TIMEOUT_MS,
          "the page to move on",
        );
        // The built answer never reaches the server.
        if (to === "sw/export.csv") await answered(WORKER_EXPORT, hits);
        await assertNothingSaved(files, false);
        report(t, watch.stop());
        await harness.ok(session, "tab_close", { tabId: tab.id });
      });

      test(`a click on a link to a file the service worker ${answer} saves nothing`, async (t) => {
        const watch = watchFolder(t);
        const page = await openLinks();
        const files = listed();
        const hits = fixtures.hits(WORKER_EXPORT);
        const line = to === "sw/built.csv" ? 'link "Worker built export"' : 'link "Worker export"';
        const result = await click(page, line);
        if (to === "sw/export.csv") await answered(WORKER_EXPORT, hits);
        await assertNothingSaved(files, false);
        assertRefusedOrMissed(result);
        report(t, watch.stop());
        await assertNothingToUpload(page);
        await close(page);
      });

      test(`navigate to a file the service worker ${answer} fails at once and saves nothing`, async (t) => {
        const watch = watchFolder(t);
        const page = await openLinks();
        const files = listed();
        const hits = fixtures.hits(WORKER_EXPORT);
        const started = Date.now();
        const text = await harness.refused(session, "navigate", {
          tabId: page.tabId,
          url: fixtures.url(`/foreign/go/${to}`),
        });
        const elapsed = Date.now() - started;
        const message = untrustedContent(text);
        if (to === "sw/export.csv") await answered(WORKER_EXPORT, hits);
        await assertNothingSaved(files, message === refusal(page.tabId));
        assert.equal(message, refusal(page.tabId));
        assert.ok(elapsed < 10_000, `navigate took ${elapsed} ms`);
        report(t, watch.stop());
        await close(page);
      });

      test(`a click that opens a tab on a file the service worker ${answer} saves nothing`, async (t) => {
        await firefox.allowPopups(fixtures.site);
        try {
          const watch = watchFolder(t);
          const page = await openLinks();
          const files = listed();
          const hits = fixtures.hits(WORKER_EXPORT);
          const line =
            to === "sw/built.csv"
              ? 'link "Worker built export in a new tab"'
              : 'link "Worker export in a new tab"';
          const result = await click(page, line);
          if (to === "sw/export.csv") await answered(WORKER_EXPORT, hits);
          await assertNothingSaved(files, false);
          // Recorded for the tab the link opened, which Firefox may close before the act lists it.
          assertRefusedOrMissed(result);
          report(t, watch.stop());
          // Firefox closes a tab whose load became a download, but may not have yet.
          const { openedTabs = [] } = result;
          assert.ok(Array.isArray(openedTabs), JSON.stringify(result));
          for (const tabId of openedTabs) await harness.call(session, "tab_close", { tabId });
          await close(page);
        } finally {
          await firefox.resetPopups(fixtures.site);
        }
      });
    }

    for (const [answer, to] of [
      ["passed on", "sw/public.csv"],
      ["built", "sw/built.csv"],
    ] as const) {
      test(`a frame on a file the service worker ${answer} saves nothing`, async (t) => {
        const watch = watchFolder(t);
        const files = listed();
        const hits = fixtures.hits("/foreign/sw/public.csv");
        const url = fixtures.url(`/foreign/worker-frame?to=${to}`);
        const tab = tabOf(await harness.ok(session, "tab_open", { url }));
        const found = (await firefox.contexts()).find((context) => context.url === url);
        assert.ok(found !== undefined, `no tab shows ${url}`);
        await pollUntil(
          async () =>
            (await firefox.evaluate(found.context, "window.framed === true")) === true
              ? true
              : undefined,
          PAGE_TIMEOUT_MS,
          "the page to add the frame",
        );
        if (to === "sw/public.csv") await answered("/foreign/sw/public.csv", hits);
        await assertNothingSaved(files, false);
        report(t, watch.stop());
        await harness.ok(session, "tab_close", { tabId: tab.id });
      });
    }

    test("a page of the other site that builds a file itself after a redirect saves nothing", async (t) => {
      const watch = watchFolder(t);
      const page = await openLinks();
      const files = listed();
      const result = await harness.call(session, "navigate", {
        tabId: page.tabId,
        url: fixtures.url("/foreign/go/built"),
      });
      // The file can be cancelled before navigate returns, which then fails.
      if (result.isError) assert.equal(untrustedContent(result.text), refusal(page.tabId));
      await savedIn(`${other}/foreign/built`, "window.saved === true");
      await assertNothingSaved(files, false);
      report(t, watch.stop());
      await close(page);
    });

    for (const [name, query, saved] of [
      [
        "a frame on a page of the other site that builds a file itself saves nothing, and tab_open of the framing page succeeds",
        "",
        "window.saved === true",
      ],
      [
        "a frame on a page of the other site that builds a file itself, removed right after its load, saves nothing",
        "?remove=1",
        "window.saved === true && window.removed === true",
      ],
      [
        "a sandboxed frame on a page of the other site that builds a file itself saves nothing",
        "?sandbox=1",
        "window.saved === true",
      ],
    ] as const) {
      test(name, async (t) => {
        const watch = watchFolder(t);
        const files = listed();
        const url = fixtures.url(`/foreign/built-frame${query}`);
        const tab = tabOf(await harness.ok(session, "tab_open", { url }));
        await savedIn(url, saved);
        await assertNothingSaved(files, false);
        report(t, watch.stop());
        await harness.ok(session, "tab_close", { tabId: tab.id });
      });
    }

    test("a page that keeps 300 loads waiting on the service worker, then loads a file it builds, saves nothing", async (t) => {
      const watch = watchFolder(t);
      const files = listed();
      const url = fixtures.url("/foreign/worker-flood");
      const tab = tabOf(await harness.ok(session, "tab_open", { url }));
      // Whatever happens from here on, the tab closes before the next test, so that the frame it
      // adds on the other site's file cannot load in a later one, where that site is approved.
      t.after(async () => {
        await harness.ok(session, "tab_close", { tabId: tab.id });
        // Its flood mark ends HOP_GRACE_MS later, before a later test's download.
        await sleep(SAVE_WAIT_MS * 2);
      });
      const found = (await firefox.contexts()).find((context) => context.url === url);
      assert.ok(found !== undefined, `no tab shows ${url}`);
      try {
        await pollUntil(
          async () =>
            (await firefox.evaluate(found.context, "document.title")) ===
            TITLES.foreignWorkerFlooded
              ? true
              : undefined,
          PAGE_TIMEOUT_MS,
          "the page to load the file",
        );
      } catch (error: unknown) {
        throw new Error(`${messageOf(error)}; ${await pageStates(found.context)}`, {
          cause: error,
        });
      }
      await assertNothingSaved(files, false);
      report(t, watch.stop());
    });

    test("a page that loads a file the service worker builds again and again gets none of it uploaded", {
      timeout: 150_000,
    }, async (t) => {
      const watch = watchFolder(t);
      const files = listed();
      const url = fixtures.url("/foreign/worker-retry?to=sw/built.csv");
      const tab = tabOf(await harness.ok(session, "tab_open", { url }));
      // Whatever happens from here on, the page stops and its tab closes before the next test, so
      // that none of its files reach a later one.
      t.after(async () => {
        try {
          const shown = (await firefox.contexts()).find((context) => context.url === url);
          if (shown !== undefined) await firefox.evaluate(shown.context, "window.done = true");
        } finally {
          await harness.ok(session, "tab_close", { tabId: tab.id });
          // A file already on its way when the tab closed is gone before the next test lists the
          // folder.
          await sleep(SAVE_WAIT_MS);
        }
      });
      const found = (await firefox.contexts()).find((context) => context.url === url);
      assert.ok(found !== undefined, `no tab shows ${url}`);
      const read = await harness.call(session, "read_page", { tabId: tab.id });
      assert.equal(read.isError, false, read.text);
      const ref = refOf(untrustedContent(read.text) ?? "", 'button "Statement"');
      // The page starts moving on only now: read_page refuses a tab that is still loading a page.
      await firefox.evaluate(found.context, "window.go = true");
      const started = Date.now();
      let foundFiles = 0;
      let freshFiles = 0;
      for (let call = 0; call < RETRY_UPLOADS; call += 1) {
        await sleep(Math.max(0, started + ((call + 1) * RETRY_MS) / RETRY_UPLOADS - Date.now()));
        const saved = listed().filter(
          (name) => /^built.*\.csv$/.test(name) && !name.endsWith(".part"),
        );
        if (saved.length > 0) foundFiles += 1;
        const paths = (saved.length > 0 ? saved : ["built.csv"]).map((name) =>
          join(harness.downloads, name),
        );
        const text = await harness.refused(session, "upload_file", {
          tabId: tab.id,
          ref,
          paths,
          view: false,
        });
        // Gone before it was opened, removed while it was read, or refused for its age.
        assert.ok(
          ["does not exist.", "changed while Foxleash read it", FRESH_REASON].some((reason) =>
            text.includes(reason),
          ),
          text,
        );
        if (text.includes(FRESH_REASON)) freshFiles += 1;
        // The page received no file at all.
        assert.equal(
          await firefox.evaluate(found.context, "JSON.stringify(window.received)"),
          "[]",
        );
      }
      await firefox.evaluate(found.context, "window.done = true");
      assert.ok(Date.now() - started >= RETRY_MS, "the calls were spread over too short a time");
      await assertNothingSaved(files, false);
      t.diagnostic(
        `upload_file calls that found a file: ${foundFiles} of ${RETRY_UPLOADS}, ` +
          `refused for its age: ${freshFiles}`,
      );
      report(t, watch.stop());
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

    threeWays({ blocklisted: true });
  });

  describe("while the other site is approved", () => {
    before(
      async () => {
        await harness.seedSettings({
          [`site:${other}`]: { grantedAt: new Date().toISOString() },
          blocklist: [],
        });
      },
      { timeout: 60_000 },
    );

    test("a page that moves on to a file the service worker builds still saves it", async () => {
      const before = listed();
      const url = fixtures.url("/foreign/script?to=sw/built.csv");
      const tab = tabOf(await harness.ok(session, "tab_open", { url }));
      const saved = await newFile(before, FOREIGN_SECRET);
      // The folder's last check expects only the approved site's own file.
      rmSync(join(harness.downloads, saved));
      await harness.ok(session, "tab_close", { tabId: tab.id });
    });

    test("a page of the other site that builds a file itself after a redirect still saves it", async () => {
      const page = await openLinks();
      const before = listed();
      await harness.ok(session, "navigate", {
        tabId: page.tabId,
        url: fixtures.url("/foreign/go/built"),
      });
      const saved = await newFile(before, FOREIGN_SECRET);
      rmSync(join(harness.downloads, saved));
      await close(page);
    });

    for (const [how, query] of [
      ["", ""],
      [", also when the page removes the frame right after its load", "?remove=1"],
      [", also when the frame is sandboxed", "?sandbox=1"],
    ] as const) {
      test(`a frame on the other site's page that builds a file itself still saves it${how}`, async () => {
        const before = listed();
        const since = Date.now();
        const url = fixtures.url(`/foreign/built-frame${query}`);
        const tab = tabOf(await harness.ok(session, "tab_open", { url }));
        const saved = await fileFrom(url, before, since);
        rmSync(join(harness.downloads, saved));
        await harness.ok(session, "tab_close", { tabId: tab.id });
      });
    }
  });

  test("the download folder ends up holding only the approved site's own file", async () => {
    // A stop that Foxleash reported was checked at once, and each later test took the folder as
    // it found it: a file whose load was not stopped after all has arrived by now.
    await sleep(SAVE_WAIT_MS);
    assert.deepEqual(listed(), ["data.bin"]);
  });

  /**
   * The three ways a page of the approved site gets the other site's file loaded in its tab. With
   * `blocklisted`, navigate's redirect step to the other site is cancelled before it is sent.
   */
  function threeWays({ blocklisted = false } = {}): void {
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
      if (blocklisted) {
        assert.equal(message, blockedHop(page.tabId));
        // A redirect step Firefox sent after all would reach the server after the refusal.
        await assertNothingSaved(files, false);
        assert.equal(fixtures.hits(EXPORT), hits, "the other site was asked for its file");
      } else {
        assert.ok(fixtures.hits(EXPORT) > hits, "the other site was not asked for its file");
        await assertNothingSaved(files, message === refusal(page.tabId));
        assert.equal(message, refusal(page.tabId));
      }
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

  /**
   * The act's result lists the other site, or no site: a download Foxleash cancelled after the
   * fact can be missing from it.
   */
  function assertRefusedOrMissed(result: Record<string, unknown>): void {
    if ("refusedFiles" in result) assert.deepEqual(result.refusedFiles, [other]);
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

  /** What navigate says when it cancelled its load's redirect step to the other site. */
  function blockedHop(tab: number): string {
    return `Tab ${tab}'s load was redirected to ${other}, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`;
  }

  async function tabIds(): Promise<number[]> {
    return tabsOf(await harness.ok(session, "tabs_list")).map(({ id }) => id);
  }

  function listed(): string[] {
    return readdirSync(harness.downloads).sort();
  }

  /**
   * Waits for a new file holding the other site's secret; its name. When none arrives, the error
   * says what the download folder holds, what the tab showing `url` and its frames show, and what
   * Firefox downloaded since `since`, to tell a file the guard cancelled from one Firefox never
   * started.
   */
  async function fileFrom(url: string, before: string[], since: number): Promise<string> {
    try {
      return await newFile(before, FOREIGN_SECRET);
    } catch (error: unknown) {
      const folder = listed();
      // In parallel, so the failure stays well inside the runner's 60 s test timeout.
      const [page, downloads] = await Promise.all([pageStatesAt(url), downloadsSince(since)]);
      const held = folder.length === 0 ? "nothing" : folder.join(", ");
      throw new Error(
        `${messageOf(error)}; the download folder holds ${held}; ${page}; ${downloads}`,
        { cause: error },
      );
    }
  }

  /** Waits for a file not in `before` to be in the download folder, holding `content`; its name. */
  async function newFile(before: string[], content: string): Promise<string> {
    return pollUntil(
      async () => {
        const files = listed();
        if (files.some((name) => name.endsWith(".part"))) return undefined;
        const name = files.find((entry) => !before.includes(entry));
        // Firefox reserves the name with an empty file before it writes the .part one.
        if (name === undefined) return undefined;
        return readFileSync(join(harness.downloads, name), "utf8") === content ? name : undefined;
      },
      PAGE_TIMEOUT_MS,
      "a new file in the download folder",
    );
  }

  /** Waits until a tab shows `url` and `saved`, evaluated in its page, is true. */
  async function savedIn(url: string, saved: string): Promise<void> {
    const found = await pollUntil(
      async () => (await firefox.contexts()).find((context) => context.url === url),
      PAGE_TIMEOUT_MS,
      `a tab to show ${url}`,
    );
    try {
      await pollUntil(
        async () => ((await firefox.evaluate(found.context, saved)) === true ? true : undefined),
        PAGE_TIMEOUT_MS,
        `the page at ${url} to save its file`,
      );
    } catch (error: unknown) {
      throw new Error(`${messageOf(error)}; ${await pageStates(found.context)}`, { cause: error });
    }
  }

  /** What the tab showing `url` and its frames show, or why no such tab was found. */
  async function pageStatesAt(url: string): Promise<string> {
    try {
      const found = await pollUntil(
        async () => (await firefox.contexts()).find((context) => context.url === url),
        DIAGNOSTIC_READ_MS,
        `a tab to show ${url}`,
      );
      return await pageStates(found.context);
    } catch (error: unknown) {
      return `no tab found: ${messageOf(error)}`;
    }
  }

  /** What the tab and each of its frames show, and how often the server sent the built page. */
  async function pageStates(context: string): Promise<string> {
    const [tab, frames] = await Promise.all([stateOf(context), framesOf(context)]);
    const hits = fixtures.hits("/foreign/built");
    return `the tab: ${tab}; ${frames}; requests for /foreign/built since the server started: ${hits}`;
  }

  async function stateOf(context: string): Promise<string> {
    try {
      return await pollUntil(
        async () => {
          const state = await firefox.evaluate(context, PAGE_STATE);
          return typeof state === "string" ? state : undefined;
        },
        DIAGNOSTIC_READ_MS,
        "the page's state",
      );
    } catch (error: unknown) {
      return `not read: ${messageOf(error)}`;
    }
  }

  async function framesOf(context: string): Promise<string> {
    try {
      const frames = await pollUntil(
        () => firefox.frames(context),
        DIAGNOSTIC_READ_MS,
        "the tab's frames",
      );
      if (frames.length === 0) return "no frames";
      const states = await Promise.all(
        frames.map(async (frame) => `${frame.url} ${await stateOf(frame.context)}`),
      );
      return `frames: ${states.join(", ")}`;
    } catch (error: unknown) {
      return `frames not listed: ${messageOf(error)}`;
    }
  }

  /** The downloads Firefox started since `since`, with their state and whether the file is there. */
  async function downloadsSince(since: number): Promise<string> {
    const timer = new AbortController();
    try {
      const entries = await Promise.race([
        readDownloads(since),
        sleep(DIAGNOSTIC_READ_MS, undefined, { signal: timer.signal }).then(() => {
          throw new Error(`no answer within ${DIAGNOSTIC_READ_MS} ms`);
        }),
      ]);
      return entries.length === 0
        ? "no download since the spec began"
        : `downloads since the spec began: ${entries.join(", ")}`;
    } catch (error: unknown) {
      return `downloads not listed: ${messageOf(error)}`;
    } finally {
      timer.abort();
    }
  }

  async function readDownloads(since: number): Promise<string[]> {
    const page = await firefox.openContext(firefox.extensionUrl("options.html"));
    try {
      const json = await firefox.evaluate(
        page,
        `browser.downloads.search({ startedAfter: ${JSON.stringify(new Date(since).toISOString())} })` +
          ".then((items) => JSON.stringify(items.map((item) =>" +
          ' [item.url, item.state, item.error ?? "", item.filename])))',
      );
      const items: unknown = JSON.parse(String(json));
      assert.ok(Array.isArray(items), `downloads.search returned ${String(json)}`);
      return items.map((item: unknown) => {
        assert.ok(Array.isArray(item), `a download is ${JSON.stringify(item)}`);
        const [url, state, error, filename] = item.map(String) as [string, string, string, string];
        // Firefox's own `exists` stays true after the guard removes the file.
        const disk = existsSync(filename) ? "on disk" : "not on disk";
        return `${url} ${state}${error === "" ? "" : ` (${error})`}, ${disk} (${basename(filename)})`;
      });
    } finally {
      await firefox.closeContext(page).catch(() => undefined);
    }
  }

  /**
   * Lists the download folder every millisecond until `stop` or the end of test `t`; `stop` returns
   * the longest time a new file, or Firefox's .part file, was there, and the share of lists that
   * held one.
   */
  function watchFolder(t: TestContext): { stop(): { longestMs: number; share: number } } {
    const before = new Set(listed());
    const present = new Map<string, number>();
    let longestMs = 0;
    let lists = 0;
    let withFile = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      const names = readdirSync(harness.downloads).filter((name) => !before.has(name));
      lists += 1;
      if (names.length > 0) withFile += 1;
      for (const name of names) if (!present.has(name)) present.set(name, now);
      for (const [name, since] of present) {
        if (names.includes(name)) continue;
        longestMs = Math.max(longestMs, now - since);
        present.delete(name);
      }
    }, 1);
    // A test that fails before calling stop() must neither keep listing, also after the folder is
    // removed, nor keep the test process alive.
    t.after(() => clearInterval(timer));
    timer.unref();
    return {
      stop: () => {
        clearInterval(timer);
        const now = performance.now();
        for (const since of present.values()) longestMs = Math.max(longestMs, now - since);
        return { longestMs, share: lists === 0 ? 0 : withFile / lists };
      },
    };
  }

  function report(t: TestContext, seen: { longestMs: number; share: number }): void {
    t.diagnostic(
      `longest a file was in the download folder: ${Math.round(seen.longestMs)} ms; ` +
        `lists that held one: ${(seen.share * 100).toFixed(1)} %`,
    );
  }
});

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
