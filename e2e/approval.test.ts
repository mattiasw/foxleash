import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ARMING_DELAY_MS, HOLD_JOIN_MS } from "../apps/extension/src/prompt-arming.ts";
import { type Firefox, isRecord, KEY, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  messageOf,
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
// Each answer button's answer and label, in page order.
const ANSWER_LABELS =
  'JSON.stringify([...document.querySelectorAll("button[data-answer]")].map((button) => [button.dataset.answer, button.textContent]))';
// Where the Allow this session button is drawn, to show that a resize left it under the pointer.
const ONCE_PLACE = `JSON.stringify(document.querySelector(${JSON.stringify(ANSWER.once)}).getBoundingClientRect())`;
const UNARMED = "The buttons respond a moment after this window is focused.";
const UNARMED_COUNT =
  "document.querySelectorAll('button[data-answer][aria-disabled=\"true\"]').length";
const PENDING_MS = 1500;
// The page's REFOCUS text.
const REFOCUS = "Not answered. Wait a second, then use Tab to move to the button and press it.";
const FOCUSED_ANSWER = "document.activeElement?.dataset?.answer ?? null";
const FOCUSED_ID = "document.activeElement?.id ?? null";
// A keyup with no keydown, as the page sees the key that makes Firefox's menu bar let go.
const UNSEEN_ESCAPE =
  'document.activeElement.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }))';
// The event Firefox fires in the page before it shows a context menu.
const CONTEXT_MENU =
  'document.getElementById("heading").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))';
// A right-button press, and one made while another button is down, which fires no pointerdown.
const RIGHT_PRESS =
  'document.getElementById("heading").dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true }))';
const CHORDED_RIGHT_PRESS =
  'document.getElementById("heading").dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }))';
// Well under the one-second arming delay.
const TYPING_GAP_MS = 300;
// A host of 253 characters, the DNS limit; never loaded.
const LONG_HOST = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
// Where the host starts in the question, how many lines it takes, whether each of them is inside
// the window, and whether the page fits its width without scrolling sideways.
const HOST_FIT = `(() => {
  const text = document.getElementById("heading").firstChild;
  const start = text.data.indexOf(${JSON.stringify(LONG_HOST)});
  const range = document.createRange();
  range.setStart(text, Math.max(start, 0));
  range.setEnd(text, Math.max(start, 0) + ${LONG_HOST.length});
  const rects = [...range.getClientRects()];
  const width = document.documentElement.clientWidth;
  return JSON.stringify({
    start,
    lines: rects.length,
    inside: rects.every((rect) => rect.left >= 0 && rect.right <= width),
    page: document.documentElement.scrollWidth <= width,
  });
})()`;
// One line per event, kept in a page global: the time, the type, the key, the target, where focus
// came from (focus) or goes (blur), the answer buttons and how many are unarmed, as ARMED_STATE
// counts them, the page's focus and its visibility. Capture listeners on window also see focus
// events aimed at elements; the window's own focus and blur are taken where the page takes them.
const RECORD_INPUT = `(() => {
  if (window.__inputRecord !== undefined) return true;
  const entries = [];
  window.__inputRecord = entries;
  const start = performance.now();
  const name = (target) => {
    if (target === null) return "-";
    if (target === window) return "window";
    if (target === document) return "document";
    return target.id || target.dataset?.answer || target.nodeName.toLowerCase();
  };
  const add = (event) => {
    const parts = [Math.round(performance.now() - start), event.type];
    if (event instanceof KeyboardEvent) parts.push(JSON.stringify(event.key));
    parts.push(name(event.target));
    if (event.type === "focus") parts.push("from=" + name(event.relatedTarget));
    if (event.type === "blur") parts.push("to=" + name(event.relatedTarget));
    parts.push(
      "buttons=" + document.querySelectorAll("button[data-answer]").length,
      "unarmed=" + document.querySelectorAll('button[data-answer][aria-disabled="true"]').length,
      "focus=" + document.hasFocus(),
      document.visibilityState,
    );
    entries.push(parts.join(" "));
    if (entries.length > 80) entries.shift();
  };
  window.addEventListener("keydown", add, { capture: true });
  window.addEventListener("keyup", add, { capture: true });
  for (const type of ["focus", "blur"]) {
    window.addEventListener(type, (event) => event.target !== window && add(event), { capture: true });
    window.addEventListener(type, (event) => event.target === window && add(event));
  }
  document.addEventListener("visibilitychange", add);
  return true;
})()`;
const INPUT_RECORD = `(() => {
  const lines = window.__inputRecord === undefined ? ["no input record in " + location.href] : [...window.__inputRecord];
  const active = document.activeElement;
  const focused = active === null ? "none" : active.id || active.dataset?.answer || active.nodeName.toLowerCase();
  lines.push("status " + JSON.stringify(document.getElementById("status")?.textContent ?? null) + ", focus on " + focused);
  return lines.join("\\n");
})()`;

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
    assert.equal(
      await firefox.evaluate(prompt, ANSWER_LABELS),
      JSON.stringify([
        ["no", "Don't allow"],
        ["once", "Allow this session"],
        ["always", "Always allow"],
      ]),
    );

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

  test("after a slow answer, navigate on the question's tab loads the page in that tab", {
    timeout: 90_000,
  }, async () => {
    const { session, tabId, hits } = await answeredAfterTimeout();
    const tabCount = tabsOf(await harness.ok(session, "tabs_list")).length;

    const tab = tabOf(await harness.ok(session, "navigate", { tabId, url: site.url("/a") }));
    assert.equal(tab.id, tabId);
    assert.equal(tab.url, site.url("/a"));
    assert.equal(tab.title, TITLES.a);
    assert.deepEqual(await promptContexts(), []);
    assert.equal(tabsOf(await harness.ok(session, "tabs_list")).length, tabCount);
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

  test("the question wraps a long site so the whole of it fits the window", async () => {
    const session = await connected();
    const existing = await promptContexts();
    const opening = pending(harness.refused(session, "tab_open", { url: `https://${LONG_HOST}/` }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, `https://${LONG_HOST}`);
    const fit: unknown = JSON.parse(String(await firefox.evaluate(prompt, HOST_FIT)));
    assert.ok(isRecord(fit), String(fit));
    assert.deepEqual(
      {
        found: typeof fit.start === "number" && fit.start >= 0,
        wraps: typeof fit.lines === "number" && fit.lines > 1,
        inside: fit.inside,
        page: fit.page,
      },
      { found: true, wraps: true, inside: true, page: true },
      JSON.stringify(fit),
    );
    await firefox.closeContext(prompt);
    const text = await opening;
    assert.ok(text.includes("was closed without an answer"), text);
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
    assert.ok(
      back.includes(`is waiting for the user to answer whether to allow ${site.site} `),
      back,
    );
    assert.ok(back.includes(`(tab id ${background})`), back);
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
      await harness.showElsewhereAndBack(prompt, elsewhere);
      await harness.waitForArmed(prompt);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "once");
      await pressRefused(prompt, [KEY.enter]);
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab]);
      await harness.showElsewhereAndBack(prompt, elsewhere);
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
    let recorded: string | undefined;
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      await recordInput(prompt);
      recorded = prompt;
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
      await harness.showElsewhereAndBack(prompt, elsewhere);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ANSWER), "no");
      await pressRefused(prompt, [KEY.enter]);
      await sleep(1100);
      await firefox.keys(prompt, [KEY.enter]);
      await sleep(TYPING_GAP_MS);
      await pressRefused(prompt, [KEY.enter, KEY.tab, KEY.enter]);
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
    } catch (error: unknown) {
      if (recorded === undefined) throw error;
      throw new Error(
        `${messageOf(error)}\n--- prompt input record ---\n${await inputRecord(recorded)}`,
        { cause: error },
      );
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

  test("a lone Alt keeps a prompt from answering until the page sees a key or a click again", async () => {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);
      const elsewhere = await firefox.openContext("about:blank");

      // On Linux a lone Alt opens Firefox's menu bar, which takes the keys after it; the Tab path
      // right after one does not answer. Keys less than HOLD_JOIN_MS after it would join the hold.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.alt]);
      await sleep(2 * HOLD_JOIN_MS);
      await pressRefused(prompt, [KEY.tab, KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // The buttons stay unarmed after a lone Alt, also well past the second.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.alt]);
      await sleep(1500);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);

      // Focusing the window again does not end the hold; a key does, and starts the second there.
      await firefox.activate(elsewhere);
      await firefox.activate(prompt);
      await sleep(1500);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
      await pressRefused(prompt, [KEY.tab, KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      // A click ends the hold, and the buttons arm a second later.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.alt]);
      await firefox.click(prompt, "#heading");
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

  test("a key the prompt did not see go down starts its second again when it comes up", async () => {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);

      // The keyup that ends Firefox's menu bar reaches the page with no keydown. In one call, so
      // the page cannot arm again before the count is read.
      await harness.waitForArmed(prompt);
      assert.equal(
        await firefox.evaluate(prompt, `(() => { ${UNSEEN_ESCAPE}; return ${UNARMED_COUNT}; })()`),
        3,
      );

      // It also ends a lone Alt's hold, from HOLD_JOIN_MS after the Alt.
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.alt]);
      await sleep(2 * HOLD_JOIN_MS);
      await firefox.evaluate(prompt, UNSEEN_ESCAPE);
      await harness.waitForArmed(prompt);
      assert.equal(await firefox.evaluate(prompt, FOCUSED_ID), "heading");
      await firefox.keys(prompt, [KEY.tab, KEY.tab, KEY.enter]);
      const tab = tabOf(await opening);
      assert.equal(tab.url, site.url("/a"));
      assert.equal(site.hits("/a"), hits + 1);
    } finally {
      await session.close();
    }
  });

  test("a pointer press alone ends a lone Alt's hold", async () => {
    await answeredAfterLoneAlt(
      `document.getElementById("heading").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`,
    );
  });

  test("a click with no pointer press ends a lone Alt's hold, as a screen reader's does", async () => {
    await answeredAfterLoneAlt(`document.getElementById("heading").click()`);
  });

  test("F10 keeps a prompt from answering until the page sees a key or a click again", async () => {
    await heldUntilInput((prompt) => firefox.keys(prompt, [KEY.f10]));
  });

  test("a context menu keeps a prompt from answering until the page sees a key or a click again", async () => {
    await heldUntilInput(async (prompt) => {
      await firefox.evaluate(prompt, CONTEXT_MENU);
    });
  });

  test("an Alt chord keeps a prompt from answering until the page sees a key or a click again", async () => {
    await heldUntilInput((prompt) => firefox.keys(prompt, [[KEY.alt, "v"]]));
  });

  test("a right-button press keeps a prompt from answering until the page sees a key or a click again", async () => {
    await heldUntilInput(async (prompt) => {
      await firefox.evaluate(prompt, RIGHT_PRESS);
    });
  });

  test("a right-button press with another button down keeps a prompt from answering", async () => {
    await heldUntilInput(async (prompt) => {
      await firefox.evaluate(prompt, CHORDED_RIGHT_PRESS);
    });
  });

  test("a click whose press began before the buttons armed does not answer", async (t) => {
    const session = await connected();
    t.after(() => session.close());
    const hits = site.hits("/a");
    const existing = await promptContexts();
    const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    const elsewhere = await firefox.openContext("about:blank");
    t.after(() => firefox.closeContext(elsewhere));
    await firefox.activate(elsewhere);
    assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);

    // The press switches to the prompt first, so it goes down within the page's first second of
    // focus; held, it starts no second again, and the page arms under it.
    await firefox.press(prompt, ANSWER.once);
    try {
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
      await waitFor(prompt, `String(${UNARMED_COUNT})`, "0");
    } finally {
      await firefox.release(prompt);
    }
    await stillPending(opening, PENDING_MS);
    await waitForStatus(prompt, UNARMED);
    assert.equal(site.hits("/a"), hits);

    // The page still answers a click pressed while armed.
    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.once);
    assert.equal(tabOf(await opening).url, site.url("/a"));
    assert.equal(site.hits("/a"), hits + 1);
  });

  test("a prompt in a visible tab of a window without focus stays unarmed, and the click that focuses it does not answer", async (t) => {
    const session = await connected();
    t.after(() => session.close());
    // Opened in the window that has focus, before another window takes it.
    const tabId = tabOf(await harness.ok(session, "tab_open")).id;
    const front = await firefox.openWindow();
    t.after(() => firefox.closeContext(front));
    await firefox.activate(front);
    const hits = site.hits("/a");
    const existing = await promptContexts();
    const navigating = pending(
      harness.refused(session, "navigate", { tabId, url: site.url("/a") }),
    );
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    // Only BiDi until the click: a Marionette call on the prompt switches to its window, which
    // focuses it.
    const state = `JSON.stringify([document.visibilityState, document.hasFocus(), ${UNARMED_COUNT}])`;
    const unfocused = JSON.stringify(["visible", false, 3]);
    assert.equal(await firefox.evaluate(prompt, state), unfocused);
    await sleep(ARMING_DELAY_MS + 500);
    assert.equal(await firefox.evaluate(prompt, state), unfocused);
    // The question's window is not in front, so the call ends early and the question stays open.
    const text = await navigating;
    assert.ok(text.includes("window is not in front"), text);

    // The click focuses the window and lands at once.
    await firefox.click(prompt, ANSWER.once);
    await waitForStatus(prompt, UNARMED);
    // Still unanswered: a call on the prompt's tab joins the question and waits.
    const joined = pending(harness.refused(session, "navigate", { tabId, url: site.url("/a") }));
    await stillPending(joined, PENDING_MS);
    assert.equal(site.hits("/a"), hits);
  });

  test("a resize of the prompt's window starts its arming second again, and the asking session cannot resize it", async (t) => {
    // Another session in the same window, with its tab opened before the question: a session that
    // is not asking selects the tab it opens, which would hide the prompt.
    const resizing = await connected();
    t.after(() => resizing.close());
    await harness.ok(resizing, "tab_open");
    await harness.ok(resizing, "resize_window", { width: 1000, height: 700 });
    const session = await connected();
    t.after(() => session.close());
    const existing = await promptContexts();
    const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    const hits = site.hits("/a");
    await harness.waitForArmed(prompt);

    const text = await harness.refused(session, "resize_window", { width: 900, height: 700 });
    assert.ok(text.includes("Foxleash is waiting for the user to answer whether to allow"), text);

    await harness.resizeUnarms(resizing, prompt, { width: 900, height: 700 });
    await firefox.click(prompt, ANSWER.always);
    await waitForStatus(prompt, UNARMED);
    await stillPending(opening, PENDING_MS);
    assert.equal(site.hits("/a"), hits);

    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.once);
    assert.equal(tabOf(await opening).url, site.url("/a"));
    assert.equal(site.hits("/a"), hits + 1);
  });

  test("a press held on an armed button while the prompt's window is resized does not answer, also once the buttons arm again", async (t) => {
    const resizing = await connected();
    t.after(() => resizing.close());
    await harness.ok(resizing, "tab_open");
    await harness.ok(resizing, "resize_window", { width: 1000, height: 700 });
    const session = await connected();
    t.after(() => session.close());
    const existing = await promptContexts();
    const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
    const prompt = await harness.promptContext(existing);
    await waitForQuestion(prompt, site.site);
    const hits = site.hits("/a");
    await harness.waitForArmed(prompt);
    const place = await firefox.evaluate(prompt, ONCE_PLACE);

    // The page arms under a held press; the release lands on the same button, which did not move.
    await firefox.press(prompt, ANSWER.once);
    try {
      await harness.resizeUnarms(resizing, prompt, { width: 900, height: 700 });
      assert.equal(await firefox.evaluate(prompt, ONCE_PLACE), place);
      await waitFor(prompt, `String(${UNARMED_COUNT})`, "0");
    } finally {
      await firefox.release(prompt);
    }
    await waitForStatus(prompt, UNARMED);
    await stillPending(opening, PENDING_MS);
    assert.equal(site.hits("/a"), hits);

    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.once);
    assert.equal(tabOf(await opening).url, site.url("/a"));
    assert.equal(site.hits("/a"), hits + 1);
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
    const tabId = Number(/tab id (\d+)/.exec(text)?.[1]);
    assert.ok(Number.isSafeInteger(tabId), text);
    // The title the result quotes is the one the question's tab shows.
    const title = String(await firefox.evaluate(prompt, "document.title"));
    assert.equal(title, `Allow Foxleash on ${site.site}?`);
    assert.ok(
      text.includes(
        `in the tab titled ${JSON.stringify(title)} in the user's Firefox window (tab id ${tabId})`,
      ),
      text,
    );
    assert.ok(text.includes(`call navigate with tab id ${tabId}`), text);
    assert.ok(text.includes("call tab_open with the page's URL instead"), text);
    assert.ok(!text.includes("action reload"), text);
    assert.deepEqual(await promptContexts(), [prompt]);
    assert.equal(site.hits("/a"), hits);

    await harness.waitForArmed(prompt);
    await firefox.click(prompt, ANSWER.once);
    await waitForStatus(prompt, "Allowed for this session. Ask the agent to try again.");
    return { session, prompt, tabId, hits };
  }

  /**
   * Holds an armed prompt with a lone Alt, ends the hold with the input `release` dispatches, and
   * answers Allow this session with a click once the buttons arm again.
   */
  async function answeredAfterLoneAlt(release: string): Promise<void> {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);

      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.alt]);
      await firefox.evaluate(prompt, release);
      await harness.waitForArmed(prompt);
      await firefox.click(prompt, ANSWER.once);
      const tab = tabOf(await opening);
      assert.equal(tab.url, site.url("/a"));
      assert.equal(site.hits("/a"), hits + 1);
    } finally {
      await session.close();
    }
  }

  /**
   * Holds an armed prompt with the input `hold` sends, which can open a Firefox menu: the buttons
   * stay unarmed well past the second, a Tab path right after a key ends the hold is refused, and
   * after a click ends it the buttons arm and Tab, Tab, Enter answers Allow this session.
   */
  async function heldUntilInput(hold: (prompt: string) => Promise<void>): Promise<void> {
    const session = await connected();
    try {
      const hits = site.hits("/a");
      const existing = await promptContexts();
      const opening = pending(harness.ok(session, "tab_open", { url: site.url("/a") }));
      const prompt = await harness.promptContext(existing);
      await waitForQuestion(prompt, site.site);

      await harness.waitForArmed(prompt);
      await hold(prompt);
      await sleep(1500);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
      await pressRefused(prompt, [KEY.tab, KEY.tab, KEY.enter]);
      await stillPending(opening, PENDING_MS);
      assert.equal(site.hits("/a"), hits);

      await harness.waitForArmed(prompt);
      await hold(prompt);
      await sleep(1500);
      assert.equal(await firefox.evaluate(prompt, UNARMED_COUNT), 3);
      await firefox.click(prompt, "#heading");
      await harness.waitForArmed(prompt);
      await firefox.keys(prompt, [KEY.tab, KEY.tab, KEY.enter]);
      const tab = tabOf(await opening);
      assert.equal(tab.url, site.url("/a"));
      assert.equal(site.hits("/a"), hits + 1);
    } finally {
      await session.close();
    }
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

  /**
   * Records in the prompt page each key, focus, blur and visibility event with the arming as the
   * page left it: the page's window and document listeners were registered first, so they have run
   * for that event. A button's own listeners run after, and change nothing an entry shows.
   */
  async function recordInput(context: string): Promise<void> {
    await firefox.evaluate(context, RECORD_INPUT);
  }

  /** The input record, with the status and the focused element; never throws. */
  async function inputRecord(context: string): Promise<string> {
    try {
      return String(await firefox.evaluate(context, INPUT_RECORD));
    } catch (error: unknown) {
      return `input record unreadable: ${messageOf(error)}`;
    }
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
