import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  stillPending,
  tabOf,
  tabsOf,
} from "./harness.ts";

const ANSWER = {
  no: 'button[data-answer="no"]',
  once: 'button[data-answer="once"]',
  always: 'button[data-answer="always"]',
} as const;
const UNARMED = "The buttons respond a moment after this window is focused.";
const UNARMED_COUNT =
  "document.querySelectorAll('button[data-answer][aria-disabled=\"true\"]').length";
const PENDING_MS = 1500;

// One Firefox for the file. Neither fixture site is seeded, so every session is asked for both.
// The second site is the only one allowed always, and that test revokes it again.
describe("the approval prompt, in real Firefox", () => {
  let harness: Harness;
  let site: FixtureServer;
  let other: FixtureServer;
  let firefox: Firefox;
  // Shared by the first two tests: the session that allowed the site, and its tab.
  let allowing: Session;
  let allowedTab = -1;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      site = await startFixtureServer();
      other = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
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
        await Promise.all([site?.close(), other?.close()]);
      }
    },
    { timeout: 60_000 },
  );

  // A failed test can leave its prompt open, and the next test must not take it for its own.
  afterEach(async () => {
    for (const context of await promptContexts()) await firefox.closeContext(context);
  });

  test("asks before the first page of a site, and only a trusted click on armed buttons answers", async () => {
    allowing = await connected();
    const existing = await promptContexts();
    const opening = pending(harness.ok(allowing, "tab_open", { url: site.url("/a") }));
    await stillPending(opening, PENDING_MS);
    assert.equal(site.hits("/a"), 0);
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);

    // Hidden, then shown: still unarmed, as arming takes a full second of focus.
    const elsewhere = await firefox.openContext("about:blank");
    await firefox.activate(elsewhere);
    assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
    await firefox.activate(prompt);
    assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);

    // A real click that arrives with the window it focuses does not answer.
    await firefox.activate(elsewhere);
    await firefox.click(prompt, ANSWER.always);
    await waitForStatus(prompt, UNARMED);
    await stillPending(opening, PENDING_MS);
    assert.equal(site.hits("/a"), 0);

    // A scripted click on an armed button does not answer either.
    await harness.waitForArmed(prompt);
    await firefox.evaluate(
      prompt,
      `document.querySelector(${JSON.stringify(ANSWER.once)}).click()`,
    );
    await stillPending(opening, PENDING_MS);
    assert.equal(site.hits("/a"), 0);

    await firefox.click(prompt, ANSWER.once);
    const tab = tabOf(await opening);
    assert.equal(tab.url, site.url("/a"));
    assert.equal(tab.title, TITLES.a);
    assert.equal(site.hits("/a"), 1);
    allowedTab = tab.id;
    await firefox.closeContext(elsewhere);
  });

  test("the session that allowed a site opens its other pages without asking", async () => {
    const tab = tabOf(
      await harness.ok(allowing, "navigate", { tabId: allowedTab, url: site.url("/b") }),
    );
    assert.equal(tab.title, TITLES.b);
    assert.deepEqual(await promptContexts(), []);
  });

  test("the end of a session ends its open prompt", async () => {
    const hits = other.hits("/a");
    const existing = await promptContexts();
    // Closing its session fails the call before Foxleash answers it.
    const asked = harness.refused(allowing, "tab_open", { url: other.url("/a") }).catch(() => "");
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, other.site);
    await allowing.close();
    // The group holds a page, so it stays open with the prompt in it.
    await waitForStatus(prompt, "This request has ended. Ask the agent to try again.");
    assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 0);
    assert.equal(other.hits("/a"), hits);
    await firefox.closeContext(prompt);
    await asked;
  });

  test("Don't allow refuses the site for the rest of the session and keeps the prompt", async () => {
    const session = await connected();
    const hits = site.hits("/a");
    const hitsB = site.hits("/b");
    const existing = await promptContexts();
    const opening = pending(harness.refused(session, "tab_open", { url: site.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.no);
    const text = await opening;
    assert.ok(text.includes(`The user did not allow Foxleash on ${site.site}`), text);
    assert.equal(site.hits("/a"), hits);
    await waitForStatus(prompt, "Not allowed. The agent was told.");
    assert.deepEqual(await promptContexts(), [prompt]);

    const again = await harness.refused(session, "tab_open", { url: site.url("/b") });
    assert.ok(again.includes("did not allow"), again);
    assert.deepEqual(await promptContexts(), [prompt]);
    assert.equal(site.hits("/b"), hitsB);
    await firefox.closeContext(prompt);
    await session.close();
  });

  test("Always allow stores the site for later sessions until it is revoked", async () => {
    const asking = await connected();
    const existing = await promptContexts();
    const opening = pending(harness.ok(asking, "tab_open", { url: other.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.always);
    assert.equal(tabOf(await opening).title, TITLES.a);

    const later = await connected();
    const opened = tabOf(await harness.ok(later, "tab_open", { url: other.url("/b") }));
    assert.equal(opened.title, TITLES.b);
    assert.deepEqual(await promptContexts(), []);

    const settings = await harness.settingsPage();
    const revoke = `button[aria-label="Revoke ${other.site}"]`;
    await firefox.click(settings, revoke);
    await pollUntil(
      async () => {
        const listed = await firefox.evaluate(
          settings,
          `document.querySelector(${JSON.stringify(revoke)}) !== null`,
        );
        return listed === false ? true : undefined;
      },
      PAGE_TIMEOUT_MS,
      `${other.site} to leave the settings page`,
    );
    await firefox.closeContext(settings);

    const revoked = await connected();
    const hits = other.hits("/a");
    const existingAgain = await promptContexts();
    const asked = pending(harness.refused(revoked, "tab_open", { url: other.url("/a") }));
    const again = await harness.promptContext(existingAgain);
    await waitForQuestion(again, other.site);
    await firefox.closeContext(again);
    const text = await asked;
    assert.ok(text.includes("was closed without an answer"), text);
    assert.equal(other.hits("/a"), hits);
    for (const session of [asking, later, revoked]) await session.close();
  });

  test("a slow answer times out the call, and a reload of the prompt tab waits for it", {
    timeout: 90_000,
  }, async () => {
    const session = await connected();
    const hits = site.hits("/a");
    const existing = await promptContexts();
    const started = Date.now();
    const opening = pending(harness.refused(session, "tab_open", { url: site.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    const text = await opening;
    assert.ok(Date.now() - started >= 29_000, `timed out after ${Date.now() - started} ms`);
    assert.ok(text.includes("is still asking the user in tab"), text);
    assert.ok(text.includes("and action reload"), text);
    const tabId = Number(/tab (\d+)/.exec(text)?.[1]);
    assert.ok(Number.isSafeInteger(tabId), text);
    assert.deepEqual(await promptContexts(), [prompt]);
    assert.equal(site.hits("/a"), hits);

    const retry = pending(harness.ok(session, "navigate", { tabId, action: "reload" }));
    await stillPending(retry, PENDING_MS);
    assert.deepEqual(await promptContexts(), [prompt]);
    assert.equal(site.hits("/a"), hits);
    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.once);
    const tab = tabOf(await retry);
    assert.equal(tab.id, tabId);
    assert.equal(tab.url, site.url("/a"));
    assert.equal(tab.title, TITLES.a);
    assert.equal(site.hits("/a"), hits + 1);
    await session.close();
  });

  test("closing the prompt fails the call and remembers no refusal", async () => {
    const session = await connected();
    const hits = site.hits("/a");
    const existing = await promptContexts();
    const opening = pending(harness.refused(session, "tab_open", { url: site.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    await firefox.closeContext(prompt);
    const text = await opening;
    assert.ok(text.includes("was closed without an answer"), text);
    assert.equal(site.hits("/a"), hits);

    const existingAgain = await promptContexts();
    const asked = pending(harness.refused(session, "tab_open", { url: site.url("/a") }));
    const again = await harness.promptContext(existingAgain);
    await waitForQuestion(again, site.site);
    await firefox.closeContext(again);
    assert.ok((await asked).includes("was closed without an answer"));
    assert.equal(site.hits("/a"), hits);
    await session.close();
  });

  test("the prompt comes to the front, and its tab refuses going back while it asks", async () => {
    const session = await connected();
    const background = tabOf(await harness.ok(session, "tab_open")).id;
    tabOf(await harness.ok(session, "tab_open"));
    const hits = site.hits("/a");
    const existing = await promptContexts();
    const navigating = pending(
      harness.refused(session, "navigate", { tabId: background, url: site.url("/a") }),
    );
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    assert.equal(await firefox.evaluate(prompt, "document.visibilityState"), "visible");

    const back = await harness.refused(session, "navigate", { tabId: background, action: "back" });
    assert.ok(back.includes(`is waiting for the user to answer in tab ${background}`), back);
    await firefox.closeContext(prompt);
    assert.ok((await navigating).includes("was closed without an answer"));
    assert.equal(site.hits("/a"), hits);
    await session.close();
  });

  test("three closed prompts end the asking for the session", async () => {
    const session = await connected();
    const hits = site.hits("/a");
    for (let closed = 0; closed < 3; closed += 1) {
      const existing = await promptContexts();
      const opening = pending(harness.refused(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      await firefox.closeContext(prompt);
      assert.ok((await opening).includes("was closed without an answer"));
    }
    const text = await harness.refused(session, "tab_open", { url: other.url("/a") });
    assert.ok(text.includes("Foxleash asks no more in this session"), text);
    assert.deepEqual(await promptContexts(), []);
    assert.equal(site.hits("/a"), hits);
    assert.deepEqual(tabsOf(await harness.ok(session, "tabs_list")), []);
    await session.close();
  });

  test("an approval prompt's tab Firefox unloaded comes back with only its page in its history", async () => {
    const session = await connected();
    try {
      // The query only makes the URL unique.
      const url = site.url("/a?prompt-unloaded");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url }));
      const prompt = await harness.promptContext(existing);
      await harness.waitForArmed(prompt);
      await firefox.click(prompt, ANSWER.once);
      const opened = tabOf(await opening);
      assert.equal(opened.url, url);
      assert.equal(opened.active, true);
      assert.deepEqual(await firefox.sessionHistory(url), { index: 1, entries: [url] });
      // Firefox does not unload the selected tab.
      await harness.ok(session, "tab_open", { url: site.url("/b") });
      await firefox.discardTab(url);
      await harness.ok(session, "tab_select", { tabId: opened.id });
      await pollUntil(
        async () => {
          const history = await firefox.sessionHistory(url);
          if (history.entries[history.index - 1] !== url) {
            throw new Error(`the history is ${JSON.stringify(history)}`);
          }
          return history;
        },
        5000,
        `${url} as the current entry`,
      );
      // Read again as late as the stray about:blank entry was seen: 1.5 s after the select.
      await sleep(1500);
      assert.deepEqual(await firefox.sessionHistory(url), { index: 1, entries: [url] });
    } finally {
      await session.close();
    }
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
    );
  }

  async function waitForStatus(context: string, text: string): Promise<void> {
    await waitFor(context, "document.getElementById('status').textContent", text);
  }

  async function waitFor(context: string, expression: string, expected: string): Promise<void> {
    await pollUntil(
      async () => {
        const value = await firefox.evaluate(context, expression);
        if (value === expected) return true;
        throw new Error(`the prompt shows ${JSON.stringify(value)}`);
      },
      PAGE_TIMEOUT_MS,
      `the prompt to show ${expected}`,
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
