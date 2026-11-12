import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { DEFAULT_BLOCKLIST } from "../apps/extension/src/default-blocklist.ts";
import { parseBlocklist } from "../apps/extension/src/site.ts";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

const ANSWER = {
  no: 'button[data-answer="no"]',
  once: 'button[data-answer="once"]',
} as const;
// Seeded as allowed always besides the first fixture server's site.
const SITE_A = "https://a.example";
// Sorts between the seeded fixture site and SITE_A (":" before "s").
const SITE_B = "http://b.example";
const BLOCKLIST_TEXT = "Foxleash's blocklist";

// The answers section: its rows, whether the list and the empty state are visible, the live
// region's text, and the accessible name of the focused element, or "heading".
const ANSWERS_STATE = `JSON.stringify({
  rows: [...document.querySelectorAll("#answers li span")].map((span) => span.textContent),
  list: !document.getElementById("answers").hidden,
  empty: !document.getElementById("answers-empty").hidden,
  status: document.getElementById("answers-status").textContent,
  focus:
    document.activeElement === document.getElementById("answers-heading")
      ? "heading"
      : (document.activeElement?.getAttribute("aria-label") ?? null),
})`;

interface AnswersState {
  rows: string[];
  list: boolean;
  empty: boolean;
  status: string;
  focus: string | null;
}

// The blocklist section: the textarea's value, validity and whether it is read-only, the error
// list and the live region's text.
const BLOCKLIST_STATE = `(() => {
  const errors = document.getElementById("blocklist-errors");
  return JSON.stringify({
    value: document.getElementById("blocklist").value,
    status: document.getElementById("blocklist-status").textContent,
    errors: [...errors.children].map((item) => item.textContent),
    errorsShown: !errors.hidden,
    invalid: document.getElementById("blocklist").getAttribute("aria-invalid"),
    readOnly: document.getElementById("blocklist").readOnly,
  });
})()`;

interface BlocklistState {
  value: string;
  status: string;
  errors: string[];
  errorsShown: boolean;
  invalid: string | null;
  readOnly: boolean;
}

// Whether the textarea has focus, and its selection.
const SELECTION = `(() => {
  const area = document.getElementById("blocklist");
  return JSON.stringify([document.activeElement === area, area.selectionStart, area.selectionEnd]);
})()`;

const STORED_BLOCKLIST =
  'browser.storage.local.get("blocklist").then((items) => JSON.stringify(items))';

// One Firefox for the file: the tests run in order, and the blocklist test runs last so that a
// list it leaves behind cannot affect the others.
describe("editing the settings, in real Firefox", () => {
  let harness: Harness;
  let seeded: FixtureServer;
  let unseeded: FixtureServer;
  let third: FixtureServer;
  let firefox: Firefox;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      seeded = await startFixtureServer();
      unseeded = await startFixtureServer();
      third = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      const grant = { grantedAt: new Date().toISOString() };
      await harness.seedSettings({ [`site:${seeded.site}`]: grant, [`site:${SITE_A}`]: grant });
      const live = await harness.connect();
      await harness.waitUntilReady(live);
      await live.close();
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await Promise.all([seeded?.close(), unseeded?.close(), third?.close()]);
      }
    },
    { timeout: 60_000 },
  );

  // A failed test can leave its prompt open, and the next test must not take it for its own.
  afterEach(async () => {
    for (const context of await promptContexts()) await firefox.closeContext(context);
  });

  test("the settings page lists a session's answers, and Forget clears each one", async (t) => {
    const session = await connected();
    t.after(() => session.close());

    let existing = await promptContexts();
    const opening = pending(harness.ok(session, "tab_open", { url: third.url("/a") }));
    const allowing = await harness.promptContext(existing);
    await harness.waitForArmed(allowing);
    await firefox.click(allowing, ANSWER.once);
    const thirdTab = tabOf(await opening);
    assert.equal(thirdTab.title, TITLES.a);

    existing = await promptContexts();
    const refusing = pending(harness.refused(session, "tab_open", { url: unseeded.url("/a") }));
    const refusal = await harness.promptContext(existing);
    await harness.waitForArmed(refusal);
    await firefox.click(refusal, ANSWER.no);
    const refused = await refusing;
    assert.ok(refused.includes(`did not allow Foxleash on ${unseeded.site}`), refused);

    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    const allowedRow = `${third.site}: allowed this session (session with 2 tabs)`;
    const refusedRow = `${unseeded.site}: refused this session (session with 2 tabs)`;
    await waitForAnswers(page, {
      rows: [allowedRow, refusedRow],
      list: true,
      empty: false,
      status: "",
      focus: null,
    });

    await forgetRow(page, refusedRow);
    await waitForAnswers(page, {
      rows: [allowedRow],
      list: true,
      empty: false,
      status: `Forgot ${unseeded.site} for this session`,
      focus: `Forget ${allowedRow}`,
    });
    await forgetRow(page, allowedRow);
    await waitForAnswers(page, {
      rows: [],
      list: false,
      empty: true,
      status: `Forgot ${third.site} for this session`,
      focus: "heading",
    });

    const listed = tabsOf(await harness.ok(session, "tabs_list")).find(
      ({ id }) => id === thirdTab.id,
    );
    assert.deepEqual({ url: listed?.url, title: listed?.title }, { url: third.site, title: "" });

    existing = await promptContexts();
    const asked = pending(harness.refused(session, "tab_open", { url: unseeded.url("/a") }));
    const again = await harness.promptContext(existing);
    await waitForQuestion(again, unseeded.site);
    await firefox.closeContext(again);
    const closed = await asked;
    assert.ok(closed.includes("was closed without an answer"), closed);
  });

  test("a Forget click keeps its row when the answers refresh between press and release", async (t) => {
    const session = await connected();
    t.after(() => session.close());
    const existing = await promptContexts();
    const opening = pending(harness.ok(session, "tab_open", { url: third.url("/a") }));
    const allowing = await harness.promptContext(existing);
    await harness.waitForArmed(allowing);
    await firefox.click(allowing, ANSWER.once);
    await opening;
    const second = tabOf(await harness.ok(session, "tab_open", { url: third.url("/a") }));

    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    const two = `${third.site}: allowed this session (session with 2 tabs)`;
    await waitForAnswers(page, {
      rows: [two],
      list: true,
      empty: false,
      status: "",
      focus: null,
    });

    // Focusing the button also scrolls it into view, which the press needs.
    const button = `button[aria-label="Forget ${two}"]`;
    await firefox.evaluate(page, `document.querySelector(${JSON.stringify(button)}).focus()`);
    await firefox.press(page, button);
    try {
      // Closing a background tab changes the label and leaves the settings page selected.
      await harness.ok(session, "tab_close", { tabId: second.id });
      await firefox.evaluate(page, 'dispatchEvent(new Event("focus"))');
      const one = `${third.site}: allowed this session (session with 1 tab)`;
      await waitForAnswers(page, {
        rows: [one],
        list: true,
        empty: false,
        status: "",
        focus: `Forget ${one}`,
      });
    } finally {
      await firefox.release(page);
    }
    await waitForAnswers(page, {
      rows: [],
      list: false,
      empty: true,
      status: `Forgot ${third.site} for this session`,
      focus: "heading",
    });
  });

  test("coming back to the settings page reads the session answers again", async (t) => {
    const session = await connected();
    t.after(() => session.close());
    const existing = await promptContexts();
    const opening = pending(harness.ok(session, "tab_open", { url: third.url("/a") }));
    const allowing = await harness.promptContext(existing);
    await harness.waitForArmed(allowing);
    await firefox.click(allowing, ANSWER.once);
    await opening;

    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    const one = `${third.site}: allowed this session (session with 1 tab)`;
    await waitForAnswers(page, { rows: [one], list: true, empty: false, status: "", focus: null });

    // The agent's new tab is selected, which hides the settings page.
    const second = tabOf(await harness.ok(session, "tab_open", { url: third.url("/a") }));
    await firefox.activate(page);
    const two = `${third.site}: allowed this session (session with 2 tabs)`;
    await waitForAnswers(page, { rows: [two], list: true, empty: false, status: "", focus: null });

    // Closing a background tab leaves the settings page selected, so only the event refreshes it.
    await harness.ok(session, "tab_close", { tabId: second.id });
    await firefox.evaluate(page, 'document.dispatchEvent(new Event("visibilitychange"))');
    await waitForAnswers(page, { rows: [one], list: true, empty: false, status: "", focus: null });
  });

  test("Forget on closed prompts lets a session that stopped asking ask again", async (t) => {
    const session = await connected();
    t.after(() => session.close());
    const hits = unseeded.hits("/a");
    for (let closed = 0; closed < 3; closed += 1) {
      const existing = await promptContexts();
      const opening = pending(harness.refused(session, "tab_open", { url: unseeded.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, unseeded.site);
      await firefox.closeContext(prompt);
      const text = await opening;
      assert.ok(text.includes("was closed without an answer"), text);
    }
    const text = await harness.refused(session, "tab_open", { url: unseeded.url("/a") });
    assert.ok(text.includes("Foxleash asks no more in this session"), text);
    assert.ok(text.includes("Foxleash's settings"), text);
    assert.deepEqual(await promptContexts(), []);

    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    const row = "3 prompts closed without an answer (session with no tabs)";
    await waitForAnswers(page, { rows: [row], list: true, empty: false, status: "", focus: null });
    await forgetRow(page, row);
    await waitForAnswers(page, {
      rows: [],
      list: false,
      empty: true,
      status: "Forgot the closed prompts",
      focus: "heading",
    });

    const existing = await promptContexts();
    const asked = pending(harness.refused(session, "tab_open", { url: unseeded.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, unseeded.site);
    await firefox.closeContext(prompt);
    const closed = await asked;
    assert.ok(closed.includes("was closed without an answer"), closed);
    assert.equal(unseeded.hits("/a"), hits);
  });

  test("a site added elsewhere keeps focus on the same Revoke button", async (t) => {
    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    const sites = `[...document.querySelectorAll("#sites button")].map((button) => button.dataset.site)`;
    await waitFor(
      page,
      `JSON.stringify(${sites})`,
      JSON.stringify([seeded.site, SITE_A]),
      "the allowed sites",
    );
    await firefox.evaluate(
      page,
      `document.querySelector(${JSON.stringify(`button[aria-label="Revoke ${SITE_A}"]`)}).focus()`,
    );
    const stored = await firefox.evaluate(
      page,
      `browser.storage.local.set(${JSON.stringify({
        [`site:${SITE_B}`]: { grantedAt: new Date().toISOString() },
      })}).then(() => true)`,
    );
    assert.equal(stored, true);
    await waitFor(
      page,
      `JSON.stringify({ sites: ${sites}, focus: document.activeElement?.dataset?.site ?? null })`,
      JSON.stringify({ sites: [seeded.site, SITE_B, SITE_A], focus: SITE_A }),
      "the new site with focus kept",
    );
  });

  test("the blocklist is saved only when valid, and the built-in list is filled in on request", async (t) => {
    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    const session = await connected();
    t.after(() => session.close());
    const builtIn = DEFAULT_BLOCKLIST.join("\n");
    const clean = { errors: [], errorsShown: false, invalid: null, readOnly: false };
    await waitFor(page, `document.getElementById("blocklist").value`, builtIn, "the built-in list");

    await setBlocklist(page, "127.0.0.1\n\npaypal.com/");
    await firefox.click(page, "#blocklist-save");
    await waitForBlocklist(page, { value: "127.0.0.1\npaypal.com", status: "Saved", ...clean });
    const stored = JSON.stringify({ blocklist: ["127.0.0.1", "paypal.com"] });
    assert.equal(await firefox.evaluate(page, STORED_BLOCKLIST), stored);
    await assertBlocked(session);

    const invalid = "example.org\n\n*.example.com";
    await setBlocklist(page, invalid);
    await firefox.click(page, "#blocklist-save");
    const parsed = parseBlocklist("*.example.com");
    assert.ok("errors" in parsed);
    await waitForBlocklist(page, {
      value: invalid,
      status: "Not saved: 1 line needs fixing",
      errors: [`Line 3: ${parsed.errors[0]?.text}`],
      errorsShown: true,
      invalid: "true",
      readOnly: false,
    });
    assert.equal(await firefox.evaluate(page, SELECTION), JSON.stringify([true, 13, 26]));
    assert.equal(await firefox.evaluate(page, STORED_BLOCKLIST), stored);
    await assertBlocked(session);

    await firefox.click(page, "#blocklist-default");
    await waitForBlocklist(page, {
      value: builtIn,
      status: "Filled in the built-in list. Save to use it.",
      ...clean,
    });
    assert.equal(await firefox.evaluate(page, STORED_BLOCKLIST), stored);
    await assertBlocked(session);

    await firefox.click(page, "#blocklist-save");
    await waitForBlocklist(page, { value: builtIn, status: "Saved", ...clean });
    assert.equal(await firefox.evaluate(page, STORED_BLOCKLIST), "{}");
    const opened = tabOf(await harness.ok(session, "tab_open", { url: seeded.url("/a") }));
    assert.equal(opened.title, TITLES.a);
    assert.equal(seeded.hits("/a"), 1);
  });

  async function connected(): Promise<Session> {
    const session = await harness.connect();
    await harness.waitUntilReady(session);
    return session;
  }

  async function promptContexts(): Promise<string[]> {
    const prefix = firefox.extensionUrl("approve.html");
    return (await firefox.contexts())
      .filter((tab) => tab.url.startsWith(prefix))
      .map(({ context }) => context);
  }

  /** Waits until the prompt page names the site, which it does once it has connected. */
  async function waitForQuestion(context: string, name: string): Promise<void> {
    await waitFor(
      context,
      "document.querySelector('h1').textContent",
      `Allow Foxleash on ${name}?`,
      "the prompt's question",
    );
  }

  /** Focuses a row's Forget button, so the focus move is checked, then clicks it for real. */
  async function forgetRow(page: string, row: string): Promise<void> {
    const button = JSON.stringify(`button[aria-label="Forget ${row}"]`);
    await firefox.evaluate(page, `document.querySelector(${button}).focus()`);
    await firefox.click(page, `button[aria-label="Forget ${row}"]`);
  }

  async function waitForAnswers(page: string, expected: AnswersState): Promise<void> {
    await waitFor(page, ANSWERS_STATE, JSON.stringify(expected), "the session answers");
  }

  async function setBlocklist(page: string, text: string): Promise<void> {
    await firefox.evaluate(
      page,
      `document.getElementById("blocklist").value = ${JSON.stringify(text)}`,
    );
  }

  async function waitForBlocklist(page: string, expected: BlocklistState): Promise<void> {
    await waitFor(page, BLOCKLIST_STATE, JSON.stringify(expected), "the blocklist section");
  }

  async function assertBlocked(session: Session): Promise<void> {
    const text = await harness.refused(session, "tab_open", { url: seeded.url("/a") });
    assert.ok(text.includes(BLOCKLIST_TEXT), text);
    assert.equal(seeded.hits("/a"), 0);
  }

  async function waitFor(
    context: string,
    expression: string,
    expected: string,
    what: string,
  ): Promise<void> {
    await pollUntil(
      async () => {
        const value = await firefox.evaluate(context, expression);
        if (value === expected) return true;
        throw new Error(`the page shows ${String(value)}`);
      },
      PAGE_TIMEOUT_MS,
      `${what}: ${expected}`,
    );
  }
});

/**
 * Handles a tool call's failure now, so a test that fails before it awaits the call leaves no
 * unhandled rejection. Returns the same promise: a later `await` still sees the outcome.
 */
function pending<T>(call: Promise<T>): Promise<T> {
  call.catch(() => undefined);
  return call;
}
