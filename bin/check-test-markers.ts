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
// position in that text marked, the text of each statement around the unit with every function
// body in it replaced the same way (the test and describe calls holding it, with their titles),
// and every run of whitespace read as one space. A test need not be a statement (a table entry,
// a tuple of a table, a class method or field, a property of a mocha exports object), so in each
// array, object literal or class body between the unit and such a statement only the element
// holding the unit and the elements that hold no function are written, in order. Head markers
// are matched against the base file's keys as a multiset, in document order; an unmatched one is
// refused. So a marker left as it was is allowed wherever it moves among its siblings, editing a
// test body, adding a blank line or re-indenting, or adding, removing or editing another test
// beside it leaves a legacy skip alone, a `this.skip();` moved into another test, any other edit
// inside the unit (a comment, an argument, the condition) or a renamed test or describe around
// it makes the marker new, and a second identical marker is new.
//
// Vocabulary. ROOTS are the test receivers: test, describe, it, suite, context, specify and
// Jest/Vitest's concurrent. A chain is ROOTED when, walking down the object side of the member
// access, through member accesses, TypeScript wrappers (`!`, `as`, `satisfies`, `<T>x`, `f<T>`),
// parentheses, the last operand of a comma expression, the right side of a plain `=`
// assignment and an `await`'s operand (`(0, test).skip(`, `(x = test).skip(`,
// `(await test).skip(`: a function is no thenable), and calls of a LINK (skipIf, runIf,
// extend, info: they return a test object, and their arguments may hold anything:
// `test.runIf(f(x)).skip(`), one reaches a ROOT identifier, or a ROOT read off a name
// (`nt.test`, `globalThis.it`: a namespace import, a global) or off a `require(` / `import(` of
// any module (`require("vitest").test`, `(await import("vitest")).test`). A
// call of any other name ends the chain (`t.context.db.collection("u").find({}).skip(10)` is a
// database cursor, not a test). A member access is CALLED when, walking up through member
// accesses whose object it is, TypeScript wrappers, parentheses, the last operand of a comma
// expression, the right side of a plain `=` assignment and an `await`'s operand, one reaches a
// call (optional or not), a `new` or a tagged template whose callee or tag it is: so
// `test.only.each(...)(...)`, `(0, test.only)(`, `(f = test.only)(`, `(await test.only)(`,
// `new test.only(`,
// `test.only?.(`, `test.only<T>(`, `test!.only(`, `test.only!(` and `test.only.each\`...\`` are
// called, and `opts.only != x` is data. A member's name is read as the engine reads it: an
// escaped identifier (`test.only`) and a computed string or no-substitution template key
// (`test["only"]`, `test[\`only\`]`, escapes decoded) are the name they spell. A call INVOKES
// its callee, read behind wrappers, the last operand of a comma expression, the right side of a
// plain `=` assignment and an `await`'s operand (`(0, describe.skipIf)(`), with its arguments;
// a call of Function.prototype's `call` or `apply` invokes the function it is read off instead,
// one level deep (`f.call(self, a, b)` and `f.apply(self, [a, b])` invoke `f` with `a, b`, a
// hole in the list `undefined` in its place; `f.apply(self)`, `f.apply(self, null)` and
// `f.apply(self, undefined)` with none). An `apply` list that is no array literal and no such
// constant (`f.apply(self, list)`, an array-like object `f.apply(self, {})`), or a spread first
// argument (`f.call(...a)`), leaves the call as written. Rules 4, 6, 7 and 8 judge the call a
// call invokes; `.bind` is a residual.
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
//      or of a `require(` / `import(` (`jg.xit(`, a namespace import,
//      `require("@jest/globals").xit(`), the name also behind a comma expression, a plain `=`
//      assignment or an `await` (`(0, jg).xit(`, `(await jg).xit(`, `(0, globalThis).xit(`;
//      `(0, a.b).xit(` stays data). A name an import of any module that is not type-only, or a
//      destructure of a module value or of node:test or a test function (rule 11), binds to one
//      of those markers is that marker (`import { xit as check } from "@jest/globals"` or
//      `const { xit: check } = require("mocha")`, then `check(`; `check.length` is data). A
//      method of that name on any other object is no marker, and `.fit` on a name is none either
//      (`model.fit(X, y)`). A bare `expectFailure(` is refused whatever it was imported from or
//      declared as: a helper of that name reads as node:test's expected failure.
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
//      `["skip"]`, not optional) on the bare identifier `test`, or on a name the spec's own
//      top-level import of `@playwright/test` binds to its `test` (`import { test as base } from
//      "@playwright/test"`, `import base from "@playwright/test"`, then `base.skip(isCI, "r")`),
//      with no wrapper, no type arguments and no optional call anywhere; the first argument is a
//      CONDITION (below); and no later argument may be a function (`test.skip(title, () => {})`
//      declares a skipped test): one behind a comma expression, a plain `=` assignment or an
//      `await`, an immediately invoked function, or a conditional or logical expression with a
//      branch or operand that may be one counts too (`test.skip(title, (0, () => {}))`,
//      `test.skip(title, isCI ? () => {} : () => {})`, `test.skip(title, body || (() => {}))`).
//      Everything else is refused there too: `test.skip()`, `test.skip("title", fn)`,
//      `test.skip(true, r)`, `test.skip?.(isCI, r)`, `test.skip!(isCI, r)`,
//      `test?.["skip"](isCI, r)`, `test.info().skip(isCI, r)`, `test.describe.skip(...)`.
//   4. A bare `.skip()` or `.todo()` with no argument on any receiver, the call read as it
//      INVOKES (`this.skip()` in a mocha-style body, node:test's `t.todo()`, `(0, this.skip)()`,
//      `this.skip.call(this)`, `x.todo.apply(x, [])`): a failure after it no longer fails the run
//      (measured, node 24.18). And (rule `contextSkip`) `.skip` or `.todo` called on a TEST
//      CONTEXT whatever the arguments: `this`, the name `t`, or a name that is the first
//      parameter of a function passed to a test call (as rule 8 reads one, `t.test(` included),
//      to a call of a test function (as rule 11 reads one: `check(`, `it.concurrent(`,
//      `test.runIf(x)(`, `nt.default(`) or to a hook (before, beforeEach, after, afterEach,
//      beforeAll, afterAll; bare, as a member, or renamed on import or in a destructure whatever
//      the source, `import { beforeEach as setup } from "vitest"`,
//      `const { beforeEach: setup } = v`, nested under a test function's key too), or the second
//      parameter of a function passed to the call a `.for` table of a test function returns
//      (`test.for(rows)("x", (row, ctx) => …)`, a tagged `` test.for`…` `` too: the row comes
//      first); the function also passed as the last operand of a comma expression, the right
//      side of a plain `=` assignment or an `await`'s operand (`test("x", (0, (ctx) => …))`,
//      `test("x", f = (ctx) => …)`); each of those calls read as it INVOKES, the function also
//      an element of `.apply`'s array literal (`test.apply(null, ["x", (ctx) => …])`,
//      `test.for(rows).call(null, "x", (row, ctx) => …)`, `test.for.call(test, rows)(`,
//      `beforeEach.call(null, (ctx) => …)`), but not as `.call`'s or `.apply`'s receiver
//      (`test.call((ctx) => …)`: the test never calls it) or inside an array that is no `.apply`
//      list (`test("x", [(ctx) => …])`);
//      a TypeScript `this` parameter is not counted (`function (this: void, ctx)`); the `.skip`
//      or `.todo` itself also called through `.call` / `.apply` / `.bind` or a comma expression
//      as rule 3 reads a call (`ctx.skip.call(ctx, "r")`, `(0, ctx.skip)("r")`), and with the
//      receiver behind a comma expression, a plain `=` assignment or an `await`
//      (`(0, t).skip(`, `(c = ctx).skip(`, `(await ctx).skip(`).
//      After node:test's `t.skip("reason")` or `t.todo("later")` the body runs on but a failure
//      no longer fails the run (measured, node 24.18.1: a throwing body exits 0), and mocha's
//      `this.skip` (Cypress 16's included) ignores its argument, so a reason makes neither
//      conditional; an enclosing `if` is not read. The conditional form is the option:
//      node:test's `test("x", { skip: cond }, fn)`, Playwright's `test.skip(cond, "r")`,
//      Vitest's `test.skipIf(cond)`.
//   5. `.todo` on a ROOTED chain holding anything but one name: allowed only when called directly
//      with exactly one argument that is a string, or a template whose substitutions are each a
//      name or a member path of names, and nothing chained after it. node:test runs a todo's body
//      and ignores its failure (measured, node 24.18: a throwing body exits 0), so
//      `test.todo("t", fn)` is a skip; `test.todo(title)`, `test.todo.each(` and
//      `` test.todo(`a ${f()}`) `` are refused; `test.todo("planned")` is planning.
//   6. Vitest's `skipIf(x)` / `runIf(x)` on a ROOTED chain with a constant argument (see the
//      condition rules): `skipIf` is refused when x always skips or is a literal in a spelling
//      that is no plain literal; `runIf` when x is absent, never runs, or is such a spelling.
//      The call is read as it INVOKES (`test.skipIf.call(test, true)`,
//      `test.skipIf.apply(test, [true])`, `(0, describe.skipIf)(true)`): Vitest's
//      `describe.skipIf` and `describe.runIf` keep no receiver, so the comma form skips
//      (measured, vitest 5.0.5).
//   7. Playwright's fixture `testInfo.skip(x, ...)` / `testInfo.fail(x, ...)` (receiver named
//      `testInfo`, in any file, also behind a comma expression, a plain `=` assignment or an
//      `await`: `(0, testInfo).skip(`) whose first argument is not a CONDITION or is a function
//      (the fixture takes a condition, not a callback), and a bare `testInfo.fail()`; the call
//      read as it INVOKES (`testInfo.skip.call(testInfo, true)`, `(0, testInfo.skip)(true)`).
//   8. node:test's and Vitest's options object of a test call: the first or second argument of a
//      call of test, it, describe, suite, context or specify (bare, or as a member: `t.test(`,
//      `test?.(`), the call read as it INVOKES (`(0, test)(`, `test.call(null, "x", { skip: 1 },
//      fn)`, `test.apply(null, ["x", { skip: 1 }, fn])`); the object behind any wrapper, a comma
//      expression, a plain `=` assignment or an `await` (`test("x", (0, { skip: 1 }), fn)`),
//      also an object literal spread into it, read the same way (`{ ...{ skip: 1 } }`,
//      `{ ...(0, { skip: 1 }) }`). A `skip`, `only`, `todo`, `fails` or `expectFailure` key (any
//      spelling an object allows: quoted, computed, a no-substitution template) is refused when it
//      is a method or accessor (`todo() {}`, `get skip() {...}`), when its value is not an OPTION
//      CONDITION (below), and for `expectFailure` when its value is an error class (a name or
//      member path whose last name is `Error`, `Exception` or a capitalised name ending in either:
//      node:test's validator, as assert.throws takes it). PLACEHOLDER exemption: a `skip` key
//      written as a plain property (never a method or accessor) is allowed when the options
//      object is the second-to-last argument the call invokes with and the last is an EMPTY
//      function with no parameters, written as itself; the options object holds no function,
//      method or class (a getter could hand it to another test as `this`), and no plain `=`
//      assignment or `await` sits on the way from the call to the key (`(o = { skip: true })`
//      would skip `test("u", o, fn)` too, and an awaited object's `then`, from anywhere, gets it
//      as `this`): the env-gated placeholder
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
//      is `true`, a string, a number, Infinity or a function, or is any literal behind at least
//      one of that run, or the whole value is an array or object literal, and always as a method
//      or getter (`{ todo() {} }`: a function, which node:test reads as true; a setter alone
//      reads as undefined); `expectFailure` also when the whole value is a regex literal or an
//      error class; and `skip`, `todo` and `expectFailure` when the whole value is `null` or
//      `NaN` (node:test skips and todos for both, measured, node 24.18; `only` focuses for
//      neither). `{ skip: 10 }`, `{ skip: -1 }`, `todo: false`, `{ skip: null ?? x }`,
//      `only: null`, `fails: null` and `fails: "no hook"` stay allowed.
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
//      member call rules 1 to 5 see (rule 2 refuses a bare `expectFailure(` under either). So the
//      binding itself is refused, `todo` too: a planned test is `test.todo("name")` (rule 5). Only
//      the `node:` spelling names the builtin. Likewise a destructure (`const`, `let` or `var`,
//      renamed or not) of those names from a test function: a ROOTED chain whose last step is a
//      ROOT, a test modifier (rule 2's list), a computed key that is no literal or a LINK call
//      (`const { skip } = test`, `const { only: o } = describe`, `const { skip } = test.describe`,
//      `= nt.test`, `= test[kind]`, `= test.extend({})`), and a nested one under a test
//      function's key (a ROOT, `default`, a test modifier, or a computed key that is no literal:
//      `const { test: { skip } } = require("node:test")`,
//      `const { sequential: { skip } } = test`). A destructure of anything else is
//      data (`const { skip } = query`, `const { skip, take } = context.args`); a ROOT read off a
//      name counts (`const { skip } = req.context` is refused: the strict side), and so does a
//      destructure whose call rule 3 would allow in a Playwright spec (`skip(isCI, "r")`).
//      Every name a file binds to node:test or to its test functions is a ROOT in that file, for
//      rules 3, 4, 5, 6 and this one: a default or namespace import (`import nt from "node:test"`,
//      `import * as nt from "node:test"`, then `nt.skip(`), a renamed one
//      (`import { test as check } from "node:test"`, then `check.skip(` or
//      `const { skip } = check`), `const nt = require("node:test")` or `= await import(...)`, a
//      name assigned either (`nt = require("node:test")`), and a name destructured under a test
//      function's key, nested too, or as the rest, from node:test or from a test function
//      (`const { test: check } = require("node:test")`, `const { test: check } = nt`,
//      `const { describe: d } = test`, `const { sequential: seq } = test`,
//      `const { test: { describe: d } } = nt`, `const { mock, ...rest } = nt`; also through
//      such a name, `const { it: i } = d`); so is a `require("node:test")` or
//      `import("node:test")` itself (`(await import("node:test")).skip(`). `default` counts as
//      `test` in an import or a destructure under the key `default` and as a test function's last
//      step (`nt.default`), but `nt.default(` is no test call for rule 8 (see the residuals).
//      From any other module, a ROOT but `context` is a test function too (`@opentelemetry/api`
//      exports a `context`, which stays data): a name an import that is not type-only binds to
//      one (`import { test as check } from "vitest"`, `import { it as check } from
//      "@jest/globals"`, `import { test as check } from "./fixtures"`), and a name a destructure
//      binds under such a key from a MODULE VALUE: a `require(` or `import(` of any module,
//      whatever its argument, a namespace import that is not type-only, a name declared with or
//      assigned such a load, or the global object, `globalThis`, `global`, `window` or `self`
//      (`const { test: check } = await import("vitest")`, `import * as v from "vitest";
//      const { describe: d } = v`, `const { test: check } = globalThis`), nested too
//      (`const { test: { describe: d } } = require("@playwright/test")`). From the global object
//      `context` counts too (Mocha's globals hold one: `const { context: c } = globalThis`). No
//      other key binds a ROOT there (a modifier, `default`, a computed key, the rest), and a
//      destructure of anything else stays data
//      (`const { describe: d } = config`). A marker destructured under such a key from a module
//      value is refused (`const { test: { skip } } = require("vitest")`); one at the top is not
//      (`const { skip } = require("vitest")`: only node:test exports one there).
//      `@playwright/test`'s default export is its `test`: `import base from "@playwright/test"`
//      and `import { default as base } from "@playwright/test"` bind a ROOT (a destructure or a
//      read of its `default` does not: see the residuals). Rule 8 does not read
//      a renamed test function's options object either (see the residuals).
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
// values is computed; an immediately invoked function is a function, the call read as it
// INVOKES (`(0, () => x)()`, `(() => x)?.()`, `(() => x).call(null)`).
// Everything else (a name, a member access, a call) is unknown. A PLAIN literal is one written
// as itself: a literal, `undefined`, `NaN`, `Infinity`, `void x`, a bare regex, array, object or
// function, or a number, `true`, `false`, `null`, `undefined`, `NaN` or `Infinity` behind a run
// of `+` / `-` only, each optionally cast (`false as boolean`); anything behind `!`, `~` or
// parentheses, a comma expression and a signed string are not.
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
// `const focus = test.only`), a test function under a name only an alias binds
// (`const check = test; check.skip(`, `const check = require("node:test").test`) or a module
// value only an alias binds (`const g = globalThis; const { test: check } = g`; jsdom's `top`,
// `parent` and `frames`, which are the window), a test
// function or a test context chosen by a conditional, a logical operator or a logical
// assignment (`(a || test).skip(`, `(x ??= test).skip(`, `(ok ? ctx : other).skip("r")`), a
// destructure that is no variable declaration (a parameter `({ skip }) =>`, an assignment
// `({ skip } = test)`), a test function's member this
// check does not list (`const { only } = test.describe.serial`), a marker re-exported through a
// local module (`export { skip } from "node:test"` in a helper the test imports), node:test
// loaded other than by `import`, or by `require(` or `import(` of the literal `"node:test"`
// (`const mod = "node:test"; require(mod)`, `process.getBuiltinModule("node:test")`,
// `module.require(`, `createRequire(import.meta.url)("node:test")`, TypeScript's
// `import nt = require("node:test")`; another module so loaded is no module value for rule 11:
// `import v = require("vitest"); const { test: check } = v`), a `context` renamed from any module
// but node:test (`import { context as c } from "mocha"`: other modules export a `context` that is
// data), a renamed test function's
// options object (`check("x", { skip: true }, fn)` and `nt.default("x", { skip: true }, fn)` are
// judged by rule 9, not rule 8), a test function imported as another module's default export
// under another name (`import check from "ava"`: a default export may be anything;
// `@playwright/test`'s is read), a ROOT destructured from a default import
// (`import jg from "@jest/globals"; const { it: check } = jg`: a default export may be data with
// a `test` key, as a Vitest config is), `@playwright/test`'s default reached other than by an
// import declaration (`const { default: base } = require("@playwright/test")`,
// `import * as pw from "@playwright/test"; pw.default.skip(`), a condition
// that is always true but that the folder cannot see
// (`test.skip(isCI === isCI, r)`), a skipped test whose body is passed by name
// (`test.skip(title, body)`, which reads like `test.skip(cond, REASON)`) or as any other value
// rule 3 does not read as a function (`test.skip(title, bodies[0])`, `test.skip(title, make())`),
// Playwright's fixture
// under a name other than `testInfo`, an options object on a call this check does not take for a
// test call (`test.concurrent(`, `test.sequential(`), an option value that is no constant
// but never false (`{ skip: offset - 1 }`, `{ skip: isCI ? "r" : null }`), a test context rule 4
// cannot see (an alias, `const self = this; self.skip("r")`; the callback of a hook or a test
// function called through `.bind`, `beforeEach.bind(null)((ctx) => …)`,
// `test.bind(null)("x", (ctx) => …)`; a member named `t`,
// `ctx.t.skip("r")`; a context passed to a helper under a name other than `t`; a context named
// other than `t` in a test body that is no inline argument of the test call: passed by name,
// `test("x", run)`, held in a table entry, `{ fn(ctx) {…} }`, or wrapped, `withDb((ctx) => …)`),
// a LINK in a ROOTED chain called through `.call` or `.apply` (`test.skipIf.call(test, x).skip(`,
// `test.runIf.call(test, x)("t", (ctx) => …)`: a chain walks a LINK only as a direct call), a
// call rules 4, 6, 7 and 8 judge made through `.bind` (`test.skipIf.bind(test)(true)`,
// `test.bind(null)("x", { skip: 1 }, fn)`), a `.for` table under a name a destructure binds
// (`const { for: table } = test; table(rows)("x", (row, ctx) => …)`: Vitest's `.for` reads its
// receiver, so that call throws a TypeError and the file fails, measured, vitest 5.0.5),
// and a legacy marker moved between tests that a concise arrow body holds with no statement between
// (`describe("s", () => [{ fn(t) {…} }, …])`: the statement around them elides that body whole)
// or that are bare functions in an array (`[(t) => {…}, (t) => {…}]`: nothing names them), or
// whose title sits beside a function in an element that is not the test's own
// (`[{ meta: { name: "a", setup() {} }, fn(t) {…} }, …]`: an element holding a function is not
// written, so the title drops out of the key).
// AGENTS.md forbids them all the same. The other way, rule 4 refuses a `skip` or `todo` method on
// `this` or on a name `t` that is no test context (`this.skip(10)` in a cursor class,
// `const t = db.find({}); t.skip(10);`, `import t from "node:test"; t.todo("planned")`), as its
// bare `.skip()` does on any receiver: rename the variable (import node:test under another name,
// or write `test.todo("planned")`). A Playwright `test` renamed by a destructure gets no
// conditional-skip exemption (`const { test: base } = require("@playwright/test");
// base.skip(isCI, "r")`, or the same from a namespace import): import it, or call `test.skip`.
// And a legacy marker is new when an element beside its test that holds no function is edited
// (`{ name: "b" }` in a table, a class field), when its unit holds its sibling tests
// (`fn: (t) => t.skip()` as a concise body makes the whole table its unit), and when an untitled
// test or suite is edited (`describe.skip(() => {…})`: its body is the call's first argument,
// kept as the marker's condition).
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
  ImportSpecifier,
  MemberExpression,
  Node,
  ObjectExpression,
  ObjectPattern,
  OptionalCallExpression,
  OptionalMemberExpression,
  Program,
  VariableDeclarator,
} from "@babel/types";

const ROOTS = new Set(["test", "describe", "it", "suite", "context", "specify", "concurrent"]);
// The ROOTS another module may export as a test function (rule 11): all but `context`, which
// other modules export as something else (`@opentelemetry/api`'s `context`).
const EXPORTED_ROOTS = new Set([...ROOTS].filter((name) => name !== "context"));
// The names of the global object, where Jest's, Vitest's and Mocha's globals put the test
// functions (rule 11): `window` and `self` too, which jsdom environments make the global.
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);
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
const HOOKS = new Set(["before", "beforeEach", "after", "afterEach", "beforeAll", "afterAll"]);
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
  /** Which rule refused it (focus, prefixed, skip, bare, contextSkip, todo, skipIf, runIf,
   * testInfo, option, data, annotation, import, destructure). */
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
  /** ROOTS and the names this file binds to node:test or its test functions (rule 11). */
  roots: ReadonlySet<string>;
  /** HOOKS and the names this file binds to a hook: renamed on import or in a destructure
   * (rule 4). */
  hooks: ReadonlySet<string>;
  /** The names this file binds to a module: a namespace import, or a name declared with or
   * assigned a `require(` or `import(` (rule 11). */
  modules: ReadonlySet<string>;
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

/** The node an expression evaluates to: every wrapper stepped through, a comma expression read
 * as its last operand, a plain `=` assignment as its right side and an `await` as its operand (a
 * test function or context is no thenable), as often as they nest (`(0, t)`, `(c = t)` and
 * `(await t)` are `t`). A compound or logical assignment is itself. */
function unwrapValue(node: Node): Node {
  let cur = unwrapAll(node);
  for (;;) {
    if (cur.type === "SequenceExpression") {
      const last = cur.expressions.at(-1);
      if (last === undefined) return cur;
      cur = unwrapAll(last);
    } else if (cur.type === "AssignmentExpression" && cur.operator === "=") {
      cur = unwrapAll(cur.right);
    } else if (cur.type === "AwaitExpression") {
      cur = unwrapAll(cur.argument);
    } else {
      return cur;
    }
  }
}

/** Whether an expression evaluates to its child, as unwrapValue reads it: a wrapper around it,
 * a comma expression whose last operand it is, a plain `=` assignment whose right side it is, or
 * an `await` of it. */
function evaluatesTo(node: Node, child: Node): boolean {
  if (wrapped(node) === child) return true;
  if (node.type === "SequenceExpression") return node.expressions.at(-1) === child;
  if (node.type === "AwaitExpression") return node.argument === child;
  return node.type === "AssignmentExpression" && node.operator === "=" && node.right === child;
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
      evaluatesTo(parent, cur) ||
      (isMember(parent) &&
        parent.object === cur &&
        (members === undefined || name === null || members.has(name)));
    if (!passes) {
      if (isCall(parent) || parent.type === "NewExpression") return parent.callee === cur;
      return parent.type === "TaggedTemplateExpression";
    }
    cur = parent;
  }
  return false;
}

/** Whether an expression is a chain rooted at a test receiver (see the header). roots is ROOTS
 * and the file's own names for node:test and its test functions. */
function isRooted(node: Node, roots: ReadonlySet<string>): boolean {
  let cur = unwrapValue(node);
  for (;;) {
    if (cur.type === "Identifier") return roots.has(cur.name);
    if (isMember(cur)) {
      const object = unwrapValue(cur.object);
      // A receiver read off a name or a module load: a namespace import, a global or any module
      // (`nt.test`, `globalThis.it`, `require("vitest").test`).
      const reader = object.type === "Identifier" || loadSource(object) !== null;
      if (reader && ROOTS.has(memberName(cur) ?? "")) return true;
      cur = object;
      continue;
    }
    if (loads(cur, "node:test")) return true;
    const callee = isCall(cur) ? unwrapValue(cur.callee) : null;
    if (callee === null || !isMember(callee) || !LINKS.has(memberName(callee) ?? "")) return false;
    cur = unwrapValue(callee.object);
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
    case "OptionalCallExpression":
      // An immediately invoked function is read as the function (the strict side), the callee the
      // call INVOKES (invocation: `(0, () => x)()`, `(() => x)?.()`, `(() => x).call(null)`).
      return isFunction(invocation(node).callee)
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

/** The call a call INVOKES (see the header): its callee as unwrapValue reads it, with its
 * arguments; for a call of Function.prototype's `call` or `apply` read off a member, the function
 * that member is read off instead, one level deep: `f.call(self, a, b)` and
 * `f.apply(self, [a, b])` invoke `f` with `a, b` (a hole in the list is `undefined` in its
 * place), and `f.apply(self)`, `f.apply(self, null)` and `f.apply(self, undefined)` with none. A
 * spread first argument, or an `apply` list that is no array literal and no known `null` or
 * `undefined`, leaves the call as written. */
function invocation(call: Call): { callee: Node; args: Array<Node | undefined> } {
  const callee = unwrapValue(call.callee);
  const written = { callee, args: call.arguments };
  if (!isMember(callee)) return written;
  const name = memberName(callee);
  const [self, list] = call.arguments;
  if ((name !== "call" && name !== "apply") || self?.type === "SpreadElement") return written;
  const target = unwrapValue(callee.object);
  if (name === "call") return { callee: target, args: call.arguments.slice(1) };
  if (list === undefined) return { callee: target, args: [] };
  const fold = foldValue(list);
  const nullish = fold.kind === "value" && (fold.value === null || fold.value === undefined);
  if (nullish) return { callee: target, args: [] };
  const array = unwrapValue(list);
  if (array.type !== "ArrayExpression") return written;
  return { callee: target, args: array.elements.map((element) => element ?? undefined) };
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
  if (key !== "fails" && key !== "only" && isNullOrNaN(unwrapAll(value))) return true;
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

/** The properties of an options object, those of object literals spread into it included (read
 * as unwrapValue reads a value: `{ ...(0, { skip: 1 }) }`). */
function optionProperties(object: ObjectExpression, judged: Set<Node>): Node[] {
  judged.add(object);
  const out: Node[] = [];
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      const spread = unwrapValue(property.argument);
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

/** Whether the callee a call invokes (invocation) is a test call's, whose options object rule 8
 * judges: one of TEST_CALLS, bare or as a member. */
function isTestCallee(callee: Node): boolean {
  if (callee.type === "Identifier") return TEST_CALLS.has(callee.name);
  return isMember(callee) && TEST_CALLS.has(memberName(callee) ?? "");
}

/** Rule 8 over the arguments a test call invokes its callee with (invocation), each of the first
 * two read as unwrapValue reads a value. */
function judgeOptions(
  call: Call,
  args: Array<Node | undefined>,
  analysis: Analysis,
  judged: Set<Node>,
): void {
  const { found, parents } = analysis;
  for (const index of [0, 1]) {
    const argument = args[index];
    if (argument === undefined) continue;
    const object = unwrapValue(argument);
    if (object.type !== "ObjectExpression") continue;
    const placeholder =
      index === args.length - 2 && isEmptyFunction(args[args.length - 1]) && !holdsCode(object);
    for (const property of optionProperties(object, judged)) {
      const key = keyName(property);
      if (key === null || !OPTION_KEYS.has(key)) continue;
      const exempt =
        placeholder &&
        PLACEHOLDER_KEYS.has(key) &&
        property.type === "ObjectProperty" &&
        !isBoundOrAwaited(property, call, parents);
      if (exempt) continue;
      const refused =
        property.type === "ObjectMethod" ||
        (property.type === "ObjectProperty" && refusedOptionValue(property.value, key));
      if (refused && "key" in property)
        found.push({ anchor: property.key, rule: "option", name: key });
    }
  }
}

/** Rule 8's PLACEHOLDER exemption: whether a node holds a function, method or class anywhere. */
function holdsCode(node: Node): boolean {
  if (isFunctionLike(node) || node.type === "ClassExpression") return true;
  return childrenOf(node).some(holdsCode);
}

/** Rule 8's PLACEHOLDER exemption: whether a plain `=` assignment (binding the node, or a list or
 * object holding it, to a name) or an `await` (whose `then` gets it) sits between a node and the
 * call holding it. */
function isBoundOrAwaited(node: Node, call: Call, parents: Map<Node, Node>): boolean {
  for (let cur = parents.get(node); cur !== undefined && cur !== call; cur = parents.get(cur)) {
    if (cur.type === "AssignmentExpression" || cur.type === "AwaitExpression") return true;
  }
  return false;
}

/** Rule 10: the `type` property that makes an annotation value a skip, or null; the value, each
 * item and the type read as unwrapValue reads a value (`(0, { type: "skip" })`). */
function skipAnnotation(value: Node): Node | null {
  const node = unwrapValue(value);
  const items: Array<Node | null> = node.type === "ArrayExpression" ? node.elements : [node];
  for (const item of items) {
    const object = item === null ? null : unwrapValue(item);
    if (object?.type !== "ObjectExpression") continue;
    for (const property of object.properties) {
      if (property.type !== "ObjectProperty" || keyName(property) !== "type") continue;
      const type = literalKey(unwrapValue(property.value));
      if (type !== null && ANNOTATION_TYPES.has(type)) return property;
    }
  }
  return null;
}

/** The argument of a `require(<arg>)` (an optional call too, `require?.(m)`) or the source of an
 * `import(<arg>)`, awaited or not, each part read as unwrapValue reads it
 * (`await (0, import("node:test"))`, `(0, require)(m)`), whatever the argument is; null when the
 * expression is no such load. */
function loadSource(value: Node): Node | null {
  const node = unwrapValue(value);
  if (node.type === "ImportExpression") return node.source;
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return null;
  const callee = unwrapValue(node.callee);
  const first = node.arguments[0];
  if (callee.type !== "Identifier" || callee.name !== "require" || first === undefined) return null;
  return first;
}

/** Whether an expression is `require("<module>")` or `import("<module>")`, read as loadSource
 * reads a load, the argument as unwrapValue reads it (`require((0, "node:test"))`). */
function loads(value: Node, module: string): boolean {
  const source = loadSource(value);
  return source !== null && literalKey(unwrapValue(source)) === module;
}

/** Rule 11: whether an expression is the global object (GLOBAL_OBJECTS). */
function isGlobalObject(value: Node): boolean {
  const node = unwrapValue(value);
  return node.type === "Identifier" && GLOBAL_OBJECTS.has(node.name);
}

/** Rule 11: whether a destructured value is a module: a `require(` or `import(` of any module, a
 * name bound to one (modules), or the global object (isGlobalObject). */
function isModuleValue(value: Node, modules: ReadonlySet<string>): boolean {
  if (loadSource(value) !== null || isGlobalObject(value)) return true;
  const node = unwrapValue(value);
  return node.type === "Identifier" && modules.has(node.name);
}

/** Whether a statement is a value import of @playwright/test itself: not `import type` or
 * `import typeof`. */
function isPlaywrightImport(statement: Node): statement is ImportDeclaration {
  return (
    statement.type === "ImportDeclaration" &&
    statement.source.value === "@playwright/test" &&
    statement.importKind !== "type" &&
    statement.importKind !== "typeof"
  );
}

/** Whether a top-level statement imports @playwright/test itself (see the header). */
function importsPlaywright(statement: Node): boolean {
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.some(
      (declaration) => declaration.init != null && loads(declaration.init, "@playwright/test"),
    );
  }
  if (!isPlaywrightImport(statement)) return false;
  return statement.specifiers.some(
    (specifier) =>
      specifier.type !== "ImportSpecifier" ||
      (specifier.importKind !== "type" && specifier.importKind !== "typeof"),
  );
}

/** Rule 3: the names a file may call the conditional `.skip(` / `.fail(` on: in a Playwright
 * spec, `test` and each name a top-level value import of @playwright/test binds to its `test`
 * (`import { test as base }`, its default export, `import base` or `import { default as base }`);
 * in any other file, none. */
function playwrightTests(body: Node[]): Set<string> {
  const names = new Set<string>();
  if (!body.some(importsPlaywright)) return names;
  names.add("test");
  for (const statement of body) {
    if (!isPlaywrightImport(statement)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") names.add(specifier.local.name);
      if (specifier.type !== "ImportSpecifier") continue;
      if (specifier.importKind === "type" || specifier.importKind === "typeof") continue;
      const name = importedName(specifier);
      if (name === "test" || name === "default") names.add(specifier.local.name);
    }
  }
  return names;
}

/** Rule 3's exemption: the canonical conditional `test.skip(` / `test.fail(` in a spec, on a name
 * in names (playwrightTests). */
function isConditionalSkip(
  member: Member,
  parents: Map<Node, Node>,
  names: ReadonlySet<string>,
): boolean {
  if (member.type !== "MemberExpression") return false;
  if (member.computed && member.property.type !== "StringLiteral") return false;
  const name = memberName(member);
  if (name !== "skip" && name !== "fail") return false;
  if (member.object.type !== "Identifier" || !names.has(member.object.name)) return false;
  const call = parents.get(member);
  if (call === undefined || call.type !== "CallExpression" || call.callee !== member) return false;
  if (call.typeArguments != null) return false;
  const [first, ...rest] = call.arguments;
  if (!isCondition(first, true)) return false;
  return !rest.some(mayBeFunction);
}

/** Rule 3's exemption: whether a later argument may be a function: one as unwrapValue reads it,
 * an immediately invoked function (as the folder reads one: the strict side), or a conditional or
 * logical expression with a branch or operand that may be one. */
function mayBeFunction(node: Node): boolean {
  const value = unwrapValue(node);
  if (isFunction(value)) return true;
  if (value.type === "ConditionalExpression") {
    return mayBeFunction(value.consequent) || mayBeFunction(value.alternate);
  }
  if (value.type === "LogicalExpression") {
    return mayBeFunction(value.left) || mayBeFunction(value.right);
  }
  return isCall(value) && isFunction(invocation(value).callee);
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

/** Rule 4: the index of the parameter that is the test context of a function passed to a call,
 * through what evaluatesTo steps through (a TypeScript `this` parameter not counted), the call
 * read as it INVOKES (invocation: `.call`'s arguments, the elements of `.apply`'s array literal):
 * 0 for a test call, a hook or a call of a test function, 1 for the call a `.for` table returns
 * (the row comes first), and -1 when the function is no test's or hook's callback. */
function contextIndex(fn: Node, analysis: Analysis): number {
  const { parents, roots, hooks } = analysis;
  const { cur, parent: holder } = climbValue(fn, parents);
  let parent = holder;
  // An element of an array literal: an argument of the call it is `.apply`'s list for.
  if (parent?.type === "ArrayExpression") parent = climbValue(parent, parents).parent;
  if (parent === undefined || !isCall(parent)) return -1;
  const { callee, args } = invocation(parent);
  // The call's callee, `.call`'s or `.apply`'s receiver (`test.call((ctx) => …)`) and an array
  // that is no `.apply` list (`test("x", [(ctx) => …])`) pass no callback: a function that is the
  // call's callee is never a test call's or a hook's own name.
  if (!args.includes(cur)) return -1;
  if (isTestCallee(callee)) return 0;
  if (callee.type === "Identifier" && hooks.has(callee.name)) return 0;
  if (isMember(callee) && HOOKS.has(memberName(callee) ?? "")) return 0;
  if (isTestFunction(callee, roots)) return 0;
  // The function a `.for` table of a test function returns: a call of `<test function>.for`
  // (`test.for(rows)`, `test.for.call(test, rows)`) or a template tagged with it.
  let table: Node | null = null;
  if (isCall(callee)) table = invocation(callee).callee;
  else if (callee.type === "TaggedTemplateExpression") table = unwrapValue(callee.tag);
  const forTable =
    table !== null &&
    isMember(table) &&
    memberName(table) === "for" &&
    isTestFunction(table.object, roots);
  return forTable ? 1 : -1;
}

/** The outermost expression that evaluates to a node (evaluatesTo, as often as it nests), and what
 * holds that expression. */
function climbValue(node: Node, parents: Map<Node, Node>): { cur: Node; parent: Node | undefined } {
  let cur = node;
  let parent = parents.get(cur);
  while (parent !== undefined && evaluatesTo(parent, cur)) {
    cur = parent;
    parent = parents.get(cur);
  }
  return { cur, parent };
}

/** Rule 4: whether a receiver is a test context (see the header). A name is bound by the nearest
 * function having a parameter so named; it is a context when that parameter, a TypeScript `this`
 * parameter not counted, sits at the function's context index. */
function isTestContext(object: Node, analysis: Analysis): boolean {
  const { parents } = analysis;
  const receiver = unwrapValue(object);
  if (receiver.type === "ThisExpression") return true;
  if (receiver.type !== "Identifier") return false;
  if (receiver.name === "t") return true;
  for (let cur = parents.get(receiver); cur !== undefined; cur = parents.get(cur)) {
    if (!("params" in cur)) continue;
    const index = cur.params
      .filter((param) => paramName(param) !== "this")
      .findIndex((param) => paramName(param) === receiver.name);
    if (index !== -1) return index === contextIndex(cur, analysis);
  }
  return false;
}

/** The name a parameter binds when it is a name, with or without a default value, else null. */
function paramName(param: Node): string | null {
  const binding = param.type === "AssignmentPattern" ? param.left : param;
  return binding.type === "Identifier" ? binding.name : null;
}

/** Rules 1 to 7 on a member access. playwright holds the names rule 3's exemption reads
 * (playwrightTests). */
function judgeMember(member: Member, analysis: Analysis, playwright: ReadonlySet<string>): void {
  const name = memberName(member);
  if (name === null) return;
  const { parents, found, roots } = analysis;
  const anchor = member.property;
  if (ANY_RECEIVER.has(name) && isCalled(member, parents)) {
    found.push({ anchor, rule: "focus", name });
  }
  const receiver = unwrapValue(member.object);
  if (
    PREFIXED.has(name) &&
    name !== "fit" &&
    (receiver.type === "Identifier" || loadSource(receiver) !== null) &&
    isCalled(member, parents)
  ) {
    found.push({ anchor, rule: "prefixed", name });
  }
  if (ROOTED_SKIPS.has(name) && isCalled(member, parents) && isRooted(member.object, roots)) {
    if (!isConditionalSkip(member, parents, playwright)) {
      found.push({ anchor, rule: "skip", name });
    }
  }
  if (name === "todo" && isCalled(member, parents) && isRooted(member.object, roots)) {
    if (!isPlannedTodo(member, parents)) found.push({ anchor, rule: "todo", name });
  }
  // A bare `this.skip()` is also rule 4's bare marker, pushed first (calls are judged before
  // members), so it is listed as bare.
  if (
    (name === "skip" || name === "todo") &&
    isCalled(member, parents) &&
    isTestContext(member.object, analysis)
  ) {
    found.push({ anchor, rule: "contextSkip", name });
  }
}

/** Rules 4, 6, 7 and 8 on a call, read as the call it INVOKES (invocation: `(0, x.skip)()`,
 * `test.skipIf.call(test, true)`, `test.apply(null, ["x", { skip: 1 }, fn])`). */
function judgeCall(call: Call, analysis: Analysis, judged: Set<Node>): void {
  const { found } = analysis;
  const { callee: member, args } = invocation(call);
  if (isTestCallee(member)) judgeOptions(call, args, analysis, judged);
  if (!isMember(member)) return;
  const name = memberName(member);
  const anchor = member.property;
  if ((name === "skip" || name === "todo") && args.length === 0) {
    found.push({ anchor, rule: "bare", name });
  }
  if ((name === "skipIf" || name === "runIf") && isRooted(member.object, analysis.roots)) {
    const constant = name === "skipIf" ? constantSkipIf(args[0]) : constantRunIf(args[0]);
    if (constant) found.push({ anchor, rule: name, name });
  }
  const receiver = unwrapValue(member.object);
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
    if (property.type === "ObjectMethod" && property.kind !== "set") {
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
    const name = importedName(specifier);
    if (BINDING_MARKERS.has(name)) found.push({ anchor: specifier, rule: "import", name });
  }
}

function importedName(specifier: ImportSpecifier): string {
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : imported.value;
}

/** Rule 11 on a variable declarator: a destructure of node:test's require or import, or of a test
 * function; and of any other module, a pattern nested under a key in EXPORTED_ROOTS (of the
 * global object, under any ROOT). */
function judgeRequire(node: VariableDeclarator, analysis: Analysis): void {
  if (node.id.type !== "ObjectPattern" || node.init == null) return;
  const { found, roots, modules } = analysis;
  const imported = loads(node.init, "node:test");
  if (imported || isTestFunction(node.init, roots)) {
    judgePattern(node.id, imported ? "import" : "destructure", found);
  } else if (isModuleValue(node.init, modules)) {
    const exported = isGlobalObject(node.init) ? ROOTS : EXPORTED_ROOTS;
    for (const property of node.id.properties) {
      if (property.type !== "ObjectProperty" || !exported.has(keyName(property) ?? "")) continue;
      const value =
        property.value.type === "AssignmentPattern" ? property.value.left : property.value;
      if (value.type === "ObjectPattern") judgePattern(value, "destructure", found);
    }
  }
}

/** Rule 11 over a destructuring pattern: each marker's name, and the names a pattern nested under
 * a test function's key pulls out. */
function judgePattern(pattern: ObjectPattern, rule: string, found: Found[]): void {
  for (const property of pattern.properties) {
    const key = keyName(property);
    const name = key ?? "";
    if (BINDING_MARKERS.has(name)) found.push({ anchor: property, rule, name });
    else if (isTestFunctionKey(key) && property.type === "ObjectProperty") {
      const value =
        property.value.type === "AssignmentPattern" ? property.value.left : property.value;
      if (value.type === "ObjectPattern") judgePattern(value, rule, found);
    }
  }
}

/** Rule 11: whether a destructured value is a test function: a ROOTED chain whose last step is a
 * ROOT, a test modifier, a computed key that is no literal or a LINK call, not data read off one
 * (`context.args`). */
function isTestFunction(value: Node, roots: ReadonlySet<string>): boolean {
  const node = unwrapValue(value);
  if (!isRooted(node, roots)) return false;
  if (!isMember(node)) return true;
  return isTestFunctionKey(memberName(node));
}

/** Rule 11: whether a name read off node:test or a test function is a test function: a ROOT, or
 * `default` (node:test's default export is `test`). */
function isRootKey(name: string): boolean {
  return ROOTS.has(name) || name === "default";
}

/** Rules 4 and 11: whether a key read off node:test or a test function gives a test function: a
 * ROOT, `default`, a test modifier, or null (a computed key that is no literal: the strict
 * side). */
function isTestFunctionKey(name: string | null): boolean {
  return name === null || isRootKey(name) || MODIFIERS.has(name);
}

/** Rules 2, 4 and 11: what a file binds (see the header). */
interface Bindings {
  /** ROOTS and the names bound to node:test or to a test function. */
  roots: Set<string>;
  /** HOOKS and the names bound to a hook. */
  hooks: Set<string>;
  /** PREFIXED and the names bound to one of them: renamed on import or destructured from a
   * module (`import { xit as check } from "@jest/globals"`). */
  prefixed: Set<string>;
  /** The names bound to a module (modulesOf), collected before the others. */
  modules: ReadonlySet<string>;
}

/** Rule 11: what a destructured value is: node:test or a test function ("test"), the global
 * object (isGlobalObject), another module (isModuleValue), or data. */
type Source = "test" | "global" | "module" | "data";

/** Rule 11: what a destructured value is (Source), node:test and a test function first. */
function sourceOf(value: Node, bindings: Bindings): Source {
  if (loads(value, "node:test") || isTestFunction(value, bindings.roots)) return "test";
  if (isGlobalObject(value)) return "global";
  return isModuleValue(value, bindings.modules) ? "module" : "data";
}

/** Rule 11: whether a key of a destructured value (Source) gives a test function: under node:test
 * or a test function, isTestFunctionKey; under the global object, a ROOT (Mocha's globals hold
 * `context`); under another module, a key in EXPORTED_ROOTS; under data, none. */
function isSourceTestKey(key: string | null, source: Source): boolean {
  if (source === "test") return isTestFunctionKey(key);
  if (key === null || source === "data") return false;
  return (source === "global" ? ROOTS : EXPORTED_ROOTS).has(key);
}

/** Rules 2, 4 and 11: the names a destructure binds: to a test function under a key
 * isSourceTestKey accepts (a pattern under one read as under a test function), and as the rest
 * when the value is node:test or a test function ("test"); when it is not data, to a prefixed
 * marker under its key; whatever its value, to a hook under a hook's key. */
function bindPattern(pattern: ObjectPattern, source: Source, bindings: Bindings): void {
  const { roots, hooks, prefixed } = bindings;
  for (const property of pattern.properties) {
    if (property.type === "RestElement") {
      if (source === "test" && property.argument.type === "Identifier") {
        roots.add(property.argument.name);
      }
      continue;
    }
    const key = keyName(property);
    const value =
      property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    const testKey = isSourceTestKey(key, source);
    if (value.type === "Identifier") {
      if (testKey) roots.add(value.name);
      else if (key !== null && HOOKS.has(key)) hooks.add(value.name);
      // Not an `else`: `expectFailure` is a test modifier and a prefixed marker both.
      if (source !== "data" && key !== null && PREFIXED.has(key)) prefixed.add(value.name);
    } else if (value.type === "ObjectPattern" && testKey) {
      bindPattern(value, "test", bindings);
    }
  }
}

/** Rules 2, 4 and 11: what one node binds, into bindings (see the header). */
function bindNode(node: Node, bindings: Bindings): void {
  const { roots, hooks, prefixed } = bindings;
  if (node.type === "ImportDeclaration") {
    if (node.importKind === "type" || node.importKind === "typeof") return;
    const nodeTest = node.source.value === "node:test";
    // @playwright/test's default export is its `test`.
    const playwright = node.source.value === "@playwright/test";
    for (const specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier") {
        const playwrightDefault = playwright && specifier.type === "ImportDefaultSpecifier";
        if (nodeTest || playwrightDefault) roots.add(specifier.local.name);
        continue;
      }
      const name = importedName(specifier);
      const value = specifier.importKind !== "type" && specifier.importKind !== "typeof";
      if (value && HOOKS.has(name)) hooks.add(specifier.local.name);
      if (value && PREFIXED.has(name)) prefixed.add(specifier.local.name);
      if (nodeTest && isTestFunctionKey(name)) roots.add(specifier.local.name);
      const exported = EXPORTED_ROOTS.has(name) || (playwright && name === "default");
      if (value && exported) roots.add(specifier.local.name);
    }
  } else if (node.type === "VariableDeclarator" && node.init != null) {
    if (node.id.type === "Identifier" && loads(node.init, "node:test")) roots.add(node.id.name);
    if (node.id.type === "ObjectPattern") {
      bindPattern(node.id, sourceOf(node.init, bindings), bindings);
    }
  } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
    if (loads(node.right, "node:test")) roots.add(node.left.name);
  }
}

/** Rule 11: the names a file binds to a module: a namespace import of any module that is not
 * `import type`, and a name declared with or assigned a `require(` or `import(` (loadSource). They
 * are collected before the roots, in a pass of their own: the walk visits sibling statements in
 * reverse order, and an import is hoisted above the destructure that reads it. */
function modulesOf(all: Node[]): Set<string> {
  const modules = new Set<string>();
  for (const node of all) {
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type" || node.importKind === "typeof") continue;
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") modules.add(specifier.local.name);
      }
    } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      if (node.init != null && loadSource(node.init) !== null) modules.add(node.id.name);
    } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      if (loadSource(node.right) !== null) modules.add(node.left.name);
    }
  }
  return modules;
}

/** Rules 2, 4 and 11: what a file binds (Bindings). A name bound from a test function can itself
 * be one (`const { describe: d } = test; const { it: i } = d;`), so the walk repeats until a pass
 * adds no root. */
function bindingsOf(all: Node[]): Bindings {
  const bindings: Bindings = {
    roots: new Set(ROOTS),
    hooks: new Set(HOOKS),
    prefixed: new Set(PREFIXED),
    modules: modulesOf(all),
  };
  for (let size = -1; size !== bindings.roots.size; ) {
    size = bindings.roots.size;
    for (const node of all) bindNode(node, bindings);
  }
  return bindings;
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
    roots: ROOTS,
    hooks: HOOKS,
    modules: new Set(),
  };
  const playwright = playwrightTests(program.body);
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
  const { roots, hooks, prefixed, modules } = bindingsOf(all);
  analysis.roots = roots;
  analysis.hooks = hooks;
  analysis.modules = modules;
  const judged = new Set<Node>();
  for (const node of all) {
    if (isCall(node)) judgeCall(node, analysis, judged);
  }
  for (const node of all) {
    if (isMember(node)) judgeMember(node, analysis, playwright);
    else if (node.type === "Identifier" && prefixed.has(node.name)) {
      if (isCalled(node, analysis.parents, MODIFIERS)) {
        analysis.found.push({ anchor: node, rule: "prefixed", name: node.name });
      }
    } else if (node.type === "ObjectExpression") judgeObject(node, analysis.found, judged);
    else if (node.type === "ImportDeclaration") judgeImport(node, analysis.found);
    else if (node.type === "VariableDeclarator") judgeRequire(node, analysis);
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

/** The elements of an array, object or class body, or null for any other node. */
function elementsOf(node: Node): Node[] | null {
  if (node.type === "ArrayExpression") return node.elements.filter((e) => e !== null);
  if (node.type === "ObjectExpression") return node.properties;
  if (node.type === "ClassBody") return node.body;
  return null;
}

/** Whether a node is or holds a function (a test's body: another test, a hook, a helper). */
function holdsFunction(node: Node): boolean {
  const stack: Node[] = [node];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    if (isFunctionLike(cur)) return true;
    stack.push(...childrenOf(cur));
  }
  return false;
}

/** The statements around a unit, outermost last, each with every function body in it elided
 * (its own too): which test and which describe a marker sits in is part of its identity, so a
 * `this.skip();` moved from a skipped test into a running one is new. A test need not be a
 * statement (a table entry, a class method, a property of a mocha exports object), so in each
 * array, object or class body on the way up only the element on the way and the elements that
 * hold no function are written (in order, joined by a fixed separator): the test's own key or
 * title stays in, and a sibling test added, removed or edited leaves the marker alone. */
function contextOf(unit: Node, analysis: Analysis): string {
  const parts: string[] = [];
  // Each array, object or class body on the way up since the last function, with its element on
  // the way. A function's body is elided in every statement around it, and the containers in it
  // with it, so they are dropped there.
  const containers: Array<[Node, Node]> = [];
  let child = unit;
  for (let cur = analysis.parents.get(unit); cur !== undefined; cur = analysis.parents.get(cur)) {
    if (isFunctionLike(cur)) containers.length = 0;
    if (elementsOf(cur) !== null) containers.push([cur, child]);
    child = cur;
    if (cur.type === "BlockStatement" || !/(?:Statement|Declaration)$/.test(cur.type)) continue;
    // The text between the elements kept, the delimiters' insides at both ends included.
    const gaps: Array<[number, number, string]> = [];
    for (const [container, onTheWay] of containers) {
      const kept = (elementsOf(container) ?? []).filter(
        (element) => element === onTheWay || !holdsFunction(element),
      );
      let at = startOf(container) + 1;
      for (const element of kept) {
        gaps.push([at, startOf(element), "\u0002"]);
        at = endOf(element);
      }
      gaps.push([at, endOf(container) - 1, "\u0002"]);
    }
    const bodies =
      isFunctionLike(cur) && "body" in cur && isNode(cur.body)
        ? [[startOf(cur.body), endOf(cur.body)] as [number, number]]
        : elidedBodies(cur, -1);
    // A body in an element left out goes with it.
    const cuts = bodies
      .filter(([start, end]) => !gaps.some(([from, to]) => start >= from && end <= to))
      .map(([start, end]): [number, number, string] => [start, end, ELIDED]);
    parts.push(cutText(cur, [...cuts, ...gaps], analysis));
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
 * (a method's body included), and the first argument of each call it is the callee of, as the
 * call INVOKES it (invocation: `test.skipIf.call(test, () => x)`), or of each `new` (a Playwright
 * condition or fixture callback, a skipIf's condition, else a title). */
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
      const first = isCall(parent) ? invocation(parent).args[0] : parent.arguments[0];
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
