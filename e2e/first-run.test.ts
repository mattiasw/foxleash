import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NODE_REQUIREMENT, SETUP_COMMAND } from "@foxleash/protocol";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { createHarness, EXTENSION_DIST, type Harness } from "./harness.ts";

// Above the extension's 10 s reconnect backoff plus the host's start.
const CONNECT_TIMEOUT_MS = 30_000;

// How each state's sentence begins. The checking and missing sentences also contain
// "is connected", so a page is matched on the start of its sentence.
const MISSING = "The Foxleash program is not found";
const CONNECTED = "The Foxleash program is connected.";

// What a page shows about the Foxleash program, and whether the mark set at the start is still
// there, so a reload would show.
const PROGRAM_STATE = `JSON.stringify({
  status: document.getElementById("program-status").textContent,
  setupHidden: document.getElementById("program-setup").hidden,
  command: document.getElementById("program-command").textContent,
  requirement: document.getElementById("program-requirement").textContent,
  marked: window.firstRunMark === true,
})`;

interface ProgramState {
  status: string;
  setupHidden: boolean;
  command: string;
  requirement: string;
  marked: boolean;
}

describe("the first-run page, in real Firefox", () => {
  let harness: Harness;
  let firefox: Firefox;

  before(
    async () => {
      harness = createHarness();
      // No install: the program is not on this computer yet.
      firefox = await harness.startFirefox(EXTENSION_DIST, { keepWelcome: true });
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      await harness?.close();
    },
    { timeout: 60_000 },
  );

  test("an install shows the program as missing, then connected", {
    timeout: 120_000,
  }, async () => {
    const welcome = await harness.pageContext("welcome.html");
    await firefox.evaluate(welcome, "window.firstRunMark = true");
    assertMissing(await waitForStatus(welcome, MISSING, PAGE_TIMEOUT_MS));

    // A new selected tab: the welcome page is now in the background.
    const settings = await harness.settingsPage();
    await firefox.evaluate(settings, "window.firstRunMark = true");
    assertMissing(await waitForStatus(settings, MISSING, PAGE_TIMEOUT_MS));

    harness.install();
    assertConnected(await waitForStatus(settings, CONNECTED, CONNECT_TIMEOUT_MS));
    await harness.waitForHost();

    // A background tab's document is hidden and does not ask; showing it asks at once.
    await firefox.activate(welcome);
    assertConnected(await waitForStatus(welcome, CONNECTED, PAGE_TIMEOUT_MS));
  });

  async function waitForStatus(context: string, start: string, ms: number): Promise<ProgramState> {
    return pollUntil(
      async () => {
        const state = await readState(context);
        if (state.status.startsWith(start)) return state;
        throw new Error(`the page says ${JSON.stringify(state.status)}`);
      },
      ms,
      `the page to say ${JSON.stringify(start)}`,
    );
  }

  async function readState(context: string): Promise<ProgramState> {
    const raw = await firefox.evaluate(context, PROGRAM_STATE);
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      !isRecord(value) ||
      typeof value.status !== "string" ||
      typeof value.setupHidden !== "boolean" ||
      typeof value.command !== "string" ||
      typeof value.requirement !== "string" ||
      typeof value.marked !== "boolean"
    ) {
      throw new Error(`the page's program state is ${String(raw)}`);
    }
    return {
      status: value.status,
      setupHidden: value.setupHidden,
      command: value.command,
      requirement: value.requirement,
      marked: value.marked,
    };
  }
});

function assertMissing(state: ProgramState): void {
  assert.equal(state.command, SETUP_COMMAND);
  assert.equal(state.requirement, NODE_REQUIREMENT);
  assert.equal(state.setupHidden, false);
}

function assertConnected(state: ProgramState): void {
  assert.equal(state.marked, true, "the page was reloaded");
  assert.equal(state.setupHidden, true);
}
