import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  DOWNLOAD_SECRET,
  type FixtureServer,
  receiptPdf,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  untrustedContent,
} from "./harness.ts";

// One Firefox for the file: the tests run in order and share its download folder.
describe("download in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let other = "";

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      // The same server under another site, which the tests never approve.
      other = `http://localhost:${fixtures.port}`;
      await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("saves a file served as an attachment under the given name, never replacing one", async () => {
    const pdf = receiptPdf();
    const first = await save("/download/receipt.pdf", "receipt.pdf");
    assert.deepEqual(first, {
      path: join(harness.downloads, "receipt.pdf"),
      bytes: Buffer.byteLength(pdf),
    });
    assert.equal(readFileSync(first.path, "utf8"), pdf);
    const second = await save("/download/receipt.pdf", "receipt.pdf");
    assert.equal(second.path, join(harness.downloads, "receipt(1).pdf"));
    assert.equal(readFileSync(second.path, "utf8"), pdf);
  });

  test("sends the cookies the site set in the browser", async () => {
    const signedOut = await harness.refused(session, "download", {
      url: fixtures.url("/download/private.txt"),
      filename: "private.txt",
    });
    assert.equal(
      untrustedContent(signedOut),
      "The server answered with status 403; nothing was saved.",
    );
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/download/login") }),
    );
    assert.equal(tab.title, TITLES.downloadLogin);
    const saved = await save("/download/private.txt", "private.txt");
    assert.equal(readFileSync(saved.path, "utf8"), DOWNLOAD_SECRET);
  });

  test("refuses a redirect to a site the session may not act on and saves nothing", async () => {
    const files = listed();
    const text = await harness.refused(session, "download", {
      url: fixtures.url("/download/away"),
      filename: "away.pdf",
    });
    assert.equal(
      untrustedContent(text),
      `The link led to ${other}, which Foxhand is not allowed on in this session; nothing was saved.`,
    );
    assert.deepEqual(listed(), files);
  });

  test("saves after a redirect on the same site", async () => {
    const saved = await save("/download/same", "same.pdf");
    assert.equal(saved.path, join(harness.downloads, "same.pdf"));
    assert.equal(readFileSync(saved.path, "utf8"), receiptPdf());
  });

  test("refuses a URL on a site the session may not act on before any request", async () => {
    const text = await harness.refused(session, "download", {
      url: `${other}/download/unapproved.pdf`,
      filename: "unapproved.pdf",
    });
    assert.equal(
      untrustedContent(text),
      `Foxhand is not allowed on ${other} in this session; open it with tab_open or navigate first, which asks the user.`,
    );
    assert.equal(fixtures.hits("/download/unapproved.pdf"), 0);
  });

  test("refuses a file the server does not have and saves nothing", async () => {
    const files = listed();
    const text = await harness.refused(session, "download", {
      url: fixtures.url("/download/missing"),
      filename: "missing.pdf",
    });
    assert.equal(untrustedContent(text), "The server answered with status 404; nothing was saved.");
    assert.deepEqual(listed(), files);
  });

  test("refuses a file name with a folder before any request", async () => {
    const text = await harness.refused(session, "download", {
      url: fixtures.url("/download/slash.pdf"),
      filename: "sub/slash.pdf",
    });
    assert.match(untrustedContent(text) ?? "", /^download needs filename to be a plain file name/);
    assert.equal(fixtures.hits("/download/slash.pdf"), 0);
    assert.deepEqual(
      listed().filter((name) => name === "sub"),
      [],
    );
  });

  test("sends nothing that names the extension", () => {
    const requests = fixtures.downloadHeaders();
    assert.ok(requests.length > 0);
    for (const headers of requests) {
      assert.equal(
        JSON.stringify(headers).includes("moz-extension"),
        false,
        JSON.stringify(headers),
      );
    }
  });

  async function save(path: string, filename: string): Promise<{ path: string; bytes: number }> {
    const result = await harness.ok(session, "download", { url: fixtures.url(path), filename });
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "path" in result &&
        typeof result.path === "string" &&
        "bytes" in result &&
        typeof result.bytes === "number",
      JSON.stringify(result),
    );
    return { path: result.path, bytes: result.bytes };
  }

  function listed(): string[] {
    return readdirSync(harness.downloads).sort();
  }
});
