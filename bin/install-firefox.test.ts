import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

// Every path runs for real against a temp cache root, with a real `tar -cJf` fixture standing in
// for Mozilla's tarball and the download seam copying it, so nothing here touches the network or
// the real cache. The one real HTTP exchange is with a server bound on 127.0.0.1.

const SCRIPT = join(import.meta.dirname, "install-firefox.ts");
const temporaryDirectories: string[] = [];

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The ensureFirefox calls below that pass no pinPath read FOXLEASH_E2E_FIREFOX; a value exported
// for the end-to-end suite must not change them.
const PIN_SELECTOR = "FOXLEASH_E2E_FIREFOX";
delete process.env[PIN_SELECTOR];

// Imported with XDG_CACHE_HOME naming a file, so a script guard that wrongly reads true fails the
// run at once instead of installing Firefox into the real cache.
const importGuard = join(makeTempDirectory("install-firefox-import-"), "file");
writeFileSync(importGuard, "");
const CACHE_HOME = "XDG_CACHE_HOME";
const savedCacheHome = process.env[CACHE_HOME];
process.env[CACHE_HOME] = importGuard;
const {
  DOWNLOAD_TIMEOUT_MS,
  EXTRACT_TIMEOUT_MS,
  PIN_PATHS,
  STALE_TEMP_MS,
  archiveUrl,
  assertSupportedPlatform,
  cacheRoot,
  downloadArchive,
  ensureFirefox,
  extractArchive,
  firefoxBinaryPath,
  readPin,
  selectedPinPath,
  sha256File,
  sweepStaleTemps,
  validatePin,
} = await import("./install-firefox.ts");
if (savedCacheHome === undefined) delete process.env[CACHE_HOME];
else process.env[CACHE_HOME] = savedCacheHome;

const LINUX = { platform: "linux", arch: "x64" };
// The discard port, where nothing listens.
const REFUSING_PROXY = "http://127.0.0.1:9";
const ANY_SHA = "a".repeat(64);

interface Fixture {
  archive: string;
  sha256: string;
  content: string;
}

/** A tiny tarball with the layout Mozilla's has: firefox/firefox. */
function makeFixtureArchive(content = "#!/bin/sh\necho fake firefox\n"): Fixture {
  const work = makeTempDirectory("install-firefox-fixture-");
  mkdirSync(join(work, "tree", "firefox"), { recursive: true });
  writeFileSync(join(work, "tree", "firefox", "firefox"), content);
  const archive = join(work, "firefox.tar.xz");
  const result = spawnSync("tar", ["-cJf", archive, "-C", join(work, "tree"), "firefox"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`fixture tar failed: ${result.stderr}`);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return { archive, sha256, content };
}

interface DownloadCall {
  url: string;
  destination: string;
}

/** A download seam that copies the fixture and records every call. */
function copyingDownload(archive: string): {
  calls: DownloadCall[];
  download: (url: string, destination: string) => Promise<void>;
} {
  const calls: DownloadCall[] = [];
  return {
    calls,
    download: async (url, destination) => {
      calls.push({ url, destination });
      copyFileSync(archive, destination);
    },
  };
}

function silentLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

function tempEntries(root: string): string[] {
  return readdirSync(root).filter(
    (name) => name.startsWith(".download-") || name.startsWith(".extract-"),
  );
}

function makeInstalled(root: string, version: string, content = "installed"): string {
  const binary = firefoxBinaryPath(root, version);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, content);
  return binary;
}

function setAge(path: string, mtimeMs: number): void {
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe("bin/firefox-version.json and the pin checks", () => {
  test("ships a pin that validates", () => {
    assert.equal(PIN_PATHS.release, join(import.meta.dirname, "firefox-version.json"));
    assert.deepEqual(readPin(PIN_PATHS.release), {
      version: "160.0.1",
      sha256: "844d8a77aa4672a08ded949b6206f84d91bb82f6637c090fd58c3126e9d44119",
    });
    assert.ok(!readPin(PIN_PATHS.release).version.endsWith("esr"));
  });

  test("ships an ESR pin that validates", () => {
    assert.equal(PIN_PATHS.esr, join(import.meta.dirname, "firefox-esr-version.json"));
    assert.deepEqual(readPin(PIN_PATHS.esr), {
      version: "153.7.0esr",
      sha256: "7d2eb92ca3a7b2a83de092eb9b94c853980214de2fbfdccb2ac39d61c593c5a5",
    });
    assert.ok(readPin(PIN_PATHS.esr).version.endsWith("esr"));
  });

  test("accepts two- and three-part release numbers", () => {
    assert.deepEqual(validatePin({ version: "157.0", sha256: ANY_SHA }), {
      version: "157.0",
      sha256: ANY_SHA,
    });
    assert.deepEqual(validatePin({ version: "156.0.1", sha256: ANY_SHA }), {
      version: "156.0.1",
      sha256: ANY_SHA,
    });
  });

  test("accepts an ESR version", () => {
    assert.deepEqual(validatePin({ version: "153.7.0esr", sha256: ANY_SHA }), {
      version: "153.7.0esr",
      sha256: ANY_SHA,
    });
    assert.deepEqual(validatePin({ version: "140.0esr", sha256: ANY_SHA }), {
      version: "140.0esr",
      sha256: ANY_SHA,
    });
  });

  test("returns only the version and the sha256", () => {
    assert.deepEqual(validatePin({ version: "156.0.1", sha256: ANY_SHA, extra: true }), {
      version: "156.0.1",
      sha256: ANY_SHA,
    });
  });

  const rejected: Array<[string, unknown, RegExp]> = [
    ["a missing pin", null, /: expected an object with version and sha256\.$/],
    ["a non-object pin", "156.0.1", /: expected an object with version and sha256\.$/],
    ["a missing version", { sha256: ANY_SHA }, /: "version" must be .* got undefined\.$/],
    ["a numeric version", { version: 156, sha256: ANY_SHA }, /: "version" must be .* got 156\.$/],
    ["a channel name", { version: "latest", sha256: ANY_SHA }, /: "version" must be/],
    ["a single number", { version: "156", sha256: ANY_SHA }, /: "version" must be/],
    ["a trailing suffix", { version: "160.0b1", sha256: ANY_SHA }, /: "version" must be/],
    [
      "a release-candidate suffix",
      { version: "160.0.1rc", sha256: ANY_SHA },
      /: "version" must be/,
    ],
    ["a suffix after esr", { version: "153.7.0esr1", sha256: ANY_SHA }, /: "version" must be/],
    ["a capitalized ESR", { version: "153.7.0ESR", sha256: ANY_SHA }, /: "version" must be/],
    ["a leading prefix", { version: "v156.0", sha256: ANY_SHA }, /: "version" must be/],
    ["a four-part version", { version: "156.0.1.2", sha256: ANY_SHA }, /: "version" must be/],
    ["a missing sha", { version: "156.0.1" }, /: "sha256" must be .* got undefined\.$/],
    ["a short sha", { version: "156.0.1", sha256: "abc" }, /: "sha256" must be .* got "abc"\.$/],
    ["an uppercase sha", { version: "156.0.1", sha256: "A".repeat(64) }, /: "sha256" must be/],
    ["a sha with a suffix", { version: "156.0.1", sha256: `${ANY_SHA}0` }, /: "sha256" must be/],
    ["a sha with a prefix", { version: "156.0.1", sha256: `0${ANY_SHA}` }, /: "sha256" must be/],
  ];
  for (const [label, pin, pattern] of rejected) {
    test(`rejects ${label}, naming the file`, () => {
      assert.throws(() => validatePin(pin, "/x/pin.json"), pattern);
      assert.throws(() => validatePin(pin, "/x/pin.json"), /^Error: \/x\/pin\.json: /);
    });
  }

  test("names the pin file by default", () => {
    assert.throws(() => validatePin(null), {
      message: `${PIN_PATHS.release}: expected an object with version and sha256.`,
    });
  });

  test("describes a valid version in its refusal", () => {
    assert.throws(() => validatePin({ version: "x" }, "/x/pin.json"), {
      message:
        '/x/pin.json: "version" must be a Firefox release number such as 160.0.1 or 153.7.0esr, got "x".',
    });
  });

  test("says where to take the sha256 from", () => {
    assert.throws(() => validatePin({ version: "157.0", sha256: "x" }, "/x/pin.json"), {
      message:
        '/x/pin.json: "sha256" must be 64 lowercase hex digits (from Mozilla\'s releases/157.0/SHA256SUMS), got "x".',
    });
  });

  test("names the pin file and keeps the cause when it cannot be parsed", () => {
    let parseError: unknown;
    try {
      JSON.parse("{not json");
    } catch (error: unknown) {
      parseError = error;
    }
    assert.ok(parseError instanceof Error);
    assert.throws(
      () => readPin("/x/pin.json", { read: () => "{not json" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `/x/pin.json: cannot read the Firefox pin: ${parseError instanceof Error ? parseError.message : ""}`,
        );
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
  });

  test("reports a read failure that is not an Error as text", () => {
    assert.throws(
      () =>
        readPin("/x/pin.json", {
          read: () => {
            throw "disk on fire";
          },
        }),
      { message: "/x/pin.json: cannot read the Firefox pin: disk on fire" },
    );
  });

  test("reads the file it is given", () => {
    const directory = makeTempDirectory("install-firefox-pin-");
    const path = join(directory, "pin.json");
    writeFileSync(path, JSON.stringify({ version: "157.0", sha256: ANY_SHA }));
    assert.deepEqual(readPin(path), { version: "157.0", sha256: ANY_SHA });
  });

  test("validates what it read", () => {
    assert.throws(
      () => readPin("/x/pin.json", { read: () => '{"version":"x","sha256":"y"}' }),
      /^Error: \/x\/pin\.json: "version" must be/,
    );
  });
});

describe("bin/install-firefox.ts pin selection", () => {
  test("selects the release when FOXLEASH_E2E_FIREFOX is unset, empty or release", () => {
    assert.equal(selectedPinPath({ env: {} }), PIN_PATHS.release);
    assert.equal(selectedPinPath({ env: { FOXLEASH_E2E_FIREFOX: "" } }), PIN_PATHS.release);
    assert.equal(selectedPinPath({ env: { FOXLEASH_E2E_FIREFOX: "release" } }), PIN_PATHS.release);
  });

  test("selects the ESR when FOXLEASH_E2E_FIREFOX is esr", () => {
    assert.equal(selectedPinPath({ env: { FOXLEASH_E2E_FIREFOX: "esr" } }), PIN_PATHS.esr);
  });

  for (const value of ["ESR", "beta", " esr", "constructor"]) {
    test(`refuses FOXLEASH_E2E_FIREFOX=${JSON.stringify(value)}, naming the allowed values`, () => {
      assert.throws(() => selectedPinPath({ env: { FOXLEASH_E2E_FIREFOX: value } }), {
        message: `FOXLEASH_E2E_FIREFOX must be "release" or "esr" (unset or empty means "release"), got ${JSON.stringify(value)}.`,
      });
    });
  }
});

describe("bin/install-firefox.ts constants", () => {
  test("bounds the download, the extraction and a temp entry's age", () => {
    assert.equal(DOWNLOAD_TIMEOUT_MS, 300_000);
    assert.equal(EXTRACT_TIMEOUT_MS, 180_000);
    assert.equal(STALE_TEMP_MS, 3_600_000);
  });
});

describe("bin/install-firefox.ts paths", () => {
  test("derives Mozilla's linux-x86_64 en-US tarball URL", () => {
    assert.equal(
      archiveUrl("156.0.1"),
      "https://archive.mozilla.org/pub/firefox/releases/156.0.1/linux-x86_64/en-US/firefox-156.0.1.tar.xz",
    );
  });

  test("derives the ESR's tarball URL", () => {
    assert.equal(
      archiveUrl("153.7.0esr"),
      "https://archive.mozilla.org/pub/firefox/releases/153.7.0esr/linux-x86_64/en-US/firefox-153.7.0esr.tar.xz",
    );
  });

  test("caches under XDG_CACHE_HOME when it is set", () => {
    assert.equal(
      cacheRoot({ env: { XDG_CACHE_HOME: "/xdg" }, homedir: "/home/u" }),
      "/xdg/foxleash-firefox",
    );
  });

  test("falls back to ~/.cache when XDG_CACHE_HOME is unset or empty", () => {
    assert.equal(cacheRoot({ env: {}, homedir: "/home/u" }), "/home/u/.cache/foxleash-firefox");
    assert.equal(
      cacheRoot({ env: { XDG_CACHE_HOME: "" }, homedir: "/home/u" }),
      "/home/u/.cache/foxleash-firefox",
    );
  });

  test("puts the binary under a per-version directory", () => {
    assert.equal(
      firefoxBinaryPath("/c/foxleash-firefox", "156.0.1"),
      "/c/foxleash-firefox/156.0.1/firefox/firefox",
    );
  });
});

describe("bin/install-firefox.ts platform check", () => {
  test("accepts linux x64", () => {
    assert.doesNotThrow(() => assertSupportedPlatform(LINUX));
  });

  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const) {
    test(`refuses ${platform} ${arch} with a message saying why and how to extend it`, () => {
      assert.throws(() => assertSupportedPlatform({ platform, arch }), {
        message:
          `Foxleash's end-to-end tests run only on linux x64, and this is ${platform} ${arch}. ` +
          "bin/firefox-version.json and bin/firefox-esr-version.json pin only the linux-x86_64 " +
          "tarball. To extend them, pin a second tarball's sha256 from Mozilla's " +
          "releases/<version>/SHA256SUMS and teach archiveUrl() in bin/install-firefox.ts to pick " +
          "it (see docs/development.md).",
      });
    });
  }

  test("never downloads on an unsupported platform", async () => {
    const root = makeTempDirectory("install-firefox-root-");
    const { download, calls } = copyingDownload("/nonexistent");

    await assert.rejects(
      ensureFirefox({
        pin: { version: "156.0.1", sha256: ANY_SHA },
        root,
        platform: "darwin",
        arch: "arm64",
        download,
        log: silentLog().log,
      }),
      /only on linux x64/,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(root), []);
  });
});

describe("bin/install-firefox.ts ensureFirefox", () => {
  test("downloads, verifies, extracts and returns the binary, leaving no temp files", async () => {
    const fixture = makeFixtureArchive();
    const root = join(makeTempDirectory("install-firefox-root-"), "cache", "foxleash-firefox");
    const { download, calls } = copyingDownload(fixture.archive);
    const { log, lines } = silentLog();

    const binary = await ensureFirefox({
      pin: { version: "156.0.1", sha256: fixture.sha256 },
      root,
      ...LINUX,
      download,
      log,
    });

    assert.equal(binary, join(root, "156.0.1", "firefox", "firefox"));
    assert.equal(readFileSync(binary, "utf8"), fixture.content);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, archiveUrl("156.0.1"));
    assert.equal(dirname(calls[0]?.destination ?? ""), root);
    assert.match(calls[0]?.destination ?? "", /\/\.download-\d+-[0-9a-f]{12}\.tar\.xz$/);
    assert.ok(calls[0]?.destination.includes(`/.download-${process.pid}-`));
    assert.deepEqual(readdirSync(root), ["156.0.1"]);
    assert.deepEqual(lines, [
      `downloading Firefox 156.0.1 from ${archiveUrl("156.0.1")}`,
      `installed Firefox 156.0.1 at ${binary}`,
    ]);
  });

  test("rejects a checksum mismatch and leaves neither an install nor the download", async () => {
    const fixture = makeFixtureArchive();
    const root = makeTempDirectory("install-firefox-root-");
    const { download } = copyingDownload(fixture.archive);
    const wrong = "b".repeat(64);

    await assert.rejects(
      ensureFirefox({
        pinPath: PIN_PATHS.release,
        pin: { version: "156.0.1", sha256: wrong },
        root,
        ...LINUX,
        download,
        log: silentLog().log,
      }),
      {
        message:
          `Checksum mismatch for ${archiveUrl("156.0.1")}: expected ${wrong} (bin/firefox-version.json), ` +
          `got ${fixture.sha256}. The download has been deleted and nothing was installed.`,
      },
    );
    assert.deepEqual(readdirSync(root), []);
  });

  test("names the ESR pin file in a checksum mismatch of the ESR", async () => {
    const fixture = makeFixtureArchive();
    const root = makeTempDirectory("install-firefox-root-");
    const { download } = copyingDownload(fixture.archive);
    const wrong = "b".repeat(64);

    await assert.rejects(
      ensureFirefox({
        pinPath: PIN_PATHS.esr,
        pin: { version: "153.7.0esr", sha256: wrong },
        root,
        ...LINUX,
        download,
        log: silentLog().log,
      }),
      {
        message:
          `Checksum mismatch for ${archiveUrl("153.7.0esr")}: expected ${wrong} (bin/firefox-esr-version.json), ` +
          `got ${fixture.sha256}. The download has been deleted and nothing was installed.`,
      },
    );
    assert.deepEqual(readdirSync(root), []);
  });

  test("never extracts an archive whose checksum is wrong", async () => {
    const fixture = makeFixtureArchive();
    const root = makeTempDirectory("install-firefox-root-");
    const extracted: string[] = [];

    await assert.rejects(
      ensureFirefox({
        pin: { version: "156.0.1", sha256: "b".repeat(64) },
        root,
        ...LINUX,
        download: copyingDownload(fixture.archive).download,
        extract: (archive) => {
          extracted.push(archive);
        },
        log: silentLog().log,
      }),
      /Checksum mismatch/,
    );
    assert.deepEqual(extracted, []);
  });

  test("reuses an installed pin without fetching", async () => {
    const root = makeTempDirectory("install-firefox-root-");
    const binary = makeInstalled(root, "156.0.1");
    const { download, calls } = copyingDownload("/nonexistent");
    const { log, lines } = silentLog();

    assert.equal(
      await ensureFirefox({
        pin: { version: "156.0.1", sha256: ANY_SHA },
        root,
        ...LINUX,
        download,
        log,
      }),
      binary,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(lines, []);
  });

  test("reads the pin from the given pin file by default", async () => {
    const root = makeTempDirectory("install-firefox-root-");
    const binary = makeInstalled(root, readPin(PIN_PATHS.esr).version);
    const { download, calls } = copyingDownload("/nonexistent");

    assert.equal(
      await ensureFirefox({
        pinPath: PIN_PATHS.esr,
        root,
        ...LINUX,
        download,
        log: silentLog().log,
      }),
      binary,
    );
    assert.deepEqual(calls, []);
  });

  test("sweeps a stale download on the installed path too, and leaves a fresh one", async () => {
    // Once an install exists every run takes this path, so it is the only place a download a
    // killed run left behind can still be removed.
    const root = makeTempDirectory("install-firefox-root-");
    const binary = makeInstalled(root, "156.0.1");
    const stale = ".download-1-aaaaaaaaaaaa.tar.xz";
    const fresh = ".download-2-bbbbbbbbbbbb.tar.xz";
    writeFileSync(join(root, stale), "left by a killed run");
    writeFileSync(join(root, fresh), "another checkout, downloading now");
    setAge(join(root, stale), Date.now() - 2 * STALE_TEMP_MS);
    const { log, lines } = silentLog();

    assert.equal(
      await ensureFirefox({
        pin: { version: "156.0.1", sha256: ANY_SHA },
        root,
        ...LINUX,
        download: copyingDownload("/nonexistent").download,
        log,
      }),
      binary,
    );
    assert.deepEqual(tempEntries(root), [fresh]);
    assert.deepEqual(lines, [`removed ${stale}, left behind by an interrupted install`]);
  });

  test("counts losing the rename race to a finished install as success", async () => {
    const fixture = makeFixtureArchive("ours");
    const root = makeTempDirectory("install-firefox-root-");
    const binary = firefoxBinaryPath(root, "156.0.1");

    const result = await ensureFirefox({
      pin: { version: "156.0.1", sha256: fixture.sha256 },
      root,
      ...LINUX,
      download: copyingDownload(fixture.archive).download,
      extract: (archive, directory) => {
        extractArchive(archive, directory);
        // Another checkout finishes its install while this one extracts.
        makeInstalled(root, "156.0.1", "theirs");
      },
      log: silentLog().log,
    });

    assert.equal(result, binary);
    assert.equal(readFileSync(binary, "utf8"), "theirs");
    assert.deepEqual(readdirSync(root), ["156.0.1"]);
  });

  test("fails when the version directory is taken by a broken install", async () => {
    const fixture = makeFixtureArchive();
    const root = makeTempDirectory("install-firefox-root-");
    mkdirSync(join(root, "156.0.1", "leftover"), { recursive: true });

    await assert.rejects(
      ensureFirefox({
        pin: { version: "156.0.1", sha256: fixture.sha256 },
        root,
        ...LINUX,
        download: copyingDownload(fixture.archive).download,
        log: silentLog().log,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^Could not move Firefox into .*\/156\.0\.1: .*ENOTEMPTY.*\. If that directory is a broken install, delete it and run again\.$/,
        );
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
    assert.deepEqual(tempEntries(root), []);
  });

  test("fails clearly when the tarball layout changes", async () => {
    const fixture = makeFixtureArchive();
    const root = makeTempDirectory("install-firefox-root-");

    await assert.rejects(
      ensureFirefox({
        pin: { version: "156.0.1", sha256: fixture.sha256 },
        root,
        ...LINUX,
        download: copyingDownload(fixture.archive).download,
        extract: (_archive, directory) => {
          mkdirSync(join(directory, "firefox-nightly", "firefox"), { recursive: true });
        },
        log: silentLog().log,
      }),
      {
        message: `${archiveUrl("156.0.1")} did not unpack to firefox/firefox; the tarball layout changed, so bin/install-firefox.ts needs updating.`,
      },
    );
    assert.deepEqual(readdirSync(root), []);
  });

  test("cleans up after a failed download", async () => {
    const root = makeTempDirectory("install-firefox-root-");

    await assert.rejects(
      ensureFirefox({
        pin: { version: "156.0.1", sha256: ANY_SHA },
        root,
        ...LINUX,
        download: async (_url, destination) => {
          writeFileSync(destination, "partial");
          throw new Error("connection reset");
        },
        log: silentLog().log,
      }),
      { message: "connection reset" },
    );
    assert.deepEqual(readdirSync(root), []);
  });

  test("reports the download error itself when no file was written", async () => {
    const root = makeTempDirectory("install-firefox-root-");

    await assert.rejects(
      ensureFirefox({
        pin: { version: "156.0.1", sha256: ANY_SHA },
        root,
        ...LINUX,
        download: async () => {
          throw new Error("getaddrinfo ENOTFOUND archive.mozilla.org");
        },
        log: silentLog().log,
      }),
      { message: "getaddrinfo ENOTFOUND archive.mozilla.org" },
    );
    assert.deepEqual(readdirSync(root), []);
  });

  test("sweeps stale temp entries before installing, and says so on stderr", async (t) => {
    const fixture = makeFixtureArchive();
    const root = makeTempDirectory("install-firefox-root-");
    const stale = join(root, ".download-1-aaaaaaaaaaaa.tar.xz");
    writeFileSync(stale, "left by a killed run");
    setAge(stale, Date.now() - 2 * STALE_TEMP_MS);
    // No `log` seam: the default one, which writes to stderr, is the one under test here.
    const printed: unknown[] = [];
    t.mock.method(console, "error", (line: unknown) => {
      printed.push(line);
    });

    await ensureFirefox({
      pin: { version: "156.0.1", sha256: fixture.sha256 },
      root,
      ...LINUX,
      download: copyingDownload(fixture.archive).download,
    });
    t.mock.restoreAll();

    assert.equal(existsSync(stale), false);
    assert.equal(
      printed[0],
      "[install-firefox] removed .download-1-aaaaaaaaaaaa.tar.xz, left behind by an interrupted install",
    );
  });
});

describe("bin/install-firefox.ts sweepStaleTemps", () => {
  test("keeps an entry exactly at the age bound and removes one a millisecond past it", () => {
    const root = makeTempDirectory("install-firefox-sweep-");
    const mtimeMs = 1_700_000_000_000;
    const entry = join(root, ".download-9-edge.tar.xz");
    writeFileSync(entry, "");
    setAge(entry, mtimeMs);
    const atBound = mtimeMs + STALE_TEMP_MS;

    assert.deepEqual(sweepStaleTemps(root, { now: atBound }), []);
    assert.equal(existsSync(entry), true);
    assert.deepEqual(sweepStaleTemps(root, { now: atBound + 1 }), [".download-9-edge.tar.xz"]);
    assert.equal(existsSync(entry), false);
  });

  test("takes its bound from the caller", () => {
    const root = makeTempDirectory("install-firefox-sweep-");
    const entry = join(root, ".extract-short");
    mkdirSync(entry);
    setAge(entry, 1_700_000_000_000);

    assert.deepEqual(sweepStaleTemps(root, { now: 1_700_000_000_011, maxAgeMs: 10 }), [
      ".extract-short",
    ]);
  });

  test("measures age against the current time by default", () => {
    const root = makeTempDirectory("install-firefox-sweep-");
    const old = join(root, ".download-3-old.tar.xz");
    const fresh = join(root, ".download-4-fresh.tar.xz");
    writeFileSync(old, "");
    writeFileSync(fresh, "");
    setAge(old, Date.now() - STALE_TEMP_MS - 60_000);

    assert.deepEqual(sweepStaleTemps(root), [".download-3-old.tar.xz"]);
    assert.deepEqual(readdirSync(root), [".download-4-fresh.tar.xz"]);
  });

  test("skips an entry it cannot stat instead of reporting it removed", () => {
    // A dangling symlink stats as ENOENT, the same answer as an entry another run removed
    // between the directory listing and the stat.
    const root = makeTempDirectory("install-firefox-sweep-");
    symlinkSync(join(root, "nowhere"), join(root, ".extract-vanished"));

    assert.deepEqual(sweepStaleTemps(root, { now: Date.now() + 10 * STALE_TEMP_MS }), []);
    assert.deepEqual(readdirSync(root), [".extract-vanished"]);
  });

  test("removes old temp entries and leaves fresh ones and everything else alone", () => {
    const root = makeTempDirectory("install-firefox-sweep-");
    const now = Date.now();
    const oldMs = now - STALE_TEMP_MS - 60_000;
    const freshMs = now - STALE_TEMP_MS + 60_000;

    const oldDownload = join(root, ".download-1-old.tar.xz");
    const freshDownload = join(root, ".download-2-fresh.tar.xz");
    const oldExtract = join(root, ".extract-old");
    const freshExtract = join(root, ".extract-fresh");
    const oldInstall = join(root, "155.0");
    const oldOther = join(root, ".other-old");
    writeFileSync(oldDownload, "");
    writeFileSync(freshDownload, "");
    mkdirSync(join(oldExtract, "firefox"), { recursive: true });
    mkdirSync(freshExtract);
    mkdirSync(oldInstall);
    writeFileSync(oldOther, "");
    for (const path of [oldDownload, oldExtract, oldInstall, oldOther]) setAge(path, oldMs);
    for (const path of [freshDownload, freshExtract]) setAge(path, freshMs);

    const removed = sweepStaleTemps(root, { now });

    assert.deepEqual(removed.sort(), [".download-1-old.tar.xz", ".extract-old"]);
    assert.deepEqual(readdirSync(root).sort(), [
      ".download-2-fresh.tar.xz",
      ".extract-fresh",
      ".other-old",
      "155.0",
    ]);
  });
});

describe("bin/install-firefox.ts real I/O helpers", () => {
  test("hashes a file with sha256", async () => {
    const file = join(makeTempDirectory("install-firefox-hash-"), "data");
    writeFileSync(file, "abc");

    assert.equal(
      await sha256File(file),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("extracts a tarball into the directory", () => {
    const fixture = makeFixtureArchive("extracted");
    const directory = makeTempDirectory("install-firefox-tar-");

    extractArchive(fixture.archive, directory);

    assert.equal(readFileSync(join(directory, "firefox", "firefox"), "utf8"), "extracted");
  });

  test("fails clearly when tar cannot be started", () => {
    const empty = makeTempDirectory("install-firefox-path-");
    const savedPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      assert.throws(
        () => extractArchive("/x/a.tar.xz", "/x"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "tar -xJf /x/a.tar.xz failed: spawnSync tar ENOENT");
          assert.ok(error.cause instanceof Error);
          return true;
        },
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("reports what tar said when extraction fails", () => {
    const directory = makeTempDirectory("install-firefox-tar-");
    const missing = join(directory, "missing.tar.xz");

    assert.throws(
      () => extractArchive(missing, directory),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^tar -xJf .*missing\.tar\.xz exited 2: \S.*missing\.tar\.xz/);
        assert.doesNotMatch(error.message, /\n$/);
        return true;
      },
    );
  });

  test("names the signal when tar is killed", () => {
    const bin = makeTempDirectory("install-firefox-path-");
    writeFileSync(join(bin, "tar"), "#!/bin/sh\nkill -KILL $$\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      assert.throws(() => extractArchive("/x/a.tar.xz", "/x"), {
        message: "tar -xJf /x/a.tar.xz exited on signal SIGKILL: ",
      });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("gives up on a tar that does not finish within its bound", () => {
    // tar blocks opening a FIFO that has no writer, so only the bound can end the call.
    const directory = makeTempDirectory("install-firefox-fifo-");
    const fifo = join(directory, "archive.tar.xz");
    const made = spawnSync("mkfifo", [fifo]);
    assert.equal(made.status, 0);
    const started = Date.now();
    try {
      assert.throws(() => extractArchive(fifo, directory, 200), {
        message: `tar -xJf ${fifo} failed: spawnSync tar ETIMEDOUT`,
      });
      assert.ok(Date.now() - started < 10_000);
    } finally {
      // tar's own child is still blocked opening the FIFO; a writer that opens and closes it ends
      // that child with an empty archive. ENXIO means no reader is left.
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // Nothing left to unblock.
      }
    }
  });

  describe("downloadArchive against a local server", () => {
    let server: Server;
    let base = "";

    before(async () => {
      server = createServer((request, response) => {
        if (request.url === "/ok") {
          response.writeHead(200);
          response.end("tarball bytes");
          return;
        }
        if (request.url === "/empty") {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.url === "/stall") {
          response.writeHead(200, { "Content-Length": "100" });
          response.write("a few bytes");
          return;
        }
        response.writeHead(404);
        response.end("nope");
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      server.listen(0, "127.0.0.1", resolve);
      await promise;
      const address: AddressInfo | string | null = server.address();
      assert.ok(address !== null && typeof address === "object");
      base = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      server.closeAllConnections();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    });

    test("streams the body to the destination", async () => {
      const destination = join(makeTempDirectory("install-firefox-dl-"), "out");

      await downloadArchive(`${base}/ok`, destination);

      assert.equal(readFileSync(destination, "utf8"), "tarball bytes");
    });

    test("fails with the status and the URL on a non-2xx answer", async () => {
      const destination = join(makeTempDirectory("install-firefox-dl-"), "out");

      await assert.rejects(downloadArchive(`${base}/missing`, destination), {
        message: `Download failed: HTTP 404 for ${base}/missing`,
      });
      assert.equal(existsSync(destination), false);
    });

    test("fails on an answer without a body", async () => {
      const destination = join(makeTempDirectory("install-firefox-dl-"), "out");

      await assert.rejects(downloadArchive(`${base}/empty`, destination), {
        message: `Download failed: HTTP 204 for ${base}/empty`,
      });
      assert.equal(existsSync(destination), false);
    });

    test("gives up on a body that stalls past its bound", async () => {
      const destination = join(makeTempDirectory("install-firefox-dl-"), "out");
      const started = Date.now();

      await assert.rejects(downloadArchive(`${base}/stall`, destination, 200), {
        name: "TimeoutError",
      });
      assert.ok(Date.now() - started < 10_000);
    });
  });
});

// The script refuses any other platform before it looks at its cache.
const SCRIPT_PLATFORM = process.platform === "linux" && process.arch === "x64";

describe("bin/install-firefox.ts as a script", {
  skip: SCRIPT_PLATFORM ? false : "the script runs only on linux x64",
}, () => {
  test("prints the installed binary path, from the cache under XDG_CACHE_HOME", () => {
    // An installed pin, so the script runs end to end without the network.
    const cache = makeTempDirectory("install-firefox-xdg-");
    const binary = makeInstalled(
      join(cache, "foxleash-firefox"),
      readPin(PIN_PATHS.release).version,
      "",
    );

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: scriptEnv(cache),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${binary}\n`);
  });

  test("exits 1 with the reason when it cannot install", () => {
    // XDG_CACHE_HOME is a FILE, so creating the cache directory fails before any download.
    const notADirectory = join(makeTempDirectory("install-firefox-xdg-"), "file");
    writeFileSync(notADirectory, "");

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: scriptEnv(notADirectory),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[install-firefox\] ENOTDIR/);
  });

  test("prints the ESR binary path when FOXLEASH_E2E_FIREFOX is esr", () => {
    const cache = makeTempDirectory("install-firefox-xdg-");
    const binary = makeInstalled(
      join(cache, "foxleash-firefox"),
      readPin(PIN_PATHS.esr).version,
      "",
    );

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { ...scriptEnv(cache), FOXLEASH_E2E_FIREFOX: "esr" },
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${binary}\n`);
  });

  test("exits 1 naming the variable when FOXLEASH_E2E_FIREFOX is unknown", () => {
    const cache = makeTempDirectory("install-firefox-xdg-");

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { ...scriptEnv(cache), FOXLEASH_E2E_FIREFOX: "beta" },
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      '[install-firefox] FOXLEASH_E2E_FIREFOX must be "release" or "esr" (unset or empty means "release"), got "beta".\n',
    );
  });
});

/**
 * The script's environment: the given XDG_CACHE_HOME, a temp HOME and a proxy that refuses every
 * connection, so a script that looks for its cache in the wrong place fails fast instead of
 * downloading Firefox into the real cache.
 */
function scriptEnv(cacheHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: makeTempDirectory("install-firefox-home-"),
    XDG_CACHE_HOME: cacheHome,
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: REFUSING_PROXY,
    https_proxy: REFUSING_PROXY,
    HTTP_PROXY: REFUSING_PROXY,
    http_proxy: REFUSING_PROXY,
  };
  delete env.NO_PROXY;
  delete env.no_proxy;
  delete env.FOXLEASH_E2E_FIREFOX;
  return env;
}
