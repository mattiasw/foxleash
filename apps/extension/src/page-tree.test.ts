import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARIA_ROLES,
  createTextBuffer,
  createTreeText,
  explicitRole,
  formatLine,
  INTERACTIVE_ROLES,
  isCredentialAutocomplete,
  isProtectedField,
  LANDMARK_ROLES,
  MAX_FIELD_CHARS,
  NAME_FROM_CONTENT_ROLES,
  quote,
  READ_PAGE_MAX_CHARS,
  readPageOptions,
  textLine,
} from "./page-tree.ts";

// A character outside the BMP: two UTF-16 units.
const PAIR = "\u{1F98A}";

describe("readPageOptions", () => {
  it("defaults to filter all, with no depth and no ref", () => {
    assert.deepEqual(readPageOptions({}), { filter: "all" });
  });

  it("keeps the options given and ignores unknown keys", () => {
    assert.deepEqual(
      readPageOptions({ tabId: 3, filter: "interactive", depth: 1, ref: "x", other: true }),
      { filter: "interactive", depth: 1, ref: "x" },
    );
    assert.deepEqual(readPageOptions({ filter: "all", depth: 2 ** 53 - 1 }), {
      filter: "all",
      depth: 2 ** 53 - 1,
    });
  });

  it("reads only own keys", () => {
    const inherited: Record<string, unknown> = Object.create({ filter: "bad", depth: 0, ref: 1 });
    assert.deepEqual(readPageOptions(inherited), { filter: "all" });
  });

  it("refuses each bad option with its sentence", () => {
    const filter = "read_page needs filter to be all or interactive.";
    const depth = "read_page needs depth to be a whole number of 1 or more.";
    const ref = "read_page needs ref to be a string.";
    const cases: [Record<string, unknown>, string][] = [
      [{ filter: "All" }, filter],
      [{ filter: null }, filter],
      [{ filter: ["all"] }, filter],
      [{ depth: 0 }, depth],
      [{ depth: -1 }, depth],
      [{ depth: 1.5 }, depth],
      [{ depth: Number.NaN }, depth],
      [{ depth: Number.POSITIVE_INFINITY }, depth],
      [{ depth: 2 ** 53 }, depth],
      [{ depth: "2" }, depth],
      [{ depth: null }, depth],
      [{ ref: 4 }, ref],
      [{ ref: null }, ref],
    ];
    for (const [params, sentence] of cases) {
      assert.equal(readPageOptions(params), sentence, JSON.stringify(params));
    }
  });
});

describe("formatLine", () => {
  it("writes role, name, ref and every state in the fixed order", () => {
    assert.equal(
      formatLine({
        level: 2,
        role: "textbox",
        name: "Email",
        ref: "0a1b2c3d-8",
        states: {
          href: "https://example.com/",
          field: { value: "me@example.com" },
          level: 3,
          focused: true,
          invalid: true,
          required: true,
          readonly: true,
          disabled: true,
          pressed: true,
          expanded: false,
          selected: true,
          checked: "mixed",
        },
      }),
      '    textbox "Email" [0a1b2c3d-8] mixed selected expanded=false pressed disabled readonly required invalid focused level=3 value="me@example.com" href="https://example.com/"',
    );
  });

  it("marks a file field straight after its reference", () => {
    assert.equal(
      formatLine({ level: 0, role: "button", ref: "0a1b2c3d-4", states: { file: true } }),
      "button [0a1b2c3d-4] file field",
    );
    assert.equal(
      formatLine({
        level: 0,
        role: "button",
        name: "Resume",
        ref: "0a1b2c3d-5",
        states: { required: true, disabled: true, file: true },
      }),
      'button "Resume" [0a1b2c3d-5] file field disabled required',
    );
    assert.equal(
      formatLine({
        level: 2,
        role: "textbox",
        name: "Email",
        ref: "0a1b2c3d-8",
        states: {
          frame: true,
          href: "https://example.com/",
          field: { value: "me@example.com" },
          level: 3,
          focused: true,
          invalid: true,
          required: true,
          readonly: true,
          disabled: true,
          pressed: true,
          expanded: false,
          selected: true,
          checked: "mixed",
          file: true,
        },
      }),
      '    textbox "Email" [0a1b2c3d-8] file field mixed selected expanded=false pressed disabled readonly required invalid focused level=3 value="me@example.com" href="https://example.com/" frame content not read',
    );
  });

  it("writes only the role when nothing else is given", () => {
    assert.equal(formatLine({ level: 0, role: "main" }), "main");
    assert.equal(formatLine({ level: 1, role: "main", states: {} }), "  main");
  });

  it("leaves out an empty name, an empty value and false states", () => {
    assert.equal(
      formatLine({
        level: 0,
        role: "textbox",
        name: " \n\t",
        ref: "0a1b2c3d-1",
        states: {
          field: { value: "  " },
          selected: false,
          pressed: false,
          disabled: false,
          readonly: false,
          required: false,
          invalid: false,
          focused: false,
        },
      }),
      "textbox [0a1b2c3d-1]",
    );
  });

  it("writes checked, expanded=true and a heading level", () => {
    assert.equal(
      formatLine({ level: 0, role: "checkbox", states: { checked: "checked", expanded: true } }),
      "checkbox checked expanded=true",
    );
    assert.equal(
      formatLine({ level: 0, role: "heading", name: "Sign in", states: { level: 2 } }),
      'heading "Sign in" level=2',
    );
  });

  it("writes a protected field without any value", () => {
    assert.equal(
      formatLine({
        level: 0,
        role: "textbox",
        name: "Password",
        ref: "0a1b2c3d-9",
        states: { required: true, field: { protected: true, filled: true }, href: "x" },
      }),
      'textbox "Password" [0a1b2c3d-9] required protected filled href="x"',
    );
    assert.equal(
      formatLine({
        level: 0,
        role: "textbox",
        states: { field: { protected: true, filled: false } },
      }),
      "textbox protected",
    );
  });

  it("ends a frame's line with a note that its content was not read", () => {
    assert.equal(
      formatLine({
        level: 1,
        role: "iframe",
        name: "Chat",
        ref: "0a1b2c3d-12",
        states: { frame: true },
      }),
      '  iframe "Chat" [0a1b2c3d-12] frame content not read',
    );
  });

  it("keeps a name with line breaks and quotes on one line, inside its quotes", () => {
    const line = formatLine({
      level: 0,
      role: "link",
      name: 'Docs"\n]\r\nlink "x" [y]\u2028\u0085\\',
      states: { href: "https://example.com/\n?q=\u0085" },
    });
    assert.equal(line, 'link "Docs\\" ] link \\"x\\" [y] \\\\" href="https://example.com/ ?q="');
    assert.equal(line.split(/[\n\r\u2028\u2029\u0085]/).length, 1);
  });
});

describe("quote", () => {
  it("collapses whitespace, NEL included, and trims", () => {
    assert.equal(quote("  a \t\n b\u0085\u0085c\u2028d\u00a0e  "), '"a b c d e"');
  });

  it("escapes quotes, backslashes and control characters", () => {
    assert.equal(quote('say "hi" \\ \u0001'), '"say \\"hi\\" \\\\ \\u0001"');
  });

  it("cuts the text to the field cap and marks the cut, without splitting a surrogate pair", () => {
    assert.equal(MAX_FIELD_CHARS, 200);
    assert.equal(quote("a".repeat(200)), JSON.stringify("a".repeat(200)));
    assert.equal(quote("a".repeat(201)), JSON.stringify(`${"a".repeat(200)}…`));
    const split = `${"a".repeat(199)}${PAIR}`;
    assert.equal(quote(split), JSON.stringify(`${"a".repeat(199)}…`));
    const whole = `${"a".repeat(198)}${PAIR}b`;
    assert.equal(quote(whole), JSON.stringify(`${"a".repeat(198)}${PAIR}…`));
  });

  it("cuts after collapsing whitespace", () => {
    assert.equal(quote(`${" ".repeat(300)}x`), '"x"');
  });
});

describe("textLine", () => {
  it("writes a text line at its level", () => {
    assert.equal(textLine(0, " Forgot  your password? "), 'text "Forgot your password?"');
    assert.equal(textLine(2, "a"), '    text "a"');
  });

  it("writes nothing for whitespace", () => {
    assert.equal(textLine(1, " \n\u0085 "), undefined);
    assert.equal(textLine(1, ""), undefined);
  });
});

describe("createTreeText", () => {
  it("joins lines with newlines", () => {
    const tree = createTreeText();
    assert.equal(tree.add("main"), true);
    assert.equal(tree.add("  link"), true);
    assert.equal(tree.full, false);
    assert.deepEqual(tree.result(), { tree: "main\n  link", truncated: false });
  });

  it("caps the tree at READ_PAGE_MAX_CHARS by default", () => {
    assert.equal(READ_PAGE_MAX_CHARS, 50_000);
    const tree = createTreeText();
    assert.equal(tree.add("a".repeat(READ_PAGE_MAX_CHARS - 2)), true);
    assert.equal(tree.add("b"), true);
    assert.equal(tree.add(""), false);
    assert.equal(tree.result().tree.length, READ_PAGE_MAX_CHARS);
  });

  it("stops before the line that would pass the cap, on a whole line", () => {
    const tree = createTreeText(10);
    assert.equal(tree.add("abcd"), true);
    assert.equal(tree.add("efgh"), true);
    assert.equal(tree.add("i"), false);
    assert.equal(tree.full, true);
    assert.equal(tree.add(""), false);
    assert.deepEqual(tree.result(), { tree: "abcd\nefgh", truncated: true });
  });

  it("fills the cap exactly without marking the tree cut", () => {
    const tree = createTreeText(9);
    assert.equal(tree.add("abcd"), true);
    assert.equal(tree.add("efgh"), true);
    assert.deepEqual(tree.result(), { tree: "abcd\nefgh", truncated: false });
  });

  it("cuts a first line longer than the cap without splitting a surrogate pair", () => {
    const tree = createTreeText(5);
    assert.equal(tree.add(`abcd${PAIR}`), false);
    assert.deepEqual(tree.result(), { tree: "abcd", truncated: true });
    const exact = createTreeText(6);
    assert.equal(exact.add(`abcd${PAIR}x`), false);
    assert.deepEqual(exact.result(), { tree: `abcd${PAIR}`, truncated: true });
  });

  it("marks the last line cut by depth", () => {
    const tree = createTreeText(12);
    tree.markCut();
    assert.deepEqual(tree.result(), { tree: "", truncated: false });
    tree.add("ab");
    tree.add("cd");
    tree.markCut();
    assert.deepEqual(tree.result(), { tree: "ab\ncd …", truncated: false });
    assert.equal(tree.add("efghij"), false);
    assert.deepEqual(tree.result(), { tree: "ab\ncd …", truncated: true });
  });

  it("marks the tree truncated when the cut mark does not fit", () => {
    const tree = createTreeText(6);
    tree.add("ab");
    tree.add("cd");
    tree.markCut();
    assert.equal(tree.full, true);
    assert.deepEqual(tree.result(), { tree: "ab\ncd", truncated: true });
    tree.markCut();
    assert.deepEqual(tree.result(), { tree: "ab\ncd", truncated: true });
  });

  it("marks a single line cut", () => {
    const tree = createTreeText();
    tree.add("list");
    tree.markCut();
    assert.deepEqual(tree.result(), { tree: "list …", truncated: false });
  });

  it("counts nothing for a cut mark before the first line", () => {
    const tree = createTreeText(4);
    tree.markCut();
    assert.equal(tree.add("abcd"), true);
    assert.deepEqual(tree.result(), { tree: "abcd", truncated: false });
  });

  it("adds no cut mark once the tree is full", () => {
    const tree = createTreeText(10);
    tree.add("abcd");
    assert.equal(tree.add("efghijk"), false);
    tree.markCut();
    assert.deepEqual(tree.result(), { tree: "abcd", truncated: true });
  });

  it("fits the cut mark exactly", () => {
    const tree = createTreeText(7);
    tree.add("ab");
    tree.add("cd");
    tree.markCut();
    assert.equal(tree.full, false);
    assert.deepEqual(tree.result(), { tree: "ab\ncd …", truncated: false });
  });
});

describe("createTextBuffer", () => {
  it("collapses whitespace across pieces and trims", () => {
    const buffer = createTextBuffer();
    buffer.add("  Hello ");
    buffer.add(" \n world");
    buffer.add("!");
    buffer.add(" ");
    assert.equal(buffer.text(), "Hello world!");
    assert.equal(buffer.full, false);
  });

  it("keeps the text after a space", () => {
    const buffer = createTextBuffer();
    buffer.add("a ");
    buffer.add("bc");
    assert.equal(buffer.text(), "a bc");
  });

  it("is full once it holds more than its limit, leading space aside", () => {
    const buffer = createTextBuffer(3);
    buffer.add("   abc");
    assert.equal(buffer.full, false);
    buffer.add("d");
    assert.equal(buffer.full, true);
    buffer.add("e");
    assert.equal(buffer.text(), "abcd");
  });

  it("does not keep a huge piece whole", () => {
    const buffer = createTextBuffer();
    buffer.add(` ${"x".repeat(100_000)}`);
    assert.equal(buffer.full, true);
    assert.equal(buffer.text(), "x".repeat(2 * MAX_FIELD_CHARS));
  });
});

describe("isCredentialAutocomplete", () => {
  it("matches each credential token, in any case and among others", () => {
    for (const token of [
      "current-password",
      "new-password",
      "one-time-code",
      "cc-number",
      "cc-csc",
    ]) {
      assert.equal(isCredentialAutocomplete(token), true, token);
      assert.equal(isCredentialAutocomplete(token.toUpperCase()), true, token);
    }
    assert.equal(isCredentialAutocomplete("section-login current-password"), true);
    assert.equal(isCredentialAutocomplete("off one-time-code"), true);
    assert.equal(isCredentialAutocomplete("shipping\tcc-csc\n"), true);
  });

  it("does not match other values", () => {
    for (const value of [null, "", "username", "email", "cc-name", "current-password-x", "off"]) {
      assert.equal(isCredentialAutocomplete(value), false, String(value));
    }
  });
});

describe("isProtectedField", () => {
  const field = { localName: "input", type: "text", autocomplete: null, wasPassword: false };

  it("protects password inputs, also once they turned into text", () => {
    assert.equal(isProtectedField({ ...field, type: "password" }), true);
    assert.equal(isProtectedField({ ...field, wasPassword: true }), true);
  });

  it("protects inputs and textareas with a credential autocomplete token", () => {
    assert.equal(isProtectedField({ ...field, autocomplete: "one-time-code" }), true);
    assert.equal(isProtectedField({ ...field, autocomplete: "off one-time-code" }), true);
    assert.equal(
      isProtectedField({
        localName: "textarea",
        type: "textarea",
        autocomplete: "cc-number",
        wasPassword: false,
      }),
      true,
    );
  });

  it("leaves other fields alone", () => {
    assert.equal(isProtectedField(field), false);
    assert.equal(isProtectedField({ ...field, autocomplete: "email" }), false);
    assert.equal(
      isProtectedField({
        localName: "select",
        type: "select-one",
        autocomplete: "cc-number",
        wasPassword: true,
      }),
      false,
    );
    assert.equal(
      isProtectedField({
        localName: "textarea",
        type: "password",
        autocomplete: null,
        wasPassword: true,
      }),
      false,
    );
  });
});

describe("explicitRole", () => {
  it("takes the first token that is an ARIA role, lowercased", () => {
    assert.equal(explicitRole("button"), "button");
    assert.equal(explicitRole(" Switch checkbox "), "switch");
    assert.equal(explicitRole("fancy-thing  link"), "link");
    assert.equal(explicitRole("none"), "none");
    assert.equal(explicitRole("generic"), "generic");
  });

  it("finds no role in null, empty or unknown values", () => {
    assert.equal(explicitRole(null), undefined);
    assert.equal(explicitRole(""), undefined);
    assert.equal(explicitRole("fancy image"), undefined);
  });
});

describe("role sets", () => {
  it("list the roles of ARIA 1.2 that are not abstract", () => {
    const roles =
      "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem";
    assert.deepEqual([...ARIA_ROLES].sort(), roles.split(" "));
  });

  it("hold only ARIA roles", () => {
    for (const set of [INTERACTIVE_ROLES, LANDMARK_ROLES, NAME_FROM_CONTENT_ROLES]) {
      for (const role of set) assert.equal(ARIA_ROLES.has(role), true, role);
    }
  });

  it("name the interactive roles and landmarks read_page keeps in filter interactive", () => {
    assert.deepEqual([...INTERACTIVE_ROLES].sort(), [
      "button",
      "checkbox",
      "combobox",
      "link",
      "listbox",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "radio",
      "searchbox",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
      "treeitem",
    ]);
    assert.deepEqual([...LANDMARK_ROLES].sort(), [
      "banner",
      "complementary",
      "contentinfo",
      "dialog",
      "form",
      "main",
      "navigation",
      "region",
      "search",
    ]);
    assert.deepEqual([...NAME_FROM_CONTENT_ROLES].sort(), [
      "button",
      "cell",
      "columnheader",
      "heading",
      "link",
      "menuitem",
      "option",
      "rowheader",
      "tab",
      "treeitem",
    ]);
  });
});
