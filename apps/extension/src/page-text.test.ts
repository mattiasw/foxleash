import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageText } from "@foxhand/protocol";
import { composePageText, pageTextOf, pageTextOptions, tidyText } from "./page-text.ts";

const REFUSAL = "get_page_text needs maxChars to be a whole number from 1 to 200000.";
// U+1F600, two UTF-16 units.
const PAIR = "\u{1F600}";

describe("tidyText", () => {
  it("makes CRLF and lone CR line ends LF", () => {
    assert.equal(tidyText("a\r\nb\rc\nd"), "a\nb\nc\nd");
  });

  it("drops trailing spaces and tabs from each line", () => {
    assert.equal(tidyText("a \t\nb  \nc"), "a\nb\nc");
  });

  it("collapses three or more line breaks to two, also across blank lines with spaces", () => {
    assert.equal(tidyText("a\n\n\nb\n\n\n\n\nc"), "a\n\nb\n\nc");
    assert.equal(tidyText("a\n  \n \t \nb"), "a\n\nb");
  });

  it("keeps two line breaks and the spaces inside a line", () => {
    assert.equal(tidyText("a  b\n\n  c   d"), "a  b\n\n  c   d");
  });

  it("trims the whole text", () => {
    assert.equal(tidyText(" \n\t a\nb \n\n "), "a\nb");
  });

  it("tidies a long run of spaces inside a line in linear time", () => {
    const text = `${" ".repeat(200_000)}x`;
    const start = performance.now();
    assert.equal(tidyText(text), "x");
    assert.equal(tidyText(`a${text}\n`), `a${text}`);
    assert.ok(performance.now() - start < 1000);
  });
});

describe("composePageText", () => {
  it("returns tidied text under the budget unchanged", () => {
    assert.deepEqual(composePageText("article", " Story \r\n\n\n\nText ", "Menu\t", 100), {
      source: "article",
      main: "Story\n\nText",
      rest: "Menu",
      truncated: false,
      totalChars: 15,
    });
  });

  it("fills the budget exactly without cutting", () => {
    assert.deepEqual(composePageText("main", "abc", "de", 5), {
      source: "main",
      main: "abc",
      rest: "de",
      truncated: false,
      totalChars: 5,
    });
  });

  it("cuts a main over the budget and leaves the rest empty", () => {
    assert.deepEqual(composePageText("main", "abcdef", "rest", 4), {
      source: "main",
      main: "abcd",
      rest: "",
      truncated: true,
      totalChars: 10,
    });
  });

  it("cuts the rest to what main leaves", () => {
    assert.deepEqual(composePageText("role_main", "abc", "defgh", 5), {
      source: "role_main",
      main: "abc",
      rest: "de",
      truncated: true,
      totalChars: 8,
    });
  });

  it("keeps a surrogate pair whole when main is cut there, and the rest empty", () => {
    assert.deepEqual(composePageText("body", `ab${PAIR}cd`, "rest", 3), {
      source: "body",
      main: "ab",
      rest: "",
      truncated: true,
      totalChars: 10,
    });
  });

  it("keeps a surrogate pair whole when the rest is cut there", () => {
    assert.deepEqual(composePageText("largest_block", "ab", `c${PAIR}d`, 4), {
      source: "largest_block",
      main: "ab",
      rest: "c",
      truncated: true,
      totalChars: 6,
    });
  });

  it("gives empty texts for empty input", () => {
    assert.deepEqual(composePageText("body", "", "", 1), {
      source: "body",
      main: "",
      rest: "",
      truncated: false,
      totalChars: 0,
    });
  });
});

describe("pageTextOptions", () => {
  it("gives the default when maxChars is missing", () => {
    assert.deepEqual(pageTextOptions({}), { maxChars: 50_000 });
  });

  it("accepts whole numbers from 1 to 200000", () => {
    assert.deepEqual(pageTextOptions({ maxChars: 1 }), { maxChars: 1 });
    assert.deepEqual(pageTextOptions({ maxChars: 200_000 }), { maxChars: 200_000 });
  });

  it("refuses anything else with its sentence", () => {
    for (const maxChars of [
      0,
      200_001,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      "100",
      null,
      true,
    ]) {
      assert.equal(pageTextOptions({ maxChars }), REFUSAL, String(maxChars));
    }
  });

  it("does not read an inherited maxChars", () => {
    assert.deepEqual(pageTextOptions(Object.create({ maxChars: 5 })), { maxChars: 50_000 });
  });
});

describe("pageTextOf", () => {
  const valid: PageText = {
    source: "main",
    main: "Story",
    rest: "Menu",
    truncated: false,
    totalChars: 9,
  };

  it("returns a fresh object with exactly the five fields", () => {
    const reply = { ...valid, extra: "page text" };
    const text = pageTextOf(reply, 100);
    assert.notEqual(text, reply);
    assert.deepEqual(text, valid);
    assert.deepEqual(Object.keys(text ?? {}), [
      "source",
      "main",
      "rest",
      "truncated",
      "totalChars",
    ]);
  });

  it("accepts every source", () => {
    for (const source of ["main", "role_main", "article", "largest_block", "body"] as const) {
      assert.deepEqual(pageTextOf({ ...valid, source }, 100), { ...valid, source });
    }
  });

  it("accepts a totalChars of 0", () => {
    const empty = { ...valid, main: "", rest: "", totalChars: 0 };
    assert.deepEqual(pageTextOf(empty, 100), empty);
  });

  it("refuses what is not an object", () => {
    for (const reply of [undefined, null, "text", 3, [valid]]) {
      assert.equal(pageTextOf(reply, 100), undefined, String(reply));
    }
  });

  it("refuses a field of the wrong type or value", () => {
    const replies: unknown[] = [
      { ...valid, source: "header" },
      { ...valid, source: undefined },
      { ...valid, main: 1 },
      { ...valid, main: undefined },
      { ...valid, rest: null },
      { ...valid, rest: undefined },
      { ...valid, truncated: "false" },
      { ...valid, truncated: undefined },
      { ...valid, totalChars: "9" },
      { ...valid, totalChars: undefined },
      { ...valid, totalChars: -1 },
      { ...valid, totalChars: 1.5 },
      { ...valid, totalChars: 2 ** 53 },
      { ...valid, totalChars: Number.NaN },
    ];
    for (const reply of replies) {
      assert.equal(pageTextOf(reply, 100), undefined, JSON.stringify(reply));
    }
  });

  it("does not read inherited fields", () => {
    assert.equal(pageTextOf(Object.create(valid), 100), undefined);
    for (const key of Object.keys(valid)) {
      const own = Object.fromEntries(Object.entries(valid).filter(([other]) => other !== key));
      const reply: unknown = Object.assign(Object.create({ [key]: Reflect.get(valid, key) }), own);
      assert.equal(pageTextOf(reply, 100), undefined, key);
    }
  });

  it("cuts an oversize main again and leaves the rest empty", () => {
    assert.deepEqual(pageTextOf({ ...valid, main: "abcdef" }, 4), {
      ...valid,
      main: "abcd",
      rest: "",
      truncated: true,
    });
  });

  it("cuts an oversize rest again to what main leaves", () => {
    assert.deepEqual(pageTextOf({ ...valid, main: "ab", rest: "cdef" }, 4), {
      ...valid,
      main: "ab",
      rest: "cd",
      truncated: true,
    });
  });

  it("keeps the reply's own truncated flag when the text fits", () => {
    assert.deepEqual(pageTextOf({ ...valid, truncated: true }, 9), { ...valid, truncated: true });
    assert.deepEqual(pageTextOf(valid, 9), valid);
  });
});
