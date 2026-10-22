import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { NetworkHeader, NetworkRequest } from "@foxhand/protocol";
import {
  type FixtureServer,
  NETWORK_SECRETS,
  startFixtureServer,
  TITLES,
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

interface NetworkRead {
  recording: boolean;
  requests: NetworkRequest[];
  truncated: boolean;
  /** The tool's whole result text, frame included. */
  text: string;
}

const POLL_MS = 100;
const POLL_LIMIT_MS = 10_000;
const REDACTED = "[redacted]";

// One Firefox for the file, as in console.test.ts.
describe("read_network in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let session: Session;
  let networkTab: number;

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
      networkTab = tabOf(
        await harness.ok(session, "tab_open", { url: fixtures.url("/network") }),
      ).id;
      await waitForTitle(networkTab, TITLES.networkDone);
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

  test("lists the page's own request, its fetch, XHR and frame request", async () => {
    const read = await readUntil(networkTab, (requests) =>
      ["/api/fetch", "/api/xhr", "/api/frame"].every(
        (path) => requestTo(requests, path)?.status !== undefined,
      ),
    );
    assert.equal(read.recording, true);
    const [page] = read.requests;
    assert.equal(page?.url, fixtures.url("/network"), JSON.stringify(page));
    assert.equal(page?.type, "main_frame");
    assert.equal(page?.status, 200);
    for (const path of ["/api/fetch", "/api/xhr"]) {
      const request = requestTo(read.requests, path);
      assert.equal(request?.status, 200, path);
      assert.equal(request?.method, "GET", path);
      assert.equal(request?.type, "xmlhttprequest", path);
      assert.ok(typeof request?.durationMs === "number", path);
    }
    const fetched = requestTo(read.requests, "/api/fetch");
    assert.equal(headerValue(fetched?.requestHeaders, "x-fixture"), "visible");
    assert.equal(headerValue(fetched?.requestHeaders, "authorization"), REDACTED);
    assert.equal(headerValue(fetched?.responseHeaders, "set-cookie"), REDACTED);
    const xhr = requestTo(read.requests, "/api/xhr");
    assert.equal(headerValue(xhr?.requestHeaders, "cookie"), REDACTED);
    assert.equal(
      requestTo(read.requests, "/api/frame")?.url,
      `http://localhost:${fixtures.port}/api/frame`,
    );
    assertNoSecrets(read.text);
  });

  test("a pattern returns only the requests whose URL contains it", async () => {
    await readUntil(networkTab, (requests) => requestTo(requests, "/api/xhr") !== undefined);
    const read = await readNetwork(networkTab, { pattern: "/api/xhr" });
    assert.deepEqual(
      read.requests.map((request) => request.url),
      [fixtures.url("/api/xhr")],
    );
    assert.equal(read.truncated, false);
  });

  test("limit returns the newest request and says some were left out", async () => {
    const all = await readUntil(networkTab, (requests) => requests.length > 1);
    const read = await readNetwork(networkTab, { limit: 1 });
    assert.equal(read.requests.length, 1);
    assert.equal(read.requests[0]?.url, all.requests.at(-1)?.url);
    assert.equal(read.truncated, true);
  });

  test("a new page in the tab starts a new list with its own request", async () => {
    const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/network") })).id;
    await waitForTitle(tab, TITLES.networkDone);
    await harness.ok(session, "navigate", { tabId: tab, url: fixtures.url("/a") });
    const read = await readUntil(
      tab,
      (requests) => requestTo(requests, "/a")?.status !== undefined,
    );
    assert.equal(
      read.requests.some((request) => new URL(request.url).pathname.startsWith("/api/")),
      false,
      JSON.stringify(read.requests),
    );
    const [page] = read.requests;
    assert.equal(page?.url, fixtures.url("/a"));
    assert.equal(page?.type, "main_frame");
    assert.equal(page?.status, 200);
    // The page's own request now sends the cookie.
    assertNoSecrets(read.text);
  });

  test("leaves out what the previous page sends as it unloads", async () => {
    const before = new Set(tabsOf(await harness.ok(session, "tabs_list")).map(({ id }) => id));
    // The page leaves for the other site at once, so tab_open may report either page.
    await harness.call(session, "tab_open", { url: fixtures.url("/network-hop") });
    const opened = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => !before.has(id));
    assert.ok(opened !== undefined, "tab_open opened no tab");
    const tab = opened.id;
    const other = `http://localhost:${fixtures.port}`;
    await waitFor(async () => {
      const listed = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tab);
      return listed !== undefined && URL.parse(listed.url)?.origin === other;
    }, `tab ${tab} to show ${other}`);
    await harness.ok(session, "navigate", { tabId: tab, url: fixtures.url("/a") });
    await waitFor(async () => {
      const read = await readNetwork(tab);
      return (
        read.recording &&
        fixtures.hits("/api/beacon-top") > 0 &&
        fixtures.hits("/api/beacon-frame") > 0
      );
    }, "the beacons of the previous page");
    const read = await readNetwork(tab);
    for (const path of ["/api/beacon-top", "/api/beacon-frame"]) {
      assert.equal(requestTo(read.requests, path), undefined, JSON.stringify(read.requests));
    }
  });

  test("another session's read of the tab is refused", async () => {
    const other = await harness.connect();
    const text = await harness.refused(other, "read_network", { tabId: networkTab });
    assert.ok(text.includes("is not in this session's tab group"), text);
  });

  async function readNetwork(
    tabId: number,
    args: Record<string, unknown> = {},
  ): Promise<NetworkRead> {
    const result = await harness.call(session, "read_network", { tabId, ...args });
    assert.equal(result.isError, false, result.text);
    return { ...networkReadOf(parseResult(result.text)), text: result.text };
  }

  /** Reads until `done` holds for the requests of a recorded page, for at most POLL_LIMIT_MS. */
  async function readUntil(
    tabId: number,
    done: (requests: readonly NetworkRequest[]) => boolean,
  ): Promise<NetworkRead> {
    const deadline = Date.now() + POLL_LIMIT_MS;
    for (;;) {
      const read = await readNetwork(tabId);
      if (read.recording && done(read.requests)) return read;
      if (Date.now() > deadline) assert.fail(`not the requests expected: ${read.text}`);
      await sleep(POLL_MS);
    }
  }

  async function waitForTitle(tabId: number, title: string): Promise<void> {
    await waitFor(async () => {
      const listed = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tabId);
      return listed?.title === title;
    }, `tab ${tabId} to show ${title}`);
  }
});

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

function requestTo(requests: readonly NetworkRequest[], path: string): NetworkRequest | undefined {
  return requests.find((request) => new URL(request.url).pathname === path);
}

function headerValue(headers: readonly NetworkHeader[] | undefined, name: string) {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value;
}

function assertNoSecrets(text: string): void {
  for (const secret of Object.values(NETWORK_SECRETS)) {
    assert.equal(text.includes(secret), false, `${secret} in ${text}`);
  }
}

function networkReadOf(value: unknown): Omit<NetworkRead, "text"> {
  assert.ok(typeof value === "object" && value !== null, JSON.stringify(value));
  const { recording, requests, truncated } = Object.fromEntries(Object.entries(value));
  assert.ok(
    typeof recording === "boolean" && Array.isArray(requests) && typeof truncated === "boolean",
    JSON.stringify(value),
  );
  return { recording, requests, truncated };
}
