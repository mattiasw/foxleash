# 0026: `wait_for` refuses selectors on attributes that mirror field values

**Status:** Accepted, 2026-10-24. Extends [0010](0010-page-tools-withhold-credential-field-values.md).

## Context

ADR 0010 says `wait_for` returns no field values. Its selector condition answers only yes or
no, but an attribute selector asked again and again (`[value^="a"]`, `[value^="b"]`, ...) reads
a value the page mirrors into an attribute one character at a time. So `wait_for` refuses a
selector that contains `[` and `value`, after decoding CSS escapes and folding ASCII case; no
record stated that rule until this one.

Angular development builds copy the first 30 characters of a bound value into `ng-reflect-*`
attributes (`ng-reflect-model` for `ngModel`): up to Angular 19 always, from Angular 20 only
when the app adds `provideNgReflectAttributes()`; production builds never do. This was read in
the published `@angular/core` 19.2.0 and 20.0.0 code (`setNgReflectProperty`,
`normalizeDebugBindingValue`, `NG_REFLECT_ATTRS_FLAG`). So
`input[type=password][ng-reflect-model^="a"]` could test a password on an approved Angular
development server, such as a developer's own app on localhost.

## Decision

`waitCondition` in `apps/extension/src/handlers.ts` refuses, with `invalid_params` and before
any request to the page, a selector that contains `[` and, after decoding CSS escapes and
folding ASCII letters to lower case, contains `value` (tested first, with its existing message)
or `ng-reflect` (with its own message). `ng-reflect` covers every Angular mirror attribute,
since they all share that prefix. The `wait_for` tool description and the README state the
rule.

## Alternatives rejected

- **Refuse attribute selectors on protected fields altogether.** The handler sees only the
  selector string, not the element it would match; a selector reaches a protected field
  indirectly through `:has()` and sibling combinators; and refusing all attribute selectors
  would refuse ordinary waits like `[data-testid=x]`.
- **A longer list of guessed mirror attributes.** React mirrors into `value`, already refused;
  `data-value`-style attributes contain `value`, already refused; no other mainstream
  framework is known to mirror values into attributes. A new one is a new entry when reported.

## Consequences

- Only known mirrors are caught. A page's own scripts that copy a value into an attribute of
  another name are not, as ADR 0010 already accepts for copies the page makes.
- Any selector with `[` and the substring is refused, also when it tests nothing of the kind
  (`[title="ng-reflect"]`, `[ng-reflected]`); the agent waits on text or another selector
  instead.
- A framework reported to mirror values into another attribute is a new word in the same
  check.
