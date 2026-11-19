import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADDON_PAGE_URL,
  type PartInfo,
  protocolMismatch,
  UPDATE_COMMAND,
  versionDifference,
  versionsOf,
} from "./index.ts";

const ADDON_FIX =
  "update the add-on in Firefox (open about:addons and choose Check for Updates), or install it " +
  "again from https://addons.mozilla.org/firefox/addon/foxleash/";
const UPDATE = "update Foxleash with `npx foxleash@latest setup` if you have not yet";

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
        `(version 1.4.0, protocol 12): ${ADDON_FIX}.`,
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

describe("the update texts", () => {
  it("are what the stale host's and the stale extension's sentences name", () => {
    const host: PartInfo = { part: "host", protocol: 3, version: "0.9.1" };
    const extension: PartInfo = { part: "extension", protocol: 3, version: "0.9.1" };
    const newer = (part: "host" | "extension"): PartInfo => ({
      part,
      protocol: 12,
      version: "1.4.0",
    });
    assert.ok(protocolMismatch(host, newer("extension"))?.includes(`\`${UPDATE_COMMAND}\``));
    assert.ok(
      protocolMismatch(extension, newer("host"))?.includes(
        `install it again from ${ADDON_PAGE_URL}`,
      ),
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
      `(version 1.4.0, protocol 6): ${ADDON_FIX}.`;
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

describe("versionDifference", () => {
  const HOST_FIX = `Firefox is still running the old native host, so ${UPDATE} and then restart Firefox`;

  it("returns null when the versions are equal", () => {
    assert.equal(
      versionDifference(
        { part: "host", protocol: 7, version: "1.4.0" },
        { part: "extension", protocol: 6, version: "1.4.0" },
      ),
      null,
    );
  });

  it("names an older host and the program update in either argument order", () => {
    const host: PartInfo = { part: "host", protocol: 7, version: "1.4.0" };
    const extension: PartInfo = { part: "extension", protocol: 7, version: "1.5.0" };
    const sentence =
      "The Foxleash native host (version 1.4.0) is older than the Foxleash extension " +
      `(version 1.5.0): ${HOST_FIX}.`;
    assert.equal(versionDifference(host, extension), sentence);
    assert.equal(versionDifference(extension, host), sentence);
    assert.ok(sentence.includes("`npx foxleash@latest setup`"));
  });

  it("names an older extension and the add-on update", () => {
    const host: PartInfo = { part: "host", protocol: 7, version: "1.10.0" };
    const extension: PartInfo = { part: "extension", protocol: 7, version: "1.9.3" };
    const sentence =
      "The Foxleash extension (version 1.9.3) is older than the Foxleash native host " +
      `(version 1.10.0): ${ADDON_FIX}.`;
    assert.equal(versionDifference(host, extension), sentence);
    assert.equal(versionDifference(extension, host), sentence);
    assert.ok(sentence.includes("about:addons"));
    assert.ok(sentence.includes(ADDON_PAGE_URL));
  });

  it("names an older MCP server", () => {
    assert.equal(
      versionDifference(
        { part: "mcp", protocol: 7, version: "0.5.0" },
        { part: "host", protocol: 7, version: "0.5.1" },
      ),
      "The Foxleash MCP server (version 0.5.0) is older than the Foxleash native host " +
        "(version 0.5.1): your MCP client is still running the old MCP server, so " +
        `${UPDATE} and then restart your MCP client.`,
    );
  });

  it("orders parts longer than a double can hold exactly", () => {
    const host: PartInfo = { part: "host", protocol: 7, version: "1.0.18014398509481984" };
    const extension: PartInfo = {
      part: "extension",
      protocol: 7,
      version: "1.0.18014398509481985",
    };
    assert.equal(Number("18014398509481984"), Number("18014398509481985"));
    assert.equal(
      versionDifference(extension, host),
      `The Foxleash native host (version ${host.version}) is older than the Foxleash extension ` +
        `(version ${extension.version}): ${HOST_FIX}.`,
    );
  });

  it("counts a missing trailing part as 0", () => {
    assert.equal(
      versionDifference(
        { part: "host", protocol: 7, version: "1.0" },
        { part: "extension", protocol: 7, version: "1.0.1" },
      ),
      "The Foxleash native host (version 1.0) is older than the Foxleash extension " +
        `(version 1.0.1): ${HOST_FIX}.`,
    );
  });

  const differ: [string, string][] = [
    ["1.0.0-beta", "1.0.0"],
    ["1.0.0", "1.0.0+build"],
    ["1..0", "1.0.0"],
    ["1.0", "1.0.0"],
  ];
  for (const [hostVersion, extensionVersion] of differ) {
    it(`names both fixes for ${hostVersion} and ${extensionVersion}`, () => {
      const host: PartInfo = { part: "host", protocol: 7, version: hostVersion };
      const extension: PartInfo = { part: "extension", protocol: 7, version: extensionVersion };
      assert.equal(
        versionDifference(host, extension),
        `The Foxleash native host (version ${hostVersion}) and the Foxleash extension ` +
          `(version ${extensionVersion}) differ in version: if the Foxleash native host is ` +
          `older, ${HOST_FIX}; if the Foxleash extension is older, ${ADDON_FIX}.`,
      );
    });
  }

  it("returns null when the protocols do not work together", () => {
    const host: PartInfo = { part: "host", protocol: 3, version: "0.9.1" };
    const extension: PartInfo = { part: "extension", protocol: 7, version: "1.4.0", oldest: 6 };
    assert.notEqual(protocolMismatch(host, extension), null);
    assert.equal(versionDifference(host, extension), null);
    assert.equal(versionDifference(extension, host), null);
  });

  it("names a difference when the protocols differ within the window", () => {
    const host: PartInfo = { part: "host", protocol: 6, version: "1.3.0" };
    const extension: PartInfo = { part: "extension", protocol: 7, version: "1.4.0", oldest: 6 };
    assert.equal(protocolMismatch(host, extension), null);
    assert.equal(
      versionDifference(host, extension),
      "The Foxleash native host (version 1.3.0) is older than the Foxleash extension " +
        `(version 1.4.0): ${HOST_FIX}.`,
    );
  });
});
