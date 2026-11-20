import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_BLOCKLIST } from "../apps/extension/src/default-blocklist.ts";
import { Bridge } from "../apps/server/src/bridge.ts";
import { resolveSocketDir } from "../apps/server/src/socket-dir.ts";
import { SERVER_VERSION } from "../apps/server/src/version.ts";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  FOREIGN_SECRET,
  RECORDING_TOKEN,
  startFixtureServer,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session } from "./harness.ts";

const GONE_TIMEOUT_MS = 15_000;
const GONE_POLL_MS = 100;
// Long enough for a recorder to be injected in a page that would still be recorded.
const RECORDER_WAIT_MS = 3_000;
const ONCE = 'button[data-answer="once"]';
/** How long a saved file must stay in the download folder to count as kept. */
const SAVE_WAIT_MS = 1500;

// One Firefox for the file; a live session probes the tabs of the sessions that end.
describe("session end in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let live: Session;
  // Connections that name a session id the test chooses; closed before the harness.
  const bridges: Bridge[] = [];

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      live = await harness.connect();
      await harness.waitUntilReady(live);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        for (const bridge of bridges) bridge.close();
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("closes a group of only blank tabs when its session ends", async () => {
    const session = await harness.connect();
    const tabId = tabIdOf(await harness.ok(session, "tab_open"));
    await session.close();
    await waitUntilGone(tabId);
  });

  test("keeps a group with a page when its session ends", async () => {
    const session = await harness.connect();
    const page = tabIdOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    const blank = tabIdOf(await harness.ok(session, "tab_open"));
    await session.close();
    await waitUntilDecided();

    for (const tabId of [page, blank]) {
      const text = await harness.refused(live, "navigate", { tabId, action: "reload" });
      assert.ok(text.includes("is not in this session's tab group"), text);
    }
  });

  test("records nothing in the tabs of a session that has ended", async () => {
    const id = randomUUID();
    const first = connectAs(id);
    const tabId = tabIdOf(await first.call("tab_open", { url: fixtures.url("/recording-form") }));
    await pollUntil(
      async () => ((await readConsole(first, tabId)).recording ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the page to be recorded while its session runs",
    );
    first.close();
    await waitUntilDecided();

    // The user loads a new page of the same site in the ended session's tab.
    const shown = (await firefox.contexts()).find(
      (context) => context.url === fixtures.url("/recording-form"),
    );
    assert.ok(shown !== undefined, "no tab shows the recording form");
    const page = shown.context;
    await firefox.navigate(page, fixtures.url("/recording-form?after-end"));
    await sleep(RECORDER_WAIT_MS);
    assert.equal(await firefox.evaluate(page, 'Object.hasOwn(window, "__foxleashConsole")'), false);
    assert.equal(
      await firefox.evaluate(page, 'console.log.toString().includes("[native code]")'),
      true,
    );
    const fetches = fixtures.hits("/api/fetch");
    await firefox.click(page, "#log");
    await firefox.click(page, "#fetch");
    await pollUntil(
      async () => (fixtures.hits("/api/fetch") > fetches ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the gap's fetch to reach the server",
    );

    // The same session comes back: its recording starts empty.
    const again = connectAs(id);
    const gapConsole = await pollUntil(
      async () => {
        const read = await readConsole(again, tabId);
        return read.recording ? read : undefined;
      },
      PAGE_TIMEOUT_MS,
      "the console recording to start again",
    );
    assert.equal(gapConsole.messages.includes(message(1)), false, JSON.stringify(gapConsole));
    const gapNetwork = await pollUntil(
      async () => {
        const read = await readNetwork(again, tabId);
        return read.recording ? read : undefined;
      },
      PAGE_TIMEOUT_MS,
      "the network recording to start again",
    );
    assert.equal(gapNetwork.urls.includes(request(1)), false, JSON.stringify(gapNetwork));
    assert.equal(gapNetwork.bodies, 0, JSON.stringify(gapNetwork));

    await firefox.click(page, "#log");
    await firefox.click(page, "#fetch");
    const messages = await pollUntil(
      async () => {
        const read = await readConsole(again, tabId);
        return read.messages.includes(message(2)) ? read.messages : undefined;
      },
      PAGE_TIMEOUT_MS,
      "the message logged after the session came back",
    );
    const requests = await pollUntil(
      async () => {
        const read = await readNetwork(again, tabId);
        const fetched = read.urls.filter((url) => url.startsWith(fixtures.url("/api/fetch")));
        return fetched.includes(request(2)) ? fetched : undefined;
      },
      PAGE_TIMEOUT_MS,
      "the request made after the session came back",
    );
    assert.deepEqual(messages, [message(2)]);
    assert.deepEqual(requests, [request(2)]);
    again.close();
  });

  test("keeps your Blob files from a site allowed for an ended session only, and loads that site's files in its left-over tab", {
    timeout: 120_000,
  }, async () => {
    // The same server under another site, not allowed always.
    const other = `http://localhost:${fixtures.port}`;
    const shownUrl = `${other}/foreign/login?session-only`;
    const session = await harness.connect();
    const existing = await promptContexts();
    // Its cookie lets the export below answer with the file.
    const opening = settled(harness.ok(session, "tab_open", { url: shownUrl }));
    const prompt = await harness.promptContext(existing);
    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ONCE);
    await opening;
    await session.close();
    await waitUntilDecided();
    const shown = (await firefox.contexts()).find((context) => context.url === shownUrl);
    assert.ok(shown !== undefined, `no tab shows ${shownUrl}`);
    const leftOver = shown.context;
    const saved: string[] = [];

    // Each outcome is recorded, so a failure shows every step's.
    const outcomes: Record<string, string> = {};
    let own: string | undefined;
    outcomes.own = await keptFile(async () => {
      own = await firefox.openContext(`${other}/foreign/built?own`);
      await builtAndSaved(own);
    });
    if (own !== undefined) await firefox.closeContext(own);
    outcomes.leftOver = await keptFile(async () => {
      await firefox.navigate(leftOver, `${other}/foreign/built?left-over`);
      await builtAndSaved(leftOver);
    });
    outcomes.loaded = await keptFile(loadExport);
    // The tab is still guarded: once on the blocklist, that site's file is stopped there.
    await harness.seedSettings({ blocklist: ["localhost"] });
    try {
      outcomes.blocked = await keptFile(loadExport);
    } finally {
      await harness.seedSettings({ blocklist: [...DEFAULT_BLOCKLIST] });
    }
    for (const name of saved) rmSync(join(harness.downloads, name), { force: true });
    assert.deepEqual(outcomes, {
      own: "kept",
      leftOver: "kept",
      loaded: "kept",
      blocked: "not saved",
    });

    /** Loads the other site's export in the left-over tab, as a link there would. */
    async function loadExport(): Promise<void> {
      const hits = fixtures.hits("/foreign/export.csv");
      const url = JSON.stringify(`${other}/foreign/export.csv`);
      await firefox.evaluate(leftOver, `location.href = ${url}; true`);
      await pollUntil(
        async () => (fixtures.hits("/foreign/export.csv") > hits ? true : undefined),
        PAGE_TIMEOUT_MS,
        "a request for the export",
      );
    }

    /**
     * Runs `step` and waits for the new file it saves: "kept" when it is still in the download
     * folder SAVE_WAIT_MS later, else what happened.
     */
    async function keptFile(step: () => Promise<void>): Promise<string> {
      const before = listed();
      try {
        await step();
      } catch (error) {
        return `failed: ${String(error)}`;
      }
      const name = await pollUntil(
        async () => {
          const names = listed();
          // Firefox reserves the name with an empty file before it writes the .part one.
          if (names.some((entry) => entry.endsWith(".part"))) return undefined;
          return names.find(
            (entry) =>
              !before.includes(entry) &&
              readFileSync(join(harness.downloads, entry), "utf8") === FOREIGN_SECRET,
          );
        },
        PAGE_TIMEOUT_MS,
        "the file in the download folder",
      ).catch(() => undefined);
      if (name === undefined) return "not saved";
      saved.push(name);
      await sleep(SAVE_WAIT_MS);
      return listed().includes(name) ? "kept" : "removed";
    }
  });

  /** Waits until the page built its file and asked Firefox to save it. */
  async function builtAndSaved(context: string): Promise<void> {
    await pollUntil(
      async () => ((await firefox.evaluate(context, "window.saved === true")) ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the page to save the file it built",
    );
  }

  function listed(): string[] {
    return readdirSync(harness.downloads).sort();
  }

  async function promptContexts(): Promise<string[]> {
    const prefix = firefox.extensionUrl("approve.html");
    return (await firefox.contexts())
      .filter((tab) => tab.url.startsWith(prefix))
      .map(({ context }) => context);
  }

  /** A connection whose requests name `session`, as an MCP server that kept its id would. */
  function connectAs(session: string): Bridge {
    const uid = process.getuid?.() ?? 0;
    const bridge = new Bridge({
      socketDir: resolveSocketDir(harness.env, uid).dir,
      uid,
      version: SERVER_VERSION,
      session,
      log: () => {},
    });
    bridges.push(bridge);
    return bridge;
  }

  /** The message the recording form logs at its `number`th Log click. */
  function message(number: number): string {
    return `${RECORDING_TOKEN}-${number}`;
  }

  /** The request the recording form makes at its `number`th Fetch click. */
  function request(number: number): string {
    return `${fixtures.url("/api/fetch")}?n=${number}`;
  }

  // The extension decides session ends one at a time, in the order the sessions closed, so once
  // a later session's blank tab is gone every earlier end has been decided.
  async function waitUntilDecided(): Promise<void> {
    const later = await harness.connect();
    const marker = tabIdOf(await harness.ok(later, "tab_open"));
    await later.close();
    await waitUntilGone(marker);
  }

  async function waitUntilGone(tabId: number): Promise<void> {
    const deadline = Date.now() + GONE_TIMEOUT_MS;
    for (;;) {
      const text = await harness.refused(live, "navigate", { tabId, action: "reload" });
      if (text.includes("does not exist")) return;
      assert.ok(Date.now() < deadline, `tab ${tabId} still open; last refusal: ${text}`);
      await sleep(GONE_POLL_MS);
    }
  }
});

interface ConsoleRead {
  recording: boolean;
  /** The texts of the messages. */
  messages: string[];
}

interface NetworkRead {
  recording: boolean;
  urls: string[];
  /** How many requests carry a captured response body. */
  bodies: number;
}

async function readConsole(bridge: Bridge, tabId: number): Promise<ConsoleRead> {
  const read = await bridge.call("read_console", { tabId });
  assert.ok(
    isRecord(read) && typeof read.recording === "boolean" && Array.isArray(read.messages),
    `expected a console read, got ${JSON.stringify(read)}`,
  );
  const messages: unknown[] = read.messages;
  return {
    recording: read.recording,
    messages: messages.map((entry) => String(isRecord(entry) ? entry.text : entry)),
  };
}

async function readNetwork(bridge: Bridge, tabId: number): Promise<NetworkRead> {
  const read = await bridge.call("read_network", { tabId, responseBody: true });
  assert.ok(
    isRecord(read) && typeof read.recording === "boolean" && Array.isArray(read.requests),
    `expected a network read, got ${JSON.stringify(read)}`,
  );
  const requests: unknown[] = read.requests;
  return {
    recording: read.recording,
    urls: requests.map((entry) => String(isRecord(entry) ? entry.url : entry)),
    bodies: requests.filter((entry) => isRecord(entry) && entry.responseBody !== undefined).length,
  };
}

/** The call, with its rejection handled, so it can be awaited later. */
function settled<T>(call: Promise<T>): Promise<T> {
  call.catch(() => undefined);
  return call;
}

function tabIdOf(value: unknown): number {
  assert.ok(
    isRecord(value) && isRecord(value.tab) && typeof value.tab.id === "number",
    `expected { tab: { id } }, got ${JSON.stringify(value)}`,
  );
  return value.tab.id;
}
