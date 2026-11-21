// Prints the end-to-end test files a CI shard runs, one per line, for `npm run e2e` to pass to
// `node --test`. FOXLEASH_E2E_SHARD=<index>/<total> selects a shard; unset or empty prints every
// file. Files are dealt longest first, each to the shard with the least time so far, by the
// durations in bin/e2e-durations.json, which bin/e2e-durations-reporter.ts measures.
//
// Usage: node bin/e2e-shard.ts
//        FOXLEASH_E2E_SHARD=2/3 node bin/e2e-shard.ts

import { globSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const DURATIONS_FILE = "bin/e2e-durations.json";

const SHARD = /^([1-9]\d*)\/([1-9]\d*)$/;

function main(): void {
  const root = resolve(import.meta.dirname, "..");
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the CI e2e step sets it; no turbo task runs this
    const list = selectedFiles(root, process.env.FOXLEASH_E2E_SHARD);
    process.stdout.write(`${list.join("\n")}\n`);
  } catch (error: unknown) {
    process.stderr.write(`[e2e-shard] ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

function selectedFiles(root: string, spec: string | undefined): string[] {
  const files = listE2eFiles(root);
  // `node --test` given no file runs its default patterns over the whole repository.
  if (files.length === 0) throw new Error(`no e2e test files under ${join(root, "e2e")}.`);
  if (spec === undefined || spec === "") return files;
  const { index, total } = parseShard(spec);
  if (total > files.length) {
    throw new Error(
      `FOXLEASH_E2E_SHARD asks for ${total} shards, more than the ${files.length} e2e test files; got ${JSON.stringify(spec)}.`,
    );
  }
  return assignShards(files, readDurations(root), total)[index - 1] ?? [];
}

/** Every `*.test.ts` under `<root>/e2e`, as sorted repo-relative paths with `/` separators. */
export function listE2eFiles(root: string): string[] {
  return globSync("e2e/**/*.test.ts", { cwd: root })
    .map((path) => repoPath(root, join(root, path)))
    .sort();
}

/** `path` relative to `root`, with `/` separators on every platform. */
export function repoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function parseShard(spec: string): { index: number; total: number } {
  const match = SHARD.exec(spec);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (match === null || index > total) {
    throw new Error(
      `FOXLEASH_E2E_SHARD must be <index>/<total> with index from 1 to total, such as 2/3; got ${JSON.stringify(spec)}.`,
    );
  }
  return { index, total };
}

/** The seconds each e2e test file took, from bin/e2e-durations.json under `root`. */
export function readDurations(
  root: string,
  { read = readUtf8 }: { read?: (path: string) => string } = {},
): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(join(root, DURATIONS_FILE)));
  } catch (error: unknown) {
    throw new Error(`${DURATIONS_FILE}: cannot read the e2e durations: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${DURATIONS_FILE}: expected an object of e2e test files and their seconds, got ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}.`,
    );
  }
  const entries: [string, unknown][] = Object.entries(parsed);
  const durations: [string, number][] = [];
  for (const [file, seconds] of entries) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(
        `${DURATIONS_FILE}: ${JSON.stringify(file)} must have a number of seconds above 0, got ${JSON.stringify(seconds)}.`,
      );
    }
    durations.push([file, seconds]);
  }
  // A "__proto__" key stays an own property here; assigning it to an object would not.
  return Object.fromEntries(durations);
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deals `files` to `total` shards, longest first, each to the shard with the smallest summed
 * weight so far (the lowest index on a tie). A file's weight is its entry in `durations`, or the
 * mean of the listed files' entries, or 1 when none has one. The result depends only on the set
 * of files, not on their order, and each shard is sorted by path.
 */
export function assignShards(
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  total: number,
): string[][] {
  if (!Number.isInteger(total) || total < 1) {
    throw new RangeError(`the shard total must be a whole number of at least 1, got ${total}.`);
  }
  // Sorted first, so both the float sum of the mean and the order of equal weights (the sort
  // below is stable) are the same whatever order the files came in.
  const sorted = [...files].sort();
  const own = new Map(Object.entries(durations));
  const known = sorted.flatMap((file) => own.get(file) ?? []);
  const mean =
    known.length === 0 ? 1 : known.reduce((sum, seconds) => sum + seconds) / known.length;
  const weighted = sorted
    .map((file) => ({ file, weight: own.get(file) ?? mean }))
    .sort((a, b) => b.weight - a.weight);
  const shards = Array.from({ length: total }, (): { files: string[]; sum: number } => ({
    files: [],
    sum: 0,
  }));
  for (const { file, weight } of weighted) {
    const lightest = shards.reduce((least, shard) => (shard.sum < least.sum ? shard : least));
    lightest.files.push(file);
    lightest.sum += weight;
  }
  return shards.map((shard) => shard.files.sort());
}

if (import.meta.main) main();
