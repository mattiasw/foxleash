import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MAX_NETWORK_RESPONSE_TEXT,
  type NetworkHeader,
  type NetworkRequestRead,
} from "@foxleash/protocol";
import { type Firefox, pollUntil } from "./firefox.ts";
import {
  type FixtureServer,
  NETWORK_BODIES,
  NETWORK_CUT_BYTES,
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
/** How many times the order test fetches each of its responses. */
const ORDERED_ROUNDS = 40;

// One Firefox for the file, as in console.test.ts.
describe("read_network in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let networkTab: number;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
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
    await pollUntil(
      async () => {
        const top = fixtures.hits("/api/beacon-armed-top");
        const frame = fixtures.hits("/api/beacon-armed-frame");
        if (top > 0 && frame > 0) return true;
        throw new Error(`armed-top ${top}, armed-frame ${frame}`);
      },
      POLL_LIMIT_MS,
      "the unload listeners of the previous page",
    );
    await harness.ok(session, "navigate", { tabId: tab, url: fixtures.url("/a") });
    await pollUntil(
      async () => {
        const top = fixtures.hits("/api/beacon-top");
        const frame = fixtures.hits("/api/beacon-frame");
        if (top > 0 && frame > 0) return true;
        throw new Error(`beacon-top ${top}, beacon-frame ${frame}`);
      },
      POLL_LIMIT_MS,
      "the beacons of the previous page",
    );
    await waitFor(async () => (await readNetwork(tab)).recording, `tab ${tab} to record`);
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

  test("a login form's POST shows its field names, never the password", async () => {
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
    assert.equal(
      headerValue(post?.requestHeaders, "content-length"),
      REDACTED,
      JSON.stringify(post?.requestHeaders),
    );
  });

  test("a JSON body shows its keys up to Firefox's limit for request bodies, never past it", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/network-large") }),
    ).id;
    await waitForTitle(tab, TITLES.networkLargeDone);
    const read = await readUntil(
      tab,
      (requests) =>
        ["/api/json-at-limit", "/api/json-over-limit"].every(
          (path) => requestTo(requests, path)?.status !== undefined,
        ),
      { body: true },
    );
    assert.deepEqual(requestTo(read.requests, "/api/json-at-limit")?.requestBody, {
      kind: "json",
      fields: [{ name: "a", depth: 1, kind: "string", filled: true }],
    });
    assert.deepEqual(requestTo(read.requests, "/api/json-over-limit")?.requestBody, {
      kind: "other",
      filled: true,
    });
  });

  test("a form body shows its field names up to Firefox's edge for form bodies, other past it or empty", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/network-large-form") }),
    ).id;
    await waitForTitle(tab, TITLES.networkLargeFormDone);
    const paths = [
      "/api/form-at-edge",
      "/api/form-over-edge",
      "/api/form-empty",
      "/api/multipart-at-edge",
      "/api/multipart-over-edge",
    ];
    const read = await readUntil(
      tab,
      (requests) => paths.every((path) => requestTo(requests, path)?.status !== undefined),
      { body: true },
    );
    const named = { kind: "form", fields: [{ name: "a", depth: 1, kind: "text", filled: true }] };
    assert.deepEqual(requestTo(read.requests, "/api/form-at-edge")?.requestBody, named);
    assert.deepEqual(requestTo(read.requests, "/api/form-over-edge")?.requestBody, {
      kind: "other",
    });
    assert.deepEqual(requestTo(read.requests, "/api/form-empty")?.requestBody, { kind: "other" });
    assert.deepEqual(requestTo(read.requests, "/api/multipart-at-edge")?.requestBody, named);
    assert.deepEqual(requestTo(read.requests, "/api/multipart-over-edge")?.requestBody, {
      kind: "other",
      filled: true,
    });
  });

  test("another session's read of the tab is refused", async () => {
    const other = await harness.connect();
    const text = await harness.refused(other, "read_network", { tabId: networkTab });
    assert.ok(text.includes("is not in this session's tab group"), text);
  });

  test("returns a fetch POST's error body as it arrived, without sending it again", async () => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    const received = await firefox.evaluate(
      page.context,
      `fetch("/api/body/error", { method: "POST", body: "token=single-use" }).then((r) => r.text())`,
    );
    assert.equal(received, NETWORK_BODIES.error);
    const read = await readUntil(
      page.tab,
      (requests) => requestTo(requests, "/api/body/error")?.responseBody !== undefined,
      { responseBody: true, failed: true },
    );
    const post = requestTo(read.requests, "/api/body/error");
    assert.equal(post?.status, 500);
    assert.equal(post?.method, "POST");
    assert.deepEqual(post?.responseBody, { text: NETWORK_BODIES.error });
    assert.equal(fixtures.hits("/api/body/error"), 1);
    const without = await readNetwork(page.tab, { failed: true });
    const plain = requestTo(without.requests, "/api/body/error");
    assert.ok(plain !== undefined, without.text);
    assert.equal(Object.hasOwn(plain, "responseBody"), false, without.text);
  });

  test("the page gets exactly the bytes the server sent: large, compressed or streamed", async (t) => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    const sent: [string, string][] = [
      ["/api/body/large", NETWORK_BODIES.large],
      ["/api/body/gzip", NETWORK_BODIES.gzip],
      ["/api/body/stream", NETWORK_BODIES.stream.join("")],
    ];
    for (const [path, body] of sent) {
      const started = Date.now();
      assert.equal(await firefox.evaluate(page.context, digestScript(path)), sha256(body), path);
      t.diagnostic(`${path}: ${Date.now() - started} ms in the page, captured`);
    }
    const read = await readUntil(
      page.tab,
      (requests) => sent.every(([path]) => requestTo(requests, path)?.responseBody !== undefined),
      { responseBody: true },
    );
    assert.deepEqual(requestTo(read.requests, "/api/body/large")?.responseBody, {
      text: NETWORK_BODIES.large.slice(0, MAX_NETWORK_RESPONSE_TEXT),
      truncated: true,
    });
    assert.deepEqual(requestTo(read.requests, "/api/body/gzip")?.responseBody, {
      text: NETWORK_BODIES.gzip,
    });
    assert.deepEqual(requestTo(read.requests, "/api/body/stream")?.responseBody, {
      text: NETWORK_BODIES.stream.join(""),
    });
  });

  test("the page gets every chunk of a large response in order, kept or not", async (t) => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    const expected = sha256(NETWORK_BODIES.ordered);
    const paths = ["/api/body/ordered-json", "/api/body/ordered-binary"];
    const differing = new Map<string, number[]>();
    for (const path of paths) {
      const started = Date.now();
      const rounds: number[] = [];
      for (let round = 0; round < ORDERED_ROUNDS; round += 1) {
        if ((await firefox.evaluate(page.context, digestScript(path))) !== expected) {
          rounds.push(round);
        }
      }
      differing.set(path, rounds);
      t.diagnostic(`${path}: ${Date.now() - started} ms for ${ORDERED_ROUNDS} fetches in the page`);
    }
    assert.deepEqual(
      differing,
      new Map(paths.map((path) => [path, []])),
      paths
        .map((path) => {
          const rounds = differing.get(path) ?? [];
          return `${path}: ${rounds.length} of ${ORDERED_ROUNDS} differ (rounds ${rounds.join(", ")})`;
        })
        .join("; "),
    );
    const read = await readUntil(
      page.tab,
      (requests) => requestTo(requests, "/api/body/ordered-json")?.responseBody !== undefined,
      { responseBody: true, pattern: "/api/body/ordered-" },
    );
    assert.deepEqual(requestTo(read.requests, "/api/body/ordered-json")?.responseBody, {
      text: NETWORK_BODIES.ordered.slice(0, MAX_NETWORK_RESPONSE_TEXT),
      truncated: true,
    });
    const binary = read.requests.filter(
      (request) => new URL(request.url).pathname === "/api/body/ordered-binary",
    );
    assert.equal(binary.length, ORDERED_ROUNDS);
    assert.equal(binary.filter((request) => Object.hasOwn(request, "responseBody")).length, 0);
  });

  test("captures no response from another site, whether the page or its frame asked", async () => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    const other = `http://localhost:${fixtures.port}`;
    const urls = {
      pageOther: `${other}/api/body/other?by=page`,
      frameOther: `${other}/api/body/other?by=frame`,
      pageOwn: fixtures.url("/api/body/other?by=page"),
      frameOwn: fixtures.url("/api/body/other?by=frame"),
    };
    // The other site's requests first: once the last request's body is in, theirs would be too.
    for (const [context, url] of [
      [page.context, urls.pageOther],
      [page.frame, urls.frameOther],
      [page.context, urls.pageOwn],
      [page.frame, urls.frameOwn],
    ] as const) {
      assert.equal(await firefox.evaluate(context, textScript(url)), NETWORK_BODIES.other, url);
    }
    const read = await readUntil(
      page.tab,
      (requests) =>
        requestWithUrl(requests, urls.pageOwn)?.responseBody !== undefined &&
        requestWithUrl(requests, urls.frameOwn)?.responseBody !== undefined &&
        requestWithUrl(requests, urls.pageOther)?.durationMs !== undefined &&
        requestWithUrl(requests, urls.frameOther)?.durationMs !== undefined,
      { responseBody: true },
    );
    for (const url of [urls.pageOther, urls.frameOther]) {
      const request = requestWithUrl(read.requests, url);
      assert.equal(request?.status, 200, read.text);
      assert.equal(request?.responseBody, undefined, read.text);
    }
  });

  test("a response the connection cuts short reaches a recorded page as complete, and read_network shows the error", async () => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    const other = `http://localhost:${fixtures.port}`;
    const outcome = async (script: string): Promise<unknown> =>
      JSON.parse(String(await firefox.evaluate(page.context, script)));
    assert.deepEqual(await outcome(outcomeScript("/api/body/cut-text")), {
      status: 200,
      length: NETWORK_CUT_BYTES.text,
      digest: sha256(NETWORK_BODIES.large.slice(0, NETWORK_CUT_BYTES.text)),
    });
    assert.deepEqual(await outcome(outcomeScript("/api/body/cut-binary")), {
      status: 200,
      length: NETWORK_CUT_BYTES.binary,
      digest: sha256(NETWORK_BODIES.ordered.slice(0, NETWORK_CUT_BYTES.binary)),
    });
    assert.deepEqual(await outcome(xhrOutcomeScript("/api/body/cut-binary")), {
      status: 200,
      length: NETWORK_CUT_BYTES.binary,
    });
    // Without a filter the same cut fails in the page, so the rows above show the filter's effect.
    assert.deepEqual(await outcome(outcomeScript(`${other}/api/body/cut-binary`)), {
      error: "TypeError",
    });
    const own = (requests: readonly NetworkRequestRead[]) =>
      requests.filter((request) => request.url.startsWith(fixtures.url("/api/body/cut-")));
    const read = await readUntil(
      page.tab,
      (requests) =>
        own(requests).length === 3 &&
        own(requests).every(
          (request) => request.error !== undefined || request.durationMs !== undefined,
        ),
      { responseBody: true, pattern: "/api/body/cut-" },
    );
    assert.deepEqual(
      own(read.requests).map((request) => ({
        path: new URL(request.url).pathname,
        error: request.error,
        body: Object.hasOwn(request, "responseBody"),
      })),
      [
        { path: "/api/body/cut-text", error: "NS_ERROR_NET_PARTIAL_TRANSFER", body: false },
        { path: "/api/body/cut-binary", error: "NS_ERROR_NET_PARTIAL_TRANSFER", body: false },
        { path: "/api/body/cut-binary", error: "NS_ERROR_NET_PARTIAL_TRANSFER", body: false },
      ],
      read.text,
    );
  });

  // Last: it blocks the fixture site for a moment, which ends every recording of it.
  test("a capture abandoned while the response arrives leaves the page's response whole", async () => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    await firefox.evaluate(page.context, `(window.held = ${digestScript("/api/body/held")}, 0)`);
    await waitFor(
      async () => fixtures.hits("/api/body/held") === 1,
      "the server to get the held request",
    );
    await readUntil(page.tab, (requests) => requestTo(requests, "/api/body/held") !== undefined);
    // Recording of the page ends: its site is blocked.
    await harness.seedSettings({ blocklist: ["localhost", "127.0.0.1"] });
    await waitFor(async () => {
      const result = await harness.call(session, "read_network", { tabId: page.tab });
      return result.isError;
    }, "read_network to refuse the blocked page");
    fixtures.releaseBody();
    assert.equal(
      await firefox.evaluate(page.context, "window.held"),
      sha256(NETWORK_BODIES.held.join("")),
    );
    await harness.seedSettings({ blocklist: ["blocked.example"] });
    await waitFor(async () => {
      const result = await harness.call(session, "read_network", { tabId: page.tab });
      return !result.isError && networkReadOf(parseResult(result.text)).recording;
    }, "recording to start again");
    const read = await readNetwork(page.tab, { responseBody: true });
    assert.equal(requestTo(read.requests, "/api/body/held"), undefined, read.text);
  });

  function readNetwork(tabId: number, args: Record<string, unknown> = {}): Promise<NetworkRead> {
    return readNetworkOf(harness, session, tabId, args);
  }

  function readUntil(
    tabId: number,
    done: (requests: readonly NetworkRequestRead[]) => boolean,
    args: Record<string, unknown> = {},
  ): Promise<NetworkRead> {
    return readUntilOf(harness, session, tabId, done, args);
  }

  function waitForTitle(tabId: number, title: string): Promise<void> {
    return waitForTitleOf(harness, session, tabId, title);
  }
});

// A Firefox of its own, with the other site approved and blocklisted.
describe("read_network response bodies and the blocklist, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
        [`site:http://localhost:${fixtures.port}`]: { grantedAt: new Date().toISOString() },
        blocklist: ["localhost"],
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

  test("captures no response from a blocklisted site, nor from a redirect to one", async () => {
    const page = await openBodiesPage(harness, session, firefox, fixtures);
    const blocked = `http://localhost:${fixtures.port}`;
    const urls = {
      pageBlocked: `${blocked}/api/body/other?by=page`,
      frameBlocked: `${blocked}/api/body/other?by=frame`,
      redirect: fixtures.url("/api/body/redirect"),
      redirected: `${blocked}/api/body/other?by=redirect`,
      pageOwn: fixtures.url("/api/body/other?by=page"),
      frameOwn: fixtures.url("/api/body/other?by=frame"),
    };
    for (const [context, url] of [
      [page.context, urls.pageBlocked],
      [page.frame, urls.frameBlocked],
      [page.context, urls.redirect],
      [page.context, urls.pageOwn],
      [page.frame, urls.frameOwn],
    ] as const) {
      assert.equal(await firefox.evaluate(context, textScript(url)), NETWORK_BODIES.other, url);
    }
    const read = await readUntilOf(
      harness,
      session,
      page.tab,
      (requests) =>
        requestWithUrl(requests, urls.pageOwn)?.responseBody !== undefined &&
        requestWithUrl(requests, urls.frameOwn)?.responseBody !== undefined &&
        [urls.pageBlocked, urls.frameBlocked, urls.redirect, urls.redirected].every(
          (url) => requestWithUrl(requests, url)?.durationMs !== undefined,
        ),
      { responseBody: true },
    );
    assert.equal(requestWithUrl(read.requests, urls.redirect)?.status, 302, read.text);
    for (const url of [urls.pageBlocked, urls.frameBlocked, urls.redirect, urls.redirected]) {
      assert.equal(requestWithUrl(read.requests, url)?.responseBody, undefined, url);
    }
  });
});

async function readNetworkOf(
  harness: Harness,
  session: Session,
  tabId: number,
  args: Record<string, unknown> = {},
): Promise<NetworkRead> {
  const result = await harness.call(session, "read_network", { tabId, ...args });
  assert.equal(result.isError, false, result.text);
  return { ...networkReadOf(parseResult(result.text)), text: result.text };
}

/** Reads until `done` holds for the requests of a recorded page, for at most POLL_LIMIT_MS. */
async function readUntilOf(
  harness: Harness,
  session: Session,
  tabId: number,
  done: (requests: readonly NetworkRequestRead[]) => boolean,
  args: Record<string, unknown> = {},
): Promise<NetworkRead> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  for (;;) {
    const read = await readNetworkOf(harness, session, tabId, args);
    if (read.recording && done(read.requests)) return read;
    if (Date.now() > deadline) assert.fail(`not the requests expected: ${read.text}`);
    await sleep(POLL_MS);
  }
}

async function waitForTitleOf(
  harness: Harness,
  session: Session,
  tabId: number,
  title: string,
): Promise<void> {
  await waitFor(async () => {
    const listed = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tabId);
    return listed?.title === title;
  }, `tab ${tabId} to show ${title}`);
}

/** Opens the response-body page in a new tab; its tab id and the contexts of the page and frame. */
async function openBodiesPage(
  harness: Harness,
  session: Session,
  firefox: Firefox,
  fixtures: FixtureServer,
): Promise<{ tab: number; context: string; frame: string }> {
  const url = fixtures.url(`/network-bodies?tab=${fixtures.hits("/network-bodies") + 1}`);
  const tab = tabOf(await harness.ok(session, "tab_open", { url })).id;
  await waitForTitleOf(harness, session, tab, TITLES.networkBodies);
  const page = (await firefox.contexts()).find((context) => context.url === url);
  assert.ok(page !== undefined, `no tab shows ${url}`);
  let frame: string | undefined;
  await waitFor(async () => {
    frame = (await firefox.frames(page.context)).find((context) =>
      context.url.endsWith("/network-bodies-frame"),
    )?.context;
    return frame !== undefined;
  }, `the frame of ${url}`);
  assert.ok(frame !== undefined);
  return { tab, context: page.context, frame };
}

/** A page script that fetches `path` and gives the SHA-256 of what it received, in hex. */
function digestScript(path: string): string {
  return `fetch(${JSON.stringify(path)})
    .then((response) => response.arrayBuffer())
    .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))`;
}

/**
 * A page script that fetches `url` and gives, as JSON, the status, the length and the SHA-256 of
 * what it received, or the name of the error when the fetch or the body fails.
 */
function outcomeScript(url: string): string {
  return `fetch(${JSON.stringify(url)})
    .then((response) => response.arrayBuffer().then(async (bytes) => {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return JSON.stringify({
        status: response.status,
        length: bytes.byteLength,
        digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      });
    }))
    .catch((error) => JSON.stringify({ error: error.name }))`;
}

/** A page script that gets `url` with XMLHttpRequest and gives, as JSON, how it ended. */
function xhrOutcomeScript(url: string): string {
  return `new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", ${JSON.stringify(url)});
    xhr.responseType = "arraybuffer";
    xhr.onload = () => resolve(JSON.stringify({ status: xhr.status, length: xhr.response.byteLength }));
    xhr.onerror = xhr.onabort = xhr.ontimeout = (event) => resolve(JSON.stringify({ error: event.type }));
    xhr.send();
  })`;
}

function textScript(url: string): string {
  return `fetch(${JSON.stringify(url)}).then((response) => response.text())`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requestWithUrl(
  requests: readonly NetworkRequestRead[],
  url: string,
): NetworkRequestRead | undefined {
  return requests.find((request) => request.url === url);
}

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
