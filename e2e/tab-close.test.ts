import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  type ToolResult,
  tabOf,
  tabsOf,
} from "./harness.ts";

describe("tab_close with a beforeunload prompt in real Firefox", () => {
  let harness: Harness;
  let firefox: Firefox;
  let fixtures: FixtureServer;
  let session: Session;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST, { holdBeforeUnloadPrompts: true });
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

  test("refuses a close the page asks to confirm, without holding other closes", async () => {
    const first = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/before-unload") }),
    );
    const second = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    // The startup tab: then the group's window holds exactly the two tabs.
    await firefox.closeContext(
      await firefox.waitForContext((context) => context.url === "about:blank", PAGE_TIMEOUT_MS),
    );
    // Another window, so closing the group's window cannot quit Firefox.
    await firefox.openWindow();
    const context = await firefox.waitForContext(
      (candidate) => candidate.url === fixtures.url("/before-unload"),
      PAGE_TIMEOUT_MS,
    );
    const prompt = await firefox.watchPrompt(context);

    const closing = watch(harness.refused(session, "tab_close", { tabId: first.id }));

    try {
      assert.equal(await prompt.opened(), "beforeunload");
    } catch (error: unknown) {
      throw new Error(`${String(error)}; tab_close on the first tab is ${closing.state()}`, {
        cause: error,
      });
    }

    // Answered while the prompt is open: the first close does not hold the second.
    assert.match(
      await harness.refused(session, "tab_close", { tabId: second.id }),
      /is the last tab in its window/,
    );
    assert.equal(closing.state(), "pending");
    assert.match(await closing.call, /asked the user to confirm leaving it/);
    // Asked again while its prompt is open, Firefox would close the tab without the user's answer.
    assert.match(
      await harness.refused(session, "tab_close", { tabId: first.id }),
      /asked the user to confirm leaving it/,
    );

    const shown = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.ok(shown.includes(first.id), `tabs_list lists ${JSON.stringify(shown)}`);

    // Another session's close and session end, still while the prompt is open.
    const other = await harness.connect();
    const page = tabOf(await harness.ok(other, "tab_open", { url: fixtures.url("/b") }));
    const blank = tabOf(await harness.ok(other, "tab_open"));
    const left = tabsOf(await harness.ok(other, "tab_close", { tabId: page.id }));
    assert.deepEqual(
      left.map((tab) => tab.id),
      [blank.id],
    );
    await other.close();
    await pollUntil(
      async () => {
        const text = await harness.refused(session, "navigate", {
          tabId: blank.id,
          action: "reload",
        });
        if (text.includes("does not exist")) return true;
        throw new Error(text);
      },
      PAGE_TIMEOUT_MS,
      `tab ${blank.id} to close with its session`,
    );

    await prompt.answer(true);

    await pollUntil(
      async () => {
        const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
        if (ids.length === 1 && ids[0] === second.id) return true;
        throw new Error(`tabs_list lists ${JSON.stringify(ids)}`);
      },
      PAGE_TIMEOUT_MS,
      `tabs_list to list only tab ${second.id}`,
    );
  });

  test("closing a window's two tabs at once without a prompt closes one and keeps the other", async () => {
    const c = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/a") }));
    const d = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/b") }));
    for (const tab of tabsOf(await harness.ok(session, "tabs_list"))) {
      if (tab.id !== c.id && tab.id !== d.id) {
        await harness.ok(session, "tab_close", { tabId: tab.id });
      }
    }

    const results = await Promise.all([
      harness.call(session, "tab_close", { tabId: c.id }),
      harness.call(session, "tab_close", { tabId: d.id }),
    ]);
    const refusals = results.filter((result) => result.isError);
    assert.equal(refusals.length, 1, JSON.stringify(results));
    assert.match(refusals[0]?.text ?? "", /is the last tab in its window/);

    const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.equal(ids.length, 1, `tabs_list lists ${JSON.stringify(ids)}`);
    assert.ok(ids[0] === c.id || ids[0] === d.id, `tabs_list lists ${JSON.stringify(ids)}`);
  });

  // Last: it leaves a tab with a beforeunload handler open.
  test("refuses a close when the user chooses to stay on the page, and closes the window's other tab", async () => {
    const left = tabsOf(await harness.ok(session, "tabs_list"));
    assert.equal(left.length, 1, `tabs_list lists ${JSON.stringify(left)}`);
    const kept = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/before-unload") }),
    );
    const context = await firefox.waitForContext(
      (candidate) => candidate.url === fixtures.url("/before-unload"),
      PAGE_TIMEOUT_MS,
    );
    const prompt = await firefox.watchPrompt(context);

    const closing = watch(harness.refused(session, "tab_close", { tabId: kept.id }));
    try {
      assert.equal(await prompt.opened(), "beforeunload");
    } catch (error: unknown) {
      throw new Error(`${String(error)}; tab_close is ${closing.state()}`, { cause: error });
    }
    await prompt.answer(false);

    assert.match(await closing.call, /the user chose to stay/);
    await harness.ok(session, "tab_close", { tabId: left[0]?.id });
    const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.deepEqual(ids, [kept.id]);
  });
});

// The extension's load wait would fail only after 30 s.
const SIGN_IN_ANSWER_MS = 10_000;

describe("leave prompts beside an open question in real Firefox", () => {
  let harness: Harness;
  let firefox: Firefox;
  let allowed: FixtureServer;
  let asked: FixtureServer;
  let session: Session;
  let question: number | undefined;
  let asking: { call: Promise<ToolResult>; state(): string } | undefined;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      allowed = await startFixtureServer();
      asked = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST, { holdBeforeUnloadPrompts: true });
      await harness.seedSettings({
        [`site:${allowed.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
      // The site prompt stays open after this call stops waiting for its answer.
      asking = watch(harness.call(session, "tab_open", { url: asked.url("/a"), view: false }));
      question = await pollUntil(
        async () => {
          const tabs = tabsOf(await harness.ok(session, "tabs_list"));
          const shown = tabs.find((tab) => tab.active);
          if (shown !== undefined) return shown.id;
          throw new Error(`tabs_list lists ${JSON.stringify(tabs)}`);
        },
        PAGE_TIMEOUT_MS,
        "the question's tab to be selected",
      );
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        if (question !== undefined) await firefox.closeContext(await harness.promptContext());
        await asking?.call;
      } finally {
        try {
          await harness?.close();
        } finally {
          await Promise.all([allowed?.close(), asked?.close()]);
        }
      }
    },
    { timeout: 60_000 },
  );

  // The control for the tests after it: without a leave prompt, the same calls select no tab.
  test("tab_close and navigate of a page that does not ask leave the open question's tab selected", async () => {
    const page = await openBeside("/a?case=control");
    const calls: [string, Record<string, unknown>][] = [
      ["navigate", { tabId: page.tabId, url: allowed.url("/b?case=control"), view: false }],
      ["navigate", { tabId: page.tabId, action: "reload", view: false }],
      ["navigate", { tabId: page.tabId, action: "back", view: false }],
      ["navigate", { tabId: page.tabId, action: "forward", view: false }],
      ["tab_close", { tabId: page.tabId }],
    ];
    for (const [name, args] of calls) {
      await harness.ok(session, name, args);
      assert.deepEqual(
        await selected(),
        [question],
        `selected after ${name} ${JSON.stringify(args)}`,
      );
    }
  });

  test("Firefox selects a tab to ask whether to leave its page on tab_close, also beside an open question", async () => {
    const page = await openBeside("/before-unload?case=close");
    // The close may answer either way: it stops waiting for the user after a few seconds.
    const { whileAsked } = await leaveWhileSelected(page, () =>
      harness.call(session, "tab_close", { tabId: page.tabId }),
    );
    assert.deepEqual(whileAsked, [page.tabId], "selected while the leave prompt is open");
    await pollUntil(
      async () => {
        const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
        if (!ids.includes(page.tabId)) return true;
        throw new Error(`tabs_list lists ${JSON.stringify(ids)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${page.tabId} to close`,
    );
  });

  test("Firefox selects a tab to ask whether to leave its page on navigate to a URL, also beside an open question, and keeps it selected after", async () => {
    const page = await openBeside("/before-unload?case=url");
    const url = allowed.url("/a?case=url");
    const { whileAsked, result } = await leaveWhileSelected(page, () =>
      harness.call(session, "navigate", { tabId: page.tabId, url, view: false }),
    );
    assert.deepEqual(whileAsked, [page.tabId], "selected while the leave prompt is open");
    assert.equal(result.isError, false, result.text);
    assert.equal(tabOf(parseResult(result.text)).url, url);
    assert.deepEqual(await selected(), [page.tabId], "selected after the user left the page");
  });

  test("Firefox selects a tab to ask whether to leave its page on a reload, also beside an open question, and keeps it selected after", async () => {
    const page = await openBeside("/before-unload?case=reload");
    const loads = allowed.hits("/before-unload");
    const { whileAsked, result } = await leaveWhileSelected(page, () =>
      harness.call(session, "navigate", { tabId: page.tabId, action: "reload", view: false }),
    );
    assert.deepEqual(whileAsked, [page.tabId], "selected while the leave prompt is open");
    assert.equal(result.isError, false, result.text);
    // The reload's request, which Firefox sends only once the user has left the page.
    await pollUntil(
      async () => (allowed.hits("/before-unload") > loads ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the reload to reach the server",
    );
    assert.deepEqual(await selected(), [page.tabId], "selected after the user left the page");
  });

  test("Firefox selects a tab to ask whether to leave its page on going back, also beside an open question, and keeps it selected after", async () => {
    const page = await openBeside("/a?case=back");
    await harness.ok(session, "navigate", {
      tabId: page.tabId,
      url: allowed.url("/before-unload?case=back"),
      view: false,
    });
    await showQuestion();
    const { whileAsked, result } = await leaveWhileSelected(page, () =>
      harness.call(session, "navigate", { tabId: page.tabId, action: "back", view: false }),
    );
    assert.deepEqual(whileAsked, [page.tabId], "selected while the leave prompt is open");
    assert.equal(result.isError, false, result.text);
    await waitForUrl(page.tabId, allowed.url("/a?case=back"));
    assert.deepEqual(await selected(), [page.tabId], "selected after the user left the page");
  });

  test("Firefox selects a tab to ask whether to leave its page on going forward, also beside an open question, and keeps it selected after", async () => {
    const page = await openBeside("/before-unload?case=forward");
    const left = await leaveWhileSelected(page, () =>
      harness.call(session, "navigate", {
        tabId: page.tabId,
        url: allowed.url("/a?case=forward"),
        view: false,
      }),
    );
    assert.equal(left.result.isError, false, left.result.text);
    // After the step Foxleash loads the page's address again, and this Firefox lets the page
    // ask to confirm leaving that load without a click on the page.
    const again = await firefox.watchPrompt(page.context);
    const back = watch(
      harness.call(session, "navigate", { tabId: page.tabId, action: "back", view: false }),
    );
    const asks = await Promise.race([
      again.opened().then(
        () => true,
        () => false,
      ),
      back.call.then(() => false),
    ]);
    if (asks) await again.answer(true);
    const backed = await back.call;
    assert.equal(backed.isError, false, backed.text);
    await waitForUrl(page.tabId, allowed.url("/before-unload?case=forward"));
    await showQuestion();
    const { whileAsked } = await leaveWhileSelected(page, () =>
      harness.call(session, "navigate", { tabId: page.tabId, action: "forward", view: false }),
    );
    assert.deepEqual(whileAsked, [page.tabId], "selected while the leave prompt is open");
    await waitForUrl(page.tabId, allowed.url("/a?case=forward"));
    assert.deepEqual(await selected(), [page.tabId], "selected after the user left the page");
  });

  test("tab_open of a 401 page without a sign-in challenge loads it, also beside an open question", async () => {
    await showQuestion();
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: allowed.url("/sign-in-none"), view: false }),
    );
    assert.equal(tab.active, false, "the tab opened beside the question is not selected");
    assert.deepEqual(await selected(), [question], "the question's tab is still selected");
    await harness.ok(session, "tab_close", { tabId: tab.id });
    await showQuestion();
  });

  test("Firefox selects a tab tab_open opens to show its sign-in dialog, also beside an open question, and tab_open answers within seconds", async () => {
    await showQuestion();
    const started = Date.now();
    const text = await harness.refused(session, "tab_open", {
      url: allowed.url("/sign-in"),
      view: false,
    });
    const elapsed = Date.now() - started;
    const match = /Tab (\d+) waits for the user to answer Firefox's sign-in dialog/.exec(text);
    assert.ok(match !== null, text);
    const tabId = Number(match[1]);
    assert.ok(elapsed < SIGN_IN_ANSWER_MS, `tab_open answered after ${elapsed} ms`);
    // Firefox's own select, to show its dialog (ADR 0057): a Firefox that stops making it fails
    // here when the pinned version moves.
    await pollUntil(
      async () => {
        const shown = await selected();
        if (shown.length === 1 && shown[0] === tabId) return true;
        throw new Error(`selected: ${JSON.stringify(shown)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${tabId} to be selected for the sign-in dialog`,
    );
    assert.match(
      await harness.refused(session, "tab_select", { tabId }),
      new RegExp(`waiting for the user to answer in tab ${question} `),
    );
    const ids = tabsOf(await harness.ok(session, "tabs_list")).map((tab) => tab.id);
    assert.ok(ids.includes(tabId), `tabs_list lists ${JSON.stringify(ids)}`);
    await harness.ok(session, "tab_close", { tabId });
    await showQuestion();
  });

  /** The ids of the session's selected tabs; all of them are in its group's window. */
  async function selected(): Promise<number[]> {
    return tabsOf(await harness.ok(session, "tabs_list"))
      .filter((tab) => tab.active)
      .map((tab) => tab.id);
  }

  async function showQuestion(): Promise<void> {
    await harness.ok(session, "tab_select", { tabId: question });
    assert.deepEqual(await selected(), [question], "the question's tab is selected");
  }

  /** A tab opened on the allowed site beside the selected question, with its BiDi context. */
  async function openBeside(path: string): Promise<{ tabId: number; context: string }> {
    await showQuestion();
    const url = allowed.url(path);
    const tab = tabOf(await harness.ok(session, "tab_open", { url, view: false }));
    // Only while a question is open does Foxleash leave the tab it opens unselected.
    assert.equal(tab.active, false, "the tab opened beside the question is not selected");
    const context = await firefox.waitForContext(
      (candidate) => candidate.url === url,
      PAGE_TIMEOUT_MS,
    );
    return { tabId: tab.id, context };
  }

  /**
   * Makes the call, reads which tabs are selected while the page's leave prompt is open, then
   * leaves the page: staying after a tab_close would leave the tab counted as still being
   * removed, which refuses later closes in its window.
   */
  async function leaveWhileSelected(
    page: { tabId: number; context: string },
    call: () => Promise<ToolResult>,
  ): Promise<{ whileAsked: number[]; result: ToolResult }> {
    // Selecting the question's own tab is never refused, so this proves the question is open.
    assert.match(
      await harness.refused(session, "tab_select", { tabId: page.tabId }),
      new RegExp(`waiting for the user to answer in tab ${question} `),
    );
    assert.deepEqual(
      await selected(),
      [question],
      "the question's tab is selected before the call",
    );
    const prompt = await firefox.watchPrompt(page.context);
    const running = watch(call());
    try {
      assert.equal(await prompt.opened(), "beforeunload");
    } catch (error: unknown) {
      throw new Error(`${String(error)}; the call is ${running.state()}`, { cause: error });
    }
    const whileAsked = await selected();
    await prompt.answer(true);
    return { whileAsked, result: await running.call };
  }

  async function waitForUrl(tabId: number, url: string): Promise<void> {
    await pollUntil(
      async () => {
        const tabs = tabsOf(await harness.ok(session, "tabs_list"));
        if (tabs.some((tab) => tab.id === tabId && tab.url === url)) return true;
        throw new Error(`tabs_list lists ${JSON.stringify(tabs)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${tabId} to show ${url}`,
    );
  }
});

/** The call, and how it has settled so far, for a failure message. */
function watch<T>(call: Promise<T>): { call: Promise<T>; state(): string } {
  let state = "pending";
  call.then(
    (value) => {
      state = `fulfilled with ${JSON.stringify(value)}`;
    },
    (reason: unknown) => {
      state = `rejected with ${String(reason)}`;
    },
  );
  return { call, state: () => state };
}
