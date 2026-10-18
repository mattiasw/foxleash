import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

// This file is itself a *.test.ts, so the guard scans its own lines: every marker is assembled
// at runtime with m(), and fixture newlines are written as escapes, never as line breaks.

const SCRIPT = path.resolve(import.meta.dirname, "check-test-integrity.sh");
const REJECTED = /focus or skip markers added/;
const PASSED = /check-test-integrity: OK/;

describe("check-test-integrity.sh", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "test-integrity-"));
    makeRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes on a clean new test file", () => {
    commitTestFile(dir, "clean.test.ts", 'test("adds", () => {\n  run();\n});\n');
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("this file passes the guard when a project adds it", () => {
    commitTestFile(dir, "check-test-integrity.test.ts", readFileSync(import.meta.filename));
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("the env handed to a spawned git keeps no inherited GIT_ variable", () => {
    const pointer = "GIT_DIR";
    const unknown = "GIT_NOT_A_REAL_GIT_VARIABLE";
    const savedDir = process.env[pointer];
    process.env[pointer] = path.join(dir, ".git");
    process.env[unknown] = "1";
    try {
      const kept = Object.keys(gitEnv())
        .filter((key) => key.startsWith("GIT_"))
        .sort();
      assert.deepEqual(kept, ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"]);
    } finally {
      if (savedDir === undefined) delete process.env[pointer];
      else process.env[pointer] = savedDir;
      delete process.env[unknown];
    }
  });

  const caught: Array<[string, string]> = [
    ["a skip with a space before the dot", `${m("test .", "skip(")}"t", () => {\n  run();\n});\n`],
    ["an optional-chained skip", `${m("test?.", "skip(")}"t", () => {\n  run();\n});\n`],
    ["an optional-chained focus", `${m("test?.", "only(")}"t", () => {\n  run();\n});\n`],
    [
      "a describe skip with a space before the dot",
      `${m("describe .", "skip(")}"d", () => {\n  run();\n});\n`,
    ],
    [
      "a focus with a space before the parentheses",
      `${m("test.", "only (")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip with a space before the parentheses",
      `${m("test.", "skip (")}"t", () => {\n  run();\n});\n`,
    ],
    ["a skip on a mocha suite", `${m("suite.", "skip(")}"s", () => {\n  run();\n});\n`],
    [
      "a skip on a sequential test",
      `${m("test.sequential.", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip on a serial describe",
      `${m("describe.serial.", "skip(")}"d", () => {\n  run();\n});\n`,
    ],
    [
      "a skip whose first argument is a condition",
      `${m("it.", "skip(")}onCI, () => {\n  run();\n});\n`,
    ],
    [
      "a skip whose arguments start on the next line",
      `${m("test.", "skip")}\n("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip whose member access starts on the next line",
      `test\n  ${m(".", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a focus whose arguments start on the next line",
      `${m("test.", "only")}\n("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a comment line",
      `test\n  // flaky on CI\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment",
      `test // flaky\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a focus on an added line that starts with two plus signs",
      `let n = 0;\n++n && ${m("test.", "only(")}"t", () => {});\n`,
    ],
  ];

  for (const [label, body] of caught) {
    test(`catches ${label}`, () => {
      commitTestFile(dir, "bad.test.ts", body);
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, REJECTED);
    });
  }

  test("catches a focus when git is configured to always colour its output", () => {
    git(dir, "config", "color.ui", "always");
    commitTestFile(dir, "bad.test.ts", `${m("test.", "only(")}"t", () => {});\n`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches a focus on a line holding a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from(`${m("test.", "only(")}"t", () => {}); // `),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]);
    commitTestFile(dir, "bad.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  const SPLIT_BEFORE = 'test\n  .todo("t", () => {\n    run();\n  });\n';
  const SPLIT_AFTER = `test\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`;

  test("catches a skip edited in under an unchanged receiver line", () => {
    commitChange(dir, "bad.test.ts", SPLIT_BEFORE, SPLIT_AFTER);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
    assert.ok(out.includes(m("test.", 'skip("t"')), out);
  });

  test("catches a skip edited in under an unchanged receiver line when diff.context is 0", () => {
    git(dir, "config", "diff.context", "0");
    commitChange(dir, "bad.test.ts", SPLIT_BEFORE, SPLIT_AFTER);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches a skip edited in under an unchanged receiver line when GIT_DIFF_OPTS asks for no context", () => {
    commitChange(dir, "bad.test.ts", SPLIT_BEFORE, SPLIT_AFTER);
    const { status, out } = runGuard(dir, "base", { GIT_DIFF_OPTS: "--unified=0" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches a skip added as the last line of a file with no newline at its end", () => {
    commitChange(
      dir,
      "bad.test.ts",
      'test\n  .todo("t", fn);',
      `test\n  ${m(".", "skip(")}"t", fn);`,
    );
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  const caughtEdits: Array<[string, string, string]> = [
    [
      "a skip edited in under an unchanged receiver chain over two lines",
      'test\n  .sequential\n  .todo("t", fn);\n',
      `test\n  .sequential\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip edited in under an unchanged receiver line and comment line",
      'test\n  // flaky on CI\n  .todo("t", fn);\n',
      `test\n  // flaky on CI\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
  ];

  for (const [label, before, after] of caughtEdits) {
    test(`catches ${label}`, () => {
      commitChange(dir, "bad.test.ts", before, after);
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, REJECTED);
    });
  }

  const allowedEdits: Array<[string, string, string, boolean]> = [
    [
      "a locator edited under an unchanged split chain",
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n',
      'test("t", async ({ page }) => {\n  await page\n    .locator("b")\n    .click();\n});\n',
      false,
    ],
    [
      "an added line below a removed line, which it does not join",
      "x();\nconst box = fit\n",
      "x();\n  .last();\n",
      false,
    ],
    [
      "an edit below a hunk boundary, which does not join the hunk above",
      'x();\ny();\nz();\nconst sizes = fit\nawait page\n  .locator("a")\n  .first()\n  .nth(0)\n  .click();\n',
      'x2();\ny();\nz();\nconst sizes = fit\nawait page\n  .locator("a")\n  .first()\n  .nth(0)\n  .dblclick();\n',
      false,
    ],
    [
      "an added line below a blank context line under diff.suppressBlankEmpty",
      "const box = fit\n\nx();\n",
      "const box = fit\n\n  .last();\n",
      true,
    ],
  ];

  for (const [label, before, after, suppressBlankEmpty] of allowedEdits) {
    test(`allows ${label}`, () => {
      if (suppressBlankEmpty) git(dir, "config", "diff.suppressBlankEmpty", "true");
      commitChange(dir, "ok.test.ts", before, after);
      const { status, out } = runGuard(dir);
      assert.equal(status, 0, out);
      assert.match(out, PASSED);
    });
  }

  const allowed: Array<[string, string]> = [
    [
      "a skip on the test context in a test body",
      `test("t", (t) => {\n  ${m("t.", "skip(")}"needs Firefox");\n});\n`,
    ],
    ["a conditional skip option", 'test("t", { skip: !process.env.X }, () => {\n  run();\n});\n'],
    ["prose with a word followed by parentheses", "// i.e. only (a, b) survive\n"],
    ["prose with a word followed by a dot", "// not a test bent to fit. next() runs\n"],
    [
      "a locator chain split over lines",
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n',
    ],
  ];

  for (const [label, body] of allowed) {
    test(`allows ${label}`, () => {
      commitTestFile(dir, "ok.test.ts", body);
      const { status, out } = runGuard(dir);
      assert.equal(status, 0, out);
      assert.match(out, PASSED);
    });
  }

  const FOCUSED = `${m("test.", "only(")}"focused", () => {});\n`;
  const failingStages: Array<[string, string, string, string, RegExp]> = [
    [
      "git diff",
      "git",
      'for a in "$@"; do [ "$a" = diff ] && exit 128; done',
      FOCUSED,
      /git diff .*failed/,
    ],
    ["the added-line scanner (awk)", "awk", "exit 2", FOCUSED, /scanner \(awk\) failed/],
    [
      "the marker grep",
      "grep",
      `for a in "$@"; do case "$a" in ${m("*fdes", "cribe*")}) exit 2 ;; esac; done`,
      FOCUSED,
      /marker grep failed \(exit 2\)/,
    ],
    [
      "the word-boundary probe",
      "grep",
      `for a in "$@"; do [ "$a" = '\\bfit[(]' ] && exit 1; done`,
      'test("clean", () => {});\n',
      /does not read \\b as a word boundary/,
    ],
  ];

  for (const [label, tool, failWhen, body, error] of failingStages) {
    test(`fails closed when ${label} fails`, () => {
      commitTestFile(dir, "bad.test.ts", body);
      const bin = stubDir(
        dir,
        tool,
        `#!/bin/sh\n${failWhen}\nPATH="$REAL_PATH" exec ${tool} "$@"\n`,
      );
      const realPath = process.env.PATH ?? "";
      const { status, out } = runGuard(dir, "base", {
        PATH: `${bin}:${realPath}`,
        REAL_PATH: realPath,
      });
      assert.equal(status, 1, out);
      assert.match(out, error);
      assert.doesNotMatch(out, PASSED);
    });
  }

  test("fails when a test file is deleted", () => {
    git(dir, "rm", "-q", "base.test.ts");
    commitAll(dir, "drop base");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 1/);
  });

  test("skips when the base ref is none", () => {
    const { status, out } = runGuard(dir, "none");
    assert.equal(status, 0, out);
    assert.match(out, /skipped/);
  });

  test("fails when the base ref cannot be resolved", () => {
    const { status, out } = runGuard(dir, "no-such-ref");
    assert.equal(status, 1, out);
    assert.match(out, /cannot resolve the base ref/);
  });
});

function m(...parts: string[]): string {
  return parts.join("");
}

function makeRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "guard-test@example.com");
  git(dir, "config", "user.name", "Guard Test");
  writeFileSync(path.join(dir, "base.test.ts"), 'test("base stays green", () => {});\n');
  commitAll(dir, "base");
  git(dir, "branch", "base");
}

function commitTestFile(dir: string, name: string, content: string | Uint8Array): void {
  writeFileSync(path.join(dir, name), content);
  commitAll(dir, `add ${name}`);
}

function commitChange(dir: string, name: string, before: string, after: string): void {
  commitTestFile(dir, name, before);
  git(dir, "branch", "-f", "base", "main");
  commitTestFile(dir, name, after);
}

function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

// Every GIT_ variable goes, not a list of names: a hook run from a linked worktree exports
// GIT_DIR and others, and a spawned git that keeps them writes to the real repository.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function runGuard(
  dir: string,
  baseRef = "base",
  extraEnv: Record<string, string> = {},
): { status: number | null; out: string } {
  const res = spawnSync("sh", [SCRIPT], {
    cwd: dir,
    env: { ...gitEnv(), BASE_REF: baseRef, ...extraEnv },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

// Untracked, so the guard, which diffs commits and counts tracked files, never sees it.
function stubDir(dir: string, name: string, script: string): string {
  const bin = path.join(dir, ".stub-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return bin;
}
