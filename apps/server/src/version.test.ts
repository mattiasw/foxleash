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
    assert.equal(parseVersion('{"name":"x","version":"1.2.3-beta+4"}'), "1.2.3-beta+4");
    const longest = "1".repeat(64);
    assert.equal(parseVersion(JSON.stringify({ version: longest })), longest);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseVersion("{"), { name: "SyntaxError" });
  });

  const invalid = [
    "null",
    "5",
    '"s"',
    "[]",
    "{}",
    '{"version":1}',
    '{"version":""}',
    JSON.stringify({ version: "1".repeat(65) }),
    '{"version":"1.0 beta"}',
    '{"version":"0.1.0\\n"}',
    '{"version":"\\n0.1.0"}',
  ];
  for (const text of invalid) {
    it(`throws for ${text}`, () => {
      assert.throws(() => parseVersion(text), {
        name: "Error",
        message: "package.json has no valid version",
      });
    });
  }
});
