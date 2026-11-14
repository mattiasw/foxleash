import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FoundTree, onlySpaces, READ_PAGE_MAX_FINDS } from "@foxleash/protocol";
import { MAX_PAGE_REPLY_CHARS } from "./page-messages.ts";
import {
  ARIA_ROLES,
  clean,
  createLineFinder,
  createLineFinders,
  createTextBuffer,
  createTreeLines,
  createTreeText,
  explicitRole,
  formatLine,
  INTERACTIVE_ROLES,
  isCredentialAutocomplete,
  isProtectedField,
  LANDMARK_ROLES,
  type Line,
  linkAddress,
  MAX_FIELD_CHARS,
  NAME_FROM_CONTENT_ROLES,
  quote,
  READ_PAGE_MAX_CHARS,
  readPageOptions,
  type TreeLines,
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

  it("keeps find and role as given, and has no key for either when not given", () => {
    assert.deepEqual(readPageOptions({ find: "  Link\n2000 ", role: " LINK " }), {
      filter: "all",
      find: "  Link\n2000 ",
      role: " LINK ",
    });
    const find = readPageOptions({ find: "a", depth: 2 });
    assert.deepEqual(find, { filter: "all", depth: 2, find: "a" });
    assert.deepEqual(Object.keys(find), ["filter", "depth", "find"]);
  });

  it("reads find and role only from own keys", () => {
    const inherited: Record<string, unknown> = Object.create({ find: "a", role: "link" });
    assert.deepEqual(readPageOptions(inherited), { filter: "all" });
    const role: Record<string, unknown> = Object.create({ find: "a" });
    role.role = "link";
    assert.equal(readPageOptions(role), "read_page takes role only together with find.");
  });

  it("refuses a bad find or role with its sentence", () => {
    const find = "read_page needs find to be text that is not only spaces.";
    const role = "read_page needs role to be a role name, such as link or heading.";
    const alone = "read_page takes role only together with find.";
    const cases: [Record<string, unknown>, string][] = [
      [{ find: "" }, find],
      [{ find: "   " }, find],
      [{ find: "\u0085" }, find],
      [{ find: " \n\t\u0085 " }, find],
      [{ find: 3 }, find],
      [{ find: null }, find],
      [{ find: ["a"] }, find],
      [{ find: "", role: "link" }, find],
      [{ find: "a", role: 4 }, role],
      [{ find: "a", role: null }, role],
      [{ find: "a", role: "" }, role],
      [{ find: "a", role: " \u0085 " }, role],
      [{ role: "" }, role],
      [{ role: "link" }, alone],
      [{ role: "link", ref: "x" }, alone],
    ];
    for (const [params, sentence] of cases) {
      assert.equal(readPageOptions(params), sentence, JSON.stringify(params));
    }
  });

  it("takes finds with find, as fresh objects, roles as given and no role key without one", () => {
    const first = { find: "Item 1", role: " LINK ", other: true };
    const second = { find: " b " };
    const options = readPageOptions({ find: "a", finds: [first, second] });
    assert.deepEqual(options, {
      filter: "all",
      find: "a",
      finds: [{ find: "Item 1", role: " LINK " }, { find: " b " }],
    });
    assert.ok(typeof options !== "string" && options.finds !== undefined);
    const [one, two] = options.finds;
    assert.notEqual(one, first);
    assert.notEqual(two, second);
    assert.deepEqual(Object.keys(two ?? {}), ["find"]);
  });

  it("takes up to READ_PAGE_MAX_FINDS entries", () => {
    const finds = Array.from({ length: READ_PAGE_MAX_FINDS }, (_, index) => ({ find: `${index}` }));
    const options = readPageOptions({ find: "a", finds });
    assert.deepEqual(typeof options === "string" ? options : options.finds, finds);
  });

  it("takes no more finds than the background's cap on a reply has room for", () => {
    // Each tree is at most twice its length as JSON, with 1,000 units for its keys and counts.
    const largest = (READ_PAGE_MAX_FINDS + 1) * (2 * READ_PAGE_MAX_CHARS + 1_000);
    assert.ok(largest <= MAX_PAGE_REPLY_CHARS);
  });

  it("reads finds and each entry's find and role only from own keys", () => {
    const inherited: Record<string, unknown> = Object.create({ finds: [{ find: "b" }] });
    inherited.find = "a";
    assert.deepEqual(readPageOptions(inherited), { filter: "all", find: "a" });
    const entry: Record<string, unknown> = Object.create({ find: "b", role: "link" });
    assert.equal(
      readPageOptions({ find: "a", finds: [entry] }),
      "read_page needs each entry of finds to have a find that is text that is not only spaces.",
    );
    entry.find = "b";
    assert.deepEqual(readPageOptions({ find: "a", finds: [entry] }), {
      filter: "all",
      find: "a",
      finds: [{ find: "b" }],
    });
  });

  it("refuses bad finds with their sentences", () => {
    const alone = "read_page takes finds only together with find.";
    const list = `read_page needs finds to be a list of 1 to ${READ_PAGE_MAX_FINDS} entries.`;
    const find =
      "read_page needs each entry of finds to have a find that is text that is not only spaces.";
    const role =
      "read_page needs each entry of finds to have a role name as its role, such as link or heading.";
    const tooMany = Array.from({ length: READ_PAGE_MAX_FINDS + 1 }, () => ({ find: "b" }));
    const cases: [Record<string, unknown>, string][] = [
      [{ finds: [{ find: "b" }] }, alone],
      [{ role: "link", finds: [{ find: "b" }] }, "read_page takes role only together with find."],
      [{ find: "a", finds: { find: "b" } }, list],
      [{ find: "a", finds: "b" }, list],
      [{ find: "a", finds: null }, list],
      [{ find: "a", finds: [] }, list],
      [{ find: "a", finds: tooMany }, list],
      [{ find: "a", finds: [null] }, find],
      [{ find: "a", finds: ["b"] }, find],
      [{ find: "a", finds: [["b"]] }, find],
      [{ find: "a", finds: [{}] }, find],
      [{ find: "a", finds: [{ find: 3 }] }, find],
      [{ find: "a", finds: [{ find: "" }] }, find],
      [{ find: "a", finds: [{ find: " \u0085" }] }, find],
      [{ find: "a", finds: [{ find: "b" }, { find: " " }] }, find],
      [{ find: "a", finds: [{ find: "b", role: " \u0085" }] }, role],
      [{ find: "a", finds: [{ find: "b", role: "" }] }, role],
      [{ find: "a", finds: [{ find: "b", role: 4 }] }, role],
      [{ find: "a", finds: [{ find: "b", role: null }] }, role],
    ];
    for (const [params, sentence] of cases) {
      assert.equal(readPageOptions(params), sentence, JSON.stringify(params));
    }
  });

  it("refuses a hole in finds as an entry without find", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    const finds = [{ find: "b" }, , { find: "c" }];
    assert.equal(
      readPageOptions({ find: "a", finds }),
      "read_page needs each entry of finds to have a find that is text that is not only spaces.",
    );
  });

  it("calls text only spaces exactly when cleaning leaves nothing of it", () => {
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const char = String.fromCharCode(unit);
      for (const text of [char, char + char, ` ${char} `]) {
        if (onlySpaces(text) !== (clean(text) === "")) {
          assert.fail(`onlySpaces and clean disagree on U+${unit.toString(16).padStart(4, "0")}`);
        }
      }
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
        ref: "b8",
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
      '  textbox "Email" [b8] mixed selected expanded=false pressed disabled readonly required invalid focused level=3 value="me@example.com" href="https://example.com/"',
    );
  });

  it("marks a file field straight after its reference", () => {
    assert.equal(
      formatLine({ level: 0, role: "button", ref: "b4", states: { file: true } }),
      "button [b4] file field",
    );
    assert.equal(
      formatLine({
        level: 0,
        role: "button",
        name: "Resume",
        ref: "b5",
        states: { required: true, disabled: true, file: true },
      }),
      'button "Resume" [b5] file field disabled required',
    );
    assert.equal(
      formatLine({
        level: 2,
        role: "textbox",
        name: "Email",
        ref: "b8",
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
      '  textbox "Email" [b8] file field mixed selected expanded=false pressed disabled readonly required invalid focused level=3 value="me@example.com" href="https://example.com/" frame content not read',
    );
  });

  it("writes only the role when nothing else is given", () => {
    assert.equal(formatLine({ level: 0, role: "main" }), "main");
    assert.equal(formatLine({ level: 1, role: "main", states: {} }), " main");
  });

  it("leaves out an empty name, an empty value and false states", () => {
    assert.equal(
      formatLine({
        level: 0,
        role: "textbox",
        name: " \n\t",
        ref: "b1",
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
      "textbox [b1]",
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
        ref: "b9",
        states: { required: true, field: { protected: true, filled: true }, href: "x" },
      }),
      'textbox "Password" [b9] required protected filled href="x"',
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
        ref: "b12",
        states: { frame: true },
      }),
      ' iframe "Chat" [b12] frame content not read',
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

describe("linkAddress", () => {
  const PAGE = "https://site.example/wiki/Page?from=1#top";

  it("shows a link to the page's own origin as the address after the origin", () => {
    const cases = [
      ["https://site.example/wiki/Foo?x=1#y", "/wiki/Foo?x=1#y"],
      ["https://site.example/", "/"],
      ["https://site.example/page#", "/page#"],
      ["https://site.example/page?", "/page?"],
      ["https://site.example/wiki/Page?from=1#top", "/wiki/Page?from=1#top"],
      ["https://site.example:443/x", "/x"],
      ["https://SITE.example/x", "/x"],
      ["https://site.example/a/../b", "/b"],
    ] as const;
    for (const [href, shown] of cases) assert.equal(linkAddress(href, PAGE), shown, href);
    assert.equal(linkAddress("http://site.example:8080/x", "http://site.example:8080/"), "/x");
  });

  it("keeps the whole address of a link to another origin, or one a path cannot stand for", () => {
    for (const href of [
      "https://other.example/x",
      "https://sub.site.example/x",
      "http://site.example/x",
      "https://site.example:8443/x",
      "https://site.example./x",
      "mailto:me@site.example",
      "javascript:void(0)",
      "ftp://site.example/x",
      "data:text/html,hi",
      "not a url",
      "",
      "https://user@site.example/x",
      "https://:secret@site.example/x",
      "https://user:secret@site.example/x",
      // A user name that starts with the site, which the address after the origin would cut.
      "https://site.example@site.example/x",
      "https://site.example:secret@site.example/x",
      "https://site.example//other.example/x",
      "https://site.example//",
    ]) {
      assert.equal(linkAddress(href, PAGE), href, href);
    }
  });

  it("keeps the whole address on a page that is not an http or https page", () => {
    const href = "https://site.example/x";
    for (const page of [
      "about:blank",
      "not a url",
      "",
      "https://site.example./",
      "blob:https://site.example/0b6c5d1e-2f3a-4b5c-8d7e-9f0a1b2c3d4e",
      "file:///home/page.html",
    ]) {
      assert.equal(linkAddress(href, page), href, page);
    }
    assert.equal(linkAddress("https://site.example./x", "https://site.example./"), "/x");
  });
});

describe("textLine", () => {
  it("gives a text line at its level, written as a text line always was", () => {
    const line = textLine(0, " Forgot  your password? ");
    assert.deepEqual(line, { level: 0, role: "text", name: " Forgot  your password? " });
    assert.ok(line !== undefined);
    assert.equal(formatLine(line), 'text "Forgot your password?"');
    const deep = textLine(2, "a");
    assert.deepEqual(deep, { level: 2, role: "text", name: "a" });
    assert.ok(deep !== undefined);
    assert.equal(formatLine(deep), '  text "a"');
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

describe("createTreeLines", () => {
  const page: Line[] = [
    { level: 0, role: "main", ref: "b1" },
    {
      level: 1,
      role: "link",
      name: "Docs",
      ref: "b2",
      states: { href: "https://example.com/" },
    },
    { level: 1, role: "text", name: "Some  text" },
  ];

  it("writes the lines as formatLine into a TreeText, cut mark included", () => {
    const tree = createTreeLines();
    for (const line of page) assert.equal(tree.add(line), true);
    tree.markCut();
    assert.equal(tree.full, false);
    assert.deepEqual(tree.result(), {
      tree: 'main [b1]\n link "Docs" [b2] href="https://example.com/"\n text "Some text" …',
      truncated: false,
    });
  });

  it("gives what createTreeText gives for the same lines at any cap", () => {
    for (const max of [READ_PAGE_MAX_CHARS, 70, 64, 40, 17, 5]) {
      const tree = createTreeLines(max);
      const text = createTreeText(max);
      for (const [index, line] of page.entries()) {
        assert.equal(tree.add(line), text.add(formatLine(line)), `${max} ${index}`);
        assert.equal(tree.full, text.full, `${max} ${index}`);
        if (index === 1) {
          tree.markCut();
          text.markCut();
        }
      }
      assert.deepEqual(tree.result(), text.result(), String(max));
      assert.equal(tree.full, text.full, String(max));
    }
  });

  it("caps the tree at READ_PAGE_MAX_CHARS by default", () => {
    const tree = createTreeLines();
    assert.equal(tree.add({ level: 0, role: "a".repeat(READ_PAGE_MAX_CHARS) }), true);
    assert.equal(tree.add({ level: 0, role: "b" }), false);
    assert.equal(tree.full, true);
  });
});

describe("createLineFinder", () => {
  const form: Line[] = [
    { level: 0, role: "main", ref: "b1" },
    { level: 1, role: "heading", name: "Sign in", ref: "b2", states: { level: 2 } },
    { level: 1, role: "form", name: "Sign in", ref: "b3" },
    {
      level: 2,
      role: "textbox",
      name: "Email",
      ref: "b4",
      states: { required: true, field: { value: "Me@Example.com" } },
    },
    {
      level: 2,
      role: "textbox",
      name: "Password",
      ref: "b5",
      states: { field: { protected: true, filled: true } },
    },
    {
      level: 2,
      role: "checkbox",
      name: "Remember",
      ref: "b6",
      states: { checked: "checked" },
    },
    { level: 2, role: "text", name: "Forgot  your\n password?" },
    {
      level: 1,
      role: "link",
      name: "Help",
      ref: "b7",
      states: { href: "https://example.com/help" },
    },
  ];
  const MAIN = "main [b1]";
  const FORM = ' form "Sign in" [b3]';
  const EMAIL = '  textbox "Email" [b4] required value="Me@Example.com"';
  const PASSWORD = '  textbox "Password" [b5] protected filled';
  const FORGOT = '  text "Forgot your password?"';
  const HELP = ' link "Help" [b7] href="https://example.com/help"';

  it("finds a name, a field value, a link address and a text, ignoring case", () => {
    const cases: [string, string[]][] = [
      ["EMAIL", [MAIN, FORM, EMAIL]],
      ["me@example.COM", [MAIN, FORM, EMAIL]],
      ["/HELP", [MAIN, HELP]],
      ["your password?", [MAIN, FORM, FORGOT]],
    ];
    for (const [find, lines] of cases) {
      assert.deepEqual(
        search(find, undefined, form),
        { tree: lines.join("\n"), truncated: false, found: { shown: 1, matches: 1, searched: 8 } },
        find,
      );
    }
  });

  it("collapses and trims whitespace in find, as in the text the tree shows", () => {
    assert.equal(
      search("  FORGOT \n YOUR\u0085 ", undefined, form).tree,
      [MAIN, FORM, FORGOT].join("\n"),
    );
  });

  it("writes each ancestor once and leaves out siblings and what a match contains", () => {
    // "o" is in a value, a name, a text and a link address, and in no line of main or the form.
    assert.deepEqual(search("o", undefined, form), {
      tree: [MAIN, FORM, EMAIL, PASSWORD, FORGOT, HELP].join("\n"),
      truncated: false,
      found: { shown: 4, matches: 4, searched: 8 },
    });
    assert.deepEqual(search("sign in", undefined, form), {
      tree: [MAIN, ' heading "Sign in" [b2] level=2', FORM].join("\n"),
      truncated: false,
      found: { shown: 2, matches: 2, searched: 8 },
    });
  });

  it("writes a match that is an ancestor of a later match once", () => {
    const lines: Line[] = [
      { level: 0, role: "list", name: "Items" },
      { level: 1, role: "listitem", name: "Item 1" },
      { level: 2, role: "link", name: "Item 1 details" },
    ];
    assert.deepEqual(search("item", undefined, lines), {
      tree: 'list "Items"\n listitem "Item 1"\n  link "Item 1 details"',
      truncated: false,
      found: { shown: 3, matches: 3, searched: 3 },
    });
  });

  it("keeps only lines of the role given, compared cleaned and in lower case", () => {
    assert.deepEqual(search("sign in", " HEADING\n", form), {
      tree: [MAIN, ' heading "Sign in" [b2] level=2'].join("\n"),
      truncated: false,
      found: { shown: 1, matches: 1, searched: 8 },
    });
    assert.equal(search("sign in", "form", form).tree, [MAIN, FORM].join("\n"));
    assert.deepEqual(search("email", "checkbox", form), {
      tree: "",
      truncated: false,
      found: { shown: 0, matches: 0, searched: 8 },
    });
    assert.equal(search("in", "foo", form).found?.matches, 0);
  });

  it("never matches a protected field's value, whatever the line holds", () => {
    const secret = Object.assign({ protected: true as const, filled: true }, { value: "hunter2" });
    const lines: Line[] = [
      { level: 0, role: "textbox", name: "Password", states: { field: secret } },
      {
        level: 0,
        role: "textbox",
        name: "Empty",
        states: { field: { protected: true, filled: false } },
      },
    ];
    for (const find of ["hunter2", "HUNTER", "protected", "filled", "true"]) {
      assert.deepEqual(search(find, undefined, lines).found, { shown: 0, matches: 0, searched: 2 });
    }
    assert.equal(search("password", undefined, lines).found?.matches, 1);
  });

  it("never matches role words, state words or refs", () => {
    const lines: Line[] = [
      ...form,
      { level: 0, role: "button", ref: "b8", states: { file: true } },
      { level: 0, role: "iframe", name: "", ref: "b9", states: { frame: true } },
      {
        level: 0,
        role: "button",
        name: "Go",
        ref: "b10",
        states: { pressed: true, expanded: true, disabled: true, selected: true },
      },
    ];
    const words = [
      "main",
      "textbox",
      "button",
      "iframe",
      "checked",
      "level=2",
      "level",
      "required",
      "protected",
      "filled",
      "file field",
      "frame content not read",
      "pressed",
      "expanded=true",
      "disabled",
      "selected",
      "value=",
      "href=",
      '"Go"',
      "[b10]",
      "b10",
    ];
    for (const find of words) {
      assert.deepEqual(
        search(find, undefined, lines).found,
        { shown: 0, matches: 0, searched: 11 },
        find,
      );
    }
  });

  it("matches only the text a line shows before its cut", () => {
    const long = `${"a".repeat(MAX_FIELD_CHARS - 5)}needle and more`;
    const lines: Line[] = [
      { level: 0, role: "link", name: long },
      { level: 0, role: "textbox", name: "Name", states: { field: { value: long } } },
      { level: 0, role: "link", name: "Name", states: { href: long } },
    ];
    for (const line of lines) {
      assert.equal(search("needl", undefined, [line]).found?.matches, 1, JSON.stringify(line));
      assert.equal(search("needle", undefined, [line]).found?.matches, 0, JSON.stringify(line));
      // The cut mark is shown between the quotes, so text copied with it matches.
      assert.equal(search("NEEDL…", undefined, [line]).found?.matches, 1, JSON.stringify(line));
    }
    assert.equal(search("Name…", undefined, lines).found?.matches, 0);
  });

  it("finds a text ending in a capital sigma inside a longer word", () => {
    const lines: Line[] = [
      { level: 0, role: "link", name: "ΟΔΟΣΤΡΩΜΑ" },
      { level: 0, role: "link", name: "οδος" },
    ];
    assert.equal(search("ΟΔΟΣ", undefined, lines).found?.matches, 2);
    assert.equal(search("οδοσ", undefined, lines).found?.matches, 2);
    assert.equal(search("Σ", undefined, lines).found?.matches, 2);
  });

  it("follows levels that jump by more than one", () => {
    const lines: Line[] = [
      { level: 0, role: "main" },
      { level: 3, role: "link", name: "A" },
      { level: 1, role: "list" },
      { level: 2, role: "listitem" },
      { level: 4, role: "text", name: "B" },
      { level: 2, role: "link", name: "C" },
    ];
    assert.equal(search("a", undefined, lines).tree, 'main\n   link "A"');
    assert.equal(search("b", undefined, lines).tree, 'main\n list\n  listitem\n    text "B"');
    assert.equal(search("c", undefined, lines).tree, 'main\n list\n  link "C"');
  });

  it("shows the first 20 matches and counts the rest", () => {
    const lines: Line[] = [{ level: 0, role: "list" }];
    for (let index = 1; index <= 30; index += 1) {
      lines.push({ level: 1, role: "listitem", name: `Item ${index}` });
    }
    const shown = lines.slice(0, 21).map(formatLine);
    assert.deepEqual(search("item", undefined, lines), {
      tree: shown.join("\n"),
      truncated: false,
      found: { shown: 20, matches: 30, searched: 31 },
    });
  });

  it("takes every line and stays open once the tree is full, counting on", () => {
    const finder = createLineFinder("item", undefined, 30);
    const lines: Line[] = [{ level: 0, role: "list" }];
    for (let index = 1; index <= 5; index += 1) {
      lines.push({ level: 1, role: "listitem", name: `Item 0${index}` });
    }
    for (const line of lines) {
      assert.equal(finder.add(line), true);
      assert.equal(finder.full, false);
    }
    assert.deepEqual(finder.result(), {
      tree: 'list\n listitem "Item 01"',
      truncated: true,
      found: { shown: 1, matches: 5, searched: 6 },
    });
  });

  it("counts no match as shown when its ancestors fill the tree", () => {
    const lines: Line[] = [
      { level: 0, role: "main", name: "A long landmark name" },
      { level: 1, role: "link", name: "Next" },
    ];
    assert.deepEqual(search("next", undefined, lines, 10), {
      tree: 'main "A lo',
      truncated: true,
      found: { shown: 0, matches: 1, searched: 2 },
    });
    assert.deepEqual(search("landmark", undefined, lines, 10), {
      tree: 'main "A lo',
      truncated: true,
      found: { shown: 0, matches: 1, searched: 2 },
    });
  });

  it("marks the last line given as cut, at once when it was written", () => {
    const finder = createLineFinder("item", undefined);
    finder.add({ level: 0, role: "list" });
    finder.add({ level: 1, role: "listitem", name: "Item 1" });
    finder.markCut();
    finder.add({ level: 1, role: "listitem", name: "Item 2" });
    assert.equal(finder.result().tree, 'list\n listitem "Item 1" …\n listitem "Item 2"');
  });

  it("marks a line not yet written as cut when it is written later", () => {
    const finder = createLineFinder("item", undefined);
    finder.add({ level: 0, role: "list" });
    finder.markCut();
    finder.add({ level: 1, role: "listitem", name: "Item 1" });
    assert.equal(finder.result().tree, 'list …\n listitem "Item 1"');
  });

  it("does nothing for a cut mark before the first line", () => {
    const finder = createLineFinder("item", undefined);
    finder.markCut();
    assert.deepEqual(finder.result(), {
      tree: "",
      truncated: false,
      found: { shown: 0, matches: 0, searched: 0 },
    });
    finder.add({ level: 0, role: "listitem", name: "Item 1" });
    assert.equal(finder.result().tree, 'listitem "Item 1"');
  });

  it("caps the tree at READ_PAGE_MAX_CHARS by default", () => {
    const fits = { level: 0, role: "x".repeat(READ_PAGE_MAX_CHARS - 4), name: "a" };
    assert.equal(formatLine(fits).length, READ_PAGE_MAX_CHARS);
    const next = { level: 0, role: "y", name: "a" };
    const full = search("a", undefined, [fits, next]);
    assert.equal(full.tree, formatLine(fits));
    assert.equal(full.truncated, true);
    assert.deepEqual(full.found, { shown: 1, matches: 2, searched: 2 });
  });

  it("searches only the texts textsOf gives, and only for lines that have the role", () => {
    const asked: Line[] = [];
    const textsOf = (line: Line): readonly string[] => {
      asked.push(line);
      return line.name === "Two" ? ["needle"] : ["other"];
    };
    const finder = createLineFinder("needle", "link", undefined, textsOf);
    const lines: Line[] = [
      { level: 0, role: "list" },
      { level: 1, role: "link", name: "One" },
      { level: 1, role: "link", name: "Two" },
      { level: 1, role: "button", name: "Two" },
    ];
    for (const line of lines) finder.add(line);
    assert.deepEqual(asked, [lines[1], lines[2]]);
    assert.deepEqual(finder.result(), {
      tree: 'list\n link "Two"',
      truncated: false,
      found: { shown: 1, matches: 1, searched: 4 },
    });
  });
});

describe("createLineFinders", () => {
  const lines: (Line | "cut")[] = [
    { level: 0, role: "main", ref: "b1" },
    { level: 1, role: "heading", name: "Sign in", ref: "b2", states: { level: 2 } },
    { level: 1, role: "form", name: "Sign in", ref: "b3" },
    "cut",
    { level: 1, role: "list", name: "Items" },
    ...Array.from({ length: 25 }, (_, index) => ({
      level: 2,
      role: "link",
      name: `Item ${index + 1}`,
      states: { href: `/item/${index + 1}` },
    })),
    { level: 2, role: "listitem", name: "Last item" },
    "cut",
    { level: 1, role: "textbox", name: "Email", states: { field: { value: "Me@Example.com" } } },
  ];
  const queries: { find: string; role?: string }[] = [
    { find: "SIGN IN" },
    { find: "sign in", role: " Heading " },
    { find: "item" },
    { find: "item/2", role: "link" },
    { find: "last", role: "listitem" },
    { find: "example.com" },
    { find: "not on the page" },
  ];

  it("gives each find the result it gets alone, from the same lines and cut marks", () => {
    for (const max of [undefined, 60]) {
      for (const [index, first] of queries.entries()) {
        const rest = queries.filter((_, other) => other !== index);
        const finders = createLineFinders(first.find, first.role, rest, max);
        feed(finders, lines);
        assert.deepEqual(finders.result(), {
          ...alone(first, max),
          finds: rest.map((query) => alone(query, max)),
        });
      }
    }
  });

  it("takes every line and is never full", () => {
    const finders = createLineFinders("item", undefined, [{ find: "none" }], 10);
    for (const line of lines) {
      if (line === "cut") continue;
      assert.equal(finders.add(line), true);
      assert.equal(finders.full, false);
    }
  });

  it("reads each line's texts once, whatever the number of finds", () => {
    let reads = 0;
    const finders = createLineFinders("zz", undefined, [
      { find: "yy" },
      { find: "xx", role: "link" },
      { find: "ww" },
    ]);
    for (const text of ["first", "second"]) {
      finders.add({
        level: 0,
        role: "link",
        get name() {
          reads += 1;
          return text;
        },
      });
    }
    assert.equal(reads, 2);
  });

  function alone(query: { find: string; role?: string }, max: number | undefined): FoundTree {
    const finder = createLineFinder(query.find, query.role, max);
    feed(finder, lines);
    return finder.result();
  }
});

function feed(tree: TreeLines, lines: readonly (Line | "cut")[]): void {
  for (const line of lines) {
    if (line === "cut") tree.markCut();
    else assert.equal(tree.add(line), true);
  }
}

function search(
  find: string,
  role: string | undefined,
  lines: readonly Line[],
  max?: number,
): ReturnType<ReturnType<typeof createLineFinder>["result"]> {
  const finder = createLineFinder(find, role, max);
  for (const line of lines) finder.add(line);
  return finder.result();
}

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
  const field = {
    localName: "input",
    type: "text",
    autocomplete: null,
    wasPassword: false,
    autofilled: false,
  };

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
        autofilled: false,
      }),
      true,
    );
  });

  it("protects inputs and textareas that Firefox autofilled", () => {
    assert.equal(isProtectedField({ ...field, autofilled: true }), true);
    assert.equal(
      isProtectedField({ ...field, localName: "textarea", type: "textarea", autofilled: true }),
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
        autofilled: true,
      }),
      false,
    );
    assert.equal(
      isProtectedField({
        localName: "textarea",
        type: "password",
        autocomplete: null,
        wasPassword: true,
        autofilled: false,
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
