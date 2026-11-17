import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION, type RequestMessage } from "@foxleash/protocol";
import { createConnection } from "./connection.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  FAKE_EXTENSION_ID,
  type FakePort,
  flush,
} from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { fieldsOf } from "./site-access.ts";

const request = { type: "request", id: "r1", session: "s1", method: "tabs_list", params: {} };

describe("connection hello", { timeout: 10000 }, () => {
  for (const allUrls of [true, false]) {
    it(`reports the extension's role, protocol, version and allUrls ${allUrls}`, async (t) => {
      const { fake, start } = setup(t);
      fake.version = "1.2.3";
      fake.allUrls = allUrls;
      start();
      await flush();
      assert.equal(fake.ports.length, 1);
      assert.deepEqual(port(fake.ports, 0).posted, [
        {
          type: "hello",
          role: "extension",
          protocol: PROTOCOL_VERSION,
          version: "1.2.3",
          oldestProtocol: OLDEST_SERVED_PROTOCOL,
          allUrls,
        },
      ]);
    });
  }

  it("leaves allUrls out when Firefox cannot answer", async (t) => {
    const { fake, start, warnings } = setup(t);
    fake.browser.permissions.contains = async () => {
      throw new Error("permissions unavailable");
    };
    start();
    await flush();
    const [hello] = port(fake.ports, 0).posted;
    assert.deepEqual(hello, {
      type: "hello",
      role: "extension",
      protocol: PROTOCOL_VERSION,
      version: "0.1.0",
      oldestProtocol: OLDEST_SERVED_PROTOCOL,
    });
    assert.deepEqual(warnings(), [
      { event: "permission_check_failed", error: "Error: permissions unavailable" },
    ]);
  });

  it("posts no hello when the port closes during the permission check", async (t) => {
    const { fake, start } = setup(t);
    const answer = Promise.withResolvers<boolean>();
    fake.browser.permissions.contains = () => answer.promise;
    start();
    port(fake.ports, 0).drop("Native host has exited.");
    answer.resolve(true);
    await flush();
    assert.deepEqual(port(fake.ports, 0).posted, []);
  });

  it("logs a hello Firefox refuses to post", async (t) => {
    const { fake, start, warnings } = setup(t);
    const answer = Promise.withResolvers<boolean>();
    fake.browser.permissions.contains = () => answer.promise;
    start();
    port(fake.ports, 0).disconnect();
    answer.resolve(true);
    await flush();
    assert.deepEqual(warnings(), [
      { event: "error", error: "Error: Attempt to postMessage on disconnected port" },
    ]);
  });

  it("opens no second port while one is open", async (t) => {
    const { fake, start } = setup(t);
    start();
    start();
    await flush();
    start();
    assert.equal(fake.ports.length, 1);
  });
});

describe("connection requests", { timeout: 10000 }, () => {
  it("posts a handler's result as a response with the request's id", async (t) => {
    const seen: RequestMessage[] = [];
    const { fake, openWelcomed } = setup(t, async (received) => {
      seen.push(received);
      return { tabs: [] };
    });
    const host = await openWelcomed();
    host.deliver({ ...request, extra: 1 });
    await flush();
    assert.deepEqual(seen, [request]);
    assert.deepEqual(host.posted.slice(1), [
      { type: "response", id: "r1", ok: true, result: { tabs: [] } },
    ]);
    assert.equal(fake.ports.length, 1);
  });

  it("posts a tool error's code and message", async (t) => {
    const { openWelcomed } = setup(t, async () => {
      throw new ToolError("tab_not_found", "Tab 4 does not exist.");
    });
    const host = await openWelcomed();
    host.deliver(request);
    await flush();
    assert.deepEqual(host.posted.slice(1), [
      {
        type: "response",
        id: "r1",
        ok: false,
        error: { code: "tab_not_found", message: "Tab 4 does not exist." },
      },
    ]);
  });

  it("answers any other failure with browser_error, keeping Firefox's text in the log", async (t) => {
    const { openWelcomed, warnings } = setup(t, async () => {
      throw new Error("Invalid url https://secret.example/");
    });
    const host = await openWelcomed();
    host.deliver(request);
    await flush();
    assert.deepEqual(host.posted.slice(1), [
      {
        type: "response",
        id: "r1",
        ok: false,
        error: { code: "browser_error", message: "Firefox could not complete the request." },
      },
    ]);
    assert.deepEqual(warnings(), [
      {
        event: "request_failed",
        method: "tabs_list",
        error: "Error: Invalid url https://secret.example/",
      },
    ]);
  });

  it("answers overlapping requests as each finishes", async (t) => {
    const pending = new Map<string, PromiseWithResolvers<unknown>>();
    const { openWelcomed } = setup(t, (received) => {
      const result = Promise.withResolvers<unknown>();
      pending.set(received.id, result);
      return result.promise;
    });
    const host = await openWelcomed();
    host.deliver({ ...request, id: "slow" });
    host.deliver({ ...request, id: "fast" });
    pending.get("fast")?.resolve("fast result");
    await flush();
    pending.get("slow")?.resolve("slow result");
    await flush();
    assert.deepEqual(
      host.posted.slice(1).map((response) => (response as { id: string }).id),
      ["fast", "slow"],
    );
  });

  it("answers a malformed request that has an id with invalid_request", async (t) => {
    const { open } = setup(t);
    const host = await open();
    host.deliver({ ...request, id: "r9", method: "tabs_close" });
    await flush();
    assert.deepEqual(host.posted.slice(1), [
      {
        type: "response",
        id: "r9",
        ok: false,
        error: {
          code: "invalid_request",
          message: "Foxleash could not read the request: invalid method.",
        },
      },
    ]);
  });

  it("logs a malformed message without an id and does not answer it", async (t) => {
    const { open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "bogus", id: "r1" });
    host.deliver("not an object");
    await flush();
    assert.equal(host.posted.length, 1);
    assert.deepEqual(warnings(), [
      { event: "invalid_message", error: "invalid type" },
      { event: "invalid_message", error: "invalid message" },
    ]);
  });

  it("logs and ignores a hello or a response from the host", async (t) => {
    const { open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "hello", role: "mcp", protocol: 1, version: "0.1.0" });
    host.deliver({ type: "response", id: "r1", ok: true, result: null });
    await flush();
    assert.equal(host.posted.length, 1);
    assert.deepEqual(warnings(), [
      { event: "unexpected_message", type: "hello" },
      { event: "unexpected_message", type: "response" },
    ]);
  });

  it("drops responses whose port closed while the request ran", async (t) => {
    const results = new Map<string, PromiseWithResolvers<unknown>>();
    const { fake, timers, openWelcomed, warnings } = setup(t, (received) => {
      const result = Promise.withResolvers<unknown>();
      results.set(received.id, result);
      return result.promise;
    });
    const first = await openWelcomed();
    first.deliver({ ...request, id: "before" });
    first.deliver({ ...request, id: "after" });
    first.drop();
    results.get("before")?.resolve({ tabs: [] });
    await flush();
    timers.advance(500);
    await flush();
    results.get("after")?.resolve({ tabs: [] });
    await flush();
    assert.equal(first.posted.length, 1);
    assert.equal(port(fake.ports, 1).posted.length, 1);
    assert.deepEqual(warnings(), [{ event: "disconnected", error: null }]);
  });
});

describe("connection welcome", { timeout: 10000 }, () => {
  it("logs a welcome from another protocol and keeps the port open", async (t) => {
    const { fake, open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "welcome", protocol: PROTOCOL_VERSION + 1, version: "9.0.0" });
    await flush();
    assert.equal(host.disconnected, false);
    assert.equal(fake.ports.length, 1);
    assert.deepEqual(warnings(), [
      {
        event: "protocol_mismatch",
        message:
          `The Foxleash extension (version 0.1.0, protocol ${PROTOCOL_VERSION}) is older than ` +
          `the Foxleash native host (version 9.0.0, protocol ${PROTOCOL_VERSION + 1}): run ` +
          "`npm run setup` in your Foxleash folder and confirm the extension update in Firefox.",
      },
    ]);
    host.deliver(request);
    await flush();
    assert.deepEqual(host.posted.slice(1), [
      {
        type: "response",
        id: "r1",
        ok: false,
        error: { code: "protocol_mismatch", message: fieldsOf(warnings()[0])?.message },
      },
    ]);
  });

  it("logs nothing for a welcome on the same protocol", async (t) => {
    const { open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    await flush();
    assert.deepEqual(warnings(), []);
  });
});

describe("connection served protocols", { timeout: 10000 }, () => {
  const served = [OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION - 1, PROTOCOL_VERSION].filter(
    (protocol, index, all) => protocol >= OLDEST_SERVED_PROTOCOL && all.indexOf(protocol) === index,
  );
  for (const protocol of served) {
    it(`answers a host of protocol ${protocol} in that protocol`, async (t) => {
      const seen: [string, number][] = [];
      const { open, warnings } = setup(t, async (received, answeredIn) => {
        seen.push([received.id, answeredIn]);
        return { tabs: [] };
      });
      const host = await open();
      host.deliver({ type: "welcome", protocol, version: "0.4.1" });
      host.deliver(request);
      await flush();
      assert.deepEqual(seen, [["r1", protocol]]);
      assert.deepEqual(host.posted.slice(1), [
        { type: "response", id: "r1", ok: true, result: { tabs: [] } },
      ]);
      assert.deepEqual(warnings(), []);
    });
  }

  it("refuses every request from a host older than the protocols it serves", async (t) => {
    const seen: RequestMessage[] = [];
    const { open, warnings } = setup(t, async (received) => {
      seen.push(received);
      return null;
    });
    const host = await open();
    host.deliver({ type: "welcome", protocol: OLDEST_SERVED_PROTOCOL - 1, version: "0.2.0" });
    host.deliver(request);
    await flush();
    const sentence =
      `The Foxleash native host (version 0.2.0, protocol ${OLDEST_SERVED_PROTOCOL - 1}) is ` +
      `older than the Foxleash extension (version 0.1.0, protocol ${PROTOCOL_VERSION}, which ` +
      `works with protocol ${OLDEST_SERVED_PROTOCOL} and later): Firefox is still running the ` +
      "old native host, so update Foxleash with `git pull && npm ci && npm run setup` if you " +
      "have not yet and then restart Firefox.";
    assert.deepEqual(seen, []);
    assert.deepEqual(host.posted.slice(1), [
      {
        type: "response",
        id: "r1",
        ok: false,
        error: { code: "protocol_mismatch", message: sentence },
      },
    ]);
    assert.deepEqual(warnings(), [{ event: "protocol_mismatch", message: sentence }]);
  });

  it("refuses every request before the host's welcome", async (t) => {
    const seen: RequestMessage[] = [];
    const { open } = setup(t, async (received) => {
      seen.push(received);
      return null;
    });
    const host = await open();
    host.deliver(request);
    await flush();
    assert.deepEqual(seen, []);
    assert.deepEqual(host.posted.slice(1), [noWelcome("r1")]);
  });

  it("refuses every request after a welcome that does not parse", async (t) => {
    const { open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "welcome", protocol: 0, version: "0.1.0" });
    host.deliver(request);
    await flush();
    assert.deepEqual(host.posted.slice(1), [noWelcome("r1")]);
    assert.deepEqual(warnings(), [{ event: "invalid_message", error: "invalid protocol" }]);
  });

  it("starts a new port without the old port's welcome", async (t) => {
    const seen: number[] = [];
    const { fake, timers, openWelcomed } = setup(t, async (_received, protocol) => {
      seen.push(protocol);
      return null;
    });
    const first = await openWelcomed(OLDEST_SERVED_PROTOCOL);
    first.drop();
    timers.advance(500);
    await flush();
    const second = port(fake.ports, 1);
    second.deliver({ ...request, id: "early" });
    await flush();
    assert.deepEqual(second.posted.slice(1), [noWelcome("early")]);
    second.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    second.deliver({ ...request, id: "late" });
    await flush();
    assert.deepEqual(seen, [PROTOCOL_VERSION]);
    assert.deepEqual(second.posted.slice(2), [
      { type: "response", id: "late", ok: true, result: null },
    ]);
  });
});

describe("connection session end", { timeout: 10000 }, () => {
  it("ends the session the host names and posts nothing", async (t) => {
    const { open, warnings, ended } = setup(t);
    const host = await open();
    host.deliver({ type: "session_end", session: "s1" });
    await flush();
    assert.deepEqual(ended, ["s1"]);
    assert.equal(host.posted.length, 1);
    assert.deepEqual(warnings(), []);
  });

  it("logs a session end that fails", async (t) => {
    const { open, warnings } = setup(t, undefined, async () => {
      throw new Error("tabs gone");
    });
    const host = await open();
    host.deliver({ type: "session_end", session: "s1" });
    await flush();
    assert.equal(host.posted.length, 1);
    assert.deepEqual(warnings(), [{ event: "error", error: "Error: tabs gone" }]);
  });

  it("logs a session end with an invalid session and ends nothing", async (t) => {
    const { open, warnings, ended } = setup(t);
    const host = await open();
    host.deliver({ type: "session_end", session: "a b" });
    host.deliver({ type: "session_end" });
    await flush();
    assert.deepEqual(ended, []);
    assert.equal(host.posted.length, 1);
    assert.deepEqual(warnings(), [
      { event: "invalid_message", error: "invalid session" },
      { event: "invalid_message", error: "invalid session" },
    ]);
  });
});

describe("connection permission changes", { timeout: 10000 }, () => {
  it("reports a revoked and a re-granted grant on the open port", async (t) => {
    const { fake, open } = setup(t);
    const host = await open();
    fake.setAllUrls(false);
    await flush();
    fake.setAllUrls(true);
    await flush();
    assert.deepEqual(host.posted, [hello(true), hello(false), hello(true)]);
    assert.equal(fake.ports.length, 1);
  });

  it("reports nothing and opens no port while no port is open", async (t) => {
    const { fake, timers, open, warnings } = setup(t);
    fake.setAllUrls(false);
    await flush();
    assert.equal(fake.ports.length, 0);
    assert.equal(timers.pending(), 0);
    const first = await open();
    first.drop();
    fake.setAllUrls(true);
    await flush();
    assert.equal(fake.ports.length, 1);
    assert.equal(first.posted.length, 1);
    assert.equal(timers.pending(), 1);
    assert.deepEqual(warnings(), [{ event: "disconnected", error: null }]);
    timers.advance(500);
    await flush();
    assert.deepEqual(port(fake.ports, 1).posted, [hello(true)]);
    port(fake.ports, 1).drop();
    fake.setAllUrls(false);
    timers.advance(999);
    assert.equal(fake.ports.length, 2);
    timers.advance(1);
    assert.equal(fake.ports.length, 3);
  });

  it("posts hellos in the order their checks started", async (t) => {
    const { fake, start } = setup(t);
    const checks: PromiseWithResolvers<boolean>[] = [];
    fake.browser.permissions.contains = () => {
      const check = Promise.withResolvers<boolean>();
      checks.push(check);
      return check.promise;
    };
    start();
    await flush();
    fake.setAllUrls(false);
    await flush();
    checks[1]?.resolve(false);
    await flush();
    checks[0]?.resolve(true);
    await flush();
    checks[1]?.resolve(false);
    await flush();
    assert.deepEqual(
      port(fake.ports, 0).posted.map((posted) => (posted as { allUrls?: boolean }).allUrls),
      [true, false],
    );
    assert.equal(fake.ports.length, 1);
  });

  it("posts nothing on a port that closed during the re-check", async (t) => {
    const { fake, open } = setup(t);
    const host = await open();
    const answer = Promise.withResolvers<boolean>();
    fake.browser.permissions.contains = () => answer.promise;
    fake.setAllUrls(false);
    await flush();
    host.drop();
    answer.resolve(false);
    await flush();
    assert.equal(host.posted.length, 1);
  });

  it("posts the next port's first hello while an old port's check never answers", async (t) => {
    const { fake, timers, start } = setup(t);
    let calls = 0;
    fake.browser.permissions.contains = () => {
      calls += 1;
      return calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(fake.allUrls);
    };
    start();
    await flush();
    port(fake.ports, 0).drop();
    timers.advance(500);
    await flush();
    assert.deepEqual(port(fake.ports, 1).posted, [hello(true)]);
  });

  it("keeps reporting after a hello Firefox refuses to post", async (t) => {
    const { fake, open, warnings } = setup(t);
    const host = await open();
    const post = host.postMessage;
    host.postMessage = () => {
      host.postMessage = post;
      throw new Error("Attempt to postMessage on disconnected port");
    };
    fake.setAllUrls(false);
    await flush();
    fake.setAllUrls(true);
    await flush();
    assert.deepEqual(host.posted, [hello(true), hello(true)]);
    assert.deepEqual(warnings(), [
      { event: "error", error: "Error: Attempt to postMessage on disconnected port" },
    ]);
  });

  it("sends a repeated hello without allUrls when the re-check fails", async (t) => {
    const { fake, open, warnings } = setup(t);
    const host = await open();
    fake.browser.permissions.contains = async () => {
      throw new Error("permissions unavailable");
    };
    fake.setAllUrls(false);
    await flush();
    assert.deepEqual(host.posted[1], {
      type: "hello",
      role: "extension",
      protocol: PROTOCOL_VERSION,
      version: "0.1.0",
      oldestProtocol: OLDEST_SERVED_PROTOCOL,
    });
    assert.deepEqual(warnings(), [
      { event: "permission_check_failed", error: "Error: permissions unavailable" },
    ]);
  });
});

describe("connection reconnect", { timeout: 10000 }, () => {
  it("logs the disconnect error and reconnects after a backoff that doubles up to 10 s", async (t) => {
    const { fake, timers, start, warnings } = setup(t);
    start();
    await flush();
    for (const [index, delay] of [500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
      port(fake.ports, index).drop("No such native application foxleash");
      timers.advance(delay - 1);
      assert.equal(fake.ports.length, index + 1, `before ${delay} ms`);
      timers.advance(1);
      assert.equal(fake.ports.length, index + 2, `after ${delay} ms`);
      await flush();
      assert.equal(port(fake.ports, index + 1).posted.length, 1, "hello");
    }
    assert.deepEqual(warnings()[0], {
      event: "disconnected",
      error: "No such native application foxleash",
    });
  });

  it("goes back to 0.5 s after a welcome and leaves no timer behind", async (t) => {
    const { fake, timers, start } = setup(t);
    start();
    await flush();
    for (const index of [0, 1, 2]) {
      port(fake.ports, index).drop();
      timers.advance(10000);
      await flush();
    }
    const current = port(fake.ports, 3);
    current.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    current.drop();
    timers.advance(499);
    assert.equal(fake.ports.length, 4);
    timers.advance(1);
    assert.equal(fake.ports.length, 5);
    await flush();
    assert.equal(timers.pending(), 0);
  });

  it("does not connect again while a reconnect is pending", async (t) => {
    const { fake, timers, start } = setup(t);
    start();
    await flush();
    port(fake.ports, 0).drop();
    start();
    assert.equal(fake.ports.length, 1);
    timers.advance(500);
    assert.equal(fake.ports.length, 2);
  });

  it("schedules a reconnect when connecting throws", async (t) => {
    const { fake, timers, start, warnings } = setup(t);
    const connectNative = fake.browser.runtime.connectNative;
    let attempts = 0;
    fake.browser.runtime.connectNative = (application) => {
      attempts += 1;
      if (attempts <= 2) throw new Error("No native messaging permission");
      return connectNative(application);
    };
    start();
    timers.advance(499);
    assert.equal(attempts, 1);
    timers.advance(1);
    assert.equal(attempts, 2);
    timers.advance(999);
    assert.equal(attempts, 2);
    timers.advance(1);
    await flush();
    assert.equal(port(fake.ports, 0).posted.length, 1);
    assert.deepEqual(warnings()[0], {
      event: "connect_failed",
      error: "Error: No native messaging permission",
    });
  });

  it("connects to the foxleash native host", async (t) => {
    const { fake, start } = setup(t);
    const names: string[] = [];
    const connectNative = fake.browser.runtime.connectNative;
    fake.browser.runtime.connectNative = (application) => {
      names.push(application);
      return connectNative(application);
    };
    start();
    assert.deepEqual(names, ["foxleash"]);
  });
});

describe("connection program state", { timeout: 10000 }, () => {
  it("is checking until the host welcomes or goes away", async (t) => {
    const { state, start } = setup(t);
    assert.equal(state(), "checking");
    start();
    await flush();
    assert.equal(state(), "checking");
  });

  it("is connected after a welcome", async (t) => {
    const { state, open } = setup(t);
    const host = await open();
    host.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    assert.equal(state(), "connected");
  });

  it("is connected after a welcome with another protocol, and still warns", async (t) => {
    const { state, open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "welcome", protocol: PROTOCOL_VERSION + 1, version: "9.0.0" });
    assert.equal(state(), "connected");
    assert.deepEqual(
      warnings().map((warning) => fieldsOf(warning)?.event),
      ["protocol_mismatch"],
    );
  });

  it("is missing when connecting throws", (t) => {
    const { fake, state, start } = setup(t);
    fake.browser.runtime.connectNative = () => {
      throw new Error("No such native application foxleash");
    };
    start();
    assert.equal(state(), "missing");
  });

  it("is missing when the port closes before a welcome", async (t) => {
    const { state, open } = setup(t);
    const host = await open();
    host.drop("No such native application foxleash");
    assert.equal(state(), "missing");
  });

  it("goes from connected to missing and back with the host", async (t) => {
    const { fake, timers, state, open } = setup(t);
    const first = await open();
    first.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    first.drop("Native host has exited.");
    assert.equal(state(), "missing");
    timers.advance(500);
    await flush();
    const second = port(fake.ports, 1);
    assert.equal(state(), "missing");
    second.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    assert.equal(state(), "connected");
  });

  for (const page of ["options.html", "welcome.html"]) {
    it(`answers ${page} with the state`, async (t) => {
      const { fake, state, open } = setup(t);
      const sender = { id: FAKE_EXTENSION_ID, url: fake.browser.runtime.getURL(page) };
      const host = await open();
      assert.deepEqual(await fake.sendMessage({ type: "program_state" }, sender), {
        state: "checking",
      });
      host.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
      assert.deepEqual(await fake.sendMessage({ type: "program_state" }, sender), {
        state: "connected",
      });
      host.drop();
      assert.deepEqual(await fake.sendMessage({ type: "program_state" }, sender), {
        state: "missing",
      });
      assert.equal(state(), "missing");
    });
  }

  it("does not answer other senders or other messages", (t) => {
    const { fake } = setup(t);
    const options = fake.browser.runtime.getURL("options.html");
    const asks: [unknown, { id?: string; url?: string }][] = [
      [{ type: "program_state" }, { id: "other@example.org", url: options }],
      [
        { type: "program_state" },
        { id: FAKE_EXTENSION_ID, url: fake.browser.runtime.getURL("approve.html") },
      ],
      [
        { type: "program_state" },
        { id: FAKE_EXTENSION_ID, url: "https://example.org/options.html" },
      ],
      [{ type: "program_state" }, { id: FAKE_EXTENSION_ID, url: `${options}#x` }],
      [{ type: "program_state" }, { id: FAKE_EXTENSION_ID }],
      [{ type: "session_answers" }, { id: FAKE_EXTENSION_ID, url: options }],
      ["program_state", { id: FAKE_EXTENSION_ID, url: options }],
      [null, { id: FAKE_EXTENSION_ID, url: options }],
    ];
    for (const [message, sender] of asks) {
      assert.equal(fake.sendMessage(message, sender), undefined, JSON.stringify([message, sender]));
    }
    assert.equal(fake.ports.length, 0);
  });

  it("starts a connection when a page asks before any was started", (t) => {
    const { fake } = setup(t);
    assert.equal(fake.ports.length, 0);
    fake.sendMessage(
      { type: "program_state" },
      { id: FAKE_EXTENSION_ID, url: fake.browser.runtime.getURL("welcome.html") },
    );
    assert.equal(fake.ports.length, 1);
  });

  it("keeps the backoff when a page asks while a reconnect is pending", async (t) => {
    const { fake, timers, open } = setup(t);
    const host = await open();
    host.drop();
    fake.sendMessage(
      { type: "program_state" },
      { id: FAKE_EXTENSION_ID, url: fake.browser.runtime.getURL("options.html") },
    );
    assert.equal(fake.ports.length, 1);
    timers.advance(499);
    assert.equal(fake.ports.length, 1);
    timers.advance(1);
    assert.equal(fake.ports.length, 2);
  });
});

function setup(
  t: TestContext,
  handleRequest: (request: RequestMessage, protocol: number) => Promise<unknown> = async () => null,
  onEndSession: (session: string) => Promise<void> = async () => {},
) {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const warn = t.mock.method(console, "warn", () => {});
  const ended: string[] = [];
  const endSession = (session: string) => {
    ended.push(session);
    return onEndSession(session);
  };
  const connection = createConnection({ browser: fake.browser, handleRequest, endSession, timers });
  const start = () => connection.start();
  const state = () => connection.state();

  async function open(): Promise<FakePort> {
    start();
    await flush();
    return port(fake.ports, fake.ports.length - 1);
  }

  async function openWelcomed(protocol = PROTOCOL_VERSION): Promise<FakePort> {
    const host = await open();
    host.deliver({ type: "welcome", protocol, version: "0.1.0" });
    return host;
  }

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { fake, timers, start, state, open, openWelcomed, warnings, ended };
}

function noWelcome(id: string) {
  return {
    type: "response",
    id,
    ok: false,
    error: {
      code: "protocol_mismatch",
      message:
        "The Foxleash extension has not learned which version the native host is, so it " +
        "cannot answer; restart Firefox if this continues.",
    },
  };
}

function port(ports: FakePort[], index: number): FakePort {
  const found = ports[index];
  assert.ok(found, `no port ${index}`);
  return found;
}

function hello(allUrls: boolean) {
  return {
    type: "hello",
    role: "extension",
    protocol: PROTOCOL_VERSION,
    version: "0.1.0",
    oldestProtocol: OLDEST_SERVED_PROTOCOL,
    allUrls,
  };
}
