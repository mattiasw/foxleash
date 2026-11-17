// Fetches the pinned Firefox the end-to-end tests run against: a fixed version, downloaded once
// into the user's own cache, no sudo, no system package, and never the machine's own Firefox,
// whose version floats.
//
// There are two pins: bin/firefox-version.json for the current release and
// bin/firefox-esr-version.json for the ESR. FOXLEASH_E2E_FIREFOX=esr selects the ESR; unset,
// empty or release selects the release. Each is plain JSON so CI can key its cache on hashFiles()
// of it. Each is raised by hand, as its own change (ADR 0003, ADR 0076); docs/development.md says
// how. The sha256 comes from Mozilla's SHA256SUMS for that release, never from the downloaded
// file.
//
// Usage: node bin/install-firefox.ts   (prints the Firefox binary path)
//        FOXLEASH_E2E_FIREFOX=esr node bin/install-firefox.ts

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Pin {
  version: string;
  sha256: string;
}

export const PIN_PATHS = {
  release: join(import.meta.dirname, "firefox-version.json"),
  esr: join(import.meta.dirname, "firefox-esr-version.json"),
};

/** The whole download, body included. The tarball is about 85 MB. */
export const DOWNLOAD_TIMEOUT_MS = 300_000;

/** `tar -xJf` of that tarball. */
export const EXTRACT_TIMEOUT_MS = 180_000;

/**
 * Temp entries older than this are leftovers of a killed run and are swept. A live install takes
 * seconds, so the bound keeps the sweep away from another checkout's download in progress.
 */
export const STALE_TEMP_MS = 60 * 60 * 1000;

export interface EnsureOptions {
  pinPath?: string;
  pin?: Pin;
  root?: string;
  platform?: string;
  arch?: string;
  download?: (url: string, destination: string) => Promise<void>;
  extract?: (archive: string, directory: string) => void;
  log?: (message: string) => void;
}

/**
 * Returns the path of the pinned Firefox binary, installing it first if it is not in the cache.
 *
 * Two checkouts may install at once. Each downloads and extracts under its own temp names inside
 * `root` (one filesystem, so the final rename is atomic), and whichever renames second finds the
 * version directory taken; if the binary is there, it lost a race to a finished install, which
 * is success.
 *
 * An installed binary is trusted without re-hashing: whoever can write to the user's cache
 * already owns the account.
 */
export async function ensureFirefox({
  pinPath = selectedPinPath(),
  pin = readPin(pinPath),
  root = cacheRoot(),
  platform = process.platform,
  arch = process.arch,
  download = downloadArchive,
  extract = extractArchive,
  log = defaultLog,
}: EnsureOptions = {}): Promise<string> {
  assertSupportedPlatform({ platform, arch });

  function sweep(): void {
    for (const name of sweepStaleTemps(root)) {
      log(`removed ${name}, left behind by an interrupted install`);
    }
  }

  const binary = firefoxBinaryPath(root, pin.version);
  if (existsSync(binary)) {
    // Swept here too: once an install exists every run returns here, so a download a killed run
    // left behind would otherwise stay until the pin changes.
    sweep();
    return binary;
  }

  mkdirSync(root, { recursive: true });
  sweep();

  const url = archiveUrl(pin.version);
  const archive = join(root, `.download-${process.pid}-${randomBytes(6).toString("hex")}.tar.xz`);
  let extractDir: string | null = null;
  try {
    log(`downloading Firefox ${pin.version} from ${url}`);
    await download(url, archive);

    const actual = await sha256File(archive);
    if (actual !== pin.sha256) {
      throw new Error(
        `Checksum mismatch for ${url}: expected ${pin.sha256} (${relative(dirname(import.meta.dirname), pinPath)}), got ${actual}. ` +
          "The download has been deleted and nothing was installed.",
      );
    }

    extractDir = mkdtempSync(join(root, ".extract-"));
    extract(archive, extractDir);
    if (!existsSync(join(extractDir, "firefox", "firefox"))) {
      throw new Error(
        `${url} did not unpack to firefox/firefox; the tarball layout changed, so bin/install-firefox.ts needs updating.`,
      );
    }

    try {
      // The rename moves extractDir, so the removal in `finally` then finds nothing there.
      renameSync(extractDir, join(root, pin.version));
    } catch (error: unknown) {
      if (!existsSync(binary)) {
        throw new Error(
          `Could not move Firefox into ${join(root, pin.version)}: ${messageOf(error)}. ` +
            "If that directory is a broken install, delete it and run again.",
          { cause: error },
        );
      }
      // Lost the race to another checkout's finished install.
    }
    log(`installed Firefox ${pin.version} at ${binary}`);
    return binary;
  } finally {
    rmSync(archive, { force: true });
    if (extractDir !== null) rmSync(extractDir, { recursive: true, force: true });
  }
}

/**
 * The pin FOXLEASH_E2E_FIREFOX selects. An unknown value throws, so a typo never quietly runs the
 * tests on the release.
 */
export function selectedPinPath({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): string {
  const value = env.FOXLEASH_E2E_FIREFOX;
  if (value === undefined || value === "" || value === "release") return PIN_PATHS.release;
  if (value === "esr") return PIN_PATHS.esr;
  throw new Error(
    `FOXLEASH_E2E_FIREFOX must be "release" or "esr" (unset or empty means "release"), got ${JSON.stringify(value)}.`,
  );
}

export function readPin(
  path = PIN_PATHS.release,
  { read = readUtf8 }: { read?: (path: string) => string } = {},
): Pin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch (error: unknown) {
    throw new Error(`${path}: cannot read the Firefox pin: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return validatePin(parsed, path);
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Checks the shape of the pin, so a typo fails here rather than as a 404 or as a checksum
 * mismatch that reads like a supply-chain problem.
 */
export function validatePin(pin: unknown, source = PIN_PATHS.release): Pin {
  if (typeof pin !== "object" || pin === null) {
    throw new Error(`${source}: expected an object with version and sha256.`);
  }
  const version: unknown = Reflect.get(pin, "version");
  const sha256: unknown = Reflect.get(pin, "sha256");
  if (typeof version !== "string" || !/^\d+\.\d+(\.\d+)?(esr)?$/.test(version)) {
    throw new Error(
      `${source}: "version" must be a Firefox release number such as 160.0.1 or 153.7.0esr, got ${JSON.stringify(version)}.`,
    );
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      `${source}: "sha256" must be 64 lowercase hex digits (from Mozilla's releases/${version}/SHA256SUMS), got ${JSON.stringify(sha256)}.`,
    );
  }
  return { version, sha256 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `${XDG_CACHE_HOME:-~/.cache}/foxleash-firefox`; an empty XDG_CACHE_HOME counts as unset. */
export function cacheRoot({
  env = process.env,
  homedir = osHomedir(),
}: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
} = {}): string {
  const base = env.XDG_CACHE_HOME || join(homedir, ".cache");
  return join(base, "foxleash-firefox");
}

function defaultLog(message: string): void {
  console.error(`[install-firefox] ${message}`);
}

/**
 * Only the linux-x86_64 tarball is pinned. Failing loudly rather than skipping: a suite that
 * silently does nothing on some machines is a green that proves nothing.
 */
export function assertSupportedPlatform({
  platform = process.platform,
  arch = process.arch,
}: {
  platform?: string;
  arch?: string;
} = {}): void {
  if (platform === "linux" && arch === "x64") return;
  throw new Error(
    `Foxleash's end-to-end tests run only on linux x64, and this is ${platform} ${arch}. ` +
      "bin/firefox-version.json and bin/firefox-esr-version.json pin only the linux-x86_64 " +
      "tarball. To extend them, pin a second tarball's sha256 from Mozilla's " +
      "releases/<version>/SHA256SUMS and teach archiveUrl() in bin/install-firefox.ts to pick " +
      "it (see docs/development.md).",
  );
}

/**
 * Removes `.download-*` and `.extract-*` entries a killed run left in `root`, but only those
 * older than `maxAgeMs`, so a concurrent install from another checkout is left alone. Returns the
 * names removed.
 */
export function sweepStaleTemps(
  root: string,
  { now = Date.now(), maxAgeMs = STALE_TEMP_MS }: { now?: number; maxAgeMs?: number } = {},
): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(".download-") && !name.startsWith(".extract-")) continue;
    const path = join(root, name);
    let mtimeMs: number;
    try {
      ({ mtimeMs } = statSync(path));
    } catch {
      // Gone between readdir and stat: another run finished with it.
      continue;
    }
    if (now - mtimeMs <= maxAgeMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function firefoxBinaryPath(root: string, version: string): string {
  return join(root, version, "firefox", "firefox");
}

/** The linux-x86_64 en-US tarball on Mozilla's release archive. */
export function archiveUrl(version: string): string {
  return `https://archive.mozilla.org/pub/firefox/releases/${version}/linux-x86_64/en-US/firefox-${version}.tar.xz`;
}

/** The default download: global fetch, the whole transfer bounded, the body streamed to disk. */
export async function downloadArchive(
  url: string,
  destination: string,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/** Streaming sha256 of a file, as lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The default extraction: the system's `tar`, bounded. */
export function extractArchive(
  archive: string,
  directory: string,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): void {
  const result = spawnSync("tar", ["-xJf", archive, "-C", directory], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    throw new Error(`tar -xJf ${archive} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `tar -xJf ${archive} exited ${result.status ?? `on signal ${result.signal}`}: ${result.stderr.trim()}`,
    );
  }
}

async function main(): Promise<void> {
  try {
    console.log(await ensureFirefox());
  } catch (error: unknown) {
    console.error(`[install-firefox] ${messageOf(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
