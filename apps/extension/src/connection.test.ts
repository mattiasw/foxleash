import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { PROTOCOL_VERSION, type RequestMessage } from "@foxhand/protocol";
import { createConnection } from "./connection.ts";
import { createFakeBrowser, createFakeTimers, type FakePort, flush } from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";

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
        { type: "hello", role: "extension", protocol: PROTOCOL_VERSION, version: "1.2.3", allUrls },
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
    const { fake, open } = setup(t, async (received) => {
      seen.push(received);
      return { tabs: [] };
    });
    const host = await open();
    host.deliver({ ...request, extra: 1 });
    await flush();
    assert.deepEqual(seen, [request]);
    assert.deepEqual(host.posted.slice(1), [
      { type: "response", id: "r1", ok: true, result: { tabs: [] } },
    ]);
    assert.equal(fake.ports.length, 1);
  });

  it("posts a tool error's code and message", async (t) => {
    const { open } = setup(t, async () => {
      throw new ToolError("tab_not_found", "Tab 4 does not exist.");
    });
    const host = await open();
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
    const { open, warnings } = setup(t, async () => {
      throw new Error("Invalid url https://secret.example/");
    });
    const host = await open();
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
    const { open } = setup(t, (received) => {
      const result = Promise.withResolvers<unknown>();
      pending.set(received.id, result);
      return result.promise;
    });
    const host = await open();
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
          message: "Foxhand could not read the request: invalid method.",
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
    const { fake, timers, open, warnings } = setup(t, (received) => {
      const result = Promise.withResolvers<unknown>();
      results.set(received.id, result);
      return result.promise;
    });
    const first = await open();
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
          `The Foxhand extension (version 0.1.0, protocol ${PROTOCOL_VERSION}) is older than ` +
          `the Foxhand native host (version 9.0.0, protocol ${PROTOCOL_VERSION + 1}): run ` +
          "`npm run setup` in your Foxhand folder and confirm the extension update in Firefox.",
      },
    ]);
    host.deliver(request);
    await flush();
    assert.equal(host.posted.length, 2);
  });

  it("logs nothing for a welcome on the same protocol", async (t) => {
    const { open, warnings } = setup(t);
    const host = await open();
    host.deliver({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    await flush();
    assert.deepEqual(warnings(), []);
  });
});

describe("connection reconnect", { timeout: 10000 }, () => {
  it("logs the disconnect error and reconnects after a backoff that doubles up to 10 s", async (t) => {
    const { fake, timers, start, warnings } = setup(t);
    start();
    await flush();
    for (const [index, delay] of [500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
      port(fake.ports, index).drop("No such native application foxhand");
      timers.advance(delay - 1);
      assert.equal(fake.ports.length, index + 1, `before ${delay} ms`);
      timers.advance(1);
      assert.equal(fake.ports.length, index + 2, `after ${delay} ms`);
      await flush();
      assert.equal(port(fake.ports, index + 1).posted.length, 1, "hello");
    }
    assert.deepEqual(warnings()[0], {
      event: "disconnected",
      error: "No such native application foxhand",
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

  it("connects to the foxhand native host", async (t) => {
    const { fake, start } = setup(t);
    const names: string[] = [];
    const connectNative = fake.browser.runtime.connectNative;
    fake.browser.runtime.connectNative = (application) => {
      names.push(application);
      return connectNative(application);
    };
    start();
    assert.deepEqual(names, ["foxhand"]);
  });
});

function setup(
  t: TestContext,
  handleRequest: (request: RequestMessage) => Promise<unknown> = async () => null,
) {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const warn = t.mock.method(console, "warn", () => {});
  const connection = createConnection({ browser: fake.browser, handleRequest, timers });
  const start = () => connection.start();

  async function open(): Promise<FakePort> {
    start();
    await flush();
    return port(fake.ports, fake.ports.length - 1);
  }

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { fake, timers, start, open, warnings };
}

function port(ports: FakePort[], index: number): FakePort {
  const found = ports[index];
  assert.ok(found, `no port ${index}`);
  return found;
}
