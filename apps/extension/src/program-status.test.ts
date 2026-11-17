import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  EXTENSION_UPDATE_COMMAND,
  NODE_REQUIREMENT,
  SETUP_COMMAND,
  UPDATE_COMMAND,
} from "@foxleash/protocol";
import { createFakeTimers, flush } from "./fake-browser.ts";
import { POLL_MS, SENTENCES, watchProgram } from "./program-status.ts";

const CHECKING = "Checking whether the Foxleash program is connected.";

describe("watchProgram", { timeout: 10000 }, () => {
  it("fills in the commands and the requirement, and asks at once", (t) => {
    const { elements, requests } = setup(t);
    assert.equal(elements.command.textContent, SETUP_COMMAND);
    assert.equal(elements.requirement.textContent, NODE_REQUIREMENT);
    assert.equal(elements.updateCommand.textContent, UPDATE_COMMAND);
    assert.equal(elements.addonUpdateCommand.textContent, EXTENSION_UPDATE_COMMAND);
    assert.deepEqual(
      requests.map((request) => request.message),
      [{ type: "program_state" }],
    );
  });

  it("shows the setup while the program is missing and hides it once connected", async (t) => {
    const { elements, requests, timers } = setup(t);
    await answer(requests, 0, { state: "missing" });
    assert.equal(elements.status.textContent, SENTENCES.missing);
    assert.equal(elements.setup.hidden, false);
    timers.advance(POLL_MS);
    await answer(requests, 1, { state: "connected" });
    assert.equal(elements.status.textContent, SENTENCES.connected);
    assert.equal(elements.setup.hidden, true);
  });

  for (const state of ["missing", "too_old", "addon_older"] as const) {
    it(`shows only the steps for ${state}, and none once connected`, async (t) => {
      const { elements, requests, timers } = setup(t);
      await answer(requests, 0, { state });
      assert.equal(elements.status.textContent, SENTENCES[state]);
      assert.deepEqual(visibleBlocks(elements), [state]);
      timers.advance(POLL_MS);
      await answer(requests, 1, { state: "connected" });
      assert.equal(elements.status.textContent, SENTENCES.connected);
      assert.deepEqual(visibleBlocks(elements), []);
    });
  }

  it("moves from one notice's steps to another's", async (t) => {
    const { elements, requests, timers } = setup(t);
    const states = ["too_old", "addon_older", "missing", "too_old"] as const;
    for (const [index, state] of states.entries()) {
      if (index > 0) timers.advance(POLL_MS);
      await answer(requests, index, { state });
      assert.equal(elements.status.textContent, SENTENCES[state]);
      assert.deepEqual(visibleBlocks(elements), [state]);
    }
  });

  it("keeps the checking sentence while the background is checking", async (t) => {
    const { elements, requests } = setup(t);
    await answer(requests, 0, { state: "checking" });
    assert.equal(elements.status.textContent, CHECKING);
    assert.equal(elements.setup.hidden, true);
  });

  it("keeps a shown state when a restarted background answers checking", async (t) => {
    const { elements, requests, timers } = setup(t);
    await answer(requests, 0, { state: "missing" });
    timers.advance(POLL_MS);
    await answer(requests, 1, { state: "checking" });
    assert.equal(elements.status.textContent, SENTENCES.missing);
    assert.equal(elements.setup.hidden, false);
  });

  it("writes the page only when the state changes", async (t) => {
    const { elements, requests, timers } = setup(t);
    await answer(requests, 0, { state: "missing" });
    elements.status.textContent = "unchanged";
    timers.advance(POLL_MS);
    await answer(requests, 1, { state: "missing" });
    assert.equal(elements.status.textContent, "unchanged");
  });

  it("writes nothing when a too old program stays too old across checking", async (t) => {
    const { elements, requests, timers } = setup(t);
    await answer(requests, 0, { state: "too_old" });
    elements.status.textContent = "unchanged";
    for (const [index, state] of ["checking", "too_old"].entries()) {
      timers.advance(POLL_MS);
      await answer(requests, index + 1, { state });
    }
    assert.equal(elements.status.textContent, "unchanged");
    assert.deepEqual(visibleBlocks(elements), ["too_old"]);
  });

  it("asks every second while visible, also when a request never settles", (t) => {
    const { requests, timers } = setup(t);
    timers.advance(POLL_MS - 1);
    assert.equal(requests.length, 1);
    timers.advance(1);
    assert.equal(requests.length, 2);
    timers.advance(POLL_MS * 3);
    assert.equal(requests.length, 5);
  });

  it("ignores a late reply to an older request", async (t) => {
    const { elements, requests, timers } = setup(t);
    timers.advance(POLL_MS);
    await answer(requests, 1, { state: "connected" });
    await answer(requests, 0, { state: "missing" });
    assert.equal(elements.status.textContent, SENTENCES.connected);
    assert.equal(elements.setup.hidden, true);
  });

  it("applies a reply that took longer than a second", async (t) => {
    const { elements, requests, timers } = setup(t);
    timers.advance(POLL_MS);
    await answer(requests, 0, { state: "missing" });
    assert.equal(elements.status.textContent, SENTENCES.missing);
    await answer(requests, 1, { state: "connected" });
    assert.equal(elements.status.textContent, SENTENCES.connected);
  });

  it("stops asking while hidden and asks at once when shown again", (t) => {
    const { requests, timers, show } = setup(t);
    show(false);
    // The ask scheduled while visible still runs, and schedules no other.
    timers.advance(POLL_MS * 5);
    assert.equal(requests.length, 2);
    assert.equal(timers.pending(), 0);
    show(true);
    assert.equal(requests.length, 3);
    timers.advance(POLL_MS);
    assert.equal(requests.length, 4);
  });

  it("does not ask twice when shown while an ask is scheduled", (t) => {
    const { requests, timers, show } = setup(t);
    show(true);
    assert.equal(requests.length, 2);
    assert.equal(timers.pending(), 1);
    timers.advance(POLL_MS);
    assert.equal(requests.length, 3);
  });

  it("asks once and schedules nothing when it loads hidden", (t) => {
    const { requests, timers } = setup(t, false);
    assert.equal(requests.length, 1);
    assert.equal(timers.pending(), 0);
  });

  it("logs a reply it cannot read and keeps what it shows", async (t) => {
    const { elements, requests, timers, warnings } = setup(t);
    await answer(requests, 0, { state: "missing" });
    for (const [index, reply] of [undefined, "missing", { state: "gone" }].entries()) {
      timers.advance(POLL_MS);
      await answer(requests, index + 1, reply);
    }
    assert.equal(elements.status.textContent, SENTENCES.missing);
    assert.deepEqual(warnings(), [
      { event: "program_state_unreadable" },
      { event: "program_state_unreadable" },
      { event: "program_state_unreadable" },
    ]);
  });

  it("logs a failed request and keeps what it shows", async (t) => {
    const { elements, requests, timers, warnings } = setup(t);
    await answer(requests, 0, { state: "connected" });
    timers.advance(POLL_MS);
    requests[1]?.reject(new Error("Receiving end does not exist."));
    await flush();
    assert.equal(elements.status.textContent, SENTENCES.connected);
    assert.deepEqual(warnings(), [
      { event: "program_state_failed", error: "Error: Receiving end does not exist." },
    ]);
  });
});

interface Request {
  message: unknown;
  resolve(reply: unknown): void;
  reject(error: unknown): void;
}

function setup(t: TestContext, visible = true) {
  const warn = t.mock.method(console, "warn", () => {});
  const timers = createFakeTimers();
  const requests: Request[] = [];
  const visibilityListeners: (() => void)[] = [];
  const page = {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (_type: "visibilitychange", listener: () => void) => {
      visibilityListeners.push(listener);
    },
  };
  const elements = {
    status: { textContent: CHECKING },
    setup: { hidden: true },
    command: { textContent: "" },
    requirement: { textContent: "" },
    update: { hidden: true },
    updateCommand: { textContent: "" },
    addonUpdate: { hidden: true },
    addonUpdateCommand: { textContent: "" },
  };
  const browser = {
    runtime: {
      sendMessage: (message: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          requests.push({ message, resolve, reject });
        }),
    },
  };
  watchProgram({ elements, browser, page, timers });

  function show(shown: boolean): void {
    page.visibilityState = shown ? "visible" : "hidden";
    for (const listener of visibilityListeners) listener();
  }

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { elements, requests, timers, show, warnings };
}

async function answer(requests: Request[], index: number, reply: unknown): Promise<void> {
  const request = requests[index];
  assert.ok(request !== undefined, `no request ${index}`);
  request.resolve(reply);
  await flush();
}

/** The states whose steps the page shows. */
function visibleBlocks(elements: {
  setup: { hidden: boolean };
  update: { hidden: boolean };
  addonUpdate: { hidden: boolean };
}): string[] {
  const blocks = [
    ["missing", elements.setup],
    ["too_old", elements.update],
    ["addon_older", elements.addonUpdate],
  ] as const;
  return blocks.filter(([, block]) => !block.hidden).map(([state]) => state);
}
