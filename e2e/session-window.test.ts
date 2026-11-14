import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  startFixtureServer,
  TITLES,
  WAIT_LATE_TEXT,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

interface WindowState {
  id: number;
  tabs: { id: number; active: boolean; groupId: number }[];
}

const STATUS = "#session-window-status";
// Long enough for a session end the host has passed on to have closed what it closes.
const SESSION_END_MS = 2000;

// One Firefox for the file. The settings page stays open in the user's window, and every test
// reads and changes the windows from it.
describe("each agent session in its own window, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let other: FixtureServer;
  let firefox: Firefox;
  let settings = "";
  let userWindow = -1;
  // The session that opened a window in "turning the setting on", used by the tests after it.
  let session: Session;
  let sessionWindow = -1;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      other = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      settings = await harness.settingsPage();
      userWindow = Number(
        await firefox.evaluate(settings, "browser.tabs.getCurrent().then((tab) => tab.windowId)"),
      );
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await Promise.all([fixtures?.close(), other?.close()]);
      }
    },
    { timeout: 60_000 },
  );

  test("the settings page's checkbox stores the setting and removes it again", async () => {
    await firefox.click(settings, "#session-window");
    await waitForStored(true);
    await waitForStatus("Saved. Each agent session opens in its own window.");
    await firefox.click(settings, "#session-window");
    await waitForStored(false);
    await waitForStatus("Saved. Agent sessions open their tabs in your window.");
  });

  test("with the setting off, a session's first tab opens in the user's window", async () => {
    const off = await connected();
    try {
      const tab = tabOf(await harness.ok(off, "tab_open", { url: fixtures.url("/a?off") }));
      assert.equal((await windowOf(tab.id)).id, userWindow);
      assert.equal((await windows()).length, 1);
      await harness.ok(off, "tab_close", { tabId: tab.id });
    } finally {
      await off.close();
    }
  });

  test("with the setting on, a session's tabs open in a new window of its own", async () => {
    await run("browser.storage.local.set({ sessionWindow: true })");
    await pollUntil(
      async () =>
        (await firefox.evaluate(settings, 'document.getElementById("session-window").checked')) ===
        true
          ? true
          : undefined,
      PAGE_TIMEOUT_MS,
      "the checkbox to show the stored setting",
    );
    const selected = activeTab(await windowById(userWindow));
    session = await connected();
    const first = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a?own") }));
    assert.equal(first.title, TITLES.a);
    // Its window's own first tab goes once the session's tab is selected.
    const shown = await pollUntil(
      async () => {
        const window = await windowOf(first.id);
        return window.tabs.length === 1 ? window : undefined;
      },
      PAGE_TIMEOUT_MS,
      "the session's window to hold only its tab",
    );
    sessionWindow = shown.id;
    assert.notEqual(sessionWindow, userWindow);
    assert.notEqual(shown.tabs[0]?.groupId, -1);
    assert.equal((await windows()).length, 2);
    const second = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b?own") }));
    const window = await windowOf(second.id);
    assert.equal(window.id, sessionWindow);
    assert.equal(window.tabs.find((tab) => tab.id === second.id)?.groupId, shown.tabs[0]?.groupId);
    assert.equal(activeTab(await windowById(userWindow)), selected);
  });

  test("a page in the session's window comes back with only its page in its history", async () => {
    const url = fixtures.url("/a?own-history");
    const opened = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal((await windowOf(opened.id)).id, sessionWindow);
    // Firefox does not unload the selected tab.
    const selected = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
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
    // Read again as late as a stray about:blank entry was seen: 1.5 s after the select.
    await sleep(1500);
    assert.deepEqual(await firefox.sessionHistory(url), { index: 1, entries: [url] });
    for (const tabId of [opened.id, selected.id]) await harness.ok(session, "tab_close", { tabId });
  });

  test("the tools work while the session's window is behind the user's, and minimized", {
    timeout: 120_000,
  }, async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/wait-late") }));
    assert.equal((await windowOf(tab.id)).id, sessionWindow);
    await run(`browser.windows.update(${userWindow}, { focused: true })`);
    await useTools(tab.id);
    await run(`browser.windows.update(${sessionWindow}, { state: "minimized" })`);
    await useTools(tab.id);
    await run(`browser.windows.update(${sessionWindow}, { state: "normal" })`);
    await harness.ok(session, "tab_close", { tabId: tab.id });
  });

  test("the next tab opens a new window once the user closed the session's window", async () => {
    await run(`browser.windows.remove(${sessionWindow})`);
    await pollUntil(
      async () => ((await windows()).length === 1 ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the session's window to close",
    );
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a?again") }));
    const window = await windowOf(tab.id);
    assert.notEqual(window.id, sessionWindow);
    assert.notEqual(window.id, userWindow);
    assert.notEqual(window.tabs.find((found) => found.id === tab.id)?.groupId, -1);
    await session.close();
    await closeWindow(window.id);
  });

  test("a session's blank first tab opens a window that closes when the session ends", async () => {
    const blank = await connected();
    let opened: WindowState | undefined;
    try {
      const tab = tabOf(await harness.ok(blank, "tab_open"));
      opened = await windowOf(tab.id);
      assert.notEqual(opened.id, userWindow);
      assert.deepEqual(
        opened.tabs.map((found) => found.id),
        [tab.id],
      );
      assert.notEqual(opened.tabs[0]?.groupId, -1);
    } finally {
      await blank.close();
    }
    assert.ok(opened !== undefined);
    const closed = opened.id;
    await pollUntil(
      async () => ((await windows()).some((window) => window.id === closed) ? undefined : true),
      PAGE_TIMEOUT_MS,
      "the session's window to close",
    );
    assert.deepEqual(
      (await windows()).map((window) => window.id),
      [userWindow],
    );
  });

  test("the approval prompt for a session's first page opens in its new window", {
    timeout: 120_000,
  }, async () => {
    const asking = await connected();
    try {
      const opening = harness.ok(asking, "tab_open", { url: other.url("/a") });
      opening.catch(() => {});
      const prompt = await harness.promptContext();
      // The tab shows the prompt's URL for a moment before its page has `browser`.
      await harness.waitForArmed(prompt);
      const promptTab = Number(
        await firefox.evaluate(prompt, "browser.tabs.getCurrent().then((tab) => tab.id)"),
      );
      const window = await windowOf(promptTab);
      assert.notEqual(window.id, userWindow);
      await firefox.click(prompt, 'button[data-answer="once"]');
      const tab = tabOf(await opening);
      assert.equal(tab.id, promptTab);
      assert.equal(tab.url, other.url("/a"));
      assert.equal(tab.title, TITLES.a);
      assert.equal((await windowOf(tab.id)).id, window.id);
    } finally {
      await asking.close();
    }
    await closeOtherWindows();
  });

  test("a prompt in the session's window behind the user's brings that window to the front", {
    timeout: 120_000,
  }, async () => {
    await promptBringsWindowToFront("/a?front", false);
  });

  test("a prompt in the session's minimized window brings that window to the front", {
    timeout: 120_000,
  }, async () => {
    await promptBringsWindowToFront("/a?front-minimized", true);
  });

  test("the session's window stays when the session ends with a page in it", async () => {
    const reading = await connected();
    let kept = -1;
    try {
      const tab = tabOf(await harness.ok(reading, "tab_open", { url: fixtures.url("/a?kept") }));
      kept = (await windowOf(tab.id)).id;
    } finally {
      await reading.close();
    }
    // Session ends are decided one at a time, in order: once a later session's blank window has
    // closed, this one's end has been decided.
    const later = await connected();
    const marker = tabOf(await harness.ok(later, "tab_open"));
    const markerWindow = (await windowOf(marker.id)).id;
    await later.close();
    await pollUntil(
      async () =>
        (await windows()).some((window) => window.id === markerWindow) ? undefined : true,
      PAGE_TIMEOUT_MS,
      "the later session's window to close",
    );
    await sleep(SESSION_END_MS);
    assert.ok((await windows()).some((window) => window.id === kept));
    await closeWindow(kept);
  });

  async function connected(): Promise<Session> {
    const connection = await harness.connect();
    await harness.waitUntilReady(connection);
    return connection;
  }

  /**
   * Opens an allowed page in a new session's window, focuses the user's window (and minimizes the
   * session's), then has the session ask for a site not yet approved.
   */
  async function promptBringsWindowToFront(query: string, minimized: boolean): Promise<void> {
    await run("browser.storage.local.set({ sessionWindow: true })");
    const asking = await connected();
    try {
      const page = tabOf(await harness.ok(asking, "tab_open", { url: fixtures.url(query) }));
      const own = (await windowOf(page.id)).id;
      assert.notEqual(own, userWindow);
      await run(`browser.windows.update(${userWindow}, { focused: true })`);
      await pollUntil(
        async () => ((await focusedWindow()) === userWindow ? true : undefined),
        PAGE_TIMEOUT_MS,
        "the user's window to be focused",
      );
      if (minimized) {
        await run(`browser.windows.update(${own}, { state: "minimized" })`);
        await pollUntil(
          async () => ((await windowState(own)) === "minimized" ? true : undefined),
          PAGE_TIMEOUT_MS,
          "the session's window to be minimized",
        );
      }
      const opening = harness.ok(asking, "tab_open", { url: other.url("/a") });
      opening.catch(() => {});
      const prompt = await harness.promptContext();
      // Before anything that selects the prompt's tab over WebDriver, which focuses its window.
      await pollUntil(
        async () => ((await focusedWindow()) === own ? true : undefined),
        PAGE_TIMEOUT_MS,
        "the session's window to be focused",
      );
      if (minimized) {
        await pollUntil(
          async () => ((await windowState(own)) === "normal" ? true : undefined),
          PAGE_TIMEOUT_MS,
          "the session's window to be restored",
        );
      }
      // The tab shows the prompt's URL for a moment before its page has `browser`.
      await harness.waitForArmed(prompt);
      const promptTab = Number(
        await firefox.evaluate(prompt, "browser.tabs.getCurrent().then((tab) => tab.id)"),
      );
      assert.equal((await windowOf(promptTab)).id, own);
      await firefox.click(prompt, 'button[data-answer="once"]');
      assert.equal(tabOf(await opening).id, promptTab);
    } finally {
      await asking.close();
    }
    await closeOtherWindows();
  }

  async function useTools(tabId: number): Promise<void> {
    const shot = await harness.call(session, "screenshot", { tabId });
    assert.equal(shot.isError, false, shot.text);
    assert.equal(shot.images.length, 1);
    await harness.ok(session, "click", { tabId, x: 20, y: 20 });
    await harness.ok(session, "navigate", { tabId, action: "reload" });
    const shown = tabOf(await harness.ok(session, "wait_for", { tabId, text: WAIT_LATE_TEXT }));
    assert.equal(shown.id, tabId);
  }

  async function waitForStored(on: boolean): Promise<void> {
    await pollUntil(
      async () => {
        const stored = await firefox.evaluate(
          settings,
          'browser.storage.local.get(null).then((items) => Object.hasOwn(items, "sessionWindow") ? items.sessionWindow === true : "absent")',
        );
        return stored === (on ? true : "absent") ? true : undefined;
      },
      PAGE_TIMEOUT_MS,
      `the setting to be stored ${on ? "on" : "off"}`,
    );
  }

  async function waitForStatus(text: string): Promise<void> {
    await pollUntil(
      async () =>
        (await firefox.evaluate(settings, `document.querySelector("${STATUS}").textContent`)) ===
        text
          ? true
          : undefined,
      PAGE_TIMEOUT_MS,
      `the status "${text}"`,
    );
  }

  /** Runs a promise-returning expression in the settings page. */
  async function run(expression: string): Promise<void> {
    await firefox.evaluate(settings, `${expression}.then(() => true)`);
  }

  async function windows(): Promise<WindowState[]> {
    const text = await firefox.evaluate(
      settings,
      `browser.windows.getAll({ populate: true, windowTypes: ["normal"] }).then((all) =>
        JSON.stringify(all.map((window) => ({
          id: window.id,
          tabs: window.tabs.map((tab) => ({ id: tab.id, active: tab.active, groupId: tab.groupId })),
        }))))`,
    );
    return JSON.parse(String(text)) as WindowState[];
  }

  async function focusedWindow(): Promise<number> {
    return Number(
      await firefox.evaluate(
        settings,
        "browser.windows.getLastFocused().then((window) => window.id)",
      ),
    );
  }

  async function windowState(windowId: number): Promise<string> {
    return String(
      await firefox.evaluate(
        settings,
        `browser.windows.get(${windowId}).then((window) => window.state)`,
      ),
    );
  }

  function windowOf(tabId: number): Promise<WindowState> {
    return pollUntil(
      async () => (await windows()).find((window) => window.tabs.some((tab) => tab.id === tabId)),
      PAGE_TIMEOUT_MS,
      `the window of tab ${tabId}`,
    );
  }

  async function windowById(windowId: number): Promise<WindowState> {
    const window = (await windows()).find((found) => found.id === windowId);
    assert.ok(window !== undefined, `no window ${windowId}`);
    return window;
  }

  function activeTab(window: WindowState): number | undefined {
    return window.tabs.find((tab) => tab.active)?.id;
  }

  async function closeWindow(windowId: number): Promise<void> {
    await run(`browser.windows.remove(${windowId})`);
  }

  async function closeOtherWindows(): Promise<void> {
    for (const window of await windows()) {
      if (window.id !== userWindow) await closeWindow(window.id);
    }
  }
});
