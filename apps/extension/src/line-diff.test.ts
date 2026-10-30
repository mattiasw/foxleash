import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DiffLine, lineDiff, MAX_DIFF_CELLS } from "./line-diff.ts";

describe("lineDiff", () => {
  it("keeps every line of equal texts", () => {
    assert.deepEqual(lineDiff("a\nb", "a\nb"), [same("a"), same("b")]);
    assert.deepEqual(lineDiff("", ""), [same("")]);
  });

  it("adds the lines after a kept one", () => {
    assert.deepEqual(lineDiff("a", "a\nb\nc"), [same("a"), added("b"), added("c")]);
  });

  it("removes lines down to a kept one", () => {
    assert.deepEqual(lineDiff("a\nb\nc", "c"), [removed("a"), removed("b"), same("c")]);
  });

  it("interleaves kept, removed and added lines", () => {
    assert.deepEqual(lineDiff("a\nb\nc\nd\ne", "a\nx\nc\ne\ny"), [
      same("a"),
      removed("b"),
      added("x"),
      same("c"),
      removed("d"),
      same("e"),
      added("y"),
    ]);
  });

  it("adds a line before the first common one when that keeps the most lines", () => {
    assert.deepEqual(lineDiff("a\nb", "c\na\nd"), [
      added("c"),
      same("a"),
      removed("b"),
      added("d"),
    ]);
  });

  it("shows a trailing line break as a removed empty line", () => {
    assert.deepEqual(lineDiff("a\n", "a"), [same("a"), removed("")]);
    assert.deepEqual(lineDiff("a", "a\n"), [same("a"), added("")]);
  });

  it("keeps the common start and end around a changed middle", () => {
    assert.deepEqual(lineDiff("p\nq\nold\nr\ns", "p\nq\nnew\nr\ns"), [
      same("p"),
      same("q"),
      removed("old"),
      added("new"),
      same("r"),
      same("s"),
    ]);
  });

  it("does not let the end overlap the start when one text repeats the other's lines", () => {
    assert.deepEqual(lineDiff("a\na", "a\na\na"), [same("a"), same("a"), added("a")]);
    assert.deepEqual(lineDiff("a\na\na", "a"), [same("a"), removed("a"), removed("a")]);
  });

  it("finds the longest common lines with a table at the cell cap", () => {
    // 1,999 lines a side: (1,999 + 1) * (1,999 + 1) cells, exactly the cap.
    assert.equal(2000 * 2000, MAX_DIFF_CELLS);
    const { before, after, common } = crossed(1999, 1999);
    const diff = lineDiff(before, after);
    assert.equal(diff.filter(({ kind }) => kind === "same").length, common);
    assertDiffOf(diff, before, after);
  });

  it("shows the middle as removed then added once the table would pass the cap", () => {
    const { before, after, common } = crossed(2000, 1999);
    assert.ok(common > 0);
    const diff = lineDiff(before, after);
    assert.deepEqual(diff, [...before.split("\n").map(removed), ...after.split("\n").map(added)]);
  });

  it("answers 20,000 different lines a side within a second", () => {
    const before = Array.from({ length: 20_000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const after = Array.from({ length: 20_000 }, (_, i) => String.fromCodePoint(0xac00 + i));
    const started = performance.now();
    const diff = lineDiff(before.join("\n"), after.join("\n"));
    assert.ok(performance.now() - started < 1000);
    assert.deepEqual(diff, [...before.map(removed), ...after.map(added)]);
  });
});

function same(text: string): DiffLine {
  return { kind: "same", text };
}

function removed(text: string): DiffLine {
  return { kind: "removed", text };
}

function added(text: string): DiffLine {
  return { kind: "added", text };
}

/**
 * Texts of `n` and `m` lines with no common first or last line, whose longest common
 * subsequence is `common` lines: the odd lines of one are the even lines of the other.
 */
function crossed(n: number, m: number): { before: string; after: string; common: number } {
  const before = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `b${i}` : `k${i}`));
  const after = Array.from({ length: m }, (_, i) => (i % 2 === 0 ? `a${i}` : `k${i}`));
  // The kept lines are those at odd indexes below both lengths.
  const common = Math.floor(Math.min(n, m) / 2);
  return { before: before.join("\n"), after: after.join("\n"), common };
}

/** The kept and removed lines make `before`, the kept and added lines make `after`. */
function assertDiffOf(diff: DiffLine[], before: string, after: string): void {
  const of = (kinds: DiffLine["kind"][]) =>
    diff
      .filter(({ kind }) => kinds.includes(kind))
      .map(({ text }) => text)
      .join("\n");
  assert.equal(of(["same", "removed"]), before);
  assert.equal(of(["same", "added"]), after);
}
