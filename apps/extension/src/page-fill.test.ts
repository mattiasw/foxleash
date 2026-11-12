import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_FILL_CHARS, MAX_FILL_FIELDS, MAX_TYPE_CHARS } from "@foxleash/protocol";
import {
  type FillFormOptions,
  fillFormOptions,
  fillFormResultOf,
  type MatchableOption,
  optionMatcher,
} from "./page-fill.ts";

const REF = "0a1b2c3d-4";
const OTHER = "0a1b2c3d-5";
const FIELDS = "fill_form needs fields to be a list of 1 to 50 fields.";
const TOTAL =
  "fill_form takes at most 100000 characters across all values, each string counting at least one.";
const DUPLICATE = "fill_form takes each ref at most once.";

function valueRefusal(position: number): string {
  return `fill_form needs the value of field ${position} to be a string of at most 50000 characters, true or false, or a list of such strings.`;
}

function entryRefusal(position: number): string {
  return `fill_form needs field ${position} to be an object with a ref and a value.`;
}

function refRefusal(position: number): string {
  return `fill_form needs ref of field ${position} to be a string.`;
}

/** Fields with distinct refs, one per value. */
function fieldsOf(values: readonly unknown[]): { ref: string; value: unknown }[] {
  return values.map((value, index) => ({ ref: `0a1b2c3d-${index + 1}`, value }));
}

describe("fillFormOptions", () => {
  it("rebuilds a valid request from own fields only, with lists copied", () => {
    const list = ["a", "b"];
    const params = {
      fields: [
        { ref: REF, value: "hello", extra: true },
        { ref: OTHER, value: list },
        { ref: "0a1b2c3d-6", value: true },
        { ref: "0a1b2c3d-7", value: false },
        { ref: "0a1b2c3d-8", value: "" },
        { ref: "0a1b2c3d-9", value: [] },
      ],
      extra: 1,
    };
    const options = fillFormOptions(params);
    assert.deepEqual(options, {
      fields: [
        { ref: REF, value: "hello" },
        { ref: OTHER, value: ["a", "b"] },
        { ref: "0a1b2c3d-6", value: true },
        { ref: "0a1b2c3d-7", value: false },
        { ref: "0a1b2c3d-8", value: "" },
        { ref: "0a1b2c3d-9", value: [] },
      ],
    });
    assert.ok(typeof options !== "string");
    assert.notEqual(options.fields[1]?.value, list);
    assert.notEqual(options.fields, params.fields);
  });

  it("refuses fields that are missing, inherited, not a list, empty or too many", () => {
    const one = [{ ref: REF, value: "a" }];
    for (const params of [
      {},
      Object.create({ fields: one }),
      { fields: "a" },
      { fields: { 0: one[0], length: 1 } },
      { fields: null },
      { fields: [] },
      { fields: fieldsOf(Array.from({ length: MAX_FILL_FIELDS + 1 }, () => true)) },
    ]) {
      assert.equal(fillFormOptions(params), FIELDS, JSON.stringify(params));
    }
    const most = fieldsOf(Array.from({ length: MAX_FILL_FIELDS }, () => true));
    assert.deepEqual(fillFormOptions({ fields: most }), { fields: most });
  });

  it("refuses a hole in fields", () => {
    const fields: unknown[] = [{ ref: REF, value: "a" }];
    fields[2] = { ref: OTHER, value: "b" };
    assert.equal(fillFormOptions({ fields }), entryRefusal(2));
  });

  it("refuses an entry that is not an object", () => {
    for (const entry of [null, "a", 3, ["ref", "value"], true]) {
      assert.equal(
        fillFormOptions({ fields: [{ ref: REF, value: "a" }, entry] }),
        entryRefusal(2),
        JSON.stringify(entry),
      );
    }
  });

  it("refuses an entry whose ref is missing, inherited or not a string", () => {
    for (const entry of [
      { value: "a" },
      Object.assign(Object.create({ ref: REF }), { value: "a" }),
      { ref: 4, value: "a" },
      { ref: null, value: "a" },
    ]) {
      assert.equal(fillFormOptions({ fields: [entry] }), refRefusal(1));
    }
  });

  it("refuses a value that is not a string, a boolean or a list of strings", () => {
    const sparse: unknown[] = ["a"];
    sparse[2] = "b";
    for (const value of [3, null, undefined, {}, { 0: "a", length: 1 }, ["a", 3], [null], sparse]) {
      assert.equal(
        fillFormOptions({
          fields: [
            { ref: REF, value: "a" },
            { ref: OTHER, value },
          ],
        }),
        valueRefusal(2),
        String(value),
      );
    }
    assert.equal(fillFormOptions({ fields: [{ ref: REF }] }), valueRefusal(1));
    const inherited = Object.assign(Object.create({ value: "a" }), { ref: REF });
    assert.equal(fillFormOptions({ fields: [inherited] }), valueRefusal(1));
  });

  it("takes a string or option of the most characters and refuses one more", () => {
    const longest = "a".repeat(MAX_TYPE_CHARS);
    const over = `${longest}a`;
    for (const value of [longest, [longest]]) {
      assert.deepEqual(fillFormOptions({ fields: [{ ref: REF, value }] }), {
        fields: [{ ref: REF, value }],
      });
    }
    for (const value of [over, ["a", over]]) {
      assert.equal(fillFormOptions({ fields: [{ ref: REF, value }] }), valueRefusal(1));
    }
  });

  it("refuses a ref given twice", () => {
    assert.equal(
      fillFormOptions({
        fields: [
          { ref: REF, value: "a" },
          { ref: OTHER, value: true },
          { ref: REF, value: "b" },
        ],
      }),
      DUPLICATE,
    );
  });

  it("takes values of the most characters in all and refuses one more", () => {
    const half = "a".repeat(MAX_FILL_CHARS / 2);
    const most = fieldsOf([half, true, half.slice(1), ""]);
    assert.deepEqual(fillFormOptions({ fields: most }), { fields: most });
    assert.equal(fillFormOptions({ fields: fieldsOf([half, half, ""]) }), TOTAL);
    assert.equal(fillFormOptions({ fields: fieldsOf([half, [half, "a"]]) }), TOTAL);
  });

  it("counts every empty option string against the total", () => {
    const empties = Array.from({ length: MAX_FILL_CHARS + 1 }, () => "");
    assert.equal(fillFormOptions({ fields: [{ ref: REF, value: empties }] }), TOTAL);
    assert.deepEqual(fillFormOptions({ fields: [{ ref: REF, value: empties.slice(1) }] }), {
      fields: [{ ref: REF, value: empties.slice(1) }],
    });
  });
});

describe("fillFormResultOf", () => {
  const options: FillFormOptions = {
    fields: [
      { ref: REF, value: "a" },
      { ref: OTHER, value: true },
    ],
  };
  const ok = (ref: string, outcome: string) => ({ ref, ok: true, outcome });
  const failed = (ref: string, code: string, message: unknown = "No.") => ({
    ref,
    ok: false,
    code,
    message,
  });

  it("passes each outcome and an error, rebuilt from their own fields", () => {
    for (const outcome of ["typed", "selected", "clicked", "unchanged"]) {
      assert.deepEqual(
        fillFormResultOf({ fields: [ok(REF, outcome), failed(OTHER, "no_effect")] }, options),
        { fields: [ok(REF, outcome), failed(OTHER, "no_effect")] },
      );
    }
  });

  it("drops a value or method the page adds", () => {
    const reply = {
      fields: [
        { ...ok(REF, "typed"), value: "secret", method: "exec_command" },
        { ...failed(OTHER, "not_editable"), value: "secret", outcome: "typed" },
      ],
      extra: true,
    };
    assert.deepEqual(fillFormResultOf(reply, options), {
      fields: [ok(REF, "typed"), failed(OTHER, "not_editable")],
    });
  });

  it("cuts a long message to 500 characters", () => {
    const result = fillFormResultOf(
      { fields: [ok(REF, "typed"), failed(OTHER, "no_effect", "x".repeat(600))] },
      options,
    );
    assert.deepEqual(result?.fields[1], failed(OTHER, "no_effect", "x".repeat(500)));
  });

  it("passes every field code", () => {
    for (const code of [
      "invalid_params",
      "invalid_ref",
      "stale_ref",
      "ref_not_found",
      "not_editable",
      "no_effect",
      "not_attempted",
      "page_error",
    ]) {
      assert.deepEqual(
        fillFormResultOf({ fields: [failed(REF, code), ok(OTHER, "clicked")] }, options),
        { fields: [failed(REF, code), ok(OTHER, "clicked")] },
        code,
      );
    }
  });

  it("refuses a reply that is not one", () => {
    const good = ok(OTHER, "clicked");
    const holey: unknown[] = [ok(REF, "typed")];
    holey.length = 2;
    for (const reply of [
      undefined,
      null,
      "done",
      [ok(REF, "typed"), good],
      {},
      Object.create({ fields: [ok(REF, "typed"), good] }),
      { fields: { 0: ok(REF, "typed"), 1: good, length: 2 } },
      { fields: [ok(REF, "typed")] },
      { fields: [ok(REF, "typed"), good, good] },
      { fields: [ok("0a1b2c3d-6", "typed"), good] },
      { fields: [good, ok(REF, "typed")] },
      { fields: [{ ref: REF, outcome: "typed" }, good] },
      { fields: [{ ref: REF, ok: "yes", outcome: "typed" }, good] },
      { fields: [ok(REF, "filled"), good] },
      { fields: [{ ref: REF, ok: true }, good] },
      { fields: [failed(REF, "page_changed"), good] },
      { fields: [failed(REF, "no_effect", 3), good] },
      { fields: [{ ref: REF, ok: false, code: "no_effect" }, good] },
      { fields: [{ ref: REF, ok: false, message: "No." }, good] },
      { fields: [Object.create(ok(REF, "typed")), good] },
      {
        fields: [Object.assign(Object.create({ ref: REF }), { ok: true, outcome: "typed" }), good],
      },
      { fields: [null, good] },
      { fields: holey },
    ]) {
      assert.equal(fillFormResultOf(reply, options), undefined, JSON.stringify(reply));
    }
  });
});

describe("optionMatcher", () => {
  const option = (value: string, label: string, disabled = false): MatchableOption => ({
    value,
    label,
    disabled,
  });

  it("matches a value before a label", () => {
    const match = optionMatcher([option("b", "Apple"), option("a", "b")]);
    assert.equal(match("b"), 0);
    assert.equal(match("a"), 1);
  });

  it("matches a label when no value matches", () => {
    const match = optionMatcher([option("1", "One"), option("2", "Two")]);
    assert.equal(match("Two"), 1);
    assert.equal(match("One"), 0);
  });

  it("takes the first enabled option among several that match", () => {
    const match = optionMatcher([
      option("x", "First", true),
      option("x", "Second"),
      option("x", "Third"),
      option("y", "Same", true),
      option("z", "Same"),
      option("w", "Same"),
    ]);
    assert.equal(match("x"), 1);
    assert.equal(match("Same"), 4);
  });

  it("says disabled when every option whose value matches is, even when a label matches", () => {
    const match = optionMatcher([
      option("x", "One", true),
      option("x", "Two", true),
      option("y", "x"),
    ]);
    assert.equal(match("x"), "disabled");
    assert.equal(optionMatcher([option("1", "Off", true)])("Off"), "disabled");
  });

  it("says none when no value or label matches, comparing exactly", () => {
    const match = optionMatcher([option("a", "Apple")]);
    assert.equal(match("b"), "none");
    assert.equal(match("A"), "none");
    assert.equal(match("apple"), "none");
    assert.equal(match(" a"), "none");
    assert.equal(optionMatcher([])("a"), "none");
  });

  it("matches an empty string to a placeholder option's empty value", () => {
    const match = optionMatcher([option("", "Choose one"), option("a", "")]);
    assert.equal(match(""), 0);
  });
});
