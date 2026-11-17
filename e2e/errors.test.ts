import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION, protocolMismatch } from "@foxleash/protocol";
import { SERVER_VERSION } from "../apps/server/src/version.ts";
import { isRecord } from "./firefox.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  untrustedContent,
} from "./harness.ts";

// Copied from apps/server/src/bridge.ts, where it is private.
const NO_HOST =
  "No Foxleash native host is running: start Firefox with the Foxleash extension installed, and run `npm run doctor` in your Foxleash folder if it still fails.";

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
  test("a tool call says which part is older", { timeout: 120_000 }, async () => {
    // Until the extension has said hello the call finds no host, or a host without an extension.
    await harness.waitUntilReady(
      session,
      (result) => result.isError && untrustedContent(result.text) === mismatch,
    );
    assert.equal(untrustedContent(await harness.refused(session, "tabs_list")), mismatch);
  });
});

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
