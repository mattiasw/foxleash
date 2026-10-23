import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { ACT_DRAG_DATA, type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([0-9a-f]{8}-[1-9][0-9]*)";

interface Page {
  url: string;
  tabId: number;
  context: string;
  tree: string;
}

// One Firefox for the file: the tests run in order, several on the same page.
describe("click, hover, scroll and drag in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let other = "";
  let act: Page;
  let opened = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      other = `http://localhost:${fixtures.port}`;
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
      act = await open("/act", TITLES.act);
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

  test("click by ref sends the full press sequence a mousedown-then-mouseup button needs", async () => {
    const ref = refOf(act.tree, 'button "Toggle"');
    await clearLog(act);
    const result = await harness.ok(session, "click", { tabId: act.tabId, ref });
    assert.deepEqual(result, { ref, x: 70, y: 25 });
    assert.deepEqual(await evaluate(act, "window.log"), [
      "pointerdown:toggle:0:mouse",
      "mousedown:toggle",
      "pointerup:toggle:0:mouse",
      "mouseup:toggle",
      "click:toggle:1",
    ]);
    assert.equal(
      await evaluate(act, 'document.getElementById("toggle").getAttribute("aria-expanded")'),
      "true",
    );
  });

  test("click by coordinates acts on the element at that point", async () => {
    await clearLog(act);
    const result = await harness.ok(session, "click", { tabId: act.tabId, x: 210, y: 25 });
    assert.deepEqual(result, { ref: refOf(act.tree, 'button "Fixed"'), x: 210, y: 25 });
    assert.deepEqual(await clicksIn(act), ["click:fixed:1"]);
  });

  test("a button below the fold is scrolled into view and clicked", async () => {
    await clearLog(act);
    await harness.ok(session, "click", {
      tabId: act.tabId,
      ref: refOf(act.tree, 'button "Below"'),
    });
    assert.deepEqual(await clicksIn(act), ["click:below:1"]);
    assert.ok(Number(await evaluate(act, "window.scrollY")) > 0);
    await evaluate(act, "window.scrollTo(0, 0)");
  });

  test("a button scrolled out of its scrolling box is scrolled into view and clicked", async () => {
    await clearLog(act);
    await harness.ok(session, "click", {
      tabId: act.tabId,
      ref: refOf(act.tree, 'button "Listed"'),
    });
    assert.deepEqual(await clicksIn(act), ["click:listed:1"]);
    assert.ok(Number(await evaluate(act, 'document.getElementById("list").scrollTop')) > 0);
  });

  test("a covered button is refused, naming the cover, and gets no events", async () => {
    const ref = refOf(act.tree, 'button "Covered"');
    await clearLog(act);
    const events = await evaluate(act, "window.events");
    const text = await harness.refused(session, "click", { tabId: act.tabId, ref });
    assert.match(
      text,
      new RegExp(`Element ${ref} is covered at its visible centre by element ${REF} \\(div\\)`),
    );
    assert.deepEqual(await evaluate(act, "window.log"), []);
    assert.equal(await evaluate(act, "window.events"), events);
    // Scrolled to the centre to look past the cover, then back.
    assert.equal(await evaluate(act, "window.scrollY"), 0);
  });

  test("a button removed after read_page is refused as no longer on the page", async () => {
    const ref = refOf(act.tree, 'button "Removed"');
    await evaluate(act, 'document.getElementById("removed").remove()');
    const text = await harness.refused(session, "click", { tabId: act.tabId, ref });
    assert.ok(text.includes(`Element ${ref} is no longer on the page`), text);
  });

  test("clicking a text field focuses it", async () => {
    await harness.ok(session, "click", {
      tabId: act.tabId,
      ref: refOf(act.tree, 'textbox "Field"'),
    });
    assert.equal(await evaluate(act, "document.activeElement.id"), "field");
  });

  test("a right click sends contextmenu, and a double click two clicks and dblclick", async () => {
    const ref = refOf(act.tree, 'button "Mouse"');
    await clearLog(act);
    await harness.ok(session, "click", { tabId: act.tabId, ref, button: "right" });
    assert.deepEqual(await evaluate(act, "window.log"), [
      "pointerdown:mouse:0:mouse",
      "mousedown:mouse",
      "pointerup:mouse:0:mouse",
      "mouseup:mouse",
      "contextmenu:mouse",
    ]);
    await clearLog(act);
    await harness.ok(session, "click", { tabId: act.tabId, ref, doubleClick: true });
    assert.deepEqual(await clicksIn(act), ["click:mouse:1", "click:mouse:2", "dblclick:mouse:2"]);
  });

  test("a press the page cancels at pointerdown sends no mousedown or mouseup and moves no focus", async () => {
    await evaluate(act, 'document.getElementById("field").focus()');
    await clearLog(act);
    await harness.ok(session, "click", { tabId: act.tabId, ref: refOf(act.tree, 'button "Held"') });
    assert.deepEqual(await evaluate(act, "window.log"), [
      "pointerdown:held:0:mouse",
      "pointerup:held:0:mouse",
      "click:held:1",
    ]);
    assert.equal(await evaluate(act, "document.activeElement.id"), "field");
  });

  test("a button in a closed shadow root is clicked by ref", async () => {
    const ref = refOf(act.tree, 'button "Shadow button"');
    await harness.ok(session, "click", { tabId: act.tabId, ref });
    assert.equal(await evaluate(act, "window.shadowClicks"), 1);
  });

  test("a point on a frame is refused", async () => {
    const text = await harness.refused(session, "click", { tabId: act.tabId, x: 250, y: 150 });
    assert.match(text, new RegExp(`Element ${REF} at that point is a frame \\(iframe\\)`));
  });

  test("hover opens a menu on mouseenter, and hovering elsewhere closes it", async () => {
    const menuHidden = 'document.getElementById("menu").hidden';
    await clearLog(act);
    const ref = refOf(act.tree, 'button "Trigger"');
    assert.deepEqual(await harness.ok(session, "hover", { tabId: act.tabId, ref }), {
      ref,
      x: 70,
      y: 215,
    });
    assert.equal(await evaluate(act, menuHidden), false);
    await harness.ok(session, "hover", {
      tabId: act.tabId,
      ref: refOf(act.tree, 'button "Elsewhere"'),
    });
    assert.equal(await evaluate(act, menuHidden), true);
    assert.deepEqual(await evaluate(act, "window.log"), [
      "mouseenter:trigger",
      "mouseleave:trigger",
    ]);
  });

  test("clicking plain text takes focus away from a text field", async () => {
    await evaluate(act, 'document.getElementById("blurred").focus()');
    await clearLog(act);
    await harness.ok(session, "click", { tabId: act.tabId, x: 210, y: 315 });
    assert.deepEqual(await evaluate(act, "window.log"), ["blur:blurred"]);
    await assertFocusOnBody(act);
  });

  test("clicking plain text in a shadow root takes focus away from a field in it", async () => {
    await evaluate(act, "window.innerField.focus()");
    await clearLog(act);
    await harness.ok(session, "click", { tabId: act.tabId, x: 510, y: 105 });
    assert.deepEqual(await evaluate(act, "window.log"), ["blur:inner"]);
    await assertFocusOnBody(act);
  });

  test("clicking focuses tabindex -1, editable text and a host that delegates focus", async () => {
    await harness.ok(session, "click", { tabId: act.tabId, x: 660, y: 25 });
    assert.equal(await evaluate(act, "document.activeElement.id"), "tabbed");
    await harness.ok(session, "click", { tabId: act.tabId, x: 660, y: 75 });
    assert.equal(await evaluate(act, "document.activeElement.id"), "editable");
    const delegated = 'window.delegatingRoot.activeElement?.getAttribute("aria-label")';
    await harness.ok(session, "click", { tabId: act.tabId, x: 660, y: 125 });
    assert.equal(await evaluate(act, delegated), "Autofocus field");
    // Firefox moves focus to the delegate even from another field in the same host.
    await evaluate(act, 'window.delegatingRoot.querySelector("input").focus()');
    await harness.ok(session, "click", { tabId: act.tabId, x: 660, y: 125 });
    assert.equal(await evaluate(act, delegated), "Autofocus field");
  });

  test("a link and form buttons that lead to another site are refused", async () => {
    const links = await open("/act-links", TITLES.actLinks);
    const ref = refOf(links.tree, 'link "Other site"');
    const byRef = await harness.refused(session, "click", { tabId: links.tabId, ref });
    assert.ok(
      byRef.includes(
        `Element ${ref} leads to a page on ${other}, which Foxhand does not open by clicking; call navigate with that address`,
      ),
      byRef,
    );
    // The submit button of a form whose controls are named action and getAttributeNS, a label
    // for it, an SVG link, an SVG xlink:href link, a same-site form's button with a formaction
    // to the other site, an image input of a form elsewhere on the page, and a link whose
    // same-site href in another namespace comes before its own.
    for (const [x, y] of [
      [70, 75],
      [210, 75],
      [70, 125],
      [350, 25],
      [210, 175],
      [350, 175],
      [490, 25],
    ] as const) {
      const text = await harness.refused(session, "click", { tabId: links.tabId, x, y });
      assert.ok(text.includes(`leads to a page on ${other},`), `${x}, ${y}: ${text}`);
    }
    // Below the fold: scrolled into view, refused, and scrolled back.
    const far = refOf(links.tree, 'link "Far other"');
    const farText = await harness.refused(session, "click", { tabId: links.tabId, ref: far });
    assert.ok(farText.includes(`Element ${far} leads to a page on ${other},`), farText);
    assert.equal(await evaluate(links, "window.scrollY"), 0);
    // Refused before the pointer moved.
    assert.equal(await evaluate(links, "window.events"), 0);
    assert.equal(await evaluate(links, "window.clicks"), 0);
    assert.equal(await evaluate(links, "location.href"), links.url);

    const based = await open("/act-base", TITLES.actBase);
    const relative = refOf(based.tree, 'link "Relative"');
    const text = await harness.refused(session, "click", { tabId: based.tabId, ref: relative });
    assert.ok(text.includes(`Element ${relative} leads to a page on ${other},`), text);
    // An SVG link with an empty href leads to the base URL.
    const empty = await harness.refused(session, "click", { tabId: based.tabId, x: 50, y: 65 });
    assert.ok(empty.includes(`leads to a page on ${other},`), empty);
    assert.equal(await evaluate(based, "location.href"), based.url);
  });

  test("a link and a form button that lead out of the browser are refused, script links are not", async () => {
    const links = await open("/act-links", TITLES.actLinks);
    for (const line of ['link "Mail link"', 'button "Mail send"']) {
      const ref = refOf(links.tree, line);
      const text = await harness.refused(session, "click", { tabId: links.tabId, ref });
      assert.ok(
        text.includes(
          `Element ${ref} leads to an address outside the site (mailto:), which Foxhand does not open by clicking or with navigate.`,
        ),
        `${line}: ${text}`,
      );
    }
    // Refused before the pointer moved.
    assert.equal(await evaluate(links, "window.events"), 0);
    assert.equal(await evaluate(links, "window.clicks"), 0);
    assert.equal(await evaluate(links, "location.href"), links.url);

    await harness.ok(session, "click", {
      tabId: links.tabId,
      ref: refOf(links.tree, 'link "Script link"'),
    });
    // Firefox runs a javascript: URL after the click returns.
    await pollUntil(
      async () => ((await evaluate(links, "window.jsClicks")) === 1 ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the script link to run",
    );
    assert.equal(await evaluate(links, "window.clicks"), 1);
    assert.equal(await evaluate(links, "location.href"), links.url);
    // A blob URL the page made has the page's origin, so it opens.
    await harness.ok(session, "click", {
      tabId: links.tabId,
      ref: refOf(links.tree, 'link "Blob link"'),
    });
  });

  test("the cross-site check sees closed slots, SVG animation and listeners' rewrites", async () => {
    const links = await open("/act-links", TITLES.actLinks);
    // A span slotted into a link in a closed shadow root, an SVG link whose only href is a SMIL
    // <set>, and one whose <set> begins only on the click.
    for (const [x, y] of [
      [350, 125],
      [210, 125],
      [490, 125],
    ] as const) {
      const text = await harness.refused(session, "click", { tabId: links.tabId, x, y });
      assert.ok(text.includes(`leads to a page on ${other},`), `${x}, ${y}: ${text}`);
    }
    const ref = refOf(links.tree, 'link "Rewritten"');
    const text = await harness.refused(session, "click", { tabId: links.tabId, ref });
    assert.ok(text.includes(`Element ${ref} leads to a page on ${other},`), text);
    assert.deepEqual(await evaluate(links, "window.log"), [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
    ]);
    assert.equal(await evaluate(links, "window.clicks"), 0);
    assert.equal(await evaluate(links, "location.href"), links.url);
  });

  test("a same-site link navigates", async () => {
    const links = await open("/act-links", TITLES.actLinks);
    await harness.ok(session, "click", {
      tabId: links.tabId,
      ref: refOf(links.tree, 'link "Same site"'),
    });
    await pollUntil(
      async () => {
        const listed = tabsOf(await harness.ok(session, "tabs_list")).find(
          ({ id }) => id === links.tabId,
        );
        if (listed?.title === TITLES.a) return listed;
        throw new Error(`tab ${links.tabId} is listed as ${JSON.stringify(listed)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${links.tabId} to show ${TITLES.a}`,
    );
  });

  test("scroll moves the page, an inner panel and an element into view", async () => {
    const page = await open("/act-scroll", TITLES.actScroll);
    assert.deepEqual(
      await harness.ok(session, "scroll", { tabId: page.tabId, direction: "down", amount: 300 }),
      { scrollLeft: 0, scrollTop: 300, moved: true },
    );
    assert.equal(await evaluate(page, "window.scrollY"), 300);
    await evaluate(page, "window.scrollTo(0, 0)");

    const panel = refOf(page.tree, 'region "Panel"');
    const scrolled = record(
      await harness.ok(session, "scroll", { tabId: page.tabId, ref: panel, direction: "down" }),
    );
    const panelTop = await evaluate(page, 'document.getElementById("panel").scrollTop');
    assert.deepEqual(scrolled, { ref: panel, scrollLeft: 0, scrollTop: panelTop, moved: true });
    assert.ok(Number(panelTop) > 0);
    assert.equal(await evaluate(page, "window.scrollY"), 0);

    // A panel at its end does not move, so the page scrolls, by most of its own height.
    await evaluate(page, 'document.getElementById("panel").scrollTop = 1000');
    const onward = record(
      await harness.ok(session, "scroll", { tabId: page.tabId, ref: panel, direction: "down" }),
    );
    assert.equal(onward.ref, undefined, JSON.stringify(onward));
    assert.ok(Number(onward.scrollTop) > 200, JSON.stringify(onward));
    await evaluate(page, "window.scrollTo(0, 0)");

    const far = refOf(page.tree, 'button "Far"');
    // A centre target on a half pixel makes Firefox move the page at the next paint unless the
    // tool holds it.
    assert.equal(
      await evaluate(
        page,
        '(() => { const far = document.getElementById("far"); const view = document.documentElement.clientHeight; const height = 23 + (view % 2); far.style.height = height + "px"; far.style.top = 2670.5 + (view - height) / 2 + "px"; const box = far.getBoundingClientRect(); return box.top + box.height / 2 - view / 2; })()',
      ),
      2670.5,
    );
    const inView = record(await harness.ok(session, "scroll", { tabId: page.tabId, ref: far }));
    assert.equal(inView.ref, far);
    assert.equal(inView.moved, true);
    await firefox.evaluate(
      page.context,
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))",
    );
    assert.deepEqual(
      await evaluate(
        page,
        "({ scrollY: window.scrollY, exact: -document.documentElement.getBoundingClientRect().top, visual: window.visualViewport.pageTop })",
      ),
      { scrollY: inView.scrollTop, exact: inView.scrollTop, visual: inView.scrollTop },
    );
    assert.equal(
      await evaluate(
        page,
        '(() => { const box = document.getElementById("far").getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight; })()',
      ),
      true,
    );
    await evaluate(page, "window.scrollTo(0, 0)");

    const stuck = refOf(page.tree, 'region "Stuck"');
    assert.deepEqual(
      await harness.ok(session, "scroll", { tabId: page.tabId, ref: stuck, direction: "down" }),
      { scrollLeft: 0, scrollTop: 0, moved: false },
    );
    assert.equal(await evaluate(page, 'document.getElementById("stuck").scrollTop'), 0);
  });

  test("scroll follows CSS overflow propagation between the root and body", async () => {
    const modal = await open("/act-modal", TITLES.actModal);
    assert.deepEqual(
      await harness.ok(session, "scroll", { tabId: modal.tabId, direction: "down" }),
      { scrollLeft: 0, scrollTop: 0, moved: false },
    );
    assert.equal(await evaluate(modal, "window.scrollY"), 0);

    const body = await open("/act-body-scroll", TITLES.actBodyScroll);
    const scrolled = record(
      await harness.ok(session, "scroll", { tabId: body.tabId, direction: "down" }),
    );
    assert.equal(scrolled.moved, true);
    assert.ok(Number(scrolled.scrollTop) > 0, JSON.stringify(scrolled));
    assert.equal(scrolled.scrollTop, await evaluate(body, "document.body.scrollTop"));
    assert.equal(typeof scrolled.ref, "string");
    // The ref that scrolled holds the whole page: it is body.
    const read = await harness.call(session, "read_page", { tabId: body.tabId, ref: scrolled.ref });
    assert.equal(read.isError, false, read.text);
    assert.ok((untrustedContent(read.text) ?? "").includes('heading "Body scroll"'), read.text);
  });

  test("scroll with no target sends the wheel to a frame at the centre and scrolls the page", async () => {
    const page = await open("/act-embed", TITLES.actEmbed);
    const scrolled = record(
      await harness.ok(session, "scroll", { tabId: page.tabId, direction: "down" }),
    );
    assert.equal(scrolled.moved, true);
    assert.ok(Number(scrolled.scrollTop) > 0, JSON.stringify(scrolled));
    assert.equal(scrolled.scrollTop, await evaluate(page, "window.scrollY"));
  });

  test("drag moves an item that follows the pointer onto a target", async () => {
    const page = await open("/act-drag", TITLES.actDrag);
    const ref = refOf(page.tree, 'button "Item"');
    const targetRef = refOf(page.tree, 'region "Target"');
    assert.deepEqual(await harness.ok(session, "drag", { tabId: page.tabId, ref, targetRef }), {
      ref,
      targetRef,
      mode: "pointer",
      dropped: true,
    });
    assert.equal(await evaluate(page, centreInside("item", "target")), true);
    // The item cancels its pointerdown: no mouse button events while it is held.
    assert.deepEqual(await evaluate(page, "window.pressed"), []);
  });

  test("drag sends HTML drag and drop from a draggable element", async () => {
    const page = await open("/act-drag", TITLES.actDrag);
    const ref = refOf(page.tree, 'button "Source"');
    const accept = refOf(page.tree, 'region "Accept"');
    assert.deepEqual(
      await harness.ok(session, "drag", { tabId: page.tabId, ref, targetRef: accept }),
      { ref, targetRef: accept, mode: "html5", dropped: true },
    );
    assert.equal(await evaluate(page, "window.dropped"), ACT_DRAG_DATA);
    assert.deepEqual(await evaluate(page, "window.log"), [
      "pointercancel:source",
      "dragenter:accept",
      "dragover:accept",
      "drop:accept",
    ]);
    await evaluate(page, "window.log.length = 0");
    const refuse = refOf(page.tree, 'region "Refuse"');
    assert.deepEqual(
      await harness.ok(session, "drag", { tabId: page.tabId, ref, targetRef: refuse }),
      { ref, targetRef: refuse, mode: "html5", dropped: false },
    );
    assert.deepEqual(await evaluate(page, "window.log"), [
      "pointercancel:source",
      "dragenter:refuse",
      "dragover:refuse",
      "dragleave:refuse",
    ]);
  });

  test("drag to a point does not scroll to its start, which must be in view", async () => {
    const page = await open("/act-drag", TITLES.actDrag);
    const ref = refOf(page.tree, 'button "Far item"');
    const text = await harness.refused(session, "drag", {
      tabId: page.tabId,
      ref,
      targetX: 350,
      targetY: 40,
    });
    assert.ok(text.includes(`Element ${ref} has no visible part in the tab's viewport`), text);
    assert.equal(await evaluate(page, "window.scrollY"), 0);
    // With a targetRef the start is scrolled into view; the end then out of view refuses, and
    // the start is scrolled back.
    const targetRef = refOf(page.tree, 'region "Target"');
    const endText = await harness.refused(session, "drag", { tabId: page.tabId, ref, targetRef });
    assert.ok(
      endText.includes(`Element ${targetRef} has no visible part in the tab's viewport`),
      endText,
    );
    assert.equal(await evaluate(page, "window.scrollY"), 0);
  });

  test("drag falls back to the pointer when the page cancels dragstart", async () => {
    const page = await open("/act-drag", TITLES.actDrag);
    const ref = refOf(page.tree, 'button "Sortable"');
    const targetRef = refOf(page.tree, 'region "Slot"');
    assert.deepEqual(await harness.ok(session, "drag", { tabId: page.tabId, ref, targetRef }), {
      ref,
      targetRef,
      mode: "pointer",
      dropped: true,
    });
    assert.equal(await evaluate(page, centreInside("sortable", "slot")), true);
  });

  test("a tab on a site the user has not approved is refused before anything is sent", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/act-redirect") }),
    );
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
    const text = await harness.refused(session, "click", { tabId: tab.id, x: 70, y: 25 });
    assert.ok(text.includes(`Foxhand is not allowed on ${other} in this session`), text);
    const found = (await firefox.contexts()).find(({ url }) => url === `${other}/act`);
    assert.ok(found !== undefined, "no tab shows the act page on the other site");
    assert.deepEqual(
      JSON.parse(String(await firefox.evaluate(found.context, "JSON.stringify(window.log)"))),
      [],
    );
  });

  /** Opens a fixture page in a new tab, under a query of its own, and reads it. */
  async function open(path: string, title: string): Promise<Page> {
    opened += 1;
    const url = fixtures.url(`${path}?tab=${opened}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    const read = await harness.call(session, "read_page", { tabId: tab.id });
    assert.equal(read.isError, false, read.text);
    return { url, tabId: tab.id, context: found.context, tree: untrustedContent(read.text) ?? "" };
  }

  /** The page's value of a JavaScript expression, through JSON. */
  async function evaluate(page: Page, expression: string): Promise<unknown> {
    const json = await firefox.evaluate(page.context, `JSON.stringify(${expression}) ?? "null"`);
    return JSON.parse(String(json));
  }

  async function clearLog(page: Page): Promise<void> {
    await evaluate(page, "window.log.length = 0");
  }

  async function clicksIn(page: Page): Promise<unknown> {
    const log = await evaluate(page, "window.log");
    assert.ok(Array.isArray(log));
    return log.filter((entry) => typeof entry === "string" && /^(click|dblclick):/.test(entry));
  }

  async function assertFocusOnBody(page: Page): Promise<void> {
    const onBody = await evaluate(page, "document.activeElement === document.body");
    const active = await evaluate(
      page,
      'document.activeElement.localName + "#" + document.activeElement.id',
    );
    assert.equal(onBody, true, `document.activeElement is ${String(active)}`);
  }
});

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

/** Whether the centre of element `inner` lies inside element `outer`'s box. */
function centreInside(inner: string, outer: string): string {
  return `(() => {
    const a = document.getElementById(${JSON.stringify(inner)}).getBoundingClientRect();
    const b = document.getElementById(${JSON.stringify(outer)}).getBoundingClientRect();
    const x = a.left + a.width / 2;
    const y = a.top + a.height / 2;
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  })()`;
}
