import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  startFixtureServer,
  TITLES,
  WAIT_LATE_TEXT,
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

const REF = "([a-z]{1,7}[1-9][0-9]*)";

// One Firefox for the file: the tests run in order and build on each other's tab.
describe("wait_for in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let tabId = -1;

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

  test("wait_for text fails before the page shows it, then returns once it does", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/wait-late") }));
    tabId = tab.id;
    const early = await harness.refused(session, "wait_for", {
      tabId,
      text: WAIT_LATE_TEXT,
      timeout: 0.1,
    });
    assert.ok(early.includes("did not show that text within 0.1 seconds"), early);
    const shown = tabOf(await harness.ok(session, "wait_for", { tabId, text: WAIT_LATE_TEXT }));
    assert.equal(shown.id, tabId);
    assert.equal(shown.title, TITLES.waitLate);
  });

  test("wait_for selector returns once an element matches", async () => {
    await harness.ok(session, "navigate", { tabId, action: "reload" });
    const shown = tabOf(await harness.ok(session, "wait_for", { tabId, selector: "#late" }));
    assert.equal(shown.id, tabId);
  });

  test("wait_for navigation returns the tab once the page's own navigation finishes", async () => {
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/wait-navigate") });
    const moved = tabOf(await harness.ok(session, "wait_for", { tabId, navigation: true }));
    assert.equal(moved.id, tabId);
    assert.equal(moved.url, fixtures.url("/a"));
    assert.equal(moved.title, TITLES.a);
  });

  test("wait_for fails when the text never shows", async () => {
    const text = await harness.refused(session, "wait_for", {
      tabId,
      text: "Never shown on this page",
      timeout: 0.5,
    });
    assert.ok(text.includes("did not show that text within 0.5 seconds"), text);
  });

  test("wait_for refuses a selector that is not valid CSS", async () => {
    const text = await harness.refused(session, "wait_for", { tabId, selector: "[[" });
    assert.ok(text.includes("The selector is not valid CSS."), text);
  });

  test("wait_for refuses a selector on the value attribute", async () => {
    const text = await harness.refused(session, "wait_for", {
      tabId,
      selector: 'input[value^="a"]',
    });
    assert.ok(
      text.includes(
        'wait_for does not take a selector that contains both "[" and "value", since it could test what a password field holds.',
      ),
      text,
    );
  });

  test("wait_for navigation right after a click returns the page the click loaded at once", async () => {
    await harness.ok(session, "navigate", { tabId, url: fixtures.url("/read-landmarks") });
    const read = await harness.call(session, "read_page", { tabId });
    assert.equal(read.isError, false, read.text);
    const tree = untrustedContent(read.text);
    assert.ok(tree !== undefined, `not one untrusted frame:\n${read.text}`);
    await harness.ok(session, "click", { tabId, ref: refOf(tree, 'link "Home"') });
    await pollUntil(
      async () => {
        const tabs = tabsOf(await harness.ok(session, "tabs_list"));
        return tabs.some((tab) => tab.id === tabId && tab.title === TITLES.a) ? true : undefined;
      },
      10_000,
      "the click's page to load",
    );
    // So the load's end has surely reached the extension before the call.
    await sleep(300);
    const start = Date.now();
    const moved = tabOf(await harness.ok(session, "wait_for", { tabId, navigation: true }));
    const elapsed = Date.now() - start;
    assert.equal(moved.id, tabId);
    assert.equal(moved.url, fixtures.url("/a"));
    assert.equal(moved.title, TITLES.a);
    assert.ok(elapsed < 2000, `wait_for took ${elapsed} ms`);
  });

  test("wait_for navigation does not return twice for one navigation", async () => {
    const text = await harness.refused(session, "wait_for", {
      tabId,
      navigation: true,
      timeout: 1,
    });
    assert.ok(text.includes("did not finish a navigation within 1 second"), text);
  });

  test("wait_for navigation with no earlier action in the tab waits for the next one", async () => {
    const opened = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    await sleep(300);
    const text = await harness.refused(session, "wait_for", {
      tabId: opened.id,
      navigation: true,
      timeout: 1,
    });
    assert.ok(text.includes("did not finish a navigation within 1 second"), text);
  });
});

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}
