import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXTENSION_UPDATE_COMMAND,
  type PartInfo,
  protocolMismatch,
  UPDATE_COMMAND,
  versionsOf,
} from "./index.ts";

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

describe("the update commands", () => {
  it("are the commands the stale host's and the stale extension's sentences name", () => {
    const host: PartInfo = { part: "host", protocol: 3, version: "0.9.1" };
    const extension: PartInfo = { part: "extension", protocol: 3, version: "0.9.1" };
    const newer = (part: "host" | "extension"): PartInfo => ({
      part,
      protocol: 12,
      version: "1.4.0",
    });
    assert.ok(protocolMismatch(host, newer("extension"))?.includes(`\`${UPDATE_COMMAND}\``));
    assert.ok(
      protocolMismatch(extension, newer("host"))?.includes(`\`${EXTENSION_UPDATE_COMMAND}\``),
    );
  });
});

describe("protocolMismatch with a window", () => {
  const extension: PartInfo = { part: "extension", protocol: 6, version: "1.4.0", oldest: 3 };

  it("returns null when the older part is at the newer part's oldest protocol", () => {
    const host: PartInfo = { part: "host", protocol: 3, version: "0.9.1" };
    assert.equal(protocolMismatch(host, extension), null);
    assert.equal(protocolMismatch(extension, host), null);
  });

  it("returns null when the older part is inside the newer part's window", () => {
    const host: PartInfo = { part: "host", protocol: 5, version: "0.9.1" };
    assert.equal(protocolMismatch(host, extension), null);
    assert.equal(protocolMismatch(extension, host), null);
  });

  it("names a part below the window and quotes the window in either argument order", () => {
    const host: PartInfo = { part: "host", protocol: 2, version: "0.9.1" };
    const sentence =
      "The Foxleash native host (version 0.9.1, protocol 2) is older than the Foxleash extension " +
      "(version 1.4.0, protocol 6, which works with protocol 3 and later): Firefox is still " +
      `running the old native host, so ${UPDATE} and then restart Firefox.`;
    assert.equal(protocolMismatch(host, extension), sentence);
    assert.equal(protocolMismatch(extension, host), sentence);
  });

  it("does not let an older part's window serve a newer part", () => {
    const older: PartInfo = { part: "extension", protocol: 5, version: "0.9.1", oldest: 3 };
    const host: PartInfo = { part: "host", protocol: 6, version: "1.4.0" };
    const sentence =
      "The Foxleash extension (version 0.9.1, protocol 5) is older than the Foxleash native host " +
      "(version 1.4.0, protocol 6): run `npm run setup` in your Foxleash folder and confirm the " +
      "extension update in Firefox.";
    assert.equal(protocolMismatch(older, host), sentence);
    assert.equal(protocolMismatch(host, older), sentence);
  });

  it("quotes no window when the newer part's oldest protocol is its own", () => {
    const newer: PartInfo = { part: "extension", protocol: 6, version: "1.4.0", oldest: 6 };
    const host: PartInfo = { part: "host", protocol: 5, version: "0.9.1" };
    const sentence =
      "The Foxleash native host (version 0.9.1, protocol 5) is older than the Foxleash extension " +
      "(version 1.4.0, protocol 6): Firefox is still running the old native host, so " +
      `${UPDATE} and then restart Firefox.`;
    assert.equal(protocolMismatch(host, newer), sentence);
    assert.equal(protocolMismatch(newer, host), sentence);
  });

  it("refuses when the newer part's oldest protocol is not a number", () => {
    const newer: PartInfo = { ...extension, oldest: Number.NaN };
    const host: PartInfo = { part: "host", protocol: 5, version: "0.9.1" };
    assert.notEqual(protocolMismatch(host, newer), null);
  });
});

describe("versionsOf", () => {
  it("gives the version and protocol of a part without a window", () => {
    assert.equal(
      versionsOf({ part: "extension", protocol: 6, version: "1.4.0" }),
      "version 1.4.0, protocol 6",
    );
  });

  it("gives no window when the oldest protocol is the part's own", () => {
    assert.equal(
      versionsOf({ part: "extension", protocol: 6, version: "1.4.0", oldest: 6 }),
      "version 1.4.0, protocol 6",
    );
  });

  it("names the oldest protocol when it is older", () => {
    assert.equal(
      versionsOf({ part: "extension", protocol: 6, version: "1.4.0", oldest: 5 }),
      "version 1.4.0, protocol 6, which works with protocol 5 and later",
    );
  });
});
