import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  AUTOFILL_LOGIN,
  type FixtureServer,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  untrustedContent,
} from "./harness.ts";

const REFS = /\[[a-z]{1,7}[1-9][0-9]*\]/g;
const AUTOFILLED = 'document.getElementById("login-name").matches(":autofill")';
// The login name field's value only as a category, so no assertion message holds the login.
// sinceLoad is in the page's clock, null until the load event has finished.
const FIELD_STATE = `(() => {
  const loginName = document.getElementById("login-name");
  const value = loginName.value === "" ? "empty"
    : loginName.value === ${JSON.stringify(AUTOFILL_LOGIN.username)} ? "login" : "other";
  const nav = performance.getEntriesByType("navigation")[0];
  const sinceLoad = nav === undefined || nav.loadEventEnd === 0 ? null
    : Math.round(Date.now() - (performance.timeOrigin + nav.loadEventEnd));
  return JSON.stringify({ value, autofill: loginName.matches(":autofill"), sinceLoad });
})()`;
// The field can change after the load in either direction: the session store puts the value
// back unmarked, Firefox fills the saved login in again marked. The latest change measured
// after a restart came 120 ms after the load, and ADR 0025 measured an unloaded tab's restore
// at about a second, so the field is read only once the page has been loaded this long.
const SETTLE_MS = 3_000;
const CASE_TIMEOUT_MS = 180_000;

type Label = "kept" | "removed";
type Outcome = "protected" | "shown";

interface FieldState {
  value: "empty" | "login" | "other";
  autofill: boolean;
  sinceLoad: number | null;
}

interface TabState {
  id: number;
  url: string;
  groupId: number;
}

/** How far a case got, for its cleanup. */
interface Progress {
  restartAttempted: boolean;
  restarted: boolean;
  /** The settings page's tab, once the case opened it. */
  settings?: string;
}

interface Read {
  tree: string;
  texts: string[];
}

// A login field Firefox filled, in a tab Firefox restores when it starts again. Each test
// restarts Firefox on the same profile.
describe("a login field Firefox restores after a restart, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST, { restoreSession: true });
      await approveSite();
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

  test("stays protected while the login is still saved", { timeout: CASE_TIMEOUT_MS }, () =>
    // ADR 0025: Firefox fills the saved login in again, marked, in both restored tabs.
    restoreCase("kept", "protected"),
  );

  test(
    "shows its value unmarked when the login was removed before the restart",
    { timeout: CASE_TIMEOUT_MS },
    () =>
      // Accepted in ADR 0025: Firefox's session store puts the value back without the mark.
      restoreCase("removed", "shown"),
  );

  /**
   * Runs one case, then closes the settings tab and removes the saved login on a Firefox that
   * runs: after a failed restart the old one is quit and the new one may lack the extension. A
   * cleanup failure never hides the case's own.
   */
  async function restoreCase(label: Label, outcome: Outcome): Promise<void> {
    const progress: Progress = { restartAttempted: false, restarted: false };
    let failure: { error: unknown } | undefined;
    try {
      await restartAndRead(label, outcome, progress);
    } catch (error: unknown) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    if (progress.settings !== undefined) {
      await firefox
        .closeContext(progress.settings)
        .catch((error: unknown) => cleanupErrors.push(error));
    }
    if (!progress.restartAttempted || progress.restarted) {
      await firefox.removeLogins().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (failure !== undefined) throw failure.error;
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }

  async function restartAndRead(label: Label, outcome: Outcome, progress: Progress): Promise<void> {
    const backPath = `/autofill?${label}-back`;
    const frontPath = `/autofill?${label}-front`;
    await firefox.saveLogin(fixtures.site, AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password);
    // tab_open makes the tab active: login autofill waits for a visible document. The front
    // tab is the selected one when Firefox quits, so Firefox loads it again at startup; the
    // back tab loads only when it is selected.
    const backBefore = await open(backPath, TITLES.autofill);
    await waitForFill(fixtures.url(backPath));
    const frontBefore = await open(frontPath, TITLES.autofill);
    await waitForFill(fixtures.url(frontPath));
    for (const tabId of [backBefore, frontBefore]) {
      assertReadAs(await read(tabId), "protected");
    }
    // With no saved login, no new fill can hide what the session store restores.
    if (label === "removed") await firefox.removeLogins();
    // Its host goes away with Firefox; closed first, it cannot reconnect to the new one.
    await session.close();

    progress.restartAttempted = true;
    firefox = await harness.restartFirefox(EXTENSION_DIST, { restoreSession: true });
    progress.restarted = true;
    await approveSite();
    session = await harness.connect();
    await harness.waitUntilReady(session);
    const settings = await harness.settingsPage();
    progress.settings = settings;
    assert.equal(
      await firefox.savedLogins(),
      label === "kept" ? 1 : 0,
      "saved logins after the restart",
    );

    const frontUrl = fixtures.url(frontPath);
    if (!(await firefox.contexts()).some((context) => context.url === frontUrl)) {
      assert.fail(`Firefox did not restore ${frontUrl}: ${await restoredTabs(settings)}`);
    }
    assertField(frontUrl, await settled(frontUrl), outcome);

    const backUrl = fixtures.url(backPath);
    const back = (await queryTabs(settings)).find((tab) => tab.url === backUrl);
    if (back === undefined) {
      assert.fail(`Firefox did not restore ${backUrl}: ${await restoredTabs(settings)}`);
    }
    const opened = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url(`/a?${label}-new`) }),
    );
    const group = (await queryTabs(settings)).find((tab) => tab.id === opened.id)?.groupId;
    assert.ok(group !== undefined && group !== -1, "the new session's tab is in no group");
    // As a user moving the tab into the session's group would.
    assert.equal(
      await firefox.evaluate(
        settings,
        `browser.tabs.group({ groupId: ${group}, tabIds: [${back.id}] }).then(() => true)`,
      ),
      true,
    );
    await harness.ok(session, "tab_select", { tabId: back.id });
    assertField(backUrl, await settled(backUrl), outcome);
    assertReadAs(await read(back.id), outcome);

    if (label === "kept") {
      // Firefox still fills the saved login after the restart, so this case is not one
      // without a login.
      await open(`/autofill?${label}-check`, TITLES.autofill);
      await waitForFill(fixtures.url(`/autofill?${label}-check`));
    }
  }

  async function approveSite(): Promise<void> {
    await harness.seedSettings({
      [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
    });
  }

  async function open(path: string, title: string): Promise<number> {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url(path) }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    return tab.id;
  }

  async function contextOf(url: string): Promise<string> {
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    return found.context;
  }

  /** The context of the tab showing `url`, once Firefox has filled in its login name field. */
  function waitForFill(url: string): Promise<string> {
    return pollUntil(
      async () => {
        const context = await contextOf(url);
        return (await firefox.evaluate(context, AUTOFILLED)) === true ? context : undefined;
      },
      PAGE_TIMEOUT_MS,
      `Firefox to fill the saved login into ${url}`,
    );
  }

  async function read(tabId: number): Promise<Read> {
    const result = await harness.call(session, "read_page", { tabId });
    assert.equal(result.isError, false, result.text);
    const tree = untrustedContent(result.text);
    assert.ok(tree !== undefined, `not one untrusted frame:\n${result.text}`);
    return { tree, texts: result.texts };
  }

  /** Every tab's URL, as BiDi and as tabs.query see them, for a tab Firefox did not restore. */
  async function restoredTabs(settings: string): Promise<string> {
    const contexts = (await firefox.contexts()).map(({ url }) => url);
    return `the contexts show ${JSON.stringify(contexts)}; tabs.query lists ${JSON.stringify(
      await queryTabs(settings),
    )}`;
  }

  /**
   * The login name field's state in the tab showing `url` once the page has been loaded for
   * SETTLE_MS. The tab's context is looked up each time, since a restore can replace it.
   */
  function settled(url: string): Promise<FieldState> {
    return pollUntil(
      async () => {
        const state = await fieldState(await contextOf(url));
        return state.sinceLoad !== null && state.sinceLoad >= SETTLE_MS ? state : undefined;
      },
      PAGE_TIMEOUT_MS + SETTLE_MS,
      `${url} to be loaded for ${SETTLE_MS} ms`,
    );
  }

  async function fieldState(context: string): Promise<FieldState> {
    const json = await firefox.evaluate(context, FIELD_STATE);
    assert.equal(typeof json, "string", `the field state is ${String(json)}`);
    const state: unknown = JSON.parse(String(json));
    assert.ok(
      isRecord(state) &&
        (state.value === "empty" || state.value === "login" || state.value === "other") &&
        typeof state.autofill === "boolean" &&
        (state.sinceLoad === null || typeof state.sinceLoad === "number"),
      `unexpected field state ${String(json)}`,
    );
    return { value: state.value, autofill: state.autofill, sinceLoad: state.sinceLoad };
  }

  async function queryTabs(settings: string): Promise<TabState[]> {
    const json = await firefox.evaluate(
      settings,
      "browser.tabs.query({}).then((tabs) => JSON.stringify(tabs.map(({ id, url, groupId }) => ({ id, url, groupId }))))",
    );
    assert.equal(typeof json, "string", `tabs.query returned ${String(json)}`);
    const tabs: unknown = JSON.parse(String(json));
    assert.ok(Array.isArray(tabs), `tabs.query returned ${String(json)}`);
    return tabs.map((tab: unknown) => {
      assert.ok(
        isRecord(tab) &&
          typeof tab.id === "number" &&
          typeof tab.url === "string" &&
          typeof tab.groupId === "number",
        `unexpected tab ${JSON.stringify(tab)}`,
      );
      return { id: tab.id, url: tab.url, groupId: tab.groupId };
    });
  }
});

/** Asserts the field holds the login, marked as autofilled when `outcome` is protected. */
function assertField(url: string, state: FieldState, outcome: Outcome): void {
  assert.ok(
    state.value === "login" && state.autofill === (outcome === "protected"),
    `${url}: expected the login name field ${outcome}, found ${JSON.stringify(state)}`,
  );
}

/** Asserts the read shows the login name field as `outcome`, and never the password. */
function assertReadAs({ tree, texts }: Read, outcome: Outcome): void {
  if (outcome === "protected") {
    assertLines(tree, ['textbox "Login name" [*] protected filled']);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password]);
  } else {
    assertLines(tree, [`textbox "Login name" [*] value="${AUTOFILL_LOGIN.username}"`]);
    assertNoSecrets(texts, [AUTOFILL_LOGIN.password]);
  }
}

/** Asserts each expected line, `[*]` standing for a ref, is a whole line of the tree. */
function assertLines(tree: string, expected: string[]): void {
  const found = tree.replace(REFS, "[*]").split("\n");
  for (const line of expected) {
    assert.ok(found.includes(line), `no line ${JSON.stringify(line)} in:\n${tree}`);
  }
}

function assertNoSecrets(texts: string[], secrets: string[]): void {
  for (const secret of secrets) {
    for (const text of texts) assert.equal(text.includes(secret), false, `${secret} in:\n${text}`);
  }
}
