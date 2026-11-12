import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

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
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    return spawnSync(process.execPath, ["--test", `--test-reporter=${REPORTER}`, ...args], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
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
});
