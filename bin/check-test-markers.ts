// check-test-markers.ts — gate 2 of check-test-integrity.sh for JavaScript and TypeScript test
// files: the diff must not ADD a focus or skip marker. It needs the `@babel/parser`
// devDependency. The comments here are the ground truth for gate 2's rules;
// check-test-integrity.sh holds gate 1.
//
// Usage (check-test-integrity.sh runs it; nothing else should):
//   node bin/check-test-markers.ts <list>
// where <list> is the output of `git diff --raw -z --no-abbrev <base> HEAD` over the JavaScript
// and TypeScript test files. Exit 0: nothing refused. Exit 3: markers refused, listed on stdout.
// Any other status (2 here, 1 for an uncaught exception) means the check could not judge, and the
// shell gate fails closed.
//
// Why a parser: the shell gate read added lines with regexes and joined wrapped calls itself,
// and every defect it had was a lexing case (a block comment between a receiver and its `.skip`,
// a regex literal holding `/*`, two lines glued into one token, a call inside a condition, a
// window that never closed). Babel reads each file whole, so a call is the call it is however
// the formatter wrapped it and whatever comments sit inside it. typescript's own API is no
// option: TypeScript 7 (the Go port) ships no JavaScript parser API (measured 2026-10-23,
// typescript 7.0.2: `createSourceFile` is undefined).
//
// Which files: each entry of the list with status A, M, R or T whose new path ends in .ts, .tsx,
// .js, .mjs or .cjs and whose new mode is a regular file. The head side is the new blob, the base
// side the old blob (a rename compares with the old path's content; a copy is not detected, so a
// copied file is all new). A head file that does not parse is "cannot judge" (exit 2: it would
// not run either; TypeScript's decorators parse as `experimentalDecorators` writes them); a base
// file that does not parse holds no markers, so every head marker counts as new (the strict side).
//
// Which markers are new: each marker's key is its rule and name, the source text of its unit (the
// nearest enclosing statement, or the import declaration) with the body of every function inside
// that unit that does not hold the marker replaced by a fixed placeholder (but a function in the
// marker's own condition: its key's value, or the first argument of its call), the marker's
// position in that text marked, the text of each statement around the unit with every function body
// in it replaced the same way (the test and describe calls holding it, with their titles), and
// every run of whitespace read as one space. Head markers are matched against the base file's keys
// as a multiset, in document order; an unmatched one is refused. So a marker left as it was is
// allowed wherever it moves among its siblings, editing a test body, adding a blank line or
// re-indenting leaves a legacy skip alone, a `this.skip();` moved into another test, any other edit
// inside the unit (a comment, an argument, the condition) or a renamed test or describe around it
// makes the marker new, and a second identical marker is new.
//
// Vocabulary. ROOTS are the test receivers: test, describe, it, suite, context, specify and
// Jest/Vitest's concurrent. A chain is ROOTED when, walking down the object side of the member
// access, through member accesses, TypeScript wrappers (`!`, `as`, `satisfies`, `<T>x`, `f<T>`),
// parentheses and calls of a LINK (skipIf, runIf, extend, info: they return a test object, and
// their arguments may hold anything: `test.runIf(f(x)).skip(`), one reaches a ROOT identifier, or
// a ROOT read off a name (`nt.test`, `globalThis.it`: a namespace import, a global). A
// call of any other name ends the chain (`t.context.db.collection("u").find({}).skip(10)` is a
// database cursor, not a test). A member access is CALLED when, walking up through member
// accesses whose object it is, TypeScript wrappers, parentheses and the last operand of a comma
// expression, one reaches a call (optional or not), a `new` or a tagged template whose callee or
// tag it is: so `test.only.each(...)(...)`, `(0, test.only)(`, `new test.only(`,
// `test.only?.(`, `test.only<T>(`, `test!.only(`, `test.only!(` and `test.only.each\`...\`` are
// called, and `opts.only != x` is data. A member's name is read as the engine reads it: an
// escaped identifier (`test.only`) and a computed string or no-substitution template key
// (`test["only"]`, `test[\`only\`]`, escapes decoded) are the name they spell.
//
// Refused when head adds it:
//   1. `.only`, `.fixme` and node:test's `.expectFailure` called on ANY receiver
//      (`suite.only(`, `test.describe.serial.only(`, `it.expectFailure(`): none of them ever
//      scopes a test. node:test's `test.expectFailure(` passes the run while its body throws
//      (measured, node 24.18).
//   2. The x- and f-prefixed markers (fit, xit, xtest, xcontext, xspecify, fdescribe, xdescribe)
//      and a bare `expectFailure` called, directly or through a chain whose every member is a test
//      modifier (`.each`, `.for`, `.only`, `.skip`, `.failing`, `.concurrent`, ...), `call`,
//      `apply` or `bind`, or a computed key that is no literal (`xit.each(...)(`, `fit!(`,
//      `fit?.(`, `fit["each"](`, `fit.call(`, `fit[mode](`), so a variable so named is data
//      (`const problems = fit.outsideCircle.map(`); and all but `fit` also as a member of a name
//      (`jg.xit(`, a namespace import). A method of that name on any other object is no marker,
//      and `.fit` on a name is none either (`model.fit(X, y)`). A bare `expectFailure(` is refused
//      whatever it was imported from or declared as: a helper of that name reads as node:test's
//      expected failure.
//   3. `.skip`, `.fail`, `.fails` and `.failing` called on a ROOTED chain, the chain after them
//      included (`test.skip.each(`, `test.sequential.skip(`, Playwright's `test.step.skip(` and
//      `test.describe.skip(`, `test.extend({}).skip(`). Jest's `.failing(` and Vitest's
//      `.fails(` invert the verdict; Playwright's `test.fail(` runs the test and passes the run
//      only while it fails (pytest's xfail), so it takes `test.skip(`'s rules. In Jest, Vitest,
//      Mocha/Cypress and node:test the first argument of `test.skip` is the title, so every such
//      call is refused there; their conditional idioms are `const itX = cond ? it : it.skip;`,
//      Vitest's `test.skipIf(cond)` and node:test's `{ skip: !process.env.X }`. ONLY in a
//      Playwright spec (below) is the canonical `test.skip(<condition>, ...)` /
//      `test.fail(<condition>, ...)` allowed: the callee is a plain member access (`.skip` or
//      `["skip"]`, not optional) on the bare identifier `test`, with no wrapper, no type
//      arguments and no optional call anywhere; the first argument is a CONDITION (below); and no
//      later argument is a function (`test.skip(title, () => {})` declares a skipped test).
//      Everything else is refused there too: `test.skip()`, `test.skip("title", fn)`,
//      `test.skip(true, r)`, `test.skip?.(isCI, r)`, `test.skip!(isCI, r)`,
//      `test?.["skip"](isCI, r)`, `test.info().skip(isCI, r)`, `test.describe.skip(...)`.
//   4. A bare `.skip()` or `.todo()` with no argument on any receiver (`this.skip()` in a
//      mocha-style body, node:test's `t.todo()`): a failure after it no longer fails the run
//      (measured, node 24.18). `t.skip("reason")` and `t.todo("later")` stay allowed: a runtime
//      call, usually under an `if`.
//   5. `.todo` on a ROOTED chain holding anything but one name: allowed only when called directly
//      with exactly one argument that is a string, or a template whose substitutions are each a
//      name or a member path of names, and nothing chained after it. node:test runs a todo's body
//      and ignores its failure (measured, node 24.18: a throwing body exits 0), so
//      `test.todo("t", fn)` is a skip; `test.todo(title)`, `test.todo.each(` and
//      `` test.todo(`a ${f()}`) `` are refused; `test.todo("planned")` is planning.
//   6. Vitest's `skipIf(x)` / `runIf(x)` on a ROOTED chain with a constant argument (see the
//      condition rules): `skipIf` is refused when x always skips or is a literal in a spelling
//      that is no plain literal; `runIf` when x is absent, never runs, or is such a spelling.
//   7. Playwright's fixture `testInfo.skip(x, ...)` / `testInfo.fail(x, ...)` (receiver named
//      `testInfo`, in any file) whose first argument is not a CONDITION or is a function (the
//      fixture takes a condition, not a callback), and a bare `testInfo.fail()`.
//   8. node:test's and Vitest's options object of a test call: the first or second argument of a
//      call of test, it, describe, suite, context or specify (bare, or as a member: `t.test(`,
//      `test?.(`), behind any wrapper, also an object literal spread into it
//      (`{ ...{ skip: 1 } }`). A `skip`, `only`, `todo`, `fails` or `expectFailure` key (any
//      spelling an object allows: quoted, computed, a no-substitution template) is refused when it
//      is a method or accessor (`todo() {}`, `get skip() {...}`), when its value is not an OPTION
//      CONDITION (below), and for `expectFailure` when its value is an error class (a name or
//      member path whose last name is `Error`, `Exception` or a capitalised name ending in either:
//      node:test's validator, as assert.throws takes it). PLACEHOLDER exemption: a `skip` key
//      written as a plain property (never a method or accessor) is allowed when the options
//      object is the call's second-to-last argument and the last is an EMPTY function with no
//      parameters, the env-gated placeholder
//        test("... (set DATABASE_URL to run)", { skip: true }, () => {});
//      a skipped empty test silences nothing. Never `only` (an empty test focused under
//      `--test-only` silences every test beside it, measured, node 24.18), `todo` (a planned test
//      is `test.todo("name")`), `fails` or `expectFailure` (an empty test marked to fail fails
//      the run).
//   9. The same keys in ANY other object literal (data, or a variable later passed as options),
//      judged by how the value starts (L, its leftmost operand: the left side of a binary or
//      logical expression, the test of a conditional, the first of a sequence), kept narrow so
//      pagination and fixtures stay allowed (`skip` is Prisma's pagination key): `skip` / `only`
//      refused when L is `true` or a string; `fails` when L is `true` (test data has string-typed
//      `fails:` fields); `todo` / `expectFailure` (no pagination keys; Biome puts a long call's
//      options on lines of their own) when L, after any run of `!`, `~`, `+`, `-` and parentheses,
//      is `true`, a string, a number, Infinity or a function, or is any literal behind at least one
//      of that run, or the whole value is an array or object literal, and always as a method or
//      accessor (`{ todo() {} }`: a function, which node:test reads as true); `expectFailure` also
//      when the whole value is a regex literal or an error class; and every key but `fails` when
//      the whole value is `null` or `NaN` (node:test skips and todos for both, measured, node
//      24.18). `{ skip: 10 }`, `{ skip: -1 }`, `todo: false`, `{ skip: null ?? x }`, `fails: null`
//      and `fails: "no hook"` stay allowed.
//  10. Playwright's `annotation` key, in any object literal of any file, whose value is an object
//      with a `type` of "skip", "fixme" or "fail", or an array holding one: skip and fixme set the
//      test's expected status to skipped and fail inverts its verdict (measured, Playwright
//      1.64.0). `type: "issue"`, the reporter's plural `annotations:` and a reducer action
//      `{ type: "skip" }` stay allowed.
//  11. A marker's name bound from node:test: `only`, `fixme`, `expectFailure`, `skip`, `fail`,
//      `fails`, `failing` or `todo` imported by name from `node:test` (an import, renamed or not,
//      that is not `import type`; or `const { skip } = require("node:test")` /
//      `await import("node:test")`). node:test exports `expectFailure`, `skip`, `only` and `todo`
//      as functions (measured, node 24.18: an imported `skip("t", fn)` or `todo("t", fn)` whose
//      body throws exits 0), and a call of such a binding, under its own name or another, is no
//      member call rules 1 to 5 see (nor, renamed, a bare `expectFailure(`, rule 2), so the binding
//      itself is refused, `todo` too: a planned test is `test.todo("name")` (rule 5). Only the
//      `node:` spelling names the builtin. Likewise a destructure (`const`, `let` or `var`,
//      renamed or not) of those names from a test function: a ROOTED chain whose last step is a
//      ROOT, a test modifier (rule 2's list), a computed key that is no literal or a LINK call
//      (`const { skip } = test`, `const { only: o } = describe`, `const { skip } = test.describe`,
//      `= nt.test`, `= test[kind]`, `= test.extend({})`). A destructure of anything else is data
//      (`const { skip } = query`, `const { skip, take } = context.args`); a ROOT read off a name
//      counts (`const { skip } = req.context` is refused: the strict side), and so does a
//      destructure whose call rule 3 would allow in a Playwright spec (`skip(isCI, "r")`).
//
// A PLAYWRIGHT SPEC is a file whose head imports `@playwright/test` itself at the top level: an
// import that is not type-only and binds at least one value, or a `require("@playwright/test")`.
// A spec importing `test` through a fixtures module is not one, and so gets no exemption (fail
// closed).
//
// The condition rules. A constant folder walks the argument's syntax (it never evaluates code)
// and gives a known primitive, an object (an object, array or regex literal, a function, a class,
// a `new`; always truthy), or unknown. Literals, `undefined`, `NaN`, `Infinity` (shadowing
// ignored: the strict side), `void x` and a no-substitution template are known; `typeof x` and a
// template with text are known non-empty strings; `!`, `-`, `+` and `~` compute their result;
// `&&`, `||` and `??` short-circuit on a known left side, and `x || y` with an always truthy y
// is always truthy; a conditional with a known test takes its branch; a comma expression is its
// last operand, an assignment its right side, `await` its operand; a comparison of two known
// values is computed; an immediately invoked function is a function. Everything else (a name, a
// member access, a call) is unknown. A PLAIN literal is one written as itself: a literal,
// `undefined`, `NaN`, `Infinity`, `void x`, a bare regex, array, object or function, or a number,
// `true`, `false`, `null`, `undefined`, `NaN` or `Infinity` behind a run of `+` / `-` only, each
// optionally cast (`false as boolean`); anything behind `!`, `~` or parentheses, a comma
// expression and a signed string are not.
//   - skipIf(x): allowed with no argument (never skips), a plain literal that is falsy
//     (`skipIf(false)`, `skipIf(0x0)`, `skipIf(void 0)`, `skipIf(-false)`), and anything unknown
//     (`skipIf(isCI)`, `skipIf(!0 && isCI)`, `skipIf(["linux"].includes(p))`).
//   - runIf(x): allowed with a plain literal that is truthy or a plain object (`runIf(true)`,
//     `runIf(1e3)`, `runIf(/x/)`, `runIf(() => x)`) and anything unknown.
//   - A CONDITION (Playwright's `test.skip` / `test.fail` and `testInfo.skip` / `testInfo.fail`
//     first argument) is present, unknown, and reads a name: an expression with no name in it
//     (but `undefined`, `NaN` and `Infinity`; a member's or a key's own name does not count) and
//     no `this` has one value on every run however it is spelled, so `1 + 1`, `1 == 1`,
//     `[].length` and `"a".includes("a")` are no condition. For `test.skip` / `test.fail` a
//     function is Playwright's fixture callback, a condition when every value it returns is one
//     (`({ browserName }) => browserName === "webkit"`; `() => true`, `() => !0`, `() => 1 + 1`
//     and a block body with no `return` are not).
//   - An OPTION CONDITION (rule 8) is false, undefined or unknown: node:test skips for every
//     other value (measured, node 24.18: `0`, `""`, `null`, `NaN` and `{}` skip). Also refused,
//     although the folder cannot know them: a value that is a unary `-`, `+` or `~` of anything
//     (a number, never false: `-offset`, `~x.indexOf(y)`), a `typeof`, a `new`, an `await` of a
//     literal, and a value whose leftmost operand (as in rule 9) is `true`, a string, a number or
//     Infinity, or any literal or function behind at least one `!`, `~`, `+`, `-` or parenthesis
//     (`~0 || isCI`, `!~{}`). `{ skip: !process.env.X }`, `null ?? isCI`, `-offset < 0`,
//     `typeof Bun === "undefined"`, `await isFlaky()` and `/^win/.test(p)` stay allowed.
//
// Output, per refused marker in file order: `<path>:<line>:` (the path as git gave it, the line
// of the marker itself), then the unit's lines as written: all of them when it spans at most 6
// lines, else its first line, `  …`, the marker's line and the two after it, and `  …` when it
// goes on.
//
// Accepted residuals: a marker reached through an alias (`const s = test.skip; s("x", fn)`,
// `const focus = test.only`), a test function or node:test's module under a name that is no ROOT
// (`import * as nt from "node:test"; nt.skip(`, `import tst from "node:test"; tst.skip(`,
// `import { test as t } from "node:test"; const { skip } = t`,
// `const { skip } = require("node:test").test`), a destructure that is no variable declaration
// (a parameter `({ skip }) =>`, an assignment `({ skip } = test)`) or is nested
// (`const { test: { skip } } = require("node:test")`), a test function's member this check does
// not list (`const { only } = test.describe.serial`), a marker re-exported through a local
// module (`export { skip } from "node:test"` in a helper the test imports), node:test loaded
// other than by `import`, `require(` or `import(` (`process.getBuiltinModule("node:test")`,
// `module.require(`, `createRequire(import.meta.url)("node:test")`), a condition that is
// always true but that the folder cannot see (`test.skip(isCI === isCI, r)`), a skipped test
// whose body is passed by name (`test.skip(title, body)`, which reads like
// `test.skip(cond, REASON)`), Playwright's fixture under a name other than `testInfo`, an options
// object on a call this check does not take for a test call (`test.concurrent(`,
// `test.sequential(`), and an option value that is no constant but never false
// (`{ skip: offset - 1 }`, `{ skip: isCI ? "r" : null }`). AGENTS.md forbids them all the same.
//
// The check never runs the code it reads: the folder walks literal nodes only, git runs with an
// argument array (blob ids, never a shell string), and every error fails closed.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as BabelParser from "@babel/parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  FunctionExpression,
  ImportDeclaration,
  MemberExpression,
  Node,
  ObjectExpression,
  OptionalCallExpression,
  OptionalMemberExpression,
  Program,
  VariableDeclarator,
} from "@babel/types";

const ROOTS = new Set(["test", "describe", "it", "suite", "context", "specify", "concurrent"]);
const LINKS = new Set(["skipIf", "runIf", "extend", "info"]);
const PREFIXED = new Set([
  "fit",
  "xit",
  "xtest",
  "xcontext",
  "xspecify",
  "fdescribe",
  "xdescribe",
  "expectFailure",
]);
const TEST_CALLS = new Set(["test", "it", "describe", "suite", "context", "specify"]);
const ANY_RECEIVER = new Set(["only", "fixme", "expectFailure"]);
const ROOTED_SKIPS = new Set(["skip", "fail", "fails", "failing"]);
const BINDING_MARKERS = new Set([...ANY_RECEIVER, ...ROOTED_SKIPS, "todo"]);
// The members a test function is chained or invoked through: Jest's, Vitest's and node:test's
// modifiers (`.each`, `.for`, `.only`, `.skip`, `.failing`, ...) and Function.prototype's `call`,
// `apply` and `bind`, which call the function itself. Rule 2 accepts only these between a bare
// prefixed name and its call.
const MODIFIERS = new Set([
  ...ANY_RECEIVER,
  ...ROOTED_SKIPS,
  "each",
  "for",
  "todo",
  "concurrent",
  "sequential",
  "call",
  "apply",
  "bind",
]);
const OPTION_KEYS = new Set(["skip", "only", "todo", "fails", "expectFailure"]);
const PLACEHOLDER_KEYS = new Set(["skip"]);
const ANNOTATION_TYPES = new Set(["skip", "fixme", "fail"]);
const ERROR_CLASS = /^(?:[A-Z][A-Za-z0-9_$]*)?(?:Error|Exception)$/;
const SIGN_RUN = new Set(["!", "~", "+", "-"]);
const COMPARISONS = new Set(["===", "!==", "<", ">", "<=", ">="]);
const NOT_CHILDREN = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
  "errors",
]);
const REGULAR_FILE = new Set(["100644", "100755"]);
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
// What a function body not holding the marker reads as in a unit's key.
const ELIDED = "{…}";

/** A marker head adds and base does not have, ready to print. */
export interface Marker {
  /** The 1-based line of the marker itself. */
  line: number;
  /** Which rule refused it (focus, prefixed, skip, bare, todo, skipIf, runIf, testInfo, option,
   * data, annotation, import, destructure). */
  rule: string;
  /** The unit's lines as written, shortened past 6 lines (see the header). */
  lines: string[];
}

/** A head file that does not parse: gate 2 cannot judge it. */
export class ParseFailure extends Error {}

type Primitive = string | number | bigint | boolean | null | undefined;
// exact: the value itself is known (not only its truthiness, as for `typeof x`). plain: written
// as a literal (see the header). signable: a `+` / `-` run in front of it keeps it plain.
type Fold =
  | { kind: "unknown" }
  | { kind: "value"; value: Primitive; exact: boolean; plain: boolean; signable: boolean }
  | { kind: "object"; plain: boolean; text: string | null };

const UNKNOWN: Fold = { kind: "unknown" };
// A value known to be truthy whose value itself is not known (`typeof x`, `` `a${x}` ``,
// `x || true`).
const TRUTHY: Fold = { kind: "value", value: "?", exact: false, plain: false, signable: false };

type Call = CallExpression | OptionalCallExpression;
type Member = MemberExpression | OptionalMemberExpression;

interface Found {
  anchor: Node;
  rule: string;
  name: string;
}

interface Analysis {
  text: string;
  lineStarts: number[];
  parents: Map<Node, Node>;
  found: Found[];
}

function startOf(node: Node): number {
  return node.start ?? 0;
}

function endOf(node: Node): number {
  return node.end ?? startOf(node);
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function childrenOf(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_CHILDREN.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function isMember(node: Node): node is Member {
  return node.type === "MemberExpression" || node.type === "OptionalMemberExpression";
}

function isCall(node: Node): node is Call {
  return node.type === "CallExpression" || node.type === "OptionalCallExpression";
}

function isFunction(node: Node): node is ArrowFunctionExpression | FunctionExpression {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
}

/** The node a wrapper holds (parentheses, `x!`, `x as T`, `x satisfies T`, `<T>x`, `f<T>`), or
 * null when the node is no wrapper. */
function wrapped(node: Node): Node | null {
  switch (node.type) {
    case "ParenthesizedExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSInstantiationExpression":
      return node.expression;
    default:
      return null;
  }
}

/** A node with every wrapper around it stepped through. */
function unwrapAll(node: Node): Node {
  let cur = node;
  for (let inner = wrapped(cur); inner !== null; inner = wrapped(cur)) cur = inner;
  return cur;
}

/** The text a literal key spells: a string or a template with no substitution. */
function literalKey(node: Node): string | null {
  if (node.type === "StringLiteral") return node.value;
  if (node.type !== "TemplateLiteral" || node.expressions.length > 0) return null;
  return node.quasis[0]?.value.cooked ?? null;
}

/** The name a member access reads: `.name`, `["name"]` or `[\`name\`]`, or null. */
function memberName(node: Member): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return literalKey(unwrapAll(node.property));
}

/** The name an object property's or a pattern property's key spells, or null. */
function keyName(node: Node): string | null {
  if (node.type !== "ObjectProperty" && node.type !== "ObjectMethod") return null;
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  return literalKey(unwrapAll(node.key));
}

/** Whether a member access (or a name) is called, through the chain after it (see the header). A
 * tagged template's only child that can be such a chain is its tag. With `members`, the chain
 * passes only member accesses whose name is in it or is unknown (a computed key that is no
 * literal: the strict side); any other member ends the walk, not called (rule 2). */
function isCalled(node: Node, parents: Map<Node, Node>, members?: ReadonlySet<string>): boolean {
  let cur = node;
  for (let parent = parents.get(cur); parent !== undefined; parent = parents.get(cur)) {
    const name = isMember(parent) ? memberName(parent) : null;
    const passes =
      wrapped(parent) === cur ||
      (isMember(parent) &&
        parent.object === cur &&
        (members === undefined || name === null || members.has(name))) ||
      (parent.type === "SequenceExpression" && parent.expressions.at(-1) === cur);
    if (!passes) {
      if (isCall(parent) || parent.type === "NewExpression") return parent.callee === cur;
      return parent.type === "TaggedTemplateExpression";
    }
    cur = parent;
  }
  return false;
}

/** Whether an expression is a chain rooted at a test receiver (see the header). */
function isRooted(node: Node): boolean {
  let cur = unwrapAll(node);
  for (;;) {
    if (cur.type === "Identifier") return ROOTS.has(cur.name);
    if (isMember(cur)) {
      const object = unwrapAll(cur.object);
      // A receiver read off a name: a namespace import or a global (`nt.test`, `globalThis.it`).
      if (object.type === "Identifier" && ROOTS.has(memberName(cur) ?? "")) return true;
      cur = object;
      continue;
    }
    const callee = isCall(cur) ? unwrapAll(cur.callee) : null;
    if (callee === null || !isMember(callee) || !LINKS.has(memberName(callee) ?? "")) return false;
    cur = unwrapAll(callee.object);
  }
}

/** The call whose callee a node is, through wrappers, or null. */
function callOf(node: Node, parents: Map<Node, Node>): Call | null {
  let cur = node;
  let parent = parents.get(cur);
  while (parent !== undefined && wrapped(parent) === cur) {
    cur = parent;
    parent = parents.get(cur);
  }
  return parent !== undefined && isCall(parent) && parent.callee === cur ? parent : null;
}

function truthy(fold: Fold): boolean | null {
  if (fold.kind === "unknown") return null;
  if (fold.kind === "object") return true;
  return Boolean(fold.value);
}

function known(value: Primitive): Fold {
  return { kind: "value", value, exact: true, plain: false, signable: false };
}

function literal(value: Primitive, signable: boolean): Fold {
  return { kind: "value", value, exact: true, plain: true, signable };
}

function notPlain(fold: Fold): Fold {
  if (fold.kind === "value") return { ...fold, plain: false, signable: false };
  if (fold.kind === "object") return { ...fold, plain: false };
  return fold;
}

/** `!`, `-`, `+` or `~` applied to a primitive, as JavaScript does; null where it throws. */
function applyUnary(operator: string, value: Primitive): Primitive | null {
  try {
    if (operator === "!") return !value;
    if (operator === "-") return -(value as number);
    if (operator === "+") return +(value as number);
    return ~(value as number);
  } catch {
    // `+1n` throws a TypeError: no value to fold.
    return null;
  }
}

function compare(operator: string, a: Primitive, b: Primitive): boolean {
  if (operator === "===") return a === b;
  if (operator === "!==") return a !== b;
  // Mixed primitive comparisons follow JavaScript's own rules; a and b are never objects here.
  const x = a as number;
  const y = b as number;
  if (operator === "<") return x < y;
  if (operator === ">") return x > y;
  if (operator === "<=") return x <= y;
  return x >= y;
}

/** What an object literal converts to as a primitive, where that is certain, or null. */
function objectText(node: Node): string | null {
  if (node.type === "RegExpLiteral") return `/${node.pattern}/${node.flags}`;
  if (isFunction(node)) return "function";
  if (node.type === "ObjectExpression") {
    return node.properties.length === 0 ? "[object Object]" : null;
  }
  if (node.type !== "ArrayExpression") return null;
  const parts: string[] = [];
  for (const element of node.elements) {
    if (element === null || element.type === "SpreadElement") return null;
    const fold = foldValue(element);
    if (fold.kind !== "value" || !fold.exact) return null;
    parts.push(fold.value === null || fold.value === undefined ? "" : String(fold.value));
  }
  return parts.join(",");
}

function foldUnary(operator: string, operand: Fold): Fold {
  if (operand.kind === "unknown") return UNKNOWN;
  if (operand.kind === "object") {
    if (operator === "!") return known(false);
    if (operand.text === null) return UNKNOWN;
    const value = applyUnary(operator, operand.text);
    return value === null ? UNKNOWN : known(value);
  }
  if (!operand.exact && operator !== "!") return UNKNOWN;
  const value = applyUnary(operator, operand.value);
  if (value === null) return UNKNOWN;
  const sign = operator === "-" || operator === "+";
  const keeps = sign && operand.plain && operand.signable;
  return { kind: "value", value, exact: true, plain: keeps, signable: keeps };
}

/** The constant folder (see the header): a pure walk over the syntax, never an evaluation. */
function foldValue(node: Node): Fold {
  switch (node.type) {
    case "ParenthesizedExpression":
      return notPlain(foldValue(node.expression));
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSInstantiationExpression":
      return foldValue(node.expression);
    case "StringLiteral":
      return literal(node.value, false);
    case "NumericLiteral":
      return literal(node.value, true);
    case "BigIntLiteral":
      return literal(node.value, true);
    case "BooleanLiteral":
      return literal(node.value, true);
    case "NullLiteral":
      return literal(null, true);
    case "TemplateLiteral": {
      if (node.expressions.length === 0) return literal(node.quasis[0]?.value.cooked ?? "", false);
      const text = node.quasis.some((quasi) => (quasi.value.cooked ?? quasi.value.raw) !== "");
      return text ? TRUTHY : UNKNOWN;
    }
    case "Identifier":
      if (node.name === "undefined") return literal(undefined, true);
      if (node.name === "NaN") return literal(Number.NaN, true);
      if (node.name === "Infinity") return literal(Number.POSITIVE_INFINITY, true);
      return UNKNOWN;
    case "RegExpLiteral":
    case "ArrayExpression":
    case "ObjectExpression":
      return { kind: "object", plain: true, text: objectText(node) };
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return { kind: "object", plain: true, text: objectText(node) };
    case "ClassExpression":
    case "NewExpression":
      return { kind: "object", plain: false, text: null };
    case "CallExpression":
      // An immediately invoked function is read as the function (the strict side).
      return isFunction(unwrapAll(node.callee))
        ? { kind: "object", plain: false, text: null }
        : UNKNOWN;
    case "UnaryExpression":
      if (node.operator === "void") {
        return { kind: "value", value: undefined, exact: true, plain: true, signable: false };
      }
      if (node.operator === "typeof") {
        return TRUTHY;
      }
      if (node.operator === "delete") return UNKNOWN;
      return foldUnary(node.operator, foldValue(node.argument));
    case "LogicalExpression": {
      const left = foldValue(node.left);
      const isTrue = truthy(left);
      if (isTrue === null) {
        // `x || <always truthy>` is always truthy, whatever x is.
        const always = node.operator === "||" && truthy(foldValue(node.right)) === true;
        return always ? TRUTHY : UNKNOWN;
      }
      if (node.operator === "&&") return notPlain(isTrue ? foldValue(node.right) : left);
      if (node.operator === "||") return notPlain(isTrue ? left : foldValue(node.right));
      const nullish = left.kind === "value" && (left.value === null || left.value === undefined);
      return notPlain(nullish ? foldValue(node.right) : left);
    }
    case "ConditionalExpression": {
      const test = truthy(foldValue(node.test));
      if (test === null) return UNKNOWN;
      return notPlain(foldValue(test ? node.consequent : node.alternate));
    }
    case "SequenceExpression": {
      const last = node.expressions[node.expressions.length - 1];
      return last === undefined ? UNKNOWN : notPlain(foldValue(last));
    }
    case "AssignmentExpression":
      return node.operator === "=" ? notPlain(foldValue(node.right)) : UNKNOWN;
    case "AwaitExpression":
      return notPlain(foldValue(node.argument));
    case "BinaryExpression": {
      if (!COMPARISONS.has(node.operator) || node.left.type === "PrivateName") return UNKNOWN;
      const left = foldValue(node.left);
      const right = foldValue(node.right);
      if (left.kind !== "value" || right.kind !== "value" || !left.exact || !right.exact) {
        return UNKNOWN;
      }
      return known(compare(node.operator, left.value, right.value));
    }
    default:
      return UNKNOWN;
  }
}

/** The values a function returns: its concise body, or each `return` of its block body. */
function returnedValues(fn: Node): Array<Node | null> {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") return [];
  if (fn.body.type !== "BlockStatement") return [fn.body];
  const values: Array<Node | null> = [];
  const stack: Node[] = [fn.body];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "ReturnStatement") values.push(node.argument ?? null);
    for (const child of childrenOf(node)) {
      // A nested function's returns are its own.
      if (
        !isFunction(child) &&
        child.type !== "FunctionDeclaration" &&
        child.type !== "ClassBody"
      ) {
        stack.push(child);
      }
    }
  }
  return values;
}

/** Whether an expression reads no name (but undefined, NaN and Infinity), no `this` and no
 * `super`: it has one value on every run, whatever the folder makes of it. A member's or a
 * key's own name is no read, and neither is a type. */
function readsNothing(node: Node): boolean {
  const stack: Node[] = [node];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    if (cur.type === "Identifier") {
      if (cur.name !== "undefined" && cur.name !== "NaN" && cur.name !== "Infinity") return false;
    }
    if (cur.type === "ThisExpression" || cur.type === "Super") return false;
    for (const child of childrenOf(cur)) {
      if (isMember(cur) && !cur.computed && child === cur.property) continue;
      // A shorthand property's value is a node of its own, so `{ isCI }` still reads isCI.
      if (
        (cur.type === "ObjectProperty" || cur.type === "ObjectMethod") &&
        !cur.computed &&
        child === cur.key
      ) {
        continue;
      }
      if (child.type.startsWith("TS") && wrapped(child) === null) continue;
      stack.push(child);
    }
  }
  return true;
}

/** Whether a value can tell runs apart: the folder cannot know it and it reads a name. */
function variesByRun(value: Node): boolean {
  return foldValue(value).kind === "unknown" && !readsNothing(value);
}

/** Whether an argument is a CONDITION (see the header); a function counts only if allowed. */
function isCondition(argument: Node | undefined, allowFunction: boolean): boolean {
  if (argument === undefined || argument.type === "SpreadElement") return false;
  const inner = unwrapAll(argument);
  if (isFunction(inner)) {
    // A generator returns an iterator, which is always truthy.
    if (!allowFunction || inner.generator) return false;
    const values = returnedValues(inner);
    return values.length > 0 && values.every((value) => value !== null && variesByRun(value));
  }
  return variesByRun(argument);
}

/** Rule 6: whether `skipIf(argument)` always skips or is spelled as no plain literal. */
function constantSkipIf(argument: Node | undefined): boolean {
  if (argument === undefined || argument.type === "SpreadElement") return false;
  const fold = foldValue(argument);
  if (fold.kind === "unknown") return false;
  if (fold.kind === "object" || !fold.plain) return true;
  return Boolean(fold.value);
}

/** Rule 6: whether `runIf(argument)` never runs or is spelled as no plain literal. */
function constantRunIf(argument: Node | undefined): boolean {
  if (argument === undefined) return true;
  if (argument.type === "SpreadElement") return false;
  const fold = foldValue(argument);
  if (fold.kind === "unknown") return false;
  if (fold.kind === "object") return !fold.plain;
  return !fold.plain || !fold.value;
}

function isLiteralNode(node: Node): boolean {
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BigIntLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "RegExpLiteral":
    case "TemplateLiteral":
    case "ArrayExpression":
    case "ObjectExpression":
      return true;
    case "Identifier":
      return node.name === "undefined" || node.name === "NaN" || node.name === "Infinity";
    case "UnaryExpression":
      return node.operator === "void";
    default:
      return false;
  }
}

function isStringNode(node: Node): boolean {
  return node.type === "StringLiteral" || node.type === "TemplateLiteral";
}

function isNumberNode(node: Node): boolean {
  return (
    node.type === "NumericLiteral" ||
    node.type === "BigIntLiteral" ||
    (node.type === "Identifier" && node.name === "Infinity")
  );
}

function isTrueNode(node: Node): boolean {
  return node.type === "BooleanLiteral" && node.value;
}

/** The leftmost operand of a value and whether a run of `!`, `~`, `+`, `-` or parentheses sat
 * before it (only stepped through when runs is set). */
function leftmost(value: Node, runs: boolean): { node: Node; wrapped: boolean } {
  let node = value;
  let behind = false;
  for (;;) {
    const parenthesised = node.type === "ParenthesizedExpression";
    const inner = wrapped(node);
    if (inner !== null && (runs || !parenthesised)) {
      behind ||= parenthesised;
      node = inner;
    } else if (runs && node.type === "UnaryExpression" && SIGN_RUN.has(node.operator)) {
      behind = true;
      node = node.argument;
    } else if (
      (node.type === "BinaryExpression" || node.type === "LogicalExpression") &&
      node.left.type !== "PrivateName"
    ) {
      node = node.left;
    } else if (node.type === "ConditionalExpression") {
      node = node.test;
    } else if (node.type === "SequenceExpression" && node.expressions[0] !== undefined) {
      node = node.expressions[0];
    } else {
      return { node, wrapped: behind };
    }
  }
}

/** A value behind its run of `!`, `~`, `+`, `-` and parentheses (and TypeScript wrappers). */
function behindRun(value: Node): Node {
  let node = unwrapAll(value);
  while (node.type === "UnaryExpression" && SIGN_RUN.has(node.operator)) {
    node = unwrapAll(node.argument);
  }
  return node;
}

/** Whether a value starts like a constant: the leftmost-operand rule of rules 8 and 9. */
function startsConstant(value: Node): boolean {
  const { node, wrapped } = leftmost(value, true);
  if (isTrueNode(node) || isStringNode(node) || isNumberNode(node) || isFunction(node)) {
    return true;
  }
  return wrapped && isLiteralNode(node);
}

function isErrorClass(value: Node): boolean {
  const node = unwrapAll(value);
  if (node.type === "Identifier") return ERROR_CLASS.test(node.name);
  if (node.type !== "MemberExpression" || node.computed) return false;
  if (node.property.type !== "Identifier" || !ERROR_CLASS.test(node.property.name)) return false;
  let object = unwrapAll(node.object);
  while (object.type === "MemberExpression" && !object.computed) object = unwrapAll(object.object);
  return object.type === "Identifier";
}

/** Rule 8: whether an option value of a test call is refused (see OPTION CONDITION). */
function refusedOptionValue(value: Node, key: string): boolean {
  const fold = foldValue(value);
  if (fold.kind === "object") return true;
  if (fold.kind === "value" && fold.value !== false && fold.value !== undefined) return true;
  const node = unwrapAll(value);
  // A typeof and a new are already known (a string, an object) to the folder.
  if (node.type === "UnaryExpression" && ["-", "+", "~"].includes(node.operator)) return true;
  if (node.type === "AwaitExpression" && isLiteralNode(unwrapAll(node.argument))) return true;
  if (startsConstant(value)) return true;
  return key === "expectFailure" && isErrorClass(value);
}

/** Rule 9: whether an option key's value in any other object literal is refused. */
function refusedDataValue(value: Node, key: string): boolean {
  if (key !== "fails" && isNullOrNaN(unwrapAll(value))) return true;
  if (key === "skip" || key === "only" || key === "fails") {
    const { node } = leftmost(value, false);
    return isTrueNode(node) || (key !== "fails" && isStringNode(node));
  }
  if (startsConstant(value)) return true;
  const whole = behindRun(value);
  if (whole.type === "ArrayExpression" || whole.type === "ObjectExpression") return true;
  return key === "expectFailure" && (whole.type === "RegExpLiteral" || isErrorClass(whole));
}

function isNullOrNaN(node: Node): boolean {
  return node.type === "NullLiteral" || (node.type === "Identifier" && node.name === "NaN");
}

/** The properties of an options object, those of object literals spread into it included. */
function optionProperties(object: ObjectExpression, judged: Set<Node>): Node[] {
  judged.add(object);
  const out: Node[] = [];
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      const spread = unwrapAll(property.argument);
      if (spread.type === "ObjectExpression") out.push(...optionProperties(spread, judged));
    } else {
      out.push(property);
    }
  }
  return out;
}

function isEmptyFunction(node: Node | undefined): boolean {
  return (
    (node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression") &&
    node.params.length === 0 &&
    node.body.type === "BlockStatement" &&
    node.body.body.length === 0 &&
    node.body.directives.length === 0
  );
}

/** Whether a call is a test call whose options object rule 8 judges. */
function isTestCall(call: Call): boolean {
  const callee = unwrapAll(call.callee);
  if (callee.type === "Identifier") return TEST_CALLS.has(callee.name);
  return isMember(callee) && TEST_CALLS.has(memberName(callee) ?? "");
}

/** Rule 8 over one test call. */
function judgeOptions(call: Call, judged: Set<Node>, found: Found[]): void {
  const args = call.arguments;
  for (const index of [0, 1]) {
    const argument = args[index];
    if (argument === undefined) continue;
    const object = unwrapAll(argument);
    if (object.type !== "ObjectExpression") continue;
    const placeholder = index === args.length - 2 && isEmptyFunction(args[args.length - 1]);
    for (const property of optionProperties(object, judged)) {
      const key = keyName(property);
      if (key === null || !OPTION_KEYS.has(key)) continue;
      if (placeholder && PLACEHOLDER_KEYS.has(key) && property.type === "ObjectProperty") continue;
      const refused =
        property.type === "ObjectMethod" ||
        (property.type === "ObjectProperty" && refusedOptionValue(property.value, key));
      if (refused && "key" in property)
        found.push({ anchor: property.key, rule: "option", name: key });
    }
  }
}

/** Rule 10: the `type` property that makes an annotation value a skip, or null. */
function skipAnnotation(value: Node): Node | null {
  const node = unwrapAll(value);
  const items: Array<Node | null> = node.type === "ArrayExpression" ? node.elements : [node];
  for (const item of items) {
    const object = item === null ? null : unwrapAll(item);
    if (object?.type !== "ObjectExpression") continue;
    for (const property of object.properties) {
      if (property.type !== "ObjectProperty" || keyName(property) !== "type") continue;
      const type = literalKey(unwrapAll(property.value));
      if (type !== null && ANNOTATION_TYPES.has(type)) return property;
    }
  }
  return null;
}

/** Whether an expression is `require("<module>")` or `import("<module>")`, awaited or not. */
function loads(value: Node, module: string): boolean {
  let node = unwrapAll(value);
  if (node.type === "AwaitExpression") node = unwrapAll(node.argument);
  if (node.type === "ImportExpression") return literalKey(unwrapAll(node.source)) === module;
  if (node.type !== "CallExpression") return false;
  const callee = unwrapAll(node.callee);
  const first = node.arguments[0];
  return (
    callee.type === "Identifier" &&
    callee.name === "require" &&
    first !== undefined &&
    literalKey(unwrapAll(first)) === module
  );
}

/** Whether a top-level statement imports @playwright/test itself (see the header). */
function importsPlaywright(statement: Node): boolean {
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.some(
      (declaration) => declaration.init != null && loads(declaration.init, "@playwright/test"),
    );
  }
  if (statement.type !== "ImportDeclaration" || statement.source.value !== "@playwright/test") {
    return false;
  }
  if (statement.importKind === "type" || statement.importKind === "typeof") return false;
  return statement.specifiers.some(
    (specifier) =>
      specifier.type !== "ImportSpecifier" ||
      (specifier.importKind !== "type" && specifier.importKind !== "typeof"),
  );
}

/** Rule 3's exemption: the canonical conditional `test.skip(` / `test.fail(` in a spec. */
function isConditionalSkip(member: Member, parents: Map<Node, Node>): boolean {
  if (member.type !== "MemberExpression") return false;
  if (member.computed && member.property.type !== "StringLiteral") return false;
  const name = memberName(member);
  if (name !== "skip" && name !== "fail") return false;
  if (member.object.type !== "Identifier" || member.object.name !== "test") return false;
  const call = parents.get(member);
  if (call === undefined || call.type !== "CallExpression" || call.callee !== member) return false;
  if (call.typeArguments != null) return false;
  const [first, ...rest] = call.arguments;
  if (!isCondition(first, true)) return false;
  return !rest.some((argument) => isFunction(unwrapAll(argument)));
}

/** Rule 5: whether a rooted `.todo` is a planned test: one name, called directly. */
function isPlannedTodo(member: Member, parents: Map<Node, Node>): boolean {
  const call = callOf(member, parents);
  if (call === null) return false;
  const args = call.arguments;
  const name = args[0];
  if (args.length !== 1 || name === undefined) return false;
  if (name.type === "StringLiteral") return true;
  if (name.type !== "TemplateLiteral") return false;
  return name.expressions.every((expression) => isNamePath(expression));
}

function isNamePath(node: Node): boolean {
  let cur = node;
  while (
    (cur.type === "MemberExpression" || cur.type === "OptionalMemberExpression") &&
    !cur.computed
  ) {
    cur = cur.object;
  }
  return cur.type === "Identifier";
}

/** Rules 1 to 7 on a member access. */
function judgeMember(member: Member, analysis: Analysis, playwright: boolean): void {
  const name = memberName(member);
  if (name === null) return;
  const { parents, found } = analysis;
  const anchor = member.property;
  if (ANY_RECEIVER.has(name) && isCalled(member, parents)) {
    found.push({ anchor, rule: "focus", name });
  }
  if (
    PREFIXED.has(name) &&
    name !== "fit" &&
    unwrapAll(member.object).type === "Identifier" &&
    isCalled(member, parents)
  ) {
    found.push({ anchor, rule: "prefixed", name });
  }
  if (ROOTED_SKIPS.has(name) && isCalled(member, parents) && isRooted(member.object)) {
    if (!playwright || !isConditionalSkip(member, parents)) {
      found.push({ anchor, rule: "skip", name });
    }
  }
  if (name === "todo" && isCalled(member, parents) && isRooted(member.object)) {
    if (!isPlannedTodo(member, parents)) found.push({ anchor, rule: "todo", name });
  }
}

/** Rules 4, 6, 7 and 8 on a call. */
function judgeCall(call: Call, analysis: Analysis, judged: Set<Node>): void {
  const { found } = analysis;
  if (isTestCall(call)) judgeOptions(call, judged, found);
  const member = unwrapAll(call.callee);
  if (!isMember(member)) return;
  const name = memberName(member);
  const args = call.arguments;
  const anchor = member.property;
  if ((name === "skip" || name === "todo") && args.length === 0) {
    found.push({ anchor, rule: "bare", name });
  }
  if ((name === "skipIf" || name === "runIf") && isRooted(member.object)) {
    const constant = name === "skipIf" ? constantSkipIf(args[0]) : constantRunIf(args[0]);
    if (constant) found.push({ anchor, rule: name, name });
  }
  const receiver = unwrapAll(member.object);
  if (
    (name === "skip" || name === "fail") &&
    receiver.type === "Identifier" &&
    receiver.name === "testInfo"
  ) {
    const refused = args.length === 0 ? name === "fail" : !isCondition(args[0], false);
    if (refused) found.push({ anchor, rule: "testInfo", name });
  }
}

/** Rules 9 and 10 on an object literal. */
function judgeObject(object: ObjectExpression, found: Found[], judged: Set<Node>): void {
  for (const property of object.properties) {
    if (property.type === "ObjectMethod") {
      const key = keyName(property);
      if ((key === "todo" || key === "expectFailure") && !judged.has(object)) {
        found.push({ anchor: property.key, rule: "data", name: key });
      }
    }
    if (property.type !== "ObjectProperty") continue;
    const key = keyName(property);
    if (key === "annotation") {
      const type = skipAnnotation(property.value);
      if (type !== null) found.push({ anchor: type, rule: "annotation", name: key });
    }
    if (key === null || !OPTION_KEYS.has(key) || judged.has(object)) continue;
    if (refusedDataValue(property.value, key)) {
      found.push({ anchor: property.key, rule: "data", name: key });
    }
  }
}

/** Rule 11 on an import declaration. */
function judgeImport(node: ImportDeclaration, found: Found[]): void {
  if (node.source.value !== "node:test") return;
  if (node.importKind === "type" || node.importKind === "typeof") return;
  for (const specifier of node.specifiers) {
    if (specifier.type !== "ImportSpecifier") continue;
    if (specifier.importKind === "type" || specifier.importKind === "typeof") continue;
    const { imported } = specifier;
    const name = imported.type === "Identifier" ? imported.name : imported.value;
    if (BINDING_MARKERS.has(name)) found.push({ anchor: specifier, rule: "import", name });
  }
}

/** Rule 11 on a variable declarator: a destructure of node:test's require or import, or of a test
 * function. */
function judgeRequire(node: VariableDeclarator, found: Found[]): void {
  if (node.id.type !== "ObjectPattern" || node.init == null) return;
  const imported = loads(node.init, "node:test");
  if (!imported && !isTestFunction(node.init)) return;
  const rule = imported ? "import" : "destructure";
  for (const property of node.id.properties) {
    const name = keyName(property) ?? "";
    if (BINDING_MARKERS.has(name)) found.push({ anchor: property, rule, name });
  }
}

/** Rule 11: whether a destructured value is a test function: a ROOTED chain whose last step is a
 * ROOT, a test modifier, a computed key that is no literal or a LINK call, not data read off one
 * (`context.args`). */
function isTestFunction(value: Node): boolean {
  const node = unwrapAll(value);
  if (!isRooted(node)) return false;
  if (!isMember(node)) return true;
  const name = memberName(node);
  return name === null || ROOTS.has(name) || MODIFIERS.has(name);
}

// TypeScript's decorators as `experimentalDecorators` writes them, parameter decorators included
// (Nest, Angular, TypeORM); tsx, Vitest and ts-jest run them.
function pluginsFor(fileName: string): BabelParser.ParserPlugin[] {
  if (fileName.endsWith(".tsx")) {
    return ["typescript", "jsx", "decorators-legacy", "decoratorAutoAccessors"];
  }
  if (fileName.endsWith(".ts")) {
    return ["typescript", "decorators-legacy", "decoratorAutoAccessors"];
  }
  return ["jsx"];
}

function sourceTypeFor(fileName: string): "module" | "script" | "unambiguous" {
  if (fileName.endsWith(".mjs")) return "module";
  if (fileName.endsWith(".cjs")) return "script";
  return "unambiguous";
}

let parser: typeof BabelParser | null = null;

/** The parser, loaded on first use so that a missing install fails with its own message. Only
 * major version 8: the rules read its syntax tree (`typeArguments`, `ImportExpression`, a bigint's
 * value), and version 7, which other packages pull in, would judge some markers wrongly without
 * failing. */
function loadParser(): typeof BabelParser {
  if (parser !== null) return parser;
  const require = createRequire(import.meta.url);
  let loaded: typeof BabelParser;
  let version: string;
  try {
    loaded = require("@babel/parser") as typeof BabelParser;
    ({ version } = require("@babel/parser/package.json") as { version: string });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `gate 2 needs the @babel/parser package (a devDependency of this repository): run npm ci (${reason})`,
    );
  }
  if (!version.startsWith("8.")) {
    throw new Error(
      `gate 2 needs @babel/parser 8 (a devDependency of this repository), not ${version}: add it and run npm ci`,
    );
  }
  parser = loaded;
  return parser;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The 0-based line holding offset. */
function lineAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Parses a file and finds every marker in it, new or not. Throws ParseFailure. */
function analyse(text: string, fileName: string): Analysis {
  const { parse } = loadParser();
  let program: Program;
  try {
    program = parse(text, {
      sourceType: sourceTypeFor(fileName),
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowNewTargetOutsideFunction: true,
      allowUndeclaredExports: true,
      allowSuperOutsideMethod: true,
      createParenthesizedExpressions: true,
      attachComment: false,
      plugins: pluginsFor(fileName),
    }).program;
  } catch (error) {
    throw new ParseFailure(error instanceof Error ? error.message : String(error));
  }
  const analysis: Analysis = {
    text,
    lineStarts: lineStartsOf(text),
    parents: new Map(),
    found: [],
  };
  const playwright = program.body.some(importsPlaywright);
  // Every test call's options objects are judged by rule 8 first, so rule 9 can leave them out.
  const all: Node[] = [];
  const stack: Node[] = [program];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    all.push(node);
    for (const child of childrenOf(node)) {
      analysis.parents.set(child, node);
      stack.push(child);
    }
  }
  const judged = new Set<Node>();
  for (const node of all) {
    if (isCall(node)) judgeCall(node, analysis, judged);
  }
  for (const node of all) {
    if (isMember(node)) judgeMember(node, analysis, playwright);
    else if (node.type === "Identifier" && PREFIXED.has(node.name)) {
      if (isCalled(node, analysis.parents, MODIFIERS)) {
        analysis.found.push({ anchor: node, rule: "prefixed", name: node.name });
      }
    } else if (node.type === "ObjectExpression") judgeObject(node, analysis.found, judged);
    else if (node.type === "ImportDeclaration") judgeImport(node, analysis.found);
    else if (node.type === "VariableDeclarator") judgeRequire(node, analysis.found);
  }
  analysis.found.sort((a, b) => startOf(a.anchor) - startOf(b.anchor));
  return analysis;
}

/** The nearest statement or declaration holding a node: the marker's unit. */
function unitOf(node: Node, parents: Map<Node, Node>): Node {
  let cur = node;
  while (!/(?:Statement|Declaration)$/.test(cur.type)) {
    const parent = parents.get(cur);
    if (parent === undefined) return cur;
    cur = parent;
  }
  return cur;
}

/** The bodies of the functions in a unit that do not hold the marker, outermost only, but for
 * functions inside a kept range (the marker's own condition). */
function elidedBodies(
  unit: Node,
  offset: number,
  kept: Array<[number, number]> = [],
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack: Node[] = [unit];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node !== unit && "body" in node && isNode(node.body) && isFunctionLike(node)) {
      const body = node.body;
      const inKept = kept.some(([start, end]) => startOf(node) >= start && endOf(node) <= end);
      if (!inKept && (offset < startOf(body) || offset >= endOf(body))) {
        ranges.push([startOf(body), endOf(body)]);
        continue;
      }
    }
    stack.push(...childrenOf(node));
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isFunctionLike(node: Node): boolean {
  return (
    isFunction(node) ||
    node.type === "FunctionDeclaration" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod"
  );
}

/** A node's text with each cut (start, end, what stands for it) applied. */
function cutText(node: Node, cuts: Array<[number, number, string]>, analysis: Analysis): string {
  cuts.sort((a, b) => a[0] - b[0]);
  let text = "";
  let at = startOf(node);
  for (const [start, end, stand] of cuts) {
    text += analysis.text.slice(at, start) + stand;
    at = end;
  }
  return text + analysis.text.slice(at, endOf(node));
}

/** The statements around a unit, outermost last, each with every function body in it elided
 * (its own too): which test and which describe a marker sits in is part of its identity, so a
 * `this.skip();` moved from a skipped test into a running one is new. */
function contextOf(unit: Node, analysis: Analysis): string {
  const parts: string[] = [];
  for (let cur = analysis.parents.get(unit); cur !== undefined; cur = analysis.parents.get(cur)) {
    if (cur.type === "BlockStatement" || !/(?:Statement|Declaration)$/.test(cur.type)) continue;
    const bodies =
      isFunctionLike(cur) && "body" in cur && isNode(cur.body)
        ? [[startOf(cur.body), endOf(cur.body)] as [number, number]]
        : elidedBodies(cur, -1);
    const cuts = bodies.map(([start, end]): [number, number, string] => [start, end, ELIDED]);
    parts.push(cutText(cur, cuts, analysis));
  }
  return parts.join("\u0000");
}

/** A marker's identity across base and head (see the header). */
function keyOf(found: Found, analysis: Analysis): string {
  const unit = unitOf(found.anchor, analysis.parents);
  const offset = startOf(found.anchor);
  // Each elided body becomes ELIDED, and the marker's own position a SOH byte.
  const cuts: Array<[number, number, string]> = elidedBodies(
    unit,
    offset,
    conditionRanges(found, analysis.parents),
  ).map(([start, end]) => [start, end, ELIDED]);
  cuts.push([offset, offset, "\u0001"]);
  const text = `${cutText(unit, cuts, analysis)}\u0000${contextOf(unit, analysis)}`;
  // Whitespace runs read as one space: a blank line or a re-indent leaves a marker as it was.
  return `${found.rule}\u0000${found.name}\u0000${text.replace(/\s+/g, " ")}`;
}

/** A marker's own condition, whose functions keep their bodies in its key: the value of its key
 * (a method's body included), and the first argument of each call it is the callee of (a
 * Playwright condition or fixture callback, a skipIf's condition, else a title). */
function conditionRanges(found: Found, parents: Map<Node, Node>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const holder = parents.get(found.anchor);
  if (holder?.type === "ObjectProperty" && holder.key === found.anchor) {
    ranges.push([startOf(holder.value), endOf(holder.value)]);
  } else if (holder?.type === "ObjectMethod" && holder.key === found.anchor) {
    ranges.push([startOf(holder), endOf(holder)]);
  }
  let cur = found.anchor;
  for (let parent = parents.get(cur); parent !== undefined; parent = parents.get(cur)) {
    if (/(?:Statement|Declaration)$/.test(parent.type)) break;
    if (isCall(parent) || parent.type === "NewExpression") {
      if (parent.callee !== cur) break;
      const first = parent.arguments[0];
      if (first !== undefined) ranges.push([startOf(first), endOf(first)]);
    }
    cur = parent;
  }
  return ranges;
}

/** The lines printed for a refused marker (see the header). */
function printedLines(found: Found, analysis: Analysis): { line: number; lines: string[] } {
  const { lineStarts, text } = analysis;
  const unit = unitOf(found.anchor, analysis.parents);
  const first = lineAt(lineStarts, startOf(unit));
  const last = lineAt(lineStarts, Math.max(startOf(unit), endOf(unit) - 1));
  const marker = lineAt(lineStarts, startOf(found.anchor));
  const lineText = (index: number): string => {
    const start = lineStarts[index] ?? text.length;
    const next = lineStarts[index + 1];
    const end = next === undefined ? text.length : next - 1;
    return text.slice(start, end).replace(/\r$/, "");
  };
  const lines: string[] = [];
  if (last - first < 6) {
    for (let index = first; index <= last; index++) lines.push(lineText(index));
  } else {
    lines.push(lineText(first));
    const from = Math.max(marker, first + 1);
    const to = Math.min(marker + 2, last);
    if (from > first + 1) lines.push("  …");
    for (let index = from; index <= to; index++) lines.push(lineText(index));
    if (to < last) lines.push("  …");
  }
  return { line: marker + 1, lines };
}

/**
 * The markers head adds that base does not have. base is null for a file the diff adds. Throws
 * ParseFailure when head does not parse; a base that does not parse holds no markers.
 */
export function findAddedMarkers(
  base: string | null,
  head: string,
  fileName: string,
  baseName: string = fileName,
): Marker[] {
  const headAnalysis = analyse(head, fileName);
  const legacy = new Map<string, number>();
  if (base !== null) {
    let baseAnalysis: Analysis | null = null;
    try {
      baseAnalysis = analyse(
        base,
        JS_EXTENSIONS.some((e) => baseName.endsWith(e)) ? baseName : fileName,
      );
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
    }
    for (const found of baseAnalysis?.found ?? []) {
      const key = keyOf(found, baseAnalysis as Analysis);
      legacy.set(key, (legacy.get(key) ?? 0) + 1);
    }
  }
  const markers: Marker[] = [];
  const printed = new Set<string>();
  for (const found of headAnalysis.found) {
    const key = keyOf(found, headAnalysis);
    const count = legacy.get(key) ?? 0;
    if (count > 0) {
      legacy.set(key, count - 1);
      continue;
    }
    const { line, lines } = printedLines(found, headAnalysis);
    // Two markers in one unit on one line (`test.only.skip(`) are listed once.
    const shown = `${line}\u0000${lines.join("\n")}`;
    if (printed.has(shown)) continue;
    printed.add(shown);
    markers.push({ line, rule: found.rule, lines });
  }
  return markers;
}

interface Entry {
  status: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  oldPath: Buffer;
  newPath: Buffer;
}

/** The entries of `git diff --raw -z --no-abbrev`. */
function readRawList(raw: Buffer): Entry[] {
  const fields: Buffer[] = [];
  let at = 0;
  for (let nul = raw.indexOf(0, at); nul !== -1; nul = raw.indexOf(0, at)) {
    fields.push(raw.subarray(at, nul));
    at = nul + 1;
  }
  if (at < raw.length) throw new Error("the diff list does not end with a NUL byte");
  const entries: Entry[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++]?.toString("latin1") ?? "";
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header);
    if (match === null) throw new Error(`unexpected diff entry: ${JSON.stringify(header)}`);
    const [, oldMode = "", newMode = "", oldBlob = "", newBlob = "", status = ""] = match;
    const oldPath = fields[index++];
    const newPath = status === "R" || status === "C" ? fields[index++] : oldPath;
    if (oldPath === undefined || newPath === undefined) {
      throw new Error("the diff list ends inside an entry");
    }
    entries.push({ status, oldMode, newMode, oldBlob, newBlob, oldPath, newPath });
  }
  return entries;
}

function readBlob(blob: string): string {
  const result = spawnSync("git", ["cat-file", "blob", blob], { maxBuffer: 1024 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr.toString().trim();
    throw new Error(`git cat-file blob ${blob} failed (exit ${result.status}): ${reason}`);
  }
  // Non-fatal: a byte that is not valid UTF-8 becomes U+FFFD and the file is still judged.
  return new TextDecoder("utf-8").decode(result.stdout);
}

/** Judges every entry; returns what to print (empty when nothing is refused). */
function judgeList(raw: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (const entry of readRawList(raw)) {
    if (!["A", "M", "R", "T"].includes(entry.status)) continue;
    const name = entry.newPath.toString("latin1");
    if (!JS_EXTENSIONS.some((extension) => name.endsWith(extension))) continue;
    if (!REGULAR_FILE.has(entry.newMode)) continue;
    const hasBase = entry.status !== "A" && REGULAR_FILE.has(entry.oldMode);
    const base = hasBase ? readBlob(entry.oldBlob) : null;
    const head = readBlob(entry.newBlob);
    let markers: Marker[];
    try {
      markers = findAddedMarkers(base, head, name, entry.oldPath.toString("latin1"));
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      throw new Error(`gate 2 cannot parse ${name}: ${error.message}`);
    }
    for (const marker of markers) {
      out.push(entry.newPath, Buffer.from(`:${marker.line}:\n${marker.lines.join("\n")}\n`));
    }
  }
  return out;
}

function main(args: string[]): number {
  const [list] = args;
  if (list === undefined || args.length !== 1) {
    process.stderr.write("usage: node bin/check-test-markers.ts <git diff --raw -z list>\n");
    return 2;
  }
  const out = judgeList(readFileSync(list));
  if (out.length === 0) return 0;
  process.stdout.write(Buffer.concat(out));
  return 3;
}

// Run as a script, not imported by the unit tests (import.meta.main needs Node 24.2).
const entry = process.argv[1];
// Both sides resolved: under --preserve-symlinks-main import.meta.url keeps a symlink's path.
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${reason}\n`);
    process.exitCode = 2;
  }
}
