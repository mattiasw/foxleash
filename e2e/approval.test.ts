import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, KEY, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
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
// The page's REFOCUS text.
const REFOCUS = "Not answered. Wait a second, then use Tab to move to the button and press it.";
const FOCUSED_ANSWER = "document.activeElement?.dataset?.answer ?? null";
const FOCUSED_ID = "document.activeElement?.id ?? null";
// Well under the one-second arming delay.
const TYPING_GAP_MS = 300;

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

  test("after a slow answer, the same tab_open opens the page once the prompt tab is closed", {
    timeout: 90_000,
  }, async () => {
    const { session, prompt, hits } = await answeredAfterTimeout();
    assert.equal(
      await firefox.evaluate(prompt, "document.getElementById('close').checkVisibility()"),
      true,
    );
    await firefox.closeContext(prompt);

    const tab = tabOf(await harness.ok(session, "tab_open", { url: site.url("/a") }));
    assert.equal(tab.url, site.url("/a"));
    assert.equal(tab.title, TITLES.a);
    assert.deepEqual(await promptContexts(), []);
    assert.equal(site.hits("/a"), hits + 1);
    await session.close();
  });

  test("after a slow answer, the same tab_open opens the page in a new tab beside the answered prompt", {
    timeout: 90_000,
  }, async () => {
    const { session, prompt, tabId, hits } = await answeredAfterTimeout();

    const tab = tabOf(await harness.ok(session, "tab_open", { url: site.url("/a") }));
    assert.notEqual(tab.id, tabId);
    assert.equal(tab.url, site.url("/a"));
    assert.equal(tab.title, TITLES.a);
    assert.deepEqual(await promptContexts(), [prompt]);
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

  test("Enter or Space answers only on an answer button reached after the buttons armed", async () => {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      const elsewhere = await firefox.openContext("about:blank");

      // Focus reaches Allow this session before the buttons arm.
      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab]);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");

      // Once armed, Enter on it does not answer: focus goes back to the question, and the page
      // says what to do.
      await harness.waitForArmed(prompt);
      await pressRefused(prompt, [KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Nor does Space held while Enter is pressed on a button whose focus does not count: the
      // Enter on the question starts the second again, so both Tabs arrive unarmed. Firefox
      // clicks on Enter and again on the Space keyup.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.enter, KEY.tab, KEY.tab]);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [[" ", KEY.enter]]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus moved there while armed no longer counts after the page loses focus, for Enter or
      // Space.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab]);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await pressRefused(prompt, [KEY.enter]);
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab]);
      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      await harness.waitForArmed(prompt);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await pressRefused(prompt, [" "]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // A letter typed after the buttons armed starts their second again, so moving to the button
      // right after it and pressing Enter does not answer.
      await harness.waitForArmed(prompt);
      await pressRefused(prompt, ["x", KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus moved there while armed no longer counts after a letter, also once the buttons
      // arm again with focus still on it.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab, "x"]);
      await harness.waitForArmed(prompt);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await pressRefused(prompt, [KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Enter typed outside the answer buttons starts their second again, so moving to a button
      // right after it and pressing Enter does not answer.
      await harness.waitForArmed(prompt);
      await firefox.click(prompt, "#heading");
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), null);
      await pressRefused(prompt, [KEY.enter, KEY.tab, KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // A letter typed while a counted Space is down starts the second again before its keyup.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, [" ", "x"]]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus is still on Don't allow, no longer counted; Enter goes back to the question, and
      // Tab from there, once armed, reaches a button whose Enter answers.
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "no");
      await pressRefused(prompt, [KEY.enter]);
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab, KEY.enter]);
      const tab = tabOf(await opening);
      assert.equal(tab.url, site.url("/a"));
      assert.equal(site.hits("/a"), hits + 1);
      await firefox.closeContext(elsewhere);
    } finally {
      await session.close();
    }
  });

  test("a prompt rests focus on its question, and Shift+Tab then Enter or Space answers nothing", async () => {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.refused(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      await waitFor(prompt, FOCUSED_ID, "heading");

      // From the page's body, which held focus before the page focused its question, Shift+Tab
      // reached Always allow, and Enter answered it.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [[KEY.shift, KEY.tab]]);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), null);
      await firefox.keys(prompt, [KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      await firefox.click(prompt, "#heading");
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [[KEY.shift, KEY.tab]]);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), null);
      await firefox.keys(prompt, [" "]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus came back on no element, from which Tab never counts; from the question it does.
      await firefox.click(prompt, "#heading");
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.enter]);
      const text = await opening;
      assert.ok(text.includes(`The user did not allow Foxleash on ${site.site}`), text);
      assert.equal(site.hits("/a"), hits);
    } finally {
      await session.close();
    }
  });

  test("refused key presses start the second again and send focus back to the question", async () => {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      const elsewhere = await firefox.openContext("about:blank");

      // Focus on Allow this session from before the buttons armed does not count, nor does the
      // focus Tab moves on from it.
      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab]);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await harness.waitForArmed(prompt);
      await pressRefused(prompt, [KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // A refused press starts the second again, so the Tab after it arrives unarmed. In one
      // call: the page arms again during a wait of PENDING_MS.
      await harness.waitForArmed(prompt);
      await focusAnswer(prompt, ANSWER.always);
      await pressRefused(prompt, [KEY.enter, KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // A Tab while a counted Space is down starts the second again.
      await harness.waitForArmed(prompt);
      await pressRefused(prompt, [KEY.tab, [" ", KEY.tab], KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Refused presses no longer fill the pause: the window comes back with focus on Don't
      // allow, which does not count.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab]);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "no");
      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      await firefox.keys(prompt, [KEY.enter]);
      await sleep(1100);
      await firefox.keys(prompt, [KEY.enter]);
      await sleep(TYPING_GAP_MS);
      await firefox.keys(prompt, [KEY.enter, KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus from no element does not count.
      await harness.waitForArmed(prompt);
      await firefox.click(prompt, "#heading");
      await firefox.evaluate(prompt, "document.activeElement.blur()");
      await pressRefused(prompt, [KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus from after the buttons does not count.
      await harness.waitForArmed(prompt);
      await firefox.evaluate(prompt, `document.getElementById("status").focus()`);
      await focusAnswer(prompt, ANSWER.no);
      await pressRefused(prompt, [KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Focus that skips a button on the path does not count.
      await harness.waitForArmed(prompt);
      await focusAnswer(prompt, ANSWER.always);
      await pressRefused(prompt, [KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // Nor does focus that skips a button from a button whose focus counts.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab]);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "no");
      await focusAnswer(prompt, ANSWER.always);
      await pressRefused(prompt, [KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // From the question, once armed, Tab, Tab and Space answer.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab, " "]);
      const tab = tabOf(await opening);
      assert.equal(tab.url, site.url("/a"));
      assert.equal(site.hits("/a"), hits + 1);
      await firefox.closeContext(elsewhere);
    } finally {
      await session.close();
    }
  });

  test("typing into the prompt keeps its buttons unarmed until the typing stops", async () => {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      const elsewhere = await firefox.openContext("about:blank");

      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      const started = Date.now();
      let previous = started;
      // A letter, not Tab: Tab past the last button leaves the page, which disarms it anyway.
      while (Date.now() - started < 2000) {
        // Also before the key: a letter typed while armed disarms again, so a page that armed
        // during the pause would read unarmed after it.
        assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
        await firefox.keys(prompt, ["a"]);
        const gap = Date.now() - previous;
        previous = Date.now();
        assert.ok(gap < 900, `the runner left ${gap} ms between keys`);
        assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
        await sleep(TYPING_GAP_MS);
      }
      assert.ok(Date.now() - started >= 2000);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);

      // Once the typing stops, the buttons arm and a click answers.
      await harness.waitForArmed(prompt);
      await firefox.click(prompt, ANSWER.once);
      const tab = tabOf(await opening);
      assert.equal(tab.url, site.url("/a"));
      assert.equal(site.hits("/a"), hits + 1);
      await firefox.closeContext(elsewhere);
    } finally {
      await session.close();
    }
  });

  async function connected(): Promise<Session> {
    const session = await harness.connect();
    await harness.waitUntilReady(session);
    return session;
  }

  /**
   * Opens the site in a fresh session and lets the call time out, then answers Allow this
   * session in the prompt, which stays open.
   */
  async function answeredAfterTimeout(): Promise<{
    session: Session;
    prompt: string;
    tabId: number;
    hits: number;
  }> {
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
    assert.ok(text.includes("make the same tab_open or navigate call again"), text);
    assert.ok(text.includes("call tab_open with the page's URL instead"), text);
    assert.ok(!text.includes("action reload"), text);
    const tabId = Number(/tab (\d+)/.exec(text)?.[1]);
    assert.ok(Number.isSafeInteger(tabId), text);
    assert.deepEqual(await promptContexts(), [prompt]);
    assert.equal(site.hits("/a"), hits);

    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.once);
    await waitForStatus(prompt, "Allowed for this session. Ask the agent to try again.");
    return { session, prompt, tabId, hits };
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

  /**
   * Presses `keys` in one call, the last of them refused: the page shows its REFOCUS text, written
   * again after the status is cleared, with focus back on the question.
   */
  async function pressRefused(
    context: string,
    keys: readonly (string | readonly string[])[],
  ): Promise<void> {
    await firefox.evaluate(context, `document.getElementById("status").textContent = ""`);
    await firefox.keys(context, keys);
    await waitForStatus(context, REFOCUS);
    assert.equal(await firefox.evaluate(context, FOCUSED_ID), "heading");
  }

  /** Focuses an answer button by script, from wherever focus is. */
  async function focusAnswer(context: string, selector: string): Promise<void> {
    await firefox.evaluate(context, `document.querySelector(${JSON.stringify(selector)}).focus()`);
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
