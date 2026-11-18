import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  FOREIGN_LATE_MS,
  FOREIGN_SECRET,
  startFixtureServer,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness } from "./harness.ts";

/** The other site's export that needs no cookie and answers FOREIGN_LATE_MS after its request. */
const LATE = "/foreign/late.csv";
/**
 * How long Firefox gets to save a file after the other site answered, before a test takes the
 * download folder to be as it stays.
 */
const SAVE_WAIT_MS = 1500;

// One Firefox for the file: the restart test takes the tab the reload test left in the group.
describe("a tab left in an agent's tab group after a reload or a restart, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  /** The same server under another site. */
  let other = "";
  /** The page of the approved site that the session left open in its group. */
  let left = "";
  let groupId = -1;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      other = `http://localhost:${fixtures.port}`;
      left = fixtures.url("/foreign/links?left");
      firefox = await harness.startFirefox(EXTENSION_DIST, { restoreSession: true });
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      // The folder Firefox saves in is an upload folder, as ~/Downloads is by default.
      const session = await harness.connect({ FOXLEASH_UPLOAD_DIRS: harness.downloads });
      try {
        await harness.waitUntilReady(session);
        await harness.ok(session, "tab_open", { url: left });
        groupId = await groupOfLeft();
        assert.notEqual(groupId, -1, "the session's tab is in no group");
      } finally {
        // Ended before the reload, so no tool call adds the guard's listener afterwards.
        await session.close();
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

  test("after an add-on reload, a tab left in the old group still saves nothing of the other site's file, and a tab outside every group still saves it", {
    timeout: 120_000,
  }, async () => {
    await harness.reloadExtension();
    assert.equal(await groupOfLeft(), groupId);
    await assertCovered();
  });

  test("after a Firefox restart, a tab left in the old group still saves nothing of the other site's file, and a tab outside every group still saves it", {
    timeout: 180_000,
  }, async () => {
    // Firefox restores the selected tab loaded.
    await firefox.activate(await contextOf(left));
    firefox = await harness.restartFirefox(EXTENSION_DIST, { restoreSession: true });
    assert.equal(await groupOfLeft(), groupId);
    await assertCovered();
  });

  /**
   * A frame the left tab's page adds, and then the tab itself, load the other site's export and
   * save nothing; the same export loaded in a tab outside every group is saved.
   */
  async function assertCovered(): Promise<void> {
    const context = await contextOf(left);
    const url = JSON.stringify(`${other}${LATE}`);

    let files = listed();
    let hits = fixtures.hits(LATE);
    await firefox.evaluate(
      context,
      `(() => { const frame = document.createElement("iframe"); frame.id = "late"; frame.src = ${url}; document.body.append(frame); return true; })()`,
    );
    await answeredAndSettled(hits);
    assert.deepEqual(listed(), files, "the frame's file was saved");
    await firefox.evaluate(context, 'document.getElementById("late").remove(); true');

    files = listed();
    hits = fixtures.hits(LATE);
    await firefox.evaluate(context, `location.href = ${url}; true`);
    await answeredAndSettled(hits);
    assert.deepEqual(listed(), files, "the tab's file was saved");

    const own = await firefox.openContext(fixtures.url("/foreign/links?own"));
    const before = listed();
    await firefox.evaluate(own, `location.href = ${url}; true`);
    const saved = await pollUntil(
      async () => {
        const names = listed();
        if (names.some((name) => name.endsWith(".part"))) return undefined;
        const name = names.find((entry) => !before.includes(entry));
        // Firefox reserves the name with an empty file before it writes the .part one.
        if (name === undefined) return undefined;
        return readFileSync(join(harness.downloads, name), "utf8") === FOREIGN_SECRET
          ? name
          : undefined;
      },
      FOREIGN_LATE_MS + PAGE_TIMEOUT_MS,
      "the export in the download folder",
    );
    assert.match(saved, /^late.*\.csv$/);
    rmSync(join(harness.downloads, saved));
    await firefox.closeContext(own);
  }

  /** Waits for a request for the export since `hits`, its held answer, and the time to save it. */
  async function answeredAndSettled(hits: number): Promise<void> {
    await pollUntil(
      async () => (fixtures.hits(LATE) > hits ? true : undefined),
      PAGE_TIMEOUT_MS,
      `a request for ${LATE}`,
    );
    await sleep(FOREIGN_LATE_MS + SAVE_WAIT_MS);
  }

  /** The group of the left tab, as the extension sees it from its settings page. */
  async function groupOfLeft(): Promise<number> {
    const settings = await harness.settingsPage();
    try {
      const json = await firefox.evaluate(
        settings,
        "browser.tabs.query({}).then((tabs) => JSON.stringify(tabs.map(({ url, groupId }) => ({ url, groupId }))))",
      );
      const tabs: unknown = JSON.parse(String(json));
      assert.ok(Array.isArray(tabs), `tabs.query returned ${String(json)}`);
      const found: unknown = tabs.find((tab: unknown) => isRecord(tab) && tab.url === left);
      assert.ok(
        isRecord(found) && typeof found.groupId === "number",
        `no tab shows ${left}: ${String(json)}`,
      );
      return found.groupId;
    } finally {
      await firefox.closeContext(settings);
    }
  }

  /** The browsing context of the tab showing `url`, once there is one. */
  function contextOf(url: string): Promise<string> {
    return pollUntil(
      async () => (await firefox.contexts()).find((context) => context.url === url)?.context,
      PAGE_TIMEOUT_MS,
      `a tab showing ${url}`,
    );
  }

  function listed(): string[] {
    return readdirSync(harness.downloads).sort();
  }
});
