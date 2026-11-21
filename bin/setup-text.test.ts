import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  ADDON_PAGE_URL,
  EXTENSION_ID,
  NODE_REQUIREMENT,
  SETUP_COMMAND,
  UPDATE_COMMAND,
} from "../packages/protocol/src/index.ts";

const ROOT = path.join(import.meta.dirname, "..");

describe("the setup command and the Node.js requirement", () => {
  for (const file of ["README.md", "docs/amo/listing.md"]) {
    test(`${file} names the requirement the pages show`, () => {
      assert.ok(read(file).includes(NODE_REQUIREMENT), `${file} lacks "${NODE_REQUIREMENT}"`);
    });
  }

  // The pages fill these in from the constants, so the HTML cannot drift from them.
  for (const file of ["apps/extension/src/welcome.html", "apps/extension/src/options.html"]) {
    test(`${file} leaves the commands and the requirement to its script`, () => {
      const html = read(file);
      const texts = [SETUP_COMMAND, UPDATE_COMMAND, ADDON_PAGE_URL, NODE_REQUIREMENT, "Node.js"];
      for (const text of texts) {
        assert.ok(!html.includes(text), `${file} contains "${text}"`);
      }
    });
  }
});

describe("the add-on page address", () => {
  test("is an add-on page on AMO whose last segment is a slug or the add-on id", () => {
    const match = /^https:\/\/addons\.mozilla\.org\/firefox\/addon\/([^/]+)\/$/.exec(
      ADDON_PAGE_URL,
    );
    const segment = match?.[1];
    assert.ok(segment !== undefined, `${ADDON_PAGE_URL} is not an add-on page on AMO`);
    assert.ok(
      segment === EXTENSION_ID || /^(?!\d+$)[a-z0-9-]+$/.test(segment),
      `${ADDON_PAGE_URL} ends in neither the add-on id nor a lower-case slug`,
    );
  });
});

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}
