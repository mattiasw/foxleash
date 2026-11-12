import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PartInfo, protocolMismatch } from "./index.ts";

const UPDATE = "update Foxleash with `git pull && npm ci && npm run setup` if you have not yet";

describe("protocolMismatch", () => {
  it("returns null when the protocols match, even with different versions", () => {
    assert.equal(
      protocolMismatch(
        { part: "extension", protocol: 4, version: "1.0.0" },
        { part: "host", protocol: 4, version: "2.3.1" },
      ),
      null,
    );
  });

  const cases: { stale: PartInfo; other: PartInfo; sentence: string }[] = [
    {
      stale: { part: "extension", protocol: 3, version: "0.9.1" },
      other: { part: "host", protocol: 12, version: "1.4.0" },
      sentence:
        "The Foxleash extension (version 0.9.1, protocol 3) is older than the Foxleash native host " +
        "(version 1.4.0, protocol 12): run `npm run setup` in your Foxleash folder and confirm the " +
        "extension update in Firefox.",
    },
    {
      stale: { part: "host", protocol: 3, version: "0.9.1" },
      other: { part: "extension", protocol: 12, version: "1.4.0" },
      sentence:
        "The Foxleash native host (version 0.9.1, protocol 3) is older than the Foxleash extension " +
        "(version 1.4.0, protocol 12): Firefox is still running the old native host, so " +
        `${UPDATE} and then restart Firefox.`,
    },
    {
      stale: { part: "mcp", protocol: 3, version: "0.9.1" },
      other: { part: "host", protocol: 12, version: "1.4.0" },
      sentence:
        "The Foxleash MCP server (version 0.9.1, protocol 3) is older than the Foxleash native host " +
        "(version 1.4.0, protocol 12): your MCP client is still running the old MCP server, so " +
        `${UPDATE} and then restart your MCP client.`,
    },
  ];

  for (const { stale, other, sentence } of cases) {
    it(`names a stale ${stale.part} and its fix in either argument order`, () => {
      assert.equal(protocolMismatch(stale, other), sentence);
      assert.equal(protocolMismatch(other, stale), sentence);
    });

    it(`gives both versions and protocols and no long dash for a stale ${stale.part}`, () => {
      for (const text of [protocolMismatch(stale, other), protocolMismatch(other, stale)]) {
        assert.ok(text !== null);
        for (const part of [stale, other]) {
          assert.ok(text.includes(`protocol ${part.protocol}`));
          assert.ok(text.includes(`version ${part.version}`));
        }
        assert.ok(!text.includes("\u2014"));
        assert.ok(!text.includes("\u2013"));
      }
    });
  }
});
