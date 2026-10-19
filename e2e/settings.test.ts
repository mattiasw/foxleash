import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
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

// Seeded besides the first fixture server's site, which sorts before them (http: before https:).
const SITE_A = "https://a.example";
const SITE_B = "https://b.example";

// What the settings page shows: its sites, whether the list and the empty state are visible,
// the live region's text, and the site of the focused button, or "heading".
const PAGE_STATE = `JSON.stringify({
  sites: [...document.querySelectorAll("#sites button")].map((button) => button.dataset.site),
  list: !document.getElementById("sites").hidden,
  empty: !document.getElementById("sites-empty").hidden,
  status: document.getElementById("status").textContent,
  focus:
    document.activeElement === document.getElementById("sites-heading")
      ? "heading"
      : (document.activeElement?.dataset?.site ?? null),
})`;

interface PageState {
  sites: string[];
  list: boolean;
  empty: boolean;
  status: string;
  focus: string | null;
}

// One Firefox for the file: the tests run in order and share the tab the first one opens.
describe("sites allowed always, in real Firefox", () => {
  let harness: Harness;
  let first: FixtureServer;
  let second: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let tabId = -1;
  let context = "";

  before(
    async () => {
      harness = createHarness();
      harness.install();
      first = await startFixtureServer();
      second = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      const grant = { grantedAt: new Date().toISOString() };
      await harness.seedSettings(
        Object.fromEntries([first.site, SITE_A, SITE_B].map((site) => [`site:${site}`, grant])),
      );
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
        await Promise.all([first?.close(), second?.close()]);
      }
    },
    { timeout: 60_000 },
  );

  test("a tab the user takes to an unapproved site shows the agent only that site", async () => {
    const opened = tabOf(await harness.ok(session, "tab_open", { url: first.url("/a") }));
    assert.equal(opened.url, first.url("/a"));
    assert.equal(opened.title, TITLES.a);
    tabId = opened.id;
    context = await firefox.waitForContext((tab) => tab.url === first.url("/a"), 10_000);

    await firefox.navigate(context, second.url("/b"));
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map(({ id, url, title }) => ({ id, url, title })),
      [{ id: tabId, url: second.site, title: "" }],
    );
  });

  test("a local file shows the agent only that it is a file", async () => {
    const page = join(harness.root, "page.html");
    writeFileSync(page, "<!doctype html><title>Local notes</title><p>Local notes</p>\n");
    await firefox.navigate(context, pathToFileURL(page).href);
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map(({ id, url, title }) => ({ id, url, title })),
      [{ id: tabId, url: "file:", title: "" }],
    );
  });

  test("revoking sites on the settings page moves focus along the list and redacts their tabs", async () => {
    const shown = tabOf(await harness.ok(session, "navigate", { tabId, url: first.url("/a") }));
    assert.equal(shown.url, first.url("/a"));
    const page = await harness.settingsPage();
    const sites = [first.site, SITE_A, SITE_B];
    await waitForPage(page, { sites, list: true, empty: false, status: "", focus: null });

    // Neither the second click of a double-click nor a held Enter revokes anything; a held Tab
    // still moves on.
    const cancelled = await firefox.evaluate(
      page,
      `(() => {
        const button = document.querySelector(${JSON.stringify(revokeButton(first.site))});
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
        const cancels = (init) =>
          !button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
        return JSON.stringify([
          cancels({ key: "Enter", repeat: true }),
          cancels({ key: "Enter" }),
          cancels({ key: "Tab", repeat: true }),
        ]);
      })()`,
    );
    assert.equal(cancelled, "[true,false,false]");

    await revoke(page, SITE_A, [first.site, SITE_B], SITE_B);
    await revoke(page, SITE_B, [first.site], first.site);
    await revoke(page, first.site, [], "heading");

    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.deepEqual(
      tabs.map(({ id, url, title }) => ({ id, url, title })),
      [{ id: tabId, url: first.site, title: "" }],
    );
  });

  /** Clicks a site's Revoke button with real input and waits for the page to show the result. */
  async function revoke(page: string, site: string, sites: string[], focus: string): Promise<void> {
    const button = revokeButton(site);
    // Focused first, so the focus move is checked whatever a click does to focus.
    await firefox.evaluate(page, `document.querySelector(${JSON.stringify(button)}).focus()`);
    await firefox.click(page, button);
    const listed = sites.length > 0;
    await waitForPage(page, {
      sites,
      list: listed,
      empty: !listed,
      status: `Revoked ${site}`,
      focus,
    });
  }

  async function waitForPage(page: string, expected: PageState): Promise<void> {
    const want = JSON.stringify(expected);
    await pollUntil(
      async () => {
        const state = await firefox.evaluate(page, PAGE_STATE);
        if (state === want) return true;
        throw new Error(`the settings page shows ${String(state)}`);
      },
      PAGE_TIMEOUT_MS,
      `the settings page to show ${want}`,
    );
  }
});

function revokeButton(site: string): string {
  return `button[aria-label="Revoke ${site}"]`;
}
