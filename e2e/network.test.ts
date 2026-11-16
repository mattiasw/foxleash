import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { NetworkHeader, NetworkRequestRead } from "@foxleash/protocol";
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
  requests: NetworkRequestRead[];
  truncated: boolean;
  /** The tool's whole result text, frame included. */
  text: string;
}

const REF = "([a-z]{1,7}[1-9][0-9]*)";
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
    const read = await readUntil(
      networkTab,
      (requests) =>
        ["/api/fetch", "/api/xhr", "/api/frame"].every(
          (path) => requestTo(requests, path)?.status !== undefined,
        ),
      { headers: true },
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

  test("leaves the headers out unless asked", async (t) => {
    const without = await readUntil(networkTab, (requests) =>
      ["/api/fetch", "/api/xhr", "/api/frame"].every(
        (path) => requestTo(requests, path)?.status !== undefined,
      ),
    );
    const withHeaders = await readNetwork(networkTab, { headers: true });
    for (const request of without.requests) {
      assert.equal(Object.hasOwn(request, "requestHeaders"), false, JSON.stringify(request));
      assert.equal(Object.hasOwn(request, "responseHeaders"), false, JSON.stringify(request));
    }
    for (const request of withHeaders.requests) {
      assert.ok(Array.isArray(request.requestHeaders), JSON.stringify(request));
      assert.ok(Array.isArray(request.responseHeaders), JSON.stringify(request));
    }
    assert.ok(without.text.length < withHeaders.text.length);
    t.diagnostic(
      `read_network on the network page: ${Buffer.byteLength(without.text)} bytes for ${without.requests.length} requests without headers, ${Buffer.byteLength(withHeaders.text)} bytes for ${withHeaders.requests.length} with headers`,
    );
  });

  test("types returns only the requests of those types", async () => {
    await readUntil(networkTab, (requests) => requestTo(requests, "/api/xhr") !== undefined);
    const read = await readNetwork(networkTab, { types: ["main_frame"] });
    assert.deepEqual(
      read.requests.map((request) => request.url),
      [fixtures.url("/network")],
    );
    for (const request of read.requests) assert.equal(request.type, "main_frame");
    assert.equal(read.truncated, false);
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
      { headers: true },
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

  test("a fetch POST shows its JSON keys, never a value", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/network-json") }),
    ).id;
    await waitForTitle(tab, TITLES.networkJsonDone);
    const read = await readUntil(
      tab,
      (requests) =>
        ["/api/json", "/api/form-json"].every(
          (path) => requestTo(requests, path)?.status !== undefined,
        ),
      { body: true, headers: true },
    );
    assert.deepEqual(requestTo(read.requests, "/api/json")?.requestBody, {
      kind: "json",
      fields: [
        { name: "user", depth: 1, kind: "object", filled: true },
        { name: "name", depth: 2, kind: "string", filled: true },
        { name: "nickname", depth: 2, kind: "string", filled: false },
        { name: "age", depth: 2, kind: "number" },
        { name: "admin", depth: 2, kind: "boolean" },
        { name: "manager", depth: 2, kind: "null" },
        { name: "items", depth: 1, kind: "array", filled: true },
        { name: "[]", depth: 2, kind: "string", filled: true },
        { name: "g-recaptcha-response", depth: 1, kind: "string", filled: true },
        { name: "(name withheld)", depth: 1, kind: "boolean" },
      ],
    });
    assert.deepEqual(requestTo(read.requests, "/api/form-json")?.requestBody, { kind: "other" });
    assertNoSecrets(read.text);
    for (const args of [{}, { body: false }]) {
      const without = await readNetwork(tab, args);
      assert.ok(requestTo(without.requests, "/api/json") !== undefined, without.text);
      for (const request of without.requests) {
        assert.equal(Object.hasOwn(request, "requestBody"), false, JSON.stringify(request));
      }
    }
  });

  test("a login form's POST shows its field names, never the password", async (t) => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/network-login") }),
    ).id;
    await waitForTitle(tab, TITLES.networkLogin);
    const page = await harness.call(session, "read_page", { tabId: tab });
    assert.equal(page.isError, false, page.text);
    await harness.ok(session, "click", { tabId: tab, ref: refOf(page.text, 'button "Sign in"') });
    await waitForTitle(tab, TITLES.networkLoginDone);
    const read = await readUntil(
      tab,
      (requests) =>
        requests[0] !== undefined &&
        new URL(requests[0].url).pathname === "/network-login-post" &&
        requests[0].status !== undefined,
      { body: true, headers: true },
    );
    const [post] = read.requests;
    assert.equal(post?.type, "main_frame", JSON.stringify(post));
    assert.equal(post?.method, "POST");
    assert.deepEqual(post?.requestBody, {
      kind: "form",
      fields: [
        { name: "username", depth: 1, kind: "text", filled: true },
        { name: "password", depth: 1, kind: "text", filled: true },
      ],
    });
    assertNoSecrets(read.text);
    const length = headerValue(post?.requestHeaders, "content-length");
    assert.ok(length !== undefined, JSON.stringify(post?.requestHeaders));
    t.diagnostic(`the login form's POST carries Content-Length: ${length}`);
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
    done: (requests: readonly NetworkRequestRead[]) => boolean,
    args: Record<string, unknown> = {},
  ): Promise<NetworkRead> {
    const deadline = Date.now() + POLL_LIMIT_MS;
    for (;;) {
      const read = await readNetwork(tabId, args);
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

function requestTo(
  requests: readonly NetworkRequestRead[],
  path: string,
): NetworkRequestRead | undefined {
  return requests.find((request) => new URL(request.url).pathname === path);
}

function headerValue(headers: readonly NetworkHeader[] | undefined, name: string) {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value;
}

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
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
