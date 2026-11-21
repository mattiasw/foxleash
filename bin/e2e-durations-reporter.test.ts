import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { TestEvent } from "node:test/reporters";
import { reportDurations } from "./e2e-durations-reporter.ts";

// The default export writes the bin/e2e-durations.json next to it, so these tests drive
// `reportDurations` with a fake clock, file read and write, and run the default export only from
// a copy in a temporary root.

const ROOT = "/repo";
const DURATIONS_PATH = join(ROOT, "bin/e2e-durations.json");
const FILES = ["e2e/a.test.ts", "e2e/b.test.ts", "e2e/c.test.ts"];

type Step = [time: number, event: TestEvent];
type Counts = { failed?: number; cancelled: number };

describe("reportDurations", () => {
  test("times each file from the previous file's last event to its own", async () => {
    const run = await measure(
      [
        [1000, plan()],
        [1001, enqueue("a")],
        [1002, enqueue("c")],
        [1100, start("a")],
        [3449, complete("a")],
        [3500, start("c")],
        [8000, complete("c")],
        [8001, diagnostic("c")],
        [9000, summary({ success: true })],
      ],
      { start: 1000 },
    );
    assert.deepEqual(run.writes, [
      [DURATIONS_PATH, '{\n  "e2e/a.test.ts": 2.4,\n  "e2e/c.test.ts": 4.6\n}\n'],
    ]);
    assert.deepEqual(run.lines, [
      "e2e durations: wrote bin/e2e-durations.json; files measured: 2, seconds: 7\n",
    ]);
  });

  test("ignores an early enqueue of a later file, and events without a file", async () => {
    const run = await measure(
      [
        [1003, enqueue("b")],
        [1004, enqueue("a")],
        [2000, complete("b")],
        [2600, diagnostic()],
        [2700, plan()],
        [3000, complete("a")],
        [3010, summary({ success: true })],
      ],
      { start: 1000 },
    );
    assert.deepEqual(run.writes, [
      [DURATIONS_PATH, '{\n  "e2e/a.test.ts": 1,\n  "e2e/b.test.ts": 1\n}\n'],
    ]);
  });

  test("writes sorted keys, one decimal and at least 0.1 s", async () => {
    const run = await measure(
      [
        [1030, complete("c")],
        [1080, complete("b")],
        [13_534, complete("a")],
        [14_000, summary({ success: true })],
      ],
      { start: 1000 },
    );
    assert.deepEqual(run.writes, [
      [
        DURATIONS_PATH,
        '{\n  "e2e/a.test.ts": 12.5,\n  "e2e/b.test.ts": 0.1,\n  "e2e/c.test.ts": 0.1\n}\n',
      ],
    ]);
    assert.deepEqual(run.lines, [
      "e2e durations: wrote bin/e2e-durations.json; files measured: 3, seconds: 12.7\n",
    ]);
  });

  test("keeps unmeasured listed entries, replaces measured ones, drops the rest", async () => {
    const run = await measure(
      [
        [1500, complete("a")],
        [2000, complete("other")],
        [3000, complete("b")],
        [3001, summary({ success: true })],
      ],
      {
        start: 1000,
        existing:
          '{ "e2e/a.test.ts": 50, "e2e/c.test.ts": 7, "e2e/gone.test.ts": 3, "e2e/old.test.ts": 4 }',
      },
    );
    assert.deepEqual(run.reads, [DURATIONS_PATH]);
    assert.deepEqual(run.writes, [
      [
        DURATIONS_PATH,
        '{\n  "e2e/a.test.ts": 0.5,\n  "e2e/b.test.ts": 1,\n  "e2e/c.test.ts": 7\n}\n',
      ],
    ]);
    assert.deepEqual(run.lines, [
      "e2e durations: wrote bin/e2e-durations.json; files measured: 2, seconds: 1.5, stale entries dropped: 2\n",
    ]);
  });

  test("writes nothing when no listed e2e file ran", async () => {
    const run = await measure([
      [1500, complete("other")],
      [1600, summary({ success: true })],
    ]);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.lines, ["e2e durations: not written; no e2e test file ran\n"]);
  });

  test("writes nothing when the run failed, saying how many tests failed", async () => {
    const run = await measure([
      [1500, complete("a")],
      [1600, fail("b")],
      [1700, summary({ success: false, counts: { failed: 2, cancelled: 1 } })],
    ]);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.lines, ["e2e durations: not written; tests failed: 3\n"]);
  });

  test("counts cancelled tests alone when the summary has no failed count", async () => {
    const run = await measure([
      [1500, complete("a")],
      [1700, summary({ success: false, counts: { cancelled: 2 } })],
    ]);
    assert.deepEqual(run.lines, ["e2e durations: not written; tests failed: 2\n"]);
  });

  test("writes when a failing todo test sent test:fail in a green run", async () => {
    const run = await measure(
      [
        [1500, fail("a")],
        [2000, complete("a")],
        [2100, summary({ success: true })],
      ],
      { start: 1000 },
    );
    assert.deepEqual(run.writes, [[DURATIONS_PATH, '{\n  "e2e/a.test.ts": 1\n}\n']]);
  });

  test("writes nothing when the run did not finish", async () => {
    for (const steps of [
      [[1500, complete("a")]],
      [
        [1500, complete("a")],
        [1600, summary({ success: true, file: "a" })],
      ],
    ] satisfies Step[][]) {
      const run = await measure(steps);
      assert.deepEqual(run.writes, []);
      assert.deepEqual(run.lines, ["e2e durations: not written; the run did not finish\n"]);
    }
  });

  test("refuses an invalid durations file before it takes the first event", async () => {
    let pulled = 0;
    async function* source(): AsyncGenerator<TestEvent> {
      pulled += 1;
      yield plan();
    }
    const lines = reportDurations(source(), {
      now: () => 0,
      read: () => "{",
      write: () => assert.fail("wrote the durations file"),
      root: ROOT,
      files: FILES,
    });
    await assert.rejects(lines.next(), /^Error: bin\/e2e-durations\.json: cannot read/);
    assert.equal(pulled, 0);
  });
});

describe("the reporter run by node --test", () => {
  const temporaryDirectories: string[] = [];
  after(() => {
    for (const directory of temporaryDirectories)
      rmSync(directory, { recursive: true, force: true });
  });

  test("measures the files of a green run into the durations file next to it", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-durations-reporter-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "e2e"));
    for (const script of ["e2e-shard.ts", "e2e-durations-reporter.ts"]) {
      copyFileSync(join(import.meta.dirname, script), join(root, "bin", script));
    }
    writeFileSync(join(root, "bin", "e2e-durations.json"), "{}\n");
    writeFileSync(
      join(root, "e2e", "one.test.ts"),
      'import { test } from "node:test";\ntest("passes", () => {});\n',
    );
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=./bin/e2e-durations-reporter.ts",
        "e2e/one.test.ts",
      ],
      { cwd: root, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const written: unknown = JSON.parse(
      readFileSync(join(root, "bin", "e2e-durations.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(written ?? {}), ["e2e/one.test.ts"]);
    const seconds: unknown = Reflect.get(written ?? {}, "e2e/one.test.ts");
    assert.ok(typeof seconds === "number" && seconds > 0, String(seconds));
  });
});

async function measure(
  steps: readonly Step[],
  { start = 0, existing = "{}" }: { start?: number; existing?: string } = {},
): Promise<{ lines: string[]; reads: string[]; writes: [string, string][] }> {
  let time = start;
  const reads: string[] = [];
  const writes: [string, string][] = [];
  async function* source(): AsyncGenerator<TestEvent> {
    for (const [at, event] of steps) {
      time = at;
      yield event;
    }
  }
  const lines: string[] = [];
  for await (const line of reportDurations(source(), {
    now: () => time,
    read: (path) => {
      reads.push(path);
      return existing;
    },
    write: (path, text) => {
      writes.push([path, text]);
    },
    root: ROOT,
    files: FILES,
  })) {
    lines.push(line);
  }
  return { lines, reads, writes };
}

function path(name: string): string {
  return join(ROOT, "e2e", `${name}.test.ts`);
}

function plan(): TestEvent {
  return { type: "test:plan", data: { nesting: 0, count: 1 } };
}

function diagnostic(name?: string): TestEvent {
  const data = { message: "note", nesting: 0, level: "info" } as const;
  return {
    type: "test:diagnostic",
    data: name === undefined ? data : { ...data, file: path(name) },
  };
}

function enqueue(name: string): TestEvent {
  return {
    type: "test:enqueue",
    data: {
      file: path(name),
      name,
      nesting: 0,
      parentId: undefined,
      tags: [],
      testId: 1,
      type: "test",
    },
  };
}

function start(name: string): TestEvent {
  return {
    type: "test:start",
    data: { file: path(name), name, nesting: 0, parentId: undefined, tags: [], testId: 1 },
  };
}

function complete(name: string): TestEvent {
  return {
    type: "test:complete",
    data: {
      file: path(name),
      name: path(name),
      nesting: 0,
      parentId: undefined,
      tags: [],
      testId: 1,
      testNumber: 1,
      details: { passed: true, duration_ms: 1 },
    },
  };
}

function fail(name: string): TestEvent {
  return {
    type: "test:fail",
    data: {
      file: path(name),
      name,
      nesting: 0,
      parentId: undefined,
      tags: [],
      testId: 1,
      testNumber: 1,
      details: { duration_ms: 1, error: Object.assign(new Error("failed"), { cause: undefined }) },
    },
  };
}

function summary({
  success,
  counts = { failed: 0, cancelled: 0 },
  file,
}: {
  success: boolean;
  counts?: Counts;
  file?: string;
}): TestEvent {
  // Node 24 sends a `failed` count, which @types/node leaves out of the type. A number literal as
  // the `todo` value reads as a test marker to bin/check-test-markers.ts.
  const none = 0;
  const all = {
    tests: 1,
    passed: 1,
    skipped: none,
    suites: none,
    todo: none,
    topLevel: 1,
    ...counts,
  };
  return {
    type: "test:summary",
    data: {
      success,
      counts: all,
      duration_ms: 1,
      file: file === undefined ? undefined : path(file),
    },
  };
}
