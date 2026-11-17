import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MAX_TAB_TITLE, MAX_TAB_URL } from "@foxleash/protocol";
import { pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  LONG_ADDRESS_CHAR,
  LONG_ADDRESS_CHARS,
  LONG_TITLE_CHAR,
  startFixtureServer,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

const LONG_TITLE_SHOWN = `${LONG_TITLE_CHAR.repeat(MAX_TAB_TITLE)}…`;
// Over pollUntil's 60 s plus one call's 45 s, so a failing run reports its last error.
const TEST_TIMEOUT_MS = 180_000;

// One Firefox for the file: the tests run in order and the last one lists both earlier tabs.
describe("a tab's long title and address in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let longAddressShown = "";
  let titleTabId = -1;
  let addressTabId = -1;

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
      const pushed = fixtures.url("/long-address?") + LONG_ADDRESS_CHAR.repeat(LONG_ADDRESS_CHARS);
      longAddressShown = `${pushed.slice(0, MAX_TAB_URL)}…`;
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

  test("tab_open and tabs_list cut a long title", { timeout: TEST_TIMEOUT_MS }, async () => {
    const opened = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/long-title") }),
    );
    assert.ok(opened.title.length <= MAX_TAB_TITLE + 1, `${opened.title.length} characters`);
    titleTabId = opened.id;
    const title = await pollUntil(
      async () => {
        const tabs = tabsOf(await harness.ok(session, "tabs_list"));
        const shown = tabs.find((tab) => tab.id === titleTabId)?.title;
        return shown === LONG_TITLE_SHOWN ? shown : undefined;
      },
      60_000,
      "tabs_list to show the cut title",
    );
    assert.equal(title, LONG_TITLE_SHOWN);
  });

  test("tab_open and tabs_list cut a long address", { timeout: TEST_TIMEOUT_MS }, async () => {
    const opened = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/long-address") }),
    );
    assert.ok(opened.url.length <= MAX_TAB_URL + 1, `${opened.url.length} characters`);
    addressTabId = opened.id;
    const unpushed = fixtures.url("/long-address");
    const url = await pollUntil(
      async () => {
        const tabs = tabsOf(await harness.ok(session, "tabs_list"));
        const shown = tabs.find((tab) => tab.id === addressTabId)?.url;
        return shown !== undefined && shown.length > unpushed.length ? shown : undefined;
      },
      60_000,
      "tabs_list to show the pushed address",
    );
    assert.equal(url, longAddressShown);
  });

  test("tabs_list stays small with both tabs open", { timeout: TEST_TIMEOUT_MS }, async () => {
    const result = await harness.call(session, "tabs_list");
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.length < 10_000, `${result.text.length} characters`);
    const tabs = tabsOf(parseResult(result.text));
    assert.equal(tabs.find((tab) => tab.id === titleTabId)?.title, LONG_TITLE_SHOWN);
    assert.equal(tabs.find((tab) => tab.id === addressTabId)?.url, longAddressShown);
  });
});
