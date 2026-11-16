import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { TabInfo } from "@foxleash/protocol";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

const STOPPED = "The user stopped this agent session in Firefox.";
const ONCE = 'button[data-answer="once"]';
const TITLE_ON = "Foxleash: an agent session can use this tab";
const TITLE_STOPPED = "Foxleash: the agent session of this tab was stopped";
// The readiness check of each session is its first request, so they are numbered 1 and 2.
const FIRST = "session 1 with 3 tabs";
const SECOND = "session 2 with 1 tab";
// Well below a site prompt's 30 s wait and the wait_for's timeout.
const PROMPT_END_MS = 10_000;

// The sessions section: its rows, the Stop buttons' accessible names, the live region's text, and
// whether the section heading has focus.
const SESSIONS_STATE = `JSON.stringify({
  rows: [...document.querySelectorAll("#answers li span")].map((span) => span.textContent),
  stops: [...document.querySelectorAll("#answers button")]
    .filter((button) => button.textContent === "Stop this session")
    .map((button) => button.getAttribute("aria-label")),
  status: document.getElementById("answers-status").textContent,
  headingFocused: document.activeElement === document.getElementById("answers-heading"),
})`;

// One Firefox for the file: the tests run in order and share the two sessions and their tabs.
describe("stopping an agent session from the settings page, in real Firefox", () => {
  let harness: Harness;
  let always: FixtureServer;
  let once: FixtureServer;
  let pending: FixtureServer;
  let firefox: Firefox;
  let first: Session;
  let second: Session;
  let settings: string;
  let tabA: TabInfo;
  let tabB: TabInfo;
  let tabC: TabInfo;
  let tabD: TabInfo;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      always = await startFixtureServer();
      once = await startFixtureServer();
      pending = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${always.site}`]: { grantedAt: new Date().toISOString() },
      });
      first = await harness.connect();
      await harness.waitUntilReady(first);
      second = await harness.connect();
      await harness.waitUntilReady(second);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await Promise.all([always?.close(), once?.close(), pending?.close()]);
      }
    },
    { timeout: 60_000 },
  );

  test("Stop ends the session's calls under way and its open prompt, and leaves the other session", async () => {
    tabA = tabOf(await harness.ok(first, "tab_open", { url: always.url("/a") }));
    let existing = await promptContexts();
    const opening = settled(harness.ok(first, "tab_open", { url: once.url("/a") }));
    const allowing = await harness.promptContext(existing);
    await harness.waitForArmed(allowing);
    await firefox.click(allowing, ONCE);
    tabB = tabOf(await opening);
    assert.equal(tabB.title, TITLES.a);
    tabC = tabOf(await harness.ok(first, "tab_open"));
    tabD = tabOf(await harness.ok(second, "tab_open", { url: always.url("/a") }));

    const waiting = settled(
      harness.call(first, "wait_for", { tabId: tabB.id, text: "Never on the page", timeout: 30 }),
    );
    existing = await promptContexts();
    const navigating = settled(
      harness.call(first, "navigate", { tabId: tabC.id, url: pending.url("/a") }),
    );
    const prompt = await harness.promptContext(existing);
    await waitFor(
      prompt,
      "document.querySelector('h1').textContent",
      `Allow Foxleash on ${pending.site}?`,
      "the prompt's question",
    );

    settings = await harness.settingsPage();
    await waitForSessions({
      rows: [`Agent ${FIRST}`, `${once.site}: allowed this session (${FIRST})`, `Agent ${SECOND}`],
      stops: [`Stop this session (${FIRST})`, `Stop this session (${SECOND})`],
      status: "",
      headingFocused: false,
    });
    const stop = `button[aria-label="Stop this session (${FIRST})"]`;
    // Focusing the button also scrolls it into view, and checks where focus goes after the click.
    await firefox.evaluate(settings, `document.querySelector(${JSON.stringify(stop)}).focus()`);
    const clicked = Date.now();
    await firefox.click(settings, stop);

    for (const call of [navigating, waiting]) {
      const result = await call;
      assert.ok(result.isError && result.text.includes(STOPPED), result.text);
    }
    assert.ok(
      Date.now() - clicked < PROMPT_END_MS,
      `the calls ended ${Date.now() - clicked} ms after the click`,
    );
    await waitFor(
      prompt,
      "document.getElementById('status').textContent",
      "This request has ended. Ask the agent to try again.",
      "the prompt to end",
    );
    await waitForSessions({
      rows: [`Agent ${FIRST}, stopped`, `Agent ${SECOND}`],
      stops: [`Stop this session (${SECOND})`],
      status: `Stopped the agent ${FIRST}`,
      headingFocused: true,
    });
  });

  test("the stopped session is refused every tool, on sites allowed always and for the session, and asks nothing", async () => {
    for (const tab of [tabA, tabB]) {
      for (const [name, args] of [
        ["read_page", { tabId: tab.id }],
        ["screenshot", { tabId: tab.id }],
        ["click", { tabId: tab.id, x: 10, y: 10 }],
      ] as const) {
        const text = await harness.refused(first, name, args);
        assert.ok(text.includes(STOPPED), `${name} in tab ${tab.id}: ${text}`);
      }
    }
    const tabs = await tabCount();
    const contexts = (await firefox.contexts()).length;
    for (const [name, args] of [
      ["tabs_list", {}],
      ["navigate", { tabId: tabA.id, url: pending.url("/a") }],
      ["request_sites", { sites: [pending.site] }],
      ["tab_open", { url: always.url("/b") }],
    ] as const) {
      const text = await harness.refused(first, name, args);
      assert.ok(text.includes(STOPPED), `${name}: ${text}`);
    }
    assert.equal(await tabCount(), tabs);
    assert.equal((await firefox.contexts()).length, contexts);
    assert.equal(pending.hits("/a"), 0);
  });

  test("the toolbar shows no ON on the stopped session's tabs, and ON on the other session's", async () => {
    for (const tab of [tabA, tabB, tabC]) {
      await waitFor(
        settings,
        badgeOf(tab.id),
        JSON.stringify(["", TITLE_STOPPED]),
        `tab ${tab.id}'s badge`,
      );
    }
    await waitFor(
      settings,
      badgeOf(tabD.id),
      JSON.stringify(["ON", TITLE_ON]),
      "the other session's badge",
    );
  });

  test("the other session still reads and opens pages on the site allowed always", async () => {
    const read = await harness.call(second, "read_page", { tabId: tabD.id });
    assert.equal(read.isError, false, read.text);
    assert.ok(read.text.includes(`heading "${TITLES.a}"`), read.text);
    const opened = tabOf(await harness.ok(second, "tab_open", { url: always.url("/b") }));
    assert.equal(opened.title, TITLES.b);
  });

  test("Stop ends the site-request page a session has open", async (t) => {
    const third = await harness.connect();
    t.after(() => third.close());
    await harness.waitUntilReady(third);
    const existing = await contextsOf("run.html");
    const requesting = settled(harness.call(third, "request_sites", { sites: [pending.site] }));
    const page = await harness.pageContext("run.html", existing);
    await waitFor(
      page,
      "document.getElementById('heading').textContent",
      "Allow Foxleash on these sites for this session?",
      "the site-request page",
    );

    // The settings page reads the sessions again when it gets focus.
    const stop = 'button[aria-label^="Stop this session (session 3 "]';
    await waitFor(
      settings,
      `dispatchEvent(new Event("focus")); String(document.querySelector(${JSON.stringify(stop)}) !== null)`,
      "true",
      "the third session's Stop button",
    );
    const clicked = Date.now();
    await firefox.click(settings, stop);
    const result = await requesting;
    assert.ok(result.isError && result.text.includes(STOPPED), result.text);
    assert.ok(
      Date.now() - clicked < PROMPT_END_MS,
      `request_sites ended ${Date.now() - clicked} ms after the click`,
    );
    await waitFor(
      page,
      "document.getElementById('status').textContent",
      "This request has ended.",
      "the site-request page to end",
    );
    // The page draws every row again at once, so session 2's row is read after the stop too.
    await waitFor(
      settings,
      `String([...document.querySelectorAll("#answers li span")].some(
        ({ textContent }) => textContent.startsWith("Agent session 3 ") && textContent.endsWith(", stopped"),
      ))`,
      "true",
      "the third session's row to read stopped",
    );
    assert.equal(
      await firefox.evaluate(
        settings,
        // Session 2 has opened a second tab since.
        `document.querySelector('button[aria-label^="Stop this session (session 2 "]') !== null`,
      ),
      true,
    );
  });

  async function promptContexts(): Promise<string[]> {
    return contextsOf("approve.html");
  }

  async function contextsOf(page: string): Promise<string[]> {
    const prefix = firefox.extensionUrl(page);
    return (await firefox.contexts())
      .filter((tab) => tab.url.startsWith(prefix))
      .map(({ context }) => context);
  }

  async function tabCount(): Promise<unknown> {
    return firefox.evaluate(settings, "browser.tabs.query({}).then((tabs) => tabs.length)");
  }

  async function waitForSessions(expected: {
    rows: string[];
    stops: string[];
    status: string;
    headingFocused: boolean;
  }): Promise<void> {
    await waitFor(settings, SESSIONS_STATE, JSON.stringify(expected), "the running sessions");
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

/** The tab's toolbar badge text and title, read from an extension page. */
function badgeOf(tabId: number): string {
  return `Promise.all([
    browser.action.getBadgeText({ tabId: ${tabId} }),
    browser.action.getTitle({ tabId: ${tabId} }),
  ]).then((badge) => JSON.stringify(badge))`;
}

/**
 * Handles a tool call's failure now, so a test that fails before it awaits the call leaves no
 * unhandled rejection. Returns the same promise: a later `await` still sees the outcome.
 */
function settled<T>(call: Promise<T>): Promise<T> {
  call.catch(() => undefined);
  return call;
}
