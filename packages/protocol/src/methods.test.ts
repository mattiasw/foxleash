import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillChars } from "./methods.ts";

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
