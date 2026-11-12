import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TYPE_CHARS } from "@foxleash/protocol";
import {
  blocksImplicitSubmission,
  expectedValue,
  frameOnSite,
  implicitSubmission,
  isClickInput,
  isTypeableInput,
  keyDefault,
  lengthLimit,
  lineFeeds,
  nextInTabOrder,
  nextOption,
  type ParsedKey,
  parseKey,
  pressKeyOptions,
  pressKeyResultOf,
  sendsKeyPress,
  singleLine,
  submitsImplicitly,
  typeOptions,
  typeResultOf,
} from "./page-input.ts";

const REF = "0a1b2c3d-4";
const KEY_NAMES =
  "press_key needs key to be one character or one of Enter, Tab, Escape, Space, Backspace, Delete, Insert, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown and F1 to F12, after any of the modifiers Shift, Control (or Ctrl), Alt and Meta joined with +, such as Control+a.";
const KEY_MODIFIERS =
  "press_key takes only Shift, Control (or Ctrl), Alt and Meta before the key, each at most once and joined with +, such as Control+Shift+a.";
const NONE = { shift: false, control: false, alt: false, meta: false };
const NAMED = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
];

function key(text: string): ParsedKey {
  const parsed = parseKey(text);
  assert.ok(typeof parsed !== "string", `${text}: ${String(parsed)}`);
  return parsed;
}

describe("parseKey", () => {
  it("takes every named key, with the name as key and code", () => {
    for (const name of NAMED) {
      assert.deepEqual(parseKey(name), { key: name, code: name, ...NONE }, name);
    }
  });

  it("sends Space, named or written as a space, as the key ' ' with the code Space", () => {
    assert.deepEqual(parseKey("Space"), { key: " ", code: "Space", ...NONE });
    assert.deepEqual(parseKey(" "), { key: " ", code: "Space", ...NONE });
    assert.deepEqual(parseKey("Shift+ "), { key: " ", code: "Space", ...NONE, shift: true });
  });

  it("matches named keys and modifiers in any letter case and gives their canonical form", () => {
    assert.deepEqual(parseKey("enter"), { key: "Enter", code: "Enter", ...NONE });
    assert.deepEqual(parseKey("ARROWDOWN"), { key: "ArrowDown", code: "ArrowDown", ...NONE });
    assert.deepEqual(parseKey("f5"), { key: "F5", code: "F5", ...NONE });
    assert.deepEqual(parseKey("space"), { key: " ", code: "Space", ...NONE });
    assert.deepEqual(parseKey("ctrl+a"), { key: "a", code: "KeyA", ...NONE, control: true });
    assert.deepEqual(parseKey("SHIFT+tab"), { key: "Tab", code: "Tab", ...NONE, shift: true });
    assert.deepEqual(parseKey("cOnTrOl+alt+META+x"), {
      key: "x",
      code: "KeyX",
      shift: false,
      control: true,
      alt: true,
      meta: true,
    });
  });

  it("keeps a single character exactly as written", () => {
    assert.deepEqual(parseKey("a"), { key: "a", code: "KeyA", ...NONE });
    assert.deepEqual(parseKey("A"), { key: "A", code: "KeyA", ...NONE });
    assert.deepEqual(parseKey("Shift+a"), { key: "a", code: "KeyA", ...NONE, shift: true });
    assert.deepEqual(parseKey("z"), { key: "z", code: "KeyZ", ...NONE });
    assert.deepEqual(parseKey("Z"), { key: "Z", code: "KeyZ", ...NONE });
  });

  it("gives digits a Digit code and other characters none", () => {
    assert.deepEqual(parseKey("0"), { key: "0", code: "Digit0", ...NONE });
    assert.deepEqual(parseKey("9"), { key: "9", code: "Digit9", ...NONE });
    for (const character of ["é", "ß", "/", ".", "-", "😀", "中", "Ａ", "٣"]) {
      assert.deepEqual(parseKey(character), { key: character, code: "", ...NONE }, character);
    }
  });

  it("takes an astral character as one key", () => {
    assert.deepEqual(parseKey("Control+😀"), { key: "😀", code: "", ...NONE, control: true });
  });

  it("takes modifiers in any order, with Ctrl for Control", () => {
    const all = { key: "k", code: "KeyK", shift: true, control: true, alt: true, meta: true };
    assert.deepEqual(parseKey("Shift+Control+Alt+Meta+k"), all);
    assert.deepEqual(parseKey("Meta+Alt+Ctrl+Shift+k"), all);
    assert.deepEqual(parseKey("Alt+Shift+Meta+Control+k"), all);
    assert.deepEqual(parseKey("Control+k"), { key: "k", code: "KeyK", ...NONE, control: true });
    assert.deepEqual(parseKey("Ctrl+k"), { key: "k", code: "KeyK", ...NONE, control: true });
    assert.deepEqual(parseKey("Alt+F4"), { key: "F4", code: "F4", ...NONE, alt: true });
    assert.deepEqual(parseKey("Meta+Enter"), { key: "Enter", code: "Enter", ...NONE, meta: true });
  });

  it("reads a bare + and a trailing ++ as the + key", () => {
    assert.deepEqual(parseKey("+"), { key: "+", code: "", ...NONE });
    assert.deepEqual(parseKey("Control++"), { key: "+", code: "", ...NONE, control: true });
    assert.deepEqual(parseKey("Shift+Control++"), {
      key: "+",
      code: "",
      ...NONE,
      shift: true,
      control: true,
    });
  });

  it("refuses an empty key, an unknown name and more than one character", () => {
    for (const text of ["", "Control+", "Shift+Alt+", "Return", "Esc", "F13", "F0", "ab", "é"]) {
      assert.equal(parseKey(text), KEY_NAMES, JSON.stringify(text));
    }
  });

  it("refuses control characters and lone surrogates", () => {
    for (const text of ["\n", "\r", "\t", "\u0000", "\u007f", "\u0085", "\ud83d", "\ude00"]) {
      assert.equal(parseKey(text), KEY_NAMES, JSON.stringify(text));
      assert.equal(parseKey(`Shift+${text}`), KEY_NAMES, JSON.stringify(text));
    }
  });

  it("refuses an empty, unknown or repeated modifier", () => {
    for (const text of [
      "++",
      "+a",
      "a+b",
      "Shift++a",
      "Shift+Shift+a",
      "Control+Ctrl+a",
      "ctrl+CONTROL+a",
      "Hyper+a",
      "Cmd+a",
      "constructor+a",
      "__proto__+a",
      "toString+a",
      "Shift+++",
      " Shift+a",
      "Shift +a",
    ]) {
      assert.equal(parseKey(text), KEY_MODIFIERS, text);
    }
  });

  it("refuses a modifier name used as the key", () => {
    assert.equal(parseKey("Shift"), KEY_NAMES);
    assert.equal(parseKey("Control+Alt"), KEY_NAMES);
  });

  it("refuses a modifier ending the text as a key with no name", () => {
    assert.equal(parseKey("a+"), KEY_NAMES);
  });
});

describe("pressKeyOptions", () => {
  it("takes a key, and a ref when given, keeping only those fields", () => {
    assert.deepEqual(pressKeyOptions({ key: "Enter", tabId: 1, extra: true }), { key: "Enter" });
    assert.deepEqual(pressKeyOptions({ key: "shift+tab", ref: REF }), {
      key: "shift+tab",
      ref: REF,
    });
    assert.deepEqual(pressKeyOptions({ key: "a", ref: "anything" }), {
      key: "a",
      ref: "anything",
    });
    assert.deepEqual(Object.keys(pressKeyOptions({ ref: REF, key: "a", x: 1 })), ["key", "ref"]);
  });

  it("refuses a key that is not a string, or that parseKey refuses", () => {
    for (const bad of [undefined, 1, null, ["Enter"], {}]) {
      assert.equal(pressKeyOptions({ key: bad }), "press_key needs key to be a string.");
    }
    assert.equal(pressKeyOptions({ key: "" }), KEY_NAMES);
    assert.equal(pressKeyOptions({ key: "Return" }), KEY_NAMES);
    assert.equal(pressKeyOptions({ key: "Shift+Shift+a" }), KEY_MODIFIERS);
    assert.equal(pressKeyOptions({ key: "Control+" }), KEY_NAMES);
  });

  it("refuses a ref that is not a string", () => {
    for (const ref of [1, null, {}, ["a"], false]) {
      assert.equal(pressKeyOptions({ key: "a", ref }), "press_key needs ref to be a string.");
    }
  });

  it("ignores inherited fields", () => {
    assert.equal(
      pressKeyOptions(Object.create({ key: "Enter" })),
      "press_key needs key to be a string.",
    );
    const inherited = Object.assign(Object.create({ ref: 5 }), { key: "Tab" });
    assert.deepEqual(pressKeyOptions(inherited), { key: "Tab" });
  });

  it("gives back the same options when it parses its own result", () => {
    for (const params of [{ key: "Enter" }, { key: "Control++", ref: REF }]) {
      const options = pressKeyOptions(params);
      assert.ok(typeof options !== "string");
      assert.deepEqual(pressKeyOptions(options), options);
    }
  });
});

describe("typeOptions", () => {
  const textRefusal = `type needs text to be a string of 1 to ${MAX_TYPE_CHARS} characters.`;

  it("takes a ref and a text, keeping only those fields", () => {
    assert.deepEqual(typeOptions({ ref: REF, text: "hello", tabId: 3, extra: 1 }), {
      ref: REF,
      text: "hello",
    });
    assert.deepEqual(typeOptions({ ref: "anything", text: "x" }), { ref: "anything", text: "x" });
    assert.deepEqual(Object.keys(typeOptions({ text: "a", ref: REF })), ["ref", "text"]);
  });

  it("refuses a missing or non-string ref", () => {
    for (const ref of [undefined, 1, null, {}, ["a"]]) {
      assert.equal(typeOptions({ ref, text: "a" }), "type needs ref to be a string.");
    }
  });

  it("refuses an empty or non-string text", () => {
    for (const text of [undefined, "", 1, null, ["a"], {}]) {
      assert.equal(typeOptions({ ref: REF, text }), textRefusal);
    }
  });

  it("takes MAX_TYPE_CHARS UTF-16 units and refuses one more", () => {
    const longest = "a".repeat(MAX_TYPE_CHARS);
    assert.deepEqual(typeOptions({ ref: REF, text: longest }), { ref: REF, text: longest });
    assert.equal(typeOptions({ ref: REF, text: `${longest}a` }), textRefusal);
    const astral = "😀".repeat(MAX_TYPE_CHARS / 2);
    assert.deepEqual(typeOptions({ ref: REF, text: astral }), { ref: REF, text: astral });
    assert.equal(typeOptions({ ref: REF, text: `${astral}a` }), textRefusal);
  });

  it("ignores inherited fields", () => {
    assert.equal(
      typeOptions(Object.assign(Object.create({ ref: REF }), { text: "a" })),
      "type needs ref to be a string.",
    );
    assert.equal(
      typeOptions(Object.assign(Object.create({ text: "a" }), { ref: REF })),
      textRefusal,
    );
  });
});

describe("typeResultOf", () => {
  it("takes every outcome and method", () => {
    for (const outcome of ["typed", "sent_unconfirmed"] as const) {
      for (const method of ["exec_command", "native_setter", "beforeinput_dom"] as const) {
        assert.deepEqual(typeResultOf({ outcome, method }), { outcome, method });
      }
    }
  });

  it("keeps only the known fields", () => {
    assert.deepEqual(
      Object.keys(
        typeResultOf({ method: "exec_command", outcome: "typed", value: "secret" }) ?? {},
      ),
      ["outcome", "method"],
    );
  });

  it("refuses unknown members, wrong types and anything that is not a record", () => {
    for (const value of [
      { outcome: "Typed", method: "exec_command" },
      { outcome: "failed", method: "exec_command" },
      { outcome: "typed", method: "key_events" },
      { outcome: "typed", method: "EXEC_COMMAND" },
      { outcome: "typed" },
      { method: "exec_command" },
      { outcome: 1, method: "exec_command" },
      { outcome: "typed", method: null },
      null,
      "typed",
      ["typed", "exec_command"],
      undefined,
    ]) {
      assert.equal(typeResultOf(value), undefined, JSON.stringify(value));
    }
  });

  it("ignores inherited fields", () => {
    assert.equal(
      typeResultOf(Object.create({ outcome: "typed", method: "exec_command" })),
      undefined,
    );
    assert.equal(
      typeResultOf(Object.assign(Object.create({ method: "exec_command" }), { outcome: "typed" })),
      undefined,
    );
  });
});

describe("pressKeyResultOf", () => {
  it("takes every action, prevented or not", () => {
    for (const action of [
      "none",
      "submitted",
      "clicked",
      "focus_moved",
      "selected_option",
      "closed_dialog",
      "hid_popover",
    ] as const) {
      assert.deepEqual(pressKeyResultOf({ action, prevented: false }), {
        action,
        prevented: false,
      });
      assert.deepEqual(pressKeyResultOf({ action, prevented: true }), { action, prevented: true });
    }
  });

  it("keeps only the known fields", () => {
    assert.deepEqual(
      Object.keys(pressKeyResultOf({ prevented: false, action: "none", extra: 1 }) ?? {}),
      ["action", "prevented"],
    );
  });

  it("refuses unknown members, wrong types and anything that is not a record", () => {
    for (const value of [
      { action: "navigated", prevented: false },
      { action: "None", prevented: false },
      { action: "none", prevented: "false" },
      { action: "none", prevented: 0 },
      { action: "none" },
      { prevented: true },
      { action: 1, prevented: true },
      null,
      [],
      "none",
    ]) {
      assert.equal(pressKeyResultOf(value), undefined, JSON.stringify(value));
    }
  });

  it("ignores inherited fields", () => {
    assert.equal(pressKeyResultOf(Object.create({ action: "none", prevented: false })), undefined);
    assert.equal(
      pressKeyResultOf(Object.assign(Object.create({ prevented: false }), { action: "none" })),
      undefined,
    );
  });
});

describe("nextInTabOrder", () => {
  const entries = (...tabIndexes: number[]) => tabIndexes.map((tabIndex) => ({ tabIndex }));

  it("goes through positive tab indexes in ascending order, then tab index 0 in tree order", () => {
    const list = entries(0, 2, 0, 1, 3);
    const order: number[] = [];
    for (let at = nextInTabOrder(list, -1, false); at !== undefined; ) {
      order.push(at);
      at = nextInTabOrder(list, at, false);
    }
    assert.deepEqual(order, [3, 1, 4, 0, 2]);
  });

  it("keeps tree order between equal positive tab indexes", () => {
    const list = entries(2, 1, 2, 1);
    assert.equal(nextInTabOrder(list, -1, false), 1);
    assert.equal(nextInTabOrder(list, 1, false), 3);
    assert.equal(nextInTabOrder(list, 3, false), 0);
    assert.equal(nextInTabOrder(list, 0, false), 2);
    assert.equal(nextInTabOrder(list, 2, false), undefined);
  });

  it("goes the other way backwards", () => {
    const list = entries(0, 2, 0, 1, 3);
    const order: number[] = [];
    for (let at = nextInTabOrder(list, -1, true); at !== undefined; ) {
      order.push(at);
      at = nextInTabOrder(list, at, true);
    }
    assert.deepEqual(order, [2, 0, 4, 1, 3]);
  });

  it("starts at the first or the last from no focused entry", () => {
    const list = entries(0, 1, 0);
    assert.equal(nextInTabOrder(list, -1, false), 1);
    assert.equal(nextInTabOrder(list, -1, true), 2);
    assert.equal(nextInTabOrder(entries(0, 0), -1, true), 1);
    assert.equal(nextInTabOrder(entries(-1, 0, -1), -1, false), 1);
  });

  it("finds nothing when no entry is in the sequence", () => {
    assert.equal(nextInTabOrder([], -1, false), undefined);
    assert.equal(nextInTabOrder([], -1, true), undefined);
    assert.equal(nextInTabOrder(entries(-1, -2), -1, false), undefined);
    assert.equal(nextInTabOrder(entries(-1, -2), 0, true), undefined);
    assert.equal(nextInTabOrder(entries(-1, -2), 0, false), undefined);
  });

  it("does not wrap past either end", () => {
    const list = entries(1, 0, 0);
    assert.equal(nextInTabOrder(list, 2, false), undefined);
    assert.equal(nextInTabOrder(list, 0, true), undefined);
    assert.equal(nextInTabOrder(entries(0), 0, false), undefined);
    assert.equal(nextInTabOrder(entries(0), 0, true), undefined);
  });

  it("leaves out negative entries", () => {
    const list = entries(0, -1, 0, -5, 1);
    assert.equal(nextInTabOrder(list, 4, false), 0);
    assert.equal(nextInTabOrder(list, 0, false), 2);
    assert.equal(nextInTabOrder(list, 2, true), 0);
    assert.equal(nextInTabOrder(list, 0, true), 4);
  });

  it("steps from a focused entry outside the sequence by its place in tree order", () => {
    // A focused container with tabindex -1 between controls.
    const list = entries(0, -1, 0, 0);
    assert.equal(nextInTabOrder(list, 1, false), 2);
    assert.equal(nextInTabOrder(list, 1, true), 0);
    assert.equal(nextInTabOrder(entries(-1, 0, 0), 0, false), 1);
    assert.equal(nextInTabOrder(entries(0, 0, -1), 2, false), undefined);
    assert.equal(nextInTabOrder(entries(0, 0, -1), 2, true), 1);
  });

  it("steps back from outside the sequence into its positive part when no 0 comes before", () => {
    const list = entries(-1, 0, 2, 1);
    assert.equal(nextInTabOrder(list, 0, true), 2);
    assert.equal(nextInTabOrder(entries(2, -1, 0), 1, true), 0);
    assert.equal(nextInTabOrder(entries(-1, 0), 0, true), undefined);
    assert.equal(nextInTabOrder(entries(3, 0, -1, 1), 2, true), 1);
  });

  it("goes forward from outside the sequence to tab index 0 entries only", () => {
    assert.equal(nextInTabOrder(entries(-1, 2, 0), 0, false), 2);
    assert.equal(nextInTabOrder(entries(-1, 2), 0, false), undefined);
  });

  it("takes an index past the entries as no focused entry", () => {
    assert.equal(nextInTabOrder(entries(0, 0), 5, false), 0);
    assert.equal(nextInTabOrder(entries(0, 0), 5, true), 1);
  });
});

describe("frameOnSite", () => {
  it("takes a frame on the page's origin, its host written in any case", () => {
    assert.equal(frameOnSite("https://docs.example", "https://docs.example/d/1"), true);
    assert.equal(frameOnSite("http://localhost:8080", "http://LOCALHOST:8080/a?b"), true);
  });

  it("refuses an opaque origin, another host, scheme or port, and a page that is not on the web", () => {
    assert.equal(frameOnSite("null", "https://docs.example/"), false);
    assert.equal(frameOnSite("https://other.example", "https://docs.example/"), false);
    assert.equal(frameOnSite("http://docs.example", "https://docs.example/"), false);
    assert.equal(frameOnSite("https://docs.example:8443", "https://docs.example/"), false);
    assert.equal(frameOnSite("https://sub.docs.example", "https://docs.example/"), false);
    assert.equal(frameOnSite("null", "about:blank"), false);
  });
});

describe("the input type rules", () => {
  it("types into text-like inputs only", () => {
    for (const type of ["text", "search", "email", "url", "tel", "password", "number"]) {
      assert.equal(isTypeableInput(type), true, type);
    }
    for (const type of ["date", "checkbox", "file", "range", "color", "hidden", "submit", ""]) {
      assert.equal(isTypeableInput(type), false, type);
    }
  });

  it("submits implicitly from any input but buttons, checkable, file, color, range and hidden", () => {
    for (const type of ["text", "email", "number", "date", "time", "password", "search"]) {
      assert.equal(submitsImplicitly(type), true, type);
    }
    for (const type of [
      "button",
      "submit",
      "reset",
      "image",
      "checkbox",
      "radio",
      "file",
      "color",
      "range",
      "hidden",
    ]) {
      assert.equal(submitsImplicitly(type), false, type);
    }
  });

  it("knows the fields that block implicit submission", () => {
    for (const type of [
      "text",
      "search",
      "url",
      "tel",
      "email",
      "password",
      "date",
      "month",
      "week",
      "time",
      "datetime-local",
      "number",
    ]) {
      assert.equal(blocksImplicitSubmission(type), true, type);
    }
    for (const type of ["checkbox", "radio", "color", "range", "file", "hidden", "submit"]) {
      assert.equal(blocksImplicitSubmission(type), false, type);
    }
  });

  it("clicks button-like inputs", () => {
    for (const type of ["button", "submit", "reset", "image"]) {
      assert.equal(isClickInput(type), true, type);
    }
    for (const type of ["text", "checkbox", "radio", "file"]) {
      assert.equal(isClickInput(type), false, type);
    }
  });
});

describe("implicitSubmission", () => {
  it("submits through an enabled default button whatever the fields", () => {
    for (const fields of [0, 1, 2]) {
      assert.equal(implicitSubmission("enabled", fields), "with_button");
    }
  });

  it("does not submit with a disabled default button", () => {
    for (const fields of [0, 1, 2]) assert.equal(implicitSubmission("disabled", fields), "none");
  });

  it("submits without a button only with exactly one blocking field", () => {
    assert.equal(implicitSubmission("none", 1), "without_button");
    assert.equal(implicitSubmission("none", 0), "none");
    assert.equal(implicitSubmission("none", 2), "none");
  });
});

describe("keyDefault", () => {
  it("knows the keys with a default action", () => {
    assert.equal(keyDefault(key("Enter")), "enter");
    assert.equal(keyDefault(key("Tab")), "tab");
    assert.equal(keyDefault(key("Shift+Tab")), "shift_tab");
    assert.equal(keyDefault(key("Escape")), "escape");
    assert.equal(keyDefault(key("ArrowDown")), "arrow_down");
    assert.equal(keyDefault(key("ArrowUp")), "arrow_up");
  });

  it("has none for other keys", () => {
    for (const text of ["a", "Space", "ArrowLeft", "Backspace", "F5", "+", "End"]) {
      assert.equal(keyDefault(key(text)), undefined, text);
    }
  });

  it("has none with Control, Alt or Meta, nor with Shift but for Tab", () => {
    for (const modifier of ["Control", "Alt", "Meta"]) {
      for (const name of ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"]) {
        assert.equal(keyDefault(key(`${modifier}+${name}`)), undefined, `${modifier}+${name}`);
      }
      assert.equal(keyDefault(key(`Shift+${modifier}+Tab`)), undefined, modifier);
    }
    for (const name of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
      assert.equal(keyDefault(key(`Shift+${name}`)), undefined, name);
    }
  });
});

describe("sendsKeyPress", () => {
  it("sends a keypress for Enter and characters", () => {
    for (const text of ["Enter", "a", "Shift+A", "Space", " ", "+", "😀", "Alt+a", "Shift+Enter"]) {
      assert.equal(sendsKeyPress(key(text)), true, text);
    }
  });

  it("sends none for other named keys, nor with Control or Meta", () => {
    for (const text of ["Tab", "Escape", "ArrowDown", "Backspace", "F1", "Delete"]) {
      assert.equal(sendsKeyPress(key(text)), false, text);
    }
    for (const text of ["Control+a", "Meta+a", "Control+Enter", "Meta+Enter", "Control+Space"]) {
      assert.equal(sendsKeyPress(key(text)), false, text);
    }
  });
});

describe("singleLine", () => {
  it("strips CR and LF and keeps everything else", () => {
    assert.equal(singleLine("a\r\nb\nc\rd"), "abcd");
    assert.equal(singleLine("\n\n"), "");
    assert.equal(singleLine("tab\there "), "tab\there ");
  });
});

describe("expectedValue", () => {
  it("adds the text after the value", () => {
    assert.equal(expectedValue("ab", "cd", -1), "abcd");
    assert.equal(expectedValue("", "x", -1), "x");
  });

  it("cuts to maxLength when it is 0 or more", () => {
    assert.equal(expectedValue("ab", "cdef", 4), "abcd");
    assert.equal(expectedValue("ab", "cd", 4), "abcd");
    assert.equal(expectedValue("", "abc", 0), "");
    assert.equal(expectedValue("abcd", "e", 4), "abcd");
  });

  it("never cuts a value already longer than maxLength", () => {
    assert.equal(expectedValue("abcdef", "g", 4), "abcdef");
  });

  it("never cuts through a surrogate pair", () => {
    assert.equal(expectedValue("ab", "\u{1F600}", 3), "ab");
    assert.equal(expectedValue("a", "\u{1F600}b", 2), "a");
    assert.equal(expectedValue("a", "\u{1F600}b", 3), "a\u{1F600}");
    assert.equal(expectedValue("a", "b\u{1F600}", 4), "ab\u{1F600}");
    // A lone half is kept when nothing cuts it, and the value held before is never shortened.
    assert.equal(expectedValue("a", "b\uD83D", 3), "ab\uD83D");
    assert.equal(expectedValue("a\uD83D", "\uDE00b", 1), "a\uD83D");
    assert.equal(expectedValue("a\uD83D", "\uDE00b", 2), "a\uD83D");
  });
});

describe("lineFeeds", () => {
  it("turns CRLF and CR into LF and keeps everything else", () => {
    assert.equal(lineFeeds("a\r\nb\rc\nd"), "a\nb\nc\nd");
    assert.equal(lineFeeds("\r\r\n\n"), "\n\n\n");
    assert.equal(lineFeeds("tab\there "), "tab\there ");
  });
});

describe("lengthLimit", () => {
  it("gives the maxLength of text fields and textareas, and none for a number input", () => {
    assert.equal(lengthLimit("text", 4), 4);
    assert.equal(lengthLimit("textarea", 0), 0);
    assert.equal(lengthLimit("email", -1), -1);
    assert.equal(lengthLimit("number", 2), -1);
  });
});

describe("nextOption", () => {
  it("goes to the next or previous enabled option", () => {
    assert.equal(nextOption([false, false, false], 0, false), 1);
    assert.equal(nextOption([false, false, false], 2, true), 1);
    assert.equal(nextOption([false, true, false], 0, false), 2);
    assert.equal(nextOption([false, true, true, false], 3, true), 0);
  });

  it("starts at the first enabled option forward from none selected", () => {
    assert.equal(nextOption([true, false, false], -1, false), 1);
    assert.equal(nextOption([false, false], -1, false), 0);
  });

  it("finds nothing backward from none selected", () => {
    assert.equal(nextOption([false, false], -1, true), undefined);
  });

  it("finds nothing at either end, or past only disabled options", () => {
    assert.equal(nextOption([false, false], 1, false), undefined);
    assert.equal(nextOption([false, false], 0, true), undefined);
    assert.equal(nextOption([false, true], 0, false), undefined);
    assert.equal(nextOption([true, false], 1, true), undefined);
    assert.equal(nextOption([], -1, false), undefined);
  });
});
