import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

// This file is itself a *.test.ts, so the guard scans its own lines: every marker is assembled
// at runtime with m(), and fixture newlines are written as escapes, never as line breaks.

const SCRIPT = path.resolve(import.meta.dirname, "check-test-integrity.sh");
const REJECTED = /focus, skip or todo markers added/;
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

  const SKIP_TRUE = m("skip", ": true");
  const TODO_TRUE = m("todo", ": true");
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
      "a skip split from its receiver by a blank line",
      `test\n\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment",
      `test // flaky\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a quote",
      `test // don't\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a quote and ending in a period",
      `test // don't retry.\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a double quote and a backtick",
      `test // say "hi" or \`hi\`\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment line",
      `test\n  /* flaky */\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a trailing block comment",
      `test /* flaky */\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment holding a quote and a trailing comment",
      `test /* don't */ // flaky\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose opening star is followed by a slash",
      `test /*/ flaky */\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment after a regex literal holding quotes",
      `x.split(/["']/), test // flaky\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a split skip on a receiver after a string holding two slashes",
      `run("http://example.com"), test\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a split skip on a receiver after a string holding an escaped quote and two slashes",
      `run("a \\" // b"), test\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a split skip on a receiver with trailing spaces after a regex literal holding a quote",
      `x(/'/), test   \n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip after a regex literal holding a quote and a string holding two slashes, on a line the next one joins",
      `x.match(/"/) || "a//b", test${m(".", "skip(")}"t", fn)\n  .then(done);\n`,
    ],
    [
      "a split skip on a receiver after a regex literal holding a quote and a string holding a URL",
      `x(/'/, 'http://a'), test\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a split skip on a receiver after a regex literal holding a quote and a string holding two slashes",
      `x(/'/, 'a//b'), test\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a focus after a regex literal holding two slashes, above a block comment line and a joined line",
      `const re = /[a//]/; test${m(".", "only(")}name, fn)\n  /* chained */\n  .then(done);\n`,
    ],
    [
      "a focus on an added line that starts with two plus signs",
      `let n = 0;\n++n && ${m("test.", "only(")}"t", () => {});\n`,
    ],
    ["a bare skip on this", `test("t", function () {\n  ${m("this.", "skip()")};\n  run();\n});\n`],
    ["a bare skip on the test context", `test("t", (t) => {\n  ${m("t.", "skip()")};\n});\n`],
    [
      "a bare skip with a space before the dot",
      `test("t", function () {\n  ${m("this .", "skip()")};\n});\n`,
    ],
    [
      "a bare skip with a space before the parentheses",
      `test("t", function () {\n  ${m("this.", "skip ()")};\n});\n`,
    ],
    [
      "a bare skip whose parentheses start on the next line",
      `test("t", function () {\n  ${m("this.", "skip")}\n  ();\n});\n`,
    ],
    [
      "a skip option on a test with a body",
      `test("real", { ${SKIP_TRUE} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option over several lines",
      `test("real", {\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option with a string reason",
      `test("real", { ${m("skip", ': "flaky on CI"')} }, () => {\n  run();\n});\n`,
    ],
    ["a focus option", `test("real", { ${m("only", ": true")} }, () => {\n  run();\n});\n`],
    [
      "a skip option holding a number",
      `test("real", { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding a number after another option",
      `test("real", { timeout: 5, ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding a negated literal",
      `test("real", { ${m("skip", ": !0")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a focus option holding a number",
      `test("real", { ${m("only", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding a parenthesised literal",
      `test("real", { ${m("skip", ": (true)")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding a number on a test whose name holds a comma and parentheses",
      `test("parses a, b (c)", { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding null",
      `test("real", { ${m("skip", ": null")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding NaN in an options object over several lines",
      `test("real", {\n  ${m("skip", ": NaN")},\n}, () => {\n  run();\n});\n`,
    ],
    ["a focus option on an empty test", `test("p", { ${m("only", ": true")} }, () => {});\n`],
    [
      "a focus option beside a skip option on an empty test",
      `test("p", { ${SKIP_TRUE}, ${m("only", ": true")} }, () => {});\n`,
    ],
    [
      "a skip option with a space before the colon",
      `test("real", { ${m("skip", " : true")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a block comment",
      `test("real", { /* flaky */ ${SKIP_TRUE} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option with a double-quoted key",
      `test("real", { ${m('"skip"', ": true")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a focus option with a single-quoted key",
      `test("real", { ${m("'only'", ": true")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a comment line ending in a period",
      `test("real", {\n  // Flaky on CI.\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a comment line ending in a call",
      `test("real", {\n  // Flaky, see retry().\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a comment line ending in a word",
      `test("real", {\n  // Flaky on CI\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a trailing comment with a quote and a period",
      `test("real", {\n  timeout: 5, // don't retry.\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a trailing comment with a quote and a call",
      `test("real", {\n  timeout: 5, // don't call retry()\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a trailing comment with a quote and a word",
      `test("real", {\n  timeout: 5, // don't retry\n  ${SKIP_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option whose body only looks like a placeholder after it",
      `test("real", { ${SKIP_TRUE} }, () => { run(); }); const f = () => {});\n`,
    ],
    [
      "a skip option whose reason looks like the end of a placeholder",
      `test("real", { ${m("skip", ': "stop }, () => {})"')} }, () => { run(); });\n`,
    ],
    [
      "a skip option whose body holds an empty callback of its own",
      `test("real", { ${SKIP_TRUE} }, () => { on({ once: true }, () => {}); });\n`,
    ],
    [
      "a skip option whose body ends in an empty callback",
      `test("real", { ${SKIP_TRUE} }, () => { run(); [1].map(() => {}); });\n`,
    ],
    [
      "a todo option on a test with a body",
      `test("real", { ${TODO_TRUE} }, () => {\n  run();\n});\n`,
    ],
    [
      "a todo option with a string reason",
      `test("real", { ${m("todo", ': "flaky on CI"')} }, () => {\n  run();\n});\n`,
    ],
    [
      "a todo option holding a number",
      `test("real", { ${m("todo", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a todo option over several lines",
      `test("real", {\n  ${TODO_TRUE},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a todo option holding a number in an options object that comes first",
      `test({ ${m("todo", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a todo option holding a number in an options object over several lines",
      `test("multi", {\n  ${m("todo", ": 1")},\n}, () => {\n  run();\n});\n`,
    ],
    ["a todo option on an empty test", `test("p", { ${TODO_TRUE} }, () => {});\n`],
    ["a todo with a body", `${m("test.", "todo(")}"t", () => {\n  run();\n});\n`],
    ["an it todo with a body", `${m("it.", "todo(")}"t", () => {\n  run();\n});\n`],
    ["a describe todo with a body", `${m("describe.", "todo(")}"d", () => {\n  run();\n});\n`],
    ["a todo with a body and no name", `${m("test.", "todo(")}() => {\n  run();\n});\n`],
    ["a todo whose name is a variable", `${m("test.", "todo(")}name, () => {\n  run();\n});\n`],
    [
      "a todo with options and a body",
      `${m("test.", "todo(")}"t", { timeout: 5 }, () => {\n  run();\n});\n`,
    ],
    [
      "a todo whose arguments start on the next line",
      `${m("test.", "todo(")}\n  "t",\n  () => {\n    run();\n  },\n);\n`,
    ],
    [
      "a todo whose body starts on the next line",
      `${m("test.", "todo(")}"t",\n  () => {\n    run();\n  });\n`,
    ],
    [
      "a todo whose name holds an escaped quote before a parenthesis",
      `${m("test.", "todo(")}"a \\")", () => {\n  run();\n});\n`,
    ],
    [
      "a todo whose template-literal name nests a template",
      `${m("test.", "todo(")}\`\${\`)\`}\`, () => {\n  run();\n});\n`,
    ],
    [
      "a todo whose template-literal name holds a backtick in an interpolated string",
      `${m("test.", "todo(")}\`\${"}\`)"}\`, () => {\n  run();\n});\n`,
    ],
    [
      "a todo whose template-literal name runs onto the next line",
      `${m("test.", "todo(")}\`a\nb\`, () => {\n  run();\n});\n`,
    ],
    [
      "a todo called through a chain",
      `${m("test.", "todo")}.call(null, "t", () => {\n  run();\n});\n`,
    ],
    [
      "a todo whose name ends its line",
      `${m("test.", "todo(")}"t"\n  , () => {\n    run();\n  });\n`,
    ],
    [
      "a todo whose parentheses start on the next line",
      `${m("test.", "todo")}\n("t", () => {\n  run();\n});\n`,
    ],
    [
      "a todo whose member access starts on the next line",
      `test\n  ${m(".", "todo(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional-chained todo with a body",
      `${m("test?.", "todo(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a todo with a space before the dot and a body",
      `${m("test .", "todo(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a bare todo on the test context",
      `test("t", (t) => {\n  ${m("t.", "todo()")};\n  run();\n});\n`,
    ],
    ["an optional call on a skip", `${m("test.", "skip?.(")}"t", () => {\n  run();\n});\n`],
    ["an optional call on a focus", `${m("test.", "only?.(")}"t", () => {\n  run();\n});\n`],
    [
      "an optional call on a describe skip",
      `${m("describe.", "skip?.(")}"d", () => {\n  run();\n});\n`,
    ],
    [
      "an optional call on a todo with a body",
      `${m("test.", "todo?.(")}"t", () => {\n  run();\n});\n`,
    ],
    ["an optional call on an f-prefixed marker", `${m("fit", "?.(")}"t", () => {\n  run();\n});\n`],
    ["an optional call on a fixme", `${m("test.", "fixme?.(")}"t", () => {\n  run();\n});\n`],
    [
      "an optional call with spaces around the optional chain",
      `${m("test.", "only ?. (")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional call on an each chain after a skip",
      `${m("test.", "skip.each?.(")}[1])("t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional call on an each chain after a todo",
      `${m("test.", "todo.each?.(")}[1])("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip each chain called as a tagged template",
      `${m("test.", "skip.each")}\`a\`("t", () => {\n  run();\n});\n`,
    ],
    [
      "a todo each chain called as a tagged template",
      `${m("test.", "todo.each")}\`a\`("t", () => {\n  run();\n});\n`,
    ],
    [
      "a bare optional skip on the test context",
      `test("t", (t) => {\n  ${m("t.", "skip?.()")};\n});\n`,
    ],
    [
      "a bare optional todo on the test context",
      `test("t", (t) => {\n  ${m("t.", "todo?.()")};\n  run();\n});\n`,
    ],
    [
      "a focus option holding a number on an optional test call",
      `test?.("real", { ${m("only", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding a number on an optional test call",
      `test?.("real", { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "an optional call whose optional chain starts on the next line",
      `${m("test.", "skip")}\n?.("t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional call whose parenthesis starts the next line",
      `${m("test.", "skip?.")}\n("t", () => {\n  run();\n});\n`,
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

  test("lists the line of a todo that carries a body", () => {
    commitTestFile(dir, "bad.test.ts", `${m("test.", "todo(")}"t", () => {\n  run();\n});\n`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
    assert.ok(out.includes(m("test.", 'todo("t"')), out);
  });

  test("lists a refused line once", () => {
    commitTestFile(dir, "bad.test.ts", `${m("test.", "only(")}"t", () => {});\n`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.equal(out.split(m("test.", 'only("t"')).length, 2, out);
  });

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

  test("catches a skip option on a line holding a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from(`test("real", { ${SKIP_TRUE} }, () => { // `),
      Buffer.from([0xff]),
      Buffer.from("\n  assert.ok(work());\n});\n"),
    ]);
    commitTestFile(dir, "bad.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches a focus option on a test whose name holds a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from('test("x'),
      Buffer.from([0xff]),
      Buffer.from(`", { ${m("only", ": 1")} }, () => {\n  run();\n});\n`),
    ]);
    commitTestFile(dir, "bad.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches a skip option on a test whose name holds a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from('test("x'),
      Buffer.from([0xff]),
      Buffer.from(`", { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`),
    ]);
    commitTestFile(dir, "bad.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches a todo with a body whose name holds a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from(`${m("test.", "todo(")}"x`),
      Buffer.from([0xff]),
      Buffer.from('", () => {\n  run();\n});\n'),
    ]);
    commitTestFile(dir, "bad.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("accepts a bodiless todo whose name holds a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from(`${m("test.", "todo(")}"x`),
      Buffer.from([0xff]),
      Buffer.from('");\n'),
    ]);
    commitTestFile(dir, "ok.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("accepts an empty placeholder whose skip reason holds a byte that is not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from(`test("p", { ${m("skip", ': "needs ')}`),
      Buffer.from([0xff]),
      Buffer.from('" }, () => {});\n'),
    ]);
    commitTestFile(dir, "ok.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("catches a focus with an ideographic space before the parentheses", () => {
    const body = Buffer.concat([
      Buffer.from(m("test.", "only")),
      Buffer.from([0xe3, 0x80, 0x80]),
      Buffer.from('("t", () => {\n  run();\n});\n'),
    ]);
    commitTestFile(dir, "bad.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("accepts an empty placeholder with an ideographic space before its body", () => {
    const body = Buffer.concat([
      Buffer.from(`test("p", { ${m("skip", ": true")} },`),
      Buffer.from([0xe3, 0x80, 0x80]),
      Buffer.from("() => {});\n"),
    ]);
    commitTestFile(dir, "ok.test.ts", body);
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  const FOCUS_LINE = `${m("test.", "only(")}"t", () => {});`;
  const diffBypasses: Array<
    [string, { setup?: (repo: string) => void; env?: Record<string, string>; body?: Uint8Array }]
  > = [
    [
      "a committed gitattributes file marks test files -diff",
      { setup: (repo) => writeAttributes(repo, "*.test.ts -diff") },
    ],
    [
      "the added line holds a NUL byte",
      {
        body: Buffer.concat([
          Buffer.from(`${FOCUS_LINE} // `),
          Buffer.from([0x00]),
          Buffer.from("\n"),
        ]),
      },
    ],
    ["a diff driver is marked binary", { setup: (repo) => useDiffDriver(repo, "binary") }],
    [
      "diff.external is configured",
      { setup: (repo) => git(repo, "config", "diff.external", "true") },
    ],
    ["GIT_EXTERNAL_DIFF is set", { env: { GIT_EXTERNAL_DIFF: "true" } }],
    ["a diff driver has a command", { setup: (repo) => useDiffDriver(repo, "command") }],
    ["a diff driver has a textconv", { setup: (repo) => useDiffDriver(repo, "textconv") }],
    ["GIT_LITERAL_PATHSPECS is set", { env: { GIT_LITERAL_PATHSPECS: "1" } }],
    ["GIT_NOGLOB_PATHSPECS is set", { env: { GIT_NOGLOB_PATHSPECS: "1" } }],
    ["GIT_GLOB_PATHSPECS is set", { env: { GIT_GLOB_PATHSPECS: "1" } }],
  ];

  for (const [label, { setup, env, body }] of diffBypasses) {
    test(`catches a focus when ${label}`, () => {
      setup?.(dir);
      // In a subdirectory: under glob pathspec magic, * does not match a slash.
      mkdirSync(path.join(dir, "src"));
      commitTestFile(dir, "src/bad.test.ts", body ?? `${FOCUS_LINE}\n`);
      const { status, out } = runGuard(dir, "base", env);
      assert.equal(status, 1, out);
      assert.match(out, REJECTED);
      assert.doesNotMatch(out, PASSED);
    });
  }

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

  const caughtEdits: Array<[string, string, string, boolean]> = [
    [
      "a skip edited in under an unchanged receiver chain over two lines",
      'test\n  .sequential\n  .todo("t", fn);\n',
      `test\n  .sequential\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line and comment line",
      'test\n  // flaky on CI\n  .todo("t", fn);\n',
      `test\n  // flaky on CI\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line whose trailing comment holds a quote",
      `test // don't\n  .todo("t", fn);\n`,
      `test // don't\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line after a regex literal holding a quote and a URL",
      `x(/'/, 'http://a'), test\n  .todo("t", fn);\n`,
      `x(/'/, 'http://a'), test\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line and block comment line",
      'test\n  /* flaky */\n  .todo("t", fn);\n',
      `test\n  /* flaky */\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip whose receiver line is edited above an unchanged skip line",
      `const q = db\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip whose receiver line, with a trailing comment holding a quote, is edited above an unchanged skip line",
      `const q = db // don't\n  ${m(".", "skip(")}"t", fn);\n`,
      `test // don't\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a focus whose receiver line is edited above its unchanged arguments",
      'run\n("t", fn);\n',
      `${m("f", "it")}\n("t", fn);\n`,
      false,
    ],
    [
      "a skip whose receiver line is edited above an unchanged chain over two lines",
      `const q = db\n  .sequential\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  .sequential\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip whose receiver line is edited above a blank line and an unchanged skip line",
      `const q = db\n\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in below a receiver line and a blank context line",
      "test\n\nx();\n",
      `test\n\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in below a receiver line and a blank context line under diff.suppressBlankEmpty",
      "test\n\nx();\n",
      `test\n\n  ${m(".", "skip(")}"t", fn);\n`,
      true,
    ],
  ];

  for (const [label, before, after, suppressBlankEmpty] of caughtEdits) {
    test(`catches ${label}`, () => {
      if (suppressBlankEmpty) git(dir, "config", "diff.suppressBlankEmpty", "true");
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
      "an unchanged skip below an edited line it does not join",
      `x();\ntest\n  ${m(".", "skip(")}"t", fn);\n`,
      `y();\ntest\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a blank line inserted above an unchanged skip",
      `test\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "an unchanged skip below an edited line and a blank context line under diff.suppressBlankEmpty",
      `x();\ntest\n\n  ${m(".", "skip(")}"t", fn);\n`,
      `y();\ntest\n\n  ${m(".", "skip(")}"t", fn);\n`,
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
    [
      "a skip on the test context below a trailing comment holding a quote",
      `test("t", (t) => {\n  t // don't run on CI\n    ${m(".", "skip(")}"needs Firefox");\n});\n`,
    ],
    [
      "a skip on another receiver below a trailing comment after a regex literal holding quotes",
      `x.split(/["']/) // per test\n  ${m(".", "skip(")}"r");\n`,
    ],
    ["a conditional skip option", 'test("t", { skip: !process.env.X }, () => {\n  run();\n});\n'],
    [
      "a conditional skip option on an optional test call",
      'test?.("t", { skip: !process.env.X }, () => {\n  run();\n});\n',
    ],
    [
      "an optional skip on the test context in a test body",
      `test("t", (t) => {\n  ${m("t.", "skip?.(")}"needs Firefox");\n});\n`,
    ],
    ["a false skip option", 'test("t", { skip: false }, () => {\n  run();\n});\n'],
    ["a parenthesised condition", 'test("t", { skip: (isCI) }, () => {\n  run();\n});\n'],
    [
      "an env-gated empty placeholder",
      `if (!DATABASE_URL) {\n  test("store (set DATABASE_URL to run)", { ${SKIP_TRUE} }, () => {});\n} else {\n  test("store", () => {\n    run();\n  });\n}\n`,
    ],
    [
      "an empty placeholder with a string reason",
      `test("p", { ${m("skip", ': "needs DATABASE_URL"')} }, () => {});\n`,
    ],
    [
      "an empty placeholder with a second option",
      `test("p", { ${m("skip", ": true")}, timeout: 5 }, () => {});\n`,
    ],
    [
      "an empty placeholder after a block comment",
      `test("p", { /* no database */ ${SKIP_TRUE} }, () => {});\n`,
    ],
    [
      "an empty placeholder with a template-literal reason",
      `test("p", { ${m("skip", ": `set ", "$", "{V} to run`")} }, () => {});\n`,
    ],
    [
      "an empty placeholder with a reason holding a brace",
      `test("p", { ${m("skip", ': "needs {X}"')} }, () => {});\n`,
    ],
    [
      "an empty placeholder with a reason holding an apostrophe",
      `test("p", { ${m("skip", ': "doesn\'t run without a database"')} }, () => {});\n`,
    ],
    ["an empty async placeholder", `test("p", { ${SKIP_TRUE} }, async () => {});\n`],
    ["pagination on one line", "const rows = await db.user.findMany({ skip: 10, take: 5 });\n"],
    [
      "pagination over several lines",
      "const rows = await db.user.findMany({\n  where: { active: true },\n  skip: 10,\n  take: 5,\n});\n",
    ],
    [
      "pagination in a matcher inside a test body",
      'test("pages", async () => {\n  expect(args).toEqual(expect.objectContaining({ skip: 0, take: 2 }));\n});\n',
    ],
    [
      "pagination in a call nested in a one-line test",
      'it("a", () => db.find("b", { skip: 0 }));\n',
    ],
    ["prose with a word and a colon after a comma", "// two columns, desktop only: 2 per row\n"],
    [
      "prose with a quoted word after the colon",
      "// Non-spec files only: 'findImporters' skips them\n",
    ],
    ["prose with a word followed by parentheses", "// i.e. only (a, b) survive\n"],
    ["prose with a word followed by a dot", "// not a test bent to fit. next() runs\n"],
    [
      "a locator chain split over lines",
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n',
    ],
    ["a bodiless todo", `${m("test.", "todo(")}"planned");\n`],
    ["a bodiless todo with an optional call", `${m("test.", "todo?.(")}"planned");\n`],
    ["a bodiless todo with a single-quoted name", `${m("test.", "todo(")}'planned');\n`],
    ["a bodiless todo with a template-literal name", `${m("test.", "todo(")}\`planned\`);\n`],
    [
      "a bodiless todo whose template-literal name interpolates",
      `${m("test.", "todo(")}\`planned \${x} \${ a.b }\`);\n`,
    ],
    ["a bodiless todo whose name holds an apostrophe", `${m("test.", "todo(")}"don't forget");\n`],
    ["a bodiless it todo", `${m("it.", "todo(")}"planned");\n`],
    [
      "a bodiless todo with a trailing comment",
      `${m("test.", "todo(")}"planned"); // trailing comment\n`,
    ],
    [
      "a todo on the test context in a test body",
      `test("t", (t) => {\n  ${m("t.", "todo(")}"needs Firefox");\n});\n`,
    ],
    [
      "an optional todo on the test context in a test body",
      `test("t", (t) => {\n  ${m("t.", "todo?.(")}"needs Firefox");\n});\n`,
    ],
    ["a conditional todo option", 'test("t", { todo: !process.env.X }, () => {\n  run();\n});\n'],
    ["a false todo option", 'test("t", { todo: false }, () => {\n  run();\n});\n'],
    ["a parenthesised todo condition", 'test("t", { todo: (isCI) }, () => {\n  run();\n});\n'],
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
  const OPTIONED = `test("real", { ${SKIP_TRUE} }, () => {\n  assert.ok(work());\n});\n`;
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
      "the first join pass",
      "awk",
      'for a in "$@"; do [ "$a" = plain=1 ] && exit 2; done',
      FOCUSED,
      /scanner \(awk\) failed/,
    ],
    [
      "the second join pass",
      "awk",
      'for a in "$@"; do [ "$a" = plain=0 ] && exit 2; done',
      FOCUSED,
      /scanner \(awk\) failed/,
    ],
    [
      "the duplicate-line filter",
      "awk",
      'for a in "$@"; do case "$a" in *seen*) exit 2 ;; esac; done',
      FOCUSED,
      /scanner \(awk\) failed/,
    ],
    [
      "the marker grep",
      "grep",
      `for a in "$@"; do case "$a" in ${m("*fdes", "cribe*")}) exit 2 ;; esac; done`,
      FOCUSED,
      /marker grep failed \(exit 2\)/,
    ],
    [
      "the option-object grep",
      "grep",
      'for a in "$@"; do [ "$a" = -avE ] && break; case "$a" in *"]?skip"*) exit 2 ;; esac; done',
      OPTIONED,
      /option-object grep failed \(exit 2\)/,
    ],
    [
      "the placeholder grep",
      "grep",
      'for a in "$@"; do [ "$a" = -avE ] && exit 2; done',
      OPTIONED,
      /placeholder grep failed \(exit 2\)/,
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

// Committed with the test file, which commitAll stages with the rest of the tree.
function writeAttributes(dir: string, line: string): void {
  writeFileSync(path.join(dir, ".gitattributes"), `${line}\n`);
}

// A diff that honours the driver hides the added lines: as a command or textconv, `true` prints
// nothing; as binary, git prints only that the files differ.
function useDiffDriver(dir: string, setting: "binary" | "command" | "textconv"): void {
  writeAttributes(dir, "*.test.ts diff=hide");
  git(dir, "config", `diff.hide.${setting}`, "true");
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
