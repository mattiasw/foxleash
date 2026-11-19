import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseVersion, SERVER_VERSION } from "./version.ts";

describe("SERVER_VERSION", () => {
  it("is the version in the server's package.json", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
    assert.equal(SERVER_VERSION, manifest.version);
  });
});

describe("parseVersion", () => {
  it("returns a valid version", () => {
    assert.equal(parseVersion({ name: "x", version: "1.2.3-beta+4" }), "1.2.3-beta+4");
    const longest = "1".repeat(64);
    assert.equal(parseVersion({ version: longest }), longest);
  });

  const invalid: unknown[] = [
    null,
    undefined,
    5,
    "s",
    [],
    {},
    { version: 1 },
    { version: "" },
    { version: "1".repeat(65) },
    { version: "1.0 beta" },
    { version: "0.1.0\n" },
    { version: "\n0.1.0" },
  ];
  for (const value of invalid) {
    it(`throws for ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseVersion(value), {
        name: "Error",
        message: "package.json has no valid version",
      });
    });
  }
});
