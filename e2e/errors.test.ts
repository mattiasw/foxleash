import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  ADDON_PAGE_URL,
  OLDEST_SERVED_PROTOCOL,
  PROTOCOL_VERSION,
  protocolMismatch,
  UPDATE_COMMAND,
} from "@foxleash/protocol";
import { SERVER_VERSION } from "../apps/server/src/version.ts";
import { type Firefox, isRecord, pollUntil } from "./firefox.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  untrustedContent,
} from "./harness.ts";

// Copied from apps/server/src/bridge.ts, where it is private.
const NO_HOST =
  "No Foxleash native host is running: start Firefox with the Foxleash extension installed, and run `npx foxleash doctor` (in a Foxleash checkout, `npm run doctor`) if it still fails.";

// Copied from apps/extension/src/program-status.ts, which the e2e type check cannot load.
const TOO_OLD =
  "The Foxleash program on this computer is too old for this add-on and needs an update.";
const ADDON_OLDER =
  "This add-on is older than the Foxleash program on this computer and needs an update.";

// Copied from apps/extension/src/indicator.ts, where they are private.
const TITLE_TOO_OLD =
  "Foxleash: the program on this computer is too old for this add-on. Open the settings to see what to do.";
const TITLE_ADDON_OLDER =
  "Foxleash: this add-on is older than the program on this computer. Open the settings to see what to do.";

// Above the extension's 10 s reconnect backoff plus the host's start.
const PROGRAM_TIMEOUT_MS = 30_000;

// What a page shows about the Foxleash program.
const PROGRAM_PLACE = `JSON.stringify({
  status: document.getElementById("program-status").textContent,
  setupHidden: document.getElementById("program-setup").hidden,
  updateHidden: document.getElementById("program-update").hidden,
  addonUpdateHidden: document.getElementById("program-addon-update").hidden,
  updateCommand: document.getElementById("program-update-command").textContent,
  addonUpdateCommand: document.getElementById("program-addon-update-command").textContent,
})`;

// The badge text and title of the toolbar button on the evaluating page's own tab.
const OWN_BUTTON =
  "browser.tabs.getCurrent().then((tab) => Promise.all([browser.action.getBadgeText({ tabId: tab.id }), browser.action.getTitle({ tabId: tab.id })])).then((values) => JSON.stringify(values))";

interface ProgramPlace {
  status: string;
  setupHidden: boolean;
  updateHidden: boolean;
  addonUpdateHidden: boolean;
  updateCommand: string;
  addonUpdateCommand: string;
}

describe("without Firefox", () => {
  let harness: Harness;
  let session: Session;

  before(async () => {
    harness = createHarness();
    const empty = join(harness.root, "run-empty");
    mkdirSync(empty, { mode: 0o700 });
    session = await harness.connect({ XDG_RUNTIME_DIR: empty });
  });

  after(async () => {
    await harness?.close();
  });

  test("a tool call says that no host is running", async () => {
    assert.equal(await harness.refused(session, "tabs_list"), NO_HOST);
  });
});

describe("with an extension that speaks a newer protocol", () => {
  let harness: Harness;
  let session: Session;

  before(
    async () => {
      harness = createHarness();
      const extension = patchedExtension(harness, "extension-newer", [
        ["PROTOCOL_VERSION", PROTOCOL_VERSION, PROTOCOL_VERSION + 1],
      ]);
      harness.install();
      await harness.startFirefox(extension);
      session = await harness.connect();
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      await harness?.close();
    },
    { timeout: 60_000 },
  );

  // waitUntilReady's host and ready waits take up to 60 s between them, the default test timeout.
  test("a tool call is answered", { timeout: 120_000 }, async () => {
    // Until the extension has said hello the call finds no host, or a host without an extension.
    await harness.waitUntilReady(session);
    assert.ok(isRecord(await harness.ok(session, "tabs_list")));
  });
});

describe("with an extension that speaks an older protocol", () => {
  let harness: Harness;
  let firefox: Firefox;
  let session: Session;
  let mismatch: string;

  before(
    async () => {
      harness = createHarness();
      // Both numbers go down, so the hello's oldest protocol is not above its protocol.
      const extension = patchedExtension(harness, "extension-older", [
        ["PROTOCOL_VERSION", PROTOCOL_VERSION, PROTOCOL_VERSION - 1],
        ["OLDEST_SERVED_PROTOCOL", OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION - 1],
      ]);
      const manifest: unknown = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
      assert.ok(isRecord(manifest) && typeof manifest.version === "string");
      const sentence = protocolMismatch(
        { part: "host", protocol: PROTOCOL_VERSION, version: SERVER_VERSION },
        {
          part: "extension",
          protocol: PROTOCOL_VERSION - 1,
          version: manifest.version,
          oldest: PROTOCOL_VERSION - 1,
        },
      );
      assert.ok(sentence !== null);
      mismatch = sentence;

      harness.install();
      firefox = await harness.startFirefox(extension);
      session = await harness.connect();
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      await harness?.close();
    },
    { timeout: 60_000 },
  );

  // waitUntilReady's host and ready waits take up to 60 s between them, the default test timeout.
  test("a tool call says which part is older", { timeout: 120_000 }, async () => {
    // Until the extension has said hello the call finds no host, or a host without an extension.
    await harness.waitUntilReady(
      session,
      (result) => result.isError && untrustedContent(result.text) === mismatch,
    );
    assert.equal(untrustedContent(await harness.refused(session, "tabs_list")), mismatch);
  });

  test("the settings and the button say the add-on is older", { timeout: 120_000 }, async () => {
    const settings = await harness.settingsPage();
    const place = await waitForProgram(firefox, settings, ADDON_OLDER);
    assert.equal(place.addonUpdateCommand, ADDON_PAGE_URL);
    assert.equal(place.addonUpdateHidden, false);
    assert.equal(place.setupHidden, true);
    assert.equal(place.updateHidden, true);
    await waitForOwnButton(firefox, settings, ["!", TITLE_ADDON_OLDER]);
  });
});

describe("with a program too old for the extension", () => {
  let harness: Harness;
  let firefox: Firefox;

  before(
    async () => {
      harness = createHarness();
      // Both numbers go up, so the host's protocol is below the oldest the extension serves.
      const extension = patchedExtension(harness, "program-too-old", [
        ["PROTOCOL_VERSION", PROTOCOL_VERSION, PROTOCOL_VERSION + 1],
        ["OLDEST_SERVED_PROTOCOL", OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION + 1],
      ]);
      harness.install();
      firefox = await harness.startFirefox(extension);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      await harness?.close();
    },
    { timeout: 60_000 },
  );

  test("the settings and the button say the program is too old", {
    timeout: 120_000,
  }, async () => {
    const settings = await harness.settingsPage();
    const place = await waitForProgram(firefox, settings, TOO_OLD);
    assert.equal(place.updateCommand, UPDATE_COMMAND);
    assert.equal(place.updateHidden, false);
    assert.equal(place.setupHidden, true);
    assert.equal(place.addonUpdateHidden, true);

    // The tab gets values of its own, then an update without a navigation, so Firefox keeps
    // them and only the indicator's write lets the global notice show.
    await firefox.evaluate(
      settings,
      `browser.tabs.getCurrent().then(async (tab) => {
        await browser.action.setBadgeText({ tabId: tab.id, text: "x" });
        await browser.action.setTitle({ tabId: tab.id, title: "x" });
        await browser.tabs.update(tab.id, { muted: true });
        return true;
      })`,
    );
    await waitForOwnButton(firefox, settings, ["!", TITLE_TOO_OLD]);
  });
});

async function waitForProgram(
  firefox: Firefox,
  context: string,
  status: string,
): Promise<ProgramPlace> {
  return pollUntil(
    async () => {
      const place = await readProgram(firefox, context);
      if (place.status === status) return place;
      throw new Error(`the page says ${JSON.stringify(place.status)}`);
    },
    PROGRAM_TIMEOUT_MS,
    `the page to say ${JSON.stringify(status)}`,
  );
}

async function readProgram(firefox: Firefox, context: string): Promise<ProgramPlace> {
  const raw = await firefox.evaluate(context, PROGRAM_PLACE);
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    typeof value.setupHidden !== "boolean" ||
    typeof value.updateHidden !== "boolean" ||
    typeof value.addonUpdateHidden !== "boolean" ||
    typeof value.updateCommand !== "string" ||
    typeof value.addonUpdateCommand !== "string"
  ) {
    throw new Error(`the page's program place is ${String(raw)}`);
  }
  return {
    status: value.status,
    setupHidden: value.setupHidden,
    updateHidden: value.updateHidden,
    addonUpdateHidden: value.addonUpdateHidden,
    updateCommand: value.updateCommand,
    addonUpdateCommand: value.addonUpdateCommand,
  };
}

async function waitForOwnButton(
  firefox: Firefox,
  context: string,
  shown: [text: string, title: string],
): Promise<void> {
  const expected = JSON.stringify(shown);
  await pollUntil(
    async () => {
      const seen = await firefox.evaluate(context, OWN_BUTTON);
      if (seen === expected) return true;
      throw new Error(`badge and title are ${String(seen)}`);
    },
    PROGRAM_TIMEOUT_MS,
    `the button to show ${expected}`,
  );
}

/** A copy of the built extension with each constant in its bundle changed from one number to another. */
function patchedExtension(
  harness: Harness,
  name: string,
  patches: [constant: string, from: number, to: number][],
): string {
  const extension = join(harness.root, name);
  cpSync(EXTENSION_DIST, extension, { recursive: true });
  const background = join(extension, "background.js");
  let source = readFileSync(background, "utf8");
  for (const [constant, from, to] of patches) {
    const search = `${constant} = ${from};`;
    assert.equal(
      source.split(search).length - 1,
      1,
      `expected exactly one ${JSON.stringify(search)} in the bundled background.js`,
    );
    source = source.replace(search, `${constant} = ${to};`);
  }
  writeFileSync(background, source);
  return extension;
}
