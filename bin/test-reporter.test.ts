import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

// Each case runs a real `node --test` with this reporter over fixture test files in a temp
// directory, as the package test scripts do.

const REPORTER = join(import.meta.dirname, "test-reporter.ts");

describe("test reporter", () => {
  let dir = "";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "foxleash-test-reporter-"));
    writeFileSync(
      join(dir, "lib.ts"),
      [
        "export function sign(x: number): number {",
        "  if (x > 0) return 1;",
        "  return -1;",
        "}",
        "export function unused(): number {",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "green.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { sign } from "./lib.ts";',
        'test("a passing test", () => {',
        '  console.log("chatter from a passing test");',
        "  assert.equal(sign(1), 1);",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "red.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, test } from "node:test";',
        'describe("outer", () => {',
        '  describe("inner", () => {',
        '    test("compares", () => {',
        '      console.error("stderr from the failing test");',
        "      assert.deepEqual({ list: [1, 2] }, { list: [1, 3] });",
        "    });",
        '    test("passes", () => {});',
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "noted.test.ts"),
      [
        'import { describe, test } from "node:test";',
        'describe("suite", () => {',
        '  test("timed", (t) => {',
        '    t.diagnostic("took 123 ms");',
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "crash.test.ts"), 'throw new Error("broken at load");\n');
    writeFileSync(
      join(dir, "late.test.ts"),
      [
        'import { test } from "node:test";',
        'test("throws after it ended", () => {',
        '  setTimeout(() => { throw new Error("thrown late"); }, 10);',
        "});",
        'test("outlasts it", async () => {',
        "  await new Promise((resolve) => setTimeout(resolve, 100));",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "hung-test.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, test } from "node:test";',
        'describe("hung suite", () => {',
        '  test("fails first", () => {',
        '    assert.fail("failed before the hang");',
        "  });",
        '  test("never ends", async () => {',
        "    setInterval(() => {}, 1000);",
        "    await new Promise(() => {});",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "hung-hook.test.ts"),
      [
        'import { after, describe, test } from "node:test";',
        'describe("hooked suite", () => {',
        "  after(async () => {",
        "    setInterval(() => {}, 1000);",
        "    await new Promise(() => {});",
        "  });",
        '  test("passes", () => {});',
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "hung-loud.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { describe, test } from "node:test";',
        'describe("loud suite", () => {',
        "  for (let i = 0; i < 300; i += 1) {",
        '    test("fails " + i, () => {',
        '      console.log("x".repeat(2000));',
        '      assert.fail("failure " + i);',
        "    });",
        "  }",
        '  test("never ends", async () => {',
        "    setInterval(() => {}, 1000);",
        "    await new Promise(() => {});",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    // A second reporter, fed by the same parent process: once a line is in its file, the reporter
    // under test has seen that event too.
    writeFileSync(
      join(dir, "progress.mjs"),
      [
        "export default async function* progress(source) {",
        "  for await (const event of source) {",
        '    if (event.type === "test:dequeue" || event.type === "test:complete") {',
        '      yield event.type + " " + event.data.name + "\\n";',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(process.execPath, ["--test", `--test-reporter=${REPORTER}`, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: testEnv(),
    });
  }

  /** Runs `fixture`, sends SIGTERM once the run has reported `line`, and returns its stdout. */
  async function interrupted(line: string, fixture: string): Promise<string> {
    const progress = join(dir, `${fixture}.progress`);
    const child = spawn(
      process.execPath,
      [
        "--test",
        `--test-reporter=${REPORTER}`,
        "--test-reporter-destination=stdout",
        "--test-reporter=./progress.mjs",
        `--test-reporter-destination=${progress}`,
        fixture,
      ],
      { cwd: dir, env: testEnv(), timeout: 30_000 },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const closed = once(child, "close");
    try {
      await waitForLine(progress, line);
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
    return stdout;
  }

  async function waitForLine(file: string, line: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!existsSync(file) || !readFileSync(file, "utf8").split("\n").includes(line)) {
      if (Date.now() > deadline) throw new Error(`no "${line}" in ${file}`);
      await sleep(20);
    }
  }

  function testEnv(): NodeJS.ProcessEnv {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    return env;
  }

  test("a green run prints only the counts and the coverage totals", () => {
    const result = run("--experimental-test-coverage", "green.test.ts");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = result.stdout.split("\n");
    assert.equal(lines.length, 3, result.stdout);
    assert.equal(lines[2], "");
    assert.match(
      lines[0] ?? "",
      /^ℹ tests 1, suites 0, pass 1, fail 0, cancelled 0, skipped 0, todo 0, duration_ms [\d.]+$/,
    );
    assert.equal(lines[1], "ℹ coverage: lines 57.14%, branches 66.67%, functions 50.00%");
    assert.doesNotMatch(result.stdout, /chatter|a passing test/);
  });

  test("a green run prints a test's diagnostic under its file name", () => {
    const result = run("noted.test.ts");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /^ℹ noted\.test\.ts: took 123 ms\nℹ tests 1, suites 1, pass 1, fail 0, /,
    );
    assert.doesNotMatch(result.stdout, /coverage|captured test output/);
  });

  test("a run without coverage prints no coverage line", () => {
    const result = run("green.test.ts");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /coverage/);
  });

  test("a failing test is printed in full under its suites, with the captured output", () => {
    const result = run("red.test.ts", "green.test.ts");
    assert.equal(result.status, 1);
    const file = join(dir, "red.test.ts");
    assert.match(result.stdout, new RegExp(`✖ outer > inner > compares \\(${file}:5:5\\)\\n`));
    assert.match(result.stdout, /\+ {5}2\n.*- {5}3\n/s);
    assert.match(result.stdout, /operator: 'deepStrictEqual'/);
    assert.match(result.stdout, /at TestContext\.<anonymous> \(file:\/\/.*red\.test\.ts:7:14\)/);
    assert.doesNotMatch(result.stdout, /✖ outer > inner \(|✖ outer \(/);
    assert.doesNotMatch(result.stdout, /✖ .*passes/);
    assert.match(
      result.stdout,
      /--- captured test output \(stdout and stderr\) ---\n(.|\n)*stderr from the failing test/,
    );
    assert.match(result.stdout, /chatter from a passing test/);
    assert.match(result.stdout, /\n\nℹ tests 3, suites 2, pass 2, fail 1,/);
  });

  test("a red run prints a test's diagnostic too", () => {
    const result = run("red.test.ts", "noted.test.ts");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✖ outer > inner > compares /);
    assert.match(result.stdout, /\nℹ noted\.test\.ts: took 123 ms\nℹ tests 3, /);
  });

  test("a test file that crashes while loading shows the crash from its stderr", () => {
    const result = run("crash.test.ts");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✖ crash\.test\.ts \(/);
    assert.match(result.stdout, /captured test output(.|\n)*Error: broken at load/);
  });

  test("a warning from the runner keeps a line of its own, apart from the counts", () => {
    const result = run("late.test.ts");
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /\nℹ Error: Test "throws after it ended" at late\.test\.ts:2:1 generated asynchronous activity after the test ended\.[^\n]*\nℹ tests 3, /,
    );
  });

  test("a missed coverage floor prints the per-file table and the floor error", () => {
    const result = run(
      "--experimental-test-coverage",
      "--test-coverage-functions=90",
      "green.test.ts",
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ℹ start of coverage report\n/);
    assert.match(result.stdout, /ℹ lib\.ts +\| +57\.14 \| +66\.67 \| +50\.00 \| 3 6-7\n/);
    assert.match(
      result.stdout,
      /✖ Error: 50\.00% function coverage does not meet threshold of 90%\.\n/,
    );
    assert.doesNotMatch(result.stdout, /captured test output|chatter/);
  });

  test("a run ended by a signal prints the failures so far and the test that was running", async () => {
    const stdout = await interrupted("test:dequeue never ends", "hung-test.test.ts");
    const file = join(dir, "hung-test.test.ts");
    assert.match(stdout, new RegExp(`✖ hung suite > fails first \\(${file}`));
    assert.match(stdout, /failed before the hang/);
    assert.ok(
      stdout.startsWith(
        "\nInterrupted while running:\n  hung-test.test.ts: hung suite > never ends\n\n✖ ",
      ),
      stdout,
    );
  });

  test("a run ended by a signal names the running test even when its failures fill the pipe", async () => {
    const stdout = await interrupted("test:dequeue never ends", "hung-loud.test.ts");
    assert.ok(
      stdout.startsWith(
        "\nInterrupted while running:\n  hung-loud.test.ts: loud suite > never ends\n",
      ),
      stdout.slice(0, 2000),
    );
    assert.match(stdout, /✖ loud suite > fails 0 \(/);
  });

  test("a run ended by a signal in a suite's after hook points at the hooks after its last test", async () => {
    const stdout = await interrupted("test:complete passes", "hung-hook.test.ts");
    assert.equal(
      stdout,
      "\nInterrupted while running:\n  hung-hook.test.ts: after hooked suite > passes, a hook or the file's teardown (the file did not exit)\n",
    );
  });
});
