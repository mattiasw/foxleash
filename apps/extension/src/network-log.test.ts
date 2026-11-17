import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  MAX_NETWORK_BODY_FIELDS,
  MAX_NETWORK_HEADER,
  MAX_NETWORK_HEADERS,
  MAX_NETWORK_REQUESTS,
  MAX_NETWORK_URL,
  type NetworkRequestRead,
  type Result,
} from "@foxleash/protocol";
import type {
  HeadersReceivedDetails,
  HttpHeader,
  RedirectDetails,
  RequestDetails,
} from "./browser-api.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  type FakeStreamFilter,
  type FakeTab,
  flush,
} from "./fake-browser.ts";
import {
  createNetworkLog,
  MAX_LOG_CHARS,
  MAX_OPEN_CAPTURES,
  type NetworkReadOptions,
  REDACTED,
  REDACTED_HEADERS,
  REDACTED_REQUEST_HEADERS,
  redactHeaders,
} from "./network-log.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite, saveBlocklist } from "./settings.ts";
import { createSiteAccess, PROMPT_PAGE, type SessionMemory } from "./site-access.ts";

const SITE = "https://a.example";
const URL_A = `${SITE}/page`;
const OTHER = "https://b.example";
const NONE: Result<"read_network"> = { recording: false, requests: [], truncated: false };
const ALL: NetworkReadOptions = {
  failed: false,
  headers: true,
  body: true,
  responseBody: true,
  limit: MAX_NETWORK_REQUESTS,
};

describe("network log", { timeout: 10000 }, () => {
  it("records a request's url, method, type, timing, status and headers", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/api`, { method: "POST", timeStamp: 1000 });
    fake.emitWebRequest("onSendHeaders", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1001,
      requestHeaders: [{ name: "Accept", value: "*/*" }],
    });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1100,
      statusCode: 201,
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
    });
    const [received] = read(tab.id).requests;
    assert.equal(received?.status, 201);
    assert.equal(received?.durationMs, undefined);
    fake.emitWebRequest("onCompleted", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1250,
      statusCode: 201,
      fromCache: false,
      responseHeaders: [
        { name: "Content-Type", value: "text/plain" },
        { name: "Content-Length", value: "2" },
      ],
    });
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 1,
      requests: [
        {
          url: `${SITE}/api`,
          method: "POST",
          type: "xmlhttprequest",
          startTime: 1000,
          durationMs: 250,
          status: 201,
          fromCache: false,
          requestHeaders: [{ name: "Accept", value: "*/*" }],
          responseHeaders: [
            { name: "Content-Type", value: "text/plain" },
            { name: "Content-Length", value: "2" },
          ],
        },
      ],
      truncated: false,
    });
  });

  it("records a redirect as one entry per hop, and a failure with its error", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/old`, { type: "script", timeStamp: 1000 });
    fake.emitWebRequest("onBeforeRedirect", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1020,
      statusCode: 301,
      redirectUrl: `${SITE}/new`,
      fromCache: true,
    });
    // The hop ended at its redirect: nothing more reaches it.
    fake.emitWebRequest("onErrorOccurred", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1025,
      error: "NS_BINDING_ABORTED",
    });
    request(tab.id, `${SITE}/new`, { requestId: id, type: "script", timeStamp: 1030 });
    fake.emitWebRequest("onErrorOccurred", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1100,
      error: "NS_ERROR_NET_RESET",
    });
    assert.deepEqual(read(tab.id).requests, [
      {
        url: `${SITE}/old`,
        method: "GET",
        type: "script",
        startTime: 1000,
        durationMs: 20,
        status: 301,
        redirectUrl: `${SITE}/new`,
        fromCache: true,
        requestHeaders: [],
        responseHeaders: [],
      },
      {
        url: `${SITE}/new`,
        method: "GET",
        type: "script",
        startTime: 1030,
        durationMs: 70,
        error: "NS_ERROR_NET_RESET",
        requestHeaders: [],
        responseHeaders: [],
      },
    ]);
    fake.emitWebRequest("onCompleted", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1200,
      statusCode: 200,
      fromCache: false,
    });
    assert.equal(read(tab.id).requests.at(-1)?.status, undefined);
  });

  it("keeps the response headers when the completion carries none", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/api`);
    const responseHeaders = [{ name: "Content-Type", value: "text/plain" }];
    fake.emitWebRequest("onHeadersReceived", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1010,
      statusCode: 200,
      responseHeaders,
    });
    fake.emitWebRequest("onCompleted", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1020,
      statusCode: 200,
      fromCache: false,
    });
    assert.deepEqual(read(tab.id).requests[0]?.responseHeaders, responseHeaders);
  });

  it("redacts the credential headers in any letter case, in both directions", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/api`);
    const sent: HttpHeader[] = [
      { name: "COOKIE", value: "session=secret-1" },
      { name: "Authorization", value: "Bearer secret-2" },
      { name: "PROXY-AUTHORIZATION", value: "Basic secret-3" },
      { name: "X-Fixture", value: "visible" },
      { name: "cookie2", value: "kept" },
    ];
    const received: HttpHeader[] = [
      { name: "set-cookie", value: "a=secret-4\nb=secret-5" },
      { name: "Set-Cookie", value: "c=secret-6" },
      { name: "cookie", value: "secret-7" },
      { name: "authorization", value: "secret-8" },
      { name: "Proxy-Authorization", value: "secret-9" },
      { name: "Content-Type", value: "text/html" },
      { name: "WWW-Authenticate", value: "Basic" },
    ];
    fake.emitWebRequest("onSendHeaders", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1001,
      requestHeaders: sent,
    });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1002,
      statusCode: 200,
      responseHeaders: received,
    });
    const expected = {
      requestHeaders: [
        { name: "COOKIE", value: REDACTED },
        { name: "Authorization", value: REDACTED },
        { name: "PROXY-AUTHORIZATION", value: REDACTED },
        { name: "X-Fixture", value: "visible" },
        { name: "cookie2", value: "kept" },
      ],
      responseHeaders: [
        { name: "set-cookie", value: REDACTED },
        { name: "Set-Cookie", value: REDACTED },
        { name: "cookie", value: REDACTED },
        { name: "authorization", value: REDACTED },
        { name: "Proxy-Authorization", value: REDACTED },
        { name: "Content-Type", value: "text/html" },
        { name: "WWW-Authenticate", value: "Basic" },
      ],
    };
    const [recorded] = read(tab.id).requests;
    assert.deepEqual(recorded?.requestHeaders, expected.requestHeaders);
    assert.deepEqual(recorded?.responseHeaders, expected.responseHeaders);
    fake.emitWebRequest("onCompleted", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1003,
      statusCode: 200,
      fromCache: false,
      responseHeaders: received,
    });
    assert.deepEqual(read(tab.id).requests[0]?.responseHeaders, expected.responseHeaders);
    assert.equal(REDACTED, "[redacted]");
    assert.doesNotMatch(JSON.stringify(read(tab.id)), /secret/);
  });

  it("redacts a request's Content-Length in any letter case, never a response's", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const sent: HttpHeader[][] = [
      [{ name: "Content-Length", value: "73" }],
      // HTTP/2 names arrive lowercase; a request can carry the header more than once.
      [
        { name: "content-length", value: "73" },
        { name: "CONTENT-LENGTH", value: "73" },
      ],
    ];
    const received: HttpHeader[] = [{ name: "Content-Length", value: "512" }];
    const ids = sent.map((requestHeaders) => {
      const id = request(tab.id, `${SITE}/login`, { method: "POST" });
      fake.emitWebRequest("onSendHeaders", {
        requestId: id,
        tabId: tab.id,
        timeStamp: 1010,
        requestHeaders,
      });
      fake.emitWebRequest("onHeadersReceived", {
        requestId: id,
        tabId: tab.id,
        timeStamp: 1020,
        statusCode: 200,
        responseHeaders: received,
      });
      return id;
    });
    const kept = [{ name: "Content-Length", value: "512" }];
    const responseHeaders = () => read(tab.id).requests.map((recorded) => recorded.responseHeaders);
    assert.deepEqual(responseHeaders(), [kept, kept]);
    for (const id of ids) {
      fake.emitWebRequest("onCompleted", {
        requestId: id,
        tabId: tab.id,
        timeStamp: 1030,
        statusCode: 200,
        fromCache: false,
        responseHeaders: received,
      });
    }
    assert.deepEqual(responseHeaders(), [kept, kept]);
    const requestHeaders = read(tab.id).requests.map((recorded) => recorded.requestHeaders);
    assert.deepEqual(requestHeaders, [
      [{ name: "Content-Length", value: REDACTED }],
      [
        { name: "content-length", value: REDACTED },
        { name: "CONTENT-LENGTH", value: REDACTED },
      ],
    ]);
    assert.doesNotMatch(JSON.stringify(requestHeaders), /73/);
  });

  it("gives a header without a text value an empty value, and no headers for none", () => {
    // Firefox sends a header that is not valid UTF-8 as binaryValue only.
    const binary = { name: "X-Binary", binaryValue: [0xff, 0xfe] } as unknown as HttpHeader;
    const credential = { name: "Cookie", binaryValue: [0xff] } as unknown as HttpHeader;
    assert.deepEqual(redactHeaders([binary, credential]), [
      { name: "X-Binary", value: "" },
      { name: "Cookie", value: REDACTED },
    ]);
    assert.deepEqual(redactHeaders(undefined), []);
    assert.deepEqual(redactHeaders([]), []);
  });

  it("redacts a Content-Length only with the request set, which keeps the credential ones", () => {
    const length = { name: "Content-Length", value: "73" };
    const binaryLength = { name: "content-length", binaryValue: [0x37] } as unknown as HttpHeader;
    const credentials: HttpHeader[] = [
      { name: "Cookie", value: "secret-1" },
      { name: "Set-Cookie", value: "secret-2" },
      { name: "Authorization", value: "secret-3" },
      { name: "Proxy-Authorization", value: "secret-4" },
    ];
    const redactedCredentials = credentials.map(({ name }) => ({ name, value: REDACTED }));
    assert.deepEqual(redactHeaders([length, ...credentials]), [
      { name: "Content-Length", value: "73" },
      ...redactedCredentials,
    ]);
    assert.deepEqual(
      redactHeaders([length, binaryLength, ...credentials], REDACTED_REQUEST_HEADERS),
      [
        { name: "Content-Length", value: REDACTED },
        { name: "content-length", value: REDACTED },
        ...redactedCredentials,
      ],
    );
    assert.deepEqual(
      [...REDACTED_HEADERS],
      ["cookie", "set-cookie", "authorization", "proxy-authorization"],
    );
  });

  it("caps urls, methods, types, errors, header names, values and counts", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const longUrl = `${SITE}/${"u".repeat(MAX_NETWORK_URL)}`;
    const long = "m".repeat(MAX_NETWORK_HEADER + 1);
    const id = request(tab.id, longUrl, { method: long, type: long });
    const name = `x-${"n".repeat(MAX_NETWORK_HEADER)}`;
    const headers: HttpHeader[] = [
      { name, value: "v".repeat(MAX_NETWORK_HEADER + 1) },
      { name: "Authorization", value: "s".repeat(MAX_NETWORK_HEADER * 3) },
      ...Array.from({ length: MAX_NETWORK_HEADERS }, (_, index) => ({
        name: `x-${index}`,
        value: "v",
      })),
    ];
    fake.emitWebRequest("onSendHeaders", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1001,
      requestHeaders: headers,
    });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1002,
      statusCode: 302,
      responseHeaders: headers,
    });
    fake.emitWebRequest("onBeforeRedirect", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1003,
      statusCode: 302,
      redirectUrl: longUrl,
      fromCache: false,
    });
    const failed = request(tab.id, `${SITE}/failed`);
    fake.emitWebRequest("onErrorOccurred", {
      requestId: failed,
      tabId: tab.id,
      timeStamp: 1004,
      error: long,
    });
    const [capped, error] = read(tab.id).requests;
    assert.equal(capped?.url, longUrl.slice(0, MAX_NETWORK_URL));
    assert.equal(capped?.redirectUrl, longUrl.slice(0, MAX_NETWORK_URL));
    assert.equal(capped?.method, long.slice(0, MAX_NETWORK_HEADER));
    assert.equal(capped?.type, long.slice(0, MAX_NETWORK_HEADER));
    assert.equal(error?.error, long.slice(0, MAX_NETWORK_HEADER));
    for (const kept of [capped?.requestHeaders, capped?.responseHeaders]) {
      assert.equal(kept?.length, MAX_NETWORK_HEADERS);
      assert.deepEqual(kept?.[0], {
        name: name.slice(0, MAX_NETWORK_HEADER),
        value: "v".repeat(MAX_NETWORK_HEADER),
      });
      assert.deepEqual(kept?.[1], { name: "Authorization", value: REDACTED });
      assert.deepEqual(kept?.at(-1), { name: `x-${MAX_NETWORK_HEADERS - 3}`, value: "v" });
    }
  });

  it("starts a new log at each top-frame commit, and keeps it at a frame's", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    request(tab.id, `${SITE}/first`);
    fake.emitCommitted({ tabId: tab.id, frameId: 1, url: `${SITE}/frame` });
    await flush();
    assert.equal(read(tab.id).requests.length, 1);
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 1002,
      requests: [],
      truncated: false,
    });
  });

  it("records nothing off an approved site, outside a session's group or in its prompt", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, access } = setup();
    await fake.browser.storage.local.set({ blocklist: ["blocked.example"] });
    await grantSite(fake.browser, "https://blocked.example");
    const loose = fake.openTab();
    const userGroup = fake.openTab();
    await fake.browser.tabs.group({ tabIds: [userGroup.id] });
    const cases: [FakeTab, string][] = [
      [await tabIn("s1"), "https://c.example/"],
      [await tabIn("s1"), "https://blocked.example/"],
      [await tabIn("s1"), "about:blank"],
      [await tabIn("s1"), fake.browser.runtime.getURL(PROMPT_PAGE)],
      [loose, URL_A],
      [userGroup, URL_A],
    ];
    for (const [tab, url] of cases) {
      fake.navigateByUser(tab.id, url);
      await flush();
      request(tab.id, `${SITE}/api`, { documentUrl: url });
      for (const site of [SITE, "https://c.example", "https://blocked.example"]) {
        assert.deepEqual(read(tab.id, ALL, "s1", site), NONE, url);
      }
    }
    const prompted = await tabIn("s1");
    await access.ask("s1", "https://c.example/", prompted.id, {
      generation: access.generation("s1"),
    });
    assert.equal(access.openPrompt("s1")?.tabId, prompted.id);
    fake.emitCommitted({ tabId: prompted.id, frameId: 0, url: URL_A });
    await flush();
    request(prompted.id, `${SITE}/api`);
    assert.deepEqual(read(prompted.id), NONE);
  });

  it("records nothing for a page approved after it loaded, until it loads again", async () => {
    const { fake, read, request, tabIn, sessions } = setup();
    const tab = await tabIn("s1", "https://c.example/");
    const options = { documentUrl: "https://c.example/" };
    request(tab.id, "https://c.example/before", options);
    sessions.set("s1", { allowed: new Set(["https://c.example"]), refused: new Set(), closed: 0 });
    request(tab.id, "https://c.example/after", options);
    assert.deepEqual(read(tab.id, ALL, "s1", "https://c.example"), NONE);
    await fake.browser.tabs.reload(tab.id);
    await flush();
    request(tab.id, "https://c.example/reloaded", { ...options, timeStamp: 2000 });
    assert.deepEqual(urlsOf(read(tab.id, ALL, "s1", "https://c.example")), [
      "https://c.example/reloaded",
    ]);
  });

  it("drops the old page's requests that end after the next commit", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const old = request(tab.id, `${SITE}/slow`);
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    fake.emitWebRequest("onSendHeaders", {
      requestId: old,
      tabId: tab.id,
      timeStamp: 1001,
      requestHeaders: [],
    });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: old,
      tabId: tab.id,
      timeStamp: 1002,
      statusCode: 200,
    });
    fake.emitWebRequest("onCompleted", {
      requestId: old,
      tabId: tab.id,
      timeStamp: 1003,
      statusCode: 200,
      fromCache: false,
    });
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 1001,
      requests: [],
      truncated: false,
    });
  });

  it("leaves out an earlier page's request that Firefox reports after the next commit", async () => {
    const { commit, fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    commit(tab.id, `${SITE}/next`, 2000);
    await flush();
    const old = request(tab.id, `${SITE}/old`, { timeStamp: 1999 });
    fake.emitWebRequest("onSendHeaders", {
      requestId: old,
      tabId: tab.id,
      timeStamp: 2002,
      requestHeaders: [],
    });
    fake.emitWebRequest("onCompleted", {
      requestId: old,
      tabId: tab.id,
      timeStamp: 2003,
      statusCode: 200,
      fromCache: false,
    });
    const next = { documentUrl: `${SITE}/next` };
    request(tab.id, `${SITE}/at-commit`, { ...next, timeStamp: 2000 });
    request(tab.id, `${SITE}/after`, { ...next, timeStamp: 2001 });
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/at-commit`, `${SITE}/after`]);
  });

  it("keeps only requests whose top-level document is on the log's site", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const kept: RequestOverrides[] = [
      { documentUrl: URL_A },
      { documentUrl: null, originUrl: `${SITE}/origin` },
      {
        frameId: 3,
        documentUrl: `${OTHER}/frame`,
        frameAncestors: [
          { url: `${OTHER}/frame-parent`, frameId: 2 },
          { url: URL_A, frameId: 0 },
        ],
      },
    ];
    const ignored: RequestOverrides[] = [
      { documentUrl: `${OTHER}/` },
      { documentUrl: `${OTHER}/`, originUrl: URL_A },
      { documentUrl: null },
      {
        frameId: 3,
        documentUrl: URL_A,
        frameAncestors: [
          { url: URL_A, frameId: 2 },
          { url: `${OTHER}/`, frameId: 0 },
        ],
      },
      { frameId: 3, documentUrl: URL_A, originUrl: URL_A },
      { frameId: 3, documentUrl: URL_A, frameAncestors: [] },
    ];
    for (const [index, details] of ignored.entries()) {
      request(tab.id, `${SITE}/ignored-${index}`, details);
    }
    for (const [index, details] of kept.entries()) {
      request(tab.id, `${SITE}/kept-${index}`, details);
    }
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/kept-0`, `${SITE}/kept-1`, `${SITE}/kept-2`]);
  });

  it("starts the page's log with its own request, from before and after the commit", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const page = request(tab.id, `${SITE}/next`, { type: "main_frame", timeStamp: 2000 });
    fake.emitWebRequest("onSendHeaders", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 2001,
      requestHeaders: [{ name: "Cookie", value: "secret" }],
    });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 2002,
      statusCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }],
    });
    // Not the current page's request.
    assert.deepEqual(read(tab.id).requests, []);
    fake.navigateByUser(tab.id, `${SITE}/next#part`);
    fake.emitWebRequest("onCompleted", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 2010,
      statusCode: 200,
      fromCache: false,
    });
    await flush();
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 2003,
      requests: [
        {
          url: `${SITE}/next`,
          method: "GET",
          type: "main_frame",
          startTime: 2000,
          durationMs: 10,
          status: 200,
          fromCache: false,
          requestHeaders: [{ name: "Cookie", value: REDACTED }],
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
        },
      ],
      truncated: false,
    });
  });

  it("carries a page's request that ended before its commit, and no other", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const done = request(tab.id, `${SITE}/done`, { type: "main_frame" });
    fake.emitWebRequest("onCompleted", {
      requestId: done,
      tabId: tab.id,
      timeStamp: 1100,
      statusCode: 200,
      fromCache: true,
    });
    // It ended: a later event for its id changes nothing, before its commit or after.
    const late = { requestId: done, tabId: tab.id, timeStamp: 1200, error: "NS_BINDING_ABORTED" };
    fake.emitWebRequest("onErrorOccurred", late);
    fake.navigateByUser(tab.id, `${SITE}/done`);
    await flush();
    fake.emitWebRequest("onErrorOccurred", late);
    assert.deepEqual(read(tab.id).requests, [
      {
        url: `${SITE}/done`,
        method: "GET",
        type: "main_frame",
        startTime: 1000,
        durationMs: 100,
        status: 200,
        fromCache: true,
        requestHeaders: [],
        responseHeaders: [],
      },
    ]);
    // Carried once: a commit of the same URL without a request of its own starts empty.
    fake.navigateByUser(tab.id, `${SITE}/done`);
    await flush();
    assert.deepEqual(read(tab.id).requests, []);

    request(tab.id, `${SITE}/elsewhere`, { type: "main_frame", timeStamp: 1250 });
    fake.navigateByUser(tab.id, `${SITE}/committed`);
    await flush();
    assert.deepEqual(read(tab.id).requests, []);

    const hop = request(tab.id, `${SITE}/hop`, { type: "main_frame", timeStamp: 1300 });
    fake.emitWebRequest("onBeforeRedirect", {
      requestId: hop,
      tabId: tab.id,
      timeStamp: 1310,
      statusCode: 302,
      redirectUrl: `${SITE}/final`,
      fromCache: false,
    });
    request(tab.id, `${SITE}/final`, { requestId: hop, type: "main_frame", timeStamp: 1320 });
    fake.navigateByUser(tab.id, `${SITE}/final`);
    await flush();
    fake.emitWebRequest("onCompleted", {
      requestId: hop,
      tabId: tab.id,
      timeStamp: 1350,
      statusCode: 200,
      fromCache: false,
    });
    assert.deepEqual(read(tab.id).requests, [
      {
        url: `${SITE}/final`,
        method: "GET",
        type: "main_frame",
        startTime: 1320,
        durationMs: 30,
        status: 200,
        fromCache: false,
        requestHeaders: [],
        responseHeaders: [],
      },
    ]);
  });

  it("puts the page's own request first when Firefox reports it after the commit", async () => {
    const { commit, fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1");
    const next = `${SITE}/next`;
    commit(tab.id, URL_A, 1000);
    commit(tab.id, `${next}#part`, 1600);
    request(tab.id, `${SITE}/early`, { documentUrl: next, timeStamp: 1610 });
    const page = request(tab.id, next, { type: "main_frame", timeStamp: 1500 });
    fake.emitWebRequest("onSendHeaders", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 1501,
      requestHeaders: [{ name: "Cookie", value: "secret" }],
    });
    await flush();
    fake.emitWebRequest("onHeadersReceived", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 1550,
      statusCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }],
    });
    fake.emitWebRequest("onCompleted", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 1700,
      statusCode: 200,
      fromCache: false,
    });
    // The page has its own request: another one of its URL, reported late too, is not it.
    request(tab.id, next, { type: "main_frame", timeStamp: 1550 });
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 1600,
      requests: [
        {
          url: next,
          method: "GET",
          type: "main_frame",
          startTime: 1500,
          durationMs: 200,
          status: 200,
          fromCache: false,
          requestHeaders: [{ name: "Cookie", value: REDACTED }],
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
        },
        {
          url: `${SITE}/early`,
          method: "GET",
          type: "xmlhttprequest",
          startTime: 1610,
          requestHeaders: [],
          responseHeaders: [],
        },
      ],
      truncated: false,
    });
  });

  it("leaves a request of the page's URL that starts after its commit to the next commit", async () => {
    const { commit, read, request, tabIn } = setup();
    const tab = await tabIn("s1");
    commit(tab.id, URL_A, 1000);
    await flush();
    // A reload, then the page's own request, reported after it.
    request(tab.id, URL_A, { type: "main_frame", timeStamp: 1001 });
    request(tab.id, URL_A, { type: "main_frame", timeStamp: 990 });
    assert.deepEqual(startTimesOf(read(tab.id)), [990]);
    commit(tab.id, URL_A, 1001);
    await flush();
    assert.deepEqual(startTimesOf(read(tab.id)), [1001]);
  });

  it("does not carry a request that started by the tab's previous commit", async () => {
    const { commit, read, request, sessions, tabIn } = setup();
    const tab = await tabIn("s1");
    const c = "https://c.example";
    commit(tab.id, `${c}/`, 1000);
    await flush();
    // The refused page's own request, reported after its commit.
    request(tab.id, `${c}/`, { type: "main_frame", timeStamp: 1000 });
    sessions.set("s1", { allowed: new Set([c]), refused: new Set(), closed: 0 });
    commit(tab.id, `${c}/`, 1100);
    await flush();
    assert.deepEqual(read(tab.id, ALL, "s1", c), {
      recording: true,
      since: 1100,
      requests: [],
      truncated: false,
    });
    request(tab.id, `${c}/`, { type: "main_frame", timeStamp: 1050 });
    assert.deepEqual(startTimesOf(read(tab.id, ALL, "s1", c)), [1050]);
  });

  it("carries no request of a navigation that never committed, whatever its time", async () => {
    const { commit, read, request, tabIn } = setup();
    const tab = await tabIn("s1");
    commit(tab.id, URL_A, 1000);
    // A download: its request commits no document.
    request(tab.id, `${SITE}/file`, { type: "main_frame", timeStamp: 1100 });
    // Reported after that request, although it is earlier.
    commit(tab.id, `${SITE}/next`, 1050);
    commit(tab.id, `${SITE}/file`, 1200);
    await flush();
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 1200,
      requests: [],
      truncated: false,
    });
  });

  it("puts a redirect's final hop first when reported after the commit, not its earlier hop", async () => {
    const { commit, fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1");
    commit(tab.id, URL_A, 1000);
    commit(tab.id, `${SITE}/final`, 1300);
    const hop = request(tab.id, `${SITE}/hop`, { type: "main_frame", timeStamp: 1100 });
    fake.emitWebRequest("onBeforeRedirect", {
      requestId: hop,
      tabId: tab.id,
      timeStamp: 1150,
      statusCode: 302,
      redirectUrl: `${SITE}/final`,
      fromCache: false,
    });
    request(tab.id, `${SITE}/final`, { requestId: hop, type: "main_frame", timeStamp: 1200 });
    fake.emitWebRequest("onCompleted", {
      requestId: hop,
      tabId: tab.id,
      timeStamp: 1350,
      statusCode: 200,
      fromCache: false,
    });
    await flush();
    assert.deepEqual(read(tab.id).requests, [
      {
        url: `${SITE}/final`,
        method: "GET",
        type: "main_frame",
        startTime: 1200,
        durationMs: 150,
        status: 200,
        fromCache: false,
        requestHeaders: [],
        responseHeaders: [],
      },
    ]);
  });

  it("keeps the requests made while the commit is checked once it passes, else drops them", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn } = setup();
    const hold = holdTabsGet(t, fake);
    const tab = await tabIn("s1", URL_A);
    const release = hold();
    fake.navigateByUser(tab.id, `${SITE}/next`);
    request(tab.id, `${SITE}/early`);
    await flush();
    assert.deepEqual(read(tab.id), NONE);
    release();
    await flush();
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/early`]);

    const refuse = hold();
    fake.navigateByUser(tab.id, "https://c.example/");
    request(tab.id, "https://c.example/early", { documentUrl: "https://c.example/" });
    refuse();
    await flush();
    assert.deepEqual(read(tab.id, ALL, "s1", "https://c.example"), NONE);
  });

  it("lets only the latest commit open or drop a tab's log", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, sessions } = setup();
    const hold = holdTabsGet(t, fake);
    const tab = await tabIn("s1", URL_A);
    // A refusal that ends after a newer commit passed.
    const refusal = hold();
    fake.navigateByUser(tab.id, "https://c.example/");
    fake.navigateByUser(tab.id, `${SITE}/second`);
    await flush();
    request(tab.id, `${SITE}/second-api`);
    refusal();
    await flush();
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/second-api`]);

    // An approval that ends after a newer commit on another site, still being checked.
    sessions.set("s1", { allowed: new Set(["https://c.example"]), refused: new Set(), closed: 0 });
    const first = hold();
    const second = hold();
    fake.navigateByUser(tab.id, `${SITE}/third`);
    fake.navigateByUser(tab.id, "https://c.example/");
    request(tab.id, "https://c.example/api", {
      documentUrl: "https://c.example/",
      timeStamp: 2000,
    });
    first();
    await flush();
    assert.deepEqual(read(tab.id, ALL, "s1", "https://c.example"), NONE);
    assert.deepEqual(read(tab.id), NONE);
    second();
    await flush();
    assert.deepEqual(urlsOf(read(tab.id, ALL, "s1", "https://c.example")), [
      "https://c.example/api",
    ]);
  });

  it("stops recording when the user withdraws the site, and records again from a new approval", async () => {
    const { fake, read, request, tabIn, sessions, access, clock } = setup();
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1", `${OTHER}/`);
    const other = await tabIn("s1", URL_A);
    const options = { documentUrl: `${OTHER}/` };
    request(tab.id, `${OTHER}/before`, options);
    request(other.id, `${SITE}/kept`);
    access.forget("s1", OTHER);
    assert.deepEqual(read(tab.id, ALL, "s1", OTHER), NONE);
    const gap = request(tab.id, `${OTHER}/gap`, { ...options, timeStamp: 3000 });
    await flush();
    assert.deepEqual(read(tab.id, ALL, "s1", OTHER), NONE);
    assert.deepEqual(urlsOf(read(other.id)), [`${SITE}/kept`]);
    clock.now = 4000;
    assert.deepEqual(await access.allowForSession("s1", [OTHER], () => true), [OTHER]);
    await flush();
    fake.emitWebRequest("onCompleted", {
      requestId: gap,
      tabId: tab.id,
      timeStamp: 4100,
      statusCode: 200,
      fromCache: false,
    });
    request(tab.id, `${OTHER}/after`, { ...options, timeStamp: 4000 });
    assert.deepEqual(read(tab.id, ALL, "s1", OTHER), {
      recording: true,
      since: 4000,
      requests: [
        {
          url: `${OTHER}/after`,
          method: "GET",
          type: "xmlhttprequest",
          startTime: 4000,
          requestHeaders: [],
          responseHeaders: [],
        },
      ],
      truncated: false,
    });
    assert.deepEqual(urlsOf(read(other.id)), [`${SITE}/kept`]);
    await reloadAndRead(fake, tab.id, OTHER, request, read);
  });

  it("stops recording when the tab leaves the group, and records again from its return", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, groups, clock } = setup();
    const tab = await tabIn("s1", URL_A);
    // Keeps the group open while the tab is out of it.
    await tabIn("s1");
    request(tab.id, `${SITE}/before`);
    fake.ungroup(tab.id);
    assert.deepEqual(read(tab.id), NONE);
    request(tab.id, `${SITE}/outside`, { timeStamp: 2000 });
    assert.deepEqual(read(tab.id), NONE);
    clock.now = 3000;
    await groups.ensureGroup("s1", tab);
    await flush();
    request(tab.id, `${SITE}/early`, { timeStamp: 2999 });
    request(tab.id, `${SITE}/back`, { timeStamp: 3000 });
    const back = read(tab.id);
    assert.equal(back.since, 3000);
    assert.deepEqual(urlsOf(back), [`${SITE}/back`]);
    await reloadAndRead(fake, tab.id, SITE, request, read);
  });

  it("stops recording when stored access no longer allows the site, until it does again", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, clock } = setup();
    const tab = await tabIn("s1", URL_A);
    request(tab.id, `${SITE}/before`);
    await revokeSite(fake.browser, SITE);
    await flush();
    assert.deepEqual(read(tab.id), NONE);
    request(tab.id, `${SITE}/gap`, { timeStamp: 2000 });
    clock.now = 3000;
    await grantSite(fake.browser, SITE);
    await flush();
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 3000,
      requests: [],
      truncated: false,
    });
    request(tab.id, `${SITE}/after`, { timeStamp: 3001 });
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/after`]);
    await reloadAndRead(fake, tab.id, SITE, request, read);
  });

  it("starts an empty log when the site of a page already open is approved", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, access, clock, network } = setup();
    const tab = await tabIn("s1", `${OTHER}/`);
    const options = { documentUrl: `${OTHER}/` };
    const early = request(tab.id, `${OTHER}/early`, { ...options, timeStamp: 2000 });
    assert.deepEqual(read(tab.id, ALL, "s1", OTHER), NONE);
    clock.now = 3000;
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    assert.deepEqual(read(tab.id, ALL, "s1", OTHER), {
      recording: true,
      since: 3000,
      requests: [],
      truncated: false,
    });
    // A request from before the approval: its later events find nothing to change.
    fake.emitWebRequest("onSendHeaders", {
      requestId: early,
      tabId: tab.id,
      timeStamp: 3010,
      requestHeaders: [],
    });
    fake.emitWebRequest("onCompleted", {
      requestId: early,
      tabId: tab.id,
      timeStamp: 3020,
      statusCode: 200,
      fromCache: false,
    });
    // Reported late, but started before the approval.
    request(tab.id, `${OTHER}/late`, { ...options, timeStamp: 2999 });
    // The page's own request, reported after: the log has no page request to take.
    request(tab.id, `${OTHER}/`, { type: "main_frame", timeStamp: 1500 });
    request(tab.id, `${OTHER}/`, { type: "main_frame", timeStamp: 3050 });
    request(tab.id, `${OTHER}/now`, { ...options, timeStamp: 3000 });
    assert.deepEqual(urlsOf(read(tab.id, ALL, "s1", OTHER)), [`${OTHER}/now`]);
    assert.equal(network.requestsSince(tab.id, 0).begun, 1);
  });

  it("leaves out what a page requested before an approval its commit's check saw", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, access, clock } = setup();
    const tab = await tabIn("s1");
    const held = Promise.withResolvers<void>();
    const get = fake.browser.storage.local.get;
    let first = true;
    t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      if (first) {
        first = false;
        await held.promise;
      }
      return Reflect.apply(get, fake.browser.storage.local, args);
    });
    const options = { documentUrl: `${OTHER}/` };
    fake.navigateByUser(tab.id, `${OTHER}/`);
    request(tab.id, `${OTHER}/before`, { ...options, timeStamp: 1010 });
    // The commit's gate is reading the settings.
    await flush();
    clock.now = 2000;
    await access.allowForSession("s1", [OTHER], () => true);
    held.resolve();
    await flush();
    request(tab.id, `${OTHER}/after`, { ...options, timeStamp: 2000 });
    const after = read(tab.id, ALL, "s1", OTHER);
    assert.equal(after.since, 2000);
    assert.deepEqual(urlsOf(after), [`${OTHER}/after`]);
  });

  it("stops recording when the tab shows another site without a commit", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    request(tab.id, `${SITE}/before`);
    fake.pushState(tab.id, `${SITE}/other#part`);
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/before`]);
    // As a page from another site restored from the back-forward cache, and then this one again.
    fake.pushState(tab.id, `${OTHER}/`);
    fake.pushState(tab.id, URL_A);
    assert.deepEqual(read(tab.id), NONE);
    request(tab.id, `${SITE}/after`);
    assert.deepEqual(read(tab.id), NONE);
    await reloadAndRead(fake, tab.id, SITE, request, read);
  });

  it("reads nothing for another session or another site", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    request(tab.id, `${SITE}/api`);
    assert.deepEqual(read(tab.id, ALL, "s2"), NONE);
    assert.deepEqual(read(tab.id, ALL, "s1", OTHER), NONE);
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/api`]);
  });

  it("keeps the newest 500 requests of a page", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    for (let index = 0; index < MAX_NETWORK_REQUESTS; index += 1) {
      request(tab.id, `${SITE}/${index}`);
    }
    assert.equal(read(tab.id).truncated, false);
    request(tab.id, `${SITE}/last`);
    const result = read(tab.id);
    assert.equal(result.requests.length, MAX_NETWORK_REQUESTS);
    assert.equal(result.requests[0]?.url, `${SITE}/1`);
    assert.equal(result.requests.at(-1)?.url, `${SITE}/last`);
    assert.equal(result.truncated, true);
    // Dropped from the log, not only left out of the read.
    assert.deepEqual(read(tab.id, { ...ALL, pattern: `${SITE}/0`, limit: 1 }).requests, []);
    assert.deepEqual(read(tab.id, { ...ALL, pattern: "/last", limit: 1 }).truncated, true);
  });

  it("drops a page's own request reported after its commit first when the log is full", async () => {
    const { commit, read, request, tabIn } = setup();
    const tab = await tabIn("s1");
    commit(tab.id, URL_A, 1000);
    await flush();
    for (let index = 0; index < MAX_NETWORK_REQUESTS; index += 1) {
      request(tab.id, `${SITE}/${index}`, { timeStamp: 1001 });
    }
    request(tab.id, URL_A, { type: "main_frame", timeStamp: 990 });
    const result = read(tab.id);
    assert.equal(result.requests.length, MAX_NETWORK_REQUESTS);
    assert.equal(result.requests[0]?.url, `${SITE}/0`);
    assert.equal(result.truncated, true);
    // Dropped from the log, not only left out of the read.
    assert.deepEqual(read(tab.id, { ...ALL, pattern: URL_A, limit: 1 }).requests, []);
  });

  it("keeps the newest requests within the page's character budget", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const headers = bigHeaders(98);
    const url = (index: number) =>
      `${SITE}/${String(index).padStart(3, "0")}`.padEnd(MAX_NETWORK_URL, "p");
    // url, method, type, and each header's name and value.
    const chars = MAX_NETWORK_URL + "GET".length + "xmlhttprequest".length + 98 * (5 + 1000);
    const fits = Math.floor(MAX_LOG_CHARS / chars);
    // So that leaving out what onBeforeRequest brings would keep one more.
    assert.notEqual(Math.floor(MAX_LOG_CHARS / (chars - MAX_NETWORK_URL - 17)), fits);
    const ids: string[] = [];
    for (let index = 0; index <= fits; index += 1) {
      const id = request(tab.id, url(index));
      ids.push(id);
      // Twice: an update counts the difference, not the whole entry again.
      for (const timeStamp of [1001, 1002]) {
        fake.emitWebRequest("onHeadersReceived", {
          requestId: id,
          tabId: tab.id,
          timeStamp,
          statusCode: 200,
          responseHeaders: headers,
        });
      }
    }
    const trimmed = read(tab.id);
    assert.equal(trimmed.truncated, true);
    assert.deepEqual(
      urlsOf(trimmed),
      Array.from({ length: fits }, (_, index) => url(index + 1)),
    );
    // A request dropped while open takes nothing more of the budget.
    fake.emitWebRequest("onSendHeaders", {
      requestId: ids[0] ?? "",
      tabId: tab.id,
      timeStamp: 1003,
      requestHeaders: headers,
    });
    for (let index = 0; index < 100; index += 1) request(tab.id, `${SITE}/small-${index}`);
    const after = read(tab.id);
    assert.equal(after.requests.length, fits + 100);
    assert.equal(after.requests[0]?.url, url(1));
  });

  it("counts the page's own request in the character budget", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const headers = bigHeaders(MAX_NETWORK_HEADERS);
    const page = request(tab.id, `${SITE}/next`, { type: "main_frame" });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: page,
      tabId: tab.id,
      timeStamp: 1001,
      statusCode: 200,
      responseHeaders: headers,
    });
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    const chars = (url: string, type: string) =>
      url.length + "GET".length + type.length + headers.length * (5 + 1000);
    const pageChars = chars(`${SITE}/next`, "main_frame");
    const each = chars(`${SITE}/000`, "xmlhttprequest");
    const count = Math.floor((MAX_LOG_CHARS - pageChars) / each) + 1;
    // Without the page's own request, all of them would fit.
    assert.ok(count * each <= MAX_LOG_CHARS);
    for (let index = 0; index < count; index += 1) {
      const id = request(tab.id, `${SITE}/${String(index).padStart(3, "0")}`, {
        timeStamp: 2000,
      });
      fake.emitWebRequest("onHeadersReceived", {
        requestId: id,
        tabId: tab.id,
        timeStamp: 2001,
        statusCode: 200,
        responseHeaders: headers,
      });
    }
    const result = read(tab.id);
    assert.equal(result.requests.length, count);
    assert.equal(result.requests[0]?.url, `${SITE}/000`);
    assert.equal(result.truncated, true);
  });

  it("records a tab whose id is 0", async () => {
    const { fake, groups, read, request, access } = setup();
    await grantSite(fake.browser, SITE);
    const tab = fake.openTab();
    fake.tabs.delete(tab.id);
    // The fake numbers tabs from 1; Firefox's ids are whole numbers of 0 or more.
    const zero: FakeTab = { ...tab, id: 0 };
    fake.tabs.set(0, zero);
    access.admit("s1");
    await groups.ensureGroup("s1", zero);
    request(0, `${SITE}/`, { type: "main_frame" });
    fake.navigateByUser(0, `${SITE}/`);
    await flush();
    const id = request(0, `${SITE}/api`, { timeStamp: 2000 });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: id,
      tabId: 0,
      timeStamp: 2001,
      statusCode: 204,
    });
    assert.deepEqual(
      read(0).requests.map(({ url, status }) => [url, status]),
      [
        [`${SITE}/`, undefined],
        [`${SITE}/api`, 204],
      ],
    );
  });

  it("returns the newest matching requests, matching the pattern as plain text", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    for (const path of ["/a.js", "/api/one", "/api.two", "/API/three", "/api/four"]) {
      request(tab.id, `${SITE}${path}`);
    }
    assert.deepEqual(urlsOf(read(tab.id, { ...ALL, pattern: "/api.", limit: 10 })), [
      `${SITE}/api.two`,
    ]);
    assert.deepEqual(urlsOf(read(tab.id, { ...ALL, pattern: "/API", limit: 10 })), [
      `${SITE}/API/three`,
    ]);
    assert.equal(read(tab.id, { ...ALL, pattern: "", limit: 10 }).requests.length, 5);
    assert.deepEqual(read(tab.id, { ...ALL, pattern: "/api/", limit: 1 }), {
      recording: true,
      since: 1,
      requests: [read(tab.id).requests[4]],
      truncated: true,
    });
    assert.deepEqual(read(tab.id, { ...ALL, pattern: "/api/", limit: 2 }).truncated, false);
    assert.deepEqual(urlsOf(read(tab.id, { ...ALL, limit: 2 })), [
      `${SITE}/API/three`,
      `${SITE}/api/four`,
    ]);
    assert.equal(read(tab.id, { ...ALL, limit: 5 }).truncated, false);
    assert.equal(read(tab.id, { ...ALL, limit: 4 }).truncated, true);
    assert.deepEqual(read(tab.id, { ...ALL, pattern: "nothing", limit: 1 }), {
      recording: true,
      since: 1,
      requests: [],
      truncated: false,
    });
  });

  it("keeps only the requests whose type is exactly one of the given types", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    for (const type of ["script", "image", "xmlhttprequest", "stylesheet", "script"]) {
      request(tab.id, `${SITE}/${type}`, { type });
    }
    assert.deepEqual(urlsOf(read(tab.id, { ...ALL, types: ["script"] })), [
      `${SITE}/script`,
      `${SITE}/script`,
    ]);
    assert.deepEqual(urlsOf(read(tab.id, { ...ALL, types: ["image", "script"] })), [
      `${SITE}/script`,
      `${SITE}/image`,
      `${SITE}/script`,
    ]);
    assert.deepEqual(
      read(tab.id, { ...ALL, types: ["stylesheet", "stylesheet"] }),
      read(tab.id, { ...ALL, types: ["stylesheet"] }),
    );
    assert.equal(read(tab.id, { ...ALL, types: ["stylesheet"] }).requests.length, 1);
    for (const types of [["font"], ["Script"], ["scrip"]]) {
      assert.deepEqual(read(tab.id, { ...ALL, types }), {
        recording: true,
        since: 1,
        requests: [],
        truncated: false,
      });
    }
    assert.deepEqual(read(tab.id, { ...ALL, types: ["script"] }, "s2"), NONE);
  });

  it("keeps only the requests that failed with failed", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const tabId = tab.id;
    const timeStamp = 1100;
    const done = (path: string, statusCode: number) => {
      const requestId = request(tabId, `${SITE}${path}`);
      fake.emitWebRequest("onCompleted", {
        requestId,
        tabId,
        timeStamp,
        statusCode,
        fromCache: false,
      });
    };
    done("/ok", 200);
    done("/399", 399);
    done("/400", 400);
    // Its headers arrived, its body still loads.
    const loading = request(tabId, `${SITE}/404`);
    fake.emitWebRequest("onHeadersReceived", {
      requestId: loading,
      tabId,
      timeStamp,
      statusCode: 404,
    });
    done("/500", 500);
    const moved = request(tabId, `${SITE}/moved`);
    fake.emitWebRequest("onBeforeRedirect", {
      requestId: moved,
      tabId,
      timeStamp,
      statusCode: 302,
      redirectUrl: `${SITE}/ok`,
      fromCache: false,
    });
    const refused = request(tabId, `${SITE}/refused`);
    fake.emitWebRequest("onErrorOccurred", {
      requestId: refused,
      tabId,
      timeStamp,
      error: "NS_ERROR_CONNECTION_REFUSED",
    });
    const cut = request(tabId, `${SITE}/cut`);
    fake.emitWebRequest("onHeadersReceived", {
      requestId: cut,
      tabId,
      timeStamp,
      statusCode: 200,
    });
    fake.emitWebRequest("onErrorOccurred", {
      requestId: cut,
      tabId,
      timeStamp,
      error: "NS_ERROR_NET_INTERRUPT",
    });
    request(tabId, `${SITE}/in-flight`);
    assert.deepEqual(
      urlsOf(read(tabId, { ...ALL, failed: true })),
      ["/400", "/404", "/500", "/refused", "/cut"].map((path) => `${SITE}${path}`),
    );
    assert.equal(read(tabId, { ...ALL, failed: true }).truncated, false);
    assert.equal(read(tabId, { ...ALL, failed: false }).requests.length, 9);
  });

  it("leaves both header lists out unless headers is true", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const tabId = tab.id;
    const id = request(tabId, `${SITE}/api`, { timeStamp: 1000 });
    fake.emitWebRequest("onSendHeaders", {
      requestId: id,
      tabId,
      timeStamp: 1001,
      requestHeaders: [{ name: "Accept", value: "*/*" }],
    });
    fake.emitWebRequest("onCompleted", {
      requestId: id,
      tabId,
      timeStamp: 1250,
      statusCode: 200,
      fromCache: true,
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
    });
    const moved = request(tabId, `${SITE}/old`, { timeStamp: 1300 });
    fake.emitWebRequest("onBeforeRedirect", {
      requestId: moved,
      tabId,
      timeStamp: 1310,
      statusCode: 301,
      redirectUrl: `${SITE}/new`,
      fromCache: false,
    });
    const broken = request(tabId, `${SITE}/broken`, { timeStamp: 1400 });
    fake.emitWebRequest("onErrorOccurred", {
      requestId: broken,
      tabId,
      timeStamp: 1450,
      error: "NS_ERROR_NET_RESET",
    });
    const without = read(tabId, { ...ALL, headers: false });
    assert.deepEqual(without, {
      recording: true,
      since: 1,
      requests: [
        {
          url: `${SITE}/api`,
          method: "GET",
          type: "xmlhttprequest",
          startTime: 1000,
          durationMs: 250,
          status: 200,
          fromCache: true,
        },
        {
          url: `${SITE}/old`,
          method: "GET",
          type: "xmlhttprequest",
          startTime: 1300,
          durationMs: 10,
          status: 301,
          redirectUrl: `${SITE}/new`,
          fromCache: false,
        },
        {
          url: `${SITE}/broken`,
          method: "GET",
          type: "xmlhttprequest",
          startTime: 1400,
          durationMs: 50,
          error: "NS_ERROR_NET_RESET",
        },
      ],
      truncated: false,
    });
    for (const returned of without.requests) {
      assert.equal(Object.hasOwn(returned, "requestHeaders"), false);
      assert.equal(Object.hasOwn(returned, "responseHeaders"), false);
    }
    assert.deepEqual(
      read(tabId, { ...ALL, headers: true }).requests.map(({ requestHeaders, responseHeaders }) => [
        requestHeaders,
        responseHeaders,
      ]),
      [
        [[{ name: "Accept", value: "*/*" }], [{ name: "Content-Type", value: "text/plain" }]],
        [[], []],
        [[], []],
      ],
    );
  });

  it("keeps the shape of what a request sent, read only with body true", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const tabId = tab.id;
    request(tabId, `${SITE}/next`, {
      type: "main_frame",
      method: "POST",
      timeStamp: 2000,
      requestBody: { formData: { username: ["alice-Nw1"], password: ["hunter-Nw2"] } },
    });
    fake.navigateByUser(tabId, `${SITE}/next`);
    await flush();
    request(tabId, `${SITE}/api`, {
      method: "POST",
      timeStamp: 3000,
      requestBody: { raw: [{ bytes: bytesOf('{"token":"token-Nw3","items":[]}') }] },
    });
    request(tabId, `${SITE}/get`, { timeStamp: 3001, requestBody: null });
    request(tabId, `${SITE}/plain`, { timeStamp: 3002 });
    const withBody = read(tabId, { ...ALL, headers: false });
    assert.deepEqual(withBody.requests, [
      {
        url: `${SITE}/next`,
        method: "POST",
        type: "main_frame",
        startTime: 2000,
        requestBody: {
          kind: "form",
          fields: [
            { name: "username", depth: 1, kind: "text", filled: true },
            { name: "password", depth: 1, kind: "text", filled: true },
          ],
        },
      },
      {
        url: `${SITE}/api`,
        method: "POST",
        type: "xmlhttprequest",
        startTime: 3000,
        requestBody: {
          kind: "json",
          fields: [
            { name: "token", depth: 1, kind: "string", filled: true },
            { name: "items", depth: 1, kind: "array", filled: false },
          ],
        },
      },
      { url: `${SITE}/get`, method: "GET", type: "xmlhttprequest", startTime: 3001 },
      { url: `${SITE}/plain`, method: "GET", type: "xmlhttprequest", startTime: 3002 },
    ]);
    const serialized = JSON.stringify(withBody);
    for (const secret of ["alice-Nw1", "hunter-Nw2", "token-Nw3"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    for (const options of [
      { ...ALL, body: false },
      { ...ALL, headers: false, body: false },
    ]) {
      const without = read(tabId, options);
      assert.equal(without.requests.length, 4);
      for (const returned of without.requests) {
        assert.equal(Object.hasOwn(returned, "requestBody"), false);
      }
    }
  });

  it("counts a request's body shape in the page's character budget", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const keys = Array.from({ length: MAX_NETWORK_BODY_FIELDS }, (_, index) =>
      `k${String(index).padStart(3, "0")}`.padEnd(100, "k"),
    );
    const body = JSON.stringify(Object.fromEntries(keys.map((key) => [key, 1])));
    const url = (index: number) =>
      `${SITE}/${String(index).padStart(3, "0")}`.padEnd(MAX_NETWORK_URL, "p");
    // url, method, type, the body's kind, and each field's name and kind.
    const plain = MAX_NETWORK_URL + "POST".length + "xmlhttprequest".length;
    const chars = plain + "json".length + MAX_NETWORK_BODY_FIELDS * (100 + "number".length);
    const fits = Math.floor(MAX_LOG_CHARS / chars);
    // So that leaving out the body's kind, or the fields' kinds or names, would keep one more.
    assert.ok(fits < MAX_NETWORK_REQUESTS);
    assert.notEqual(Math.floor(MAX_LOG_CHARS / (chars - "json".length)), fits);
    assert.notEqual(Math.floor(MAX_LOG_CHARS / (chars - MAX_NETWORK_BODY_FIELDS * 6)), fits);
    assert.notEqual(Math.floor(MAX_LOG_CHARS / (chars - MAX_NETWORK_BODY_FIELDS * 100)), fits);
    for (let index = 0; index <= fits; index += 1) {
      request(tab.id, url(index), {
        method: "POST",
        requestBody: { raw: [{ bytes: bytesOf(body) }] },
      });
    }
    const trimmed = read(tab.id);
    assert.equal(trimmed.truncated, true);
    assert.deepEqual(
      urlsOf(trimmed),
      Array.from({ length: fits }, (_, index) => url(index + 1)),
    );
  });

  it("applies pattern, types and failed together before the limit", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const tabId = tab.id;
    const sent: [string, string, number][] = [
      ["/api/1", "xmlhttprequest", 500],
      ["/api/2", "script", 500],
      ["/api/3", "xmlhttprequest", 200],
      ["/other/4", "xmlhttprequest", 404],
      ["/api/5", "xmlhttprequest", 503],
      ["/api/6", "xmlhttprequest", 404],
    ];
    for (const [path, type, statusCode] of sent) {
      const requestId = request(tabId, `${SITE}${path}`, { type });
      fake.emitWebRequest("onCompleted", {
        requestId,
        tabId,
        timeStamp: 1100,
        statusCode,
        fromCache: false,
      });
    }
    const options: NetworkReadOptions = {
      ...ALL,
      pattern: "/api/",
      types: ["xmlhttprequest"],
      failed: true,
    };
    assert.deepEqual(urlsOf(read(tabId, options)), [
      `${SITE}/api/1`,
      `${SITE}/api/5`,
      `${SITE}/api/6`,
    ]);
    assert.equal(read(tabId, options).truncated, false);
    assert.deepEqual(urlsOf(read(tabId, { ...options, limit: 2 })), [
      `${SITE}/api/5`,
      `${SITE}/api/6`,
    ]);
    assert.equal(read(tabId, { ...options, limit: 2 }).truncated, true);
    assert.equal(read(tabId, { ...options, limit: 3 }).truncated, false);
  });

  it("reports dropped requests as truncated whatever the filters", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    for (let index = 0; index <= MAX_NETWORK_REQUESTS; index += 1) {
      request(tab.id, `${SITE}/${index}`, { type: "script" });
    }
    assert.deepEqual(read(tab.id, { ...ALL, types: ["font"] }), {
      recording: true,
      since: 1,
      requests: [],
      truncated: true,
    });
    assert.equal(read(tab.id, { ...ALL, failed: true }).truncated, true);
  });

  it("forgets a closed tab's log and the request of the page it was loading", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, groups } = setup();
    const tab = await tabIn("s1", URL_A);
    request(tab.id, `${SITE}/api`);
    request(tab.id, `${SITE}/next`, { type: "main_frame" });
    fake.removeTab(tab.id);
    assert.deepEqual(read(tab.id), NONE);
    // The same tab id again, as a test can make it: nothing of the closed tab reaches it.
    fake.tabs.set(tab.id, { ...tab, url: "about:blank", groupId: -1, history: [], index: 0 });
    await groups.ensureGroup("s1", tab);
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    const reopened = read(tab.id);
    assert.equal(reopened.recording, true);
    assert.deepEqual(reopened.requests, []);
  });

  it("ignores requests that belong to no tab", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/api`);
    const details = { requestId: id, tabId: -1, timeStamp: 1001 };
    request(-1, `${SITE}/worker`);
    request(-1, `${SITE}/page`, { type: "main_frame" });
    fake.emitWebRequest("onSendHeaders", {
      ...details,
      requestHeaders: [{ name: "a", value: "" }],
    });
    fake.emitWebRequest("onHeadersReceived", { ...details, statusCode: 500 });
    fake.emitWebRequest("onBeforeRedirect", {
      ...details,
      statusCode: 302,
      redirectUrl: `${SITE}/`,
      fromCache: false,
    });
    fake.emitWebRequest("onCompleted", { ...details, statusCode: 500, fromCache: false });
    fake.emitWebRequest("onErrorOccurred", { ...details, error: "failed" });
    assert.deepEqual(read(tab.id).requests, [
      {
        url: `${SITE}/api`,
        method: "GET",
        type: "xmlhttprequest",
        startTime: 1000,
        requestHeaders: [],
        responseHeaders: [],
      },
    ]);
  });

  describe("requestsSince", () => {
    it("gives the latest end of the requests that ended, whatever their order", async () => {
      const { fake, network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      const ends: [string, number][] = [
        [request(tab.id, `${SITE}/long`, { timeStamp: 1000 }), 1500],
        [request(tab.id, `${SITE}/short`, { timeStamp: 1100 }), 1200],
        [request(tab.id, `${SITE}/failed`, { timeStamp: 1200 }), 1300],
      ];
      for (const [requestId, timeStamp] of ends) {
        const details = { requestId, tabId: tab.id, timeStamp };
        if (requestId === ends[2]?.[0]) {
          fake.emitWebRequest("onErrorOccurred", { ...details, error: "failed" });
        } else {
          fake.emitWebRequest("onCompleted", { ...details, statusCode: 200, fromCache: false });
        }
      }
      assert.deepEqual(network.requestsSince(tab.id, 1000), {
        begun: 3,
        open: 0,
        lastEnd: 1500,
        lastFetchEnd: 1500,
      });
      assert.deepEqual(network.requestsSince(tab.id, 1100), {
        begun: 2,
        open: 0,
        lastEnd: 1300,
        lastFetchEnd: 1300,
      });
    });

    it("gives the latest end of the top document's fetches apart from that of every request", async () => {
      const { fake, network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      const ends: [string, number][] = [
        [request(tab.id, `${SITE}/api`, { timeStamp: 1000 }), 1200],
        [request(tab.id, `${SITE}/early`, { timeStamp: 1000 }), 1100],
        [request(tab.id, `${SITE}/pixel.png`, { timeStamp: 1000, type: "image" }), 1500],
        [request(tab.id, `${SITE}/app.js`, { timeStamp: 1000, type: "script" }), 1400],
      ];
      for (const [requestId, timeStamp] of ends) {
        const details = { requestId, tabId: tab.id, timeStamp };
        fake.emitWebRequest("onCompleted", { ...details, statusCode: 200, fromCache: false });
      }
      assert.deepEqual(network.requestsSince(tab.id, 1000), {
        begun: 4,
        open: 0,
        lastEnd: 1500,
        lastFetchEnd: 1200,
      });
    });

    it("gives no fetch end while no fetch begun since the time ended", async () => {
      const { fake, network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      const before = request(tab.id, `${SITE}/before`, { timeStamp: 999 });
      request(tab.id, `${SITE}/open`, { timeStamp: 1000 });
      const image = request(tab.id, `${SITE}/pixel.png`, { timeStamp: 1000, type: "image" });
      for (const [requestId, timeStamp] of [
        [before, 1300],
        [image, 1200],
      ] as const) {
        const details = { requestId, tabId: tab.id, timeStamp };
        fake.emitWebRequest("onCompleted", { ...details, statusCode: 200, fromCache: false });
      }
      assert.deepEqual(network.requestsSince(tab.id, 1000), { begun: 2, open: 1, lastEnd: 1200 });
    });

    it("gives no fetch end for a frame's fetch, which ends like any request", async () => {
      const { fake, network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      const framed = request(tab.id, `${SITE}/frame-api`, {
        frameId: 3,
        documentUrl: `${SITE}/frame`,
        frameAncestors: [{ url: URL_A, frameId: 0 }],
      });
      fake.emitWebRequest("onCompleted", {
        requestId: framed,
        tabId: tab.id,
        timeStamp: 1200,
        statusCode: 200,
        fromCache: false,
      });
      assert.deepEqual(network.requestsSince(tab.id, 1000), { begun: 1, open: 0, lastEnd: 1200 });
    });

    it("counts the requests begun at or after the time, and those of them not ended", async () => {
      const { fake, network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      request(tab.id, `${SITE}/before`, { timeStamp: 999 });
      const ended = request(tab.id, `${SITE}/at`, { timeStamp: 1000 });
      request(tab.id, `${SITE}/after`, { timeStamp: 1001 });
      fake.emitWebRequest("onCompleted", {
        requestId: ended,
        tabId: tab.id,
        timeStamp: 1002,
        statusCode: 200,
        fromCache: false,
      });
      assert.deepEqual(network.requestsSince(tab.id, 1000), {
        begun: 2,
        open: 1,
        lastEnd: 1002,
        lastFetchEnd: 1002,
      });
      assert.deepEqual(network.requestsSince(tab.id, 999), {
        begun: 3,
        open: 2,
        lastEnd: 1002,
        lastFetchEnd: 1002,
      });
      assert.deepEqual(network.requestsSince(tab.id, 1001), { begun: 1, open: 1 });
      assert.deepEqual(network.requestsSince(tab.id, 1002), { begun: 0, open: 0 });
    });

    it("leaves out websockets, media, beacons, pings and CSP reports", async () => {
      const { network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      for (const type of ["websocket", "media", "beacon", "ping", "csp_report"]) {
        request(tab.id, `${SITE}/${type}`, { type });
      }
      assert.deepEqual(network.requestsSince(tab.id, 1000), { begun: 0, open: 0 });
      for (const type of ["xmlhttprequest", "script", "image", "sub_frame"]) {
        request(tab.id, `${SITE}/${type}`, { type });
      }
      assert.deepEqual(network.requestsSince(tab.id, 1000), { begun: 4, open: 4 });
    });

    it("counts only the tab's own live document, and nothing for a tab without one", async (t) => {
      quiet(t);
      const { fake, network, request, tabIn } = setup();
      const tab = await tabIn("s1", URL_A);
      const other = await tabIn("s1", URL_A);
      request(other.id, `${SITE}/api`);
      assert.deepEqual(network.requestsSince(tab.id, 0), { begun: 0, open: 0 });
      assert.deepEqual(network.requestsSince(other.id, 0), { begun: 1, open: 1 });
      assert.deepEqual(network.requestsSince(99, 0), { begun: 0, open: 0 });
      fake.navigateByUser(other.id, "https://b.example/");
      await flush();
      assert.deepEqual(network.requestsSince(other.id, 0), { begun: 0, open: 0 });
    });
  });

  it("adds six non-blocking listeners for every URL, which return nothing", async () => {
    const { fake, request, tabIn } = setup();
    assert.deepEqual(fake.webRequestRegistrations, [
      {
        event: "onBeforeRequest",
        filter: { urls: ["<all_urls>"] },
        extraInfoSpec: ["requestBody"],
      },
      {
        event: "onSendHeaders",
        filter: { urls: ["<all_urls>"] },
        extraInfoSpec: ["requestHeaders"],
      },
      {
        event: "onHeadersReceived",
        filter: { urls: ["<all_urls>"] },
        extraInfoSpec: ["responseHeaders"],
      },
      { event: "onBeforeRedirect", filter: { urls: ["<all_urls>"] } },
      {
        event: "onCompleted",
        filter: { urls: ["<all_urls>"] },
        extraInfoSpec: ["responseHeaders"],
      },
      { event: "onErrorOccurred", filter: { urls: ["<all_urls>"] } },
    ]);
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/api`);
    const details = { requestId: id, tabId: tab.id, timeStamp: 1001 };
    const returned = [
      fake.emitWebRequest("onBeforeRequest", {
        ...details,
        requestId: "other",
        frameId: 0,
        url: `${SITE}/x`,
        method: "GET",
        type: "image",
        documentUrl: URL_A,
      }),
      fake.emitWebRequest("onSendHeaders", { ...details, requestHeaders: [] }),
      fake.emitWebRequest("onHeadersReceived", { ...details, statusCode: 200 }),
      fake.emitWebRequest("onBeforeRedirect", {
        ...details,
        statusCode: 302,
        redirectUrl: `${SITE}/`,
        fromCache: false,
      }),
      fake.emitWebRequest("onCompleted", { ...details, statusCode: 200, fromCache: false }),
      fake.emitWebRequest("onErrorOccurred", { ...details, error: "failed" }),
    ];
    assert.deepEqual(returned, [
      [undefined],
      [undefined],
      [undefined],
      [undefined],
      [undefined],
      [undefined],
    ]);
  });

  it("returns copies that a caller cannot change the log through", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const id = request(tab.id, `${SITE}/api`);
    fake.emitWebRequest("onSendHeaders", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1001,
      requestHeaders: [{ name: "Accept", value: "*/*" }],
    });
    fake.emitWebRequest("onHeadersReceived", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1002,
      statusCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
    });
    const before = structuredClone(read(tab.id));
    const [first] = read(tab.id).requests;
    assert.ok(first !== undefined);
    first.url = "changed";
    first.status = 500;
    assert.ok(first.requestHeaders !== undefined && first.responseHeaders !== undefined);
    first.requestHeaders.push({ name: "X", value: "y" });
    const header = first.responseHeaders[0];
    assert.ok(header !== undefined);
    header.value = "changed";
    assert.deepEqual(read(tab.id), before);
  });

  it("returns copies of a body shape that a caller cannot change the log through", async () => {
    const { read, request, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    request(tab.id, `${SITE}/api`, {
      method: "POST",
      requestBody: { formData: { username: ["alice-Cp1"] } },
    });
    const before = structuredClone(read(tab.id));
    const shape = read(tab.id).requests[0]?.requestBody;
    assert.ok(shape?.fields !== undefined);
    shape.kind = "other";
    shape.truncated = true;
    const field = shape.fields[0];
    assert.ok(field !== undefined);
    field.name = "changed";
    field.filled = false;
    shape.fields.push({ name: "added", depth: 1, kind: "text" });
    assert.deepEqual(read(tab.id), before);
  });
});

describe("network log response bodies", { timeout: 10000 }, () => {
  it("copies an approved fetch's response and returns it only with responseBody true", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/api`, { method: "POST" });
    const other = request(tab.id, `${SITE}/other`);
    assert.equal(fake.streamFilters.length, 2);
    respond(fake, tab.id, id, '{"error":"invalid token"}', 500);
    assert.deepEqual(filterFor(fake, id)?.writtenText(), '{"error":"invalid token"}');
    const [first, second] = read(tab.id).requests;
    assert.deepEqual(first?.responseBody, { text: '{"error":"invalid token"}' });
    assert.equal(first?.status, 500);
    assert.equal(second?.responseBody, undefined);
    assert.equal(
      read(tab.id, { ...ALL, responseBody: false }).requests[0]?.responseBody,
      undefined,
    );
    assert.deepEqual(
      read(tab.id, { ...ALL, pattern: "/api" }).requests.map((entry) => entry.responseBody),
      [{ text: '{"error":"invalid token"}' }],
    );
    respond(fake, tab.id, other, "plain", 200, "text/plain");
    assert.deepEqual(read(tab.id, { ...ALL, pattern: "/other" }).requests[0]?.responseBody, {
      text: "plain",
    });
  });

  it("returns a copy of a body that a caller cannot change the log through", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    respond(fake, tab.id, request(tab.id, `${SITE}/api`), "{}");
    const body = read(tab.id).requests[0]?.responseBody;
    assert.ok(body !== undefined);
    body.text = "changed";
    body.truncated = true;
    assert.deepEqual(read(tab.id).requests[0]?.responseBody, { text: "{}" });
  });

  it("attaches a filter only to the fetches of the page and its frames to approved sites", async () => {
    const { fake, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const frame = {
      frameId: 3,
      documentUrl: `${OTHER}/frame`,
      frameAncestors: [{ url: URL_A, frameId: 0 }],
    };
    const refused = [
      request(tab.id, `${OTHER}/api`),
      request(tab.id, `${OTHER}/api`, frame),
      request(tab.id, `${SITE}/script.js`, { type: "script" }),
      request(tab.id, `${SITE}/image.png`, { type: "image" }),
      request(tab.id, `${SITE}/sub`, { type: "sub_frame" }),
    ];
    const allowed = [request(tab.id, `${SITE}/api`), request(tab.id, `${SITE}/api`, frame)];
    assert.deepEqual(
      fake.streamFilters.map((filter) => filter.requestId),
      allowed,
    );
    for (const id of refused) assert.equal(filterFor(fake, id), undefined);
  });

  it("attaches no filter to a request to a blocklisted site, approved or not", async () => {
    const { fake, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    await grantSite(fake.browser, OTHER);
    await flush();
    const before = request(tab.id, `${OTHER}/api`);
    await saveBlocklist(fake.browser, ["b.example"]);
    await flush();
    const after = request(tab.id, `${OTHER}/api`);
    const frame = request(tab.id, `${OTHER}/api`, {
      frameId: 3,
      documentUrl: `${OTHER}/frame`,
      frameAncestors: [{ url: URL_A, frameId: 0 }],
    });
    const own = request(tab.id, `${SITE}/api`);
    assert.deepEqual(
      fake.streamFilters.map((filter) => filter.requestId),
      [before, own],
    );
    assert.equal(filterFor(fake, after), undefined);
    assert.equal(filterFor(fake, frame), undefined);
  });

  it("attaches no filter before the log started, while its page is checked, or outside a session", async (t) => {
    const { fake, request, tabIn, commit } = setup();
    const tab = await liveTab(tabIn);
    request(tab.id, `${SITE}/early`, { timeStamp: 0 });
    const hold = holdTabsGet(t, fake);
    const release = hold();
    commit(tab.id, `${SITE}/next`, 2000);
    request(tab.id, `${SITE}/checking`, { documentUrl: `${SITE}/next`, timeStamp: 2001 });
    assert.equal(fake.streamFilters.length, 0);
    release();
    await flush();
    await flush();
    const later = request(tab.id, `${SITE}/later`, {
      documentUrl: `${SITE}/next`,
      timeStamp: 2002,
    });
    assert.deepEqual(
      fake.streamFilters.map((filter) => filter.requestId),
      [later],
    );
    const outside = fake.openTab();
    fake.navigateByUser(outside.id, URL_A);
    await flush();
    request(outside.id, `${SITE}/api`);
    assert.equal(fake.streamFilters.length, 1);
  });

  it("attaches no filter when Firefox refuses one", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    fake.failFilterResponseData = true;
    request(tab.id, `${SITE}/api`);
    assert.deepEqual(urlsOf(read(tab.id)), [`${SITE}/api`]);
    fake.failFilterResponseData = false;
    request(tab.id, `${SITE}/api`);
    assert.equal(fake.streamFilters.length, 1);
  });

  it("forgets the site check at once on a settings change, a grant, a withdrawal and a stop", async (t) => {
    const { fake, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    const hold = holdViews(t, access);
    const changes: [string, () => unknown][] = [
      ["settings", () => grantSite(fake.browser, "https://c.example")],
      ["grant", () => access.allowForSession("s1", ["https://d.example"], () => true)],
      ["withdrawal", () => access.forget("s1", OTHER)],
    ];
    for (const [name, change] of changes) {
      await flush();
      const release = hold();
      const before = fake.streamFilters.length;
      await change();
      request(tab.id, `${SITE}/miss`);
      assert.equal(fake.streamFilters.length, before, name);
      release();
      await flush();
      request(tab.id, `${SITE}/hit`);
      assert.equal(fake.streamFilters.length, before + 1, name);
    }
    hold();
    access.stop("s1");
    request(tab.id, `${SITE}/stopped`);
    assert.equal(fake.streamFilters.length, 3);
  });

  it("throws away a site check that started before access changed", async (t) => {
    const { fake, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", {
      allowed: new Set([OTHER, "https://c.example"]),
      refused: new Set(),
      closed: 0,
    });
    const hold = holdViews(t, access);
    const first = hold();
    const second = hold();
    access.forget("s1", OTHER);
    access.forget("s1", "https://c.example");
    first();
    await flush();
    request(tab.id, `${SITE}/stale`);
    assert.equal(fake.streamFilters.length, 0);
    second();
    await flush();
    request(tab.id, `${SITE}/fresh`);
    assert.equal(fake.streamFilters.length, 1);
  });

  it("stores nothing once the request's own site is withdrawn or blocklisted", async () => {
    const { fake, read, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    await grantSite(fake.browser, "https://c.example");
    await flush();
    const granted = request(tab.id, `${OTHER}/api`);
    const stored = request(tab.id, "https://c.example/api");
    const own = request(tab.id, `${SITE}/api`);
    for (const id of [granted, stored, own]) {
      fake.emitWebRequest("onHeadersReceived", headersOf(tab.id, id));
      filterFor(fake, id)?.data("{");
    }
    access.forget("s1", OTHER);
    await flush();
    await saveBlocklist(fake.browser, ["c.example"]);
    await flush();
    for (const id of [granted, stored, own]) {
      filterFor(fake, id)?.data("}");
      filterFor(fake, id)?.stop();
    }
    assert.deepEqual(
      read(tab.id).requests.map((entry) => entry.responseBody),
      [undefined, undefined, { text: "{}" }],
    );
    for (const id of [granted, stored]) {
      assert.equal(filterFor(fake, id)?.disconnects, 0, id);
      assert.equal(filterFor(fake, id)?.writtenText(), "{}", id);
      assert.equal(filterFor(fake, id)?.closes, 1, id);
    }
  });

  it("forgets the stored bodies of a site once it is withdrawn or blocklisted", async (t) => {
    const { fake, read, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    await grantSite(fake.browser, "https://c.example");
    await flush();
    for (const url of [`${OTHER}/api`, "https://c.example/api", `${SITE}/api`]) {
      respond(fake, tab.id, request(tab.id, url), "{}");
    }
    const bodies = () => read(tab.id).requests.map((entry) => entry.responseBody?.text);
    assert.deepEqual(bodies(), ["{}", "{}", "{}"]);
    const release = holdViews(t, access)();
    access.forget("s1", OTHER);
    // While the site check is read again, no body is given.
    assert.deepEqual(bodies(), [undefined, undefined, undefined]);
    release();
    await flush();
    assert.deepEqual(bodies(), [undefined, "{}", "{}"]);
    await saveBlocklist(fake.browser, ["c.example"]);
    await flush();
    assert.deepEqual(bodies(), [undefined, undefined, "{}"]);
    await access.allowForSession("s1", [OTHER], () => true);
    await saveBlocklist(fake.browser, []);
    await flush();
    assert.deepEqual(bodies(), [undefined, undefined, "{}"]);
    const budget = read(tab.id, { ...ALL, responseBody: false }).requests;
    assert.equal(budget.length, 3);
  });

  it("keeps nothing that arrived while the site check was being read again", async (t) => {
    const { fake, read, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    // A settings change reads the session's site check again, with OTHER granted.
    await grantSite(fake.browser, "https://c.example");
    await flush();
    const id = request(tab.id, `${OTHER}/api`);
    fake.emitWebRequest("onHeadersReceived", headersOf(tab.id, id));
    filterFor(fake, id)?.data("{");
    const release = holdViews(t, access)();
    access.forget("s1", OTHER);
    filterFor(fake, id)?.data('"while":"withdrawn"');
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    filterFor(fake, id)?.data("}");
    filterFor(fake, id)?.stop();
    release();
    await flush();
    assert.equal(read(tab.id).requests[0]?.responseBody, undefined);
    assert.equal(filterFor(fake, id)?.disconnects, 0);
    assert.equal(filterFor(fake, id)?.status, "closed");
    assert.equal(filterFor(fake, id)?.closes, 1);
    assert.equal(filterFor(fake, id)?.writtenText(), '{"while":"withdrawn"}');
  });

  it("waits for the site check at the stop, then stores", async (t) => {
    const { fake, read, request, tabIn, access } = setup();
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/api`);
    fake.emitWebRequest("onHeadersReceived", headersOf(tab.id, id));
    filterFor(fake, id)?.data("{}");
    const release = holdViews(t, access)();
    await grantSite(fake.browser, "https://c.example");
    filterFor(fake, id)?.stop();
    assert.equal(read(tab.id).requests[0]?.responseBody, undefined);
    release();
    await flush();
    assert.deepEqual(read(tab.id).requests[0]?.responseBody, { text: "{}" });
  });

  it("releases the session's captures when a site check fails, with a warning", async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    const { fake, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    const id = request(tab.id, `${SITE}/api`);
    filterFor(fake, id)?.data("{");
    t.mock.method(access, "view", async () => {
      throw new Error("storage failed");
    });
    // A withdrawal of a site no tab shows: only the network log reads the view.
    access.forget("s1", OTHER);
    await flush();
    // A capture still open would ask for the site check again at the next chunk.
    filterFor(fake, id)?.data("}");
    await flush();
    assert.equal(filterFor(fake, id)?.disconnects, 0);
    assert.equal(filterFor(fake, id)?.writtenText(), "{}");
    assert.deepEqual(
      warnings.mock.calls.map((call) => JSON.parse(String(call.arguments[0]))),
      [{ event: "network_recording_failed", error: "Error: storage failed" }],
    );
  });

  it("reads a session's site check once at a time, and again after one failed", async (t) => {
    quiet(t);
    const { fake, request, tabIn, access, sessions } = setup();
    const tab = await liveTab(tabIn);
    sessions.set("s1", { allowed: new Set([OTHER]), refused: new Set(), closed: 0 });
    const view = access.view;
    const { promise, resolve } = Promise.withResolvers<void>();
    let fails = 1;
    const reads = t.mock.method(access, "view", async (session: string) => {
      await promise;
      if (fails > 0) {
        fails -= 1;
        throw new Error("storage failed");
      }
      return view(session);
    });
    access.forget("s1", OTHER);
    request(tab.id, `${SITE}/a`);
    request(tab.id, `${SITE}/b`);
    assert.equal(reads.mock.callCount(), 1);
    resolve();
    await flush();
    request(tab.id, `${SITE}/c`);
    assert.equal(reads.mock.callCount(), 2);
    await flush();
    request(tab.id, `${SITE}/d`);
    assert.equal(fake.streamFilters.length, 1);
  });

  it("reads the type from onCompleted when no headers came before", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/api`);
    filterFor(fake, id)?.data("{}");
    filterFor(fake, id)?.stop();
    assert.equal(read(tab.id).requests[0]?.responseBody, undefined);
    fake.emitWebRequest("onCompleted", {
      requestId: id,
      tabId: tab.id,
      timeStamp: 1200,
      statusCode: 200,
      fromCache: true,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    });
    assert.deepEqual(read(tab.id).requests[0]?.responseBody, { text: "{}" });
  });

  it("forgets the log of a page whose check refuses it", async () => {
    const { fake, network, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    fake.navigateByUser(tab.id, "https://refused.example/");
    await flush();
    request(tab.id, "https://refused.example/api", {
      documentUrl: "https://refused.example/",
      timeStamp: 9e12,
    });
    assert.deepEqual(network.requestsSince(tab.id, 0), { begun: 0, open: 0 });
  });

  it("releases the captures of a log that new access to its page replaced before it was dropped", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, access, sessions, clock } = setup();
    sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/api`);
    filterFor(fake, id)?.data("{");
    clock.now = 3000;
    // The log's own site check waits, so nothing reads the tab's log before access starts again.
    const release = holdViews(t, access)();
    access.forget("s1", SITE);
    await flush();
    await flush();
    assert.equal(holdsOf(fake).length, 1);
    assert.ok(released(filterFor(fake, id)));
    filterFor(fake, id)?.data("}");
    filterFor(fake, id)?.stop();
    assert.equal(filterFor(fake, id)?.disconnects, 0);
    assert.equal(filterFor(fake, id)?.writtenText(), "{}");
    assert.equal(filterFor(fake, id)?.closes, 1);
    release();
    await flush();
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 3000,
      requests: [],
      truncated: false,
    });
  });

  it("releases quietly when a stopped session's site check refuses", async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    const { fake, request, tabIn, access } = setup();
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/api`);
    filterFor(fake, id)?.data("{");
    access.stop("s1");
    await flush();
    assert.ok(released(filterFor(fake, id)));
    filterFor(fake, id)?.data("}");
    await flush();
    assert.equal(filterFor(fake, id)?.disconnects, 0);
    assert.equal(filterFor(fake, id)?.writtenText(), "{}");
    assert.deepEqual(
      warnings.mock.calls.filter((call) => String(call.arguments[0]).includes("stopped")),
      [],
    );
  });

  it("holds the recorded tab's fetches with a blocking listener that returns at once", async (t) => {
    quiet(t);
    const { fake, request, tabIn, commit } = setup();
    const outside = fake.openTab();
    fake.navigateByUser(outside.id, URL_A);
    await flush();
    const tab = await liveTab(tabIn);
    assert.deepEqual(holdsOf(fake), [
      {
        event: "onBeforeRequest",
        filter: { urls: ["<all_urls>"], types: ["xmlhttprequest"], tabId: tab.id },
        extraInfoSpec: ["blocking"],
      },
    ]);
    const details: RequestDetails = {
      requestId: "held",
      tabId: tab.id,
      timeStamp: 1000,
      frameId: 0,
      url: `${SITE}/api`,
      method: "GET",
      type: "xmlhttprequest",
      documentUrl: URL_A,
    };
    assert.deepEqual(fake.emitWebRequest("onBeforeRequest", details), [undefined, undefined]);
    assert.deepEqual(
      fake.emitWebRequest("onBeforeRequest", { ...details, requestId: "out", tabId: outside.id }),
      [undefined],
    );
    // A commit drops it until the new page is live.
    const hold = holdTabsGet(t, fake);
    const release = hold();
    commit(tab.id, `${SITE}/next`, 2000);
    assert.deepEqual(holdsOf(fake), []);
    release();
    await flush();
    await flush();
    assert.equal(holdsOf(fake).length, 1);
    // A refused page has none.
    fake.navigateByUser(tab.id, "https://refused.example/");
    await flush();
    assert.deepEqual(holdsOf(fake), []);
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.equal(holdsOf(fake).length, 1);
    fake.removeTab(tab.id);
    assert.deepEqual(holdsOf(fake), []);
    request(tab.id, `${SITE}/closed`);
    assert.equal(fake.streamFilters.length, 1);
  });

  it("drops the hold and the captures with a log that stopped being live", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    // Keeps the group open while the tab is out of it.
    await tabIn("s1");
    const id = request(tab.id, `${SITE}/api`);
    fake.ungroup(tab.id);
    assert.equal(holdsOf(fake).length, 1);
    assert.deepEqual(read(tab.id), NONE);
    assert.deepEqual(holdsOf(fake), []);
    assert.equal(filterFor(fake, id)?.status, "uninitialized");
    filterFor(fake, id)?.start();
    assert.equal(filterFor(fake, id)?.status, "disconnected");
  });

  it("keeps one hold when access to the page starts again and releases the old captures", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, access, sessions, clock } = setup();
    sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/api`);
    filterFor(fake, id)?.data("{");
    clock.now = 3000;
    // The stored approval still allows the site: access starts again, empty.
    access.forget("s1", SITE);
    await flush();
    await flush();
    assert.equal(holdsOf(fake).length, 1);
    assert.equal(filterFor(fake, id)?.status, "transferringdata");
    assert.equal(filterFor(fake, id)?.disconnects, 0);
    assert.ok(released(filterFor(fake, id)));
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 3000,
      requests: [],
      truncated: false,
    });
    const next = request(tab.id, `${SITE}/next`, { timeStamp: 3000 });
    respond(fake, tab.id, next, "{}");
    assert.deepEqual(read(tab.id).requests[0]?.responseBody, { text: "{}" });
  });

  it("holds and copies nothing in its tabs once the session ended, and reads no gap later", async (t) => {
    quiet(t);
    const { fake, read, request, tabIn, access, clock } = setup();
    const tab = await liveTab(tabIn);
    access.endSession("s1");
    clock.now = 2000;
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    await flush();
    assert.deepEqual(holdsOf(fake), []);
    const filters = fake.streamFilters.length;
    request(tab.id, `${SITE}/gap`, { documentUrl: `${SITE}/next`, timeStamp: 2000 });
    assert.equal(fake.streamFilters.length, filters);
    clock.now = 3000;
    access.admit("s1");
    await flush();
    await flush();
    assert.deepEqual(read(tab.id), {
      recording: true,
      since: 3000,
      requests: [],
      truncated: false,
    });
    assert.equal(holdsOf(fake).length, 1);
  });

  it("releases a capture at a redirect, and the next hop decides on its own URL", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    await saveBlocklist(fake.browser, ["b.example"]);
    await flush();
    const id = request(tab.id, `${SITE}/a`);
    const first = filterFor(fake, id);
    fake.emitWebRequest("onHeadersReceived", headersOf(tab.id, id, 302));
    first?.data("{");
    fake.emitWebRequest("onBeforeRedirect", redirectOf(tab.id, id, `${OTHER}/b`));
    // A capture still open would store what the first hop passes on after the redirect.
    first?.data("}");
    first?.stop();
    assert.equal(first?.disconnects, 0);
    assert.equal(first?.closes, 1);
    request(tab.id, `${OTHER}/b`, { requestId: id });
    assert.equal(fake.streamFilters.length, 1);
    const hop = request(tab.id, `${SITE}/c`);
    fake.emitWebRequest("onBeforeRedirect", redirectOf(tab.id, hop, `${SITE}/d`));
    const old = filterFor(fake, hop);
    request(tab.id, `${SITE}/d`, { requestId: hop });
    const next = filterFor(fake, hop);
    assert.ok(next !== undefined && next !== old);
    // The first hop's filter errors after the next hop attached.
    old?.fail("Channel redirected");
    respond(fake, tab.id, hop, "{}");
    assert.deepEqual(
      read(tab.id).requests.map((entry) => entry.responseBody),
      [undefined, undefined, undefined, { text: "{}" }],
    );
  });

  it("releases a hop that did not end when the same request starts again", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const id = request(tab.id, `${SITE}/a`);
    const first = filterFor(fake, id);
    fake.emitWebRequest("onHeadersReceived", headersOf(tab.id, id));
    first?.data("{");
    request(tab.id, `${SITE}/a`, { requestId: id });
    // A capture still open would store what the first hop passes on after it.
    first?.data("}");
    first?.stop();
    assert.equal(first?.disconnects, 0);
    assert.equal(first?.closes, 1);
    respond(fake, tab.id, id, "{}");
    assert.deepEqual(
      read(tab.id).requests.map((entry) => entry.responseBody),
      [undefined, { text: "{}" }],
    );
  });

  it("releases a capture on a failure, a new page and the tab closing", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const failed = request(tab.id, `${SITE}/failed`);
    fake.emitWebRequest("onHeadersReceived", headersOf(tab.id, failed));
    filterFor(fake, failed)?.data("{");
    fake.emitWebRequest("onErrorOccurred", {
      requestId: failed,
      tabId: tab.id,
      timeStamp: 1100,
      error: "NS_ERROR_NET_RESET",
    });
    // A capture still open would store what the filter passes on after the failure.
    filterFor(fake, failed)?.data("}");
    filterFor(fake, failed)?.stop();
    assert.equal(filterFor(fake, failed)?.disconnects, 0);
    assert.equal(read(tab.id).requests[0]?.responseBody, undefined);
    const replaced = request(tab.id, `${SITE}/replaced`);
    filterFor(fake, replaced)?.data("{");
    fake.navigateByUser(tab.id, `${SITE}/next`);
    assert.equal(filterFor(fake, replaced)?.status, "transferringdata");
    assert.equal(filterFor(fake, replaced)?.disconnects, 0);
    assert.ok(released(filterFor(fake, replaced)));
    await flush();
    const closed = request(tab.id, `${SITE}/closed`, {
      documentUrl: `${SITE}/next`,
      timeStamp: 9e12,
    });
    filterFor(fake, closed)?.data("{");
    fake.removeTab(tab.id);
    assert.equal(filterFor(fake, closed)?.status, "transferringdata");
    assert.equal(filterFor(fake, closed)?.disconnects, 0);
    assert.ok(released(filterFor(fake, closed)));
    assert.deepEqual(read(tab.id), NONE);
  });

  it(`copies at most ${MAX_OPEN_CAPTURES} responses of a page at once`, async () => {
    const { fake, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const ids = Array.from({ length: MAX_OPEN_CAPTURES + 1 }, () => request(tab.id, `${SITE}/api`));
    assert.equal(fake.streamFilters.length, MAX_OPEN_CAPTURES);
    assert.equal(filterFor(fake, ids.at(-1) ?? ""), undefined);
    respond(fake, tab.id, ids[0] ?? "", "{}");
    request(tab.id, `${SITE}/api`);
    assert.equal(fake.streamFilters.length, MAX_OPEN_CAPTURES + 1);
    request(tab.id, `${SITE}/api`);
    assert.equal(fake.streamFilters.length, MAX_OPEN_CAPTURES + 1);
    filterFor(fake, ids[1] ?? "")?.fail("Invalid request ID");
    request(tab.id, `${SITE}/api`);
    assert.equal(fake.streamFilters.length, MAX_OPEN_CAPTURES + 2);
  });

  it("counts bodies in the page's bound, dropping the oldest bodies first while they take most", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const body = "b".repeat(32_768);
    // 411 small requests, then about 1,900,000 characters of headers in 19: with 70 bodies, the
    // page holds exactly 500 requests.
    for (let index = 0; index < 411; index += 1) {
      request(tab.id, `${SITE}/image`, { type: "image" });
    }
    for (let index = 0; index < 19; index += 1) headersRequest(fake, request, tab.id, "/headers");
    for (let index = 0; index < 70; index += 1) {
      respond(fake, tab.id, request(tab.id, `${SITE}/body`), body);
    }
    const result = read(tab.id);
    assert.equal(result.truncated, false);
    assert.equal(result.requests.length, MAX_NETWORK_REQUESTS);
    const kept = result.requests.filter((entry) => entry.responseBody !== undefined);
    assert.ok(kept.length > MAX_LOG_CHARS / 2 / body.length && kept.length < 70);
    // The newest bodies are the ones kept.
    assert.equal(
      result.requests.findIndex((entry) => entry.responseBody !== undefined),
      MAX_NETWORK_REQUESTS - kept.length,
    );
    assert.ok(charsIn(result) <= MAX_LOG_CHARS);
    // Bodies go until they take half or less, then the oldest requests, the body-less ones too.
    for (let index = 0; index < 25; index += 1) headersRequest(fake, request, tab.id, "/more");
    const later = read(tab.id);
    assert.equal(later.truncated, true);
    assert.equal(later.requests.filter((entry) => entry.url === `${SITE}/more`).length, 25);
    assert.equal(later.requests[0]?.responseBody?.text, body);
    assert.ok(charsIn(later) <= MAX_LOG_CHARS);
    assert.ok(charsIn(later) > MAX_LOG_CHARS - body.length - 100);
  });

  it("drops requests, not bodies, once the bodies left take half the bound or less", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const body = "o".repeat(32_768);
    // 61 bodies take just under half the bound.
    for (let index = 0; index < 61; index += 1) {
      respond(fake, tab.id, request(tab.id, `${SITE}/old?n=${index}`), body);
    }
    // The 20th pushes the page over the bound: the oldest request goes, with its body.
    for (let index = 0; index < 20; index += 1) headersRequest(fake, request, tab.id, "/headers");
    assert.equal(read(tab.id).requests[0]?.url, `${SITE}/old?n=1`);
    // Back at 61 bodies, over the bound again: the oldest request goes, not just its body.
    respond(fake, tab.id, request(tab.id, `${SITE}/new`), body);
    const result = read(tab.id);
    assert.equal(result.requests[0]?.url, `${SITE}/old?n=2`);
    assert.equal(result.requests[0]?.responseBody?.text, body);
    assert.equal(result.requests.length, 59 + 20 + 1);
  });

  it("releases the capture of a request the count bound drops", async () => {
    const { fake, read, request, tabIn } = setup();
    const tab = await liveTab(tabIn);
    const open = request(tab.id, `${SITE}/open`);
    filterFor(fake, open)?.data("{");
    for (let index = 0; index < MAX_NETWORK_REQUESTS - 1; index += 1) {
      request(tab.id, `${SITE}/image`, { type: "image" });
    }
    assert.equal(filterFor(fake, open)?.status, "transferringdata");
    assert.equal(read(tab.id).requests[0]?.url, `${SITE}/open`);
    request(tab.id, `${SITE}/image`, { type: "image" });
    assert.equal(filterFor(fake, open)?.status, "transferringdata");
    assert.equal(filterFor(fake, open)?.disconnects, 0);
    // The released capture no longer takes one of the page's open captures.
    const filters = fake.streamFilters.length;
    for (let index = 0; index < MAX_OPEN_CAPTURES; index += 1) request(tab.id, `${SITE}/api`);
    assert.equal(fake.streamFilters.length, filters + MAX_OPEN_CAPTURES);
  });
});

/** Starts a fetch of the tab whose request headers take about 100,500 characters. */
function headersRequest(
  fake: Context["fake"],
  request: Context["request"],
  tabId: number,
  path: string,
): void {
  const requestId = request(tabId, `${SITE}${path}`);
  fake.emitWebRequest("onSendHeaders", {
    requestId,
    tabId,
    timeStamp: 1001,
    requestHeaders: bigHeaders(100),
  });
}

/** The characters of every string of the requests, as the page's bound counts them. */
function charsIn(result: Result<"read_network">): number {
  let chars = 0;
  for (const request of result.requests) {
    chars += request.url.length + request.method.length + request.type.length;
    chars += (request.redirectUrl?.length ?? 0) + (request.error?.length ?? 0);
    for (const { name, value } of [
      ...(request.requestHeaders ?? []),
      ...(request.responseHeaders ?? []),
    ]) {
      chars += name.length + value.length;
    }
    chars += request.responseBody?.text.length ?? 0;
  }
  return chars;
}

/** A tab of s1 whose page on A is live, with the session's site check read. */
async function liveTab(tabIn: Context["tabIn"]): Promise<FakeTab> {
  const tab = await tabIn("s1", URL_A);
  await flush();
  return tab;
}

/** The latest filter made for the request. */
function filterFor(fake: Context["fake"], requestId: string): FakeStreamFilter | undefined {
  return fake.streamFilters.findLast((filter) => filter.requestId === requestId);
}

/** Whether the filter's capture ended: its handlers then only pass the response on. */
function released(filter: FakeStreamFilter | undefined): boolean {
  return filter !== undefined && filter.onerror === null;
}

/** The holds currently added: the blocking listeners. */
function holdsOf(fake: Context["fake"]): Context["fake"]["webRequestRegistrations"] {
  return fake
    .activeWebRequestRegistrations()
    .filter((registration) => registration.extraInfoSpec?.includes("blocking") === true);
}

function headersOf(
  tabId: number,
  requestId: string,
  statusCode = 200,
  contentType = "application/json",
): HeadersReceivedDetails {
  return {
    requestId,
    tabId,
    timeStamp: 1100,
    statusCode,
    responseHeaders: [{ name: "Content-Type", value: contentType }],
  };
}

function redirectOf(tabId: number, requestId: string, redirectUrl: string): RedirectDetails {
  return { requestId, tabId, timeStamp: 1050, statusCode: 302, redirectUrl, fromCache: false };
}

/** The response arrives whole through the request's filter: headers, the text, the end. */
function respond(
  fake: Context["fake"],
  tabId: number,
  requestId: string,
  text: string,
  statusCode = 200,
  contentType = "application/json",
): void {
  fake.emitWebRequest("onHeadersReceived", headersOf(tabId, requestId, statusCode, contentType));
  const filter = filterFor(fake, requestId);
  filter?.data(text);
  // Firefox can report the end before the filter's stop; then only the stored body trims the log.
  fake.emitWebRequest("onCompleted", {
    requestId,
    tabId,
    timeStamp: 1200,
    statusCode,
    fromCache: false,
  });
  filter?.stop();
}

/**
 * Makes `access.view` wait, call by call, for the holds taken: each `hold()` returns the release
 * of the next call not yet held.
 */
function holdViews(t: TestContext, access: Context["access"]): () => () => void {
  const holds: Promise<void>[] = [];
  const view = access.view;
  t.mock.method(access, "view", async (session: string) => {
    const hold = holds.shift();
    if (hold !== undefined) await hold;
    return view(session);
  });
  return () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    holds.push(promise);
    return () => resolve();
  };
}

function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  // What the log's clock reads; a test sets it.
  const clock = { now: 5000 };
  const network = createNetworkLog({
    browser: fake.browser,
    groups,
    access,
    now: () => clock.now,
  });
  let requests = 0;

  /** A tab in the session's group, on `url` with A's site stored as approved. */
  async function tabIn(session: string, url?: string): Promise<FakeTab> {
    // A group exists only after its session's first request admitted it.
    access.admit(session);
    await grantSite(fake.browser, SITE);
    const tab = fake.openTab();
    await groups.ensureGroup(session, tab);
    if (url !== undefined) {
      fake.navigateByUser(tab.id, url);
      await flush();
    }
    return tab;
  }

  /** The tab's top frame committing `url` at `timeStamp`. */
  function commit(tabId: number, url: string, timeStamp: number): void {
    fake.emitCommitted({ tabId, frameId: 0, url, timeStamp });
  }

  /** Starts a GET request of the tab's top frame, its document on A; returns its id. */
  function request(
    tabId: number,
    url: string,
    { documentUrl = URL_A, ...details }: RequestOverrides = {},
  ): string {
    requests += 1;
    const sent: RequestDetails = {
      requestId: `r${requests}`,
      tabId,
      timeStamp: 1000,
      frameId: 0,
      url,
      method: "GET",
      type: "xmlhttprequest",
      ...details,
    };
    if (documentUrl !== null) sent.documentUrl = documentUrl;
    fake.emitWebRequest("onBeforeRequest", sent);
    return sent.requestId;
  }

  function read(
    tabId: number,
    options: NetworkReadOptions = ALL,
    session = "s1",
    site = SITE,
  ): Result<"read_network"> {
    return network.read(session, tabId, site, options);
  }

  return { fake, groups, sessions, access, network, clock, tabIn, commit, request, read };
}

type Context = ReturnType<typeof setup>;

/** A request's details to change; a null `documentUrl` leaves it out. */
type RequestOverrides = Partial<Omit<RequestDetails, "documentUrl">> & {
  documentUrl?: string | null;
};

/** Reloads the tab and checks that it records again, from the reload on. */
async function reloadAndRead(
  fake: Context["fake"],
  tabId: number,
  site: string,
  request: Context["request"],
  read: Context["read"],
): Promise<void> {
  let since: number | undefined;
  fake.browser.webNavigation.onCommitted.addListener(({ frameId, timeStamp }) => {
    if (frameId === 0) since = timeStamp;
  });
  await fake.browser.tabs.reload(tabId);
  await flush();
  assert.ok(since !== undefined);
  request(tabId, `${site}/reloaded`, { documentUrl: `${site}/`, timeStamp: since + 1 });
  assert.deepEqual(read(tabId, ALL, "s1", site), {
    recording: true,
    since,
    requests: [
      {
        url: `${site}/reloaded`,
        method: "GET",
        type: "xmlhttprequest",
        startTime: since + 1,
        requestHeaders: [],
        responseHeaders: [],
      },
    ],
    truncated: false,
  });
}

/**
 * Makes `tabs.get` wait, call by call, for the holds taken: each `hold()` returns the release of
 * the next call not yet held.
 */
function holdTabsGet(t: TestContext, fake: Context["fake"]): () => () => void {
  const holds: Promise<void>[] = [];
  const get = fake.browser.tabs.get;
  t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
    const hold = holds.shift();
    if (hold !== undefined) await hold;
    return get(tabId);
  });
  return () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    holds.push(promise);
    return () => resolve();
  };
}

/** `count` headers of 5-character names and 1,000-character values. */
function bigHeaders(count: number): HttpHeader[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `x-${String(index).padStart(3, "0")}`,
    value: "v".repeat(MAX_NETWORK_HEADER),
  }));
}

function urlsOf(result: Result<"read_network">): string[] {
  return result.requests.map((request: NetworkRequestRead) => request.url);
}

function startTimesOf(result: Result<"read_network">): number[] {
  return result.requests.map((request: NetworkRequestRead) => request.startTime);
}

/** Keeps the log's warnings out of the test output. */
function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => {});
}
