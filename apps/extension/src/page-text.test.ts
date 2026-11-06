import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageText } from "@foxhand/protocol";
import {
  composePageText,
  type PageTextOptions,
  pageTextOf,
  pageTextOptions,
  tidyText,
} from "./page-text.ts";

const REFUSAL = "get_page_text needs maxChars to be a whole number from 1 to 200000.";
const OFFSET_REFUSAL = "get_page_text needs offset to be a whole number of 0 or more.";
// U+1F600, two UTF-16 units.
const PAIR = "\u{1F600}";
const FIVE_KEYS = ["source", "main", "rest", "truncated", "totalChars"];

function options(maxChars: number, offset = 0): PageTextOptions {
  return { maxChars, offset };
}

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
    assert.deepEqual(composePageText("article", " Story \r\n\n\n\nText ", "Menu\t", options(100)), {
      source: "article",
      main: "Story\n\nText",
      rest: "Menu",
      truncated: false,
      totalChars: 15,
    });
  });

  it("fills the budget exactly without cutting", () => {
    assert.deepEqual(composePageText("main", "abc", "de", options(5)), {
      source: "main",
      main: "abc",
      rest: "de",
      truncated: false,
      totalChars: 5,
    });
  });

  it("cuts a main over the budget and leaves the rest empty", () => {
    assert.deepEqual(composePageText("main", "abcdef", "rest", options(4)), {
      source: "main",
      main: "abcd",
      rest: "",
      truncated: true,
      totalChars: 10,
      nextOffset: 4,
    });
  });

  it("cuts the rest to what main leaves", () => {
    assert.deepEqual(composePageText("role_main", "abc", "defgh", options(5)), {
      source: "role_main",
      main: "abc",
      rest: "de",
      truncated: true,
      totalChars: 8,
      nextOffset: 5,
    });
  });

  it("keeps a surrogate pair whole when main is cut there, and the rest empty", () => {
    assert.deepEqual(composePageText("body", `ab${PAIR}cd`, "rest", options(3)), {
      source: "body",
      main: "ab",
      rest: "",
      truncated: true,
      totalChars: 10,
      nextOffset: 2,
    });
  });

  it("keeps a surrogate pair whole when the rest is cut there", () => {
    assert.deepEqual(composePageText("largest_block", "ab", `c${PAIR}d`, options(4)), {
      source: "largest_block",
      main: "ab",
      rest: "c",
      truncated: true,
      totalChars: 6,
      nextOffset: 3,
    });
  });

  it("gives empty texts for empty input", () => {
    assert.deepEqual(composePageText("body", "", "", options(1)), {
      source: "body",
      main: "",
      rest: "",
      truncated: false,
      totalChars: 0,
    });
  });
});

describe("composePageText with an offset", () => {
  it("returns a window inside main, cut at both ends, with the rest empty", () => {
    assert.deepEqual(composePageText("main", "abcdefgh", "rest", options(3, 2)), {
      source: "main",
      main: "cde",
      rest: "",
      truncated: true,
      totalChars: 12,
      nextOffset: 5,
    });
  });

  it("returns a window from inside main into the rest", () => {
    assert.deepEqual(composePageText("main", "abcdef", "ghij", options(4, 4)), {
      source: "main",
      main: "ef",
      rest: "gh",
      truncated: true,
      totalChars: 10,
      nextOffset: 8,
    });
  });

  it("starts the rest at its first character for an offset at main's end", () => {
    const text = composePageText("main", "abcdef", "ghij", options(4, 6));
    assert.deepEqual(text, {
      source: "main",
      main: "",
      rest: "ghij",
      truncated: false,
      totalChars: 10,
    });
    assert.deepEqual(Object.keys(text), FIVE_KEYS);
  });

  it("returns an empty main for a window that starts inside the rest", () => {
    const text = composePageText("article", "abcdef", "ghij", options(2, 7));
    assert.deepEqual(text, {
      source: "article",
      main: "",
      rest: "hi",
      truncated: true,
      totalChars: 10,
      nextOffset: 9,
    });
    assert.deepEqual(Object.keys(text), [...FIVE_KEYS, "nextOffset"]);
  });

  it("is not truncated when the window ends exactly at the end of the text", () => {
    assert.deepEqual(composePageText("main", "abcdef", "ghij", options(8, 2)), {
      source: "main",
      main: "cdef",
      rest: "ghij",
      truncated: false,
      totalChars: 10,
    });
  });

  it("returns empty text, not truncated, for an offset at or past the end", () => {
    for (const offset of [10, 11, Number.MAX_SAFE_INTEGER]) {
      const text = composePageText("main", "abcdef", "ghij", options(4, offset));
      assert.deepEqual(
        text,
        { source: "main", main: "", rest: "", truncated: false, totalChars: 10 },
        String(offset),
      );
      assert.deepEqual(Object.keys(text), FIVE_KEYS, String(offset));
    }
  });

  it("counts offsets in the tidied text", () => {
    // The tidied main is "ab\n\n cd", 7 units; offset 8 is the rest's second character.
    assert.deepEqual(composePageText("main", " ab \r\n\r\n\r\n cd  ", "xyz", options(10, 8)), {
      source: "main",
      main: "",
      rest: "yz",
      truncated: false,
      totalChars: 10,
    });
  });

  it("does not move past a surrogate pair with a maxChars of 1", () => {
    assert.deepEqual(composePageText("body", `a${PAIR}b`, "", options(1, 1)), {
      source: "body",
      main: "",
      rest: "",
      truncated: true,
      totalChars: 4,
      nextOffset: 1,
    });
  });
});

describe("reading on with nextOffset", () => {
  const main = `Intro ${PAIR} text${PAIR}${PAIR} and more of the main content ${PAIR}x`;
  const rest = `${PAIR}Menu ${PAIR} links, footer${PAIR} and the end`;
  const whole = tidyText(main) + tidyText(rest);

  /** Reads the whole text window by window, following nextOffset; the ends of the windows. */
  function readAll(read: (offset: number) => PageText | undefined): {
    text: string;
    ends: number[];
  } {
    let text = "";
    const ends: number[] = [];
    let offset = 0;
    for (let reads = 0; reads <= whole.length; reads++) {
      const piece = read(offset);
      assert.ok(piece !== undefined);
      assert.equal(piece.totalChars, whole.length);
      text += piece.main + piece.rest;
      if (!piece.truncated) return { text, ends };
      assert.ok(piece.nextOffset !== undefined && piece.nextOffset > offset, String(offset));
      assert.equal(piece.nextOffset, offset + piece.main.length + piece.rest.length);
      offset = piece.nextOffset;
      ends.push(offset);
    }
    assert.fail("the reads did not reach the end of the text");
  }

  it("reassembles the whole text exactly, in windows of several sizes", () => {
    const ends: number[] = [];
    const short: number[] = [];
    for (const maxChars of [2, 3, 4, 5, 7]) {
      const read = readAll((offset) =>
        composePageText("main", main, rest, options(maxChars, offset)),
      );
      assert.equal(read.text, whole, String(maxChars));
      ends.push(...read.ends);
      let previous = 0;
      for (const end of read.ends) {
        if (end - previous < maxChars) short.push(end);
        previous = end;
      }
    }
    // Some window ended on the boundary of main and rest, and some before a surrogate pair.
    assert.ok(ends.includes(tidyText(main).length));
    assert.ok(
      short.some((end) => whole.charCodeAt(end) >= 0xd800 && whole.charCodeAt(end) <= 0xdbff),
    );
  });

  it("reassembles the whole text exactly through the background's own cut", () => {
    for (const maxChars of [2, 3, 5]) {
      const read = readAll((offset) =>
        pageTextOf(
          composePageText("main", main, rest, options(maxChars, offset)),
          options(maxChars, offset),
        ),
      );
      assert.equal(read.text, whole, String(maxChars));
    }
  });
});

describe("pageTextOptions", () => {
  it("gives the default when maxChars is missing", () => {
    assert.deepEqual(pageTextOptions({}), { maxChars: 50_000, offset: 0 });
  });

  it("accepts whole numbers from 1 to 200000", () => {
    assert.deepEqual(pageTextOptions({ maxChars: 1 }), { maxChars: 1, offset: 0 });
    assert.deepEqual(pageTextOptions({ maxChars: 200_000 }), {
      maxChars: 200_000,
      offset: 0,
    });
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

  it("accepts an offset of 0 or more", () => {
    assert.deepEqual(pageTextOptions({ offset: 0 }), { maxChars: 50_000, offset: 0 });
    assert.deepEqual(pageTextOptions({ maxChars: 7, offset: Number.MAX_SAFE_INTEGER }), {
      maxChars: 7,
      offset: Number.MAX_SAFE_INTEGER,
    });
  });

  it("refuses any other offset with its sentence", () => {
    for (const offset of [
      -1,
      1.5,
      "10",
      null,
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
    ]) {
      assert.equal(pageTextOptions({ offset }), OFFSET_REFUSAL, String(offset));
      assert.equal(pageTextOptions({ maxChars: 10, offset }), OFFSET_REFUSAL, String(offset));
    }
  });

  it("refuses a bad maxChars with its own sentence also when the offset is bad", () => {
    assert.equal(pageTextOptions({ maxChars: 0, offset: -1 }), REFUSAL);
  });

  it("does not read an inherited offset", () => {
    assert.deepEqual(pageTextOptions(Object.create({ offset: 5 })), {
      maxChars: 50_000,
      offset: 0,
    });
    assert.deepEqual(pageTextOptions(Object.create({ offset: -1 })), {
      maxChars: 50_000,
      offset: 0,
    });
  });

  it("does not read an inherited maxChars", () => {
    assert.deepEqual(pageTextOptions(Object.create({ maxChars: 5 })), {
      maxChars: 50_000,
      offset: 0,
    });
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
    const text = pageTextOf(reply, options(100));
    assert.notEqual(text, reply);
    assert.deepEqual(text, valid);
    assert.deepEqual(Object.keys(text ?? {}), FIVE_KEYS);
  });

  it("accepts every source", () => {
    for (const source of ["main", "role_main", "article", "largest_block", "body"] as const) {
      assert.deepEqual(pageTextOf({ ...valid, source }, options(100)), { ...valid, source });
    }
  });

  it("accepts a totalChars of 0", () => {
    const empty = { ...valid, main: "", rest: "", totalChars: 0 };
    assert.deepEqual(pageTextOf(empty, options(100)), empty);
  });

  it("refuses what is not an object", () => {
    for (const reply of [undefined, null, "text", 3, [valid]]) {
      assert.equal(pageTextOf(reply, options(100)), undefined, String(reply));
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
      assert.equal(pageTextOf(reply, options(100)), undefined, JSON.stringify(reply));
    }
  });

  it("does not read inherited fields", () => {
    assert.equal(pageTextOf(Object.create(valid), options(100)), undefined);
    for (const key of Object.keys(valid)) {
      const own = Object.fromEntries(Object.entries(valid).filter(([other]) => other !== key));
      const reply: unknown = Object.assign(Object.create({ [key]: Reflect.get(valid, key) }), own);
      assert.equal(pageTextOf(reply, options(100)), undefined, key);
    }
  });

  it("cuts an oversize main again and leaves the rest empty", () => {
    assert.deepEqual(pageTextOf({ ...valid, main: "abcdef" }, options(4)), {
      ...valid,
      main: "abcd",
      rest: "",
      truncated: true,
      nextOffset: 4,
    });
  });

  it("cuts an oversize rest again to what main leaves", () => {
    assert.deepEqual(pageTextOf({ ...valid, main: "ab", rest: "cdef" }, options(4)), {
      ...valid,
      main: "ab",
      rest: "cd",
      truncated: true,
      nextOffset: 4,
    });
  });

  it("keeps the reply's own truncated flag when the text fits", () => {
    assert.deepEqual(pageTextOf({ ...valid, truncated: true }, options(9)), {
      ...valid,
      truncated: true,
      nextOffset: 9,
    });
    assert.deepEqual(pageTextOf(valid, options(9)), valid);
  });

  it("gives a cut reply the next offset after the request's offset", () => {
    assert.deepEqual(pageTextOf({ ...valid, main: "abcdef" }, options(4, 20)), {
      ...valid,
      main: "abcd",
      rest: "",
      truncated: true,
      nextOffset: 24,
    });
    assert.deepEqual(pageTextOf({ ...valid, truncated: true }, options(9, 30)), {
      ...valid,
      truncated: true,
      nextOffset: 39,
    });
  });

  it("ignores the reply's own nextOffset", () => {
    const truncated = pageTextOf({ ...valid, truncated: true, nextOffset: 3 }, options(100, 30));
    assert.deepEqual(truncated, { ...valid, truncated: true, nextOffset: 39 });
    assert.deepEqual(Object.keys(truncated ?? {}), [...FIVE_KEYS, "nextOffset"]);
    const whole = pageTextOf({ ...valid, nextOffset: 5 }, options(100, 30));
    assert.deepEqual(whole, valid);
    assert.deepEqual(Object.keys(whole ?? {}), FIVE_KEYS);
  });

  it("refuses a truncated reply whose next offset is not a safe integer", () => {
    const reply = { ...valid, truncated: true };
    assert.deepEqual(pageTextOf(reply, options(100, Number.MAX_SAFE_INTEGER - 9)), {
      ...reply,
      nextOffset: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(pageTextOf(reply, options(100, Number.MAX_SAFE_INTEGER - 8)), undefined);
    assert.deepEqual(pageTextOf(valid, options(100, Number.MAX_SAFE_INTEGER)), valid);
  });
});
