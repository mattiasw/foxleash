import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

  // Option values spelled as literals: none is a condition, so each fixes the test's fate in the
  // source, whatever the environment.
  const SKIP_LITERALS = [
    "-1",
    "+1",
    ".5",
    "-.5",
    "0x1",
    "1e3",
    "1_000",
    "1n",
    "Infinity",
    "-Infinity",
    "-true",
    '+"1"',
    "!-1",
    "-(1)",
    "!void 0",
    "(-1)",
    "!-(1)",
    "-!0",
    "- 1",
    "~0",
    "-~0",
  ];
  const ONLY_LITERALS = ["-1", ".5", "Infinity", "+true", "!void 0", "~0"];
  const TODO_LITERALS = ["-1", ".5", "Infinity", "-true", "!void 0"];
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
      "a skip split from its receiver by a block comment that closes on the skip's line",
      `test /${m("*")}\n ${m("*", "/", ".skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a block comment over two lines",
      `test\n  /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip below a receiver line that opens a block comment, a comment line and a closing line",
      `test /${m("* flaky")}\n     on CI\n  ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment over two lines holding a quote and two slashes",
      `test\n  /${m("* don't retry,")}\n     see https://x ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip after a block comment that closes before the dot on its line",
      `test\n  /* flaky */ ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment over two lines, after a regex literal holding a quote",
      `x(/'/), test /${m("* flaky")}\n     on CI ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment glued to it, after a regex literal holding a quote",
      `x(/'/), test/${m("* flaky *", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment over two lines, after a string holding two slashes",
      `run("http://x"), test /${m("*")}\n   flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a skip split from its receiver by a block comment over two lines, below a regex literal holding a comment's start",
      `const trim = (u) => u.replace(/\\/${m("*")}$/, "");\ntest\n  /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a split skip after a regex literal holding a comment's start",
      `const re = /\\/${m("*")}/; test\n  ${m(".", "skip(")}"t", fn);\n`,
    ],
    [
      "a split skip on a receiver after a block comment over two lines holding two slashes",
      `/${m("* see")}\n   http://x ${m("*", "/")} test\n  ${m(".", "skip(")}"t", fn);\n`,
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
      "a skip option joined to a placeholder-shaped call on the next line",
      `test("real", { ${SKIP_TRUE} }, () => { run(); })\n  .then(() => ({ ${m("skip", ": 0")} }, () => {}));\n`,
    ],
    [
      "a skip option joined to a placeholder-shaped call across a blank line",
      `test("real", { ${SKIP_TRUE} }, () => { run(); })\n\n  .then(() => ({ ${m("skip", ": 0")} }, () => {}));\n`,
    ],
    [
      "a skip option after an empty placeholder on the same line",
      `test("p", { skip: !process.env.X }, () => {}); test("real", { ${SKIP_TRUE} }, () => { run(); });\n`,
    ],
    [
      "a skip option whose reason holds an escaped quote before an empty callback",
      `test("real", { ${m("skip", ": 'it\\'s flaky'")} }, () => { on({ a: 'b\\'c' }, () => {}); });\n`,
    ],
    [
      "a skip option with a block comment holding a quote before an empty callback",
      `test("real", { ${SKIP_TRUE} /* don't */ }, () => { on({ /* it's */ }, () => {}); });\n`,
    ],
    [
      "a skip option before a nested object followed by an empty callback",
      `test("real", { ${SKIP_TRUE}, fn: on({ a: 1 }, () => {}) }, () => { run(); });\n`,
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
    ...SKIP_LITERALS.map((value): [string, string] => [
      `a skip option holding ${value}`,
      `test("real", { ${m("skip", ": ", value)} }, () => {\n  run();\n});\n`,
    ]),
    ...ONLY_LITERALS.map((value): [string, string] => [
      `a focus option holding ${value}`,
      `test("real", { ${m("only", ": ", value)} }, () => {\n  run();\n});\n`,
    ]),
    ...TODO_LITERALS.map((value): [string, string] => [
      `a todo option holding ${value}`,
      `test("real", { ${m("todo", ": ", value)} }, () => {\n  run();\n});\n`,
    ]),
    [
      "a todo option holding a negative number in an options object over several lines",
      `test("real", {\n  ${m("todo", ": -1")},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a todo option holding void 0 negated in an options object over several lines",
      `test("real", {\n  ${m("todo", ": !void 0")},\n}, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option in an options object that comes first",
      `test({ ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option holding a negative number in an options object that comes first",
      `test({ ${m("skip", ": -1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a focus option in an options object that comes first",
      `test({ ${m("only", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a focus option in an options object that comes first on an optional test call",
      `test?.({ ${m("only", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option in an options object that comes first after a space",
      `test( { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a skip option after a name holding an escaped quote",
      `test('it\\'s "x"', { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a focus option after a template-literal name holding an escaped backtick",
      `test(\`a \\\` b\`, { ${m("only", ": -1")} }, () => {\n  run();\n});\n`,
    ],
    // Type arguments before a marker's call.
    ["a skip with type arguments", `${m("test.", "skip<object>(")}"t", () => {\n  run();\n});\n`],
    [
      "an optional-call skip with type arguments",
      `${m("test.", "skip?.<object>(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip with type arguments and a space before the call",
      `${m("test.", "skip<object> (")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip with nested type arguments",
      `${m("test.", "skip<Array<string>>(")}"t", () => {\n  run();\n});\n`,
    ],
    ["a focus with type arguments", `${m("test.", "only<T>(")}"t", () => {\n  run();\n});\n`],
    ["a todo with type arguments and a body", `${m("test.", "todo<object>(")}"t", fn);\n`],
    // A function is always truthy, and a negated one is never a condition.
    [
      "an option-object skip that is an arrow",
      `test("t", { ${m("skip", ": () => !process.env.DB")} }, () => { run(); });\n`,
    ],
    [
      "an option-object skip that is an async arrow",
      `test("t", { ${m("skip", ": async () => x")} }, () => { run(); });\n`,
    ],
    [
      "an option-object skip that is a function expression",
      `test("t", { ${m("skip", ": function () { return 1; }")} }, () => { run(); });\n`,
    ],
    [
      "an option-object focus that is an arrow",
      `test("t", { ${m("only", ": () => x")} }, () => { run(); });\n`,
    ],
    [
      "an option-object skip that is a negated arrow (never a condition)",
      `test("t", { ${m("skip", ": !(() => x)")} }, () => { run(); });\n`,
    ],
    [
      "an option-object skip that is a parenthesised arrow",
      `test("t", { ${m("skip", ": (() => x)")} }, () => { run(); });\n`,
    ],
    [
      "an option-object skip that is a bitwise-negated arrow",
      `test("t", { ${m("skip", ": ~(() => x)")} }, () => { run(); });\n`,
    ],
    [
      "a wrapped todo option holding an arrow",
      `test("t", {\n  ${m("to", "do: () => x")},\n}, () => {\n  work();\n});\n`,
    ],
    // Read as the engine reads names: a computed literal key, an escaped name and a block
    // comment inside the line are spelled out before the patterns run.
    [
      "a computed member access with a double-quoted key",
      `${m("test", '["only"]')}("t", () => {\n  work();\n});\n`,
    ],
    [
      "a computed member access with a single-quoted key",
      `${m("describe", "['skip']")}("s", () => {});\n`,
    ],
    ["a computed member access with a backtick key", `${m("test", "[`only`]")}("t", fn);\n`],
    ["an optional computed member access", `${m("test?.", '["skip"]')}("t", fn);\n`],
    [
      "a computed key with spaces inside the brackets",
      `${m("test[ ", '"only"', " ]")}("t", fn);\n`,
    ],
    ["a chain of two computed keys", `${m("test", '["describe"]', '["only"]')}("s", fn);\n`],
    ["a computed key after an index", `${m("suites[0]", '["only"]')}("t", fn);\n`],
    ["a unicode escape in the name", `${m("test.", "\\u006f", "nly(")}"t", fn);\n`],
    ["an uppercase unicode escape in the name", `${m("test.", "\\u006F", "nly(")}"t", fn);\n`],
    ["a braced unicode escape in the name", `${m("describe.", "\\u{73}", "kip(")}"s", fn);\n`],
    [
      "a braced unicode escape with leading zeros in the name",
      `${m("describe.", "\\u{0073}", "kip(")}"s", fn);\n`,
    ],
    ["a hex escape in a computed key", `${m("test", '["\\x6f', 'nly"]')}("t", fn);\n`],
    ["an identity escape in a computed key", `${m("test", '["\\o', 'nly"]')}("t", fn);\n`],
    [
      "an identity escape in a quoted option key",
      `test("t", { ${m('"\\s', 'kip": true')} }, () => {\n  work();\n});\n`,
    ],
    [
      "a unicode escape in an option key",
      `test("t", { ${m("sk", "\\u0069", "p: true")} }, () => {\n  work();\n});\n`,
    ],
    ["a block comment after the dot", `${m("test./", "* x */only(")}"t", fn);\n`],
    [
      "a block comment after the dot, as Biome spaces it",
      `${m("test./", "* x */ only(")}"t", fn);\n`,
    ],
    [
      "a block comment after the dot with a space before it",
      `${m("test. /", "* x */only(")}"t", fn);\n`,
    ],
    ["a block comment before the dot of a skip", `${m("test/", "* x */.skip(")}"t", fn);\n`],
    ["a block comment before the call's paren", `${m("test.only/", "**/(")}"t", fn);\n`],
    [
      "a block comment inside an option object",
      `test("t", { ${m("skip/", "**/: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a block comment between two words, then one after the dot",
      `${m("void /", "* c */ test./", "* d */skip(")}"t", fn);\n`,
    ],
    [
      "a computed key between two strings holding a comment's ends",
      `const a = "/*"; ${m("test", '["only"]')}("t", fn); const b = "*/";\n`,
    ],
    // Option keys and values: any key spelling, a composite and a method shorthand.
    [
      "a computed option key with a double-quoted name",
      `test("t", { ${m('["sk', 'ip"]: true')} }, () => {\n  work();\n});\n`,
    ],
    [
      "a computed option key with a single-quoted name",
      `test("t", { ${m("['on", "ly']: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a computed option key with a backtick name and spaces",
      `test("t", { ${m("[ `sk", "ip` ]: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a computed option key with a number on the test call's line",
      `test("t", { ${m('["sk', 'ip"]: 1')} }, () => {\n  work();\n});\n`,
    ],
    [
      "a wrapped computed option key",
      `test("t", {\n  ${m('["sk', 'ip"]: true')},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a wrapped computed todo key",
      `test("t", {\n  ${m('["to', 'do"]: true')},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a wrapped todo option",
      `test("t", {\n  ${m("to", "do: true")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a wrapped todo option with a string reason",
      `test("t", {\n  ${m("to", 'do: "a long reason"')},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a wrapped todo option with a number",
      `test("t", {\n  ${m("to", "do: 1")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an empty array as an option skip",
      `test("t", { ${m("skip", ": []")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an empty object as an option skip",
      `test("t", { ${m("skip", ": {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a doubly negated array as an option skip",
      `test("t", { ${m("skip", ": !![]")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a bitwise-negated array as an option skip",
      `test("t", { ${m("skip", ": ~[]")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a todo method on the test call's line",
      `test("t", { ${m("to", "do() {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an async todo method on the test call's line",
      `test("t", { ${m("async to", "do() {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a skip getter on the test call's line",
      `test("t", { ${m("get sk", "ip() { return true; }")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a generator skip method on the test call's line",
      `test("t", { ${m("*sk", "ip() {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an async generator todo method on the test call's line",
      `test("t", { ${m("async *to", "do() {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a todo option beside an object holding a function (no placeholder)",
      `test("real", { ${m("to", "do: true")}, x: f({}, () => {}) }, () => {\n  work();\n});\n`,
    ],
    [
      "a skip method on an empty test (no placeholder)",
      `test("p", { ${m("sk", "ip() { return true; }")} }, () => {});\n`,
    ],
    // node:test's expected failure exits 0 when its body throws.
    [
      "an expected failure on test",
      `${m("test.expect", "Failure(")}"t", () => {\n  work();\n});\n`,
    ],
    [
      "an expected failure on describe",
      `${m("describe.expect", "Failure(")}"d", () => {\n  work();\n});\n`,
    ],
    [
      "a bare expected-failure call imported from node:test",
      `${m("expect", "Failure(")}"t", () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure each chain",
      `${m("it.expect", "Failure.each(")}[[1]])("n", () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option set to true on the test call's line",
      `test("t", { ${m("expect", "Failure: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option set to true on its own line of a multi-line options object",
      `test("t", {\n  ${m("expect", "Failure: true")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option with a string reason on the test call's line",
      `test("t", { ${m("expect", 'Failure: "known bug"')} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option with a string reason on its own line",
      `test("t", {\n  ${m("expect", 'Failure: "a long reason"')},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option that is an arrow on the test call's line",
      `test("t", { ${m("expect", "Failure: () => true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure method on the test call's line",
      `test("t", { ${m("expect", "Failure() {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option on an empty test (no placeholder)",
      `test("p", { ${m("expect", "Failure: true")} }, () => {});\n`,
    ],
    [
      "an expected-failure option holding a regex on the test call's line",
      `test("t", { ${m("expect", "Failure: /boom/")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding a regex on its own line",
      `test("t", {\n  ${m("expect", "Failure: /boom/")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding a regex with an escaped slash and a flag",
      `test("t", { ${m("expect", "Failure: /a\\/b/i")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding a regex that ends its line",
      `test("t", {\n  ${m("expect", "Failure: /boom/")}\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding an error class on the test call's line",
      `test("t", { ${m("expect", "Failure: TypeError")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding the Error class",
      `test("t", { ${m("expect", "Failure: Error")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding DOMException",
      `test("t", { ${m("expect", "Failure: DOMException")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option holding a namespaced error class on its own line",
      `test("t", {\n  ${m("expect", "Failure: assert.AssertionError")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option opening a validator object over several lines",
      `test("t", {\n  ${m("expect", "Failure: {")}\n    message: "boom",\n  },\n}, () => {\n  work();\n});\n`,
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

  test("lists a refused computed-key line as the gate reads it", () => {
    commitTestFile(dir, "bad.test.ts", `${m("test", '["only"]')}("t", fn);\n`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, new RegExp(`^${m("test\\.", "only\\(")}"t", fn\\);$`, "m"));
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
    ["GIT_ICASE_PATHSPECS is set", { env: { GIT_ICASE_PATHSPECS: "1" } }],
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

  test("GIT_ICASE_PATHSPECS does not change the verdict", () => {
    // Top level, so the case-insensitive match is the only thing that could reach this file.
    commitTestFile(dir, "notes.TEST.TS", `${FOCUS_LINE}\n`);
    const plain = runGuard(dir);
    const icase = runGuard(dir, "base", { GIT_ICASE_PATHSPECS: "1" });
    assert.equal(icase.status, plain.status, `${plain.out}\n${icase.out}`);
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

  // Two hunks: hunk 1 ends inside a block comment that closes between the hunks, so hunk 2,
  // where the skip is edited in on the line that closes another comment, starts outside one.
  const COMMENT_HUNK_BEFORE = `a();\n/${m("*")}\n one\n two\n three\n${m("*", "/")}\nb();\nc();\nd();\ne();\nf();\ng();\ntest /${m("*")}\n ${m("*", "/", ".todo(")}"t", fn);\n`;
  const COMMENT_HUNK_AFTER = COMMENT_HUNK_BEFORE.replace("a();", "a(1);").replace(
    m(".", "todo("),
    m(".", "skip("),
  );
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
      "a skip edited in under an unchanged receiver line and an unchanged block comment over two lines",
      `test\n  /${m("* reason:")}\n     flaky ${m("*", "/")}\n  .concurrent("t", fn);\n`,
      `test\n  /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in on the line that closes an unchanged block comment",
      `test /${m("*")}\n   flaky\n ${m("*", "/", ".todo(")}"t", fn);\n`,
      `test /${m("*")}\n   flaky\n ${m("*", "/", ".skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in below a hunk whose context ends inside a block comment",
      COMMENT_HUNK_BEFORE,
      COMMENT_HUNK_AFTER,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver after a block comment over two lines holding two slashes",
      `/${m("* see")}\n   http://x ${m("*", "/")} test\n  .concurrent("t", fn);\n`,
      `/${m("* see")}\n   http://x ${m("*", "/")} test\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip whose receiver line, opening a block comment, is edited above the comment's unchanged closing line and skip line",
      `const q = db /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
      `test /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip whose receiver line is edited above an unchanged block comment over two lines and skip line",
      `const q = db\n  /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  /${m("* reason:")}\n     flaky ${m("*", "/")}\n  ${m(".", "skip(")}"t", fn);\n`,
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
      "a link added between an unchanged root and an unchanged skip",
      `test\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  .sequential\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a receiver edited into a test root above an unchanged comment line and skip link",
      `const q = db\n  // flaky\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  // flaky\n  ${m(".", "skip(")}"t", fn);\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in a block comment holding a URL",
      `test /${m("* see https://x *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* see https://x *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in a block comment, after a string holding a comment's start",
      `x("/${m("*")}"); test /${m("* see *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x("/${m("*")}"); test /${m("* see *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in two block comments",
      `test /${m("* a */ /", "* b */")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* a */ /", "* b */")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in a block comment holding a URL, after a match-pattern string",
      `x("*://*/${m("*")}"); test /${m("* see https://x *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x("*://*/${m("*")}"); test /${m("* see https://x *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in a block comment holding a URL, after a string holding an escaped quote",
      `x("a\\"b"); test /${m("* see https://x *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x("a\\"b"); test /${m("* see https://x *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in a block comment holding a paren",
      `test /${m("* x) *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* x) *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line ending in a block comment holding //, then a line comment",
      `test /${m("* a//b *", "/")} // c\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* a//b *", "/")} // c\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
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

  // Two edits seven unchanged lines apart, so git prints two hunks at the gate's 3 lines of
  // context (it merges changes at most twice the context apart): hunk 1 ends with
  // `const sizes = fit`, hunk 2 starts with `  .locator("a")`, and `await page` is in neither.
  const HUNK_BOUNDARY_BEFORE =
    'x();\ny();\nz();\nconst sizes = fit\nawait page\n  .locator("a")\n  .first()\n  .nth(0)\n  .click();\n';
  const HUNK_BOUNDARY_AFTER = HUNK_BOUNDARY_BEFORE.replace("x();", "x2();").replace(
    "  .click();",
    "  .dblclick();",
  );
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
      HUNK_BOUNDARY_BEFORE,
      HUNK_BOUNDARY_AFTER,
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
      "a body line edited below an unchanged one-line call",
      'test("t", () => {\n  run(1);\n});\n',
      'test("t", () => {\n  run(2);\n});\n',
      false,
    ],
    [
      "an edit two lines below an unchanged legacy skip",
      `${m("it.", "skip(")}"legacy", () => {});\ntest("t", () => {\n  run(1);\n});\n`,
      `${m("it.", "skip(")}"legacy", () => {});\ntest("t", () => {\n  run(2);\n});\n`,
      false,
    ],
    [
      "an edit below an unchanged comment that mentions an unclosed skip",
      `describe("d", () => {\n  // never wrap this in ${m("test.", "skip(")} again\n  test("t", () => {\n    run(1);\n  });\n});\n`,
      `describe("d", () => {\n  // never wrap this in ${m("test.", "skip(")} again\n  test("t", () => {\n    run(2);\n  });\n});\n`,
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

  // The hunk-boundary rows test the reset at a hunk header only while their edits diff as two
  // hunks, which depends on the gate's diff context.
  test("the hunk-boundary case diffs as two hunks at the gate's context", () => {
    const context = /--unified=(\d+)/.exec(readFileSync(SCRIPT, "utf8"));
    assert.ok(context, "the script names its diff context");
    commitChange(dir, "bad.test.ts", HUNK_BOUNDARY_BEFORE, HUNK_BOUNDARY_AFTER);
    const diff = git(dir, "diff", `--unified=${context[1]}`, "base...HEAD");
    assert.equal(diff.match(/^@@ /gm)?.length, 2, diff);
  });

  test("the block-comment hunk-boundary case diffs as two hunks at the gate's context", () => {
    const context = /--unified=(\d+)/.exec(readFileSync(SCRIPT, "utf8"));
    assert.ok(context, "the script names its diff context");
    commitChange(dir, "bad.test.ts", COMMENT_HUNK_BEFORE, COMMENT_HUNK_AFTER);
    const diff = git(dir, "diff", `--unified=${context[1]}`, "base...HEAD");
    assert.equal(diff.match(/^@@ /gm)?.length, 2, diff);
  });

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
      "a skip on the test context below a block comment over two lines",
      `test("t", (t) => {\n  t /${m("* no Firefox")}\n     here ${m("*", "/")}\n    ${m(".", "skip(")}"needs Firefox");\n});\n`,
    ],
    [
      "a locator chain split by a block comment over two lines",
      `test("t", async ({ page }) => {\n  await page\n    /${m("* the first")}\n       link ${m("*", "/")}\n    .locator("a")\n    .click();\n});\n`,
    ],
    [
      "a skip on another receiver below a string holding a test-root word and a comment's start, then a block comment line",
      `test("q", async () => {\n  const rows = await db\n    .collection("files")\n    .find({ path: { $regex: "^suite/${m("*")}" } })\n    /${m("* page two *", "/")}\n    ${m(".", "skip(")}10)\n    .toArray();\n});\n`,
    ],
    [
      "a skip on another receiver below a block comment glued to the code before it and ending in a test-root word",
      `test("q", async () => {\n  const rows = await db.find()/${m("* page two, see test")}\n     above ${m("*", "/")}\n    ${m(".", "skip(")}10);\n});\n`,
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
    [
      "two empty placeholders on one line",
      `test("p", { ${SKIP_TRUE} }, () => {}); test("q", { ${SKIP_TRUE} }, async () => {});\n`,
    ],
    [
      "pagination after an empty placeholder with a second option",
      'test("p", { timeout: 5, skip: !process.env.X }, () => {}); const page = { limit: 10, skip: 1 };\n',
    ],
    [
      "an empty placeholder whose reason holds an escaped quote",
      `test("p", { ${m("skip", ": 'it\\'s off'")} }, () => {});\n`,
    ],
    [
      "an empty placeholder with a block comment holding a quote",
      `test("p", { ${SKIP_TRUE} /* don't */ }, () => {});\n`,
    ],
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
    ...["-offset", "!-(offset)", "InfinityMode", "!voidable", "void 0", "~offset", "!void$x"].map(
      (value): [string, string] => [
        `a skip option holding the condition ${value}`,
        `test("t", { skip: ${value} }, () => {\n  run();\n});\n`,
      ],
    ),
    [
      "a todo option holding a negated name",
      'test("t", { todo: -offset }, () => {\n  run();\n});\n',
    ],
    [
      "a focus option holding a negated name",
      'test("t", { only: -offset }, () => {\n  run();\n});\n',
    ],
    [
      "a conditional skip option in an options object that comes first",
      "test({ skip: !process.env.X }, () => {\n  run();\n});\n",
    ],
    [
      "pagination holding a negative number outside a test call",
      "const rows = await db.user.findMany({ skip: -1, take: 5 });\n",
    ],
    [
      "a comparison that reads like type arguments after only",
      `test("t", () => {\n  if (filters.${m("only", " < 1")} && total > (offset + 1)) {\n    run();\n  }\n});\n`,
    ],
    [
      "a less-or-equal comparison that reads like type arguments after only",
      `test("t", () => {\n  if (filters.${m("only", " <= 1")} && total > (offset ?? 0)) {\n    run();\n  }\n});\n`,
    ],
    [
      "a less-or-equal comparison on a name spelled like a focus marker",
      `test("t", () => {\n  if (${m("fit", " <= max")} && size > (min ?? 0)) {\n    run();\n  }\n});\n`,
    ],
    [
      "a database cursor skip on AVA's t.context",
      `test("t", async (t) => {\n  const rows = await t.context.db.find({})${m(".", "skip(")}10).toArray();\n  assert.ok(rows);\n});\n`,
    ],
    [
      "a database cursor skip on a context object",
      `test("t", async () => {\n  const rows = await context.db.collection("u").find({})${m(".", "skip(")}10);\n  assert.ok(rows);\n});\n`,
    ],
    [
      "an option-object skip on a name starting with function and a dollar sign",
      `test("t", { ${m("skip", ": function$enabled")} }, () => {\n  run();\n});\n`,
    ],
    [
      "an option-object skip on a name starting with function",
      `test("t", { ${m("skip", ": functionality")} }, () => { run(); });\n`,
    ],
    [
      "a locator chain with a quoted trailing comment",
      `test("t", async ({ page }) => {\n  await page // the user's page\n    .locator("a")\n    .click();\n});\n`,
    ],
    ["a todo with one quoted name", `${m("test.", "todo(")}"title");\n`],
    ["a todo whose name holds a comma", `${m("test.", "todo(")}"a, b");\n`],
    ["a todo whose template name holds a member path", m("test.", "todo(", "`a $", "{b.c}`);\n")],
    [
      "node:test's in-body todo with a reason",
      `test("t", (t) => {\n  ${m("t.", "todo(")}"later");\n});\n`,
    ],
    [
      "an option skip whose value starts with an array",
      `test("t", { ${m("skip", ': ["darwin"].includes(process.platform)')} }, () => {\n  work();\n});\n`,
    ],
    [
      "an option skip whose value starts with a negated array",
      `test("t", { ${m("skip", ': !["linux"].includes(p)')} }, () => {\n  work();\n});\n`,
    ],
    [
      "the empty placeholder with a computed skip key",
      `test("store (set DATABASE_URL to run)", { ${m('["sk', 'ip"]: true')} }, () => {});\n`,
    ],
    [
      "a todo option set to false",
      `test("t", { ${m("to", "do: false")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a computed pagination key",
      `test("t", () => {\n  db.findMany({ ${m('["sk', 'ip"]: 10')}, take: 5 });\n});\n`,
    ],
    [
      "an array literal after return",
      `const f = () => {\n  return ${m('["only"]', ".map(g)")};\n};\n`,
    ],
    ["an array literal after an equals sign", `const b = ${m('["only"]', ".forEach(f)")};\n`],
    ["an array literal as an argument", `fn(${m('["only"]', ".concat(x))")};\n`],
    ["a computed call on another name", 'S["init"]({});\nwindow["DOCS_modelChunkLoadData"](x);\n'],
    [
      "escapes that decode to no identifier character",
      'const s = "a\\u0000b \\u00b7 \\u{1F600} \\x00";\n',
    ],
    [
      "escape sequences between the letters of markers, which stand for no letter",
      'const s = "a.o\\nly(1) b.\\fixme(2) c.fi\\xme(3) \\tes\\t.skip(4) descri\\be.skip(5) desc\\ribe.skip(6) test.r\\unIf(false)(7)";\n',
    ],
    [
      "an escape of a non-ASCII letter in a name",
      `const v = ${m("test.", "\\u00e9", "only(")}"t");\n`,
    ],
    [
      "escaped identifiers in a comment",
      '// see \\u0068eaders() and "next/hea\\u0064ers"\ntest("t", () => {});\n',
    ],
    ["a glob holding /**/", 'const files = glob("src/**/*.ts");\ntest("t", () => {});\n'],
    [
      "an expected-failure option set to false",
      `test("t", { ${m("expect", "Failure: false")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a conditional expected-failure option",
      `test("t", { ${m("expect", "Failure: !process.env.X")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option on a name after a block comment",
      `test("t", { ${m("expect", "Failure: /* why */ isWindows")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a conditional expected-failure option that starts with an array",
      `test("t", { ${m("expect", 'Failure: ["win32"].includes(process.platform)')} }, () => {\n  work();\n});\n`,
    ],
    [
      "a conditional expected-failure option that starts with a regex",
      `test("t", { ${m("expect", "Failure: /^win/.test(process.platform)")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a conditional expected-failure option on a flag named like an error",
      `test("t", { ${m("expect", "Failure: hasError")} }, () => {\n  work();\n});\n`,
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
      "the join pass with plain=1 and carry=0",
      "awk",
      'p=; c=; for a in "$@"; do case "$a" in plain=1) p=1 ;; carry=0) c=1 ;; esac; done; [ "$p$c" = 11 ] && exit 2',
      FOCUSED,
      /scanner \(awk\) failed/,
    ],
    [
      "the join pass with plain=0 and carry=0",
      "awk",
      'p=; c=; for a in "$@"; do case "$a" in plain=0) p=1 ;; carry=0) c=1 ;; esac; done; [ "$p$c" = 11 ] && exit 2',
      FOCUSED,
      /scanner \(awk\) failed/,
    ],
    [
      "the join pass with plain=1 and carry=1",
      "awk",
      'p=; c=; for a in "$@"; do case "$a" in plain=1) p=1 ;; carry=1) c=1 ;; esac; done; [ "$p$c" = 11 ] && exit 2',
      FOCUSED,
      /scanner \(awk\) failed/,
    ],
    [
      "the join pass with plain=0 and carry=1",
      "awk",
      'p=; c=; for a in "$@"; do case "$a" in plain=0) p=1 ;; carry=1) c=1 ;; esac; done; [ "$p$c" = 11 ] && exit 2',
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
      "the readings pass",
      "awk",
      'for a in "$@"; do case "$a" in *jsnorm*) exit 2 ;; esac; done',
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
      'for a in "$@"; do case "$a" in *"]?(skip)"*) exit 2 ;; esac; done',
      OPTIONED,
      /option-object grep failed \(exit 2\)/,
    ],
    [
      "the placeholder strip (sed)",
      "sed",
      "exit 1",
      OPTIONED,
      /placeholder strip \(sed\) failed \(exit 1\)/,
    ],
    [
      "the base listing (git ls-tree)",
      "git",
      'for a in "$@"; do [ "$a" = ls-tree ] && exit 128; done',
      'test("clean", () => {});\n',
      /cannot list the files at/,
    ],
    [
      "the index listing (git ls-files)",
      "git",
      'for a in "$@"; do [ "$a" = ls-files ] && exit 128; done',
      'test("clean", () => {});\n',
      /cannot list the files in the index/,
    ],
    [
      "the test-file count (grep)",
      "grep",
      'for a in "$@"; do case "$a" in *"100[0-7]"*) exit 2 ;; esac; done',
      'test("clean", () => {});\n',
      /test-file count \(grep\) failed/,
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

  test("fails when a test file is turned into a symlink", () => {
    writeFileSync(path.join(dir, "keep.ts"), "export const kept = 1;\n");
    unlinkSync(path.join(dir, "base.test.ts"));
    symlinkSync("keep.ts", path.join(dir, "base.test.ts"));
    commitAll(dir, "link base");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 1/);
  });

  test("fails when a test file is turned into a submodule", () => {
    const head = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "rm", "-q", "base.test.ts");
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},base.test.ts`);
    // Not commitAll: add -A would drop the gitlink, which has no directory in the work tree.
    git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "submodule base");
    assert.match(git(dir, "ls-tree", "HEAD", "base.test.ts"), /^160000 /);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 1/);
  });

  test("fails when a test file whose name holds a non-ASCII character is deleted", () => {
    commitTestFile(dir, "\u00fc.test.ts", 'test("u", () => {});\n');
    git(dir, "branch", "-f", "base", "main");
    git(dir, "rm", "-q", "\u00fc.test.ts");
    commitAll(dir, "drop it");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 2/);
  });

  test("allows renaming a test file to another name with a non-ASCII character", () => {
    commitTestFile(dir, "\u00fc.test.ts", 'test("u", () => {});\n');
    git(dir, "branch", "-f", "base", "main");
    git(dir, "mv", "\u00fc.test.ts", "\u00f6.test.ts");
    commitAll(dir, "rename it");
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("fails when a test file whose name git quotes is deleted", () => {
    commitTestFile(dir, 'q".test.ts', 'test("q", () => {});\n');
    git(dir, "branch", "-f", "base", "main");
    git(dir, "rm", "-q", 'q".test.ts');
    commitAll(dir, "drop it");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 2/);
  });

  test("fails when a test file whose name holds a byte that is not valid UTF-8 is deleted", () => {
    // A spawn argument cannot carry the byte, so the file is made and removed through a Buffer
    // path and staged by add -A.
    const name = Buffer.concat([
      Buffer.from(`${dir}/`),
      Buffer.from([0xff]),
      Buffer.from(".test.ts"),
    ]);
    writeFileSync(name, 'test("x", () => {});\n');
    commitAll(dir, "add it");
    git(dir, "branch", "-f", "base", "main");
    unlinkSync(name);
    commitAll(dir, "drop it");
    const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 2/);
  });

  test("fails when a test file is deleted beside one left unmerged", () => {
    writeFileSync(path.join(dir, "a.test.ts"), 'test("a", () => {});\n');
    commitTestFile(dir, "c.test.ts", 'test("c", () => {});\n');
    git(dir, "branch", "-f", "base", "main");
    git(dir, "checkout", "-q", "-b", "other");
    commitTestFile(dir, "c.test.ts", 'test("c2", () => {});\n');
    git(dir, "checkout", "-q", "main");
    commitTestFile(dir, "c.test.ts", 'test("c3", () => {});\n');
    const merge = spawnSync("git", ["merge", "-q", "other"], { cwd: dir, env: gitEnv() });
    assert.equal(merge.status, 1, "the merge should stop on a conflict");
    git(dir, "rm", "-q", "a.test.ts");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /test files dropped from 3 \(base\) to 1\./);
  });

  test("allows a test file made executable", () => {
    chmodSync(path.join(dir, "base.test.ts"), 0o755);
    commitAll(dir, "make it executable");
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
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
