import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  AUTOFILL_CARD,
  AUTOFILL_LOGIN,
  type FixtureServer,
  READ_EDITABLE_LONG,
  READ_HIDDEN,
  READ_LARGE_ITEMS,
  READ_OPEN_DETAILS,
  READ_RENDERED,
  READ_SECRETS,
  READ_UNRENDERED,
  READ_VISIBLE_MARKER,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

const REF = /\[([a-z]{1,7}[1-9][0-9]*)\]/;
const REFS = /\[[a-z]{1,7}[1-9][0-9]*\]/g;
const TREE_CUT =
  "The page tree was cut at 50,000 characters. Read a part of it with ref, or use filter interactive or a smaller depth.";
// Everything a test compares before and after a read: read_page must not change the page.
const SNAPSHOT = `JSON.stringify({
  html: document.documentElement.outerHTML,
  active: document.activeElement === null ? null : document.activeElement.id || document.activeElement.localName,
  fields: Array.from(document.querySelectorAll("input, textarea, select"), (field) =>
    [field.id, field.value, field.checked === undefined ? null : field.checked,
      field.selectedIndex === undefined ? null : field.selectedIndex]),
  scroll: [window.scrollX, window.scrollY],
})`;

const AUTOFILLED = 'document.getElementById("login-name").matches(":autofill")';
const CARD_AUTOFILLED = 'document.getElementById("card-number").matches(":autofill")';
const SPACED_CARD_NUMBER = "4111 1111 1111 1111";
const FRAME_STATE =
  "JSON.stringify({ href: location.href, readyState: document.readyState, timeOrigin: performance.timeOrigin })";

interface Read {
  tree: string;
  texts: string[];
}

// One Firefox for the file: the tests run in order and build on each other's tabs.
describe("read_page in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let formTab = -1;
  let refsTab = -1;
  let keepRef = "";
  let removedRef = "";
  let autofillTab = -1;
  let autofillContext = "";

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("a read changes nothing in the page", async () => {
    formTab = await open("/read-form", TITLES.readForm);
    const context = await contextOf(fixtures.url("/read-form"));
    const before = await firefox.evaluate(context, SNAPSHOT);
    assert.equal(typeof before, "string");
    assert.notEqual(JSON.parse(String(before)).scroll[1], 0, String(before));
    await read(formTab);
    assert.equal(await firefox.evaluate(context, SNAPSHOT), before);
  });

  test("a form reads with names, states and values, and no credential value", async () => {
    const { tree, texts } = await read(formTab);
    assertNoSecrets(texts, [
      READ_SECRETS.passwordAttribute,
      READ_SECRETS.passwordScript,
      READ_SECRETS.oneTimeCode,
      READ_SECRETS.oneTimeCodeArea,
      READ_SECRETS.toggled,
      READ_SECRETS.bare,
      READ_SECRETS.hidden,
    ]);
    assertLines(tree, [
      "main [*]",
      ' heading "Sign in" [*] level=2',
      ' form "Sign in" [*]',
      '  textbox "Email" [*] required value="me@example.com"',
      '  textbox "Password" [*] protected filled',
      '  textbox "Second password" [*] protected filled',
      '  textbox "Empty password" [*] protected',
      '  textbox "Code" [*] protected filled',
      '  searchbox "Search the site" [*]',
      '  checkbox "Remember me" [*] checked',
      '  combobox "Plan" [*] value="Pro"',
      '   option "Free" [*]',
      '   option "Pro" [*] selected',
      '  textbox "Notes" [*] disabled',
      '  textbox "Backup code" [*] protected filled',
      '  button "Use code" [*]',
      '  textbox "Account" [*] readonly value="acct-1"',
      '  textbox "Day" [*]',
      '  textbox "Nickname" [*]',
      '  textbox "Toggled password" [*] protected filled',
      "  textbox [*] protected filled",
      '  button "Sign in" [*]',
    ]);
    assert.equal(tree.includes(READ_HIDDEN.labelPart), false, tree);
    // The date input is one line: nothing of Firefox's own date widget is read.
    const day = lines(tree).findIndex((line) => line.startsWith('  textbox "Day"'));
    assert.match(lines(tree)[day + 1] ?? "", /^ {2}text "Nickname"$/, tree);
  });

  test("a password field the page turns into text or a button stays protected", async () => {
    const context = await contextOf(fixtures.url("/read-form"));
    assert.equal(
      await firefox.evaluate(
        context,
        `document.getElementById("toggle").type = "text";
        document.getElementById("later").hidden = false;
        document.getElementById("hidden-password").type = "text";
        document.getElementById("bare").type = "submit"`,
      ),
      "submit",
    );
    const { tree, texts } = await read(formTab);
    assertNoSecrets(texts, [READ_SECRETS.toggled, READ_SECRETS.bare, READ_SECRETS.hidden]);
    assertLines(tree, [
      '  textbox "Toggled password" [*] protected filled',
      // Hidden at every earlier read, so the walk never reached it there.
      '  textbox "Hidden password" [*] protected filled',
      "  button [*] protected filled",
    ]);
  });

  test("find returns a line whose field value holds the text, after its ancestors", async () => {
    const { tree, texts } = await read(formTab, { find: "ME@example.com" });
    assert.equal(
      withoutRefs(tree),
      [
        "main [*]",
        ' form "Sign in" [*]',
        '  textbox "Email" [*] required value="me@example.com"',
      ].join("\n"),
    );
    assert.equal(texts.length, 1, texts.join("\n"));
  });

  test("find never matches what a protected field holds", async () => {
    const secrets = Object.values(READ_SECRETS);
    for (const secret of secrets) {
      const text = await noMatch(formTab, { find: secret });
      assert.match(text, /^No line matches\. Foxleash searched [0-9,]+ lines\.$/);
      assertNoSecrets([text], secrets);
    }
  });

  test("find with depth ends a matching line whose contents depth cut with the cut mark", async () => {
    const { tree, texts } = await read(formTab, { find: "Sign in", depth: 2 });
    assert.equal(
      withoutRefs(tree),
      ["main [*]", ' heading "Sign in" [*] level=2', ' form "Sign in" [*] …'].join("\n"),
    );
    assert.equal(texts.length, 1, texts.join("\n"));
  });

  test("a password field a click by coordinates turns into text before any read stays protected", async () => {
    // Without tab_open's view, which reads the page.
    const tabId = await open("/read-form?fresh=1", TITLES.readForm, { view: false });
    const context = await contextOf(fixtures.url("/read-form?fresh=1"));
    const answer = await firefox.evaluate(
      context,
      `(() => {
        const button = document.getElementById("show-password");
        button.scrollIntoView({ block: "center" });
        const box = button.getBoundingClientRect();
        return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      })()`,
    );
    const centre: { x: number; y: number } = JSON.parse(String(answer));
    // No ref: getting one needs read_page, which would remember the password fields first. The
    // click's view is the first read, after the field turned into text.
    const clicked = await harness.call(session, "click", { tabId, x: centre.x, y: centre.y });
    assert.equal(clicked.isError, false, clicked.text);
    assertNoSecrets(clicked.texts, [READ_SECRETS.toggled]);
    await pollUntil(
      async () =>
        (await firefox.evaluate(context, 'document.getElementById("toggle").type')) === "text"
          ? true
          : undefined,
      PAGE_TIMEOUT_MS,
      "the toggled field to turn into text",
    );
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, [READ_SECRETS.toggled]);
    assertLines(tree, ['  textbox "Toggled password" [*] protected filled']);
  });

  test("an editable area's line shows the text the user sees in it as its value", async () => {
    const tabId = await open("/read-editable", TITLES.readEditable);
    const hidden = [
      READ_HIDDEN.editableVisibility,
      READ_HIDDEN.editableDisplay,
      READ_HIDDEN.editableContentVisibility,
      READ_HIDDEN.editableLabel,
      READ_HIDDEN.editablePassword,
    ];
    const message = 'textbox "Message Body" [*] value="Hello Ann, See you soon."';
    const outer = 'textbox "Outer" [*] value="Outer text inner text"';
    // Only the editing host has a value, not an editable element inside it.
    const inner = ' textbox "Inner" [*]';
    const fields = [
      message,
      `textbox "Long" [*] value="${READ_EDITABLE_LONG.slice(0, 200)}…"`,
      'textbox "Partly hidden" [*] value="Shown part with a label"',
      'textbox "Content hidden editable" [*]',
      'textbox "Empty" [*]',
      outer,
      inner,
      // A form field's value never becomes part of an editable area's.
      'textbox "With fields" [*] value="Note"',
    ];
    const interactive = await read(tabId, { filter: "interactive" });
    assertNoSecrets(interactive.texts, hidden);
    assertLines(interactive.tree, fields);
    const found = lines(withoutRefs(interactive.tree));
    assert.equal(found[found.indexOf(outer) + 1], inner, interactive.tree);
    // Filter all keeps the text lines under an editable area.
    const all = await read(tabId);
    assertNoSecrets(all.texts, hidden);
    assertLines(all.tree, fields);
    const allFound = lines(withoutRefs(all.tree));
    const at = allFound.indexOf(message);
    assert.deepEqual(
      allFound.slice(at + 1, at + 3),
      [' text "Hello Ann,"', ' text "See you soon."'],
      all.tree,
    );
  });

  test("landmarks nest, with their headings and text", async () => {
    const tabId = await open("/read-landmarks", TITLES.readLandmarks);
    // Links to the page's own site show their address after the origin.
    const home = "/a";
    const docs = "/b";
    assert.equal(
      withoutRefs((await read(tabId)).tree),
      [
        "banner [*]",
        ' navigation "Main" [*]',
        `  link "Home" [*] href="${home}"`,
        `  link "Docs" [*] href="${docs}"`,
        "main [*]",
        ' heading "Landmarks" [*] level=1',
        ' heading "Article title" [*] level=3',
        ' text "Article text"',
        ' region "News" [*]',
        '  heading "News" [*] level=2',
        '  text "News text"',
        ' text "Unnamed section text"',
        "complementary [*]",
        ' text "Aside text"',
        "contentinfo [*]",
        ' text "Footer text"',
      ].join("\n"),
    );
    assert.equal(
      withoutRefs((await read(tabId, { filter: "interactive" })).tree),
      [
        "banner [*]",
        ' navigation "Main" [*]',
        `  link "Home" [*] href="${home}"`,
        `  link "Docs" [*] href="${docs}"`,
      ].join("\n"),
    );
    assert.equal(
      withoutRefs((await read(tabId, { depth: 1 })).tree),
      ["banner [*] …", "main [*] …", "complementary [*] …", "contentinfo [*] …"].join("\n"),
    );
  });

  test("hidden elements are left out, a visible child of a hidden parent is not", async () => {
    const tabId = await open("/read-hidden", TITLES.readHidden);
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, [
      READ_HIDDEN.display,
      READ_HIDDEN.attribute,
      READ_HIDDEN.aria,
      READ_HIDDEN.inert,
      READ_HIDDEN.visibility,
      READ_HIDDEN.answer,
      READ_HIDDEN.contentVisibility,
      READ_HIDDEN.fallback,
      READ_HIDDEN.namespacedOpen,
      READ_HIDDEN.foreignSummary,
      READ_HIDDEN.detailsVisibility,
      READ_HIDDEN.detailsContentVisibilityChild,
      READ_HIDDEN.detailsDisplay,
      READ_HIDDEN.detailsDisplayChild,
      READ_HIDDEN.detailsOwnBox,
      READ_HIDDEN.detailsInName,
      READ_HIDDEN.detailsInNameChild,
      READ_HIDDEN.detailsOwnName,
      READ_HIDDEN.detailsContentVisibility,
      READ_HIDDEN.foreignDetails,
    ]);
    assertLines(tree, [
      'button "Visible child" [*]',
      "group [*]",
      ' button "Question" [*]',
      `text "${READ_VISIBLE_MARKER}"`,
      ' button "Namespaced" [*]',
      ' button "Foreign" [*]',
      'group "Visibility box" [*]',
      ' button "Visibility" [*]',
      ' button "Content visibility" [*]',
      ' button "Display" [*]',
      'button "Pressable" [*]',
      ' button "Shown" [*]',
      ` text "${READ_OPEN_DETAILS.answer}"`,
      ` text "${READ_OPEN_DETAILS.paragraph}"`,
      ` text "${READ_OPEN_DETAILS.contentsChild}"`,
      'heading "Named Inner" [*] level=2',
      `heading "Plain Sum ${READ_OPEN_DETAILS.inName}" [*] level=2`,
      `text "${READ_OPEN_DETAILS.revealed}"`,
    ]);
    const sub = await read(tabId, { ref: refOf(tree, 'group "Visibility box"') });
    assertNoSecrets(sub.texts, [READ_HIDDEN.detailsVisibility]);
    assertLines(sub.tree, ['group "Visibility box" [*]', ' button "Visibility" [*]']);
  });

  test("a full read leaves out what Firefox does not render in a canvas, object, embed, select, svg, wbr or column", async () => {
    const tabId = await open("/read-hidden?fresh=1", TITLES.readHidden);
    const { tree, texts } = await read(tabId);
    const tokens = [
      ...READ_UNRENDERED.flatMap(({ direct, contents }) => [direct, contents]),
      READ_HIDDEN.canvasLabel,
      READ_HIDDEN.canvasValue,
      READ_HIDDEN.legendCanvas,
      READ_HIDDEN.legendSvg,
      READ_HIDDEN.buttonSvg,
      READ_HIDDEN.selectText,
      READ_HIDDEN.selectLabel,
      READ_HIDDEN.selectHeading,
      READ_HIDDEN.svgDefs,
      READ_HIDDEN.svgContentsTspan,
      READ_HIDDEN.svgLanguage,
      READ_HIDDEN.svgSwitch,
      READ_HIDDEN.optionLabelled,
      READ_HIDDEN.optionColumn,
      READ_HIDDEN.optionSkipped,
      READ_HIDDEN.optionCanvas,
      READ_HIDDEN.optionDetails,
      READ_HIDDEN.optionListSkipped,
    ];
    // Lists every leaked token, where assertNoSecrets stops at the first.
    assert.deepEqual(
      tokens.filter((token) => texts.some((text) => text.includes(token))),
      [],
    );
    assertLines(tree, [
      'button "Chart" [*]',
      'group "Billing" [*]',
      'group "Card" [*]',
      'button "Delete" [*]',
      'combobox "Plan" [*] value="Free"',
      ' option "Free" [*] selected',
      'combobox "Labelled pick" [*] value="Labelled free"',
      ' option "Labelled free" [*] selected',
      `text "${READ_RENDERED.svgText}"`,
      `text "${READ_RENDERED.foreign}"`,
      `text "${READ_RENDERED.objectFallback}"`,
      `text "${READ_RENDERED.embedFallback}"`,
      ` option "${READ_RENDERED.wrappedOption}" [*]`,
      ' option "List choice" [*]',
    ]);
    assert.ok(tree.includes(READ_RENDERED.svgLink), tree);
  });

  test("open and closed shadow roots and their slotted text are read", async () => {
    const tabId = await open("/read-shadow", TITLES.readShadow);
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, [READ_SECRETS.shadow]);
    assertLines(tree, [
      'textbox "Shadow password" [*] protected filled',
      'button "Open button" [*]',
      'text "Slotted open text"',
      'button "Closed button" [*] focused',
      'text "Slotted closed text"',
    ]);
    const closed = lines(tree).find((line) => line.startsWith('button "Closed button"')) ?? "";
    const ref = REF.exec(closed)?.[1];
    assert.ok(ref !== undefined, tree);
    const subtree = await read(tabId, { ref });
    assert.equal(lines(subtree.tree)[0], `button "Closed button" [${ref}] focused`);

    // A password field in a closed root stays protected after the page turns it into text.
    const context = await contextOf(fixtures.url("/read-shadow"));
    await firefox.evaluate(context, 'window.shadowPassword.type = "text"');
    const toggled = await read(tabId);
    assertNoSecrets(toggled.texts, [READ_SECRETS.shadow]);
    assertLines(toggled.tree, ['textbox "Shadow password" [*] protected filled']);

    // A ref inside the shadow root of a host the page then hides reads as its own line only.
    const panel = refOf(tree, 'group "Closed button panel"');
    assert.equal(
      withoutRefs((await read(tabId, { ref: panel })).tree),
      'group "Closed button panel" [*]\n button "Closed button inside" [*]',
    );
    await firefox.evaluate(
      context,
      'document.querySelector("closed-widget").setAttribute("aria-hidden", "true")',
    );
    assert.equal(
      withoutRefs((await read(tabId, { ref: panel })).tree),
      'group "Closed button panel" [*]',
    );
  });

  test("text a slot hides as it passes it on to another slot is left out", async () => {
    const tabId = await open("/read-shadow", TITLES.readShadow);
    const hidden = [
      READ_HIDDEN.forwardVisibility,
      READ_HIDDEN.forwardContentVisibility,
      READ_HIDDEN.forwardDisplay,
      READ_HIDDEN.forwardName,
      READ_HIDDEN.forwardFallback,
      READ_HIDDEN.forwardReceiverFallback,
    ];
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, hidden);
    assertLines(tree, ['text "Forwarded text"', 'button "Forwarded button" [*]']);
    const interactive = await read(tabId, { filter: "interactive" });
    assertNoSecrets(interactive.texts, hidden);
    assertLines(interactive.tree, ['button "Forwarded button" [*]']);
  });

  test("a frame is noted, never read", async () => {
    const tabId = await open("/read-frame", TITLES.readFrame);
    const { tree, texts } = await read(tabId);
    assertLines(tree, ['text "Before the frame"', 'iframe "Chat" [*] frame content not read']);
    assertNoSecrets(texts, [READ_HIDDEN.frame, "/read-frame-inner", "Frame link"]);
    const ref = refOf(tree, 'iframe "Chat"');
    assert.equal(
      (await read(tabId, { ref })).tree,
      `iframe "Chat" [${ref}] frame content not read`,
    );
  });

  test("a large page is cut at 50,000 characters on a whole line, with a note", async () => {
    const tabId = await open("/read-large", TITLES.readLarge);
    const all = await read(tabId);
    assert.ok(all.tree.length <= 50_000, `${all.tree.length} characters`);
    assert.ok(all.tree.length > 45_000, `${all.tree.length} characters`);
    const last = lines(all.tree).at(-1) ?? "";
    assert.match(
      last,
      /^( listitem \[[a-z]{1,7}[1-9][0-9]*\]| {2}text "Item [0-9]{4} lorem ipsum dolor sit amet"| {2}link "Link [0-9]{4}" \[[a-z]{1,7}[1-9][0-9]*\] href="\/a")$/,
    );
    assert.deepEqual(all.texts.slice(1), [TREE_CUT]);

    const interactive = await read(tabId, { filter: "interactive" });
    assert.equal(lines(interactive.tree).length, READ_LARGE_ITEMS / 100);
    assert.deepEqual(interactive.texts.length, 1);
    const shallow = await read(tabId, { depth: 1 });
    assert.equal(withoutRefs(shallow.tree), "list [*] …");
    assert.deepEqual(shallow.texts.length, 1);
  });

  test("find returns the matching lines of a large page with their ancestors", async () => {
    const tabId = await open("/read-large", TITLES.readLarge);
    const href = "/a";
    const link = (number: number) =>
      `  link "Link ${String(number).padStart(4, "0")}" [*] href="${href}"`;

    // Past the point where a full read is cut.
    const last = await read(tabId, { find: "Link 2000" });
    assert.equal(withoutRefs(last.tree), ["list [*]", " listitem [*]", link(2000)].join("\n"));
    assert.equal(last.texts.length, 1, last.texts.join("\n"));

    const thousands = await read(tabId, { find: "link 1", role: "link" });
    const links = Array.from({ length: 10 }, (_, index) => [
      " listitem [*]",
      link(1000 + 100 * index),
    ]);
    assert.equal(withoutRefs(thousands.tree), ["list [*]", ...links.flat()].join("\n"));
    assert.equal(thousands.texts.length, 1, thousands.texts.join("\n"));

    // 1001 to 1999 without the ten links: 990 text lines.
    const items = await read(tabId, { find: "ITEM 1" });
    const texts = Array.from({ length: 20 }, (_, index) => [
      " listitem [*]",
      `  text "Item ${1001 + index} lorem ipsum dolor sit amet"`,
    ]);
    assert.equal(withoutRefs(items.tree), ["list [*]", ...texts.flat()].join("\n"));
    assert.deepEqual(items.texts.slice(1), [
      "970 matching lines are not shown. Narrow find, add role, or read one element with ref.",
    ]);

    const addresses = await read(tabId, { find: "/a", role: "link" });
    const all = Array.from({ length: 20 }, (_, index) => [
      " listitem [*]",
      link(100 * (index + 1)),
    ]);
    assert.equal(withoutRefs(addresses.tree), ["list [*]", ...all.flat()].join("\n"));
    assert.equal(addresses.texts.length, 1, addresses.texts.join("\n"));

    // The list, 2,000 list items, 1,980 text lines and 20 links.
    assert.equal(
      await noMatch(tabId, { find: "not on the page" }),
      "No line matches. Foxleash searched 4,001 lines.",
    );
  });

  test("find searches only what filter, depth and ref keep", async () => {
    const tabId = await open("/read-large", TITLES.readLarge);
    const href = "/a";
    const interactive = await read(tabId, { filter: "interactive", find: "link 1" });
    const links = Array.from(
      { length: 10 },
      (_, index) => `link "Link ${1000 + 100 * index}" [*] href="${href}"`,
    );
    assert.equal(withoutRefs(interactive.tree), links.join("\n"));

    assert.equal(
      await noMatch(tabId, { depth: 1, find: "Link 2000" }),
      "No line matches. Foxleash searched 1 line.",
    );

    const last = await read(tabId, { find: "Link 2000" });
    const ref = refOf(last.tree, " listitem");
    const item = await read(tabId, { ref, find: "Link" });
    assert.equal(
      withoutRefs(item.tree),
      ["listitem [*]", ` link "Link 2000" [*] href="${href}"`].join("\n"),
    );
    assert.ok(item.tree.startsWith(`listitem [${ref}]`), item.tree);
  });

  test("an element keeps its ref across reads", async () => {
    refsTab = await open("/read-refs", TITLES.readRefs);
    const first = await read(refsTab);
    const second = await read(refsTab);
    assert.equal(second.tree, first.tree);
    // A link role on an anchor with no address carries no href; an image's alt and a
    // descendant's aria-label name the button and link they are in, also in filter interactive.
    const home = "/a";
    assertLines(first.tree, [
      'link "No address" [*]',
      'button "Close" [*]',
      `link "Home" [*] href="${home}"`,
    ]);
    assertLines((await read(refsTab, { filter: "interactive" })).tree, [
      'button "Close" [*]',
      `link "Home" [*] href="${home}"`,
    ]);
    keepRef = refOf(first.tree, 'button "Keep"');
    removedRef = refOf(first.tree, 'button "Remove me"');
    assert.notEqual(keepRef, removedRef);
    assert.equal((await read(refsTab, { ref: keepRef })).tree, `button "Keep" [${keepRef}]`);
  });

  test("a removed element's ref is refused as no longer on the page", async () => {
    const context = await contextOf(fixtures.url("/read-refs"));
    await firefox.evaluate(context, 'document.getElementById("remove").remove()');
    const text = await refused(refsTab, { ref: removedRef });
    assert.ok(
      text.includes(`Element ${removedRef} is no longer on the page; read the page again`),
      text,
    );
  });

  test("a ref from before a navigation is refused as stale", async () => {
    tabOf(await harness.ok(session, "navigate", { tabId: refsTab, url: fixtures.url("/a") }));
    const text = await refused(refsTab, { ref: keepRef });
    assert.ok(
      text.includes(`Element ${keepRef} is from a page the tab no longer shows; read the page`),
      text,
    );
  });

  test("a ref from before a reload is refused as stale", async () => {
    const tabId = await open("/read-refs", TITLES.readRefs);
    const ref = refOf((await read(tabId)).tree, 'button "Keep"');
    tabOf(await harness.ok(session, "navigate", { tabId, action: "reload" }));
    const text = await refused(tabId, { ref });
    assert.ok(
      text.includes(`Element ${ref} is from a page the tab no longer shows; read the page`),
      text,
    );
    // The reloaded page hands out refs of its own.
    const again = refOf((await read(tabId)).tree, 'button "Keep"');
    assert.notEqual(again, ref);
    assert.equal((await read(tabId, { ref: again })).tree, `button "Keep" [${again}]`);
  });

  test("a ref from the page left by going back is refused as stale", async () => {
    const tabId = await open("/read-refs", TITLES.readRefs);
    await read(tabId);
    tabOf(await harness.ok(session, "navigate", { tabId, url: fixtures.url("/read-landmarks") }));
    const ref = refOf((await read(tabId)).tree, '  link "Home"');
    const back = tabOf(await harness.ok(session, "navigate", { tabId, action: "back" }));
    assert.equal(back.title, TITLES.readRefs);
    const text = await refused(tabId, { ref });
    assert.ok(
      text.includes(`Element ${ref} is from a page the tab no longer shows; read the page`),
      text,
    );
  });

  test("a ref read in another tab of the same page is refused as stale", async () => {
    const first = await open("/read-refs", TITLES.readRefs);
    // Without tab_open's view, whose read would give out the second tab's refs.
    const second = await open("/read-refs", TITLES.readRefs, { view: false });
    const ref = refOf((await read(first)).tree, 'button "Keep"');
    const stale = `Element ${ref} is from a page the tab no longer shows; read the page`;
    // Before and after the other tab's page handed out refs of its own.
    const unread = await refused(second, { ref });
    assert.ok(unread.includes(stale), unread);
    await read(second);
    const text = await refused(second, { ref });
    assert.ok(text.includes(stale), text);
  });

  test("a link to the page's own site shows a path that navigate takes on that site", async () => {
    const tabId = await open("/act-links", TITLES.actLinks);
    const { tree } = await read(tabId);
    const shown = lines(withoutRefs(tree)).map((line) => line.trimStart());
    for (const line of [
      `link "Other site" [*] href="http://localhost:${fixtures.port}/a"`,
      'link "Same site" [*] href="/a"',
      'link "Mail link" [*] href="mailto:someone@example.org?body=x"',
    ]) {
      assert.ok(shown.includes(line), `no line ${JSON.stringify(line)} in:\n${tree}`);
    }
    const same = /link "Same site" \[[a-z]{1,7}[1-9][0-9]*\] href="([^"]+)"/.exec(tree)?.[1];
    assert.equal(same, "/a");
    const tab = tabOf(await harness.ok(session, "navigate", { tabId, url: same }));
    assert.equal(tab.url, fixtures.url("/a"));
    assert.equal(tab.title, TITLES.a);
  });

  test("a ref read_page did not give out is refused", async () => {
    const text = await refused(refsTab, { ref: "nonsense" });
    assert.ok(text.includes("That is not an element reference that read_page gave out."), text);
  });

  test("a blank tab is refused as not a web page", async () => {
    const blank = tabOf(await harness.ok(session, "tab_open")).id;
    const text = await refused(blank);
    assert.ok(text.includes("Foxleash acts only on http and https pages"), text);
  });

  test("a tab redirected to a site the user has not approved is refused", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/read-redirect") }),
    );
    const other = `http://localhost:${fixtures.port}`;
    // tab_open can return before the tab shows the redirect target.
    await pollUntil(
      async () => {
        const listed = tabsOf(await harness.ok(session, "tabs_list")).find(
          ({ id }) => id === tab.id,
        );
        if (listed !== undefined && URL.parse(listed.url)?.origin === other) return listed;
        throw new Error(`tab ${tab.id} is listed as ${JSON.stringify(listed?.url)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${tab.id} to show ${other}`,
    );
    const text = await refused(tab.id);
    assert.ok(text.includes(`Foxleash is not allowed on ${other} in this session`), text);
  });

  test("another session's tab is refused", async () => {
    const other = await harness.connect();
    const tab = tabOf(await harness.ok(other, "tab_open", { url: fixtures.url("/b") }));
    const text = await refused(tab.id);
    assert.ok(text.includes("is not in this session's tab group"), text);
  });

  test("a ref read leaves out what the page hid after the read", async () => {
    const tabId = await open("/read-ref-hidden", TITLES.readRefHidden);
    const { tree } = await read(tabId);
    // Each root but a boxed one is set to display: contents, given an own and a display: contents
    // child's text, and moved into its holder (by default the one with its id); the slotted root
    // stays where it is.
    const roots = [
      { id: "display", label: "Display root", shown: false },
      { id: "cv", label: "Content visibility root", shown: false },
      { id: "box", label: "Box root", shown: false },
      { id: "closed", label: "Closed root", shown: false },
      { id: "nested", label: "Nested root", shown: false },
      { id: "childless", label: "Childless root", shown: false },
      { id: "br", label: "Break root", shown: false },
      { id: "shadow-top", label: "Shadow top root", shown: false },
      { id: "unslotted", label: "Unslotted root", shown: false },
      { id: "fallback", label: "Fallback root", shown: false },
      { id: "visible", label: "Visible root", shown: true },
      { id: "open-details", label: "Open details root", shown: true },
      { id: "slotted", label: "Slotted root", shown: true },
      { id: "shown-fallback", label: "Shown fallback root", shown: true },
      { id: "canvas", label: "Canvas root", shown: false },
      // Its first holder with a box is a div that Firefox calls visible in the canvas.
      { id: "canvas-deep", label: "Deep canvas root", shown: false },
      { id: "object-data", label: "Object data root", shown: false },
      { id: "embed-data", label: "Embed data root", shown: false },
      { id: "select", label: "Select root", shown: false },
      { id: "svg", label: "Svg root", shown: false },
      { id: "svg-g", label: "Svg group root", shown: false },
      { id: "wbr", label: "Word break root", shown: false },
      { id: "col", label: "Column root", shown: false },
      { id: "table-column", label: "Table column root", shown: false },
      { id: "object-fallback", label: "Object fallback root", shown: true },
      { id: "embed-fallback", label: "Embed fallback root", shown: true },
      { id: "svg-foreign", label: "Foreign object root", shown: true },
      {
        id: "canvas-boxed",
        label: "Boxed canvas root",
        shown: false,
        holder: "canvas",
        boxed: true,
      },
      {
        id: "canvas-deep-boxed",
        label: "Boxed deep canvas root",
        shown: false,
        holder: "canvas-deep",
        boxed: true,
      },
      {
        id: "object-fallback-boxed",
        label: "Boxed object fallback root",
        shown: true,
        holder: "object-fallback",
        boxed: true,
      },
    ].map((root) => ({
      ...root,
      ref: refOf(tree, `group "${root.label}"`),
      own: `ref-hidden-${root.id}-own-Ka7`,
      child: `ref-hidden-${root.id}-child-Lb8`,
    }));
    // Each element named from its content gets new text (in `inner` when given), then the page
    // hides it or not.
    const named = [
      { id: "button-closed", line: ' button "Go closed"', role: "button", shown: false },
      { id: "button-box", line: ' button "Go box"', role: "button", shown: false },
      { id: "button-display", line: 'button "Go display"', role: "button", shown: false },
      { id: "button-contents", line: 'button "Go contents"', role: "button", shown: false },
      { id: "option-hidden", line: ' option "Two"', role: "option", shown: false },
      { id: "option-contents", line: ' option "Six"', role: "option", shown: false },
      { id: "option-own", line: ' option "Eight"', role: "option", shown: false },
      { id: "option-group", line: ' option "Nine"', role: "option", shown: false },
      { id: "button-control", line: 'button "Go control"', role: "button", shown: true },
      { id: "option-control", line: ' option "Four"', role: "option", shown: true },
      {
        id: "button-canvas",
        line: 'button "Go canvas"',
        role: "button",
        shown: false,
        inner: "button-canvas-label",
      },
      {
        id: "button-defs",
        line: 'button "Go defs"',
        role: "button",
        shown: false,
        inner: "button-defs-label",
      },
      // Firefox lists an option in a div in its select, not one in an hr.
      { id: "option-wrapped", line: ' option "Wrapped two"', role: "option", shown: true },
      { id: "option-in-rule", line: ' option "Rule two"', role: "option", shown: false },
    ].map((name) => ({
      ...name,
      ref: refOf(tree, name.line),
      token: `ref-hidden-name-${name.id}-Mc9`,
    }));
    const changes = {
      roots: roots.map(({ id, holder, boxed, own, child }) => ({
        id,
        holder: holder ?? id,
        boxed: boxed === true,
        own,
        child,
      })),
      named: named.map(({ id, inner, token }) => ({ id: inner ?? id, token })),
    };
    assert.equal(
      await firefox.evaluate(
        await contextOf(fixtures.url("/read-ref-hidden")),
        `(() => {
          const changes = ${JSON.stringify(changes)};
          for (const { id, holder: holderId, boxed, own, child } of changes.roots) {
            const root = document.getElementById("root-" + id);
            if (!boxed) root.style.display = "contents";
            root.textContent = own + " ";
            const span = document.createElement("span");
            span.style.display = "contents";
            span.textContent = child;
            root.append(span);
            if (id === "slotted") continue;
            const holder = document.getElementById("holder-" + holderId);
            if (holderId === "fallback" || holderId === "shown-fallback") {
              holder.shadowRoot.querySelector("slot").append(root);
            } else if (holderId === "shadow-top") {
              holder.shadowRoot.append(root);
            } else {
              holder.append(root);
            }
          }
          for (const { id, token } of changes.named) {
            document.getElementById(id).textContent = token;
          }
          document.getElementById("name-closed").open = false;
          document.getElementById("name-box").classList.add("box-hidden");
          document.getElementById("button-display").style.display = "none";
          document.getElementById("select-hidden").style.display = "none";
          document.getElementById("select-contents").style.display = "contents";
          document.getElementById("option-own").hidden = true;
          document.getElementById("optgroup-display").style.display = "none";
          const contents = document.getElementById("button-contents");
          contents.style.display = "contents";
          document.getElementById("holder-button-contents").append(contents);
          document.getElementById("holder-canvas").append(document.getElementById("button-canvas"));
          document.getElementById("holder-defs").append(document.getElementById("button-defs"));
          const wrapper = document.createElement("div");
          document.getElementById("select-wrapped").append(wrapper);
          wrapper.append(document.getElementById("option-wrapped"));
          const rule = document.createElement("hr");
          document.getElementById("select-rule").append(rule);
          rule.append(document.getElementById("option-in-rule"));
          return "changed";
        })()`,
      ),
      "changed",
    );

    // Every root and name that fails is listed, not only the first.
    const rootFailures: string[] = [];
    for (const { label, shown, ref, own, child } of roots) {
      const sub = await read(tabId, { ref });
      const wrong: string[] = [];
      if (lines(sub.tree)[0] !== `group "${label}" [${ref}]`) wrong.push("first line");
      for (const token of [own, child]) {
        const right = shown
          ? lines(sub.tree).some((line) => line.startsWith(' text "') && line.includes(token))
          : !sub.texts.some((text) => text.includes(token));
        if (!right) wrong.push(shown ? `no text line with ${token}` : `${token} read`);
      }
      if (wrong.length > 0) rootFailures.push(`${label}: ${wrong.join(", ")} in:\n${sub.tree}`);
    }
    assert.deepEqual(rootFailures, []);
    const nameFailures: string[] = [];
    for (const { id, role, shown, ref, token } of named) {
      const sub = await read(tabId, { ref });
      const first = lines(sub.tree)[0] ?? "";
      const right = shown
        ? first === `${role} "${token}" [${ref}]`
        : first.startsWith(`${role} `) &&
          first.includes(`[${ref}]`) &&
          !sub.texts.some((text) => text.includes(token));
      if (!right) nameFailures.push(`${id} in:\n${sub.tree}`);
    }
    assert.deepEqual(nameFailures, []);
    const all = await read(tabId);
    assertNoSecrets(all.texts, [
      ...roots.filter(({ shown }) => !shown).flatMap(({ own, child }) => [own, child]),
      ...named.filter(({ shown }) => !shown).map(({ token }) => token),
    ]);
  });

  test("a full read leaves out a legend, figcaption or caption the page hides", async () => {
    const tabId = await open("/read-ref-hidden?fresh=1", TITLES.readRefHidden);
    const { tree, texts } = await read(tabId);
    const tokens = [
      READ_HIDDEN.legendDisplay,
      READ_HIDDEN.legendAttribute,
      READ_HIDDEN.figcaptionDisplay,
      READ_HIDDEN.captionAttribute,
    ];
    // Lists every leaked token, where assertNoSecrets stops at the first.
    assert.deepEqual(
      tokens.filter((token) => texts.some((text) => text.includes(token))),
      [],
    );
    assertLines(tree, ['textbox "Hidden label name" [*]']);
  });

  test("a read leaves out a hidden drop-down's options, a list box's hidden selection and a content-visibility: hidden field's value", async () => {
    const path = "/read-ref-hidden?fresh=3";
    const tabId = await open(path, TITLES.readRefHidden);
    const tokens = [
      READ_HIDDEN.optionDropDown,
      READ_HIDDEN.optionDropDownGroup,
      READ_HIDDEN.valueContentVisibility,
      READ_HIDDEN.selectValueContentVisibility,
      READ_HIDDEN.areaValueContentVisibility,
      READ_HIDDEN.labelContentVisibility,
      READ_HIDDEN.listBoxSelectedAttribute,
      READ_HIDDEN.listBoxSelectedVisibility,
      READ_HIDDEN.listBoxSelectedContentVisibility,
      READ_HIDDEN.listBoxSelectedChild,
      READ_HIDDEN.listBoxLabelContent,
      READ_HIDDEN.buttonValueContentVisibility,
      READ_HIDDEN.listBoxSelectedDisplay,
      READ_HIDDEN.listBoxSelectedGroup,
    ];
    const full = await read(tabId);
    assert.deepEqual(leakedTokens([full], tokens), []);
    const listBox = 'listbox "Shown list value"';
    const listBoxValue = 'value="Shown list value one, Shown list value two, Shown row label"';
    const fields = [
      'textbox "Content hidden note"',
      'combobox "Content hidden pick"',
      'textbox "Content hidden area"',
      'textbox "Content hidden label field"',
      'button "Content hidden button"',
    ];
    assertLines(full.tree, [
      ...fields.map((field) => `${field} [*]`),
      // A list box paints an option that is visible in it.
      'option "Shown list choice" [*]',
      'option "Shown multiple choice" [*]',
      // A list box shows its selection only in the rows it paints.
      `${listBox} [*] ${listBoxValue}`,
      ' option "Shown list value one" [*] selected',
      ' option "Shown list value two" [*] selected',
      ' option "Shown row label" [*] selected',
      // Firefox draws a drop-down's selected option's whole label however it is hidden.
      'combobox "Drawn hidden pick" [*] value="Drawn hidden choice"',
      'combobox "Drawn child pick" [*] value="Drawn child drawn tail"',
      'combobox "Drawn empty label pick" [*] value="Drawn empty label text"',
    ]);
    const found = lines(withoutRefs(full.tree));
    assert.equal(
      found.some((line) => line.includes('option "Drawn hidden choice"')),
      false,
      full.tree,
    );
    assert.equal(found[found.indexOf(`${fields[1]} [*]`) + 1], `${fields[2]} [*]`, full.tree);
    const context = await contextOf(fixtures.url(path));
    assert.equal(
      await firefox.evaluate(context, 'CSS.supports("appearance", "base-select")'),
      false,
      "with appearance: base-select a drop-down can draw text other than its option's label",
    );

    // A hidden drop-down has no line, so its refs come from a read while it is shown.
    const select = 'document.getElementById("select-dropdown-hidden").style';
    assert.equal(await firefox.evaluate(context, `${select}.visibility = "visible"`), "visible");
    const shown = (await read(tabId)).tree;
    const option = ` option "${READ_HIDDEN.optionDropDown}"`;
    assertLines(shown, ['combobox "Hidden drop-down pick" [*] value="Drop one"', `${option} [*]`]);
    const selectRef = refOf(shown, 'combobox "Hidden drop-down pick"');
    const optionRef = refOf(shown, option);
    assert.equal(await firefox.evaluate(context, `${select}.visibility = "hidden"`), "hidden");

    const dropDown = [await read(tabId, { ref: selectRef }), await read(tabId, { ref: optionRef })];
    assert.deepEqual(
      dropDown.map(({ tree }) => tree),
      [`combobox "Hidden drop-down pick" [${selectRef}]`, `option [${optionRef}]`],
    );
    const fieldRefs = fields.map((field) => refOf(full.tree, field));
    const fieldReads: Read[] = [];
    for (const ref of fieldRefs) fieldReads.push(await read(tabId, { ref }));
    assert.deepEqual(
      fieldReads.map(({ tree }) => lines(tree)[0]),
      fields.map((field, index) => `${field} [${fieldRefs[index]}]`),
    );
    const listBoxRef = refOf(full.tree, listBox);
    const listBoxRead = await read(tabId, { ref: listBoxRef });
    assert.equal(lines(listBoxRead.tree)[0], `${listBox} [${listBoxRef}] ${listBoxValue}`);
    assert.deepEqual(leakedTokens([...dropDown, ...fieldReads, listBoxRead], tokens), []);
  });

  test("a ref read's first line leaves out a name or value the page hid after the read", async () => {
    const tabId = await open("/read-ref-hidden?fresh=2", TITLES.readRefHidden);
    const { tree } = await read(tabId);
    // Each change runs with `token` set to the case's token. `secret`: the user cannot see it.
    const cases = [
      {
        id: "legend-Pa1",
        line: 'group "Hidden legend"',
        change: `document.getElementById("legend-hidden").textContent = token;
          document.getElementById("fieldset-hidden").style.display = "none";`,
        first: (ref: string) => `group [${ref}]`,
        secret: true,
      },
      {
        id: "figcaption-Qb2",
        line: 'figure "Hidden figcaption"',
        change: `document.getElementById("figcaption-hidden").textContent = token;
          document.getElementById("figure-hidden").style.display = "none";`,
        first: (ref: string) => `figure [${ref}]`,
        secret: true,
      },
      {
        id: "caption-Rc3",
        line: 'table "Hidden caption"',
        change: `document.getElementById("caption-hidden").textContent = token;
          document.getElementById("table-hidden").style.display = "none";`,
        first: (ref: string) => `table [${ref}]`,
        secret: true,
      },
      {
        id: "closed-legend-Sd4",
        line: ' group "Closed legend"',
        change: `document.getElementById("legend-closed").textContent = token;
          document.getElementById("details-legend").open = false;`,
        first: (ref: string) => `group [${ref}]`,
        secret: true,
      },
      {
        id: "wrapped-Te5",
        line: 'textbox "Wrapped name"',
        change: `const label = document.getElementById("label-wrapping");
          label.firstChild.nodeValue = token + " ";
          label.style.display = "none";`,
        first: (ref: string) => `textbox [${ref}]`,
        secret: true,
      },
      {
        id: "both-Uf6",
        line: 'textbox "Both name"',
        change: `document.getElementById("label-both").textContent = token;
          document.getElementById("label-both").style.display = "none";
          document.getElementById("textarea-both").style.display = "none";`,
        first: (ref: string) => `textbox [${ref}]`,
        secret: true,
      },
      {
        id: "invisible-Vg7",
        line: 'textbox "Invisible name"',
        change: `document.getElementById("label-invisible").textContent = token;
          document.getElementById("label-invisible").style.display = "none";
          document.getElementById("input-invisible").style.visibility = "hidden";`,
        first: (ref: string) => `textbox [${ref}]`,
        secret: true,
      },
      {
        id: "kept-Wh8",
        line: 'textbox "Kept name"',
        change: `document.getElementById("label-kept").textContent = token;
          document.getElementById("input-kept").style.display = "none";`,
        first: (ref: string, token: string) => `textbox "${token}" [${ref}]`,
        secret: false,
      },
      {
        id: "value-Xi9",
        line: 'textbox "Hidden value"',
        change: `document.getElementById("input-value-hidden").value = token;
          document.getElementById("input-value-hidden").style.display = "none";`,
        first: (ref: string) => `textbox "Hidden value" [${ref}]`,
        secret: true,
      },
      {
        id: "invisible-value-Yj1",
        line: 'textbox "Invisible value"',
        change: `document.getElementById("input-value-invisible").value = token;
          document.getElementById("input-value-invisible").style.visibility = "hidden";`,
        first: (ref: string) => `textbox "Invisible value" [${ref}]`,
        secret: true,
      },
      {
        id: "area-Zk2",
        line: 'textbox "Hidden area"',
        change: `document.getElementById("textarea-value-hidden").value = token;
          document.getElementById("textarea-value-hidden").style.display = "none";`,
        first: (ref: string) => `textbox "Hidden area" [${ref}]`,
        secret: true,
      },
      {
        id: "editable-Io2",
        line: 'textbox "Hidden editable"',
        change: `document.getElementById("editable-value-hidden").textContent = token;
          document.getElementById("editable-wrap-hidden").style.display = "none";`,
        first: (ref: string) => `textbox "Hidden editable" [${ref}]`,
        secret: true,
      },
      {
        id: "shown-editable-Jp3",
        line: 'textbox "Shown editable"',
        change: `document.getElementById("editable-value-shown").textContent = token;`,
        first: (ref: string, token: string) => `textbox "Shown editable" [${ref}] value="${token}"`,
        secret: false,
      },
      {
        id: "select-Al3",
        line: 'combobox "Hidden value pick"',
        change: `document.getElementById("option-value-hidden").textContent = token;
          document.getElementById("select-value-hidden").style.display = "none";`,
        first: (ref: string) => `combobox "Hidden value pick" [${ref}]`,
        secret: true,
      },
      {
        id: "password-Bm4",
        line: 'textbox "Hidden password field"',
        change: `document.getElementById("input-password-hidden").value = token;
          document.getElementById("input-password-hidden").style.display = "none";`,
        first: (ref: string) => `textbox "Hidden password field" [${ref}] protected filled`,
        secret: true,
      },
      {
        id: "shown-value-Cn5",
        line: 'textbox "Shown value"',
        change: `document.getElementById("input-value-shown").value = token;`,
        first: (ref: string, token: string) => `textbox "Shown value" [${ref}] value="${token}"`,
        secret: false,
      },
      {
        id: "button-Fq8",
        line: 'button "Send hidden"',
        change: `document.getElementById("input-button-hidden").value = token;
          document.getElementById("input-button-hidden").style.display = "none";`,
        first: (ref: string) => `button [${ref}]`,
        secret: true,
      },
      {
        id: "invisible-button-Gr9",
        line: 'button "Send invisible"',
        change: `document.getElementById("input-button-invisible").value = token;
          document.getElementById("input-button-invisible").style.visibility = "hidden";`,
        first: (ref: string) => `button [${ref}]`,
        secret: true,
      },
      {
        id: "shown-button-Hs1",
        line: 'button "Send shown"',
        change: `document.getElementById("input-button-shown").value = token;`,
        first: (ref: string, token: string) => `button "${token}" [${ref}]`,
        secret: false,
      },
      {
        id: "shown-legend-Do6",
        line: 'group "Shown legend"',
        change: `document.getElementById("legend-shown").textContent = token;`,
        first: (ref: string, token: string) => `group "${token}" [${ref}]`,
        secret: false,
      },
      {
        id: "hidden-label-Ep7",
        line: 'textbox "Hidden label name"',
        change: "",
        first: (ref: string) => `textbox "Hidden label name" [${ref}]`,
        secret: false,
      },
    ].map((entry) => ({
      ...entry,
      ref: refOf(tree, entry.line),
      token: `ref-hidden-${entry.id}`,
    }));
    const script = cases
      .map(({ token, change }) => `{ const token = ${JSON.stringify(token)}; ${change} }`)
      .join("\n");
    assert.equal(
      await firefox.evaluate(
        await contextOf(fixtures.url("/read-ref-hidden?fresh=2")),
        `(() => {
          ${script}
          return "changed";
        })()`,
      ),
      "changed",
    );

    const reads: { entry: (typeof cases)[number]; sub: Read }[] = [];
    for (const entry of cases) reads.push({ entry, sub: await read(tabId, { ref: entry.ref }) });
    assert.deepEqual(
      reads.map(({ sub }) => lines(sub.tree)[0]),
      cases.map(({ first, ref, token }) => first(ref, token)),
    );
    for (const { entry, sub } of reads) {
      if (entry.secret) assertNoSecrets(sub.texts, [entry.token]);
    }
    const all = await read(tabId);
    assertNoSecrets(
      all.texts,
      cases.filter(({ secret }) => secret).map(({ token }) => token),
    );
  });

  test("a card number Firefox autofilled into a field with no autocomplete token reads as protected", async () => {
    const tabId = await open("/card-autofill", TITLES.cardAutofill);
    const context = await contextOf(fixtures.url("/card-autofill"));
    await firefox.fillCreditCard(context, "#card-number", AUTOFILL_CARD);
    await pollUntil(
      async () => ((await firefox.evaluate(context, CARD_AUTOFILLED)) === true ? true : undefined),
      PAGE_TIMEOUT_MS,
      "Firefox to fill the card",
    );
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, [AUTOFILL_CARD.number, SPACED_CARD_NUMBER, AUTOFILL_CARD.name]);
    // Without refs, whose random hex ids could hold a digit group by chance.
    assertNoSecrets([withoutRefs(tree)], ["4111", "1111"]);
    assertLines(tree, [
      'textbox "Name on card" [*] protected filled',
      'textbox "Card number" [*] focused protected filled',
      'textbox "Expiry" [*] protected filled',
      'textbox "Plain name" [*] value="MMMM WWWW"',
    ]);
    // get_page_text leaves out every field's value, autofilled or not.
    const pageText = JSON.stringify(await harness.ok(session, "get_page_text", { tabId }));
    assertNoSecrets(
      [pageText],
      [AUTOFILL_CARD.number, SPACED_CARD_NUMBER, "4111", "1111", AUTOFILL_CARD.name],
    );
  });

  test("a field Firefox autofilled from a saved login reads as protected", async () => {
    await firefox.saveLogin(fixtures.site, AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password);
    try {
      // tab_open makes the tab active: login autofill waits for a visible document.
      autofillTab = await open("/autofill", TITLES.autofill);
      autofillContext = await contextOf(fixtures.url("/autofill"));
      await pollUntil(
        async () =>
          (await firefox.evaluate(autofillContext, AUTOFILLED)) === true ? true : undefined,
        PAGE_TIMEOUT_MS,
        "Firefox to fill the saved login",
      );
    } finally {
      await firefox.removeLogins();
    }
    const { tree, texts } = await read(autofillTab);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password]);
    assertLines(tree, [
      'textbox "Login name" [*] protected filled',
      'textbox "Password" [*] protected filled',
      'textbox "Plain name" [*] value="MMMM WWWW"',
    ]);
  });

  test("type refuses a field Firefox autofilled, and it stays protected", async () => {
    const ref = refOf((await read(autofillTab)).tree, 'textbox "Login name"');
    const text = await harness.refused(session, "type", { tabId: autofillTab, ref, text: "x" });
    assert.ok(text.includes(`Firefox filled in element ${ref}`), text);
    assert.equal(await firefox.evaluate(autofillContext, AUTOFILLED), true);
    assert.equal(
      await firefox.evaluate(autofillContext, 'document.getElementById("login-name").value'),
      AUTOFILL_LOGIN.username,
    );
    const { tree, texts } = await read(autofillTab);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password]);
    assertLines(tree, ['textbox "Login name" [*] protected filled']);
  });

  test("a reload brings back no autofilled value", async () => {
    await harness.ok(session, "navigate", { tabId: autofillTab, action: "reload" });
    const { tree, texts } = await read(autofillTab);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password]);
    assertLines(tree, ['textbox "Login name" [*]']);
  });

  test("going back to a page Firefox loads again brings back no autofilled value", async () => {
    const tabId = await filledTab("/autofill-unload?back");
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/a?back") });
    await reloadedOnce("/autofill-unload", () =>
      harness.ok(session, "navigate", { tabId, action: "back" }),
    );
    await assertNoFill(tabId, fixtures.url("/autofill-unload?back"));
  });

  test("going back to a page that changes its address as it loads brings back no autofilled value", async () => {
    const tabId = await filledTab("/autofill-moving?back");
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/a?moving") });
    await reloadedOnce("/autofill-moving", () =>
      harness.ok(session, "navigate", { tabId, action: "back" }),
    );
    await assertNoFill(tabId, fixtures.url("/autofill-moving?back&moved"));
  });

  test("going forward to a page Firefox loads again brings back no autofilled value", async () => {
    const url = fixtures.url("/autofill-unload?forward");
    const tabId = await open("/a?forward", TITLES.a);
    await withLogin(async () => {
      await harness.ok(session, "navigate", { tabId, url });
      await waitForFill(url);
    });
    await harness.ok(session, "navigate", { tabId, action: "back" });
    await reloadedOnce("/autofill-unload", () =>
      harness.ok(session, "navigate", { tabId, action: "forward" }),
    );
    await assertNoFill(tabId, url);
  });

  test("going back over 3 pages never shows the autofilled value unmarked", async () => {
    const path = "/autofill?b3";
    const tabId = await filledTab(path);
    await leave(tabId, "b3", 3);
    const before = fixtures.hits("/autofill");
    await goBack(tabId, 3);
    // Firefox sometimes keeps the page in memory over three steps, mark intact (Navigation Timing
    // still reports back_forward), and Foxleash then does not reload it.
    if ((await firefox.evaluate(await contextOf(fixtures.url(path)), AUTOFILLED)) === true) {
      assert.equal(fixtures.hits("/autofill"), before, "requests for /autofill");
      await assertProtected(tabId);
      return;
    }
    assert.equal(fixtures.hits("/autofill"), before + 1, "requests for /autofill");
    await assertNoFill(tabId, fixtures.url(path));
  });

  test("going back over 4 pages brings back no autofilled value", async () => {
    const path = "/autofill?b4";
    const tabId = await filledTab(path);
    await leave(tabId, "b4", 4);
    await reloadedOnce("/autofill", () => goBack(tabId, 4));
    await assertNoFill(tabId, fixtures.url(path));
  });

  test("going back to a page Firefox kept in memory keeps it filled and protected", async () => {
    const path = "/autofill?kept";
    const tabId = await filledTab(path, { view: false });
    const context = await contextOf(fixtures.url(path));
    // No Foxleash page tool before leaving, not even a view: the page stays as Firefox would keep
    // it. The note in sessionStorage outlives a reload in the tab, so it tells whether Firefox
    // showed this document again from memory, whatever happened after.
    assert.equal(
      await firefox.evaluate(
        context,
        `window.kept = true;
        addEventListener("pageshow", (event) => {
          if (event.persisted) sessionStorage.setItem("shown-from-memory", "yes");
        });
        true`,
      ),
      true,
    );
    const before = fixtures.hits("/autofill");
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/a?kept") });
    const started = Date.now();
    await harness.ok(session, "navigate", { tabId, action: "back", view: false });
    const elapsed = Date.now() - started;
    if ((await firefox.evaluate(context, 'sessionStorage.getItem("shown-from-memory")')) === null) {
      // Firefox did not keep the page this time and loaded it again.
      assert.equal(fixtures.hits("/autofill"), before + 1, "requests for /autofill");
      await assertNoFill(tabId, fixtures.url(path));
      return;
    }
    assert.ok(elapsed < 500, `going back took ${elapsed} ms`);
    assert.equal(
      await firefox.evaluate(context, "window.kept === true"),
      true,
      "Foxleash reloaded a page Firefox showed again from memory",
    );
    assert.equal(fixtures.hits("/autofill"), before, "requests for /autofill");
    assert.equal(await firefox.evaluate(context, AUTOFILLED), true);
    await assertProtected(tabId);
  });

  test("going back and forward between pages Firefox kept in memory answers within half a second and requests nothing", async () => {
    // Not /a: it is served no-store, which Firefox never keeps in memory.
    const first = fixtures.url("/autofill?mem-1");
    const second = fixtures.url("/autofill?mem-2");
    // No Foxleash page tool on these pages, not even a view: they stay as Firefox would keep them.
    const tabId = await open("/autofill?mem-1", TITLES.autofill, { view: false });
    await markForMemory(await contextOf(first));
    await harness.ok(session, "navigate", { tabId, url: second, view: false });
    await markForMemory(await contextOf(second));
    const moves: ["back" | "forward", string][] = [
      ["back", first],
      ["forward", second],
    ];
    let fromMemory = 0;
    for (let round = 1; round <= 3; round += 1) {
      for (const [action, shown] of moves) {
        const label = `${action} in round ${round}`;
        const hits = fixtures.hits("/autofill");
        const started = Date.now();
        await harness.ok(session, "navigate", { tabId, action, view: false });
        const elapsed = Date.now() - started;
        const context = await contextOf(shown);
        // A page shown from memory can read a stale sessionStorage: compare a time, not a count.
        const shownAt = await firefox.evaluate(
          context,
          'sessionStorage.getItem("shown-from-memory-at")',
        );
        if (Number(shownAt) >= started) {
          fromMemory += 1;
          assert.ok(elapsed < 500, `${label} took ${elapsed} ms`);
          assert.equal(fixtures.hits("/autofill"), hits, `requests for /autofill, ${label}`);
          assert.equal(await firefox.evaluate(context, "window.kept === true"), true, label);
        } else {
          // Firefox loaded the page again, and Foxleash reloaded it without the cache.
          assert.equal(fixtures.hits("/autofill"), hits + 1, `requests for /autofill, ${label}`);
          await markForMemory(context);
        }
      }
    }
    assert.ok(fromMemory > 0, "Firefox showed no page from memory");
  });

  test("going back to a page Firefox kept in memory that reloads itself brings back no autofilled value", async () => {
    // Firefox does not keep every page in memory: a few tries, until it showed one from memory.
    let fromMemory = false;
    for (let attempt = 1; attempt <= 3 && !fromMemory; attempt += 1) {
      const path = `/autofill?pageshow-${attempt}`;
      const url = fixtures.url(path);
      const tabId = await filledTab(path);
      const context = await contextOf(url);
      // Sites reload a page shown from memory this way; the reload would put the value back unmarked.
      assert.equal(
        await firefox.evaluate(
          context,
          `addEventListener("pageshow", (event) => {
            if (event.persisted) {
              sessionStorage.setItem("reloaded-itself", "yes");
              location.reload();
            }
          });
          true`,
        ),
        true,
      );
      await harness.ok(session, "navigate", { tabId, url: fixtures.url(`/a?pageshow-${attempt}`) });
      await harness.ok(session, "navigate", { tabId, action: "back" });
      const reloadedItself = await pollUntil(
        async () => {
          const state = await firefox.evaluate(
            context,
            `document.readyState === "complete" && location.href === ${JSON.stringify(url)}
              ? sessionStorage.getItem("reloaded-itself") ?? "no"
              : undefined`,
          );
          return typeof state === "string" ? state : undefined;
        },
        PAGE_TIMEOUT_MS,
        `${url} to finish loading`,
      );
      await assertNoFill(tabId, url, `the page reloaded itself: ${reloadedItself}`);
      fromMemory = reloadedItself === "yes";
    }
    assert.ok(fromMemory, "Firefox showed the page from memory in none of 3 tries");
  });

  test("going back to a page a form sent with POST brings back its autofilled value unmarked", async () => {
    // Accepted in ADR 0025: reloading would send the form again.
    const posted = fixtures.url("/autofill-post");
    const tabId = await withLogin(async () => {
      const opened = await open("/autofill-unload?post", TITLES.autofill);
      const context = await waitForFill(fixtures.url("/autofill-unload?post"));
      await firefox.evaluate(context, 'document.querySelector("form").submit(), true');
      await waitForFill(posted);
      return opened;
    });
    const hits = fixtures.hits("/autofill-post");
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/a?post") });
    await harness.ok(session, "navigate", { tabId, action: "back" });
    const context = await waitForValue(posted);
    assert.equal(await firefox.evaluate(context, AUTOFILLED), false);
    assertLines((await read(tabId)).tree, [
      `textbox "Login name" [*] value="${AUTOFILL_LOGIN.username}"`,
    ]);
    assert.equal(fixtures.hits("/autofill-post"), hits);
  });

  test("going back to a page whose frame a form sent with POST sends that form no second time", async () => {
    // The frame measurement of ADR 0051. Firefox fills no saved login into a frame from another
    // site (ADR 0025), so the test sets the values a fill or the user would leave.
    const page = "/autofill-framed-unload";
    const site = `http://localhost:${fixtures.port}`;
    const tabId = await open(page, TITLES.autofillFramed);
    const form = await frameLoad(await contextOf(fixtures.url(page)), `${site}/autofill-frame`, 0);
    await firefox.evaluate(form.context, 'document.querySelector("form").submit(), true');
    const posted = await frameLoad(
      await contextOf(fixtures.url(page)),
      `${site}/autofill-frame-post`,
      0,
    );
    await firefox.evaluate(
      posted.context,
      `document.getElementById("login-name").value = ${JSON.stringify(AUTOFILL_LOGIN.username)};
      document.getElementById("plain-name").value = "Typed in the frame";`,
    );
    const posts = fixtures.hits("/autofill-frame-post");
    const pageHits = fixtures.hits(page);
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/a?frame-post") });
    await harness.ok(session, "navigate", { tabId, action: "back" });
    assert.equal(fixtures.hits("/autofill-frame-post"), posts);
    const top = await contextOf(fixtures.url(page));
    const type = await firefox.evaluate(top, 'performance.getEntriesByType("navigation")[0].type');
    if (type === "back_forward") {
      // Foxleash saw the frame's POST and loaded nothing: Firefox puts the frame's values back.
      assert.equal(fixtures.hits(page), pageHits);
      const restored = await frameLoad(top, `${site}/autofill-frame-post`, posted.timeOrigin);
      await pollUntil(
        async () =>
          (await firefox.evaluate(
            restored.context,
            'document.getElementById("login-name").value',
          )) === AUTOFILL_LOGIN.username
            ? true
            : undefined,
        PAGE_TIMEOUT_MS,
        "Firefox to put the login name back into the frame",
      );
      assert.equal(
        await firefox.evaluate(restored.context, 'document.getElementById("plain-name").value'),
        "Typed in the frame",
      );
      assert.equal(await firefox.evaluate(restored.context, AUTOFILLED), false);
    } else if (type === "navigate") {
      // Foxleash loaded the page's address again: the frame loads from its src.
      assert.equal(fixtures.hits(page), pageHits + 1);
      const { context } = await frameLoad(top, `${site}/autofill-frame`, 0);
      assert.equal(
        await firefox.evaluate(context, 'document.getElementById("login-name").value'),
        "",
      );
      assert.equal(await firefox.evaluate(context, AUTOFILLED), false);
      assert.equal(
        await firefox.evaluate(context, 'document.getElementById("plain-name").value'),
        "MMMM WWWW",
      );
    } else {
      assert.fail(`the page loaded with navigation type ${String(type)}`);
    }
  });

  test("navigating a tab to its own address brings back no autofilled value", async () => {
    const path = "/autofill?same";
    const tabId = await filledTab(path);
    await harness.ok(session, "navigate", { tabId, url: fixtures.url(path) });
    await assertNoFill(tabId, fixtures.url(path));
  });

  test("a reload brings back no value in a frame from another site", async () => {
    // Firefox fills no saved login into a frame from another site (ADR 0025), so the test sets
    // the values a fill or the user would leave. It records what Firefox does and does not guard
    // bypassCache: a reload without it restores nothing in the frame either.
    const tabId = await open("/autofill-framed", TITLES.autofillFramed);
    const top = await contextOf(fixtures.url("/autofill-framed"));
    const frameUrl = `http://localhost:${fixtures.port}/autofill?frame`;
    const loaded = await frameLoad(top, frameUrl, 0);
    await firefox.evaluate(
      loaded.context,
      `document.getElementById("login-name").value = ${JSON.stringify(AUTOFILL_LOGIN.username)};
      document.getElementById("plain-name").value = "Typed in the frame";`,
    );
    await harness.ok(session, "navigate", { tabId, action: "reload" });
    const { context } = await frameLoad(top, frameUrl, loaded.timeOrigin);
    assert.equal(
      await firefox.evaluate(context, 'document.getElementById("login-name").value'),
      "",
    );
    assert.equal(await firefox.evaluate(context, AUTOFILLED), false);
    assert.equal(
      await firefox.evaluate(context, 'document.getElementById("plain-name").value'),
      "MMMM WWWW",
    );
  });

  test("a tab Firefox unloaded brings its autofilled value back unmarked when it loads again", async () => {
    // Accepted in ADR 0025: Firefox's session store puts the value back without the mark.
    const url = fixtures.url("/autofill?unloaded");
    const tabId = await filledTab("/autofill?unloaded");
    // Firefox does not unload the selected tab.
    await open("/a?unloaded", TITLES.a);
    await firefox.discardTab(url);
    await harness.ok(session, "tab_select", { tabId });
    const context = await waitForValue(url);
    assert.equal(await firefox.evaluate(context, AUTOFILLED), false);
    assertLines((await read(tabId)).tree, [
      `textbox "Login name" [*] value="${AUTOFILL_LOGIN.username}"`,
    ]);
  });

  // Last: the blocklist then covers the fixture server for the rest of the file.
  test("a tab on a blocked site is refused", async () => {
    await harness.seedSettings({ blocklist: ["127.0.0.1", "localhost"] });
    const text = await refused(formTab);
    assert.ok(text.includes(fixtures.site), text);
    assert.ok(text.includes("Foxleash's blocklist"), text);
  });

  async function open(
    path: string,
    title: string,
    args: Record<string, unknown> = {},
  ): Promise<number> {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url(path), ...args }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    return tab.id;
  }

  async function read(tabId: number, args: Record<string, unknown> = {}): Promise<Read> {
    const result = await harness.call(session, "read_page", { tabId, ...args });
    assert.equal(result.isError, false, result.text);
    const tree = untrustedContent(result.text);
    assert.ok(tree !== undefined, `not one untrusted frame:\n${result.text}`);
    return { tree, texts: result.texts };
  }

  /** The one text of a read with find that matched no line, which is Foxleash's own. */
  async function noMatch(tabId: number, args: Record<string, unknown>): Promise<string> {
    const result = await harness.call(session, "read_page", { tabId, ...args });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.texts, [result.text]);
    assert.equal(untrustedContent(result.text), undefined, result.text);
    return result.text;
  }

  async function refused(tabId: number, args: Record<string, unknown> = {}): Promise<string> {
    return harness.refused(session, "read_page", { tabId, ...args });
  }

  async function contextOf(url: string): Promise<string> {
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    return found.context;
  }

  /** Opens `path` in a new tab and returns its id once Firefox filled in the saved login. */
  function filledTab(path: string, args: Record<string, unknown> = {}): Promise<number> {
    return withLogin(async () => {
      // tab_open makes the tab active: login autofill waits for a visible document.
      const tabId = await open(path, TITLES.autofill, args);
      await waitForFill(fixtures.url(path));
      return tabId;
    });
  }

  /** Runs `steps` with the autofill login saved, and removes it after, so Firefox fills no more. */
  async function withLogin<T>(steps: () => Promise<T>): Promise<T> {
    await firefox.saveLogin(fixtures.site, AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password);
    try {
      return await steps();
    } finally {
      await firefox.removeLogins();
    }
  }

  /** The context of the tab showing `url`, once Firefox has filled in its login name field. */
  function waitForFill(url: string): Promise<string> {
    return pollUntil(
      async () => {
        const context = await contextOf(url);
        return (await firefox.evaluate(context, AUTOFILLED)) === true ? context : undefined;
      },
      PAGE_TIMEOUT_MS,
      `Firefox to fill the saved login into ${url}`,
    );
  }

  /** The context of the tab showing `url`, once its login name field holds the saved login. */
  function waitForValue(url: string): Promise<string> {
    return pollUntil(
      async () => {
        const context = await contextOf(url);
        const value = await firefox.evaluate(
          context,
          'document.getElementById("login-name").value',
        );
        return value === AUTOFILL_LOGIN.username ? context : undefined;
      },
      PAGE_TIMEOUT_MS,
      `Firefox to put the login name back into ${url}`,
    );
  }

  /**
   * Runs `steps` and asserts they requested `path` from the server once: Firefox loads the page
   * again from its cache, so the one request is Foxleash's reload without the cache.
   */
  async function reloadedOnce(path: string, steps: () => Promise<unknown>): Promise<void> {
    const before = fixtures.hits(path);
    await steps();
    assert.equal(fixtures.hits(path), before + 1, `requests for ${path}`);
  }

  /** Navigates the tab to `pages` more pages, `/a?<label>-1` and on. */
  async function leave(tabId: number, label: string, pages: number): Promise<void> {
    for (let page = 1; page <= pages; page += 1) {
      await harness.ok(session, "navigate", { tabId, url: fixtures.url(`/a?${label}-${page}`) });
    }
  }

  async function goBack(tabId: number, pages: number): Promise<void> {
    for (let page = 1; page <= pages; page += 1) {
      await harness.ok(session, "navigate", { tabId, action: "back" });
    }
  }

  /** Asserts the login name field of the tab showing `url` is empty, unmarked and read so. */
  async function assertNoFill(tabId: number, url: string, label = url): Promise<void> {
    const context = await contextOf(url);
    assert.equal(
      await firefox.evaluate(context, 'document.getElementById("login-name").value'),
      "",
      label,
    );
    assert.equal(await firefox.evaluate(context, AUTOFILLED), false, label);
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password]);
    assertLines(tree, ['textbox "Login name" [*]']);
  }

  /** Asserts read_page shows the tab's login name field as protected and filled. */
  async function assertProtected(tabId: number): Promise<void> {
    const { tree, texts } = await read(tabId);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password]);
    assertLines(tree, ['textbox "Login name" [*] protected filled']);
  }

  /**
   * Marks the document in `context` with `window.kept` and notes, in the tab's sessionStorage
   * (`shown-from-memory-at`), when Firefox last showed it again from memory.
   */
  async function markForMemory(context: string): Promise<void> {
    assert.equal(
      await firefox.evaluate(
        context,
        `window.kept = true;
        addEventListener("pageshow", (event) => {
          if (event.persisted) {
            sessionStorage.setItem("shown-from-memory-at", String(Date.now()));
          }
        });
        true`,
      ),
      true,
    );
  }

  /**
   * The frame of `top` showing `url`, once a document other than the one that started at
   * `before` (a `performance.timeOrigin`, or 0 for any) has loaded in it. Each frame is asked
   * for its own address, since the tree's URL of a frame from another site can be out of date.
   */
  function frameLoad(
    top: string,
    url: string,
    before: number,
  ): Promise<{ context: string; timeOrigin: number }> {
    return pollUntil(
      async () => {
        const seen: unknown[] = [];
        for (const frame of await firefox.frames(top)) {
          let state: unknown;
          try {
            state = JSON.parse(String(await firefox.evaluate(frame.context, FRAME_STATE)));
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            seen.push({ context: frame.context, treeUrl: frame.url, error: message });
            continue;
          }
          seen.push({ context: frame.context, treeUrl: frame.url, state });
          if (
            isRecord(state) &&
            state.href === url &&
            state.readyState === "complete" &&
            typeof state.timeOrigin === "number" &&
            state.timeOrigin !== before
          ) {
            return { context: frame.context, timeOrigin: state.timeOrigin };
          }
        }
        throw new Error(`the frames of ${top} are ${JSON.stringify(seen)}`);
      },
      PAGE_TIMEOUT_MS,
      `${url} to load in a frame`,
    );
  }
});

function lines(tree: string): string[] {
  return tree.split("\n");
}

function withoutRefs(tree: string): string {
  return tree.replace(REFS, "[*]");
}

/** Asserts each expected line, `[*]` standing for a ref, is a whole line of the tree. */
function assertLines(tree: string, expected: string[]): void {
  const found = lines(withoutRefs(tree));
  for (const line of expected) {
    assert.ok(found.includes(line), `no line ${JSON.stringify(line)} in:\n${tree}`);
  }
}

function assertNoSecrets(texts: string[], secrets: string[]): void {
  for (const secret of secrets) {
    for (const text of texts) assert.equal(text.includes(secret), false, `${secret} in:\n${text}`);
  }
}

/** The tokens any of the reads' texts contain, all of them where assertNoSecrets stops at one. */
function leakedTokens(reads: Read[], tokens: string[]): string[] {
  return tokens.filter((token) =>
    reads.some(({ texts }) => texts.some((text) => text.includes(token))),
  );
}

function refOf(tree: string, start: string): string {
  const line = lines(tree).find((candidate) => candidate.startsWith(start)) ?? "";
  const ref = REF.exec(line)?.[1];
  assert.ok(ref !== undefined, `no ref on a line starting ${start} in:\n${tree}`);
  return ref;
}
