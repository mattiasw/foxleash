import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FoundLines, fillChars, foundLinesOf, READ_PAGE_MAX_MATCHES } from "./methods.ts";

describe("fillChars", () => {
  it("counts nothing for a checkbox's or radio's state", () => {
    assert.equal(fillChars([{ value: true }, { value: false }]), 0);
  });

  it("counts a string's length, and an empty string as one", () => {
    assert.equal(fillChars([{ value: "abc" }]), 3);
    assert.equal(fillChars([{ value: "" }]), 1);
  });

  it("counts each entry of a list the same way", () => {
    assert.equal(fillChars([{ value: ["ab", "", "cde"] }]), 6);
    assert.equal(fillChars([{ value: [] }]), 0);
  });

  it("adds up a mixed request", () => {
    assert.equal(
      fillChars([{ value: "hello" }, { value: true }, { value: ["a", ""] }, { value: "" }]),
      8,
    );
  });

  it("counts a string by its UTF-16 units", () => {
    assert.equal(fillChars([{ value: "\u{1F600}" }]), 2);
  });
});

describe("foundLinesOf", () => {
  const many = Array.from({ length: 25 }, (_, index) => `link "${index}"`).join("\n");

  it("accepts consistent counts as a fresh object without other keys", () => {
    assert.deepEqual(foundLinesOf({ shown: 0, matches: 0, searched: 0 }, "", false), {
      shown: 0,
      matches: 0,
      searched: 0,
    });
    const given = { shown: 20, matches: 970, searched: 4001, extra: "page text" };
    const found = foundLinesOf(given, many, false);
    assert.deepEqual(found, { shown: 20, matches: 970, searched: 4001 });
    assert.notEqual(found, given);
    assert.deepEqual(Object.keys(found ?? {}), ["shown", "matches", "searched"]);
    assert.deepEqual(foundLinesOf({ shown: 3, matches: 3, searched: 3 }, "a\nb\nc", false), {
      shown: 3,
      matches: 3,
      searched: 3,
    });
  });

  it("refuses what is not an object of three own counts", () => {
    const counts = { shown: 1, matches: 2, searched: 3 };
    assert.deepEqual(foundLinesOf(counts, "main", true), counts);
    const cases: unknown[] = [
      undefined,
      null,
      [],
      [1, 2, 3],
      "counts",
      3,
      { matches: 2, searched: 3 },
      { shown: 1, searched: 3 },
      { shown: 1, matches: 2 },
      Object.create(counts),
      JSON.parse('{"__proto__": {"shown": 1, "matches": 2, "searched": 3}}'),
      { ...counts, shown: "1" },
      { ...counts, matches: null },
      { ...counts, searched: 3.5 },
      { ...counts, shown: Number.NaN },
      { ...counts, searched: Number.POSITIVE_INFINITY },
      { ...counts, searched: 2 ** 53 },
      { ...counts, shown: -1 },
    ];
    for (const value of cases) {
      assert.equal(foundLinesOf(value, "main", true), undefined, String(value));
    }
  });

  it("refuses counts that cannot all be true", () => {
    assert.equal(foundLinesOf({ shown: 3, matches: 2, searched: 50 }, many, true), undefined);
    assert.equal(foundLinesOf({ shown: 1, matches: 60, searched: 50 }, many, true), undefined);
    assert.equal(READ_PAGE_MAX_MATCHES, 20);
    assert.equal(foundLinesOf({ shown: 21, matches: 100, searched: 100 }, many, true), undefined);
    assert.deepEqual(foundLinesOf({ shown: 20, matches: 100, searched: 100 }, many, true), {
      shown: 20,
      matches: 100,
      searched: 100,
    });
  });

  it("refuses counts the tree they came with cannot have", () => {
    const cases: [FoundLines, string, boolean, boolean][] = [
      // No match: nothing written, so nothing cut.
      [{ shown: 0, matches: 0, searched: 5 }, "", false, true],
      [{ shown: 0, matches: 0, searched: 5 }, "main", false, false],
      [{ shown: 0, matches: 0, searched: 5 }, "", true, false],
      // A match: at least the start of its first ancestor line is written.
      [{ shown: 3, matches: 3, searched: 3 }, "", false, false],
      [{ shown: 0, matches: 3, searched: 3 }, "", true, false],
      // Every match up to the cap is shown unless the tree is full.
      [{ shown: 0, matches: 9, searched: 9 }, "main", false, false],
      [{ shown: 0, matches: 9, searched: 9 }, "main", true, true],
      [{ shown: 2, matches: 3, searched: 3 }, "main", false, false],
      [{ shown: 19, matches: 30, searched: 40 }, many, false, false],
      [{ shown: 19, matches: 30, searched: 40 }, many, true, true],
      [{ shown: 20, matches: 30, searched: 40 }, many, false, true],
      // Every line written is searched, and every match shown is a line.
      [{ shown: 20, matches: 20, searched: 20 }, "main", false, false],
      [{ shown: 1, matches: 1, searched: 1 }, "a\nb\nc", false, false],
      [{ shown: 1, matches: 1, searched: 3 }, "a\nb\nc", false, true],
      [{ shown: 3, matches: 3, searched: 3 }, "a\nb\nc", false, true],
    ];
    for (const [counts, tree, truncated, accepted] of cases) {
      assert.deepEqual(
        foundLinesOf(counts, tree, truncated),
        accepted ? counts : undefined,
        JSON.stringify([counts, tree, truncated]),
      );
    }
  });
});
