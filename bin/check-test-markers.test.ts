// Fast, in-process cases for each rule of gate 2's JavaScript/TypeScript check, both directions,
// so a mutation of the checker fails a case in milliseconds; check-test-integrity.test.ts runs the
// whole gate on real git repos and is the contract. A few cases at the end run the checker as
// gate 2 does, on a `git diff --raw -z` list.
//
// IMPORTANT: this file is itself a *.test.ts, so the guard judges it when a change to it lands:
// marker text is assembled at runtime by m() and kept in strings, never written as code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { findAddedMarkers, ParseFailure } from "./check-test-markers.ts";

const CHECKER = path.resolve(import.meta.dirname, "check-test-markers.ts");
const PLAYWRIGHT_IMPORT = 'import { test } from "@playwright/test";\n';

// Join fragments into a marker string at runtime, so no marker is contiguous in this source.
function m(...parts: string[]): string {
  return parts.join("");
}

/** The rules of the markers head adds to base, in file order. */
function rules(head: string, file = "a.test.ts", base: string | null = null): string[] {
  return findAddedMarkers(base, head, file).map((marker) => marker.rule);
}

function inSpec(source: string): string[] {
  return rules(`${PLAYWRIGHT_IMPORT}${source}`, "a.spec.ts");
}

// [label, source, the rules refused]: an empty list is a source that must pass.
type Case = [string, string, string[]];

function runCases(title: string, cases: Case[], judge: (source: string) => string[]): void {
  describe(title, () => {
    for (const [label, source, expected] of cases) {
      test(`${expected.length > 0 ? "refuses" : "allows"} ${label}`, () => {
        assert.deepEqual(judge(source), expected, source);
      });
    }
  });
}

const BODY = '"t", () => {\n  run();\n});\n';

runCases(
  "rule 1: only, fixme and expectFailure on any receiver",
  [
    ["only on test", m("test.", "only(", BODY), ["focus"]],
    ["only on another receiver", m("suite.", "only(", BODY), ["focus"]],
    ["only deep in a chain", m("test.describe.serial.", "only(", BODY), ["focus"]],
    ["fixme", m("test.", "fixme(", BODY), ["focus"]],
    ["expectFailure", m("it.", "expectFailure(", BODY), ["focus"]],
    ["an optional call", m("test.", "only?.(", BODY), ["focus"]],
    ["an optional member", m("test?.", "only(", BODY), ["focus"]],
    ["a computed string key", m('test["', 'only"](', BODY), ["focus"]],
    ["a computed template key", m("test[`", "only`](", BODY), ["focus"]],
    ["a parenthesised computed key", m('test[("', 'only")](', BODY), ["focus"]],
    ["an escaped name", m("test.\\u006f", "nly(", BODY), ["focus"]],
    ["type arguments", m("test.", "only<string>(", BODY), ["focus"]],
    ["a non-null receiver", m("test!.", "only(", BODY), ["focus"]],
    ["a non-null callee", m("test.", "only!(", BODY), ["focus"]],
    ["a parenthesised callee", m("(test.", "only)(", BODY), ["focus"]],
    ["an each chain", m("test.", "only.each([[1]])(", BODY), ["focus"]],
    ["a new expression", m("new test.", "only(", BODY), ["focus"]],
    ["a comma callee", m("(0, test.", "only)(", BODY), ["focus"]],
    ["the first operand of a comma callee", m("(test.", "only, f)(", BODY), []],
    ["a tagged each table", m("test.", "only.each`a`(", BODY), ["focus"]],
    ["a comparison", "if (opts.only != mode) run();\n", []],
    ["a less-than", "const n = filters.only < 1;\n", []],
    ["a computed key that is no literal", m("test[", "only](", BODY), []],
    ["a member read", "const o = test.only;\n", []],
    ["a private name", "class A {\n  #only = 1;\n  f() {\n    return this.#only;\n  }\n}\n", []],
  ],
  (source) => rules(source),
);

runCases(
  "rule 2: the x- and f-prefixed markers",
  [
    ["fit", m("f", "it(", BODY), ["prefixed"]],
    ["xdescribe", m("x", "describe(", BODY), ["prefixed"]],
    ["an each chain", m("x", "it.each([[1]])(", BODY), ["prefixed"]],
    ["a non-null call", m("f", "it!(", BODY), ["prefixed"]],
    ["an optional call", m("f", "it?.(", BODY), ["prefixed"]],
    ["a tagged template", m("x", "test`t`;\n"), ["prefixed"]],
    ["a new expression", m("new f", "it(", BODY), ["prefixed"]],
    ["a comma callee", m("(0, f", "it)(", BODY), ["prefixed"]],
    ["a modifier other than each", m("x", "it.failing(", BODY), ["prefixed"]],
    ["a computed modifier key", m("f", 'it["each"]([[1]])(', BODY), ["prefixed"]],
    ["a call through call", m("f", 'it.call(null, "t", () => {});\n'), ["prefixed"]],
    ["a call through bind", m("x", 'describe.bind(null)("s", () => {});\n'), ["prefixed"]],
    ["a computed key that is no literal", m("f", 'it[mode]("t", () => {});\n'), ["prefixed"]],
    ["a variable with a member chain", "const problems = fit.outsideCircle.map((p) => p);\n", []],
    ["a non-modifier after a modifier", m("x", "it.skip.custom(", BODY), []],
    ["an index then a non-modifier", "fit[i].map((p) => p);\n", []],
    ["a method of another object", "model.fit(x, y);\n", []],
    ["a member of a name", m("jg.", "xit(", BODY), ["prefixed"]],
    ["fdescribe as a member of a name", m("jg.", "fdescribe(", BODY), ["prefixed"]],
    ["fit as a member of a name", m("jg.", "fit(", BODY), []],
    ["a member of a member", m("a.b.", "xit(", BODY), []],
    ["a member read", m("const f = jg.", "xit;\n"), []],
    ["a variable", "const fit = 1;\nuse(fit);\n", []],
    ["an object key", "const o = { fit: 1 };\n", []],
    ["a declaration", "function fit() {}\n", []],
    ["a bare expectFailure", m("expect", "Failure(", BODY), ["prefixed"]],
    [
      "a bare expectFailure imported from node:test",
      m("import { expect", 'Failure } from "node:test";\n', "expect", "Failure(", BODY),
      ["import", "prefixed"],
    ],
    [
      "a bare expectFailure imported from a local module",
      m("import { expect", 'Failure } from "./helpers";\n', "expect", "Failure(", BODY),
      ["prefixed"],
    ],
    [
      "a local function named expectFailure called bare",
      m("function expect", "Failure() {}\n", "expect", "Failure(", BODY),
      ["prefixed"],
    ],
    ["an optional call of expectFailure", m("expect", "Failure?.(", BODY), ["prefixed"]],
    ["a comma callee of expectFailure", m("(0, expect", "Failure)(", BODY), ["prefixed"]],
    [
      "expectFailure through call",
      m("expect", 'Failure.call(null, "t", () => {});\n'),
      ["prefixed"],
    ],
    ["expectFailure as a member of a name", m("jg.", "expect", "Failure(", BODY), ["focus"]],
    ["a declaration of expectFailure", m("function expect", "Failure() {}\n"), []],
    ["a read of expectFailure", m("use(expect", "Failure);\n"), []],
  ],
  (source) => rules(source),
);

runCases(
  "rule 3: rooted skips outside a Playwright spec",
  [
    ["a titled skip", m("test.", "skip(", BODY), ["skip"]],
    ["a conditional-looking skip", m("test.", "skip(isCI, ", '"r");\n'), ["skip"]],
    ["fail", m("test.", "fail(", BODY), ["skip"]],
    ["fails", m("it.", "fails(", BODY), ["skip"]],
    ["failing", m("test.", "failing(", BODY), ["skip"]],
    ["each after skip", m("test.", "skip.each([[1]])(", BODY), ["skip"]],
    ["a link before", m("test.sequential.", "skip(", BODY), ["skip"]],
    ["describe", m("describe.", "skip(", BODY), ["skip"]],
    ["suite", m("suite.", "skip(", BODY), ["skip"]],
    ["context", m("context.", "skip(", BODY), ["skip"]],
    ["specify", m("specify.", "skip(", BODY), ["skip"]],
    ["concurrent", m("concurrent.", "skip(", BODY), ["skip"]],
    ["a runIf link with a call inside", m("test.runIf(f(x)).", "skip(", BODY), ["skip"]],
    ["a skipIf link", m("test.skipIf(isCI).", "skip(", BODY), ["skip"]],
    ["an extend link", m("test.extend({}).", "skip(", BODY), ["skip"]],
    ["a receiver read off a namespace", m("nt.test.", "skip(", BODY), ["skip"]],
    ["a comma callee", m("(0, test.", "skip)(", BODY), ["skip"]],
    ["a new expression", m("new describe.", "skip(", BODY), ["skip"]],
    ["a receiver read off a global", m("globalThis.it.", "skip(", BODY), ["skip"]],
    ["a member of a name that is no receiver", m("db.cursor.", "skip(10);\n"), []],
    ["an info link", m("test.info().", "skip(isCI, ", '"r");\n'), ["skip"]],
    ["an optional link call", m("test.runIf?.(isCI).", "skip(", BODY), ["skip"]],
    ["a parenthesised receiver", m("(test).", "skip(", BODY), ["skip"]],
    ["a non-null link", m("test.runIf(isCI)!.", "skip(", BODY), ["skip"]],
    ["a split chain", m("test\n  .", "skip(", BODY), ["skip"]],
    ["a cursor skip", "t.context.db.collection(u).find({}).skip(10);\n", []],
    ["a skip after a call of no link", "test.each([[1]]).skip(1);\n", []],
    ["a skip on a computed link", m("test[name].", "skip(", BODY), ["skip"]],
    ["a skip after a computed link call", "test[name](x).skip(1);\n", []],
    ["a skip on another root", m("page.", "skip(", BODY), []],
    ["a skip on this", m("this.", 'skip("reason");\n'), ["contextSkip"]],
    ["a skip on a call of a name", m("getTest().", 'skip("reason");\n'), []],
    ["an alias", m("const s = test.", "skip;\n"), []],
  ],
  (source) => rules(source),
);

runCases(
  "rule 3: the conditional skip in a Playwright spec",
  [
    ["a condition", m("test.", "skip(isCI, ", '"r");\n'), []],
    ["a string-keyed condition", m('test["', 'skip"](isCI, "r");\n'), []],
    ["a conditional fail", m("test.", "fail(isWebkit, ", '"bug");\n'), []],
    ["a negated condition", m("test.", "skip(!process.env.X, ", '"r");\n'), []],
    [
      "a fixture callback",
      m("test.", "skip(({ browserName }) => browserName === ", '"webkit");\n'),
      [],
    ],
    ["a callback returning a name", m("test.", "skip(() => isCI, ", '"r");\n'), []],
    ["a callback with a block body", m("test.", "skip(() => {\n  return isCI;\n});\n"), []],
    ["a function callback", m("test.", "skip(function () {\n  return isCI;\n});\n"), []],
    [
      "a callback whose nested function returns a literal",
      m("test.", "skip(() => {\n  const f = () => true;\n  return isCI && f;\n});\n"),
      [],
    ],
    [
      "a callback whose nested class returns a literal",
      m(
        "test.",
        "skip(() => {\n  class A {\n    m() {\n      return 1;\n    }\n  }\n  return isCI;\n});\n",
      ),
      [],
    ],
    ["a non-ASCII name", m("test.", "skip(é, ", '"r");\n'), []],
    ["a literal compared with a name", m("test.", "skip(0 < x, ", '"r");\n'), []],
    ["a member of this", m("test.", "skip(this.flag, ", '"r");\n'), []],
    ["a computed member of a name", m("test.", "skip([1][i], ", '"r");\n'), []],
    ["a shorthand property's name", m("test.", "skip({ isCI }.isCI, ", '"r");\n'), []],
    ["a computed key's name", m("test.", "skip({ [k]: 1 }.a, ", '"r");\n'), []],
    ["a sum of literals", m("test.", "skip(1 + 1, ", '"r");\n'), ["skip"]],
    ["a loose equality of literals", m("test.", "skip(1 == 1, ", '"r");\n'), ["skip"]],
    ["a member of a literal", m("test.", "skip([].length, ", '"r");\n'), ["skip"]],
    ["a method of a literal", m("test.", 'skip("a".includes("a"), ', '"r");\n'), ["skip"]],
    ["literal names", m("test.", "skip([undefined, NaN, Infinity].length, ", '"r");\n'), ["skip"]],
    ["a key's own name", m("test.", "skip({ a: 1 }.a, ", '"r");\n'), ["skip"]],
    ["an object method's name", m("test.", "skip({ f() {} }.f(), ", '"r");\n'), ["skip"]],
    ["a cast to a named type", m("test.", "skip([].length as Count, ", '"r");\n'), ["skip"]],
    ["a callback returning a sum", m("test.", "skip(() => 1 + 1, ", '"r");\n'), ["skip"]],
    ["no argument", m("test.", "skip();\n"), ["bare"]],
    ["a title and a body", m("test.", "skip(", BODY), ["skip"]],
    ["a literal", m("test.", "skip(true, ", '"r");\n'), ["skip"]],
    ["an or with a literal", m("test.", "skip(isCI || true, ", '"r");\n'), ["skip"]],
    ["a negated literal", m("test.", "skip(!null, ", '"r");\n'), ["skip"]],
    ["a parenthesised literal", m("test.", "skip((true), ", '"r");\n'), ["skip"]],
    ["Infinity", m("test.", "skip(Infinity, ", '"r");\n'), ["skip"]],
    ["a doubly negated regex", m("test.", "skip(!!/x/, ", '"r");\n'), ["skip"]],
    ["a callback returning a literal", m("test.", "skip(() => true, ", '"r");\n'), ["skip"]],
    ["a callback returning a regex", m("test.", "skip(() => /x/, ", '"r");\n'), ["skip"]],
    ["a callback with no return", m("test.", "skip(() => {});\n"), ["skip"]],
    [
      "a generator callback",
      m("test.", 'skip(function* () {\n  return isCI;\n}, "r");\n'),
      ["skip"],
    ],
    [
      "a callback with a bare return",
      m("test.", "skip(() => {\n  if (x) return;\n  return isCI;\n});\n"),
      ["skip"],
    ],
    [
      "a callback returning a literal from a block",
      m("test.", "skip(() => {\n  return true;\n});\n"),
      ["skip"],
    ],
    ["a later function", m("test.", "skip(isCI, () => {});\n"), ["skip"]],
    ["a later async function", m("test.", "skip(isCI, async function () {});\n"), ["skip"]],
    ["a later parenthesised function", m("test.", "skip(isCI, (() => {}));\n"), ["skip"]],
    ["a spread", m("test.", "skip(...conditions);\n"), ["skip"]],
    ["an optional call", m("test.", "skip?.(isCI, ", '"r");\n'), ["skip"]],
    ["an optional member", m("test?.", "skip(isCI, ", '"r");\n'), ["skip"]],
    ["a non-null callee", m("test.", "skip!(isCI, ", '"r");\n'), ["skip"]],
    ["a parenthesised receiver", m("(test).", "skip(isCI, ", '"r");\n'), ["skip"]],
    ["type arguments", m("test.", "skip<string>(isCI, ", '"r");\n'), ["skip"]],
    ["a template key", m("test[`", "skip`](isCI, ", '"r");\n'), ["skip"]],
    ["fails", m("test.", "fails(isCI, ", '"r");\n'), ["skip"]],
    ["a skip on describe", m("test.describe.", "skip(isCI, ", '"r");\n'), ["skip"]],
    ["a skip on another receiver", m("it.", "skip(isCI, ", '"r");\n'), ["skip"]],
    ["a namespace's test", m("pw.test.", "skip(isCI, ", '"r");\n'), ["skip"]],
  ],
  inSpec,
);

runCases(
  "which file is a Playwright spec",
  [
    ["a named import", PLAYWRIGHT_IMPORT, []],
    ["a default import", 'import test from "@playwright/test";\n', []],
    ["a namespace import", 'import * as pw from "@playwright/test";\n', []],
    ["a value beside a type", 'import { type Page, test } from "@playwright/test";\n', []],
    ["a require", 'const { test } = require("@playwright/test");\n', []],
    ["a type-only import", 'import type { Page } from "@playwright/test";\n', ["skip"]],
    ["only type specifiers", 'import { type Page } from "@playwright/test";\n', ["skip"]],
    ["an import binding nothing", 'import "@playwright/test";\n', ["skip"]],
    ["a fixtures module", 'import { test } from "./fixtures";\n', ["skip"]],
    ["a comment", '// import { test } from "@playwright/test";\n', ["skip"]],
    ["a string", 'const runner = "@playwright/test";\n', ["skip"]],
    ["a require of another module", 'const { test } = require("./fixtures");\n', ["skip"]],
    ["a declaration with no value", "let test;\n", ["skip"]],
    [
      "a require inside a function",
      'function f() {\n  return require("@playwright/test");\n}\n',
      ["skip"],
    ],
  ],
  (prefix) => rules(m(prefix, "test.", "skip(isCI, ", '"r");\n'), "a.spec.ts"),
);

runCases(
  "rule 4: a bare skip or todo on any receiver, or any skip or todo on a test context",
  [
    ["this.skip()", m("this.", "skip();\n"), ["bare"]],
    ["t.todo()", m("t.", "todo();\n"), ["bare"]],
    ["an optional call", m("this.", "skip?.();\n"), ["bare"]],
    ["a non-null callee", m("this.", "skip!();\n"), ["bare"]],
    ["a skip with a reason", m("t.", 'skip("reason");\n'), ["contextSkip"]],
    ["a todo with a reason", m("t.", 'todo("later");\n'), ["contextSkip"]],
    [
      "t.todo with a reason in a test",
      m('test("x", (t) => {\n  t.', 'todo("wip");\n});\n'),
      ["contextSkip"],
    ],
    [
      "this.skip with a reason in a mocha body",
      m('it("x", function () {\n  this.', 'skip("flaky");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a context under another name",
      m('test("x", (ctx) => {\n  ctx.', 'skip("wip");\n  throw new Error("boom");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a todo on a context named context",
      m('test("x", (context) => {\n  context.', 'todo("wip");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a subtest's context",
      m('t.test("x", async (sub) => {\n  sub.', 'skip("wip");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a context with a default value",
      m('test("x", (ctx = {}) => {\n  ctx.', 'skip("wip");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a typed context",
      m('test("x", (ctx: TestContext) => {\n  ctx.', 'skip("wip");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a context after a TypeScript this parameter",
      m('test("x", function (this: unknown, ctx) {\n  ctx.', 'skip("wip");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a second parameter after a TypeScript this parameter",
      m('test("x", function (this: unknown, ctx, done) {\n  done.', 'skip("wip");\n});\n'),
      [],
    ],
    [
      "a skip on this in a hook",
      m("beforeEach(function () {\n  this.", 'skip("x");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a hook's context",
      m("beforeEach((ctx) => {\n  ctx.", 'skip("x");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a member hook's context",
      m("t.afterEach((ctx) => {\n  ctx.", 'skip("x");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a wrapped callback's context",
      m('test("x", ((ctx) => {\n  ctx.', 'skip("x");\n}) as Fn);\n'),
      ["contextSkip"],
    ],
    ["a skip called through call", m("t.", 'skip.call(t, "x");\n'), ["contextSkip"]],
    [
      "a skip in a helper taking t",
      m("function maybeSkip(t) {\n  t.", 'skip("r");\n}\n'),
      ["contextSkip"],
    ],
    [
      "a skip method on this in a cursor class (the closed side)",
      m("class Cursor {\n  page() {\n    return this.", "skip(10);\n  }\n}\n"),
      ["contextSkip"],
    ],
    [
      "a planned todo on node:test imported as t",
      m('import t from "node:test";\nt.', 'todo("planned");\n'),
      [],
    ],
    [
      "a todo with a body on node:test imported as t",
      m('import t from "node:test";\nt.', "todo(", BODY),
      ["todo"],
    ],
    [
      "a todo on a parameter t in a file that imports node:test as t",
      m('import { test as t } from "node:test";\nfunction later(t) {\n  t.', 'todo("r");\n}\n'),
      ["contextSkip"],
    ],
    [
      "a skip on a cursor named t (the closed side)",
      m("const t = db.find({});\nt.", "skip(10);\n"),
      ["contextSkip"],
    ],
    ["a skip on another receiver", m("cursor.", "skip(10);\n"), []],
    ["a skip read, not called", m("const s = t.", "skip;\n"), []],
    ["a skip on a context's member", m('test("x", (ctx) => {\n  ctx.db.', 'skip("x");\n});\n'), []],
    [
      "a skip on a second parameter",
      m('test("x", (ctx, done) => {\n  done.', 'skip("x");\n});\n'),
      [],
    ],
    [
      "a skip on a name a nested function rebinds",
      m('test("x", (ctx) => {\n  rows.map((ctx) => ctx.', "skip(1));\n});\n"),
      [],
    ],
    [
      "a skip on a name a nested function binds second",
      m('test("x", (ctx) => {\n  rows.map((row, ctx) => ctx.', "skip(1));\n});\n"),
      [],
    ],
    [
      "a skip on the first parameter of another call's callback",
      m("rows.map((ctx) => ctx.", "skip(1));\n"),
      [],
    ],
    [
      "a skip on the first parameter of a function declaration",
      m("function page(ctx) {\n  return ctx.", "skip(1);\n}\n"),
      [],
    ],
    [
      "a skip on the context of a renamed test import's callback",
      m(
        'import { test as check } from "node:test";\ncheck("x", (ctx) => {\n  ctx.',
        'skip("r");\n});\n',
      ),
      ["contextSkip"],
    ],
    [
      "a skip on the context of a default import's callback",
      m('import nt from "node:test";\nnt("x", (ctx) => {\n  ctx.', 'skip("r");\n});\n'),
      ["contextSkip"],
    ],
    [
      "a skip on the first parameter of another export's callback",
      m('import { mock as mk } from "node:test";\nmk("x", (ctx) => ctx.', "skip(1));\n"),
      [],
    ],
  ],
  (source) => rules(source),
);

runCases(
  "rule 5: a rooted todo holding anything but one name",
  [
    ["one name", m("test.", 'todo("planned");\n'), []],
    ["one name on it", m("it.", 'todo("planned");\n'), []],
    ["a template of names", m("test.", "todo(`a $", "{x} $", "{y.z}`);\n"), []],
    ["a non-null callee", m("test.", 'todo!("planned");\n'), []],
    ["a body", m("test.", "todo(", BODY), ["todo"]],
    ["a name", m("test.", "todo(title);\n"), ["todo"]],
    ["a template with a call", m("test.", "todo(`a $", "{f()}`);\n"), ["todo"]],
    ["a template with a computed member", m("test.", "todo(`a $", "{x[0]}`);\n"), ["todo"]],
    ["an each chain", m("test.", 'todo.each([[1]])("n");\n'), ["todo"]],
    ["a tagged template", m("test.", "todo`t`;\n"), ["todo"]],
    ["a body on describe", m("describe.", 'todo("s", () => {});\n'), ["todo"]],
    ["a body on a namespace's test", m("nt.test.", 'todo("t", fn);\n'), ["todo"]],
    ["no argument", m("test.", "todo();\n"), ["bare"]],
    ["a body on a test context", m("t.", 'todo("t", fn);\n'), ["contextSkip"]],
    ["a body on another receiver", m("list.", 'todo("t", fn);\n'), []],
  ],
  (source) => rules(source),
);

// skipIf / runIf arguments, each called on test: [argument, refused by skipIf, by runIf].
const LINK_ARGUMENTS: Array<[string, boolean, boolean]> = [
  ["", false, true],
  ["true", true, false],
  ["false", false, true],
  ["0", false, true],
  ["1", true, false],
  ["0.0", false, true],
  ["0x0", false, true],
  ["0n", false, true],
  ["1n", true, false],
  ["1e3", true, false],
  ["NaN", false, true],
  ["Infinity", true, false],
  ["undefined", false, true],
  ["null", false, true],
  ["void 0", false, true],
  ['""', false, true],
  ['"x"', true, false],
  ["``", false, true],
  ["`x`", true, false],
  [m("`$", "{x}`"), false, false],
  [m("`a$", "{x}`"), true, true],
  ["-1", true, false],
  ["-0", false, true],
  ["+-0", false, true],
  ["+-1", true, false],
  ["-false", false, true],
  ["-true", true, false],
  ['+"1"', true, true],
  ["+1n", false, false],
  ["-1n", true, false],
  ["~0", true, true],
  ["~1n", true, true],
  ["!0", true, true],
  ["!1", true, true],
  ["!NaN", true, true],
  ["!void 0", true, true],
  ["(true)", true, true],
  ["(false)", true, true],
  ["(0, true)", true, true],
  ["(isCI, true)", true, true],
  ["true as boolean", true, false],
  ["false as boolean", false, true],
  ["false satisfies boolean", false, true],
  ["<boolean>false", false, true],
  ["true!", true, false],
  ["/x/", true, false],
  ["-/x/", true, true],
  ["[]", true, false],
  ["+[]", true, true],
  ["+[1]", true, true],
  ["+[[1]]", false, false],
  ["+[,]", false, false],
  ["+[...x]", false, false],
  ["+[null]", true, true],
  ["+[x]", false, false],
  ["{}", true, false],
  ["+{}", true, true],
  ["+{ a: 1 }", false, false],
  ["() => x", true, false],
  ["function () {}", true, false],
  ["!(() => x)", true, true],
  ["+(() => x)", true, true],
  ["class {}", true, true],
  ["new Date()", true, true],
  ["(() => !process.env.DB)()", true, true],
  ["typeof x", true, true],
  ["isCI", false, false],
  ["!isCI", false, false],
  ["-x", false, false],
  ["typeof x === 'string'", false, false],
  ["!0 && isCI", false, false],
  ["0 && isCI", true, true],
  ["1 && isCI", false, false],
  ["isCI && true", false, false],
  ["0 || isCI", false, false],
  ["1 || isCI", true, true],
  ["null ?? isCI", false, false],
  ["0 ?? isCI", true, true],
  ["undefined ?? 1", true, true],
  ["true ? 0 : isCI", true, true],
  ["false ? 0 : isCI", false, false],
  ["isCI ? 0 : 1", false, false],
  ["(isCI, 0)", true, true],
  ["x = 1", true, true],
  ["x += 1", false, false],
  ["await 1", true, true],
  ["await isCI", false, false],
  ["1 === 1", true, true],
  ["1 !== 1", true, true],
  ["1 < 2", true, true],
  ["1 > 2", true, true],
  ["2 <= 1", true, true],
  ["2 >= 1", true, true],
  ["1 === Number(x)", false, false],
  ["typeof x === typeof y", false, false],
  ["1 + 1", false, false],
  ["delete x.y", false, false],
  ["x++", false, false],
  ['["linux"].includes(p)', false, false],
  ["{ a: 1 }.a", false, false],
  ["(a, b)", false, false],
  ["!isCI, 'reason'", false, false],
  ["...xs", false, false],
  ["[] || isCI", true, true],
  ["isCI || true", true, true],
  ["isCI || []", true, true],
  ["!(isCI || 1)", true, true],
  ["isCI || 0", false, false],
  ["isCI && 1", false, false],
  ["![] || isCI", false, false],
  ["([])", true, true],
  ["-!0", true, true],
  ["~0 && isCI", false, false],
  ["-null", false, true],
  ["-undefined", false, true],
  ["-NaN", false, true],
  ["-Infinity", true, false],
  ["-``", true, true],
  ["-typeof x", false, false],
  ["!typeof x", true, true],
  [m("`a$", '{x}` === "?" || isCI'), false, false],
  ["void 0 === undefined || isCI", true, true],
  ["1 === 1 || isCI", true, true],
  ["1 !== 2 || isCI", true, true],
  ["1 < 2 || isCI", true, true],
  ["1 < 1 || isCI", false, false],
  ["2 > 1 || isCI", true, true],
  ["1 > 1 || isCI", false, false],
  ["1 <= 1 || isCI", true, true],
  ["2 <= 1 || isCI", false, false],
  ["1 >= 1 || isCI", true, true],
  ["1 >= 2 || isCI", false, false],
  ["+[typeof x]", false, false],
  ["+[1] || isCI", true, true],
  ["+[null] === 0 || isCI", true, true],
  ["+[undefined] === 0 || isCI", true, true],
];

describe("rule 6: skipIf and runIf with a constant argument", () => {
  for (const [argument, skipIf, runIf] of LINK_ARGUMENTS) {
    for (const [link, refused] of [
      ["skipIf", skipIf],
      ["runIf", runIf],
    ] as const) {
      test(`${refused ? "refuses" : "allows"} ${link}(${argument})`, () => {
        const source = m("test.", link, `(${argument})("t", fn);\n`);
        assert.deepEqual(rules(source), refused ? [link] : [], source);
      });
    }
  }

  test("judges the link on any rooted chain and in any spelling", () => {
    assert.deepEqual(rules(m("describe.", 'skipIf(true)("s", fn);\n')), ["skipIf"]);
    assert.deepEqual(rules(m("test.concurrent.", 'skipIf(1)("t", fn);\n')), ["skipIf"]);
    assert.deepEqual(rules(m("v.test.", 'skipIf(true)("t", fn);\n')), ["skipIf"]);
    assert.deepEqual(rules(m("test.", 'skipIf?.(true)("t", fn);\n')), ["skipIf"]);
    assert.deepEqual(rules(m('test["', 'runIf"](false)("t", fn);\n')), ["runIf"]);
    assert.deepEqual(rules(m("vi.", "skipIf(true);\n")), []);
    assert.deepEqual(rules(m("skipIf", "(true);\n")), []);
  });
});

runCases(
  "rule 7: Playwright's testInfo fixture",
  [
    ["a literal skip", m("testInfo.", 'skip(true, "r");\n'), ["testInfo"]],
    ["a literal fail", m("testInfo.", "fail(1);\n"), ["testInfo"]],
    ["a bare fail", m("testInfo.", "fail();\n"), ["testInfo"]],
    ["a bare skip", m("testInfo.", "skip();\n"), ["bare"]],
    ["a callback", m("testInfo.", 'skip(() => isMobile, "r");\n'), ["testInfo"]],
    ["a negated literal", m("testInfo.", "skip(!0);\n"), ["testInfo"]],
    ["a sum of literals", m("testInfo.", 'skip(1 + 1, "r");\n'), ["testInfo"]],
    ["an optional receiver", m("testInfo?.", "skip(true);\n"), ["testInfo"]],
    ["a non-null callee", m("testInfo.", "skip!(true);\n"), ["testInfo"]],
    ["a parenthesised receiver", m("(testInfo).", "skip(true);\n"), ["testInfo"]],
    ["a condition", m("testInfo.", 'skip(isMobile, "r");\n'), []],
    ["a comparison", m("testInfo.", 'fail(browserName === "webkit");\n'), []],
    ["another fixture name", m("info.", "skip(true);\n"), []],
    ["another method", m("testInfo.", "annotate(true);\n"), []],
  ],
  (source) => rules(source),
);

// Options values of a test call: [value, refused].
const OPTION_VALUES: Array<[string, boolean]> = [
  ["true", true],
  ['"reason"', true],
  ["''", true],
  ["1", true],
  ["0", true],
  ["-1", true],
  ["NaN", true],
  ["null", true],
  ["Infinity", true],
  ["!0", true],
  ["~0", true],
  ["(true)", true],
  ["!void 0", true],
  ["!!/x/", true],
  ["() => x", true],
  ["function () {}", true],
  ["!(() => x)", true],
  ["[]", true],
  ["{}", true],
  ["/x/", true],
  ["-offset", true],
  ["+x", true],
  ["~x.indexOf(y)", true],
  ["-f(a, b)", true],
  ["-x!", true],
  ["(-offset)", true],
  ["-offset as number", true],
  ["typeof x", true],
  ["typeof(x)", true],
  ["new Date()", true],
  ["await 1", true],
  ['await "x"', true],
  ["~0 || isCI", true],
  ["!~0 || isCI", true],
  ["!~{}", true],
  ["0 || isCI", true],
  ['"a" && isCI', true],
  ["Infinity && isCI", true],
  ["1n || isCI", true],
  ["`x` || isCI", true],
  ["true || isCI", true],
  ["!(0 || isCI)", true],
  ["(isCI, 1)", true],
  ["(() => x) && isCI", true],
  ["(0, isCI)", true],
  ["isCI || true", true],
  ["isCI || false", false],
  ["await false", true],
  ["await undefined", true],
  ["false", false],
  ["undefined", false],
  ["void 0", false],
  ["!process.env.X", false],
  ["null ?? isCI", false],
  ["false || isCI", false],
  ["-offset < 0", false],
  ["-x ? a : b", false],
  ["-a && b", false],
  ["!-(offset)", false],
  ["(isCI)", false],
  ["isCI as boolean", false],
  ['typeof Bun === "undefined"', false],
  ["new Date().getDay() === 0", false],
  ["await isFlaky()", false],
  ["/^win/.test(p)", false],
  ['!["linux"].includes(p)', false],
  ["hasError", false],
  ["x.y", false],
];

describe("rule 8: the options object of a test call", () => {
  for (const [value, refused] of OPTION_VALUES) {
    test(`${refused ? "refuses" : "allows"} ${m("sk", "ip")}: ${value}`, () => {
      const source = m('test("t", { ', "skip: ", value, " }, () => {\n  run();\n});\n");
      assert.deepEqual(rules(source), refused ? ["option"] : [], source);
    });
  }

  const cases: Case[] = [
    ["only", m('test("t", { ', "only: true }, fn);\n"), ["option"]],
    ["todo", m('test("t", { ', "todo: 1 }, fn);\n"), ["option"]],
    ["fails", m('test("t", { ', "fails: true }, fn);\n"), ["option"]],
    ["expectFailure", m('test("t", { ', "expectFailure: true }, fn);\n"), ["option"]],
    ["an error class", m('test("t", { ', "expectFailure: TypeError }, fn);\n"), ["option"]],
    ["an exception class", m('test("t", { ', "expectFailure: DOMException }, fn);\n"), ["option"]],
    ["a bare Error", m('test("t", { ', "expectFailure: Error }, fn);\n"), ["option"]],
    [
      "a namespaced error class",
      m('test("t", { ', "expectFailure: assert.AssertionError }, fn);\n"),
      ["option"],
    ],
    ["a name like an error", m('test("t", { ', "expectFailure: hasError }, fn);\n"), []],
    ["a member path to a flag", m('test("t", { ', "expectFailure: config.flag }, fn);\n"), []],
    [
      "a deep namespaced error class",
      m('test("t", { ', "expectFailure: node.assert.AssertionError }, fn);\n"),
      ["option"],
    ],
    [
      "an error class under a computed member",
      m('test("t", { ', 'expectFailure: errors["x"].TypeError }, fn);\n'),
      [],
    ],
    ["an error class as skip", m('test("t", { ', "skip: TypeError }, fn);\n"), []],
    [
      "an error class off a name path",
      m('test("t", { ', "expectFailure: f().AssertionError }, fn);\n"),
      [],
    ],
    [
      "a computed error class",
      m('test("t", { ', 'expectFailure: errors["TypeError"] }, fn);\n'),
      [],
    ],
    ["the first argument", m("test({ ", "skip: 1 }, fn);\n"), ["option"]],
    ["the third argument", m('test("t", fn, { ', "skip: 1 });\n"), []],
    ["a subtest", m('t.test("t", { ', "only: true }, fn);\n"), ["option"]],
    ["describe", m('describe("s", { ', "skip: 1 }, fn);\n"), ["option"]],
    ["an optional call", m('test?.("t", { ', "skip: 1 }, fn);\n"), ["option"]],
    ["a type assertion", m('test("t", <TestOptions>{ ', "skip: 1 }, fn);\n"), ["option"]],
    ["a spread object", m('test("t", { ...{ ', "skip: 1 } }, fn);\n"), ["option"]],
    ["a spread name", m('test("t", { ...opts, timeout: 1 }, fn);\n'), []],
    ["a quoted key", m('test("t", { "', 'skip": 1 }, fn);\n'), ["option"]],
    ["a computed key", m('test("t", { ["', 'skip"]: 1 }, fn);\n'), ["option"]],
    ["a template key", m('test("t", { [`', "skip`]: 1 }, fn);\n"), ["option"]],
    ["an escaped key", m('test("t", { sk\\u0069', "p: 1 }, fn);\n"), ["option"]],
    ["a numeric key", m('test("t", { 1: true }, fn);\n'), []],
    ["a computed name key", m('test("t", { [key]: true }, fn);\n'), []],
    ["a method", m('test("t", { ', "todo() {} }, fn);\n"), ["option"]],
    ["a getter", m('test("t", { get ', "skip() {\n  return true;\n} }, fn);\n"), ["option"]],
    ["a method of another key", m('test("t", { setup() {} }, fn);\n'), []],
    ["the placeholder", m('test("t (set X to run)", { ', "skip: true }, () => {});\n"), []],
    ["an async placeholder", m('test("t", { ', "skip: true }, async () => {});\n"), []],
    ["a function placeholder", m('test("t", { ', "skip: true }, function () {});\n"), []],
    [
      "a focus option on a function placeholder",
      m('test("t", { ', "only: true }, function () {});\n"),
      ["option"],
    ],
    [
      "a focus option on a placeholder",
      m('test("t", { ', "only: true }, () => {});\n"),
      ["option"],
    ],
    ["a todo placeholder", m('test("t", { ', 'todo: "later" }, () => {});\n'), ["option"]],
    ["a todo option on a placeholder", m('test("t", { ', "todo: true }, () => {});\n"), ["option"]],
    [
      "a skip method on a placeholder",
      m('test("t", { ', "skip() {\n  return true;\n} }, () => {});\n"),
      ["option"],
    ],
    [
      "a skip getter on a placeholder",
      m('test("t", { get ', "skip() {\n  return true;\n} }, () => {});\n"),
      ["option"],
    ],
    ["a first-argument placeholder", m("test({ ", "skip: true }, () => {});\n"), []],
    ["fails on a placeholder", m('test("t", { ', "fails: true }, () => {});\n"), ["option"]],
    [
      "expectFailure on a placeholder",
      m('test("t", { ', "expectFailure: true }, () => {});\n"),
      ["option"],
    ],
    ["a body", m('test("t", { ', "skip: true }, () => {\n  run();\n});\n"), ["option"]],
    ["a body with a parameter", m('test("t", { ', "skip: true }, (t) => {});\n"), ["option"]],
    [
      "a body with a directive",
      m('test("t", { ', 'skip: true }, () => {\n  "use strict";\n});\n'),
      ["option"],
    ],
    ["a body passed by name", m('test("t", { ', "skip: true }, body);\n"), ["option"]],
    ["an argument after the body", m('test("t", { ', "skip: true }, () => {}, 1);\n"), ["option"]],
    ["no body", m('test("t", { ', "skip: true });\n"), ["option"]],
    ["another call", m("makeContext({ ", "skip: 0 });\n"), []],
    ["pagination", m("db.findMany({ ", "skip: 10, take: 5 });\n"), []],
    ["an annotation", m('test("t", { annotation: { type: "', 'skip" } }, fn);\n'), ["annotation"]],
  ];
  for (const [label, source, expected] of cases) {
    test(`${expected.length > 0 ? "refuses" : "allows"} ${label}`, () => {
      assert.deepEqual(rules(source), expected, source);
    });
  }
});

runCases(
  "rule 9: option keys in any other object literal",
  [
    ["skip true", m("const o = { ", "skip: true };\n"), ["data"]],
    ["only a string", m("const o = { ", 'only: "x" };\n'), ["data"]],
    ["skip a template", m("const o = { ", "skip: `x` };\n"), ["data"]],
    ["skip true in an expression", m("const o = { ", "skip: true && x };\n"), ["data"]],
    ["skip a string in a sum", m("const o = { ", 'skip: "a" + b };\n'), ["data"]],
    ["skip true in a conditional", m("const o = { ", "skip: true ? a : b };\n"), ["data"]],
    ["skip true in a sequence", m("const o = { ", "skip: (true, x) };\n"), []],
    ["skip true as a cast", m("const o = { ", "skip: true as boolean };\n"), ["data"]],
    ["fails true", m("const o = { ", "fails: true };\n"), ["data"]],
    ["todo true", m("const o = { ", "todo: true };\n"), ["data"]],
    ["todo a string", m("const o = { ", 'todo: "buy milk" };\n'), ["data"]],
    ["todo a number", m("const o = { ", "todo: 1 };\n"), ["data"]],
    ["todo a negative number", m("const o = { ", "todo: -1 };\n"), ["data"]],
    ["todo Infinity", m("const o = { ", "todo: Infinity };\n"), ["data"]],
    ["todo a function", m("const o = { ", "todo: () => x };\n"), ["data"]],
    ["todo a negated function", m("const o = { ", "todo: !(() => x) };\n"), ["data"]],
    ["todo an array", m("const o = { ", "todo: [] };\n"), ["data"]],
    ["todo a negated array", m("const o = { ", "todo: ![] };\n"), ["data"]],
    ["todo an object", m("const o = { ", "todo: {} };\n"), ["data"]],
    ["todo a negated null", m("const o = { ", "todo: !null };\n"), ["data"]],
    ["todo a parenthesised null", m("const o = { ", "todo: (null) };\n"), ["data"]],
    ["todo a parenthesised undefined", m("const o = { ", "todo: (undefined) };\n"), ["data"]],
    ["expectFailure a regex", m("const o = { ", "expectFailure: /boom/ };\n"), ["data"]],
    ["expectFailure a negated regex", m("const o = { ", "expectFailure: !/boom/ };\n"), ["data"]],
    [
      "expectFailure an object",
      m("const o = { ", 'expectFailure: { message: "boom" } };\n'),
      ["data"],
    ],
    ["expectFailure an error class", m("const o = { ", "expectFailure: TypeError };\n"), ["data"]],
    [
      "expectFailure a negated error class",
      m("const o = { ", "expectFailure: !TypeError };\n"),
      ["data"],
    ],
    ["todo a negated undefined", m("const o = { ", "todo: !undefined };\n"), ["data"]],
    ["todo a negated NaN", m("const o = { ", "todo: !NaN };\n"), ["data"]],
    ["todo a negated void", m("const o = { ", "todo: !void 0 };\n"), ["data"]],
    ["a quoted key", m('const o = { "', 'skip": true };\n'), ["data"]],
    ["skip a number", m("const o = { ", "skip: 10 };\n"), []],
    ["skip a negative number", m("const o = { ", "skip: -1 };\n"), []],
    ["skip zero", m("const o = { ", "skip: 0 };\n"), []],
    ["skip a parenthesised true", m("const o = { ", "skip: (true) };\n"), []],
    ["skip a computed number", m('const o = { ["', 'skip"]: 10 };\n'), []],
    ["skip a name", m("const o = { ", "skip };\n"), []],
    ["fails a string", m("const o = { ", 'fails: "no hook" };\n'), []],
    ["fails a call", m("const o = { ", "fails: FAILS.noHook(x) };\n"), []],
    ["todo null", m("const o = { ", "todo: null };\n"), ["data"]],
    ["todo NaN", m("const o = { ", "todo: NaN };\n"), ["data"]],
    ["skip null", m("const o = { ", "skip: null };\n"), ["data"]],
    ["skip NaN", m("const o = { ", "skip: NaN };\n"), ["data"]],
    ["skip a parenthesised null", m("const o = { ", "skip: (null) };\n"), ["data"]],
    ["only null", m("const o = { ", "only: null };\n"), []],
    ["only NaN", m("const o = { ", "only: NaN };\n"), []],
    ["expectFailure NaN", m("const o = { ", "expectFailure: NaN };\n"), ["data"]],
    ["skip null or a name", m("const o = { ", "skip: null ?? x };\n"), []],
    ["fails null", m("const o = { ", "fails: null };\n"), []],
    ["skip a name called NaN on an object", m("const o = { ", "skip: x.NaN };\n"), []],
    ["todo false", m("const o = { ", "todo: false };\n"), []],
    ["todo a name", m("const o = { ", "todo: x };\n"), []],
    ["todo a difference", m("const o = { ", "todo: a - b };\n"), []],
    ["todo a method", m("const o = { ", "todo() {} };\n"), ["data"]],
    ["todo a getter", m("const o = { get ", "todo() {\n  return 1;\n} };\n"), ["data"]],
    ["expectFailure a method", m("const o = { expect", "Failure() {} };\n"), ["data"]],
    ["skip a method", m("const o = { ", "skip() {\n  return this;\n} };\n"), []],
    ["todo a setter", "const o = { set todo(v) {\n  store(v);\n} };\n", []],
    ["todo an array read", m("const o = { ", 'todo: ["a"].length };\n'), []],
    ["expectFailure a name", m("const o = { ", "expectFailure: hasError };\n"), []],
    ["expectFailure a tested regex", m("const o = { ", "expectFailure: /x/.test(p) };\n"), []],
    ["another key", m("const o = { ", "only2: true };\n"), []],
    ["a destructuring default", m("const { ", "skip = true } = o;\n"), []],
  ],
  (source) => rules(source),
);

runCases(
  "rule 10: Playwright's skip annotation, in any object",
  [
    ["skip", m("const o = { annotation: { type: ", '"skip" } };\n'), ["annotation"]],
    ["fixme", m("const o = { annotation: { type: ", '"fixme" } };\n'), ["annotation"]],
    ["fail", m("const o = { annotation: { type: ", '"fail" } };\n'), ["annotation"]],
    [
      "an array item",
      m('const o = { annotation: [{ type: "issue" }, { type: ', '"fixme" }] };\n'),
      ["annotation"],
    ],
    [
      "type after a description",
      m('const o = { annotation: { description: "x", type: ', "`skip` } };\n"),
      ["annotation"],
    ],
    ["a quoted key", m('const o = { "annotation": { "type": ', '"skip" } };\n'), ["annotation"]],
    [
      "a cast value",
      m("const o = { annotation: { type: ", '"skip" } as const };\n'),
      ["annotation"],
    ],
    ["an issue", 'const o = { annotation: { type: "issue" } };\n', []],
    ["slow", 'const o = { annotation: { type: "slow" } };\n', []],
    ["skipped", 'const o = { annotation: { type: "skipped" } };\n', []],
    ["a holed array", "const o = { annotation: [, { type: x }] };\n", []],
    ["a type by name", "const o = { annotation: { type: SKIP } };\n", []],
    ["a type method", "const o = { annotation: { type() {} } };\n", []],
    ["the plural", m("const o = { annotations: [{ type: ", '"skip" }] };\n'), []],
    ["a reducer action", m("dispatch({ type: ", '"skip" });\n'), []],
    ["a name", "const o = { annotation: SKIP };\n", []],
  ],
  (source) => rules(source),
);

runCases(
  "rule 11: markers imported from node:test or destructured from a test function",
  [
    ["an import", m("import { expect", 'Failure } from "node:test";\n'), ["import"]],
    [
      "a renamed import beside others",
      m("import test, { describe, expect", 'Failure as xf } from "node:test";\n'),
      ["import"],
    ],
    [
      "a string import name",
      m('import { "expect', 'Failure" as xf } from "node:test";\n'),
      ["import"],
    ],
    ["a require", m("const { expect", 'Failure } = require("node:test");\n'), ["import"]],
    [
      "a renamed require",
      m("const { expect", 'Failure: xf } = require("node:test");\n'),
      ["import"],
    ],
    [
      "an await import",
      m("const { expect", 'Failure } = await import("node:test");\n'),
      ["import"],
    ],
    [
      "an exported, parenthesised await import",
      m("export const { expect", 'Failure } = (await import("node:test"));\n'),
      ["import"],
    ],
    ["the npm package", m("import { expect", 'Failure } from "test";\n'), []],
    ["a local module", m("import { expect", 'Failure } from "./helpers";\n'), []],
    ["a type import", m("import type { expect", 'Failure } from "node:test";\n'), []],
    ["a type specifier", m("import { type expect", 'Failure } from "node:test";\n'), []],
    ["another name", 'const { describe } = require("node:test");\n', []],
    ["a destructure of a helper", m("const { expect", "Failure } = helpers;\n"), []],
    ["an array pattern", m("const [expect", 'Failure] = require("node:test");\n'), []],
    ["no value", m("let expect", "Failure;\n"), []],
    ["a call of another function", m("const { expect", 'Failure } = load("node:test");\n'), []],
    ["a require of nothing", m("const { expect", "Failure } = require();\n"), []],
    ...(["skip", "only", "todo"] as const).flatMap((name): Case[] => [
      [`${name}: an import`, m("import { ", name, ' } from "node:test";\n'), ["import"]],
      [
        `${name}: a renamed import beside others`,
        m("import test, { describe, ", name, ' as x } from "node:test";\n'),
        ["import"],
      ],
      [
        `${name}: a string import name`,
        m('import { "', name, '" as x } from "node:test";\n'),
        ["import"],
      ],
      [`${name}: a require`, m("const { ", name, ' } = require("node:test");\n'), ["import"]],
      [
        `${name}: a renamed require`,
        m("const { ", name, ': x } = require("node:test");\n'),
        ["import"],
      ],
      [
        `${name}: an await import`,
        m("const { ", name, ' } = await import("node:test");\n'),
        ["import"],
      ],
    ]),
    ["skip destructured from test", m("const { s", "kip } = test;\n"), ["destructure"]],
    ["only renamed from describe", m("const { o", "nly: o } = describe;\n"), ["destructure"]],
    ["todo destructured from it", m("const { t", "odo } = it;\n"), ["destructure"]],
    ["fails destructured from test", m("const { f", "ails } = test;\n"), ["destructure"]],
    [
      "skip destructured from test.describe",
      m("const { s", "kip } = test.describe;\n"),
      ["destructure"],
    ],
    ["fixme destructured from test", m("const { f", "ixme } = test;\n"), ["destructure"]],
    ["a computed literal key", m('const { ["s', 'kip"]: s } = test;\n'), ["destructure"]],
    [
      "an exported destructure of a LINK call",
      m("export const { f", "ailing } = test.extend({});\n"),
      ["destructure"],
    ],
    ["a ROOT read off a name", m("const { s", "kip } = nt.test;\n"), ["destructure"]],
    [
      "a modifier as the last step",
      m("const { s", "kip } = describe.sequential;\n"),
      ["destructure"],
    ],
    ["a computed key that is no literal", m("const { s", "kip } = test[kind];\n"), ["destructure"]],
    ["skip from a local module", m("import { s", 'kip } from "./helpers";\n'), []],
    ["skip from the npm package", m("import { s", 'kip } from "test";\n'), []],
    ["a type import of skip", m("import type { s", 'kip } from "node:test";\n'), []],
    ["a type specifier of skip", m("import { type s", 'kip } from "node:test";\n'), []],
    [
      "test imported under a marker's name",
      m("import { test as s", 'kip } from "node:test";\n'),
      [],
    ],
    ["skip destructured from query", m("const { s", "kip } = query;\n"), []],
    ["skip destructured from helpers", m("const { s", "kip } = helpers;\n"), []],
    ["a name no rule refuses", "const { each } = test;\n", []],
    ["data read off context", m("const { s", "kip, take } = context.args;\n"), []],
    ["data read off it", m("const { s", "kip } = it.params;\n"), []],
    ["a local helper", m("function s", "kip(n) {\n  return n;\n}\ns", "kip(10);\n"), []],
    ["pagination", m("const page = { s", "kip: 10 };\n"), []],
    ["a planned test", m("test.", 'todo("planned");\n'), []],
    // node:test or its test functions under a name of the file's own.
    [
      "a skip on a default import",
      m('import nt from "node:test";\nnt.', 'skip("t", () => {\n  throw err;\n});\n'),
      ["skip"],
    ],
    [
      "a skip on a namespace import",
      m('import * as nt from "node:test";\nnt.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a todo with a body on a namespace import",
      m('import * as nt from "node:test";\nnt.', "todo(", BODY),
      ["todo"],
    ],
    [
      "a planned todo on a namespace import",
      m('import * as nt from "node:test";\nnt.', 'todo("planned");\n'),
      [],
    ],
    [
      "a skip on a renamed test import",
      m('import { test as check } from "node:test";\ncheck.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip destructured from a renamed test import",
      m('import { test as check } from "node:test";\nconst { s', "kip } = check;\n"),
      ["destructure"],
    ],
    [
      "a skip on a required module",
      m('const nt = require("node:test");\nnt.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip on an awaited module",
      m('const nt = await import("node:test");\nnt.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip on a name assigned a required module",
      m('let nt;\nnt = require("node:test");\nnt.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip on a name assigned another module",
      m('let nt;\nnt = require("./helpers");\nnt.', "skip(", BODY),
      [],
    ],
    [
      "a skip on a test destructured from a require",
      m('const { test: check } = require("node:test");\ncheck.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip on the rest of a require",
      m('const { test, ...nt } = require("node:test");\nnt.', "skip(", BODY),
      ["skip"],
    ],
    ["a skip on a dynamic import", m('(await import("node:test")).', "skip(", BODY), ["skip"]],
    ["a skip on a require", m('require("node:test").', "skip(", BODY), ["skip"]],
    [
      "a skip destructured from a require's test",
      m("const { s", 'kip } = require("node:test").test;\n'),
      ["destructure"],
    ],
    [
      "a nested destructure under test",
      m("const { test: { s", 'kip } } = require("node:test");\n'),
      ["import"],
    ],
    [
      "a nested destructure with a default",
      m("const { describe: { o", 'nly } = {} } = require("node:test");\n'),
      ["import"],
    ],
    [
      "a nested destructure under test from a test function",
      m("const { test: { t", "odo } } = describe;\n"),
      ["destructure"],
    ],
    [
      "a nested destructure under another key",
      m("const { mock: { s", 'kip } } = require("node:test");\n'),
      [],
    ],
    [
      "a nested array pattern under test",
      m("const { test: [s", 'kip] } = require("node:test");\n'),
      [],
    ],
    [
      "a skip on a renamed import of another export",
      m('import { mock as mk } from "node:test";\nmk.', "skip(", BODY),
      [],
    ],
    [
      "a skip on another export destructured from a require",
      m('const { mock: mk } = require("node:test");\nmk.', "skip(", BODY),
      [],
    ],
    [
      "a skip on a namespace type import",
      m('import type * as nt from "node:test";\nnt.', "skip(", BODY),
      [],
    ],
    [
      "a skip on a namespace import of another module",
      m('import * as nt from "./helpers";\nnt.', "skip(", BODY),
      [],
    ],
    [
      "a skip on a module loaded by another call",
      m('const nt = load("node:test");\nnt.', "skip(", BODY),
      [],
    ],
    [
      "a skip on an array pattern of a require",
      m('const [nt] = require("node:test");\nnt.', "skip(", BODY),
      [],
    ],
    // node:test's default export is test, under the name `default` too.
    [
      "a skip on the default export imported by name",
      m('import { default as check } from "node:test";\ncheck.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip on the default export destructured from an awaited module",
      m('const { default: check } = await import("node:test");\ncheck.', "skip(", BODY),
      ["skip"],
    ],
    [
      "a skip destructured from a namespace's default export",
      m('import * as nt from "node:test";\nconst { s', "kip } = nt.default;\n"),
      ["destructure"],
    ],
    [
      "a nested destructure under default",
      m("const { default: { s", 'kip } } = await import("node:test");\n'),
      ["import"],
    ],
    [
      "a skip destructured from another module's default export",
      m('import * as h from "./helpers";\nconst { s', "kip } = h.default;\n"),
      [],
    ],
    [
      "a skip on a test destructured with a default value",
      m('const { test: check = test } = require("node:test");\ncheck.', "skip(", BODY),
      ["skip"],
    ],
  ],
  (source) => rules(source),
);

describe("which markers are new", () => {
  const LEGACY = m("test.", 'skip("t", () => {\n  a();\n});\n');

  test("an import already in base stays allowed when the line after it changes", () => {
    const imported = (call: string) => m("import { s", 'kip } from "node:test";\n', call);
    assert.deepEqual(rules(imported("run(1);\n"), "a.test.ts", imported("run();\n")), []);
  });

  test("a name added to an import line already in base is new", () => {
    const base = m("import { s", 'kip, test } from "node:test";\n');
    const head = m("import { s", "kip, test, t", 'odo } from "node:test";\n');
    assert.deepEqual(rules(head, "a.test.ts", base), ["import"]);
  });

  test("a marker in a file the diff adds is new", () => {
    assert.deepEqual(rules(LEGACY), ["skip"]);
  });

  test("an unchanged marker is not, wherever it moves in its file", () => {
    assert.deepEqual(rules(`run();\n${LEGACY}`, "a.test.ts", `${LEGACY}run();\n`), []);
  });

  test("editing the body of a function the marker does not sit in leaves it alone", () => {
    assert.deepEqual(rules(LEGACY.replace("a()", "b()"), "a.test.ts", LEGACY), []);
    const describeSkip = (body: string) =>
      m("describe.", `skip("s", function () {\n  ${body}\n});\n`);
    assert.deepEqual(rules(describeSkip("b();"), "a.test.ts", describeSkip("a();")), []);
  });

  test("a blank line or a re-indent inside the unit leaves the marker alone", () => {
    const split = (gap: string) => m("test", gap, ".", 'skip("t", fn);\n');
    assert.deepEqual(rules(split("\n\n    "), "a.test.ts", split("\n  ")), []);
    assert.deepEqual(rules(split(""), "a.test.ts", split("\n  ")), ["skip"]);
  });

  test("editing the unit outside function bodies makes it new", () => {
    assert.deepEqual(rules(LEGACY.replace('"t"', '"u"'), "a.test.ts", LEGACY), ["skip"]);
    assert.deepEqual(rules(LEGACY.replace('"t"', '/* x */ "t"'), "a.test.ts", LEGACY), ["skip"]);
  });

  test("a second identical marker is new", () => {
    assert.deepEqual(rules(`${LEGACY}${LEGACY}`, "a.test.ts", LEGACY), ["skip"]);
  });

  test("which test a statement-level marker sits in is part of it", () => {
    const tests = (a: string, b: string) =>
      `it("legacy", function () {\n  ${a}work();\n});\nit("new", function () {\n  ${b}check();\n});\n`;
    const skip = m("this.", "skip();\n  ");
    assert.deepEqual(rules(tests("", skip), "a.test.ts", tests(skip, "")), ["bare"]);
    const renamed = tests(skip, "").replace('"legacy"', '"renamed"');
    assert.deepEqual(rules(renamed, "a.test.ts", tests(skip, "")), ["bare"]);
    const edited = tests(skip, "").replace("work()", "other()");
    assert.deepEqual(rules(edited, "a.test.ts", tests(skip, "")), []);
    const helper = (x: string) => m("function helper() {\n  this.", "skip();\n  ", x, ";\n}\n");
    assert.deepEqual(rules(helper("b()"), "a.test.ts", helper("a()")), []);
    const loop = (x: string) => m("for (const c of cases) {\n  ", x, ";\n  this.", "skip();\n}\n");
    assert.deepEqual(rules(loop("b()"), "a.test.ts", loop("a()")), ["bare"]);
  });

  // Tests that are no statements: [label, the file around its tests, one test (its name
  // and body), the marker]. Which test a marker sits in is part of it; its siblings are not.
  const T_SKIP = m("t.", "skip(); ");
  const memberTests: Array<
    [string, (tests: string[]) => string, (name: string, body: string) => string, string]
  > = [
    [
      "table entries holding a method",
      (tests) => `const cases = [\n  ${tests.join(",\n  ")},\n];\n`,
      (name, body) => `{ name: "${name}", fn(t) { ${body} } }`,
      T_SKIP,
    ],
    [
      "table entries holding an arrow",
      (tests) => `const cases = [\n  ${tests.join(",\n  ")},\n];\n`,
      (name, body) => `{ name: "${name}", fn: (t) => { ${body} } }`,
      T_SKIP,
    ],
    [
      "class methods",
      (tests) => `class Suite {\n  ${tests.join("\n  ")}\n}\n`,
      (name, body) => `${name}(t) { ${body} }`,
      T_SKIP,
    ],
    [
      "a mocha exports object",
      (tests) => `module.exports = {\n  ${tests.join(",\n  ")},\n};\n`,
      (name, body) => `"${name}": function () { ${body} }`,
      m("this.", "skip(); "),
    ],
    [
      "class-field arrows",
      (tests) => `class Suite {\n  ${tests.join("\n  ")}\n}\n`,
      (name, body) => `${name} = (t) => { ${body} };`,
      T_SKIP,
    ],
    [
      "a tuple table",
      (tests) => `const cases = [\n  ${tests.join(",\n  ")},\n];\n`,
      (name, body) => `["${name}", (t) => { ${body} }]`,
      T_SKIP,
    ],
    [
      "a nested-object table",
      (tests) => `const cases = {\n  ${tests.join(",\n  ")},\n};\n`,
      (name, body) => `${name}: { fn(t) { ${body} } }`,
      T_SKIP,
    ],
  ];
  for (const [label, file, one, skip] of memberTests) {
    const legacy = file([one("a", `${skip}work();`), one("b", "check();")]);
    // [what head does to the legacy file, its tests, the rules refused].
    const edits: Array<[string, string[], string[]]> = [
      [
        "moves the marker into another test",
        [one("a", "work();"), one("b", `${skip}check();`)],
        ["bare"],
      ],
      ["renames its test", [one("z", `${skip}work();`), one("b", "check();")], ["bare"]],
      ["edits its test's body", [one("a", `${skip}other();`), one("b", "check();")], []],
      ["adds a sibling", [one("a", `${skip}work();`), one("b", "check();"), one("c", "")], []],
      ["removes a sibling", [one("a", `${skip}work();`)], []],
      ["edits a sibling", [one("a", `${skip}work();`), one("c", "verify();")], []],
      ["moves a sibling before it", [one("b", "check();"), one("a", `${skip}work();`)], []],
    ];
    for (const [edit, tests, expected] of edits) {
      test(`in ${label}, a legacy marker is ${expected.length > 0 ? "new" : "kept"} when head ${edit}`, () => {
        assert.deepEqual(rules(file(tests), "a.test.ts", legacy), expected);
      });
    }
  }

  test("an element that holds no function stays in the key of a test beside it", () => {
    const table = (extra: string) =>
      m("const cases = [\n  ", extra, '{ name: "a", fn(t) { t.', "skip(); } },\n];\n");
    assert.deepEqual(rules(table('"x", '), "a.test.ts", table('"y", ')), ["bare"]);
    assert.deepEqual(rules(table("() => {}, "), "a.test.ts", table("")), []);
    // Two elements kept are not one: `x, y` is no `xy`.
    assert.deepEqual(rules(table("x, y, "), "a.test.ts", table("xy, ")), ["bare"]);
  });

  test("a sibling written up against the closing brace leaves with its body", () => {
    const tight = (sibling: string) => m("class Suite {a(t) {t.", "skip();}", sibling, "}\n");
    assert.deepEqual(rules(tight(""), "a.test.ts", tight("b(t) {}")), []);
  });

  // The closed side, an accepted residual: a concise body makes the whole table the unit.
  test("a marker that is a concise body has its siblings in its unit", () => {
    const table = (extra: string) =>
      m('const cases = [\n  { name: "a", fn: (t) => t.', "skip() },\n", extra, "];\n");
    assert.deepEqual(rules(table('  { name: "b", fn: (t) => {} },\n'), "a.test.ts", table("")), [
      "bare",
    ]);
  });

  test("a table inside a describe body is judged in its own statement", () => {
    const nested = (x: string) =>
      m(
        'describe("s", () => {\n  const cases = [\n    { name: "a", fn(t) { t.',
        `skip(); } },\n    ${x}\n  ];\n});\n`,
      );
    assert.deepEqual(rules(nested('{ name: "b", fn(t) {} },'), "a.test.ts", nested("")), []);
    const after = (x: string) => nested("").replace("});", `  ${x};\n});`);
    assert.deepEqual(rules(after("b()"), "a.test.ts", after("a()")), []);
  });

  test("a marker's unit is its own statement, and a function holding it is not elided", () => {
    const inBody = (x: string) => m('test("t", () => {\n  ', x, ";\n  this.", "skip();\n});\n");
    assert.deepEqual(rules(inBody("b()"), "a.test.ts", inBody("a()")), []);
    const apart = (x: string) => m("f(() => ", x, ", () => this.", "skip());\n");
    assert.deepEqual(rules(apart("b()"), "a.test.ts", apart("a()")), []);
    const holding = (x: string) => m("f(() => ", x, " || this.", "skip());\n");
    assert.deepEqual(rules(holding("b()"), "a.test.ts", holding("a()")), ["bare"]);
  });

  test("markers keep apart by rule, name and position", () => {
    const two = m("f(test.", "only(1), test.", "only(1));\n");
    assert.deepEqual(rules(two, "a.test.ts", two), []);
    assert.deepEqual(rules(m("test.", "fixme(1);\n"), "a.test.ts", m("test.", "only(1);\n")), [
      "focus",
    ]);
  });

  test("a body elided before the marker does not shift it", () => {
    const unit = (body: string) => m("f(() => {", body, "}, test.", "only(1));\n");
    assert.deepEqual(rules(unit(" a(); "), "a.test.ts", unit(" a(); b(); ")), []);
  });

  test("a marker at the start of a concise body is not elided with it", () => {
    const unit = (x: string) => m("g(() => f", "it(", x, "));\n");
    assert.deepEqual(rules(unit("b"), "a.test.ts", unit("a")), ["prefixed"]);
  });

  test("a function in a legacy marker's own condition is part of it", () => {
    const callback = (x: string) => m("test.", `skip(({ browserName }) => ${x}, "r");\n`);
    assert.deepEqual(rules(callback("true"), "a.spec.ts", callback('browserName !== "chromium"')), [
      "skip",
    ]);
    const option = (x: string) =>
      m('test("t", { ', `skip: (() => ${x})() }, () => {\n  run();\n});\n`);
    assert.deepEqual(rules(option("true"), "a.test.ts", option("isCI")), ["option"]);
    const method = (x: string) =>
      m('test("t", { ', `skip() {\n  return ${x};\n} }, () => {\n  run();\n});\n`);
    assert.deepEqual(rules(method("true"), "a.test.ts", method("isCI")), ["option"]);
    const data = (x: string) => m("const o = { ", `todo() {\n  return ${x};\n} };\n`);
    assert.deepEqual(rules(data("true"), "a.test.ts", data("isCI")), ["data"]);
    const body = (x: string) =>
      m("test.", `skip(({ browserName }) => browserName === "a", () => {\n  ${x};\n});\n`);
    assert.deepEqual(rules(body("b()"), "a.test.ts", body("a()")), []);
  });

  // The concise body starts where the marker does: kept, and the test body nested in it elided.
  test("a test body under a concise body that is the marker is elided", () => {
    const unit = (call: string) => m("const f = () => x", 'it("t", () => {\n  ', call, ";\n});\n");
    assert.deepEqual(rules(unit("run2()"), "a.test.ts", unit("run()")), []);
  });

  test("a function inside an elided body is elided with it", () => {
    const unit = (x: string) =>
      m("describe.", 'skip("s", () => {\n  it("a", () => {});\n  ', x, ";\n});\n");
    assert.deepEqual(rules(unit("b()"), "a.test.ts", unit("a()")), []);
  });

  // [label, a unit whose function body holds X]: editing X leaves the marker alone.
  const functionBodies: Array<[string, string]> = [
    ["a function declaration", m("if (f", "it(1)) {\n  function g() {\n    X;\n  }\n}\n")],
    ["an object method", m("test.", 'only("t", { setup() { X; } });\n')],
    ["a class method", m("test.", 'only("t", class { m() { X; } });\n')],
    ["a private class method", m("test.", 'only("t", class { #m() { X; } });\n')],
  ];
  for (const [label, unit] of functionBodies) {
    test(`the body of ${label} in the unit is elided`, () => {
      assert.deepEqual(rules(unit.replace("X", "b()"), "a.test.ts", unit.replace("X", "a()")), []);
    });
  }

  test("a block that is no function body is part of the unit", () => {
    const unit = (x: string) => m("if (f", "it(1)) {\n  while (x) {\n    ", x, ";\n  }\n}\n");
    assert.deepEqual(rules(unit("b()"), "a.test.ts", unit("a()")), ["prefixed"]);
  });

  test("a base that does not parse holds no markers", () => {
    assert.deepEqual(rules(LEGACY, "a.test.ts", `${LEGACY}(`), ["skip"]);
  });

  test("the base is parsed by its own name, unless that is no JavaScript", () => {
    const typed = `const n: number = 1;\n${LEGACY}`;
    assert.deepEqual(findAddedMarkers(typed, typed, "a.test.ts", "a.test.ts").length, 0);
    assert.deepEqual(findAddedMarkers(typed, typed, "a.test.ts", "a.test.js").length, 1);
    assert.deepEqual(findAddedMarkers(typed, typed, "a.test.ts", "a.test.sh").length, 0);
    assert.deepEqual(findAddedMarkers(typed, typed, "a.test.ts").length, 0);
  });

  test("a spec's base is judged as the spec it was", () => {
    const skip = m("test.", 'skip(isCI, "r");\n');
    assert.deepEqual(rules(skip, "a.spec.ts", `${PLAYWRIGHT_IMPORT}${skip}`), ["skip"]);
  });
});

describe("what is printed", () => {
  test("the marker's line and the unit's lines as written", () => {
    const head = m("run();\ntest\n  .", "skip(", BODY.replace("\n", "\r\n"));
    assert.deepEqual(findAddedMarkers(null, head, "a.test.ts"), [
      {
        line: 3,
        rule: "skip",
        lines: ["test", m("  .", 'skip("t", () => {'), "  run();", "});"],
      },
    ]);
  });

  const long = (marker: number) =>
    Array.from({ length: 9 }, (_, index) =>
      index === marker ? m("  test.", "only(1),") : `  x${index},`,
    );

  test("a unit over 6 lines, its marker in the middle", () => {
    const lines = long(4);
    const [marker] = findAddedMarkers(null, `f(\n${lines.join("\n")}\n);\n`, "a.test.ts");
    assert.deepEqual(marker?.lines, ["f(", "  …", lines[4], lines[5], lines[6], "  …"]);
    assert.equal(marker?.line, 6);
  });

  test("a unit over 6 lines, its marker on the first line", () => {
    const source = m("test.", "only(1, [\n", "  1,\n".repeat(8), "]);\n");
    const [marker] = findAddedMarkers(null, source, "a.test.ts");
    assert.deepEqual(marker?.lines, [m("test.", "only(1, ["), "  1,", "  1,", "  …"]);
  });

  test("a unit over 6 lines, its marker on the second line", () => {
    const lines = long(0);
    const [marker] = findAddedMarkers(null, `f(\n${lines.join("\n")}\n);\n`, "a.test.ts");
    assert.deepEqual(marker?.lines, ["f(", lines[0], lines[1], lines[2], "  …"]);
  });

  test("a unit over 6 lines, its marker near the end", () => {
    const lines = long(8);
    const [marker] = findAddedMarkers(null, `f(\n${lines.join("\n")}\n);\n`, "a.test.ts");
    assert.deepEqual(marker?.lines, ["f(", "  …", lines[8], ");"]);
  });

  test("a unit of 7 lines is shortened", () => {
    const source = m("test.", "only(\n  1,\n  2,\n  3,\n  4,\n  5,\n);\n");
    const [marker] = findAddedMarkers(null, source, "a.test.ts");
    assert.deepEqual(marker?.lines, [m("test.", "only("), "  1,", "  2,", "  \u2026"]);
  });

  test("a unit of exactly 6 lines is printed whole", () => {
    const source = m("test.", "only(\n  1,\n  2,\n  3,\n  4,\n);\n");
    const [marker] = findAddedMarkers(null, source, "a.test.ts");
    assert.equal(marker?.lines.length, 6);
  });

  test("the last line of a file with no newline", () => {
    const [marker] = findAddedMarkers(null, m("x();\ntest.", "only(1)"), "a.test.ts");
    assert.deepEqual(marker?.lines, [m("test.", "only(1)")]);
    assert.equal(marker?.line, 2);
  });

  test("two markers on one line of one unit are listed once", () => {
    assert.deepEqual(rules(m("test.", "only.", "skip(", BODY)), ["focus"]);
    assert.deepEqual(rules(m("test.", "only(1); test.", "only(2);\n")), ["focus"]);
    assert.deepEqual(rules(m("test.", "only(1);\ntest.", "only(1);\n")), ["focus", "focus"]);
  });

  test("a marker in a class body is listed with the class", () => {
    const source = m("class A {\n  o = { ", "skip: true };\n}\n");
    assert.deepEqual(findAddedMarkers(null, source, "a.test.ts")[0]?.lines, [
      "class A {",
      m("  o = { ", "skip: true };"),
      "}",
    ]);
  });
});

describe("parsing", () => {
  test("a head file that does not parse is a ParseFailure naming the position", () => {
    assert.throws(
      () => findAddedMarkers(null, 'test("t", () => {\n', "a.test.ts"),
      (error: unknown) => error instanceof ParseFailure && /\(2:0\)/.test(error.message),
    );
  });

  const focus = m("test.", "only(1);\n");
  const files: Array<[string, string, boolean]> = [
    ["TypeScript casts in .ts", `const a = <string>b;\n${focus}`, true],
    ["TypeScript casts are JSX in .tsx", `const a = <string>b;\n${focus}`, false],
    ["JSX in .tsx", `const a = <div />;\n${focus}`, true],
    ["JSX in .js", `const a = <div />;\n${focus}`, true],
    ["types in .js", `const a: number = 1;\n${focus}`, false],
    ["with in .cjs", `with (o) {\n  ${focus}}\n`, true],
    ["with in .mjs", `with (o) {\n  ${focus}}\n`, false],
    ["with in a .js script", `with (o) {\n  ${focus}}\n`, true],
    ["with in a .js module", `import x from "x";\nwith (o) {\n  ${focus}}\n`, false],
    ["top-level await in .cjs", `await setup();\n${focus}`, true],
    ["top-level return", `if (x) return;\n${focus}`, true],
    ["new.target outside a function", `const t = new.target;\n${focus}`, true],
    ["an undeclared export", `export { missing };\n${focus}`, true],
    ["super outside a method", `const s = super.x;\n${focus}`, true],
    [
      "parameter decorators in .ts",
      `@Injectable()\nclass A {\n  constructor(@Inject(X) x: X) {}\n}\n${focus}`,
      true,
    ],
    ["decorators in .tsx", `@Component()\nclass A {\n  @Input() x = 1;\n}\n${focus}`, true],
    ["an auto-accessor in .ts", `class A {\n  accessor x = 1;\n}\n${focus}`, true],
    ["an auto-accessor in .tsx", `class A {\n  accessor x = 1;\n}\n${focus}`, true],
  ];
  const extension: Record<string, string> = {
    ".ts": "a.test.ts",
    ".tsx": "a.test.tsx",
    ".js": "a.test.js",
    ".cjs": "a.test.cjs",
    ".mjs": "a.test.mjs",
  };
  for (const [label, source, parses] of files) {
    test(`${parses ? "parses" : "refuses to parse"} ${label}`, () => {
      const ext = /\.(tsx|ts|cjs|mjs|js)\b/.exec(label)?.[0] ?? ".js";
      const file = extension[ext] ?? "a.test.js";
      if (parses) assert.deepEqual(rules(source, file), ["focus"]);
      else assert.throws(() => rules(source, file), ParseFailure);
    });
  }
});

describe("this file", () => {
  test("holds no marker as code", () => {
    const self = readFileSync(import.meta.filename, "utf8");
    assert.deepEqual(rules(self, "check-test-markers.test.ts"), []);
  });
});

// The checker as gate 2 runs it: a `git diff --raw -z --no-abbrev` list, blobs read from git.
describe("the command line", () => {
  let dir = "";
  // No GIT_* variable reaches git or the checker: under a hook (GIT_DIR, GIT_INDEX_FILE) they
  // would read the hook's repository instead of the test's.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });

  function git(...args: string[]): string {
    const res = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout;
  }

  function commit(files: Record<string, string | null>): void {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) rmSync(path.join(dir, name), { force: true });
      else writeFileSync(path.join(dir, name), content);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
  }

  function check(list?: string) {
    const listFile = path.join(dir, ".list");
    if (list === undefined) {
      const raw = spawnSync(
        "git",
        ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "base...HEAD"],
        { cwd: dir, env },
      );
      writeFileSync(listFile, raw.stdout);
    } else {
      writeFileSync(listFile, list);
    }
    const res = spawnSync("node", [CHECKER, listFile], { cwd: dir, env, encoding: "utf8" });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "check-test-markers-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "markers-test@example.com");
    git("config", "user.name", "Markers Test");
    commit({ "base.test.ts": m("test.", 'skip("legacy", () => {\n  a();\n});\n') });
    git("branch", "base");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("exits 0 and prints nothing when nothing is refused", () => {
    commit({ "base.test.ts": m("test.", 'skip("legacy", () => {\n  b();\n});\nrun();\n') });
    assert.deepEqual(check(), { status: 0, stdout: "", stderr: "" });
  });

  test("exits 3 and lists each refused marker under its path and line", () => {
    commit({ "a b.test.ts": m("x();\ntest.", "only(1);\n"), "c.spec.js": m("f", "it(1);\n") });
    const { status, stdout } = check();
    assert.equal(status, 3);
    assert.equal(stdout, m("a b.test.ts:2:\ntest.", "only(1);\nc.spec.js:1:\nf", "it(1);\n"));
  });

  test("compares a renamed file with its old content", () => {
    git("mv", "base.test.ts", "moved.test.ts");
    commit({});
    assert.equal(check().status, 0);
  });

  test("judges a file turned from a symlink into a regular file as all new", () => {
    // The link's target reads as the same marker, so only a base read from the link would pass.
    symlinkSync(m("test.", "only(1)"), path.join(dir, "link.test.ts"));
    commit({});
    git("branch", "-f", "base", "HEAD");
    rmSync(path.join(dir, "link.test.ts"));
    commit({ "link.test.ts": m("test.", "only(1)") });
    assert.equal(check().status, 3);
  });

  test("leaves deleted files, symlinks, pytest and shell files alone", () => {
    symlinkSync("base.test.ts", path.join(dir, "link.test.ts"));
    commit({
      "base.test.ts": null,
      "test_a.py": m("@pytest.mark.", "skip\n"),
      "a.test.sh": m("test.", "only(1)\n"),
    });
    assert.equal(check().status, 0);
  });

  test("prints a path that is not valid UTF-8 as git gave it", () => {
    const name = Buffer.concat([Buffer.from("x"), Buffer.from([0xff]), Buffer.from(".test.ts")]);
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), name]), m("test.", "only(1);\n"));
    commit({});
    const listFile = path.join(dir, ".list");
    const raw = spawnSync("git", ["diff", "--raw", "-z", "--no-abbrev", "base...HEAD"], {
      cwd: dir,
      env,
    });
    writeFileSync(listFile, raw.stdout);
    const res = spawnSync("node", [CHECKER, listFile], { cwd: dir, env });
    assert.equal(res.status, 3);
    assert.ok(res.stdout.subarray(0, name.length).equals(name), res.stdout.toString("latin1"));
  });

  test("exits 2 naming the file when a head file does not parse", () => {
    commit({ "bad.test.ts": 'test("t", () => {\n' });
    const { status, stderr } = check();
    assert.equal(status, 2);
    assert.match(stderr, /^ERROR: gate 2 cannot parse bad\.test\.ts: .*\(2:0\)\n$/);
  });

  test("exits 2 when a blob cannot be read", () => {
    const sha = "0".repeat(40);
    const { status, stderr } = check(`:000000 100644 ${sha} ${"1".repeat(40)} A\0x.test.ts\0`);
    assert.equal(status, 2);
    assert.match(stderr, new RegExp(`git cat-file blob ${"1".repeat(40)} failed \\(exit 128\\)`));
  });

  test("exits 2 on a list it cannot read", () => {
    assert.equal(check("garbage\0").status, 2);
    assert.match(check("garbage\0").stderr, /unexpected diff entry/);
    assert.match(check(":100644 100644 a b M\0x.test.ts").stderr, /does not end with a NUL/);
    assert.match(check(":100644 100644 a b R100\0x.test.ts\0").stderr, /ends inside an entry/);
  });

  test("exits 2 with its usage when the list is not one argument", () => {
    for (const args of [[], ["a", "b"]]) {
      const res = spawnSync("node", [CHECKER, ...args], { env, encoding: "utf8" });
      assert.equal(res.status, 2);
      assert.equal(res.stderr, "usage: node bin/check-test-markers.ts <git diff --raw -z list>\n");
    }
  });

  test("exits 2 when the @babel/parser it finds is not version 8", () => {
    commit({ "a.test.ts": "run();\n" });
    // A copy of the checker beside a node_modules holding version 7's package.json only, so the
    // check stops at the version, and no NODE_PATH to find another.
    const copy = path.join(dir, "kit");
    const parser = path.join(copy, "node_modules", "@babel", "parser");
    mkdirSync(parser, { recursive: true });
    writeFileSync(path.join(copy, "check-test-markers.ts"), readFileSync(CHECKER));
    writeFileSync(
      path.join(parser, "package.json"),
      '{ "version": "7.29.8", "main": "index.js" }\n',
    );
    writeFileSync(
      path.join(parser, "index.js"),
      "exports.parse = () => ({ program: { body: [] } });\n",
    );
    const { NODE_PATH: _nodePath, ...bare } = env;
    const raw = spawnSync("git", ["diff", "--raw", "-z", "--no-abbrev", "base...HEAD"], {
      cwd: dir,
      env,
    });
    writeFileSync(path.join(dir, ".list"), raw.stdout);
    const res = spawnSync("node", [path.join(copy, "check-test-markers.ts"), ".list"], {
      cwd: dir,
      env: bare,
      encoding: "utf8",
    });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /needs @babel\/parser 8 .*, not 7\.29\.8/);
  });

  test("runs as the entry point through a symlink, also under --preserve-symlinks-main", () => {
    const link = path.join(dir, "linked-check.ts");
    symlinkSync(CHECKER, link);
    for (const flags of [[], ["--preserve-symlinks-main"]]) {
      const res = spawnSync("node", [...flags, link, path.join(dir, "missing")], { env });
      assert.equal(res.status, 2, `${flags.join(" ")}: ${res.stderr}`);
    }
  });

  test("exits 0 on an empty list", () => {
    assert.deepEqual(check(""), { status: 0, stdout: "", stderr: "" });
  });
});
