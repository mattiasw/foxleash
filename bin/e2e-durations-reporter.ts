// A `node --test` reporter that measures how long each end-to-end test file takes and records it
// in bin/e2e-durations.json, which bin/e2e-shard.ts deals the files to CI shards by:
//
//   FOXLEASH_TEST_REPORTER=./bin/e2e-durations-reporter.ts npm run e2e
//
// The e2e script runs one file at a time, so a file's time runs from the previous file's last
// event to its own last event, which arrives after the file's process exited. A run with a failed
// test, or one that did not finish, writes nothing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestEvent } from "node:test/reporters";
import { DURATIONS_FILE, listE2eFiles, readDurations, repoPath } from "./e2e-shard.ts";

type Summary = Extract<TestEvent, { type: "test:summary" }>["data"];

// An async generator function, as Node requires: it calls a reporter export that has
// `prototype.constructor` (a plain function has one) with `new` and no event stream.
export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const root = resolve(import.meta.dirname, "..");
  yield* reportDurations(source, {
    now: () => performance.now(),
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : "{}"),
    write: (path, text) => writeFileSync(path, text),
    root,
    files: listE2eFiles(root),
  });
}

/**
 * Yields one line of what it measured, after merging the measured seconds into the durations file
 * under `root`: measured files replace their entries, entries of the other `files` stay, and
 * entries for files not in `files` are dropped. `now` is in milliseconds.
 */
export async function* reportDurations(
  source: AsyncIterable<TestEvent>,
  {
    now,
    read,
    write,
    root,
    files,
  }: {
    now: () => number;
    read: (path: string) => string;
    write: (path: string, text: string) => void;
    root: string;
    files: readonly string[];
  },
): AsyncGenerator<string> {
  // Read first, so an invalid file stops the run before any test runs.
  const existing = Object.entries(readDurations(root, { read }));
  const start = now();
  const last = new Map<string, number>();
  let summary: Summary | undefined;
  for await (const event of source) {
    const file = event.data !== undefined && "file" in event.data ? event.data.file : undefined;
    if (typeof file === "string") last.set(file, now());
    // Node sends a summary for each file and, last, one without a file for the whole run.
    if (event.type === "test:summary" && event.data.file === undefined) summary = event.data;
  }
  if (summary === undefined) {
    yield "e2e durations: not written; the run did not finish\n";
    return;
  }
  // The run's verdict, not a `test:fail` event: a failing test marked todo sends one in a green
  // run.
  if (!summary.success) {
    yield `e2e durations: not written; tests failed: ${failedCount(summary.counts) + summary.counts.cancelled}\n`;
    return;
  }
  const listed = new Set(files);
  const measured = new Map<string, number>();
  let previous = start;
  for (const [file, time] of [...last].sort((a, b) => a[1] - b[1])) {
    const key = repoPath(root, file);
    if (listed.has(key)) measured.set(key, Math.max(0.1, Math.round((time - previous) / 100) / 10));
    previous = time;
  }
  if (measured.size === 0) {
    yield "e2e durations: not written; no e2e test file ran\n";
    return;
  }
  const kept = existing.filter(([file]) => listed.has(file) && !measured.has(file));
  const stale = existing.length - existing.filter(([file]) => listed.has(file)).length;
  const entries = [...kept, ...measured].sort(([a], [b]) => (a < b ? -1 : 1));
  write(join(root, DURATIONS_FILE), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
  let seconds = 0;
  for (const value of measured.values()) seconds += value;
  const dropped = stale === 0 ? "" : `, stale entries dropped: ${stale}`;
  yield `e2e durations: wrote ${DURATIONS_FILE}; files measured: ${measured.size}, seconds: ${Math.round(seconds * 10) / 10}${dropped}\n`;
}

// @types/node leaves `failed` out of the summary's counts; Node 24 sends it.
function failedCount(counts: object): number {
  const failed: unknown = Reflect.get(counts, "failed");
  return typeof failed === "number" ? failed : 0;
}
