import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAGE_VIEW_MAX_CHARS, type PageView, READ_PAGE_MAX_CHARS } from "@foxleash/protocol";
import { createFakeBrowser, createFakeTimers, type FakeTab, flush } from "./fake-browser.ts";
import { lineDiff, MAX_DIFF_CELLS } from "./line-diff.ts";
import { createTreeText } from "./page-tree.ts";
import {
  changedLines,
  createPageViews,
  cutTree,
  FOCUS_CONTEXT_LINES,
  type TreeRead,
} from "./page-view.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite } from "./settings.ts";
import { createSiteAccess, type SessionMemory } from "./site-access.ts";

const SITE = "https://a.example";
const TREE = 'main\n heading "Shop" [a1]\n button "Add" [a2]\n status';

describe("page views", { timeout: 10000 }, () => {
  it("gives a document's whole tree, then the lines that changed, then that none did", async () => {
    const { see, tab } = await setup();
    const tabId = tab.id;
    assert.deepEqual(see("s1", tabId, TREE), {
      kind: "tree",
      tree: TREE,
      omitted: 0,
      truncated: false,
    });
    const added = `${TREE}\n  text "Added"`;
    assert.deepEqual(see("s1", tabId, added), {
      kind: "changes",
      lines: '  main\n   status\n+   text "Added"',
      truncated: false,
    });
    assert.deepEqual(see("s1", tabId, added), { kind: "unchanged", truncated: false });
  });

  it("gives the whole tree again for a document committed since", async () => {
    const { fake, see, tab } = await setup();
    see("s1", tab.id, TREE);
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    assert.equal(see("s1", tab.id, TREE).kind, "tree");
  });

  it("keeps the last view per session and per tab", async () => {
    const { see, tab, other } = await setup();
    see("s1", tab.id, TREE);
    assert.equal(see("s2", tab.id, TREE).kind, "tree");
    assert.equal(see("s1", other.id, TREE).kind, "tree");
    assert.equal(see("s1", tab.id, TREE).kind, "unchanged");
    assert.equal(see("s2", tab.id, TREE).kind, "unchanged");
  });

  it("forgets a session's views when it ends, or one when told", async () => {
    const { see, views, tab, other } = await setup();
    see("s1", tab.id, TREE);
    see("s1", other.id, TREE);
    see("s2", tab.id, TREE);
    views.endSession("s1");
    assert.equal(see("s1", tab.id, TREE).kind, "tree");
    assert.equal(see("s1", other.id, TREE).kind, "tree");
    assert.equal(see("s2", tab.id, TREE).kind, "unchanged");
    views.forget("s2", tab.id);
    views.forget("s3", 999);
    assert.equal(see("s2", tab.id, TREE).kind, "tree");
    assert.equal(see("s1", tab.id, TREE).kind, "unchanged");
  });

  it("records nothing from a read during which the tab committed another document", async () => {
    const { fake, views, see, tab } = await setup();
    const before = views.document(tab.id);
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    const read = { tree: TREE, truncated: false };
    assert.equal(views.view("s1", tab.id, before, read, []).kind, "tree");
    views.record("s1", tab.id, before, read);
    assert.equal(see("s1", tab.id, TREE).kind, "tree");
  });

  it("shows, and records nothing from, a tab with no live document", async () => {
    const { fake, views, tab } = await setup();
    fake.ungroup(tab.id);
    await flush();
    assert.equal(views.document(tab.id), undefined);
    const read = { tree: TREE, truncated: false };
    for (let time = 0; time < 2; time += 1) {
      assert.deepEqual(views.view("s1", tab.id, undefined, read, []), {
        kind: "tree",
        tree: TREE,
        omitted: 0,
        truncated: false,
      });
      views.record("s1", tab.id, undefined, read);
    }
  });

  it("stops taking the document as the same once the session's approval of its site ends", async () => {
    const { views, see, tab, sessions, access } = await setup();
    sessions.set("s1", {
      allowed: new Set([SITE, "https://b.example"]),
      refused: new Set(),
      closed: 0,
    });
    sessions.set("s2", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    const before = views.document(tab.id);
    see("s1", tab.id, TREE);
    // A tab of s1's group, viewed by s2 too.
    see("s2", tab.id, TREE);
    access.forget("s2", SITE);
    access.forget("s1", "https://b.example");
    assert.equal(see("s1", tab.id, TREE).kind, "unchanged");
    assert.equal(see("s2", tab.id, TREE).kind, "tree");
    access.forget("s1", SITE);
    // SITE's stored approval still passes the gate: only the drop at the withdrawal ends it.
    assert.equal(views.document(tab.id), undefined);
    assert.equal(
      views.view("s1", tab.id, before, { tree: TREE, truncated: false }, []).kind,
      "tree",
    );
  });

  it("makes the next view say what changed since a recorded read_page", async () => {
    const { views, see, tab } = await setup();
    views.record("s1", tab.id, views.document(tab.id), { tree: TREE, truncated: false });
    assert.equal(see("s1", tab.id, TREE).kind, "unchanged");
  });

  it("forgets a tab's views when it closes", async () => {
    const { fake, views, see, tab } = await setup();
    see("s1", tab.id, TREE);
    fake.removeTab(tab.id);
    assert.equal(views.document(tab.id), undefined);
  });

  it("gives the tree instead of changes that would be longer than it", async () => {
    const { see, tab } = await setup();
    see("s1", tab.id, "main\n a\n b\n c");
    assert.deepEqual(see("s1", tab.id, "main\n x\n y\n z"), {
      kind: "tree",
      tree: "main\n x\n y\n z",
      omitted: 0,
      truncated: false,
    });
  });

  it("gives the changes when they are as long as the tree", async () => {
    const { see, tab } = await setup();
    see("s1", tab.id, "aaaaa\nb");
    assert.deepEqual(see("s1", tab.id, "aaaaa\nc"), {
      kind: "changes",
      lines: "- b\n+ c",
      truncated: false,
    });
  });

  it("gives the tree when the changes pass the diff's cap", async () => {
    const { see, tab } = await setup();
    const count = Math.ceil(Math.sqrt(MAX_DIFF_CELLS));
    const lines = (word: string) =>
      Array.from({ length: count }, (_, index) => `${word}${index}`).join("\n");
    see("s1", tab.id, lines("a"));
    const view = see("s1", tab.id, lines("b"));
    assert.equal(view.kind, "tree");
    assert.ok(view.kind === "tree" && view.omitted > 0);
  });

  it("says a comparison of reads cut at the cap covers only their start", async () => {
    const { see, tab } = await setup();
    const listing = Array.from(
      { length: 3000 },
      (_, index) => ` listitem "Product ${index} of the catalogue"`,
    );
    const cut = (lines: string[]): TreeRead => {
      const text = createTreeText(READ_PAGE_MAX_CHARS);
      for (const line of ["main", ...lines]) text.add(line);
      return text.result();
    };
    const first = cut(listing);
    assert.equal(first.truncated, true);
    see("s1", tab.id, first.tree, first.truncated);
    // A toast at the end is past the cut: the reads are the same.
    const toasted = cut([...listing, ' status "Added to cart"']);
    assert.deepEqual(see("s1", tab.id, toasted.tree, toasted.truncated), {
      kind: "unchanged",
      truncated: true,
    });
    // A line near the top pushes the last line past the cut: it is not shown as removed.
    const inserted = cut([listing[0] ?? "", ' status "Added"', ...listing.slice(1)]);
    assert.deepEqual(see("s1", tab.id, inserted.tree, inserted.truncated), {
      kind: "changes",
      lines: '  main\n+  status "Added"',
      truncated: true,
    });
    // A read past the cut compared with a whole one still covers only the start.
    assert.deepEqual(see("s1", tab.id, TREE), {
      kind: "tree",
      tree: TREE,
      omitted: 0,
      truncated: false,
    });
    assert.deepEqual(see("s1", tab.id, inserted.tree, inserted.truncated).kind, "tree");
    assert.deepEqual(see("s1", tab.id, inserted.tree, false), {
      kind: "unchanged",
      truncated: true,
    });
  });

  it("shows removed lines of a whole read, up to its end", async () => {
    const { see, tab } = await setup();
    see("s1", tab.id, `${TREE}\n  text "Added"`);
    assert.deepEqual(see("s1", tab.id, TREE), {
      kind: "changes",
      lines: '  main\n   status\n-   text "Added"',
      truncated: false,
    });
  });
});

describe("changedLines", () => {
  it("shows each change after the lines that contain it, each of them once", () => {
    const before = "main\n list\n  item a\n  item b\n footer";
    const after = 'main\n list\n  item a\n  item c\n footer\n  status "x"';
    assert.equal(
      changedLines(lineDiff(before, after)),
      '  main\n   list\n-   item b\n+   item c\n   footer\n+   status "x"',
    );
  });

  it("takes the lines containing a removed line from the old tree, an added one's from the new", () => {
    const before = 'main\n dialog\n  button "Close"';
    const after = 'main\n form\n  button "Send"';
    assert.equal(
      changedLines(lineDiff(before, after)),
      '  main\n-  dialog\n-   button "Close"\n+  form\n+   button "Send"',
    );
    const moved = changedLines(lineDiff("a\n b\n  c\nd", "a\nd\n e"));
    assert.equal(moved, "  a\n-  b\n-   c\n  d\n+  e");
  });

  it("gives nothing for a diff without changes", () => {
    assert.equal(changedLines(lineDiff(TREE, TREE)), "");
  });
});

describe("cutTree", () => {
  it("keeps the acted element and the lines around it before anything else", () => {
    const items = Array.from({ length: 40 }, (_, index) => ` link "Item ${index}" [l${index}]`);
    const tree = ["main [m1]", ' heading "Shop" [h1]', ...items].join("\n");
    const { tree: shown } = cutTree(tree, ["l20"], 280);
    const kept = shown.split("\n");
    assert.ok(kept.includes(' link "Item 20" [l20]'), shown);
    for (let offset = 1; offset <= FOCUS_CONTEXT_LINES; offset += 1) {
      assert.ok(kept.includes(` link "Item ${20 - offset}" [l${20 - offset}]`), shown);
      assert.ok(kept.includes(` link "Item ${20 + offset}" [l${20 + offset}]`), shown);
    }
    assert.ok(!kept.includes(' link "Item 0" [l0]'), shown);
    assert.ok(shown.length <= 280);
  });

  it("keeps live regions with what they hold, then headings and landmarks, then fields, then links", () => {
    const filler = Array.from({ length: 30 }, (_, index) => ` text "Filler ${index}"`);
    const tree = [
      "banner [b1]",
      ...filler.slice(0, 10),
      ' link "Home" [l1]',
      "main [m1]",
      ' heading "Products" [h1]',
      ...filler.slice(10, 20),
      ' textbox "Search" [t1]',
      ' button "Go" [g1]',
      " status [s1]",
      '  text "Added to cart"',
      ...filler.slice(20),
      ' link "Next" [l2]',
    ].join("\n");
    const lines = (max: number) => cutTree(tree, [], max).tree.split("\n");
    const live = lines(90);
    assert.ok(
      live.includes(" status [s1]") && live.includes('  text "Added to cart"'),
      String(live),
    );
    assert.ok(!live.includes(' heading "Products" [h1]'), String(live));
    const outline = lines(120);
    assert.ok(outline.includes(' heading "Products" [h1]'), String(outline));
    assert.ok(outline.includes("banner [b1]"), String(outline));
    assert.ok(!outline.includes(' button "Go" [g1]'), String(outline));
    const fields = lines(150);
    assert.ok(fields.includes(' button "Go" [g1]'), String(fields));
    assert.ok(!fields.includes(' link "Home" [l1]'), String(fields));
    const links = lines(190);
    assert.ok(links.includes(' textbox "Search" [t1]'), String(links));
    assert.ok(links.includes(' link "Home" [l1]'), String(links));
    assert.ok(!links.some((line) => line.includes("Filler")), String(links));
  });

  it("keeps a live region that starts the tree, and one right after another", () => {
    const tree = [
      "alert [x1]",
      '  text "First"',
      "status [x2]",
      ' text "Second"',
      'button "Go somewhere far" [b1]',
      ...Array.from({ length: 20 }, (_, index) => `heading "Heading ${index}" [h${index}]`),
    ].join("\n");
    // Both regions come before the headings, which would fit in their place.
    assert.equal(
      cutTree(tree, [], 80).tree,
      'alert [x1]\n  text "First"\nstatus [x2]\n text "Second"\n… 21 lines',
    );
  });

  it("shows kept lines in document order, after the lines that contain them", () => {
    const tree = [
      "main [m1]",
      " list [l1]",
      ...Array.from({ length: 20 }, (_, index) => `  listitem "Row ${index}" [r${index}]`),
      " region [g1]",
      '  heading "Deep" [h1]',
    ].join("\n");
    const { tree: shown, omitted } = cutTree(tree, ["r19"], 260);
    assert.equal(
      shown,
      [
        "main [m1]",
        " list [l1]",
        '  listitem "Row 0" [r0]',
        "  … 13 lines",
        ...Array.from(
          { length: 6 },
          (_, index) => `  listitem "Row ${index + 14}" [r${index + 14}]`,
        ),
        " region [g1]",
        '  heading "Deep" [h1]',
      ].join("\n"),
    );
    assert.equal(omitted, 13);
  });

  it("stands one line for each run of lines left out under one line, counting them", () => {
    const tree = [
      "main [m1]",
      " navigation [n1]",
      '  link "A" [a1]',
      '  link "B" [a2]',
      ' text "Body"',
      ' text "More"',
      ' heading "Kept" [h1]',
      ' text "Tail"',
      "contentinfo [c1]",
      ' text "Foot"',
    ].join("\n");
    const { tree: shown, omitted } = cutTree(tree, [], 90);
    assert.equal(
      shown,
      [
        "main [m1]",
        " navigation [n1]",
        "  … 2 lines",
        " … 2 lines",
        ' heading "Kept" [h1]',
        " … 1 line",
        "… 2 lines",
      ].join("\n"),
    );
    assert.equal(omitted, 7);
  });

  it("counts left-out lines in thousands with commas", () => {
    const tree = ["main", ...Array.from({ length: 1500 }, () => ' text "x"')].join("\n");
    assert.equal(cutTree(tree, [], 20).tree, "main\n … 1,500 lines");
  });

  it("finds the ref after a name that holds quotes and brackets", () => {
    const tree = [
      "main",
      ' button "Say \\"[x1]\\" now" [b1]',
      ' button "Unterminated',
      " button [b2] disabled",
      ' text "no ref"',
      " link [b3",
    ].join("\n");
    const kept = 'main\n button "Say \\"[x1]\\" now" [b1]\n … 4 lines';
    assert.equal(cutTree(tree, ["b1"], 50).tree, kept);
    assert.equal(
      cutTree(tree, ["b2"], 50).tree,
      "main\n … 2 lines\n button [b2] disabled\n … 2 lines",
    );
    // A ref inside a name, or one never closed, is no ref: the lines come in document order.
    assert.equal(cutTree(tree, ["x1"], 50).tree, kept);
    assert.equal(cutTree(tree, ["b3"], 50).tree, kept);
  });

  it("never passes its budget, whatever the tree", () => {
    const huge = `text "${"x".repeat(60_000)}"`;
    const trees = [
      huge,
      `main\n ${huge}\n button "Go" [g1]`,
      `${" ".repeat(20_000)}button "Deep" [d1]\nmain`,
      Array.from({ length: 5000 }, (_, index) => `${" ".repeat(index % 50)}item ${index}`).join(
        "\n",
      ),
      Array.from({ length: 5000 }, () => ' button "Same" [s1]').join("\n"),
      Array.from({ length: 3000 }, () => '"\\\\" [ ]]] "').join("\n"),
      "\n".repeat(20_000),
      Array.from({ length: 2000 }, (_, index) => `${" ".repeat(index)}region [r${index}]`).join(
        "\n",
      ),
    ];
    for (const tree of trees) {
      for (const focus of [[], ["s1"], ["d1", "g1", "absent"]]) {
        const { tree: shown, omitted } = cutTree(tree, focus);
        assert.ok(shown.length <= PAGE_VIEW_MAX_CHARS, `${tree.slice(0, 40)} ${shown.length}`);
        const lines = tree.split("\n").length;
        assert.ok(omitted >= 0 && omitted <= lines);
      }
    }
  });

  it("gives a tree of up to the budget whole, which the cut would not", async () => {
    const { see, tab } = await setup();
    // Many short lines: a cut's placeholders cost more than the lines they stand for.
    const short = Array.from({ length: PAGE_VIEW_MAX_CHARS / 2 }, () => "a").join("\n");
    const exact = `${short.slice(0, -1)}ab`;
    for (const tree of [short, exact]) {
      assert.ok(tree.length <= PAGE_VIEW_MAX_CHARS);
      assert.ok(cutTree(tree, []).omitted > 0);
      assert.deepEqual(see("s1", tab.id, tree), {
        kind: "tree",
        tree,
        omitted: 0,
        truncated: false,
      });
      see("s1", tab.id, TREE);
    }
    assert.equal(exact.length, PAGE_VIEW_MAX_CHARS);
  });

  it("is used for a view of a tree past the budget", async () => {
    const { see, tab } = await setup();
    const tree = [
      "main",
      ...Array.from({ length: 2000 }, (_, index) => ` text "Line ${index}"`),
    ].join("\n");
    const view = see("s1", tab.id, tree, false);
    assert.deepEqual(view, { kind: "tree", ...cutTree(tree, []), truncated: false });
    assert.ok(view.kind === "tree" && view.tree.length <= PAGE_VIEW_MAX_CHARS);
    assert.ok(view.kind === "tree" && view.omitted > 0);
    const whole = "x".repeat(PAGE_VIEW_MAX_CHARS);
    assert.deepEqual(see("s1", tab.id, whole, true), {
      kind: "tree",
      tree: whole,
      omitted: 0,
      truncated: true,
    });
  });
});

/** Views with tabs in s1's group on SITE, each with a live document. */
async function setup() {
  const fake = createFakeBrowser();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({
    browser: fake.browser,
    groups,
    sessions,
    timers: createFakeTimers(),
  });
  const views = createPageViews({ browser: fake.browser, groups, access });
  await grantSite(fake.browser, SITE);
  const tab = await liveTab();
  const other = await liveTab();

  async function liveTab(): Promise<FakeTab> {
    const opened = fake.openTab();
    await groups.ensureGroup("s1", opened);
    fake.navigateByUser(opened.id, `${SITE}/`);
    await flush();
    assert.ok(views.document(opened.id) !== undefined);
    return opened;
  }

  /** The view of `tree` read now, with the tab's document unchanged during the read. */
  function see(session: string, tabId: number, tree: string, truncated = false): PageView {
    const before = views.document(tabId);
    return views.view(session, tabId, before, { tree, truncated }, []);
  }

  return { fake, sessions, access, views, tab, other, see };
}
