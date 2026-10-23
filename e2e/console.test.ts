import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConsoleMessage } from "@foxhand/protocol";
import {
  CONSOLE_LOG_POINT,
  CONSOLE_TOKENS,
  type FixtureServer,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

interface ConsoleRead {
  recording: boolean;
  messages: ConsoleMessage[];
  dropped: number;
  omitted: number;
}

const POLL_MS = 100;
const POLL_LIMIT_MS = 10_000;
const PAGE_TOKENS = [
  CONSOLE_TOKENS.debug,
  CONSOLE_TOKENS.log,
  CONSOLE_TOKENS.info,
  CONSOLE_TOKENS.warn,
  CONSOLE_TOKENS.error,
  CONSOLE_TOKENS.uncaught,
  CONSOLE_TOKENS.rejection,
];

// One Firefox for the file, as in page-text.test.ts.
describe("read_console in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let consoleTab: number;

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
      consoleTab = await open("/console", TITLES.console);
      await logWhenRecorded(consoleTab);
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

  test("records the page's console calls, uncaught error and rejection in order", async () => {
    const read = await readUntil(consoleTab, PAGE_TOKENS);
    assert.equal(read.recording, true);
    assert.equal(read.dropped, 0);
    assert.equal(read.omitted, 0);
    const found = PAGE_TOKENS.map((token) => messageWith(read.messages, token));
    assert.deepEqual(
      found.map(({ level, kind }) => [level, kind]),
      [
        ["debug", "console"],
        ["log", "console"],
        ["info", "console"],
        ["warn", "console"],
        ["error", "console"],
        ["error", "uncaught_error"],
        ["error", "unhandled_rejection"],
      ],
    );
    const indexes = found.map((message) => read.messages.indexOf(message));
    assert.deepEqual(
      indexes,
      [...indexes].sort((a, b) => a - b),
    );
    assert.equal(found[1]?.text, `${CONSOLE_TOKENS.log} {"n":1}`);
    assert.equal(found[6]?.text, `Error: ${CONSOLE_TOKENS.rejection}`);
    for (const message of found) {
      assert.ok(Number.isFinite(message.time) && message.time > 0, JSON.stringify(message));
    }
  });

  test("level error returns only errors", async () => {
    await readUntil(consoleTab, PAGE_TOKENS);
    const read = await readConsole(consoleTab, { level: "error" });
    assert.ok(
      read.messages.every((message) => message.level === "error"),
      JSON.stringify(read),
    );
    for (const token of [CONSOLE_TOKENS.error, CONSOLE_TOKENS.uncaught, CONSOLE_TOKENS.rejection]) {
      messageWith(read.messages, token);
    }
    for (const token of [CONSOLE_TOKENS.debug, CONSOLE_TOKENS.log, CONSOLE_TOKENS.warn]) {
      assert.equal(
        read.messages.some((message) => message.text.includes(token)),
        false,
        token,
      );
    }
  });

  test("a pattern returns only the messages it matches", async () => {
    await readUntil(consoleTab, PAGE_TOKENS);
    const read = await readConsole(consoleTab, { pattern: `^${CONSOLE_TOKENS.warn}$` });
    assert.deepEqual(
      read.messages.map((message) => message.text),
      [CONSOLE_TOKENS.warn],
    );
    assert.equal(read.omitted, 0);
  });

  test("limit returns the newest messages and counts the rest", async () => {
    const all = await readUntil(consoleTab, PAGE_TOKENS);
    const read = await readConsole(consoleTab, { limit: 2 });
    assert.deepEqual(read.messages, all.messages.slice(-2));
    assert.equal(read.omitted, all.messages.length - 2);
  });

  test("records a page whose policy forbids inline script without its nonce", async () => {
    const tab = await open("/console-csp", TITLES.consoleCsp);
    await logWhenRecorded(tab);
    const read = await readUntil(tab, [CONSOLE_TOKENS.csp]);
    assert.equal(messageWith(read.messages, CONSOLE_TOKENS.csp).level, "log");
  });

  test("records what a page logs while it loads", async () => {
    const tokens = [CONSOLE_TOKENS.loadParse, CONSOLE_TOKENS.loadReady, CONSOLE_TOKENS.loadDone];
    const tab = await open("/console-load", TITLES.consoleLoad);
    const read = await readUntil(tab, tokens);
    assert.equal(read.recording, true);
    const found = tokens.map((token) => messageWith(read.messages, token));
    assert.deepEqual(
      found.map(({ level, kind }) => [level, kind]),
      [
        ["log", "console"],
        ["log", "console"],
        ["log", "console"],
      ],
    );
    const indexes = found.map((message) => read.messages.indexOf(message));
    assert.deepEqual(
      indexes,
      [...indexes].sort((a, b) => a - b),
    );
  });

  test("a new page in the tab starts with no messages", async () => {
    const tab = await open("/console", TITLES.console);
    await logWhenRecorded(tab);
    await readUntil(tab, PAGE_TOKENS);
    await harness.ok(session, "navigate", { tabId: tab, url: fixtures.url("/a") });
    const read = await readUntilRecording(tab);
    for (const token of PAGE_TOKENS) {
      assert.equal(
        read.messages.some((message) => message.text.includes(token)),
        false,
        JSON.stringify(read),
      );
    }
  });

  test("a blank tab is refused as not a web page", async () => {
    const blank = tabOf(await harness.ok(session, "tab_open")).id;
    const text = await harness.refused(session, "read_console", { tabId: blank });
    assert.ok(text.includes("Foxhand acts only on http and https pages"), text);
  });

  async function open(path: string, title: string): Promise<number> {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url(path) }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    return tab.id;
  }

  /**
   * Clicks the page's Log button once Foxhand records the page, so a pass does not depend on how
   * soon the recorder lands, and console calls missing after it mean its wrappers do not work.
   */
  async function logWhenRecorded(tabId: number): Promise<void> {
    await readUntilRecording(tabId);
    await harness.ok(session, "click", { tabId, ...CONSOLE_LOG_POINT });
  }

  async function readConsole(tabId: number, args: Record<string, unknown> = {}) {
    return consoleReadOf(await harness.ok(session, "read_console", { tabId, ...args }));
  }

  /** Reads until every token is in a message, for at most POLL_LIMIT_MS. */
  async function readUntil(tabId: number, tokens: readonly string[]): Promise<ConsoleRead> {
    const deadline = Date.now() + POLL_LIMIT_MS;
    for (;;) {
      const read = await readConsole(tabId);
      const texts = read.messages.map((message) => message.text);
      if (tokens.every((token) => texts.some((text) => text.includes(token)))) return read;
      if (Date.now() > deadline) assert.fail(`not every token was logged: ${JSON.stringify(read)}`);
      await sleep(POLL_MS);
    }
  }

  async function readUntilRecording(tabId: number): Promise<ConsoleRead> {
    const deadline = Date.now() + POLL_LIMIT_MS;
    for (;;) {
      const read = await readConsole(tabId);
      if (read.recording) return read;
      if (Date.now() > deadline) assert.fail(`the page is not recorded: ${JSON.stringify(read)}`);
      await sleep(POLL_MS);
    }
  }
});

function messageWith(messages: readonly ConsoleMessage[], token: string): ConsoleMessage {
  const found = messages.filter((message) => message.text.includes(token));
  assert.equal(found.length, 1, `${token} in ${JSON.stringify(messages)}`);
  return found[0] as ConsoleMessage;
}

function consoleReadOf(value: unknown): ConsoleRead {
  assert.ok(typeof value === "object" && value !== null, JSON.stringify(value));
  const { recording, messages, dropped, omitted } = Object.fromEntries(Object.entries(value));
  assert.ok(
    typeof recording === "boolean" &&
      Array.isArray(messages) &&
      typeof dropped === "number" &&
      typeof omitted === "number",
    JSON.stringify(value),
  );
  return { recording, messages, dropped, omitted };
}
