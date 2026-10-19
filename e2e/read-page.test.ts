import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Firefox } from "./firefox.ts";
import {
  type FixtureServer,
  READ_HIDDEN,
  READ_LARGE_ITEMS,
  READ_SECRETS,
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
  untrustedContent,
} from "./harness.ts";

const REF = /\[([0-9a-f]{8}-[1-9][0-9]*)\]/;
const REFS = /\[[0-9a-f]{8}-[1-9][0-9]*\]/g;
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
      '  heading "Sign in" [*] level=2',
      '  form "Sign in" [*]',
      '    textbox "Email" [*] required value="me@example.com"',
      '    textbox "Password" [*] protected filled',
      '    textbox "Second password" [*] protected filled',
      '    textbox "Empty password" [*] protected',
      '    textbox "Code" [*] protected filled',
      '    searchbox "Search the site" [*]',
      '    checkbox "Remember me" [*] checked',
      '    combobox "Plan" [*] value="Pro"',
      '      option "Free" [*]',
      '      option "Pro" [*] selected',
      '    textbox "Notes" [*] disabled',
      '    textbox "Backup code" [*] protected filled',
      '    button "Use code" [*]',
      '    textbox "Account" [*] readonly value="acct-1"',
      '    textbox "Day" [*]',
      '    textbox "Nickname" [*]',
      '    textbox "Toggled password" [*] protected filled',
      "    textbox [*] protected filled",
      '    button "Sign in" [*]',
    ]);
    assert.equal(tree.includes(READ_HIDDEN.labelPart), false, tree);
    // The date input is one line: nothing of Firefox's own date widget is read.
    const day = lines(tree).findIndex((line) => line.startsWith('    textbox "Day"'));
    assert.match(lines(tree)[day + 1] ?? "", /^ {4}text "Nickname"$/, tree);
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
      '    textbox "Toggled password" [*] protected filled',
      // Hidden at every earlier read, so the walk never reached it there.
      '    textbox "Hidden password" [*] protected filled',
      "    button [*] protected filled",
    ]);
  });

  test("landmarks nest, with their headings and text", async () => {
    const tabId = await open("/read-landmarks", TITLES.readLandmarks);
    const home = fixtures.url("/a");
    const docs = fixtures.url("/b");
    assert.equal(
      withoutRefs((await read(tabId)).tree),
      [
        "banner [*]",
        '  navigation "Main" [*]',
        `    link "Home" [*] href="${home}"`,
        `    link "Docs" [*] href="${docs}"`,
        "main [*]",
        '  heading "Landmarks" [*] level=1',
        '  heading "Article title" [*] level=3',
        '  text "Article text"',
        '  region "News" [*]',
        '    heading "News" [*] level=2',
        '    text "News text"',
        '  text "Unnamed section text"',
        "complementary [*]",
        '  text "Aside text"',
        "contentinfo [*]",
        '  text "Footer text"',
      ].join("\n"),
    );
    assert.equal(
      withoutRefs((await read(tabId, { filter: "interactive" })).tree),
      [
        "banner [*]",
        '  navigation "Main" [*]',
        `    link "Home" [*] href="${home}"`,
        `    link "Docs" [*] href="${docs}"`,
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
    ]);
    assertLines(tree, [
      'button "Visible child" [*]',
      "group [*]",
      '  button "Question" [*]',
      `text "${READ_VISIBLE_MARKER}"`,
    ]);
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
      'group "Closed button panel" [*]\n  button "Closed button inside" [*]',
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
      /^( {2}listitem \[[0-9a-f]{8}-[0-9]+\]| {4}text "Item [0-9]{4} lorem ipsum dolor sit amet"| {4}link "Link [0-9]{4}" \[[0-9a-f]{8}-[0-9]+\] href="[^"]+\/a")$/,
    );
    assert.deepEqual(all.texts.slice(1), [TREE_CUT]);

    const interactive = await read(tabId, { filter: "interactive" });
    assert.equal(lines(interactive.tree).length, READ_LARGE_ITEMS / 100);
    assert.deepEqual(interactive.texts.length, 1);
    const shallow = await read(tabId, { depth: 1 });
    assert.equal(withoutRefs(shallow.tree), "list [*] …");
    assert.deepEqual(shallow.texts.length, 1);
  });

  test("an element keeps its ref across reads", async () => {
    refsTab = await open("/read-refs", TITLES.readRefs);
    const first = await read(refsTab);
    const second = await read(refsTab);
    assert.equal(second.tree, first.tree);
    // A link role on an anchor with no address carries no href; an image's alt and a
    // descendant's aria-label name the button and link they are in, also in filter interactive.
    const home = fixtures.url("/a");
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

  test("a ref read_page did not give out is refused", async () => {
    const text = await refused(refsTab, { ref: "nonsense" });
    assert.ok(text.includes("That is not an element reference that read_page gave out."), text);
  });

  test("a blank tab is refused as not a web page", async () => {
    const blank = tabOf(await harness.ok(session, "tab_open")).id;
    const text = await refused(blank);
    assert.ok(text.includes("Foxhand acts only on http and https pages"), text);
  });

  test("a tab redirected to a site the user has not approved is refused", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/read-redirect") }),
    );
    const other = `http://localhost:${fixtures.port}`;
    const text = await refused(tab.id);
    assert.ok(text.includes(`Foxhand is not allowed on ${other} in this session`), text);
  });

  test("another session's tab is refused", async () => {
    const other = await harness.connect();
    const tab = tabOf(await harness.ok(other, "tab_open", { url: fixtures.url("/b") }));
    const text = await refused(tab.id);
    assert.ok(text.includes("is not in this session's tab group"), text);
  });

  // Last: the blocklist then covers the fixture server for the rest of the file.
  test("a tab on a blocked site is refused", async () => {
    await harness.seedSettings({ blocklist: ["127.0.0.1", "localhost"] });
    const text = await refused(formTab);
    assert.ok(text.includes(fixtures.site), text);
    assert.ok(text.includes("Foxhand's blocklist"), text);
  });

  async function open(path: string, title: string): Promise<number> {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url(path) }));
    assert.equal(tab.title, title);
    return tab.id;
  }

  async function read(tabId: number, args: Record<string, unknown> = {}): Promise<Read> {
    const result = await harness.call(session, "read_page", { tabId, ...args });
    assert.equal(result.isError, false, result.text);
    const tree = untrustedContent(result.text);
    assert.ok(tree !== undefined, `not one untrusted frame:\n${result.text}`);
    return { tree, texts: result.texts };
  }

  async function refused(tabId: number, args: Record<string, unknown> = {}): Promise<string> {
    return harness.refused(session, "read_page", { tabId, ...args });
  }

  async function contextOf(url: string): Promise<string> {
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    return found.context;
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

function refOf(tree: string, start: string): string {
  const line = lines(tree).find((candidate) => candidate.startsWith(start)) ?? "";
  const ref = REF.exec(line)?.[1];
  assert.ok(ref !== undefined, `no ref on a line starting ${start} in:\n${tree}`);
  return ref;
}
