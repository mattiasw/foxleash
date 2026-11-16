import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { NODE_REQUIREMENT, SETUP_COMMAND } from "../packages/protocol/src/index.ts";

const ROOT = path.join(import.meta.dirname, "..");

describe("the setup command and the Node.js requirement", () => {
  for (const file of ["README.md", "docs/amo/listing.md"]) {
    test(`${file} names the requirement the pages show`, () => {
      assert.ok(read(file).includes(NODE_REQUIREMENT), `${file} lacks "${NODE_REQUIREMENT}"`);
    });
  }

  // The pages fill these in from the constants, so the HTML cannot drift from them.
  for (const file of ["apps/extension/src/welcome.html", "apps/extension/src/options.html"]) {
    test(`${file} leaves the command and the requirement to its script`, () => {
      const html = read(file);
      for (const text of [SETUP_COMMAND, NODE_REQUIREMENT, "Node.js"]) {
        assert.ok(!html.includes(text), `${file} contains "${text}"`);
      }
    });
  }
});

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}
