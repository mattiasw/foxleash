import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  RECORDING_TOKEN,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import { createHarness, EXTENSION_DIST, type Harness, type Session, tabOf } from "./harness.ts";

const RUN_PAGE = "run.html";
const ALLOW = 'button[data-answer="allow"]';
const TYPED = { first: "Ada", last: "Lovelace", notes: "typed before the agent came" } as const;
const FIELDS = `JSON.stringify({
  first: document.getElementById("first").value,
  last: document.getElementById("last").value,
  notes: document.getElementById("notes").value,
})`;

interface Recorded {
  recording: boolean;
  since?: number;
  /** The texts of the messages, or the URLs of the requests. */
  items: string[];
}

// One Firefox for the file: the tests run in order and build on each other's tab. The fixture
// site is not seeded as approved, so the page loads before the session may act on it.
describe("recording a page already open when access to it begins, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let settings: string;
  let page: string;
  let tabId = -1;
  let origin = 0;
  let logged = 0;
  let fetched = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      session = await harness.connect();
      await harness.waitUntilReady(session);
      settings = await harness.settingsPage();
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

  test("starts recording at the move into the group, without a reload, and keeps the form", async () => {
    // The agent's group, with a blank tab in it.
    const agent = tabOf(await harness.ok(session, "tab_open"));
    page = await firefox.openContext(fixtures.url("/recording-form"));
    assert.equal(await firefox.evaluate(page, "document.title"), TITLES.recordingForm);
    origin = Number(await firefox.evaluate(page, "performance.timeOrigin"));
    for (const [id, text] of Object.entries(TYPED)) {
      await firefox.click(page, `#${id}`);
      await firefox.keys(page, [...text]);
    }
    await logAndFetch();
    tabId = await userTabId();

    await approve();
    const before = Date.now();
    const groupId = await groupOf(agent.id);
    await firefox.evaluate(
      settings,
      `browser.tabs.group({ groupId: ${groupId}, tabIds: [${tabId}] }).then(() => true)`,
    );
    const consoleRead = await readUntil("read_console", (read) => read.recording);
    const networkRead = await readUntil("read_network", (read) => read.recording);
    for (const read of [consoleRead, networkRead]) {
      assert.ok(typeof read.since === "number" && read.since >= before, JSON.stringify(read));
    }

    await logAndFetch();
    await readUntil("read_console", (read) => read.items.includes(message(logged)));
    await readUntil("read_network", (read) => read.items.includes(request(fetched)));
    assert.equal(Number(await firefox.evaluate(page, "performance.timeOrigin")), origin);
    assert.deepEqual(JSON.parse(String(await firefox.evaluate(page, FIELDS))), TYPED);
  });

  test("returns nothing logged or requested before the approval", async () => {
    const consoleRead = await readTool("read_console");
    const networkRead = await readTool("read_network");
    assert.deepEqual(consoleRead.items, [message(logged)]);
    assert.deepEqual(
      networkRead.items.filter((url) => url.startsWith(fixtures.url("/api/fetch"))),
      [request(fetched)],
    );
    assert.equal(listsPage(networkRead), false, JSON.stringify(networkRead));
  });

  test("returns nothing from a withdrawal's gap once the site is approved again", async (t) => {
    // A settings page reads the session answers when it loads, and `settings` loaded before the
    // approval, so the user opens it again.
    const answers = await harness.settingsPage();
    t.after(() => firefox.closeContext(answers));
    const row = `Forget ${fixtures.site}: allowed this session`;
    await pollUntil(
      async () =>
        (await firefox.evaluate(
          answers,
          `document.querySelector('button[aria-label^="${row}"]') !== null`,
        )) === true
          ? true
          : undefined,
      PAGE_TIMEOUT_MS,
      "the settings page to list the approval",
    );
    await firefox.click(answers, `button[aria-label^="${row}"]`);
    await pollUntil(
      async () => {
        const called = await harness.call(session, "read_console", { tabId });
        const refusal = `Foxleash is not allowed on ${fixtures.site} in this session`;
        return called.isError && called.text.includes(refusal) ? true : undefined;
      },
      PAGE_TIMEOUT_MS,
      "read_console to refuse the withdrawn site",
    );
    const gap = { logged: logged + 1, fetched: fetched + 1 };
    await logAndFetch();
    // The gap's request has ended before the site is approved again.
    await pollUntil(
      async () => (fixtures.hits("/api/fetch") >= fetched ? true : undefined),
      PAGE_TIMEOUT_MS,
      "the gap's fetch to reach the server",
    );

    const before = Date.now();
    await approve();
    const consoleRead = await readUntil("read_console", (read) => read.recording);
    const networkRead = await readUntil("read_network", (read) => read.recording);
    for (const read of [consoleRead, networkRead]) {
      assert.ok(typeof read.since === "number" && read.since >= before, JSON.stringify(read));
    }
    await logAndFetch();
    const messages = await readUntil("read_console", (read) =>
      read.items.includes(message(logged)),
    );
    const requests = await readUntil("read_network", (read) =>
      read.items.includes(request(fetched)),
    );
    assert.deepEqual(messages.items, [message(logged)]);
    assert.equal(messages.items.includes(message(gap.logged)), false);
    assert.equal(requests.items.includes(request(gap.fetched)), false);
    assert.deepEqual(
      requests.items.filter((url) => url.startsWith(fixtures.url("/api/fetch"))),
      [request(fetched)],
    );
    assert.equal(listsPage(requests), false, JSON.stringify(requests));
    assert.equal(Number(await firefox.evaluate(page, "performance.timeOrigin")), origin);
    assert.deepEqual(JSON.parse(String(await firefox.evaluate(page, FIELDS))), TYPED);
  });

  /** The user clicks the page's Log and Fetch buttons once each. */
  async function logAndFetch(): Promise<void> {
    await firefox.click(page, "#log");
    logged += 1;
    await firefox.click(page, "#fetch");
    fetched += 1;
  }

  function message(number: number): string {
    return `${RECORDING_TOKEN}-${number}`;
  }

  function request(number: number): string {
    return `${fixtures.url("/api/fetch")}?n=${number}`;
  }

  /** Whether the read lists the form page's own load, which came before the approval. */
  function listsPage(read: Recorded): boolean {
    return read.items.some((url) => url.startsWith(fixtures.url("/recording-form")));
  }

  /** The user approves the fixture site for the session through request_sites. */
  async function approve(): Promise<void> {
    const prefix = firefox.extensionUrl(RUN_PAGE);
    const existing = (await firefox.contexts())
      .filter((context) => context.url.startsWith(prefix))
      .map(({ context }) => context);
    const requesting = harness.call(session, "request_sites", { sites: [fixtures.site] });
    requesting.catch(() => undefined);
    const run = await harness.pageContext(RUN_PAGE, existing);
    await harness.waitForArmed(run, 2);
    await firefox.click(run, ALLOW);
    const result = await requesting;
    assert.equal(result.isError, false, result.text);
    await firefox.closeContext(run);
  }

  /** The id of the user's tab with the form, outside any group. */
  async function userTabId(): Promise<number> {
    const id = await firefox.evaluate(
      settings,
      `browser.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(fixtures.url("/recording-form"))} && tab.groupId === -1)?.id ?? null)`,
    );
    assert.equal(typeof id, "number", `no user tab with the form: ${String(id)}`);
    return Number(id);
  }

  async function groupOf(id: number): Promise<number> {
    const groupId = await firefox.evaluate(
      settings,
      `browser.tabs.get(${id}).then((tab) => tab.groupId)`,
    );
    assert.ok(typeof groupId === "number" && groupId !== -1, `tab ${id} is in no group`);
    return groupId;
  }

  async function readUntil(
    tool: "read_console" | "read_network",
    done: (read: Recorded) => boolean,
  ): Promise<Recorded> {
    let last: Recorded | undefined;
    return pollUntil(
      async () => {
        last = await readTool(tool);
        if (done(last)) return last;
        throw new Error(JSON.stringify(last));
      },
      PAGE_TIMEOUT_MS,
      `${tool} to answer as expected`,
    );
  }

  async function readTool(tool: "read_console" | "read_network"): Promise<Recorded> {
    const value = await harness.ok(session, tool, { tabId });
    assert.ok(isRecord(value) && typeof value.recording === "boolean", JSON.stringify(value));
    const list = tool === "read_console" ? value.messages : value.requests;
    assert.ok(Array.isArray(list), JSON.stringify(value));
    const items = list.map((item: unknown) => {
      assert.ok(isRecord(item), JSON.stringify(item));
      const field = tool === "read_console" ? item.text : item.url;
      assert.equal(typeof field, "string", JSON.stringify(item));
      return String(field);
    });
    const read: Recorded = { recording: value.recording, items };
    if (value.since !== undefined) {
      assert.equal(typeof value.since, "number", JSON.stringify(value));
      read.since = Number(value.since);
    }
    return read;
  }
});
