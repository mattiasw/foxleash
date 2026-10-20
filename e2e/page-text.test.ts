import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { PageText } from "@foxhand/protocol";
import {
  type FixtureServer,
  READ_HIDDEN,
  READ_SECRETS,
  READ_VISIBLE_MARKER,
  startFixtureServer,
  TEXT_TOKENS,
  TITLES,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

const SOURCES: readonly unknown[] = ["main", "role_main", "article", "largest_block", "body"];

// One Firefox for the file, as in read-page.test.ts.
describe("get_page_text in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      await harness.startFirefox(EXTENSION_DIST);
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

  test("a main element is the main content and the rest follows in order", async () => {
    const text = await pageText(await open("/text-main", TITLES.textMain));
    assert.equal(text.source, "main");
    assertIn(text.main, [TEXT_TOKENS.mainHeading, TEXT_TOKENS.mainFirst, TEXT_TOKENS.mainSecond]);
    assertNotIn(text.main, [TEXT_TOKENS.nav, TEXT_TOKENS.aside, TEXT_TOKENS.footer]);
    assertIn(text.rest, [
      TEXT_TOKENS.nav,
      TEXT_TOKENS.aside,
      TEXT_TOKENS.footer,
      TEXT_TOKENS.bodyText,
      TEXT_TOKENS.contents,
    ]);
    assert.ok(text.rest.indexOf(TEXT_TOKENS.nav) < text.rest.indexOf(TEXT_TOKENS.footer));
    for (const part of [text.main, text.rest]) {
      assertNotIn(part, [
        TEXT_TOKENS.mainHidden,
        TEXT_TOKENS.bodyHidden,
        TEXT_TOKENS.bodyInvisible,
        TEXT_TOKENS.contentsArea,
        TEXT_TOKENS.contentsAnswer,
        TEXT_TOKENS.contentsParagraph,
        TEXT_TOKENS.contentsNested,
        TEXT_TOKENS.unslotted,
        TEXT_TOKENS.script,
        TEXT_TOKENS.style,
        TEXT_TOKENS.noscript,
        TEXT_TOKENS.mainValue,
        TEXT_TOKENS.asideValue,
        TEXT_TOKENS.password,
        TEXT_TOKENS.asideArea,
        TEXT_TOKENS.bodyArea,
        READ_HIDDEN.frame,
      ]);
    }
    assert.equal(text.truncated, false);
    assert.equal(text.totalChars, text.main.length + text.rest.length);
  });

  test("a hidden main element gives way to the main role", async () => {
    const text = await pageText(await open("/text-role-main", TITLES.textRoleMain));
    assert.equal(text.source, "role_main");
    assertIn(text.main, [TEXT_TOKENS.roleMain]);
    assertIn(text.rest, [TEXT_TOKENS.roleHeader]);
    for (const part of [text.main, text.rest]) assertNotIn(part, [TEXT_TOKENS.hiddenMain]);
  });

  test("without a main element the longest article is the main content", async () => {
    const text = await pageText(await open("/text-article", TITLES.textArticle));
    assert.equal(text.source, "article");
    assertIn(text.main, [TEXT_TOKENS.longArticle]);
    assertNotIn(text.main, [TEXT_TOKENS.shortArticle]);
    assertIn(text.rest, [TEXT_TOKENS.shortArticle]);
  });

  test("without landmarks the largest block of text is the main content", async () => {
    const text = await pageText(await open("/text-block", TITLES.textBlock));
    assert.equal(text.source, "largest_block");
    assertIn(text.main, [TEXT_TOKENS.block]);
    assertNotIn(text.main, [TEXT_TOKENS.sidebar]);
    assertIn(text.rest, [TEXT_TOKENS.sidebar]);
    for (const part of [text.main, text.rest]) {
      assertNotIn(part, [TEXT_TOKENS.blockArea, TEXT_TOKENS.canvas]);
    }
  });

  test("a page with little text is all main content", async () => {
    const text = await pageText(await open("/a", TITLES.a));
    assert.deepEqual(text, {
      source: "body",
      main: TITLES.a,
      rest: "",
      truncated: false,
      totalChars: TITLES.a.length,
    });
  });

  test("a body whose content is hidden gives no text", async () => {
    const text = await pageText(await open("/text-hidden-body", TITLES.textHiddenBody));
    assert.deepEqual(text, { source: "body", main: "", rest: "", truncated: false, totalChars: 0 });
  });

  test("text a shadow root hides through its slot is left out", async () => {
    const text = await pageText(await open("/text-slotted", TITLES.textSlotted));
    assert.equal(text.source, "main");
    assertIn(text.main, [TEXT_TOKENS.slottedMain]);
    for (const part of [text.main, text.rest]) {
      assertNotIn(part, [TEXT_TOKENS.slottedHidden, TEXT_TOKENS.slottedSkipped]);
    }
  });

  test("a disclosure is read as far as the user sees it", async () => {
    const text = await pageText(await open("/text-details", TITLES.textDetails));
    assert.equal(text.source, "main");
    assertIn(text.main, [TEXT_TOKENS.summaryMain]);
    assertIn(text.rest, [
      TEXT_TOKENS.detailsSummary,
      "Namespaced",
      "Foreign",
      "Styled",
      TEXT_TOKENS.openParagraph,
    ]);
    for (const part of [text.main, text.rest]) {
      assertNotIn(part, [
        TEXT_TOKENS.detailsMain,
        TEXT_TOKENS.summaryAnswer,
        TEXT_TOKENS.summaryParagraph,
        TEXT_TOKENS.namespacedAnswer,
        TEXT_TOKENS.foreignSummary,
        TEXT_TOKENS.styledAnswer,
      ]);
    }
  });

  test("hidden text is left out and text the user sees is kept", async () => {
    const text = await pageText(await open("/read-hidden", TITLES.readHidden));
    assert.equal(text.source, "body");
    for (const part of [text.main, text.rest]) {
      assertNotIn(part, [
        READ_HIDDEN.display,
        READ_HIDDEN.attribute,
        READ_HIDDEN.visibility,
        READ_HIDDEN.answer,
        READ_HIDDEN.contentVisibility,
        READ_HIDDEN.fallback,
      ]);
    }
    assertIn(text.main, [
      READ_HIDDEN.aria,
      READ_HIDDEN.inert,
      READ_VISIBLE_MARKER,
      "Visible child",
    ]);
  });

  test("slotted text is read and a shadow root's password value is not", async () => {
    const text = await pageText(await open("/read-shadow", TITLES.readShadow));
    assertIn(text.main + text.rest, ["Slotted open text", "Slotted closed text"]);
    assertNotIn(text.main + text.rest, [READ_SECRETS.shadow]);
  });

  test("main and rest together are cut to maxChars", async () => {
    const text = await pageText(await open("/text-main", TITLES.textMain), { maxChars: 40 });
    assert.ok(text.main.length + text.rest.length <= 40, JSON.stringify(text));
    assert.equal(text.truncated, true);
    assert.ok(text.totalChars > 40, JSON.stringify(text));
  });

  test("a blank tab is refused as not a web page", async () => {
    const blank = tabOf(await harness.ok(session, "tab_open")).id;
    const text = await harness.refused(session, "get_page_text", { tabId: blank });
    assert.ok(text.includes("Foxhand acts only on http and https pages"), text);
  });

  async function open(path: string, title: string): Promise<number> {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url(path) }));
    assert.equal(tab.title, title);
    return tab.id;
  }

  async function pageText(tabId: number, args: Record<string, unknown> = {}): Promise<PageText> {
    return pageTextOf(await harness.ok(session, "get_page_text", { tabId, ...args }));
  }
});

function pageTextOf(value: unknown): PageText {
  assert.ok(typeof value === "object" && value !== null, JSON.stringify(value));
  const { source, main, rest, truncated, totalChars } = Object.fromEntries(Object.entries(value));
  assert.ok(isSource(source), JSON.stringify(value));
  assert.ok(
    typeof main === "string" &&
      typeof rest === "string" &&
      typeof truncated === "boolean" &&
      typeof totalChars === "number",
    JSON.stringify(value),
  );
  return { source, main, rest, truncated, totalChars };
}

function isSource(value: unknown): value is PageText["source"] {
  return SOURCES.includes(value);
}

function assertIn(text: string, tokens: string[]): void {
  for (const token of tokens) assert.ok(text.includes(token), `no ${token} in:\n${text}`);
}

function assertNotIn(text: string, tokens: string[]): void {
  for (const token of tokens) assert.equal(text.includes(token), false, `${token} in:\n${text}`);
}
