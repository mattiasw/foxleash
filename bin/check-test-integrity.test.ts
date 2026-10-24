import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

// This file is itself a *.test.ts, so the guard scans its own lines: every marker is assembled
// at runtime with m(), and fixture newlines are written as escapes, never as line breaks.

const SCRIPT = path.resolve(import.meta.dirname, "check-test-integrity.sh");
const REJECTED = /focus, skip or todo markers added/;
const PASSED = /check-test-integrity: OK/;

const SKIP_TRUE = m("skip", ": true");
const TODO_TRUE = m("todo", ": true");

// Two hunks: hunk 1 ends inside a block comment that closes between the hunks, so hunk 2,
// where the skip is edited in on the line that closes another comment, starts outside one.
const COMMENT_HUNK_BEFORE = `a();\n/${m("*")}\n one\n two\n three\n${m("*", "/")}\nb();\nc();\nd();\ne();\nf();\ng();\ntest /${m("*")}\n ${m("*", "/", ".todo(")}"t", fn);\n`;
const COMMENT_HUNK_AFTER = COMMENT_HUNK_BEFORE.replace("a();", "a(1);").replace(
  m(".", "todo("),
  m(".", "skip("),
);

// Two edits seven unchanged lines apart, so git prints two hunks at git's default 3 lines
// of context (it merges changes at most twice the context apart): hunk 1 ends with
// `const sizes = fit`, hunk 2 starts with `  .locator("a")`, and `await page` is in neither.
const HUNK_BOUNDARY_BEFORE =
  'x();\ny();\nz();\nconst sizes = fit\nawait page\n  .locator("a")\n  .first()\n  .nth(0)\n  .click();\n';
const HUNK_BOUNDARY_AFTER = HUNK_BOUNDARY_BEFORE.replace("x();", "x2();").replace(
  "  .click();",
  "  .dblclick();",
);

// The first line of a Playwright spec: only in a file importing @playwright/test is a skip
// whose first argument is a condition a conditional skip.
const PLAYWRIGHT_IMPORT = 'import { test } from "@playwright/test";\n';
// The two kinds of file a gate 2 case runs in: [label, file name, first line].
const FILE_KINDS: Array<[string, string, string]> = [
  ["node:test file", "bad.test.ts", ""],
  ["Playwright spec", "bad.spec.ts", PLAYWRIGHT_IMPORT],
];
const CONDITIONAL = `${m("test.", "skip(")}isCI, "reason");\ntest("t", () => {});\n`;

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

  test("check-test-markers.test.ts passes the guard when a project adds it", () => {
    const unitTests = path.join(import.meta.dirname, "check-test-markers.test.ts");
    commitTestFile(dir, "check-test-markers.test.ts", readFileSync(unitTests));
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

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

  test("lists a refused computed-key line as written, under its file and line", () => {
    commitTestFile(dir, "bad.test.ts", `run();\n${m("test", '["only"]')}("t", fn);\n`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.ok(out.includes(`\nbad.test.ts:2:\n${m("test", '["only"]')}("t", fn);\n`), out);
    assert.match(out, /allowed: \{ skip: !process\.env\.X \}/);
    assert.match(out, /the rules are in the header of bin\/check-test-markers\.ts\./);
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

  // A non-ASCII identifier is a condition in any locale: a conditional skip in a Playwright spec,
  // and a skip like any other in a node:test file.
  for (const [kind, name, prefix] of FILE_KINDS) {
    const expected = name === "bad.spec.ts" ? 0 : 1;
    test(`${expected ? "catches" : "allows"} a skip whose first argument starts with a non-ASCII letter, whatever the locale (${kind})`, () => {
      commitTestFile(dir, name, `${prefix}${m("test.", "skip(")}é, "r");\n`);
      const { status, out } = runGuard(dir, "base", { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
      assert.equal(status, expected, out);
      assert.match(out, expected ? REJECTED : PASSED);
    });
  }

  // A title holding a byte that is not valid UTF-8, followed by a marker or an options object.
  const INVALID_UTF8 = Buffer.from([0xff]);
  const invalidByteLines: Array<[string, string, string]> = [
    ["a focus marker", `${m("test.", "only(")}"focused", () => {}); // `, "\n"],
    [
      "an option-object skip on a test with a body",
      `test("real", { ${m("skip", ": true")} }, () => { // `,
      "\n  assert.ok(work());\n});\n",
    ],
    [
      "a skipIf on a string literal",
      `${m("test.skipIf(", '"')}`,
      `")("t", () => {\n  run();\n});\n`,
    ],
    [
      "a numeric option-object focus after the title",
      'test("x',
      `", { ${m("only", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "a numeric option-object skip after the title",
      'test("x',
      `", { ${m("skip", ": 1")} }, () => {\n  run();\n});\n`,
    ],
    [
      "an Infinity option-object skip after the title",
      'test("x',
      `", { ${m("skip", ": Infinity")} }, () => {\n  run();\n});\n`,
    ],
  ];
  for (const [label, before, after] of invalidByteLines) {
    test(`catches ${label} on a line holding a byte that is not valid UTF-8`, () => {
      commitTestFile(
        dir,
        "bad.test.ts",
        Buffer.concat([Buffer.from(before), INVALID_UTF8, Buffer.from(after)]),
      );
      const { status, out } = runGuard(dir, "base", { LC_ALL: "C.UTF-8" });
      assert.equal(status, 1, out);
      assert.match(out, REJECTED);
    });
  }

  test("allows the empty placeholder whose reason holds a byte that is not valid UTF-8", () => {
    commitTestFile(
      dir,
      "ok.test.ts",
      Buffer.concat([
        Buffer.from(`test("t", { ${m("skip", ': "set ')}`),
        INVALID_UTF8,
        Buffer.from(' to run" }, () => {});\n'),
      ]),
    );
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
    assert.ok(out.includes(`bad.test.ts:2:\ntest\n  ${m(".", 'skip("t", () => {')}\n`), out);
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

  test("allows a line edited inside an unchanged conditional skip that runs past 6 lines (Playwright spec)", () => {
    const longSkip = (cond: string) =>
      `${m("test.", "skip(")}isCI &&\n  isLinux &&\n  isHeadless &&\n  ${cond} &&\n  isA,\n  "reason",\n);\n`;
    commitChange(
      dir,
      "bad.spec.ts",
      `${PLAYWRIGHT_IMPORT}${longSkip("isSlow")}`,
      `${PLAYWRIGHT_IMPORT}${longSkip("isFast")}`,
    );
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("catches the arguments of an unchanged wrapped skip edited across an empty line under diff.suppressBlankEmpty (Playwright spec)", () => {
    git(dir, "config", "diff.suppressBlankEmpty", "true");
    commitChange(
      dir,
      "bad.spec.ts",
      `${PLAYWRIGHT_IMPORT}${m("test.", "skip(")}\n\n  isCI,\n  "reason",\n);\n`,
      `${PLAYWRIGHT_IMPORT}${m("test.", "skip(")}\n\n  "title",\n  async () => { run(); },\n);\n`,
    );
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("catches the condition line of an unchanged wrapped skip deleted above an empty line under diff.suppressBlankEmpty (Playwright spec)", () => {
    git(dir, "config", "diff.suppressBlankEmpty", "true");
    commitChange(
      dir,
      "bad.spec.ts",
      `${PLAYWRIGHT_IMPORT}${m("test.", "skip(")}\n  isCI,\n\n  "reason",\n);\n`,
      `${PLAYWRIGHT_IMPORT}${m("test.", "skip(")}\n\n  "reason",\n);\n`,
    );
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  for (const [label, configure, env] of [
    ["diff.context is 0", () => git(dir, "config", "diff.context", "0"), {}],
    ["GIT_DIFF_OPTS asks for no context", () => {}, { GIT_DIFF_OPTS: "--unified=0" }],
  ] as Array<[string, () => void, Record<string, string>]>) {
    test(`catches a skip added under an unchanged split receiver when ${label}`, () => {
      configure();
      commitChange(
        dir,
        "bad.test.ts",
        'test\n  .runIf(isCI)\n  .concurrent("t", fn);\n',
        `test\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);\n`,
      );
      const { status, out } = runGuard(dir, "base", env);
      assert.equal(status, 1, out);
      assert.match(out, REJECTED);
    });
  }

  for (const variable of [
    "GIT_LITERAL_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
  ]) {
    test(`catches a focus marker in a subdirectory when ${variable} is set`, () => {
      mkdirSync(path.join(dir, "src"));
      commitTestFile(dir, "src/b.test.ts", `${m("test.", "only(")}"focused", () => {});\n`);
      const { status, out } = runGuard(dir, "base", { [variable]: "1" });
      assert.equal(status, 1, out);
      assert.match(out, REJECTED);
    });
  }

  test("allows a call link on test.info() that is no skip in a Playwright spec", () => {
    commitTestFile(
      dir,
      "ok.spec.ts",
      `${PLAYWRIGHT_IMPORT}test("t", async () => {\n  test.info().annotations.push({ type: "x" });\n});\n`,
    );
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("prints a refused line as written, once", () => {
    commitTestFile(dir, "bad.test.ts", `${m("test.", "skip(")}isCI, "reason");\n`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    const refused = `${m("test.", "skip(")}isCI, "reason");`;
    assert.equal(out.split("\n").filter((line) => line === refused).length, 1, out);
  });

  test("a Playwright spec whose path holds a space keeps the exemption", () => {
    commitTestFile(dir, "a b.spec.ts", `${PLAYWRIGHT_IMPORT}${CONDITIONAL}`);
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  for (const config of ["diff.noprefix", "diff.mnemonicPrefix"]) {
    test(`a Playwright spec keeps the exemption under ${config}=true`, () => {
      git(dir, "config", config, "true");
      commitTestFile(dir, "ok.spec.ts", `${PLAYWRIGHT_IMPORT}${CONDITIONAL}`);
      const { status, out } = runGuard(dir);
      assert.equal(status, 0, out);
      assert.match(out, PASSED);
    });
  }

  test("a Playwright spec in another directory keeps the exemption when run from a subdirectory", () => {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "keep.ts"), "export {};\n");
    mkdirSync(path.join(dir, "e2e"));
    commitTestFile(dir, path.join("e2e", "ok.spec.ts"), `${PLAYWRIGHT_IMPORT}${CONDITIONAL}`);
    const { status, out } = runGuard(path.join(dir, "sub"));
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  test("diff.relative=true does not narrow a run from a subdirectory to that subdirectory", () => {
    git(dir, "config", "diff.relative", "true");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "keep.ts"), "export {};\n");
    commitTestFile(dir, "bad.test.ts", `${m("test.", "only(")}"focused", () => {});\n`);
    const { status, out } = runGuard(path.join(dir, "sub"));
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
  });

  test("a refused line repeated in two files is listed for each", () => {
    const focused = `${m("test.", "only(")}"focused", () => {});`;
    writeFileSync(path.join(dir, "a.test.ts"), `${focused}\n`);
    writeFileSync(path.join(dir, "b.test.ts"), `${focused}\n`);
    commitAll(dir, "two files");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.equal(out.split("\n").filter((line) => line === focused).length, 2, out);
  });

  test("each file in one diff keeps its own kind", () => {
    // a.test.ts ends with a wrapped call, b.spec.ts is a Playwright spec, c.test.ts starts with a
    // wrapped call.
    const wrapped = (cond: string) => `${m("test.", "skip(")}\n  ${cond},\n  "reason",\n);\n`;
    writeFileSync(path.join(dir, "a.test.ts"), `test("t", () => {});\n${wrapped("isA")}`);
    writeFileSync(path.join(dir, "b.spec.ts"), `${PLAYWRIGHT_IMPORT}${wrapped("isB")}`);
    writeFileSync(path.join(dir, "c.test.ts"), `${wrapped("isC")}test("t", () => {});\n`);
    commitAll(dir, "three files");
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /isA/);
    assert.match(out, /isC/);
    assert.doesNotMatch(out, /isB/);
  });

  const CLEAN = 'test("adds", () => {});\n';

  test("fails closed when the diff list's temp file cannot be created", () => {
    commitTestFile(dir, "ok.spec.ts", `${PLAYWRIGHT_IMPORT}${CONDITIONAL}`);
    const { status, out } = runGuard(dir, "base", { TMPDIR: path.join(dir, "no-such-dir") });
    assert.equal(status, 1, out);
    assert.match(out, /mktemp failed/);
    assert.doesNotMatch(out, PASSED);
  });

  test("fails closed when node is not on PATH", () => {
    commitTestFile(dir, "ok.test.ts", CLEAN);
    const bin = path.join(dir, ".no-node-bin");
    mkdirSync(bin);
    for (const tool of ["sh", "git", "grep", "mktemp", "rm", "dirname"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      assert.match(found.stdout, /^\//, `${tool} is not on PATH`);
      symlinkSync(found.stdout.trim(), path.join(bin, tool));
    }
    const { status, out } = runGuard(dir, "base", { PATH: bin });
    assert.equal(status, 1, out);
    assert.match(out, /node is not on PATH/);
    assert.doesNotMatch(out, PASSED);
  });

  // A copy of the two scripts in a directory with no node_modules above it, and no NODE_PATH, is
  // what a checkout that never installed the devDependency runs.
  test("fails closed when the @babel/parser package is missing", () => {
    commitTestFile(dir, "ok.test.ts", CLEAN);
    const copy = mkdtempSync(path.join(tmpdir(), "test-markers-no-parser-"));
    try {
      for (const file of ["check-test-integrity.sh", "check-test-markers.ts"]) {
        writeFileSync(path.join(copy, file), readFileSync(path.join(import.meta.dirname, file)));
      }
      const { NODE_PATH: _nodePath, ...env } = gitEnv();
      const res = spawnSync("sh", [path.join(copy, "check-test-integrity.sh")], {
        cwd: dir,
        env: { ...env, BASE_REF: "base" },
        encoding: "utf8",
      });
      const out = `${res.stdout}${res.stderr}`;
      assert.equal(res.status, 1, out);
      assert.match(out, /needs the @babel\/parser package/);
      assert.match(out, /gate 2 cannot judge/);
      assert.doesNotMatch(out, PASSED);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test("fails closed when a changed test file does not parse", () => {
    commitTestFile(dir, "bad.test.ts", 'test("t", () => {\n');
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /gate 2 cannot parse bad\.test\.ts: .*\(\d+:\d+\)/);
    assert.match(out, /check-test-markers\.ts exited 2; gate 2 cannot judge/);
    assert.doesNotMatch(out, PASSED);
  });

  test("removes the diff list's temp file", () => {
    commitTestFile(dir, "bad.test.ts", `${m("test.", "only(")}"focused", () => {});\n`);
    const temp = path.join(dir, ".tmp");
    mkdirSync(temp);
    const { status, out } = runGuard(dir, "base", { TMPDIR: temp });
    assert.equal(status, 1, out);
    assert.match(out, REJECTED);
    assert.deepEqual(readdirSync(temp), []);
  });

  test("removes the diff list's temp file when the guard is terminated", () => {
    commitTestFile(dir, "ok.test.ts", CLEAN);
    const temp = path.join(dir, ".tmp");
    mkdirSync(temp);
    // The stub is the command substitution's process, so its parent is the guard itself.
    const bin = stubDir(dir, "node", "#!/bin/sh\nkill -TERM $PPID\nexit 0\n");
    const { status, out } = runGuard(dir, "base", {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: temp,
    });
    assert.equal(status, 1, out);
    assert.doesNotMatch(out, PASSED);
    assert.deepEqual(readdirSync(temp), []);
  });

  test("allows a renamed test file that keeps a legacy skip under diff.renames=false", () => {
    git(dir, "config", "diff.renames", "false");
    const legacy = `${m("test.", "skip(")}"legacy", () => {\n  run();\n});\n`;
    commitTestFile(dir, "old.test.ts", legacy);
    git(dir, "branch", "-f", "base", "main");
    git(dir, "mv", "old.test.ts", "new.test.ts");
    commitAll(dir, "rename it");
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, PASSED);
  });

  // The hunk-boundary rows hold edits that diff as two hunks at git's default context.
  test("the hunk-boundary case diffs as two hunks at three lines of context", () => {
    commitChange(dir, "bad.test.ts", HUNK_BOUNDARY_BEFORE, HUNK_BOUNDARY_AFTER);
    const diff = git(dir, "diff", "--unified=3", "base...HEAD");
    assert.equal(diff.match(/^@@ /gm)?.length, 2, diff);
  });

  test("the block-comment hunk-boundary case diffs as two hunks at three lines of context", () => {
    commitChange(dir, "bad.test.ts", COMMENT_HUNK_BEFORE, COMMENT_HUNK_AFTER);
    const diff = git(dir, "diff", "--unified=3", "base...HEAD");
    assert.equal(diff.match(/^@@ /gm)?.length, 2, diff);
  });

  const FOCUSED = `${m("test.", "only(")}"focused", () => {});\n`;
  const CANNOT_JUDGE = /gate 2 cannot judge/;
  // [label, tool, the stub's failing condition, body, the error it prints, what it must not print]
  const failingStages: Array<[string, string, string, string, RegExp, RegExp?]> = [
    [
      "git diff",
      "git",
      'for a in "$@"; do [ "$a" = diff ] && exit 128; done',
      FOCUSED,
      /git diff .*failed/,
    ],
    [
      "the script's directory (dirname)",
      "dirname",
      "exit 1",
      FOCUSED,
      /cannot find the directory of/,
    ],
    [
      "the script's directory (cd)",
      "dirname",
      "echo /no-such-directory; exit 0",
      FOCUSED,
      /cannot find the directory of/,
    ],
    ["the diff list's temp file (mktemp)", "mktemp", "exit 1", FOCUSED, /mktemp failed/],
    [
      "reading a changed test file's blob (git cat-file)",
      "git",
      'for a in "$@"; do [ "$a" = cat-file ] && exit 128; done',
      FOCUSED,
      /git cat-file blob [0-9a-f]+ failed \(exit 128\)[\s\S]*check-test-markers\.ts exited 2; gate 2 cannot judge/,
      REJECTED,
    ],
    ...[1, 2, 4, 126, 127].map((code): [string, string, string, string, RegExp, RegExp] => [
      `the JavaScript check (exit ${code})`,
      "node",
      `exit ${code}`,
      CLEAN,
      new RegExp(`check-test-markers\\.ts exited ${code}; gate 2 cannot judge`),
      REJECTED,
    ]),
    [
      "the JavaScript check (killed by SIGKILL)",
      "node",
      "kill -KILL $$",
      CLEAN,
      /check-test-markers\.ts exited 137; gate 2 cannot judge/,
      REJECTED,
    ],
    [
      "the JavaScript check (killed by SIGTERM)",
      "node",
      "kill -TERM $$",
      CLEAN,
      /check-test-markers\.ts exited 143; gate 2 cannot judge/,
      REJECTED,
    ],
    ...[1, 2].map((code): [string, string, string, string, RegExp, RegExp] => [
      `the JavaScript check (a listing, then exit ${code})`,
      "node",
      `echo "bad.test.ts:1:"; exit ${code}`,
      CLEAN,
      new RegExp(
        `bad\\.test\\.ts:1:\\n[\\s\\S]*check-test-markers\\.ts exited ${code}; gate 2 cannot judge`,
      ),
      REJECTED,
    ]),
    [
      "the JavaScript check (exit 3 with no listing)",
      "node",
      "exit 3",
      CLEAN,
      REJECTED,
      CANNOT_JUDGE,
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
  ];

  for (const [label, tool, failWhen, body, error, absent] of failingStages) {
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
      if (absent !== undefined) assert.doesNotMatch(out, absent);
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

describe("check-test-integrity.sh on tables of test files", () => {
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
      "a skip split from its receiver by a trailing comment holding a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end, after a regex stripping trailing slashes",
      `const p = s.replace(/\\/*$/, ""); test // see */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end and a dot, after a regex holding its start",
      `x(/a\\/*/); test // a */ b.\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end",
      `x(1); test // flaky */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip two links below a root whose trailing comment holds a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  .sequential\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a link by a block comment spanning its line end, below a chain whose root's trailing comment holds a comment's end after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  .concurrent("a", () => {\n    run();\n  });\ntest\n  .describe /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a quoted trailing comment after a block comment holding a quote",
      `test /${m("* it's flaky *", "/")} // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a quoted trailing comment after a block comment holding a URL and a quote",
      `test /${m("* see https://x, it's flaky *", "/")} // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment spanning the root's line end",
      `test /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose closing line holds a quote",
      `test /${m("*", " see")}\n  it's flaky *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose next line starts like a line comment",
      `test /${m("*", " see")}\n  // https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after the close of a block comment spanning the root's line end",
      `test /${m("*", " see")}\n  https://x *${m("/")} ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose closing line opens another",
      `test /${m("*", " a")}\n  b *${m("/")} /${m("*", " c")}\n  d *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment over three lines",
      `test /${m("*", " see")}\n  https://x,\n  flaky on CI *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose first line holds a glob",
      `test /${m("*", " see src/", "*.ts")}\n  for the list *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a link by a block comment spanning the link's line end",
      `test\n  .describe /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a root after the close of a block comment holding a quote, by a quoted trailing comment",
      `/${m("*", " see")}\n  it's flaky *${m("/")} test // don't.\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
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
      `test("real", { ${SKIP_TRUE} }, () => { run(); }); f(() => {});\n`,
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
    // Names as the engine reads them: a computed literal key, an escaped name and a block
    // comment inside the line.
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
    ...["-offset", "~offset"].map((value): [string, string] => [
      `a skip option holding the condition ${value}`,
      `test("t", { skip: ${value} }, () => {\n  run();\n});\n`,
    ]),
    [
      "a todo option holding a negated name",
      'test("t", { todo: -offset }, () => {\n  run();\n});\n',
    ],
    [
      "a focus option holding a negated name",
      'test("t", { only: -offset }, () => {\n  run();\n});\n',
    ],
    [
      "a skip split by a comment holding a quote after a regex holding a quote and a string holding //",
      `x(/'/, "a//b"); test // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    ...[
      ["skip", "null"],
      ["skip", "NaN"],
      ["todo", "null"],
    ].map(([key = "", value = ""]): [string, string] => [
      `a ${key} option holding ${value} in an options object passed by name`,
      `const o = { ${m(key, `: ${value}`)} };\ntest("t", o, () => {\n  run();\n});\n`,
    ]),
    ...["todo", "expectFailure"].map((key): [string, string] => [
      `${key} as a method in an options object passed by name`,
      `const o = { ${m(key, "() {}")} };\ntest("t", o, () => {\n  run();\n});\n`,
    ]),
  ];

  const caughtEdits: Array<[string, string, string, boolean]> = [
    [
      "a callback condition of a legacy skip edited to always skip",
      `${m("test.", "skip(")}({ browserName }) => browserName !== "chromium", "r");\n`,
      `${m("test.", "skip(")}({ browserName }) => true, "r");\n`,
      false,
    ],
    [
      "an immediately invoked condition of a legacy skip option edited to always skip",
      `test("t", { ${m("skip", ": (() => isCI)()")} }, () => {\n  run();\n});\n`,
      `test("t", { ${m("skip", ": (() => true)()")} }, () => {\n  run();\n});\n`,
      false,
    ],
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
      "a skip edited in under an unchanged receiver line ending in a block comment holding a quote and a quoted trailing comment",
      `test /${m("* it's flaky *", "/")} // don't\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* it's flaky *", "/")} // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line whose block comment spans its line end",
      `test /${m("*", " see")}\n  https://x *${m("/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line whose block comment spans its line end, in a hunk after one ending inside a block comment",
      `const a = 1; /${m("*", " the setup below")}\n${" * note\n".repeat(10)} *${m("/")}\n${"step();\n".repeat(10)}test /${m("*", " see")}\n  https://x *${m("/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `const a = 2; /${m("*", " the setup below")}\n${" * note\n".repeat(10)} *${m("/")}\n${"step();\n".repeat(10)}test /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in under an unchanged receiver line whose trailing comment holds a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x(/a\\/*/); test // flaky */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      false,
    ],
    [
      "a skip edited in below a receiver line and a blank context line under diff.suppressBlankEmpty",
      "test\n\nx();\n",
      `test\n\n  ${m(".", "skip(")}"t", fn);\n`,
      true,
    ],
  ];

  const allowedEdits: Array<[string, string, string, boolean]> = [
    [
      "a locator edited under an unchanged split chain",
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n',
      'test("t", async ({ page }) => {\n  await page\n    .locator("b")\n    .click();\n});\n',
      false,
    ],
    [
      "an added line below a removed line, which it does not join",
      "x()\nconst box = fit\n",
      "x()\n  .last();\n",
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
    ...["!-(offset)", "InfinityMode", "!voidable", "void 0", "!void$x"].map(
      (value): [string, string] => [
        `a skip option holding the condition ${value}`,
        `test("t", { skip: ${value} }, () => {\n  run();\n});\n`,
      ],
    ),
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
      "a cursor skip below a trailing comment ending in a test name, after a regex holding a quote",
      `test("pages", async () => {\n  const rows = await db.find({ name: /'/ }) // page 1 is in the first test\n    ${m(".", "skip(")}10);\n  assert.equal(rows.length, 10);\n});\n`,
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
      "const s = String.raw`a.o\\nly(1) b.\\fixme(2) c.fi\\xme(3) \\tes\\t.skip(4) descri\\be.skip(5) desc\\ribe.skip(6) test.r\\unIf(false)(7)`;\n",
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

  describeRows(
    "new test files that must be refused",
    caught.map(([label, body]) => ({
      name: `catches ${label}`,
      file: "bad.test.ts",
      after: body,
      refused: true,
    })),
  );

  describeRows(
    "new test files that must pass",
    allowed.map(([label, body]) => ({
      name: `allows ${label}`,
      file: "ok.test.ts",
      after: body,
      refused: false,
    })),
  );

  for (const suppressBlankEmpty of [false, true]) {
    const config: Array<[string, string]> = suppressBlankEmpty
      ? [["diff.suppressBlankEmpty", "true"]]
      : [];
    const under = suppressBlankEmpty ? " under diff.suppressBlankEmpty" : "";
    describeRows(
      `edits that must be refused${under}`,
      caughtEdits
        .filter(([, , , flag]) => flag === suppressBlankEmpty)
        .map(([label, before, after]) => ({
          name: `catches ${label}`,
          file: "bad.test.ts",
          before,
          after,
          refused: true,
        })),
      config,
    );
    describeRows(
      `edits that must pass${under}`,
      allowedEdits
        .filter(([, , , flag]) => flag === suppressBlankEmpty)
        .map(([label, before, after]) => ({
          name: `allows ${label}`,
          file: "ok.test.ts",
          before,
          after,
          refused: false,
        })),
      config,
    );
  }
});

describe("check-test-integrity.sh on node:test files and Playwright specs", () => {
  const SPLIT_SKIP = `\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`;
  const caught: Array<[string, string]> = [
    ["focus marker .only", `${m("test.", "only(")}"focused", () => {});\n`],
    ["x-prefixed describe", `${m("x", "describe(")}"suite", () => {});\n`],
    ["f-prefixed it", `${m("f", "it(")}"focused", () => {});\n`],
    ["fixme on a test", `${m("test.", "fixme(")}"broken", () => {});\n`],
    ["fixme on a describe block", `${m("test.describe.", "fixme(")}"broken suite", () => {});\n`],
    ["bare skip() with no args", `test("t", () => {\n  ${m("test.", "skip()")};\n});\n`],
    ["bare skip() via it", `it("t", function () {\n  ${m("this.", "skip()")};\n});\n`],
    ["unconditional string-titled skip", `${m("test.", "skip(")}"flaky", () => {});\n`],
    ["a literal condition is never a condition", `${m("test.", "skip(")}true, "always");\n`],
    ["a numeric literal condition", `${m("test.", "skip(")}1, "always");\n`],
    ["a .each chain on only", `${m("test.", "only.each(")}[[1]])("n", () => {});\n`],
    ["a .each chain on skip", `${m("it.", "skip.each(")}[[1]])("n", () => {});\n`],
    [
      "a wrapped call with no condition on the next line",
      `${m("test.", "skip(")}\n);\ntest("t", () => {});\n`,
    ],
    [
      "unconditional option-object skip on a test with a body",
      `test("real", { ${m("skip", ": true")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "unconditional option-object skip on a multiline options object",
      `test("real", {\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "option-object skip with a string reason",
      `test("real", { ${m("skip", ': "flaky"')} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "option-object focus",
      `test("real", { ${m("only", ": true")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    ["focus on a mocha suite", `${m("suite.", "only(")}"s", () => {});\n`],
    ["focus on a serial describe", `${m("test.describe.serial.", "only(")}"s", () => {});\n`],
    ["focus on a parallel describe", `${m("test.describe.parallel.", "only(")}"s", () => {});\n`],
    ["fixme on a serial describe", `${m("test.describe.serial.", "fixme(")}"s", () => {});\n`],
    [
      "a .each chain on a generic receiver's only",
      `${m("suite.", "only.each(")}[[1]])("n", () => {});\n`,
    ],
    ["skip on a concurrent test", `${m("test.concurrent.", "skip(")}"s", () => {});\n`],
    ["skip on a mocha suite", `${m("suite.", "skip(")}"s", () => {});\n`],
    ["skip on a mocha context", `${m("context.", "skip(")}"s", () => {});\n`],
    ["skip on a mocha specify", `${m("specify.", "skip(")}"s", () => {});\n`],
    ["x-prefixed mocha context", `${m("x", "context(")}"s", () => {});\n`],
    ["x-prefixed mocha specify", `${m("x", "specify(")}"t", () => {});\n`],
    ["focus chained with failing", `${m("test.", "only.failing(")}"s", () => {});\n`],
    ["skip chained with failing", `${m("test.", "skip.failing(")}"s", () => {});\n`],
    ["skip chained with concurrent", `${m("test.", "skip.concurrent(")}"s", () => {});\n`],
    ["skip chained with fails", `${m("it.", "skip.fails(")}"s", () => {});\n`],
    [
      "focus on a describe chained with shuffle",
      `${m("describe.", "only.shuffle(")}"s", () => {});\n`,
    ],
    ["a bare skip with a tab inside", `test("t", () => {\n  ${m("test.", "skip(")}\t);\n});\n`],
    ["a string-titled skip after a tab", `${m("test.", "skip(")}\t"flaky", () => {});\n`],
    ["a skip whose only argument is a block comment", `${m("test.", "skip(")}/* flaky */);\n`],
    [
      "a wrapped skip whose only argument is a line comment",
      `${m("test.", "skip(")}\n  // flaky\n);\n`,
    ],
    ["a skip whose argument starts with a BOM", `${m("test.", "skip(")}\uFEFF);\n`],
    ["a negated literal condition", `${m("test.", "skip(")}!false, "r");\n`],
    ["a doubly negated numeric literal", `${m("test.", "skip(")}!!1, "r");\n`],
    ["a negated zero", `${m("test.", "skip(")}!0, "r");\n`],
    [
      "a skip titled by a variable",
      `const title = "x";\n${m("test.", "skip(")}title, () => {});\n`,
    ],
    [
      "a skip with an async fixture body",
      `${m("test.", "skip(")}title, async ({ page }) => {});\n`,
    ],
    [
      "a skip with options and an async body",
      `${m("test.", "skip(")}title, { tag: "@x" }, async () => {});\n`,
    ],
    ["a skip with a function-expression body", `${m("test.", "skip(")}title, function () {});\n`],
    ["a skip with a bare-parameter arrow body", `${m("test.", "skip(")}title, page => {});\n`],
    [
      "a skip in Biome's long-title shape (every argument on its own line)",
      `${m("test.", "skip(")}\n\tTITLES.checkout.refundsTheBuyerWhenThePaymentProviderTimesOut,\n\tasync ({ page }) => {\n\t\tawait page.goto("/");\n\t},\n);\n`,
    ],
    [
      "a long-title skip whose body runs over more than 6 lines",
      `${m("test.", "skip(")}\n\tTITLES.checkout.refundsTheBuyerWhenThePaymentProviderTimesOut,\n\tasync ({ page }) => {\n\t\tawait page.goto("/");\n\t\tawait page.click("a");\n\t\tawait page.click("b");\n\t},\n);\n`,
    ],
    ["a skip with a space before the dot", `${m("test .", "skip(")}"t", () => {\n  run();\n});\n`],
    ["an optional-chained skip", `${m("test?.", "skip(")}"t", () => {\n  run();\n});\n`],
    [
      "a skip on it with a space before the dot",
      `${m("it .", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a bare skip() with a space before the dot",
      `it("t", function () {\n  ${m("this .", "skip()")};\n});\n`,
    ],
    [
      "a bare skip() with a space before the parentheses",
      `it("t", function () {\n  ${m("this.", "skip ()")};\n});\n`,
    ],
    ["an optional-chained focus", `${m("test?.", "only(")}"t", () => {\n  run();\n});\n`],
    [
      "a .each chain on only reached by optional chaining",
      `${m("it.", "only?.each(")}[[1]])("n", () => {});\n`,
    ],
    [
      "a skip whose arguments start on the next line",
      `${m("test.", "skip")}\n("flaky", () => {\n  run();\n});\n`,
    ],
    [
      "a skip whose member access starts on the next line",
      `test\n  ${m(".", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional-chained skip whose member access starts on the next line",
      `test\n  ${m("?.", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a focus whose arguments start on the next line",
      `${m("test.", "only")}\n("t", () => {\n  run();\n});\n`,
    ],
    [
      "a focused .each whose table starts on the next line",
      `${m("it.", "only.each")}\n\`a\n\${1}\`("n", () => {\n  run();\n});\n`,
    ],
    [
      "a bare skip() whose parentheses are on the next line",
      `it("t", function () {\n  ${m("this.", "skip")}\n  ();\n});\n`,
    ],
    [
      "a skip after a conditional link, split after the call",
      `test\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional-chained skip after a conditional link, split after the call",
      `test\n  .runIf(isCI)\n  ${m("?.", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf(true) after a conditional link, split after the call",
      `test\n  .runIf(isCI)\n  ${m(".skipIf(", "true)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a comment line",
      `test\n  // flaky on CI\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment",
      `test // flaky on CI\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a conditional link holding a URL",
      `test\n  .runIf(url === "http://x")\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    ["an optional-call focus", `${m("test.", "only?.(")}"f", () => {\n  run();\n});\n`],
    ["an optional-call skip", `${m("test.", "skip?.(")}"t", () => {\n  run();\n});\n`],
    [
      "an optional-call skipped describe",
      `${m("describe.", "skip?.(")}"s", () => {\n  run();\n});\n`,
    ],
    [
      "an optional-call focused .each",
      `${m("it.", "only.each?.(")}[[1]])("n", () => {\n  run();\n});\n`,
    ],
    ["an optional-call bare skip()", `it("t", function () {\n  ${m("this.", "skip?.()")};\n});\n`],
    [
      "an optional-call skipIf(true)",
      `${m("test.skipIf", "?.(true)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional-call runIf(false)",
      `${m("test.runIf", "?.(false)(")}"t", () => {\n  run();\n});\n`,
    ],
    ["an optional-call skipIf(!0)", `${m("test.skipIf", "?.(!0)(")}"t", () => {\n  run();\n});\n`],
    [
      "a skip after an optional-call conditional link",
      `${m("test.runIf?.(isCI).", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "an optional-call focus split from its member access",
      `${m("test.", "only")}\n  ?.("f", () => {\n  run();\n});\n`,
    ],
    ["a skip with type arguments", `${m("test.", "skip<object>(")}"t", () => {\n  run();\n});\n`],
    [
      "an optional-call skip with type arguments",
      `${m("test.", "skip?.<object>(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip with type arguments and a space before the call",
      `${m("test.", "skip<object> (")}"t", () => {\n  run();\n});\n`,
    ],
    ["a focus with type arguments", `${m("test.", "only<T>(")}"t", () => {\n  run();\n});\n`],
    [
      "a skip with nested type arguments",
      `${m("test.", "skip<Array<string>>(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a non-null assertion before a skip's call",
      `${m("test.skip", "!(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a non-null assertion on a skip's receiver",
      `${m("test!.", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    ["a non-null assertion before a focus's call", `${m("test.only", "!(")}"t", fn);\n`],
    ["a non-null assertion on a focus's receiver", `${m("test!.", "only(")}"t", fn);\n`],
    ["a non-null fit", `${m("fit", "!(")}"t", fn);\n`],
    ["a non-null skip before .each", `${m("test.skip", "!.each(")}[1])("t", fn);\n`],
    ["a non-null receiver of a computed key", `${m("test!", '["only"]')}("t", fn);\n`],
    ["a non-null assertion after a space before the call", `${m("test.skip ", "!(")}"t", fn);\n`],
    ["a non-null skipIf(true)", `${m("test.skipIf", "!(true)(")}"t", fn);\n`],
    ["a non-null describe before its skip", `${m("test.describe!.", "skip(")}"s", fn);\n`],
    ["a non-null bare skip()", `it("t", function () {\n  ${m("this.skip", "!()")};\n});\n`],
    ["a non-null receiver split from its skip", `test!\n  ${m(".", "skip(")}"t", fn);\n`],
    [
      "a non-null skipIf(true) wrapped by the formatter",
      `${m("test.skipIf", "!(")}\n  true,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a literal skip on a non-null testInfo wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo!.", "skip(")}\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo with a non-null call, wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.skip", "!(")}\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a skip after an inline extend",
      `${m("test.extend({}).", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after an inline extend with type arguments",
      `${m("test.extend<{ a: number }>({}).", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    ["an optional-call f-prefixed focus", `${m("f", "it?.(")}"f", () => {\n  run();\n});\n`],
    [
      "a numeric option-object skip on an optional-call test",
      `test?.("real", { ${m("skip", ": 1")} }, () => { work(); });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a quote",
      `test // it's flaky on CI\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a conditional link with a trailing comment holding a quote",
      `test\n  .runIf(isCI) // don't run locally\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a conditional link whose argument is wrapped",
      `test\n  .runIf(\n    process.env.CI === "true" && process.env.SHARD === "1",\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped skipIf(true)",
      `${m("test.skipIf(", "\n  true,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped runIf(false)",
      `${m("test.runIf(", "\n  false,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    ["a wrapped skipIf(!0)", `${m("test.skipIf(", "\n  !0,\n)(")}"t", () => {\n  run();\n});\n`],
    [
      "skipIf(true) with a trailing comma",
      `${m("test.skipIf(", "true,)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped runIf(false) after a closed skipIf on the same line",
      `${m("test.skipIf(isA).runIf(", "\n  false,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped runIf(false) opened on the line that closes a wrapped skipIf",
      `${m("test.skipIf(\n  isA,\n).runIf(", "\n  false,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped runIf(false) opened on the line that closes a skipIf wrapped over six lines",
      `${m("test.skipIf(\n  isA &&\n    isB &&\n    isC &&\n    isD &&\n    isE,\n).runIf(", "\n  false,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped skipIf(true) opened on the line that closes a wrapped runIf link",
      `test\n  .runIf(\n    isA,\n  )${m(".skipIf(", "\n    true,\n  )(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped skipIf(true) whose opening line has a comment holding a paren",
      `${m("test.skipIf(", " // flaky :)\n  true,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a wrapped conditional link whose opening line has a comment holding a paren",
      `test\n  .runIf( // see :)\n    isCI,\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a conditional link holding a template literal and a quoted trailing comment",
      `test\n  .runIf(\`\${x}\`) // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a conditional link holding an escaped quote and a quoted trailing comment",
      `test\n  .runIf(x === "a\\"b") // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a quoted trailing comment ending in a URL",
      `test // don't run on CI, see https://github.com/o/r/issues/12\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing line comment that starts like a block comment",
      `test //${m("* flaky on CI *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end, after a string holding its start",
      `x("src/*"); test // why **/a\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment ending in a comment's end, after a URL string holding its start",
      `x("http://a/*"); test // see */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a focused test before a block comment ending its line, after a regex holding a quote and a glob string",
      `const pat = /'/, glob = 'src/*.ts'; ${m("test.", "only(")}"t", fn); /${m("* see *", "/")}\n(async () => {})();\n`,
    ],
    [
      "a focused test before a chain root ending in a block comment, after a regex holding a quote",
      `const re = /'/, p = 'a/*'; ${m("test.", "only(")}"t", fn), x /${m("* c *", "/")}\n  .y();\n`,
    ],
    [
      "a focused test before a block comment ending its line, after a regex followed by a product",
      `const n = /x/*y; ${m("test.", "only(")}"t", fn); /${m("* c *", "/")}\n(async () => {})();\n`,
    ],
    [
      "a wrapped skipIf after a regex holding a comment's start and a string holding its end and a //",
      `x(/a\\/*/, "*/ //"); ${m("test.", "skipIf(")}\n  true,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end, after a regex stripping trailing slashes",
      `const p = s.replace(/\\/*$/, ""); test // see */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end and a dot, after a regex holding its start",
      `x(/a\\/*/); test // a */ b.\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a trailing comment holding a comment's end",
      `x(1); test // flaky */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip two links below a root whose trailing comment holds a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  .sequential\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip below a wrapped runIf link on a root whose trailing comment holds a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  .runIf(\n    isCI,\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a link by a block comment spanning its line end, below a chain after a regex holding a comment opener",
      `x(/a\\/*/); test // flaky */\n  .concurrent("a", () => {\n    run();\n  });\ntest\n  .describe /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped runIf whose first line ends in a block comment after void",
      `${m("test.", "runIf(")}void /${m("* c *", "/")}\n  0,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a wrapped runIf link whose block comment holds a URL and a paren",
      `test\n  ${m(".", "runIf(")} /${m("* see https://github.com/o/r/issues/1, fixed in v2) *", "/")}\n    isCI,\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped skipIf whose first line ends in a block comment holding a paren",
      `${m("test.", "skipIf(")} /${m("* see :) *", "/")}\n  true,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped skipIf whose first line holds a block comment with a quote and a quoted trailing comment holding a paren",
      `${m("test.", "skipIf(")} /${m("* it's *", "/")} // don't :)\n  true,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a quoted trailing comment after a block comment holding a quote",
      `test /${m("* it's flaky *", "/")} // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a quoted trailing comment after a block comment holding a URL and a quote",
      `test /${m("* see https://x, it's flaky *", "/")} // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped skipIf link split from its receiver whose line holds a block comment with a quote and a quoted trailing comment holding a paren",
      `test\n  ${m(".", "skipIf(")} /${m("* it's *", "/")} // don't :)\n    true,\n  )("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped skipIf on a string holding a // below a block comment with a quote and a quoted trailing comment",
      `${m("test.", "skipIf(")} /${m("* it's *", "/")} // don't :)\n  "a long reason that holds a // in it",\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a block comment spanning the root's line end",
      `test /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose closing line holds a quote",
      `test /${m("*", " see")}\n  it's flaky *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose next line starts like a line comment",
      `test /${m("*", " see")}\n  // https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after the close of a block comment spanning the root's line end",
      `test /${m("*", " see")}\n  https://x *${m("/")} ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a line holding only a block comment",
      `test\n  /${m("* flaky *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment over two lines of its own",
      `test\n  /${m("*", " flaky on CI,")}\n     see #12 *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose closing line opens another",
      `test /${m("*", " a")}\n  b *${m("/")} /${m("*", " c")}\n  d *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip on a link line starting with a block comment",
      `test\n  /${m("* flaky *", "/")} ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment over three lines",
      `test /${m("*", " see")}\n  https://x,\n  flaky on CI *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from its receiver by a block comment whose first line holds a glob",
      `test /${m("*", " see src/", "*.ts")}\n  for the list *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a link by a block comment spanning the link's line end",
      `test\n  .describe /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a wrapped runIf link by a block comment spanning its line end",
      `test\n  ${m(".", "runIf(")}\n    isCI,\n  ) /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip split from a root after the close of a block comment holding a quote, by a quoted trailing comment",
      `/${m("*", " see")}\n  it's flaky *${m("/")} test // don't.\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped skipIf after the close of a block comment holding a URL",
      `/${m("*", " see")}\n  https://github.com/o/r/issues/1 *${m("/")} ${m("test.", "skipIf(")}\n  true,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a wrapped runIf after the close of a block comment holding a URL",
      `/${m("*", " see")}\n  https://github.com/o/r/issues/1 *${m("/")} test.runIf(\n  process.env.CI === "true",\n)\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped runIf whose void and 0 sit on two lines",
      `${m("test.", "runIf(")}void\n  0,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped runIf whose void and 0 sit on two lines, a block comment before the 0",
      `${m("test.", "runIf(")}void\n  /${m("* c *", "/")} 0,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped skipIf whose sign and number sit on two lines",
      `${m("test.", "skipIf(")}-\n  1,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped runIf whose sign and zero sit on two lines",
      `${m("test.", "runIf(")}-\n  0,\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped skipIf whose sign and string sit on two lines",
      `${m("test.", "skipIf(")}+\n  "x",\n)("t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip split from its receiver by a quoted trailing comment holding a second //",
      `test // it's flaky // see #12\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a wrapped conditional link whose argument line holds a quoted trailing comment",
      `test\n  .runIf(\n    isCI, // don't run locally\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a wrapped conditional link whose argument line has a comment holding a paren",
      `test\n  .runIf(\n    isCI, // flaky on CI :)\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a conditional link whose argument is wrapped over five lines",
      `test\n  .runIf(\n    process.env.CI === "true" &&\n      process.env.SHARD === "1" &&\n      process.env.A === "1" &&\n      process.env.B === "1" &&\n      process.env.C === "1",\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a wrapped optional-call skipIf(true)",
      `${m("test.skipIf", "?.(\n  true,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped skipIf(true) after a skipIf whose argument holds a paren in a string",
      `test.skipIf(name === "(")("a", () => {\n  run(1);\n  run(2);\n  run(3);\n  run(4);\n  run(5);\n  run(6);\n});\n${m("test.skipIf(", "\n  true,\n)(")}"t", () => {\n  run();\n});\n`,
    ],
    ...(['"', "'", "`"] as const).map((q): [string, string] => [
      `a skip after a conditional link holding a URL in ${q} quotes and a quoted trailing comment`,
      `test\n  .runIf(url === ${q}http://x${q}) // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ]),
    [
      "a skip after a wrapped conditional link whose opening line holds a quoted trailing comment",
      `test\n  .runIf( // don't run locally\n    isCI,\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    ["skip on a sequential test", `${m("test.sequential.", "skip(")}"t", () => {\n  run();\n});\n`],
    ["skip on a fails test", `${m("test.fails.", "skip(")}"t", () => {\n  run();\n});\n`],
    [
      "skip on a sequential describe",
      `${m("describe.sequential.", "skip(")}"s", () => {\n  run();\n});\n`,
    ],
    [
      "a skipped step inside a test body",
      `test("t", async () => {\n  await ${m("test.step.", "skip(")}"s", async () => {});\n});\n`,
    ],
    [
      "a skip after a conditional link",
      `${m("test.runIf(isCI).", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a conditional link whose argument holds a call",
      `${m("test.runIf(f(x)).", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a conditional link whose argument holds a call, split after the call",
      `test\n  .runIf(f(x))\n  ${m(".", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a wrapped conditional link whose argument holds a call",
      `test\n  .runIf(\n    f(x),\n  )\n  ${m(".", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a conditional link whose argument holds a call nested twice",
      `${m("test.runIf(f(g(x))).", "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "a skip after a conditional link whose argument holds an open paren in a string",
      `${m('test.runIf(s === "(").', "skip(")}"t", () => {\n  run();\n});\n`,
    ],
    ["skipIf(true)", `${m("test.skipIf(", "true)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf with a non-zero number", `${m("test.skipIf(", "1)(")}"t", () => {\n  run();\n});\n`],
    [
      "skipIf with a non-empty string",
      `${m("test.skipIf(", '"x")(')}"t", () => {\n  run();\n});\n`,
    ],
    ["runIf(false)", `${m("test.runIf(", "false)(")}"t", () => {\n  run();\n});\n`],
    ["runIf with zero", `${m("test.runIf(", "0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf with an empty string", `${m("test.runIf(", '"")(')}"t", () => {\n  run();\n});\n`],
    ["runIf(null)", `${m("test.runIf(", "null)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(undefined)", `${m("test.runIf(", "undefined)(")}"t", () => {\n  run();\n});\n`],
    [
      "skipIf with a string holding another quote kind",
      `${m("test.skipIf(", `"it's flaky")(`)}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf with a negated string holding another quote kind",
      `${m("test.skipIf(", `!"it's")(`)}"t", fn);\n`,
    ],
    [
      "skipIf with a signed string holding another quote kind",
      `${m("test.skipIf(", `+"it's")(`)}"t", fn);\n`,
    ],
    [
      "runIf with a signed string holding another quote kind",
      `${m("test.runIf(", `-"it's")(`)}"t", fn);\n`,
    ],
    [
      "a comma expression ending in a string holding another quote kind in skipIf",
      `${m("test.skipIf(", `(x, "it's"))(`)}"t", fn);\n`,
    ],
    [
      "skipIf with a template literal holding an apostrophe",
      `${m("test.skipIf(", "`it's`)(")}"t", fn);\n`,
    ],
    [
      "skipIf with a string holding an escaped quote",
      `${m("test.skipIf(", '"it\\"s")(')}"t", fn);\n`,
    ],
    [
      "skipIf(true) on a describe",
      `${m("describe.skipIf(", "true)(")}"s", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf(true) after a modifier",
      `${m("test.concurrent.skipIf(", "true)(")}"t", () => {\n  run();\n});\n`,
    ],
    ["skipIf with a negated literal", `${m("test.skipIf(", "!0)(")}"t", () => {\n  run();\n});\n`],
    [
      "skipIf with a parenthesised literal",
      `${m("test.skipIf(", "(true))(")}"t", () => {\n  run();\n});\n`,
    ],
    ["runIf with a negated literal", `${m("test.runIf(", "!1)(")}"t", () => {\n  run();\n});\n`],
    [
      "skipIf with a negated parenthesised false",
      `${m("test.skipIf(", "!(false))(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf with a negated false",
      `${m("test.skipIf(", "!false)(")}"t", () => {\n  run();\n});\n`,
    ],
    ["skipIf with a negated null", `${m("test.skipIf(", "!null)(")}"t", () => {\n  run();\n});\n`],
    [
      "skipIf with a negated undefined",
      `${m("test.skipIf(", "!undefined)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf with a spaced negated empty string",
      `${m("test.skipIf(", ' !"" )(')}"t", () => {\n  run();\n});\n`,
    ],
    ["skipIf(Infinity)", `${m("test.skipIf(", "Infinity)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(-Infinity)", `${m("test.skipIf(", "-Infinity)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(1e3)", `${m("test.skipIf(", "1e3)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(0x1)", `${m("test.skipIf(", "0x1)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(1n)", `${m("test.skipIf(", "1n)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(-1)", `${m("test.skipIf(", "-1)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(.5e1)", `${m("test.skipIf(", ".5e1)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(0.05)", `${m("test.skipIf(", "0.05)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(!NaN)", `${m("test.skipIf(", "!NaN)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(!Infinity)", `${m("test.skipIf(", "!Infinity)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(!void 0)", `${m("test.skipIf(", "!void 0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(NaN)", `${m("test.runIf(", "NaN)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(void 0)", `${m("test.runIf(", "void 0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(void(0))", `${m("test.runIf(", "void(0))(")}"t", () => {\n  run();\n});\n`],
    ["runIf(0e5)", `${m("test.runIf(", "0e5)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(0x0)", `${m("test.runIf(", "0x0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(0n)", `${m("test.runIf(", "0n)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(.0)", `${m("test.runIf(", ".0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(!1e3)", `${m("test.runIf(", "!1e3)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(-0)", `${m("test.runIf(", "-0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(!-1)", `${m("test.runIf(", "!-1)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(!-Infinity)", `${m("test.skipIf(", "!-Infinity)(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(+true)", `${m("test.skipIf(", "+true)(")}"t", () => {\n  run();\n});\n`],
    ['skipIf(+"1")', `${m("test.skipIf(", '+"1")(')}"t", () => {\n  run();\n});\n`],
    ["skipIf(!-null)", `${m("test.skipIf(", "!-null)(")}"t", () => {\n  run();\n});\n`],
    ['skipIf(!+"")', `${m("test.skipIf(", '!+"")(')}"t", () => {\n  run();\n});\n`],
    ["runIf(-NaN)", `${m("test.runIf(", "-NaN)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(+null)", `${m("test.runIf(", "+null)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(-false)", `${m("test.runIf(", "-false)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(-void 0)", `${m("test.runIf(", "-void 0)(")}"t", () => {\n  run();\n});\n`],
    ['runIf(-"")', `${m("test.runIf(", '-"")(')}"t", () => {\n  run();\n});\n`],
    ["skipIf(-(1))", `${m("test.skipIf(", "-(1))(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(-!0)", `${m("test.skipIf(", "-!0)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(-!1)", `${m("test.runIf(", "-!1)(")}"t", () => {\n  run();\n});\n`],
    ["runIf(+(0))", `${m("test.runIf(", "+(0))(")}"t", () => {\n  run();\n});\n`],
    ["skipIf(+-1)", `${m("test.skipIf(", "+-1)(")}"t", fn);\n`],
    ["skipIf(-+true)", `${m("test.skipIf(", "-+true)(")}"t", fn);\n`],
    ["runIf(+-0)", `${m("test.runIf(", "+-0)(")}"t", fn);\n`],
    ["skipIf(+-!0)", `${m("test.skipIf(", "+-!0)(")}"t", fn);\n`],
    ['skipIf(-+"x")', `${m("test.skipIf(", '-+"x")(')}"t", fn);\n`],
    ["skipIf(- 1)", `${m("test.skipIf(", "- 1)(")}"t", fn);\n`],
    ["runIf(- 0)", `${m("test.runIf(", "- 0)(")}"t", fn);\n`],
    ["skipIf(+ - 1)", `${m("test.skipIf(", "+ - 1)(")}"t", fn);\n`],
    ['skipIf(+ "x")', `${m("test.skipIf(", '+ "x")(')}"t", fn);\n`],
    ["runIf(- [])", `${m("test.runIf(", "- [])(")}"t", fn);\n`],
    ["runIf(- /x/)", `${m("test.runIf(", "- /x/)(")}"t", fn);\n`],
    ["skipIf((x, - 1))", `${m("test.skipIf(", "(x, - 1))(")}"t", fn);\n`],
    [
      "skipIf on an arrow",
      `${m("test.skipIf(", "() => !process.env.DB)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on an async arrow",
      `${m("test.skipIf(", "async () => x)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on a bare-parameter arrow",
      `${m("test.skipIf(", "x => x)(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on a function expression",
      `${m("test.skipIf(", "function () { return x; })(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on an async function expression",
      `${m("test.skipIf(", "async function () {})(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on a parenthesised arrow",
      `${m("test.skipIf(", "(() => x))(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "runIf on a negated arrow",
      `${m("test.runIf(", "!(() => x))(")}"t", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on an arrow, on a describe",
      `${m("describe.skipIf(", "() => x)(")}"s", () => {\n  run();\n});\n`,
    ],
    [
      "skipIf on an immediately invoked arrow (refused: the strict side)",
      `${m("test.skipIf(", "(() => !process.env.DB)())(")}"t", () => {\n  run();\n});\n`,
    ],
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
      "a numeric option-object skip",
      `test("real", { ${m("skip", ": 1")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a negated-literal option-object skip",
      `test("real", { ${m("skip", ": !0")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip that is Infinity",
      `test("real", { ${m("skip", ": Infinity")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip that is -Infinity",
      `test("real", { ${m("skip", ": -Infinity")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a negative option-object skip",
      `test("real", { ${m("skip", ": -1")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a fractional option-object skip",
      `test("real", { ${m("skip", ": .5")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a signed true option-object skip",
      `test("t", { ${m("skip", ": -true")} }, () => { work(); });\n`,
    ],
    [
      "a signed true option-object focus",
      `test("t", { ${m("only", ": +true")} }, () => { work(); });\n`,
    ],
    [
      "a negated signed option-object skip",
      `test("t", { ${m("skip", ": !-(1)")} }, () => { work(); });\n`,
    ],
    [
      "a signed string option-object skip",
      `test("t", { ${m("skip", ': +"1"')} }, () => { work(); });\n`,
    ],
    [
      "a negated void option-object skip",
      `test("t", { ${m("skip", ": !void 0")} }, () => { work(); });\n`,
    ],
    [
      "a parenthesised negative option-object skip",
      `test("t", { ${m("skip", ": (-1)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip whose reason holds another quote kind",
      `test("t", { ${m("skip", `: "it's flaky"`)} }, () => {\n  work();\n});\n`,
    ],
    [
      "an option-object skip whose escaped quote reads like the empty placeholder",
      `test("t", { ${m("skip", ': "x\\" }, () => {}); //"')} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed name, a number node:test always skips for",
      `test("t", { ${m("skip", ": -offset")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip on a plus-signed name",
      `test("t", { ${m("skip", ": +x")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a parenthesised signed name",
      `test("t", { ${m("skip", ": (-offset)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a parenthesised plus-signed name",
      `test("t", { ${m("skip", ": (+x)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed element",
      `test("t", { ${m("skip", ": -arr[0]")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed non-null name",
      `test("t", { ${m("skip", ": -x!")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed optional member",
      `test("t", { ${m("skip", ": -x?.y")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed call",
      `test("t", { ${m("skip", ": -f(x)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed nested call",
      `test("t", { ${m("skip", ": -f(g(x))")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed call with two arguments",
      `test("t", { ${m("skip", ": -f(a, b)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a cast signed name",
      `test("t", { ${m("skip", ": -offset as unknown as boolean")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed member before a second option",
      `test("t", { ${m("skip", ": -x.length")}, timeout: 5 }, () => { work(); });\n`,
    ],
    [
      "an option-object skip that is null",
      `test("t", { ${m("skip", ": null")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip that is NaN",
      `test("t", { ${m("skip", ": NaN")} }, () => { work(); });\n`,
    ],
    [
      "an option-object todo that is null",
      `test("t", { ${m("todo", ": null")} }, () => { work(); });\n`,
    ],
    [
      "an option-object focus that is NaN",
      `test("t", { ${m("only", ": NaN")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip that is zero",
      `test("t", { ${m("skip", ": 0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip that is an empty string",
      `test("t", { ${m("skip", ': ""')} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a bitwise-not literal",
      `test("t", { ${m("skip", ": ~0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a bitwise-not search",
      `test("t", { ${m("skip", ": ~x.indexOf(y)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a double bitwise not",
      `test("t", { ${m("skip", ": ~~x")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip starting with a bitwise-not literal",
      `test("t", { ${m("skip", ": ~0 || isCI")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip starting with a negated bitwise-not literal",
      `test("t", { ${m("skip", ": !~0 || isCI")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a bitwise-not function",
      `test("t", { ${m("skip", ": ~(() => x)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a negated bitwise-not function",
      `test("t", { ${m("skip", ": !~(() => x)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a bitwise-not object",
      `test("t", { ${m("skip", ": ~{}")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a negated bitwise-not object",
      `test("t", { ${m("skip", ": !~{}")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a regex literal",
      `test("t", { ${m("skip", ": /x/")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a regex literal holding an escaped slash",
      `test("t", { ${m("skip", ": /a\\/b/g")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a cast regex literal",
      `test("t", { ${m("skip", ": /x/ as unknown as boolean")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a doubly negated regex literal",
      `test("t", { ${m("skip", ": !!/x/")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a typeof",
      `test("t", { ${m("skip", ": typeof x")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a parenthesised typeof",
      `test("t", { ${m("skip", ": typeof(x)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a new object",
      `test("t", { ${m("skip", ": new Date()")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a new object of a member class",
      `test("t", { ${m("skip", ": new a.B(1)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a new object with no arguments",
      `test("t", { ${m("skip", ": new Set")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on an awaited literal",
      `test("t", { ${m("skip", ": await 1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on an awaited negated literal",
      `test("t", { ${m("skip", ": await !0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip in an options object that is the first argument",
      `test({ ${m("skip", ": 1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip in a first-argument options object after a space",
      `test( { ${m("skip", ": 1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip in a first-argument options object after a block comment",
      `test(/${m("* c *", "/")} { ${m("skip", ": 1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a parenthesised signed name in a first-argument options object",
      `test({ ${m("skip", ": (-offset)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip after a type assertion",
      `test("t", <TestOptions>{ ${m("skip", ": 1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip inside a spread object",
      `test("t", { ...{ ${m("skip", ": 1")} } }, () => { work(); });\n`,
    ],
    [
      "an option-object skip inside a spread object after another option",
      `test("t", { timeout: 5, ...{ ${m("skip", ": 1")} } }, () => { work(); });\n`,
    ],
    [
      "an option-object skip after a block comment before the value",
      `test("t", { ${m("skip", ": /* x */ ", "true")} }, () => { work(); });\n`,
    ],
    [
      "a numeric option-object skip after a block comment before the value",
      `test("t", { ${m("skip", ": /* x */ ", "1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip after a block comment before a second-argument options object",
      `test("t", /${m("* c *", "/")} { ${m("skip", ": 1")} }, () => { work(); });\n`,
    ],
    [
      "a numeric option-object focus",
      `test("real", { ${m("only", ": 1")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a parenthesised-literal option-object skip",
      `test("real", { ${m("skip", ": (true)")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip with a space before the colon",
      `test("real", { ${m("skip", " : true")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip after a block comment",
      `test("real", { /* flaky */ ${m("skip", ": true")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip with a double-quoted key",
      `test("real", { ${m('"skip"', ": true")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object focus with a single-quoted key",
      `test("real", { ${m("'only'", ": true")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a wrapped option-object skip after a comment ending in a period",
      `test("real", {\n  // Flaky on CI, see #12.\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a wrapped option-object skip after a comment ending in a call",
      `test("real", {\n  // flaky, see retry()\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a wrapped option-object skip after a trailing comment ending in a period",
      `test("real", {\n  timeout: 5, // see "#12".\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a wrapped option-object skip after a trailing comment ending in a call",
      `test("real", {\n  timeout: 5, // see retry("x")\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a wrapped option-object skip after a trailing comment ending in a word",
      `test("real", {\n  timeout: 5, // flaky "on" CI\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "a wrapped option-object skip after a comment ending in a word",
      `test("real", {\n  // flaky on CI\n  ${m("skip", ": true")},\n}, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip with a real body and an empty arrow later on the line",
      `test("real", { ${m("skip", ": true")} }, () => { run(); }); const f = () => {};\n`,
    ],
    [
      "an option-object skip with a real body holding a callback after an object",
      `test("real", { ${m("skip", ": true")} }, () => { on({ once: true }, () => {}); });\n`,
    ],
    [
      "an option-object skip with a real body holding an empty arrow",
      `test("real", { ${m("skip", ": true")} }, () => { run(); [1].map(() => {}); });\n`,
    ],
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
    ["a computed key after a call link", `${m("test.extend({})", '["skip"]')}("t", fn);\n`],
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
      "a block comment between a literal and its cast",
      `${m("test.skipIf(true /", "* c */ as boolean)(")}"t", fn);\n`,
    ],
    [
      "a computed key between two strings holding a comment's ends",
      `const a = "/*"; ${m("test", '["only"]')}("t", fn); const b = "*/";\n`,
    ],
    [
      "a block comment after the dot, after a string holding a comment's start",
      `describe("globs src/*", () => ${m("test./", "* why */ only(")}"t", fn));\n`,
    ],
    [
      "a block comment after the dot, after a template literal holding a comment's start",
      `describe(\`globs src/*\`, () => ${m("test./", "* why */ only(")}"t", fn));\n`,
    ],
    [
      "a block comment after the dot of a skip, after a single-quoted comment start",
      `describe('globs src/*', () => ${m("test./", "* c */skip(")}"t", fn));\n`,
    ],
    [
      "a block comment after the dot, between strings holding a comment's start and end",
      `describe("src/*", () => ${m("test./", "* c */only(")}"a */ b", fn));\n`,
    ],
    [
      "a block comment after the dot of a split chain link",
      `test\n  ${m("./", "* x */only")}\n  ("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a block comment after the dot of a split chain link with a trailing comment",
      `test\n  ${m("./", "* x */only")} // flaky\n  ("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a block comment after the dot of a chain split from its call, after a string holding a comment's start",
      `x("/*"); ${m("test./", "* y */only")}\n  ("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a focused test between glob strings holding a comment's start and end, on a split chain",
      `foo("src/*.ts"); ${m("test.", "only(")}"t", fn); bar("**/x")\n  .baz();\n`,
    ],
    [
      "a focus between two block comments, split from its call",
      `test /${m("* a */.only /", "* b */")}\n  ("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a focus after a block comment, split from its call, after a URL string holding a comment's start",
      `foo("http://h/*"); test /${m("* x */.", "only")}\n  ("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a focus between two block comments after a call, split from its call",
      `foo(); /${m("* a */ test.only /", "* b */")}\n  ("t", () => {\n    run();\n  });\n`,
    ],
    ["an empty array as a skipIf argument", `${m("test.skipIf(", "[])(")}"t", fn);\n`],
    ["an empty object as a skipIf argument", `${m("test.skipIf(", "{})(")}"t", fn);\n`],
    ["an array literal as a skipIf argument", `${m("test.skipIf(", "[1, 2])(")}"t", fn);\n`],
    ["an object literal as a skipIf argument", `${m("test.skipIf(", "{ a: 1 })(")}"t", fn);\n`],
    ["a negated array as a runIf argument", `${m("test.runIf(", "![])(")}"t", fn);\n`],
    ["a negated object as a skipIf argument", `${m("test.skipIf(", "!{})(")}"t", fn);\n`],
    ["a parenthesised array as a skipIf argument", `${m("test.skipIf(", "([]))(")}"t", fn);\n`],
    ["a literal cast with as in skipIf", `${m("test.skipIf(", "true as boolean)(")}"t", fn);\n`],
    [
      "a literal cast with satisfies in skipIf",
      `${m("test.skipIf(", "1 satisfies number)(")}"t", fn);\n`,
    ],
    [
      "a literal cast twice in runIf",
      `${m("test.runIf(", "0 as unknown as boolean)(")}"t", fn);\n`,
    ],
    [
      "a parenthesised cast literal in skipIf",
      `${m("test.skipIf(", "(true as boolean))(")}"t", fn);\n`,
    ],
    ["an array cast in skipIf", `${m("test.skipIf(", "[] as Flags)(")}"t", fn);\n`],
    [
      "a comma expression ending in true in skipIf",
      `${m("test.skipIf(", "(0, true))(")}"t", fn);\n`,
    ],
    [
      "a comma expression ending in false in runIf",
      `${m("test.runIf(", "(x, false))(")}"t", fn);\n`,
    ],
    ["a negated comma expression in skipIf", `${m("test.skipIf(", "!(0, false))(")}"t", fn);\n`],
    [
      "a comma expression ending in a cast literal in skipIf",
      `${m("test.skipIf(", "(x, true as boolean))(")}"t", fn);\n`,
    ],
    [
      "a comma expression ending in an array in runIf",
      `${m("test.runIf(", "(x, []))(")}"t", fn);\n`,
    ],
    [
      "a comma expression ending in a negated literal in skipIf",
      `${m("test.skipIf(", "(x, !0))(")}"t", fn);\n`,
    ],
    ["a signed array as a runIf argument", `${m("test.runIf(", "+[])(")}"t", fn);\n`],
    ["a signed array as a skipIf argument", `${m("test.skipIf(", "-[1])(")}"t", fn);\n`],
    ["a skipIf on a bitwise-not literal", `${m("test.skipIf(", "~0)(")}"t", fn);\n`],
    ["a runIf on a bitwise-not literal", `${m("test.runIf(", "~0)(")}"t", fn);\n`],
    ["a skipIf on a signed bitwise-not literal", `${m("test.skipIf(", "-~0)(")}"t", fn);\n`],
    ["a runIf on a negated bitwise-not literal", `${m("test.runIf(", "!~0)(")}"t", fn);\n`],
    ["a bitwise-not comma expression in skipIf", `${m("test.skipIf(", "~(x, 0))(")}"t", fn);\n`],
    [
      "a comma expression ending in a bitwise-not literal in skipIf",
      `${m("test.skipIf(", "(x, ~0))(")}"t", fn);\n`,
    ],
    ["a regex literal as a skipIf argument", `${m("test.skipIf(", "/x/)(")}"t", fn);\n`],
    ["a signed regex literal as a runIf argument", `${m("test.runIf(", "-/x/)(")}"t", fn);\n`],
    ["a sign run before an array as a runIf argument", `${m("test.runIf(", "+-[])(")}"t", fn);\n`],
    [
      "a sign run before a regex literal as a runIf argument",
      `${m("test.runIf(", "+-/x/)(")}"t", fn);\n`,
    ],
    ["a runIf with no argument", `${m("test.runIf(", ")(")}"t", fn);\n`],
    ["a runIf with no argument on a describe", `${m("describe.runIf(", " )(")}"s", fn);\n`],
    ["a negated regex literal as a runIf argument", `${m("test.runIf(", "!/x/)(")}"t", fn);\n`],
    [
      "a comma expression ending in a regex literal in skipIf",
      `${m("test.skipIf(", "(x, /x/))(")}"t", fn);\n`,
    ],
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
      "a wrapped computed fails key",
      `test("t", {\n  ${m('["fa', 'ils"]: true')},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a todo option on a test with a body",
      `test("t", { ${m("to", "do: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a todo option with a string reason",
      `test("t", { ${m("to", 'do: "later"')} }, () => {\n  work();\n});\n`,
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
      "a wrapped fails option",
      `test("t", {\n  ${m("fa", "ils: true")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a fails option on a test with a body",
      `test("t", { ${m("fa", "ils: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a fails option with a string on the test call's line",
      `test("t", { ${m("fa", 'ils: "known bug"')} }, () => {\n  work();\n});\n`,
    ],
    [
      "a fails option with a number on the test call's line",
      `test("t", { ${m("fa", "ils: 1")} }, () => {\n  work();\n});\n`,
    ],
    [
      "a fails option on an empty test (no placeholder needs it)",
      `test("x (set X to run)", { ${m("fa", "ils: true")} }, () => {});\n`,
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
      "a todo option beside an object holding a function (no placeholder)",
      `test("real", { ${m("to", "do: true")}, x: f({}, () => {}) }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected failure on test",
      `${m("test.expect", "Failure(")}"t", () => {\n  work();\n});\n`,
    ],
    ["an expected failure on it", `${m("it.expect", "Failure(")}"t", () => {\n  work();\n});\n`],
    [
      "an expected failure on describe",
      `${m("describe.expect", "Failure(")}"d", () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure each chain",
      `${m("it.expect", "Failure.each(")}[[1]])("n", () => {\n  work();\n});\n`,
    ],
    [
      "an expected failure through a computed key",
      `${m('test["expect', 'Failure"](')}"t", () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option set to true on the test call's line",
      `test("t", { ${m("expect", "Failure: true")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option set to true on its own line of a wrapped options object",
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
      "an expected-failure option that is an arrow on its own line",
      `test("t", {\n  ${m("expect", "Failure: (e) => true")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option that is a number on its own line",
      `test("t", {\n  ${m("expect", "Failure: 0")},\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure method on the test call's line",
      `test("t", { ${m("expect", "Failure() {}")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure getter on the test call's line",
      `test("t", { ${m("get expect", "Failure() { return true; }")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option on an empty test (no placeholder)",
      `test("p", { ${m("expect", "Failure: true")} }, () => {});\n`,
    ],
    [
      "an expected-failure option on a negative offset on the test call's line",
      `test("t", { ${m("expect", "Failure: -offset")} }, () => {\n  work();\n});\n`,
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
      "an expected-failure option holding the Error class on its own line",
      `test("t", {\n  ${m("expect", "Failure: Error")},\n}, () => {\n  work();\n});\n`,
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
    [
      "an expected-failure option with a quoted key",
      `test("t", { ${m('"expect', 'Failure": true')} }, () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure imported by name from node:test",
      `${m("import { expect", 'Failure } from "node:test";')}\nexpectFailure("t", () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure imported from node:test beside a default import and renamed",
      `${m("import test, { describe, expect", 'Failure as xf } from "node:test";')}\nxf("t", () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure imported from node:test after another statement on its line",
      `import test from "node:test"; ${m("import { expect", 'Failure } from "node:test";')}\nexpectFailure("t", () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure required by name from node:test",
      `${m("const { expect", 'Failure } = require("node:test");')}\nexpectFailure("t", () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure required by name from node:test and exported",
      `${m("export const { expect", 'Failure } = require("node:test");')}\nexpectFailure("t", () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure destructured from a parenthesised dynamic import of node:test",
      `${m("const { expect", 'Failure } = (await import("node:test"));')}\nexpectFailure("t", () => {\n  work();\n});\n`,
    ],
    [
      "expectFailure destructured from a dynamic import of node:test",
      `${m("const { expect", 'Failure } = await import("node:test");')}\nexpectFailure("t", () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure reason Biome puts on the line below its key",
      `test("parses the header", {\n  ${m("expect", "Failure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure reason on the line below its quoted key",
      `test("t", {\n  ${m('"expect', 'Failure":')}\n    "known bug",\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure reason below its key past a comment line",
      `test("t", {\n  ${m("expect", "Failure:")}\n    // tracked in #42\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure reason 3 lines below its key past two comment lines",
      `test("t", {\n  ${m("expect", "Failure:")}\n    // tracked in #42\n    // and #43\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure reason below its key spelled with an escape",
      `test("t", {\n  ${m("expect\\u0046", "ailure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure reason below a key with a block comment before its colon",
      `test("t", {\n  ${m("expect", "Failure /* tracked in #42 */:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n});\n`,
    ],
    [
      "a Playwright skip annotation",
      `test("x", { ${m("annota", 'tion: { type: "skip" }')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright fixme annotation in an array after another annotation",
      `test("x", { ${m("annota", 'tion: [{ type: "issue", description: "x" }, { type: "fixme" }]')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright fail annotation",
      `test("x", { ${m("annota", 'tion: { type: "fail" }')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation on a describe block",
      `test.describe("s", { ${m("annota", 'tion: { type: "skip" }')} }, () => {\n  test("t", fn);\n});\n`,
    ],
    [
      "a Playwright skip annotation on the key line of a wrapped options object",
      `test("a long name", {\n  ${m("annota", 'tion: { type: "skip" }')},\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation with quoted keys",
      `test("x", { ${m('"annota', 'tion": { "type": "skip" }')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation whose type follows a description",
      `test("x", { ${m("annota", 'tion: { description: "x", type: "skip" }')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation whose description holds a brace",
      `test("x", { ${m("annota", 'tion: { description: "see {1}", type: "skip" }')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright fixme annotation after an array item whose string holds a bracket",
      `test("x", { ${m("annota", 'tion: [{ type: "issue", description: "a]b" }, { type: "fixme" }]')} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright fixme annotation wrapped over lines",
      `test("checkout", {\n  ${m("annota", "tion: {")}\n    type: "fixme",\n    description: "https://github.com/acme/shop/issues/1",\n  },\n}, async ({ page }) => {\n  await page.goto("/");\n});\n`,
    ],
    [
      "a Playwright skip annotation in an array with one item per line",
      `test("x", {\n  ${m("annota", "tion: [")}\n    { type: "skip", description: "x" },\n  ],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation as the second item of an array with one item per line",
      `test("checkout", {\n  ${m("annota", "tion: [")}\n    { type: "issue", description: "https://github.com/o/r/issues/42" },\n    { type: "skip" },\n  ],\n}, async ({ page }) => {\n  await page.goto("/");\n});\n`,
    ],
    [
      "a Playwright skip annotation in an array of items Biome wrapped over four lines each",
      `test("x", {\n  ${m("annota", "tion: [")}\n    {\n      type: "issue",\n      description: "https://github.com/acme/shop/issues/1",\n    },\n    {\n      type: "skip",\n      description: "https://github.com/acme/shop/issues/2",\n    },\n  ],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation on the 12th line of a wrapped array",
      `test("x", {\n  ${m("annota", "tion: [")}\n    {\n      type: "issue",\n      description: "https://github.com/acme/shop/issues/1",\n    },\n    {\n      type: "issue",\n      description: "https://github.com/acme/shop/issues/2",\n    },\n    {\n      description: "https://github.com/acme/shop/issues/3",\n      type: "skip",\n    },\n  ],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation wrapped from the test call's line",
      `test("x", { ${m("annota", "tion: {")}\n  type: "skip",\n} }, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright fixme annotation with quoted keys wrapped over lines",
      `test("x", {\n  ${m('"annota', 'tion": {')}\n    "type": "fixme",\n  },\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation under a computed key wrapped over lines",
      `test("x", {\n  ${m('["annota', 'tion"]: [')}\n    { type: "skip" },\n  ],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation whose description holds a closing brace",
      `test("x", {\n  ${m("annota", "tion: {")}\n    description: "see }",\n    type: "skip",\n  },\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation whose description holds an escaped quote and a brace",
      `test("x", {\n  ${m("annota", "tion: {")}\n    description: "a \\" }",\n    type: "skip",\n  },\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation whose key is spelled with an escape",
      `test("x", {\n  ${m("annot\\u0061", "tion: {")}\n    type: "skip",\n  },\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation with a block comment before its brace",
      `test("x", {\n  ${m("annota", "tion: /* flaky on CI */ {")}\n    type: "skip",\n  },\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation holding a block comment with a closing brace",
      `test("x", {\n  ${m("annota", "tion: {")}\n    /* } */\n    type: "skip",\n  },\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation after an item whose description holds a bracket",
      `test("x", {\n  ${m("annota", "tion: [")}\n    { type: "issue", description: "a]b" },\n    { type: "skip" },\n  ],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a wrapped Playwright skip annotation below a comment line holding an apostrophe",
      `test("x", {\n  ${m("annota", "tion: [")}\n    // don't run until #42\n    { type: "skip" },\n  ],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright fail annotation wrapped over lines on a describe block",
      `test.describe("s", {\n  ${m("annota", "tion: {")}\n    type: "fail",\n  },\n}, () => {\n  test("t", fn);\n});\n`,
    ],
    [
      "a Playwright skip annotation in a hugged array",
      `test("x", {\n  ${m("annota", "tion: [{")}\n    type: "skip",\n  }],\n}, async () => {\n  run();\n});\n`,
    ],
    [
      "a Playwright skip annotation as the second object of a hugged array",
      `test("x", {\n  ${m("annota", "tion: [{")}\n    type: "issue",\n  }, {\n    type: "skip",\n  }],\n}, async () => {\n  run();\n});\n`,
    ],
    ["a todo with a body", `${m("test.", "todo(")}"t", () => {\n  work();\n});\n`],
    ["a todo with a body via it", `${m("it.", "todo(")}"t", () => {\n  work();\n});\n`],
    ["a todo on a describe block with a body", `${m("describe.", "todo(")}"s", () => {});\n`],
    ["a todo with a body passed by name", `${m("test.", "todo(")}"t", namedBody);\n`],
    ["a todo titled by a variable", `${m("test.", "todo(")}title);\n`],
    ["a todo whose name ends its line", `${m("test.", "todo(")}"t"\n  , fn);\n`],
    ["a todo whose template name holds a call", m("test.", "todo(", "`a $", "{f()}`);\n")],
    ["a chain after a todo", `${m("test.", "todo.each(")}[[1]])("n %s", fn);\n`],
    [
      "node:test's bare in-body todo",
      `test("t", (t) => {\n  ${m("t.", "todo()")};\n  throw new Error("x");\n});\n`,
    ],
    ["Jest's failing", `${m("test.", "failing(")}"t", fn);\n`],
    ["Vitest's fails via it", `${m("it.", "fails(")}"t", fn);\n`],
    ["Vitest's fails on a concurrent link", `${m("test.concurrent.", "fails(")}"t", fn);\n`],
    ["a .each chain on failing", `${m("test.", "failing.each(")}[[1]])("n", fn);\n`],
    ["Playwright's bare fail in a body", `test("t", () => {\n  ${m("test.", "fail()")};\n});\n`],
    ["an unconditional titled fail", `${m("test.", "fail(")}"t", fn);\n`],
    ["a literal condition on fail", `${m("test.", "fail(")}true, "r");\n`],
    ["a condition, on the fail of test.info()", `${m("test.info().", "fail(")}isCI, "r");\n`],
    [
      "a literal skip on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}true, "r");\n});\n`,
    ],
    [
      "a bare fail on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "fail()")};\n});\n`,
    ],
    [
      "a literal fail on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "fail(")}true, "r");\n});\n`,
    ],
    [
      "a bitwise-not literal skip on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}~0, "r");\n});\n`,
    ],
    [
      "a regex literal skip on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}/x/, "r");\n});\n`,
    ],
    [
      "a function as the condition of a testInfo skip",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}() => true);\n});\n`,
    ],
    [
      "a literal skip on testInfo wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal fail on testInfo wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "fail(")}\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo wrapped around comments",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} // why\n    // it's flaky\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on an optional testInfo wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo?.", "skip(")}\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo called optionally, wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip?.(")}\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo after a comment holding a paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} // 1) flaky\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo under a comment line holding a paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    // 1) flaky on CI\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo under a comment line holding an open paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    // flaky (see #12\n    true,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo wrapped by the formatter whose reason holds an open paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    true,\n    'flaky :(',\n  );\n  a();\n  b();\n  c();\n});\n`,
    ],
    [
      "a literal skip on testInfo whose void and 0 sit on two lines",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}void\n    0,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo whose sign and number sit on two lines",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}-\n    1,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo whose void and 0 sit on two lines below a trailing comment",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} // flaky\n    void\n    0,\n    "r",\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo whose first line holds a block comment with a quote and a quoted trailing comment holding a paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} /${m("* it's *", "/")} // don't :)\n    true,\n    'r',\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo whose second line holds a block comment with a quote and a quoted trailing comment holding a paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    /${m("* it's *", "/")} // don't :)\n    true,\n    'r',\n  );\n});\n`,
    ],
    [
      "a literal skip on testInfo whose first line holds a block comment with a quote and a quoted trailing comment holding a paren, its reason holding an open paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} /${m("* it's *", "/")} // don't :)\n    true,\n    'flaky :(',\n  );\n  a();\n  b();\n  c();\n});\n`,
    ],
    [
      "a literal skip on testInfo wrapped after a regex ending in an escaped slash, its reason holding an open paren (strict side)",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}/\\/\\//.test(u) ||\n    true,\n    'flaky :(',\n  );\n  a();\n  b();\n  c();\n});\n`,
    ],
    [
      "a literal skip on testInfo, below a wrapped conditional one holding a comment line",
      `test("a", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    /${m("* why *", "/")}\n    isCI,\n    "r",\n  );\n});\ntest("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} /${m("* it's *", "/")} // don't :)\n    true,\n    'flaky :(',\n  );\n  a();\n  b();\n  c();\n});\n`,
    ],
    [
      "a skip split by a block comment after a regex holding a comment opener",
      `x(/a\\/*/); test /* c */${SPLIT_SKIP}`,
    ],
    [
      "a literal skip on testInfo wrapped by the formatter, with no paren on the lines after it",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    true,\n    'flaky :(',\n  );\n  a;\n  b;\n  c;\n});\n`,
    ],
    [
      "a skip after a split link whose condition holds a call",
      `test\n  .runIf(f(x))\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a skip after a wrapped link whose condition holds a call",
      `test\n  .runIf(\n    f(x),\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
    ],
    [
      "a test helper named expectFailure declared and called without a receiver",
      'async function expectFailure(req: Request, what: string, code: string) {\n  assert.ok(await check(req), what + code);\n}\ntest("t", async () => {\n  await expectFailure(lookupRequest(UID), "auth read", "9");\n});\n',
    ],
    [
      "a helper named expectFailure imported from a local module",
      'import { expectFailure } from "./helpers";\ntest("t", async () => {\n  await expectFailure(req, "auth read", "9");\n});\n',
    ],
    [
      "a helper named expectFailure imported from the npm package test",
      'import { expectFailure } from "test";\ntest("t", async () => {\n  await expectFailure(req, "auth read", "9");\n});\n',
    ],
    [
      "the empty placeholder with a todo option",
      `test("store (set DATABASE_URL to run)", { ${m("to", "do: true")} }, () => {});\n`,
    ],
    [
      "a null todo data key on its own line",
      `const rows = [\n  {\n    ${m("to", "do: null")},\n  },\n];\n`,
    ],
  ];

  const caughtInPlaywright: Array<[string, string]> = [
    ["a parenthesised literal", `${m("test.", "skip(")}(true), "r");\n`],
    ["an arrow returning a literal", `${m("test.", "skip(")}() => true, "r");\n`],
    [
      "an arrow with a parameter returning a literal",
      `${m("test.", "skip(")}({}) => true, "r");\n`,
    ],
    ["an arrow returning a parenthesised literal", `${m("test.", "skip(")}() => (true), "r");\n`],
    ["an arrow returning a negated literal", `${m("test.", "skip(")}() => !0, "r");\n`],
    ["a negated empty string", `${m("test.", "skip(")}!"", "r");\n`],
    ["a negated parenthesised false", `${m("test.", "skip(")}!(false), "r");\n`],
    ["a negated null", `${m("test.", "skip(")}!null, "r");\n`],
    ["a negated undefined", `${m("test.", "skip(")}!undefined, "r");\n`],
    ["a negated NaN", `${m("test.", "skip(")}!NaN, "r");\n`],
    ["Infinity", `${m("test.", "skip(")}Infinity, "r");\n`],
    ["a parenthesised string", `${m("test.", "skip(")}("x"), "r");\n`],
    ["a negated void", `${m("test.", "skip(")}!void 0, "always");\n`],
    ["a parenthesised negative number", `${m("test.", "skip(")}(-1), "always");\n`],
    ["a doubly negated fraction", `${m("test.", "skip(")}!!.5, "always");\n`],
    ["a negated signed string", `${m("test.", "skip(")}!-"x", "always");\n`],
    ["a doubly negated signed number", `${m("test.", "skip(")}!!-(1), "always");\n`],
    ["an arrow returning a negative number", `${m("test.", "skip(")}() => -1, "always");\n`],
    ["a doubly negated bitwise-not literal", `${m("test.", "skip(")}!!~0, "r");\n`],
    ["an arrow returning a bitwise-not literal", `${m("test.", "skip(")}() => ~0, "r");\n`],
    ["a doubly negated regex literal", `${m("test.", "skip(")}!!/x/, "r");\n`],
    ["an arrow returning a regex literal", `${m("test.", "skip(")}() => /x/, "r");\n`],
    ["a literal whose arguments start on the next line", `${m("test.", "skip")}\n(true, "r");\n`],
    ["a condition, on the skip of test.info()", `${m("test.info().", "skip(")}isCI, "r");\n`],
    [
      "a condition and a function after a block comment",
      `${m("test.", "skip(")}isCI, /${m("* c *", "/")} () => {});\n`,
    ],
    ["a condition, on an optional computed skip", `${m("test?.", '["skip"]')}(isCI, "r");\n`],
    ["a condition followed by a function, on fail", `${m("test.", "fail(")}isWebkit, () => {});\n`],
  ];

  const wrappedConditionals: Array<[string, string, string, boolean]> = [
    [
      "a wrapped skip whose next added line follows an empty context line under diff.suppressBlankEmpty",
      "x();\n\nend();\n",
      `${m("test.", "skip(")}\n\nisCI);\nend();\n`,
      true,
    ],
    [
      "a link added inside a wrapped conditional skip",
      `${m("test.", "skip(")}\n  process.env.B\n    .trim()\n    .toLowerCase() === "1" &&\n  process.env.C\n    .trim()\n    .toLowerCase() === "1",\n  "reason",\n);\n`,
      `${m("test.", "skip(")}\n  process.env.B\n    .normalize()\n    .trim()\n    .toLowerCase() === "1" &&\n  process.env.C\n    .trim()\n    .toLowerCase() === "1",\n  "reason",\n);\n`,
      false,
    ],
    [
      "a link deleted inside a wrapped conditional skip",
      `${m("test.", "skip(")}\n  process.env.B\n    .trim()\n    .toLowerCase() === "1" &&\n  process.env.C\n    .trim()\n    .toLowerCase() === "1",\n  "reason",\n);\n`,
      `${m("test.", "skip(")}\n  process.env.B\n    .toLowerCase() === "1" &&\n  process.env.C\n    .trim()\n    .toLowerCase() === "1",\n  "reason",\n);\n`,
      false,
    ],
  ];

  const CHAIN_BEFORE =
    'test\n  .runIf(process.env.CI)\n  .concurrent("t", async () => {\n    run();\n  });\n';
  const LEGACY_SKIP = (cond: string) =>
    `${m("test.", "skip(")}\n  ${cond},\n  "r"\n    .concat("1")\n    .concat("2")\n    .concat("3")\n    .concat("4"),\n  () => {\n    run();\n  },\n);\n`;
  const HUNK_BOUNDARY_BEFORE =
    'x();\ny();\nz();\nw();\nv();\nconst sizes = fit\nawait page\n  .locator("a")\n  .first()\n  .nth(0)\n  .last()\n  .nth(1)\n  .click();\n';
  const WRAPPED_TESTINFO = (cond: string, reason = "reason") =>
    `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    ${cond},\n    "${reason}",\n  );\n});\n`;
  const HUNK_BOUNDARY_AFTER = HUNK_BOUNDARY_BEFORE.replace("x();", "x2();").replace(
    "  .click();",
    "  .dblclick();",
  );
  const contextEdits: Array<[string, string, string, number]> = [
    [
      "an edit inside an unchanged skip whose call the hunk ends inside",
      LEGACY_SKIP("isA"),
      LEGACY_SKIP("isB"),
      1,
    ],
    [
      "a skip added under an unchanged split receiver chain",
      CHAIN_BEFORE,
      `test\n  .runIf(process.env.CI)\n  ${m(".", "skip(")}"t", async () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a literal skipIf added under an unchanged split receiver",
      'test\n  .runIf(isCI)("t", () => {\n    run();\n  });\n',
      `test\n  ${m(".skipIf(", "true)(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added as the last line of a file with no newline at its end",
      'test\n  .runIf(isCI)\n  .concurrent("t", fn);',
      `test\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);`,
      1,
    ],
    [
      "a skip added two links below another edit of the same split chain",
      'test\n  .concurrent\n  .runIf(isCI)\n  .sequential("t", () => {\n    run();\n  });\n',
      `test\n  .sequential\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged chain holding a comment line",
      'test\n  // flaky on CI\n  .concurrent("t", () => {\n    run();\n  });\n',
      `test\n  // flaky on CI\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added below a chain link that another edit followed with a comment line",
      'test\n  .concurrent\n  .runIf(isCI)\n  .sequential("t", () => {\n    run();\n  });\n',
      `test\n  .sequential\n  // why\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added below a comment line added alone above the chain's next link",
      'test\n  .runIf(isCI)\n  .concurrent("t", fn);\n',
      `test\n  // flaky\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a skip added under an unchanged chain whose root holds a trailing comment",
      'test // flaky, see #12.\n  .runIf(isCI)\n  .concurrent("t", fn);\n',
      `test // flaky, see #12.\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a skip added under an unchanged root holding a quoted trailing comment",
      'test // it\'s flaky\n  .concurrent("t", fn);\n',
      `test // it's flaky\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a URL in a block comment",
      `${m("test.", "skip(")}\n  isCI /${m("* https://bugs.webkit.org/1 *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n);\n`,
      `${m("test.", "skip(")}\n  isCI /${m("* https://bugs.webkit.org/1 *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a skip added under an unchanged root ending in a block comment holding a URL",
      `test /${m("* see https://x *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* see https://x *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root ending in a block comment, after a string holding a comment's start",
      `x("/*"); test /${m("* see *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x("/*"); test /${m("* see *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root ending in a block comment holding a quote and a quoted trailing comment",
      `test /${m("* it's flaky *", "/")} // don't\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* it's flaky *", "/")} // don't\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root ending in two block comments",
      `test /${m("* a */ /", "* b */")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("* a */ /", "* b */")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root whose block comment spans its line end",
      `test /${m("*", " see")}\n  https://x *${m("/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test /${m("*", " see")}\n  https://x *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root and a block comment over two lines of its own",
      `test\n  /${m("*", " flaky on CI,")}\n     see #12 *${m("/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test\n  /${m("*", " flaky on CI,")}\n     see #12 *${m("/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "an edited doc comment opener above prose holding an open testInfo skip, below a chain split by a block comment",
      `foo /${m("*", " a")}\n b *${m("/")}\n  .bar();\n/${m("*", "*")}\n * Prefer ${m("testInfo.", "skip(")} over\n * a bare return.\n *${m("/")}\n`,
      `foo /${m("*", " a")}\n b *${m("/")}\n  .bar();\n/${m("*", "*")} Note.\n * Prefer ${m("testInfo.", "skip(")} over\n * a bare return.\n *${m("/")}\n`,
      0,
    ],
    [
      "an empty line added inside an unchanged split skip chain",
      `test\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      `test\n\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      0,
    ],
    [
      "a skip added under an unchanged root and a line holding only a block comment, in a hunk after one ending inside a block comment",
      `const a = 1; /${m("*", " the setup below")}\n${" * note\n".repeat(10)} *${m("/")}\n${"step();\n".repeat(10)}test\n  /${m("* flaky *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `const a = 2; /${m("*", " the setup below")}\n${" * note\n".repeat(10)} *${m("/")}\n${"step();\n".repeat(10)}test\n  /${m("* flaky *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root whose trailing comment holds a comment's end, after a regex holding its start",
      `x(/a\\/*/); test // flaky */\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x(/a\\/*/); test // flaky */\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a URL in a block comment, after a match-pattern string",
      `${m("test.", "skip(")}\n  isCI && urls("*://*/x") /${m("* https://bugs.webkit.org/1 *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n);\n`,
      `${m("test.", "skip(")}\n  isCI && urls("*://*/x") /${m("* https://bugs.webkit.org/1 *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose trailing comment holds a paren and a comment's end, after a string holding its start",
      `${m("test.", "skip(")}\n  isCI("/*") || browserSupports( // flaky ) */\n    "a-long-feature-name",\n  ),\n);\n`,
      `${m("test.", "skip(")}\n  isCI("/*") || browserSupports( // flaky ) */\n    "a-long-feature-name",\n  ),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a skip added under an unchanged root ending in a block comment, after a match-pattern string",
      `x("*://*/*"); test /${m("* see https://x *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x("*://*/*"); test /${m("* see https://x *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a skip added under an unchanged root ending in a block comment, after a string holding an escaped quote",
      `x("a\\"b"); test /${m("* see https://x *", "/")}\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `x("a\\"b"); test /${m("* see https://x *", "/")}\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a URL in a block comment and ends in a quoted comment holding a paren",
      `${m("test.", "skip(")}\n  isCI /${m("* https://bugs.webkit.org/1 *", "/")} || browserSupports( // it's flaky :)\n    "a-long-feature-name",\n  ),\n);\n`,
      `${m("test.", "skip(")}\n  isCI /${m("* https://bugs.webkit.org/1 *", "/")} || browserSupports( // it's flaky :)\n    "a-long-feature-name",\n  ),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a URL and a paren in a block comment",
      `${m("test.", "skip(")}\n  isCI /${m("* https://bugs.webkit.org/1 :) *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n);\n`,
      `${m("test.", "skip(")}\n  isCI /${m("* https://bugs.webkit.org/1 :) *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a paren in a block comment",
      `${m("test.", "skip(")}\n  isCI /${m("* 1) flaky *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n);\n`,
      `${m("test.", "skip(")}\n  isCI /${m("* 1) flaky *", "/")} || browserSupports(\n    "a-long-feature-name",\n  ),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a skip added under an unchanged wrapped runIf link whose block comment holds a URL and a paren",
      `test\n  ${m(".", "runIf(")} /${m("* https://x :) *", "/")}\n    isCI,\n  )\n  .concurrent("t", () => {\n    run();\n  });\n`,
      `test\n  ${m(".", "runIf(")} /${m("* https://x :) *", "/")}\n    isCI,\n  )\n  ${m(".", "skip(")}"t", () => {\n    run();\n  });\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a comment's start in a string with an escaped quote, and its end in a later string",
      `${m("test.", "skip(")}\n  isCI || check("a\\"/*", browserSupports(\n    "*/",\n  )),\n);\n`,
      `${m("test.", "skip(")}\n  isCI || check("a\\"/*", browserSupports(\n    "*/",\n  )),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a function added to an unchanged wrapped skip whose condition holds a regex literal ending in a comment's start, and its end in a later string",
      `${m("test.", "skip(")}\n  /\\/${m("*", "$")}/.test(process.env.BASE_URL ?? "") || browserSupports("*${m("*", "/")}x"),\n);\n`,
      `${m("test.", "skip(")}\n  /\\/${m("*", "$")}/.test(process.env.BASE_URL ?? "") || browserSupports("*${m("*", "/")}x"),\n  async () => {},\n);\n`,
      1,
    ],
    [
      "a body line edited below an unchanged wrapped skip whose condition holds a regex literal ending in a comment's start, and its end in a later string",
      `${m("test.", "skip(")}\n  /\\/${m("*", "$")}/.test(process.env.BASE_URL ?? "") || browserSupports("*${m("*", "/")}x"),\n);\ntest("a", () => {\n  run();\n});\n`,
      `${m("test.", "skip(")}\n  /\\/${m("*", "$")}/.test(process.env.BASE_URL ?? "") || browserSupports("*${m("*", "/")}x"),\n);\ntest("a", () => {\n  run2();\n});\n`,
      0,
    ],
    [
      "a body line edited below an unchanged skip whose condition holds a balanced paren in a block comment",
      `${m("test.", "skip(")}isCI /${m("* see (1) *", "/")}, "flaky");\ntest("a", () => {\n  run();\n});\n`,
      `${m("test.", "skip(")}isCI /${m("* see (1) *", "/")}, "flaky");\ntest("a", () => {\n  run2();\n});\n`,
      0,
    ],
    [
      "the argument of an unchanged wrapped runIf whose block comment holds a paren edited, above an unchanged legacy skip",
      `test.runIf( /${m("* see :) *", "/")}\n  isA,\n)("t", () => {\n  run();\n});\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `test.runIf( /${m("* see :) *", "/")}\n  isCI,\n)("t", () => {\n  run();\n});\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "the argument of an unchanged wrapped skipIf edited into a literal",
      'test.skipIf(\n  isCI,\n)("t", fn);\n',
      `${m("test.skipIf(", "\n  true,\n)(")}"t", fn);\n`,
      1,
    ],
    [
      "the argument of an unchanged wrapped runIf edited, above an unchanged legacy skip",
      `test.runIf(\n  isA,\n)("t", () => {\n  run();\n});\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `test.runIf(\n  isCI,\n)("t", () => {\n  run();\n});\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a body line edited under a skipIf whose argument holds a paren in a string, above an unchanged legacy skip",
      `test.skipIf(name === "(")("t", () => {\n  run(1);\n  run(2);\n  run(3);\n  run(4);\n  run(5);\n});\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `test.skipIf(name === "(")("t", () => {\n  run(1);\n  run(9);\n  run(3);\n  run(4);\n  run(5);\n});\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a body line edited under a skipIf whose argument holds a paren in a string, then a link, above an unchanged legacy skip",
      `test.skipIf(name === "(")("t", () => {\n  run(1);\n  run(2);\n  run(3);\n  run(4);\n  run(5);\n})\n  .then(done);\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `test.skipIf(name === "(")("t", () => {\n  run(1);\n  run(2);\n  run(9);\n  run(4);\n  run(5);\n})\n  .then(done);\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a receiver edited into a test root above an unchanged skip link",
      `const q = db\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a callee edited into a focus marker above its unchanged arguments",
      'run\n("t", fn);\n',
      `${m("f", "it")}\n("t", fn);\n`,
      1,
    ],
    ["a split skip chain added whole", "x();\n", `test\n  ${m(".", "skip(")}"t", fn);\n`, 1],
    [
      "a root edited two links above an unchanged skip",
      `foo\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a link added between an unchanged root and an unchanged skip",
      `test\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  .runIf(isCI)\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a receiver edited into a test root above an unchanged comment line and skip link",
      `const q = db\n  // flaky\n  ${m(".", "skip(")}"t", fn);\n`,
      `test\n  // flaky\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a body line edited below an unchanged one-line call",
      'test("t", () => {\n  run(1);\n});\n',
      'test("t", () => {\n  run(2);\n});\n',
      0,
    ],
    [
      "an edit two lines below an unchanged legacy skip",
      `${m("it.", "skip(")}"legacy", () => {});\ntest("t", () => {\n  run(1);\n});\n`,
      `${m("it.", "skip(")}"legacy", () => {});\ntest("t", () => {\n  run(2);\n});\n`,
      0,
    ],
    [
      "an edit below an unchanged comment that mentions an unclosed skip",
      `describe("d", () => {\n  // never wrap this in ${m("test.", "skip(")} again\n  test("t", () => {\n    run(1);\n  });\n});\n`,
      `describe("d", () => {\n  // never wrap this in ${m("test.", "skip(")} again\n  test("t", () => {\n    run(2);\n  });\n});\n`,
      0,
    ],
    [
      "a locator edited under an unchanged split chain",
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n',
      'test("t", async ({ page }) => {\n  await page\n    .locator("b")\n    .click();\n});\n',
      0,
    ],
    [
      "an edit below a hunk boundary, which does not merge with the hunk above",
      HUNK_BOUNDARY_BEFORE,
      HUNK_BOUNDARY_AFTER,
      0,
    ],
    [
      "an edit of the condition of an unchanged wrapped testInfo skip into a literal",
      WRAPPED_TESTINFO("isMobile"),
      WRAPPED_TESTINFO("true"),
      1,
    ],
    [
      "an edit of the reason of an unchanged wrapped testInfo skip",
      WRAPPED_TESTINFO("isMobile"),
      WRAPPED_TESTINFO("isMobile", "other reason"),
      0,
    ],
    [
      "a wrapped testInfo slow edited to a skip above a split call, its reason holding an open paren",
      `test("t", async ({ page }, testInfo) => {\n  testInfo.slow(\n    true,\n    'flaky on webkit :(',\n  );\n  await page\n    .goto("/");\n  await expect(page).toHaveTitle("x");\n  await expect(page).toHaveURL("/");\n  await expect(page).toHaveURL("/");\n});\n`,
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    true,\n    'flaky on webkit :(',\n  );\n  await page\n    .goto("/");\n  await expect(page).toHaveTitle("x");\n  await expect(page).toHaveURL("/");\n  await expect(page).toHaveURL("/");\n});\n`,
      1,
    ],
    [
      "an edit below an unchanged wrapped conditional testInfo skip whose reason holds an open paren",
      `test("t", async ({ page, isMobile }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    isMobile,\n    'no touch :(',\n  );\n  await page.goto("/");\n  await expect(page).toHaveTitle("x");\n});\n`,
      `test("t", async ({ page, isMobile }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    isMobile,\n    'no touch :(',\n  );\n  await page.goto("/home");\n  await expect(page).toHaveTitle("x");\n});\n`,
      0,
    ],
    [
      "an edit to the condition of an unchanged wrapped conditional testInfo skip below a regex holding a comment's start",
      `const trim = (s: string) => s.replace(/\\/*$/, "");\n\ntest("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    testInfo.project.name === "webkit" &&\n      page\n        .url()\n        .startsWith("x"),\n    "reason",\n  );\n  await page.goto(trim("/a/"));\n});\n`,
      `const trim = (s: string) => s.replace(/\\/*$/, "");\n\ntest("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    testInfo.project.name === "firefox" &&\n      page\n        .url()\n        .startsWith("x"),\n    "reason",\n  );\n  await page.goto(trim("/a/"));\n});\n`,
      0,
    ],
    [
      "a literal testInfo skip added in a hunk after one inside a doc comment",
      `${"step();\n".repeat(6)}/${m("*", "* a")}\n${" * x\n".repeat(8)} *${m("/")}\n${"step();\n".repeat(12)}`,
      `${"step();\n".repeat(6)}/${m("*", "* b")}\n${" * x\n".repeat(8)} *${m("/")}\n${"step();\n".repeat(12)}test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")} /${m("* it's *", "/")} // don't :)\n    true,\n    'flaky :(',\n  );\n  a();\n  b();\n  c();\n});\n`,
      1,
    ],
    [
      "an edit adding a body to an unchanged wrapped todo",
      `${m("test.", "todo(")}\n  "a title the formatter put on a line of its own",\n);\n`,
      `${m("test.", "todo(")}\n  "a title the formatter put on a line of its own",\n  () => {\n    throw new Error("broken");\n  },\n);\n`,
      1,
    ],
    [
      "a helper line deleted between a test root and an unchanged skip link",
      `test\n  myHelper\n  ${m(".", "skip(")}"x", fn);\n`,
      `test\n  ${m(".", "skip(")}"x", fn);\n`,
      1,
    ],
    [
      "a helper line commented out between a test root and an unchanged skip link",
      `test\n  myHelper\n  ${m(".", "skip(")}"x", fn);\n`,
      `test\n  // myHelper\n  ${m(".", "skip(")}"x", fn);\n`,
      1,
    ],
    [
      "a call line deleted between an assigned test root and an unchanged skip link",
      `const t = test\n  foo()\n  ${m(".", "skip(")}"t", fn);\n`,
      `const t = test\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a call line commented out between an assigned test root and an unchanged skip link",
      `const t = test\n  foo()\n  ${m(".", "skip(")}"t", fn);\n`,
      `const t = test\n  // foo()\n  ${m(".", "skip(")}"t", fn);\n`,
      1,
    ],
    [
      "a helper line deleted above an unchanged comment line in a split skip chain",
      `test\n  myHelper\n  // note\n  ${m(".", "skip(")}"x", fn);\n`,
      `test\n  // note\n  ${m(".", "skip(")}"x", fn);\n`,
      1,
    ],
    [
      "the first argument line of an unchanged wrapped skipIf deleted, leaving a literal",
      `test.skipIf(\n  isCI &&\n  ${m("tr", "ue,")}\n)("t", fn);\n`,
      `test.skipIf(\n  ${m("tr", "ue,")}\n)("t", fn);\n`,
      1,
    ],
    [
      "the condition line of an unchanged wrapped runIf deleted, leaving no argument",
      'describe.runIf(\n  process.env.DATABASE_URL,\n)("db", () => {\n  run();\n});\n',
      `${m("describe.runIf", "(")}\n)("db", () => {\n  run();\n});\n`,
      1,
    ],
    [
      "a body line deleted under an unchanged test",
      'test("t", () => {\n  run(1);\n  run(2);\n});\n',
      'test("t", () => {\n  run(1);\n});\n',
      0,
    ],
    [
      "a link deleted from a locator chain",
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .first()\n    .click();\n});\n',
      'test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n',
      0,
    ],
    [
      "a whole test deleted above another",
      'test("a", () => {\n  run();\n});\ntest("b", () => {\n  run();\n});\n',
      'test("b", () => {\n  run();\n});\n',
      0,
    ],
    [
      "a block comment around a focused test uncommented",
      `/*\n${m("test.", "only(")}"focused", () => {});\n*/\ntest("other", () => {\n  run();\n});\n`,
      `${m("test.", "only(")}"focused", () => {});\ntest("other", () => {\n  run();\n});\n`,
      1,
    ],
    [
      "the end of a block comment moved above a focused test",
      `/*\nrun();\n${m("test.", "only(")}"focused", () => {});\nother();\n*/ done();\ntest("other", fn);\n`,
      `/*\nrun();\n*/ done();\n${m("test.", "only(")}"focused", () => {});\nother();\ntest("other", fn);\n`,
      1,
    ],
    [
      "the end of a block comment whose text holds an apostrophe moved above a focused test",
      `/*\nrun();\n${m("test.", "only(")}"focused", () => {});\nother();\n * it's parked */\ntest("other", fn);\n`,
      `/*\nrun();\n * it's parked */\n${m("test.", "only(")}"focused", () => {});\nother();\ntest("other", fn);\n`,
      1,
    ],
    [
      "a multi-line doc comment deleted above an unchanged plain test",
      '/**\n * Checks the sum.\n */\ntest("sum", () => {\n  run();\n});\n',
      'test("sum", () => {\n  run();\n});\n',
      0,
    ],
    [
      "a one-line block comment added above an unchanged legacy skip",
      `run();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `/* note */ run();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "an edit in the hunk after one that edits a block comment's opening line, above an unchanged legacy skip",
      `/*\n * note\n */\n${"x();\n".repeat(11)}run(1);\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `/**\n * note\n */\n${"x();\n".repeat(11)}run(2);\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a glob string holding a comment opener edited above an unchanged legacy skip",
      `const g = "src/*.ts";\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `const g = "lib/*.ts";\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a route glob holding a comment closer edited above an unchanged legacy skip",
      `await page.route("**/api/a", fn);\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `await page.route("**/api/b", fn);\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a returned regex literal holding a comment closer edited above an unchanged legacy skip",
      `const isErr = (m) => {\n  return m.startsWith("Error: ");\n};\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `const isErr = (m) => {\n  return /^Error: .*/.test(m);\n};\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a doc comment added a few lines above a wrapped skip the hunk ends inside",
      `test.describe("x", () => {\n  test.use({ viewport: { width: 1280, height: 720 } });\n  test.slow();\n  ${m("test.", "skip(")}\n    ({ browserName }) => browserName !== "chromium",\n    "Only chromium has the font installed in the CI runners",\n  );\n  test("a", fn);\n});\n`,
      `/**\n * Visual checks.\n */\ntest.describe("x", () => {\n  test.use({ viewport: { width: 1280, height: 720 } });\n  test.slow();\n  ${m("test.", "skip(")}\n    ({ browserName }) => browserName !== "chromium",\n    "Only chromium has the font installed in the CI runners",\n  );\n  test("a", fn);\n});\n`,
      0,
    ],
    [
      "a regex literal holding a comment closer added above an unchanged legacy skip",
      `run();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `expect(msg).toMatch(/Error: .*/);\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a regex literal holding a comment closer deleted above an unchanged legacy skip",
      `expect(msg).toMatch(/Error: .*/);\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `run();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "an arrow's regex literal holding a comment opener added above an unchanged legacy skip",
      `run();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      `expect(names.some((s) => /\\/*$/.test(s))).toBe(false);\nrun();\n${m("it.", "skip(")}"legacy", () => {});\n`,
      0,
    ],
    [
      "a block comment opener after a regex literal on a deleted line, above a focused test",
      `expect(msg).toMatch(/Error: .*/); /*\n${m("test.", "only(")}"focused", () => {});\n*/\ntest("other", fn);\n`,
      `expect(msg).toMatch(/Error: .*/);\n${m("test.", "only(")}"focused", () => {});\ntest("other", fn);\n`,
      1,
    ],
    [
      "a type edited into skip under an unchanged wrapped annotation",
      `test("x", {\n  annotation: {\n    type: "issue",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      `test("x", {\n  ${m("annota", "tion: {")}\n    type: "skip",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      1,
    ],
    [
      "a skip item added to an unchanged wrapped annotation array",
      `test("x", {\n  annotation: [\n    { type: "issue", description: "x" },\n  ],\n}, async () => {\n  run();\n  check();\n});\n`,
      `test("x", {\n  ${m("annota", "tion: [")}\n    { type: "issue", description: "x" },\n    { type: "skip" },\n  ],\n}, async () => {\n  run();\n  check();\n});\n`,
      1,
    ],
    [
      "a description edited under an unchanged wrapped issue annotation",
      `test("x", {\n  annotation: {\n    type: "issue",\n    description: "old",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      `test("x", {\n  annotation: {\n    type: "issue",\n    description: "new",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      0,
    ],
    [
      "a body line edited below an unchanged legacy wrapped skip annotation",
      `test("x", {\n  ${m("annota", "tion: {")}\n    type: "skip",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      `test("x", {\n  ${m("annota", "tion: {")}\n    type: "skip",\n  },\n}, async () => {\n  run();\n  verify();\n});\n`,
      0,
    ],
    [
      "a line deleted inside an unchanged legacy wrapped skip annotation",
      `test("x", {\n  ${m("annota", "tion: {")}\n    type: "skip",\n    description: "x",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      `test("x", {\n  ${m("annota", "tion: {")}\n    type: "skip",\n  },\n}, async () => {\n  run();\n  check();\n});\n`,
      1,
    ],
    [
      "a type edited into skip five lines below an unchanged wrapped annotation's key line",
      `test("x", {\n  annotation: [\n    {\n      type: "issue",\n    },\n    {\n      type: "issue",\n      description: "x",\n    },\n  ],\n}, async () => {\n  run();\n  check();\n});\n`,
      `test("x", {\n  ${m("annota", "tion: [")}\n    {\n      type: "issue",\n    },\n    {\n      type: "skip",\n      description: "x",\n    },\n  ],\n}, async () => {\n  run();\n  check();\n});\n`,
      1,
    ],
    [
      "a condition edited into a reason below an unchanged expected-failure key",
      'test("t", {\n  expectFailure:\n    process.platform === "win32",\n}, () => {\n  work();\n  check();\n});\n',
      `test("t", {\n  ${m("expect", "Failure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  check();\n});\n`,
      1,
    ],
    [
      "a reason added above the condition below an unchanged expected-failure key",
      'test("t", {\n  expectFailure:\n    isWindows,\n}, () => {\n  work();\n  check();\n});\n',
      `test("t", {\n  ${m("expect", "Failure:")}\n    "known bug" ||\n    isWindows,\n}, () => {\n  work();\n  check();\n});\n`,
      1,
    ],
    [
      "a key edited into an expected failure above an unchanged reason",
      'test("t", {\n  description:\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  check();\n});\n',
      `test("t", {\n  ${m("expect", "Failure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  check();\n});\n`,
      1,
    ],
    [
      "a comment line removed between an unchanged expected-failure key and its reason",
      `test("t", {\n  ${m("expect", "Failure:")}\n    // see #1\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  check();\n});\n`,
      `test("t", {\n  ${m("expect", "Failure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  check();\n});\n`,
      1,
    ],
    [
      "a body line edited below an unchanged legacy expected-failure reason under its key",
      `test("t", {\n  ${m("expect", "Failure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  check();\n});\n`,
      `test("t", {\n  ${m("expect", "Failure:")}\n    "known bug in the upstream parser until 2.0 ships, see https://github.com/acme/parser/issues/1234",\n}, () => {\n  work();\n  verify();\n});\n`,
      0,
    ],
  ];

  const WRAPPED_SKIP = `${m("test.", "skip(")}\n  isCI,\n  "reason",\n);\n`;
  const wrappedSkipEdits: Array<[string, string, number]> = [
    [
      "its arguments edited into a title and a function",
      `${m("test.", "skip(")}\n  "title",\n  async ({ page }) => { await page.goto("/"); },\n);\n`,
      1,
    ],
    [
      "its arguments edited into a title and a function that runs over more than 6 lines",
      `${m("test.", "skip(")}\n  "title",\n  async ({ page }) => {\n    await page.goto("/");\n    await page.click("a");\n    await page.click("b");\n  },\n);\n`,
      1,
    ],
    [
      "its condition edited into a literal",
      `${m("test.", "skip(")}\n  true,\n  "reason",\n);\n`,
      1,
    ],
    ["its reason edited", `${m("test.", "skip(")}\n  isCI,\n  "other reason",\n);\n`, 0],
    ["its condition line deleted", `${m("test.", "skip(")}\n  "reason",\n);\n`, 1],
    [
      "its condition edited into another expression",
      `${m("test.", "skip(")}\n  isLinux,\n  "reason",\n);\n`,
      0,
    ],
  ];

  const COND = (a: string, b: string) =>
    `${m("test.", "skip(")}\n  process.env.A === "${a}" &&\n    ${b}\n    process.env.C === "1",\n  "reason",\n);\n`;
  const sixLineSkips: Array<[string, string, string]> = [
    [
      "its first condition line edited",
      COND("1", 'process.env.B === "1" &&'),
      COND("2", 'process.env.B === "1" &&'),
    ],
    [
      "its first condition line edited above a split chain",
      COND("1", 'process.env.B\n      .trim() === "1" &&'),
      COND("2", 'process.env.B\n      .trim() === "1" &&'),
    ],
    [
      "its two condition lines collapsed into one",
      `${m("test.", "skip(")}\n  isCI &&\n    isLinux,\n  "reason",\n);\n`,
      `${m("test.", "skip(")}\n  isCI,\n  "reason",\n);\n`,
    ],
  ];

  const asFail = (s: string) => s.replaceAll(m("test.", "skip("), m("test.", "fail("));

  const unionCases: Array<[string, string, string, string]> = [
    [
      "a skip whose head-side unit closes an unchanged conditional skip above it",
      "bad.spec.ts",
      `${PLAYWRIGHT_IMPORT}${m("test.", "skip(")}isCI,\n  "r");\nfoo();\nbar();\n`,
      `${PLAYWRIGHT_IMPORT}${m("test.", "skip(")}isCI,\n  "r"); ${m("test.", "skip(")}title,\n  () => {\n    work();\n  });\nfoo();\nbar();\n`,
    ],
    [
      "an option-object skip whose head-side unit merges with a placeholder below it",
      "bad.test.ts",
      `test("other", () => work())\n  .then(() => test("p (set X to run)", { ${m("skip", ": true")} }, () => {}));\n`,
      `test("real", { ${m("skip", ": true")} }, () => work())\n  .then(() => test("p (set X to run)", { ${m("skip", ": true")} }, () => {}));\n`,
    ],
  ];

  const conditionalSkips: Array<[string, string]> = [
    [
      "conditional skip on a regex holding two slashes, above a test",
      `${m("test.", "skip(")}/^file:\\/\\//.test(page.url()), "needs http");\ntest("t", async ({ page }) => {\n  await page.goto("/a");\n  await page.goto("/b");\n  await page.goto("/c");\n  await page.goto("/d");\n  await page.goto("/e");\n});\n`,
    ],
    [
      "a conditional skip wrapped over more than 6 lines",
      `${m("test.", "skip(")}\n  isCI &&\n  isLinux &&\n  isHeadless &&\n  isSlow,\n  "reason",\n);\n`,
    ],
    [
      "a wrapped condition whose lines open with (",
      `${m("test.", "skip(")}\n  isCI &&\n  (isLinux) &&\n  (isHeadless) &&\n  (isSlow),\n  "reason",\n);\n`,
    ],
    [
      "a conditional fail wrapped by the formatter",
      `${m("test.", "fail(")}\n  isCI,\n  "r",\n);\n`,
    ],
    ["conditional function-form skip", `${m("test.", "skip(")}isCI, "needs a display");\n`],
    [
      "conditional skip on a negated signed name",
      `${m("test.", "skip(")}!-(shards), "needs one shard");\n`,
    ],
    [
      "conditional skip on a negated expression",
      `${m("test.", "skip(")}!process.env.DISPLAY, "needs a display");\n`,
    ],
    ["conditional skip on a call", `${m("test.", "skip(")}isMobile(info), NO_SEGMENTS);\n`],
    [
      "conditional skip with a quoted trailing comment",
      `${m("test.", "skip(")}isCI, "needs a display"); // it's flaky there\n`,
    ],
    [
      "conditional skip on a comparison",
      `${m("test.", "skip(")}info.project.name !== "desktop", "desktop only");\n`,
    ],
    [
      "conditional skip on a fixture callback",
      `${m("test.", "skip(")}({ browserName }) => browserName === "webkit", "not on webkit");\n`,
    ],
    [
      "conditional skip on a negated regex test",
      `${m("test.", "skip(")}!/firefox/.test(browserName), "not on firefox");\n`,
    ],
    [
      "conditional skip on a fixture callback testing a regex",
      `${m("test.", "skip(")}({ browserName }) => /webkit/.test(browserName), "not on webkit");\n`,
    ],
    [
      "conditional skip wrapped by the formatter (condition on the next line)",
      `${m("test.", "skip(")}\n  process.env.CI_ENVIRONMENT === "production",\n  "not on production",\n);\n`,
    ],
    [
      "conditional skip wrapped over 6 lines",
      `${m("test.", "skip(")}\n  isCI &&\n  isLinux &&\n  isHeadless,\n  "reason",\n);\n`,
    ],
    ["conditional skip on a parenthesised name", `${m("test.", "skip(")}(isCI), "reason");\n`],
    [
      "conditional skip on a negated parenthesised name",
      `${m("test.", "skip(")}!(isCI), "reason");\n`,
    ],
    [
      "conditional skip on an arrow returning a name",
      `${m("test.", "skip(")}() => isCI, "reason");\n`,
    ],
    [
      "conditional skip on a name starting with true",
      `${m("test.", "skip(")}trueValue, "reason");\n`,
    ],
    [
      "conditional skip on a name starting with null",
      `${m("test.", "skip(")}nullish, "reason");\n`,
    ],
    ["conditional fail", `${m("test.", "fail(")}isWebkit, "bug");\n`],
    ["conditional fail on a comparison", `${m("test.", "fail(")}browserName === "webkit", "r");\n`],
    ["conditional fail split from its arguments", `${m("test.", "fail")}\n(isCI, "r");\n`],
  ];

  const playwrightImports: Array<[string, string]> = [
    ["a one-line import", 'import { expect, test } from "@playwright/test";\n'],
    ["a single-quoted import", "import { test } from '@playwright/test';\n"],
    ["a default import", 'import test from "@playwright/test";\n'],
    ["a wrapped import", 'import {\n  expect,\n  test,\n} from "@playwright/test";\n'],
    ["a CommonJS require", 'const { test } = require("@playwright/test");\n'],
  ];

  const notPlaywright: Array<[string, string]> = [
    ["a commented-out import", '// import { test } from "@playwright/test";\n'],
    ["a mention in a string", 'const runner = "@playwright/test";\n'],
    ["a type-only import", 'import type { Page } from "@playwright/test";\n'],
    [
      "a type-only import with no space before the brace",
      'import type{ Page } from "@playwright/test";\n',
    ],
  ];

  const allowed: Array<[string, string]> = [
    [
      "a conditional testInfo skip on a regex holding two slashes",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}/^file:\\/\\//.test(page.url()), "needs http");\n  await page.goto("/a");\n  await page.goto("/b");\n  await page.goto("/c");\n  await page.goto("/d");\n  await page.goto("/e");\n});\n`,
    ],
    [
      "a conditional skip on testInfo wrapped by the formatter whose reason holds an open paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    isCI,\n    'flaky :(',\n  );\n  a();\n  b();\n  c();\n});\n`,
    ],
    [
      "a todo whose name the formatter wrapped",
      `${m("test.", "todo(")}\n  "a title the formatter put on a line of its own",\n);\n`,
    ],
    ["a todo whose name holds a backslash", `${m("test.", "todo(")}"line\\nbreak");\n`],
    ["a todo whose template name runs over lines", `${m("test.", "todo(")}\`a\nb\`);\n`],
    [
      "conditional option-object skip",
      `test("t", { ${m("skip", ": !process.env.DATABASE_URL")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "env-gated empty placeholder",
      `const DATABASE_URL = process.env.DATABASE_URL;\nif (!DATABASE_URL) {\n  test("store integration (set DATABASE_URL to run)", { ${m("skip", ": true")} }, () => {});\n} else {\n  test("real coverage", () => {});\n}\n`,
    ],
    [
      "the non-Playwright conditional idiom, a skip that is not called",
      `const itX = process.env.DATABASE_URL ? it : ${m("it.", "skip")};\nitX("t", () => {});\n`,
    ],
    [
      "prose that merely contains a marker word",
      `// whenever the tokens fit on one line, the layout is stable\ntest("t", () => {});\n`,
    ],
    ["a skipIf on a condition", 'test.skipIf(isCI)("t", () => {\n  run();\n});\n'],
    ["a runIf on a condition", 'describe.runIf(process.env.X)("s", () => {\n  run();\n});\n'],
    [
      "a skipIf on a comparison that starts with a number",
      'test.skipIf(1 === Number(process.env.SHARD))("t", () => {\n  run();\n});\n',
    ],
    [
      "a runIf on an expression that starts with false",
      'describe.runIf(false || process.env.X)("s", () => {\n  run();\n});\n',
    ],
    ["a skipIf(false), which never skips", 'test.skipIf(false)("t", () => {\n  run();\n});\n'],
    ["a runIf on an arrow, which always runs", 'test.runIf(() => x)("t", () => {\n  run();\n});\n'],
    ["a skipIf on a comparison", 'test.skipIf(a >= b)("t", () => {\n  run();\n});\n'],
    ["a skipIf on a call", 'test.skipIf(check())("t", () => {\n  run();\n});\n'],
    ["a runIf on a call holding an argument", 'test.runIf(f(x))("t", () => {\n  run();\n});\n'],
    [
      "a skipIf on a name starting with function and a dollar sign",
      'test.skipIf(function$enabled)("t", () => {\n  run();\n});\n',
    ],
    [
      "an option-object skip on a name starting with function",
      `test("t", { ${m("skip", ": functionality")} }, () => { run(); });\n`,
    ],
    ["a runIf(true), which never skips", 'test.runIf(true)("t", () => {\n  run();\n});\n'],
    ["a skipIf(0), which never skips", 'test.skipIf(0)("t", () => {\n  run();\n});\n'],
    ["a skipIf(0.0), which never skips", 'test.skipIf(0.0)("t", () => {\n  run();\n});\n'],
    ["a skipIf(0x0), which never skips", 'test.skipIf(0x0)("t", () => {\n  run();\n});\n'],
    ["a skipIf(NaN), which never skips", 'test.skipIf(NaN)("t", () => {\n  run();\n});\n'],
    ["a skipIf(void 0), which never skips", 'test.skipIf(void 0)("t", () => {\n  run();\n});\n'],
    ["a runIf(Infinity), which never skips", 'test.runIf(Infinity)("t", () => {\n  run();\n});\n'],
    ["a runIf(1e3), which never skips", 'test.runIf(1e3)("t", () => {\n  run();\n});\n'],
    ["a skipIf(-false), which never skips", 'test.skipIf(-false)("t", () => {\n  run();\n});\n'],
    ['a skipIf(""), which never skips', 'test.skipIf("")("t", () => {\n  run();\n});\n'],
    ['a runIf("x"), which never skips', 'test.runIf("x")("t", () => {\n  run();\n});\n'],
    ["a runIf(-true), which never skips", 'test.runIf(-true)("t", () => {\n  run();\n});\n'],
    ["a skipIf on a signed name", 'test.skipIf(-offset)("t", () => {\n  run();\n});\n'],
    ["a skipIf(+-0), which never skips", 'test.skipIf(+-0)("t", fn);\n'],
    ["a runIf(+-1), which never skips", 'test.runIf(+-1)("t", fn);\n'],
    ["a skipIf(+ - 0), which never skips", 'test.skipIf(+ - 0)("t", fn);\n'],
    ["a runIf(- 1), which never skips", 'test.runIf(- 1)("t", fn);\n'],
    ["a skipIf on a sign before a name", 'test.skipIf(- offset)("t", fn);\n'],
    [
      "a wrapped skipIf whose sign and zero sit on two lines, which never skips",
      'test.skipIf(-\n  0,\n)("t", () => {\n  run();\n});\n',
    ],
    [
      "a runIf on a string holding another quote kind, which never skips",
      `test.runIf("it's")("t", fn);\n`,
    ],
    [
      "a skipIf on a signed parenthesised name",
      'test.skipIf(-(offset))("t", () => {\n  run();\n});\n',
    ],
    [
      "a skipIf on a name that starts with an underscore and a digit",
      'test.skipIf(_1)("t", () => {\n  run();\n});\n',
    ],
    [
      "a skipIf on a name that reads like an exponent",
      'test.skipIf(x1e3)("t", () => {\n  run();\n});\n',
    ],
    [
      "a skipIf on a comparison that starts with an exponent",
      'test.skipIf(1e3 === n)("t", () => {\n  run();\n});\n',
    ],
    ["a runIf on a name starting with void", 'test.runIf(voidable)("t", () => {\n  run();\n});\n'],
    [
      "a runIf on a name starting with void and a dollar sign",
      'test.runIf(void$x)("t", () => {\n  run();\n});\n',
    ],
    [
      "a skipIf on a negated name starting with void",
      'test.skipIf(!voidable)("t", () => {\n  run();\n});\n',
    ],
    [
      "a skipIf on a negated parenthesised name",
      'test.skipIf(!(isCI))("t", () => {\n  run();\n});\n',
    ],
    [
      "a skipIf on an expression that starts with a negated literal",
      'test.skipIf(!0 && isCI)("t", () => {\n  run();\n});\n',
    ],
    [
      "an option-object skip that is false",
      `test("t", { ${m("skip", ": false")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip on a parenthesised signed comparison",
      `test("t", { ${m("skip", ": (-offset < 0)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed comparison",
      `test("t", { ${m("skip", ": -offset < 0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a plus-signed strict comparison",
      `test("t", { ${m("skip", ": +process.env.SHARD !== 1")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed two-argument call compared",
      `test("t", { ${m("skip", ": -compare(a, b) > 0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a plus-signed call holding a string, compared",
      `test("t", { ${m("skip", ': +semver.lt(process.version, "22.0.0") === 1')} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a ternary over a signed name",
      `test("t", { ${m("skip", ": -x ? a : b")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a signed name and a name",
      `test("t", { ${m("skip", ": -a&&b")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip that is undefined",
      `test("t", { ${m("skip", ": undefined")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip that is void 0",
      `test("t", { ${m("skip", ": void 0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a negated name",
      `test("t", { ${m("skip", ": !x")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a comparison",
      `test("t", { ${m("skip", ": a > b")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a name starting with null",
      `test("t", { ${m("skip", ": nullish")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a name starting with NaN",
      `test("t", { ${m("skip", ": NaNcheck")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on null coalesced",
      `test("t", { ${m("skip", ": null ?? isCI")} }, () => { work(); });\n`,
    ],
    [
      "a signed number as data off a test call",
      `test("t", () => {\n  expect(() => page({ ${m("skip", ": -1")} })).toThrow();\n});\n`,
    ],
    [
      "an option-object skip on a negated signed name",
      `test("t", { ${m("skip", ": !-(offset)")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip on a name starting with Infinity",
      `test("t", { ${m("skip", ": InfinityMode")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip on a parenthesised name",
      `test("t", { ${m("skip", ": (isCI)")} }, () => {\n  assert.ok(work());\n});\n`,
    ],
    [
      "an option-object skip on a regex test",
      `test("t", { ${m("skip", ": /^win/.test(process.platform)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a negated regex test",
      `test("t", { ${m("skip", ": !/^win/.test(p)")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a typeof comparison",
      `test("t", { ${m("skip", ': typeof Bun === "undefined"')} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a name starting with typeof",
      `test("t", { ${m("skip", ": typeofCheck")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a new object compared",
      `test("t", { ${m("skip", ": new Date().getDay() === 0")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a name starting with new",
      `test("t", { ${m("skip", ": newFeature")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on an awaited call",
      `test("t", { ${m("skip", ": await isFlaky()")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a name made of await and a digit",
      `test("t", { ${m("skip", ": await2fa")} }, () => { work(); });\n`,
    ],
    [
      "an option-object skip on a name right after a block comment",
      `test("t", { ${m("skip", ": /* flaky */")}isCI }, () => { work(); });\n`,
    ],
    [
      "a wrapped option-object skip after a line comment holding a slash",
      `test("t", { ${m("skip", ": // flaky/slow, see #12")}\n  isCI,\n}, () => {\n  work();\n});\n`,
    ],
    [
      "an option-object skip on a condition after a block comment",
      `test("t", { ${m("skip", ": /* why */ !process.env.X")} }, () => { work(); });\n`,
    ],
    ["a first-argument options object with no skip", `test({ timeout: 5 }, () => { work(); });\n`],
    [
      "a conditional option-object skip in a first-argument options object",
      `test({ ${m("skip", ": !process.env.X")} }, () => { work(); });\n`,
    ],
    [
      "a numeric skip on a call whose name ends in context",
      `test("t", () => {\n  const c = makeContext({ ${m("skip", ": 0")} });\n});\n`,
    ],
    ["a skipIf on a bitwise-not name", 'test.skipIf(~x)("t", () => {\n  run();\n});\n'],
    ["a skipIf on a regex test", 'test.skipIf(/x/.test(p))("t", () => {\n  run();\n});\n'],
    [
      "a runIf on a regex literal, which always runs",
      'test.runIf(/x/)("t", () => {\n  run();\n});\n',
    ],
    [
      "Prisma pagination on a line with no test call",
      `test("pages", async () => {\n  const rows = await db.story.findMany({ ${m("skip", ": 10")}, take: 5 });\n  assert.ok(rows);\n});\n`,
    ],
    [
      "wrapped Prisma pagination",
      `test("pages", async () => {\n  const rows = await db.story.findMany({\n    ${m("skip", ": 10")},\n    take: 5,\n  });\n  assert.ok(rows);\n});\n`,
    ],
    [
      "an expected-failure option set to false",
      `test("t", { ${m("expect", "Failure: false")} }, () => {\n  work();\n});\n`,
    ],
    [
      "an expected-failure option set to undefined",
      `test("t", { ${m("expect", "Failure: undefined")} }, () => {\n  work();\n});\n`,
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
    [
      "a node:test import without expectFailure",
      'import { describe, it } from "node:test";\nit("t", () => {\n  work();\n});\n',
    ],
    [
      "an expected-failure condition Biome puts on the line below its key",
      'test("t", {\n  expectFailure:\n    process.platform === "win32" && process.env.CI === "true",\n}, () => {\n  work();\n});\n',
    ],
    [
      "an expected-failure condition below its key past a comment line",
      'test("t", {\n  expectFailure:\n    // only on Windows\n    process.platform === "win32",\n}, () => {\n  work();\n});\n',
    ],
    [
      "a Playwright issue annotation",
      'test("x", { annotation: { type: "issue", description: "https://x/1" } }, async () => {\n  run();\n});\n',
    ],
    [
      "a Playwright slow annotation",
      'test("x", { annotation: { type: "slow" } }, async () => {\n  run();\n});\n',
    ],
    [
      "a Playwright annotation whose type only starts with skip",
      'test("x", { annotation: { type: "skipped" } }, async () => {\n  run();\n});\n',
    ],
    ["a Playwright tag named skip", 'test("x", { tag: "@skip" }, async () => {\n  run();\n});\n'],
    [
      "a reducer action of type skip",
      'test("t", () => {\n  expect(reduce(s, { type: "skip" })).toEqual(s);\n});\n',
    ],
    [
      "reporter data holding skip annotations",
      'test("t", () => {\n  const r = report({ annotations: [{ type: "skip" }] });\n});\n',
    ],
    [
      "a Playwright issue annotation wrapped over lines",
      'test("checkout", {\n  annotation: {\n    type: "issue",\n    description: "https://github.com/acme/shop/issues/1",\n  },\n}, async ({ page }) => {\n  await page.goto("/");\n});\n',
    ],
    [
      "a wrapped array of Playwright issue and slow annotations, one per line",
      'test("x", {\n  annotation: [\n    { type: "issue", description: "https://x/1" },\n    { type: "slow" },\n  ],\n}, async () => {\n  run();\n});\n',
    ],
    [
      "a reducer action of type skip on a line of its own",
      'test("t", () => {\n  expect(reduce(s, {\n    type: "skip",\n  })).toEqual(s);\n});\n',
    ],
    [
      "reporter data holding skip annotations over lines",
      'test("t", () => {\n  const r = report({\n    annotations: [\n      { type: "skip" },\n    ],\n  });\n});\n',
    ],
    [
      "Prisma pagination inside an asymmetric matcher",
      `test("pages", () => {\n  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ ${m("skip", ": 0")}, take: 2 }));\n});\n`,
    ],
    [
      "a comment holding a word and a colon",
      `// two columns, desktop only: 2 per row\ntest("t", () => {});\n`,
    ],
    [
      "a comment holding a word, a colon and a quote",
      `// Non-spec files only: 'findImporters' skips them\ntest("t", () => {});\n`,
    ],
    [
      "a comment where a sentence ends after a marker word",
      `// not a test bent to fit. seedChannel() writes\ntest("t", () => {});\n`,
    ],
    [
      "a comment holding i.e. before a marker word",
      `// i.e. only (a, b) survive\ntest("t", () => {});\n`,
    ],
    [
      "a wrapped conditional runIf",
      'test.runIf(\n  process.env.CI === "true",\n)("t", () => {\n  run();\n});\n',
    ],
    ["a wrapped conditional skipIf", 'test.skipIf(\n  isCI,\n)("t", () => {\n  run();\n});\n'],
    [
      "a wrapped conditional runIf opened on the line that closes a wrapped conditional skipIf",
      'test.skipIf(\n  isA,\n).runIf(\n  isB,\n)("t", () => {\n  run();\n});\n',
    ],
    [
      "a locator chain with a quoted trailing comment",
      `test("t", async ({ page }) => {\n  await page // the user's page\n    .locator("a")\n    .click();\n});\n`,
    ],
    [
      "a conditional link with a quoted trailing comment before the call",
      `test\n  .runIf(isCI) // don't run locally\n  ("t", () => {\n    run();\n  });\n`,
    ],
    [
      "a locator chain split over lines",
      `test("t", async ({ page }) => {\n  await page\n    .locator("a")\n    .click();\n});\n`,
    ],
    [
      "a call chain split after a call",
      `test("t", async ({ page }) => {\n  await expect(page)\n    .toHaveURL("/x");\n});\n`,
    ],
    [
      "a string naming a pytest mark",
      `test("t", () => {\n  assert.equal(name, "${m("pytest.mark.", "skip")}");\n});\n`,
    ],
    [
      "node:test's in-body optional-call skip with a reason",
      `test("t", (t) => {\n  ${m("t.", "skip?.(")}"no database");\n});\n`,
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
      "a cursor skip below a trailing comment ending in a test name, after a regex holding a quote",
      `test("pages", async () => {\n  const rows = await db.find({ name: /'/ }) // page 1 is in the first test\n    ${m(".", "skip(")}10);\n  assert.equal(rows.length, 10);\n});\n`,
    ],
    [
      "a wrapped conditional testInfo skip on a regex holding a quote, its trailing comment holding an open paren",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    /'/.test(testInfo.title), // titles with an apostrophe (see #12\n    "apostrophes break the route",\n  );\n  await page.goto("/a");\n  await page.goto("/b");\n  await page.goto("/c");\n  await page.goto("/d");\n});\n`,
    ],
    [
      "a one-line conditional skip on testInfo testing a regex that ends in an escaped slash",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}/^file:\\/\\//.test(testInfo.project.use.baseURL ?? ""), "needs http");\n  await page.goto("/a");\n  await page.goto("/b");\n  await page.goto("/c");\n  await page.goto("/d");\n  await page.goto("/e");\n});\n`,
    ],
    [
      "a one-line conditional fail on testInfo testing a negated regex that ends in an escaped slash",
      `test("t", async ({ page }, testInfo) => {\n  await page.goto("/0");\n  ${m("testInfo.", "fail(")}!/^https?:\\/\\//.test(page.url()), "needs a web URL");\n  await page.goto("/a");\n  await page.goto("/b");\n  await page.goto("/c");\n  await page.goto("/d");\n  await page.goto("/e");\n});\n`,
    ],
    [
      "an extended test called through its alias",
      'const t2 = test.extend({ x: 1 });\nt2("t", () => {\n  run();\n});\n',
    ],
    [
      "a comparison that reads like type arguments after only",
      `test("t", () => {\n  if (filters.${m("only", " < 1")} && total > (offset + 1)) {\n    run();\n  }\n});\n`,
    ],
    [
      "a less-or-equal comparison that reads like type arguments after fit",
      `test("t", () => {\n  if (${m("fit", " <= max")} && size > (min ?? 0)) {\n    run();\n  }\n});\n`,
    ],
    [
      "a less-or-equal comparison that reads like type arguments after only",
      `test("t", () => {\n  if (filters.${m("only", " <= 1")} && total > (offset ?? 0)) {\n    run();\n  }\n});\n`,
    ],
    [
      "node:test's in-body skip with a reason",
      `test("t", (t) => {\n  ${m("t.", "skip(")}"no database");\n});\n`,
    ],
    [
      "the empty placeholder with a string reason",
      `test("store (set DATABASE_URL to run)", { ${m("skip", ': "no database"')} }, () => {});\n`,
    ],
    [
      "the empty placeholder with a second option",
      `test("store (set DATABASE_URL to run)", { ${m("skip", ": true")}, timeout: 5 }, () => {});\n`,
    ],
    [
      "the empty placeholder after a block comment",
      `test("store (set DATABASE_URL to run)", { /* env-gated */ ${m("skip", ": true")} }, () => {});\n`,
    ],
    [
      "the empty placeholder with a template-literal reason",
      `test("store (set it to run)", { ${m("skip", ": `set $" + "{V} to run`")} }, () => {});\n`,
    ],
    [
      "the empty placeholder with a reason holding a brace",
      `test("store (set it to run)", { ${m("skip", ': "needs {X}"')} }, () => {});\n`,
    ],
    [
      "the empty placeholder with a reason holding an apostrophe",
      `test("store (set DATABASE_URL to run)", { ${m("skip", `: "it's not set"`)} }, () => {});\n`,
    ],
    [
      "the empty placeholder with a reason holding an escaped quote",
      `test("store (set it to run)", { ${m("skip", ': "set \\"DB\\" to run"')} }, () => {});\n`,
    ],
    [
      "the empty placeholder with an async body",
      `test("store (set DATABASE_URL to run)", { ${m("skip", ": true")} }, async () => {});\n`,
    ],
    ["a todo with one quoted name", `${m("test.", "todo(")}"title");\n`],
    ["a todo whose name holds a comma", `${m("test.", "todo(")}"a, b");\n`],
    ["a todo whose template name holds a member path", m("test.", "todo(", "`a $", "{b.c}`);\n")],
    [
      "node:test's in-body todo with a reason",
      `test("t", (t) => {\n  ${m("t.", "todo(")}"later");\n});\n`,
    ],
    [
      "a skipIf whose argument starts with an array",
      `${m("test.skipIf(", '["linux"].includes(process.platform))(')}"t", fn);\n`,
    ],
    [
      "a skipIf whose argument starts with an object",
      `${m("test.skipIf(", "{ a: 1 }.a)(")}"t", fn);\n`,
    ],
    ["a skipIf with a second argument", `${m("test.skipIf(", '!isCI, "reason")(')}"t", fn);\n`],
    ["a skipIf on a comma expression of names", `${m("test.skipIf(", "(a, b))(")}"t", fn);\n`],
    ["a skipIf on a cast compared", `${m("test.skipIf(", "1 as number === n)(")}"t", fn);\n`],
    ["a runIf on an array (always runs)", `${m("test.runIf(", "[])(")}"t", fn);\n`],
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
      "a fails data key holding a call",
      `const rows = [\n  {\n    ${m("fa", 'ils: FAILS.noHook("beforeSend")')},\n  },\n];\n`,
    ],
    [
      "a wrapped fails data key holding a string",
      `const rows = [\n  {\n    ${m("fa", 'ils: "no hook"')},\n  },\n];\n`,
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
      "a conditional skip on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}isMobile, "r");\n});\n`,
    ],
    [
      "a conditional fail on testInfo",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "fail(")}browserName === "webkit");\n});\n`,
    ],
    [
      "a conditional skip on testInfo wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo.", "skip(")}\n    isMobile,\n    "r",\n  );\n});\n`,
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
      'const s = "a.o\\nly(1) b.\\fixme(2) \\tes\\t.skip(4) descri\\be.skip(5) desc\\ribe.skip(6)"; // c.fi\\xme(3) test.r\\unIf(false)(7)\n',
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
      "a not-equal comparison after only",
      `test("t", () => {\n  if (opts.only != (mode === "a")) run();\n});\n`,
    ],
    [
      "a strict not-equal comparison after only",
      `test("t", () => {\n  if (opts.only !== (mode === "a")) run();\n});\n`,
    ],
    [
      "a negated array literal of names",
      `test("t", () => {\n  if (!["only", "skip"].includes(mode)) run();\n});\n`,
    ],
    [
      "a negated array literal of one name",
      `test("t", () => {\n  if (!["only"].includes(mode)) run();\n});\n`,
    ],
    [
      "a non-null member chain",
      `test("t", () => {\n  expect(row!.querySelector("td")!.textContent).toBe("x");\n});\n`,
    ],
    [
      "prose with an exclamation mark before a paren",
      'const s = "Perfect fit! (99%)";\ntest("t", fn);\n',
    ],
    [
      "a conditional skip on a non-null testInfo wrapped by the formatter",
      `test("t", async ({ page }, testInfo) => {\n  ${m("testInfo!.", "skip(")}\n    isMobile,\n    "r",\n  );\n});\n`,
    ],
    [
      "a string holding a block comment before only(",
      'const a = "/* x */ only(";\ntest("t", fn);\n',
    ],
    [
      "a glob string and a trailing block comment",
      'const files = glob("src/**/*.ts"); /* note */\ntest("t", () => {});\n',
    ],
  ];

  describeRows(
    "markers in both kinds of file",
    caught.flatMap(([label, body]) =>
      FILE_KINDS.map(([kind, file, prefix]) => ({
        name: `catches ${label} (${kind})`,
        file,
        after: `${prefix}${body}`,
        refused: true,
      })),
    ),
  );

  describeRows(
    "literals as a skip's first argument in a Playwright spec",
    caughtInPlaywright.map(([label, body]) => ({
      name: `catches ${label} as a skip's first argument (Playwright spec)`,
      file: "bad.spec.ts",
      after: `${PLAYWRIGHT_IMPORT}${body}`,
      refused: true,
    })),
  );

  for (const suppressBlankEmpty of [false, true]) {
    describeRows(
      `wrapped conditional skips${suppressBlankEmpty ? " under diff.suppressBlankEmpty" : ""}`,
      wrappedConditionals
        .filter(([, , , flag]) => flag === suppressBlankEmpty)
        .flatMap(([label, before, after]) =>
          FILE_KINDS.map(([kind, file, prefix]) => ({
            name: `${file === "bad.spec.ts" ? "allows" : "catches"} ${label} (${kind})`,
            file,
            before: `${prefix}${before}`,
            after: `${prefix}${after}`,
            refused: file !== "bad.spec.ts",
          })),
        ),
      suppressBlankEmpty ? [["diff.suppressBlankEmpty", "true"]] : [],
    );
  }

  describeRows(
    "edits around markers in both kinds of file",
    contextEdits.flatMap(([label, before, after, expected]) =>
      FILE_KINDS.map(([kind, file, prefix]) => ({
        name: `${expected ? "catches" : "allows"} ${label} (${kind})`,
        file,
        before: `${prefix}${before}`,
        after: `${prefix}${after}`,
        refused: expected === 1,
      })),
    ),
  );

  describeRows("edits of an unchanged wrapped conditional skip or fail", [
    ...wrappedSkipEdits.map(([label, after, expected]) => ({
      name: `${expected ? "catches" : "allows"} an unchanged wrapped conditional skip with ${label} (Playwright spec)`,
      file: "bad.spec.ts",
      before: `${PLAYWRIGHT_IMPORT}${WRAPPED_SKIP}`,
      after: `${PLAYWRIGHT_IMPORT}${after}`,
      refused: expected === 1,
    })),
    ...wrappedSkipEdits.map(([label, after, expected]) => ({
      name: `${expected ? "catches" : "allows"} an unchanged wrapped conditional fail with ${label} (Playwright spec)`,
      file: "bad.spec.ts",
      before: `${PLAYWRIGHT_IMPORT}${asFail(WRAPPED_SKIP)}`,
      after: `${PLAYWRIGHT_IMPORT}${asFail(after)}`,
      refused: expected === 1,
    })),
    ...sixLineSkips.map(([label, before, after]) => ({
      name: `allows an unchanged wrapped conditional skip with ${label} (Playwright spec)`,
      file: "ok.spec.ts",
      before: `${PLAYWRIGHT_IMPORT}${before}`,
      after: `${PLAYWRIGHT_IMPORT}${after}`,
      refused: false,
    })),
  ]);

  describeRows(
    "markers beside allowed ones",
    unionCases.map(([label, file, before, after]) => ({
      name: `catches ${label}`,
      file,
      before,
      after,
      refused: true,
    })),
  );

  describeRows(
    "conditional skips in and outside a Playwright spec",
    conditionalSkips.flatMap(([label, body]) => [
      {
        name: `allows ${label} in a Playwright spec`,
        file: "ok.spec.ts",
        after: `${PLAYWRIGHT_IMPORT}${body}test("t", () => {});\n`,
        refused: false,
      },
      {
        name: `catches ${label} outside a Playwright spec`,
        file: "bad.test.ts",
        after: `${body}test("t", () => {});\n`,
        refused: true,
      },
    ]),
  );

  describeRows("which files are Playwright specs", [
    ...playwrightImports.map(([label, prefix]) => ({
      name: `a file with ${label} of @playwright/test is a Playwright spec`,
      file: "ok.spec.ts",
      after: `${prefix}${CONDITIONAL}`,
      refused: false,
    })),
    ...notPlaywright.map(([label, prefix]) => ({
      name: `a file with only ${label} gets no exemption`,
      file: "bad.spec.ts",
      after: `${prefix}${CONDITIONAL}`,
      refused: true,
    })),
  ]);

  describeRows(
    "shapes that must pass",
    allowed.map(([label, body]) => ({
      name: `allows ${label}`,
      file: "ok.test.ts",
      after: body,
      refused: false,
    })),
  );
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

interface Row {
  name: string;
  file: string;
  /** The file at the base; a row with none adds the file. */
  before?: string;
  after: string;
  refused: boolean;
}

// One throwaway repo and one gate run for a whole table: each row's file sits in a directory of
// its own (r<index>/), and each row is a test of its own that reads its verdict from the listing.
function describeRows(title: string, rows: Row[], config: Array<[string, string]> = []): void {
  describe(title, () => {
    let dir = "";
    let run: { status: number | null; out: string } = { status: null, out: "" };
    const listed = new Map<string, string[]>();
    const messages: string[] = [];

    before(() => {
      dir = mkdtempSync(path.join(tmpdir(), "test-integrity-rows-"));
      makeRepo(dir);
      for (const [key, value] of config) git(dir, "config", key, value);
      const based = rows.filter((row) => row.before !== undefined);
      for (const [index, row] of rows.entries()) {
        if (row.before !== undefined) writeRow(dir, index, row.file, row.before);
      }
      if (based.length > 0) {
        commitAll(dir, "base rows");
        git(dir, "branch", "-f", "base", "main");
      }
      for (const [index, row] of rows.entries()) writeRow(dir, index, row.file, row.after);
      commitAll(dir, "head rows");
      run = runGuard(dir);
      let block: string[] | null = null;
      for (const line of run.out.split("\n")) {
        const header = /^(r\d+)\/.*:\d+:$/.exec(line);
        if (header?.[1] !== undefined) {
          block = listed.get(header[1]) ?? [];
          listed.set(header[1], block);
          block.push(line);
        } else if (line.startsWith("check-test-integrity:") || line.startsWith("ERROR:")) {
          block = null;
          messages.push(line);
        } else {
          block?.push(line);
        }
      }
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("judges every row", () => {
      const refused = rows.some((row) => row.refused);
      assert.equal(run.status, refused ? 1 : 0, run.out);
      assert.match(run.out, refused ? REJECTED : PASSED);
      assert.doesNotMatch(run.out, /cannot judge/);
    });

    for (const [index, row] of rows.entries()) {
      test(row.name, () => {
        const lines = listed.get(`r${index}`);
        assert.equal(
          lines !== undefined,
          row.refused,
          [
            `expected r${index}/${row.file} to be ${row.refused ? "refused" : "allowed"}`,
            `before: ${JSON.stringify(row.before ?? null)}`,
            `after: ${JSON.stringify(row.after)}`,
            ...(lines ?? messages),
          ].join("\n"),
        );
      });
    }
  });
}

function writeRow(dir: string, index: number, file: string, content: string): void {
  const rowDir = path.join(dir, `r${index}`);
  mkdirSync(rowDir, { recursive: true });
  writeFileSync(path.join(rowDir, file), content);
}
