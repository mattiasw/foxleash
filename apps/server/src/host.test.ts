import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, protocolMismatch } from "@foxleash/protocol";
import { createFrameReader, encodeFrame, FRAME_LIMIT, NATIVE_MESSAGE_LIMIT } from "./framing.ts";
import { type Host, type HostProcess, hostCommand, runHost } from "./host.ts";
import { SERVER_VERSION } from "./version.ts";

interface LogLine {
  message: string;
  detail: unknown;
}

interface FrameQueue {
  next(): Promise<Record<string, unknown>>;
  received(): number;
}

interface Harness {
  host: Host;
  stdin: PassThrough;
  stdout: PassThrough;
  out: FrameQueue;
  logs: LogLine[];
  socketDir: string;
}

interface StartOptions {
  socketDir?: string;
  uid?: number;
  pid?: number;
}

interface Client {
  socket: net.Socket;
  frames: FrameQueue;
  closed: Promise<void>;
  send(value: unknown): void;
}

interface FakeProcess extends HostProcess {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  listeners: Map<string, Set<() => void>>;
  exitCodes: number[];
  text(): string;
  emit(event: string): void;
}

const uid = currentUid();
const root = mkdtempSync("/tmp/foxleash-test-");
const VERSION = "1.2.3";
const EXTENSION_VERSION = "0.9.0";
const REQUEST_TIMEOUT_MS = 50;
const TIMEOUT_SENTENCE = `The extension did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s.`;
const CLOSED_SENTENCE = "Firefox closed the connection to the Foxleash native host.";
const SOCKET_FRAME_LIMIT = NATIVE_MESSAGE_LIMIT + 64 * 1024;
const LIMIT = { timeout: 3000 };
const CHILD_LIMIT = { timeout: 15_000 };
const WAIT_MS = 1000;
const CHILD_WAIT_MS = 10_000;
const DEEP = 300_000;
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const hosts: Host[] = [];
const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const processes: FakeProcess[] = [];
let counter = 0;

after(async () => {
  // A broken host can leave its server open; it must fail the run, not hang it.
  setTimeout(() => process.exit(1), 5000).unref();
  for (const socket of sockets) {
    socket.destroy();
  }
  for (const child of children) {
    child.kill("SIGKILL");
  }
  for (const proc of processes) {
    proc.emit("SIGTERM");
  }
  for (const host of hosts) {
    host.close("tests finished");
  }
  await within(Promise.all(hosts.map((host) => host.done)), 2000);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

describe("runHost, native side", () => {
  it("logs a version difference with the extension at its hello", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    assert.deepEqual(
      h.logs.filter((line) => line.message === "version difference with the extension"),
      [
        {
          message: "version difference with the extension",
          detail:
            `The Foxleash extension (version ${EXTENSION_VERSION}) is older than the Foxleash ` +
            `native host (version ${VERSION}): update the add-on in Firefox (open about:addons ` +
            "and choose Check for Updates), or install it again from " +
            "https://addons.mozilla.org/firefox/addon/foxleash/.",
        },
      ],
    );
    await finish(h);
  });

  it("logs no version difference when the versions are equal", LIMIT, async () => {
    const h = start();
    await greetExtension(h, { version: VERSION });
    assert.ok(h.logs.some((line) => line.message === "extension connected"));
    assert.ok(!h.logs.some((line) => line.message === "version difference with the extension"));
    await finish(h);
  });

  it("answers an extension hello with a welcome", LIMIT, async () => {
    const h = start();
    writeFrame(h.stdin, extensionHello());
    assert.deepEqual(await h.out.next(), {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
    });
    assert.ok(
      h.logs.some(
        (line) =>
          line.message === "extension connected" &&
          isEqual(line.detail, { version: EXTENSION_VERSION, protocol: PROTOCOL_VERSION }),
      ),
    );
    await finish(h);
  });

  it("ignores a stdio hello with role mcp", LIMIT, async () => {
    const h = start();
    writeFrame(h.stdin, { ...extensionHello(), role: "mcp" });
    const client = await connect(h);
    client.send(mcpHello());
    assert.deepEqual((await client.frames.next()).extension, { connected: false });
    await tick();
    assert.equal(h.out.received(), 0);
    assert.ok(h.logs.some((line) => line.message.startsWith("ignored a hello from Firefox")));
    await finish(h, client);
  });

  it("ignores a stdio request or welcome", LIMIT, async () => {
    const h = start();
    writeFrame(h.stdin, request("r1"));
    writeFrame(h.stdin, { type: "welcome", protocol: PROTOCOL_VERSION, version: VERSION });
    await greetExtension(h);
    assert.equal(h.out.received(), 1);
    const wrong = h.logs.filter((line) => line.message.includes("wrong direction"));
    assert.deepEqual(
      wrong.map((line) => line.detail),
      ["request", "welcome"],
    );
    await finish(h);
  });

  it("logs and ignores a malformed message from Firefox", LIMIT, async () => {
    const h = start();
    writeFrame(h.stdin, { type: "hello", role: "extension" });
    await greetExtension(h);
    assert.ok(
      h.logs.some(
        (line) => line.message.includes("malformed") && line.detail === "invalid protocol",
      ),
    );
    await finish(h);
  });

  it("updates only allUrls on a later stdio hello", LIMIT, async () => {
    const h = start();
    await greetExtension(h, { allUrls: false });
    writeFrame(h.stdin, {
      ...extensionHello(),
      protocol: PROTOCOL_VERSION + 1,
      version: "9.9.9",
      allUrls: true,
    });
    writeFrame(h.stdin, extensionHello());
    const client = await connect(h);
    client.send(mcpHello());
    assert.deepEqual((await client.frames.next()).extension, {
      connected: true,
      protocol: PROTOCOL_VERSION,
      version: EXTENSION_VERSION,
      allUrls: true,
    });
    assert.equal(h.out.received(), 1);
    assert.deepEqual(
      h.logs.filter((line) => line.message === "permission status updated"),
      [{ message: "permission status updated", detail: { allUrls: true } }],
    );
    assert.ok(
      h.logs.some((line) => line.message === "ignored a repeated hello from the extension"),
    );
    await relay(h, client, "r1");
    await finish(h, client);
  });

  it("logs the extension's oldest protocol and passes it on to MCP peers", LIMIT, async () => {
    const h = start();
    await greetExtension(h, { oldestProtocol: PROTOCOL_VERSION - 1, allUrls: true });
    assert.ok(
      h.logs.some(
        (line) =>
          line.message === "extension connected" &&
          isEqual(line.detail, {
            version: EXTENSION_VERSION,
            protocol: PROTOCOL_VERSION,
            oldestProtocol: PROTOCOL_VERSION - 1,
          }),
      ),
    );
    const client = await connect(h);
    client.send(mcpHello());
    assert.deepEqual((await client.frames.next()).extension, {
      connected: true,
      protocol: PROTOCOL_VERSION,
      version: EXTENSION_VERSION,
      allUrls: true,
      oldestProtocol: PROTOCOL_VERSION - 1,
    });
    await finish(h, client);
  });

  it("keeps the first hello's oldest protocol on a later stdio hello", LIMIT, async () => {
    const h = start();
    await greetExtension(h, { protocol: PROTOCOL_VERSION + 1, oldestProtocol: PROTOCOL_VERSION });
    writeFrame(h.stdin, {
      ...extensionHello(),
      protocol: PROTOCOL_VERSION + 2,
      oldestProtocol: PROTOCOL_VERSION + 2,
      allUrls: false,
    });
    const client = await connect(h);
    client.send(mcpHello());
    assert.deepEqual((await client.frames.next()).extension, {
      connected: true,
      protocol: PROTOCOL_VERSION + 1,
      version: EXTENSION_VERSION,
      allUrls: false,
      oldestProtocol: PROTOCOL_VERSION,
    });
    assert.equal(h.out.received(), 1);
    await relay(h, client, "r1");
    await finish(h, client);
  });

  it("logs an invalid-JSON frame and an oversize frame, then keeps reading", LIMIT, async () => {
    const h = start();
    h.stdin.write(rawFrame("{"));
    await tick();
    const oversize = Buffer.alloc(4 + FRAME_LIMIT + 1);
    oversize.writeUInt32LE(FRAME_LIMIT + 1, 0);
    h.stdin.write(oversize);
    await greetExtension(h);
    assert.deepEqual(
      h.logs.filter((line) => line.message === "bad frame from Firefox"),
      [
        { message: "bad frame from Firefox", detail: { error: "invalid JSON", more: 0 } },
        {
          message: "bad frame from Firefox",
          detail: {
            error: `frame of ${FRAME_LIMIT + 1} bytes exceeds the limit of ${FRAME_LIMIT}`,
            more: 0,
          },
        },
      ],
    );
    await finish(h);
  });

  it("logs many zero-length frames in one chunk as one line", LIMIT, async () => {
    const h = start();
    h.stdin.write(Buffer.alloc(4 * 1000));
    await greetExtension(h);
    assert.deepEqual(
      h.logs.filter((line) => line.message === "bad frame from Firefox"),
      [{ message: "bad frame from Firefox", detail: { error: "invalid JSON", more: 999 } }],
    );
    await finish(h);
  });

  it("ends a call with timeout when the response cannot be serialized", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    const forwarded = await h.out.next();
    h.stdin.write(
      rawFrame(
        `{"type":"response","id":${JSON.stringify(forwarded.id)},"ok":true,"result":{"a":${"[".repeat(DEEP)}${"]".repeat(DEEP)}}}`,
      ),
    );
    assert.deepEqual(await client.frames.next(), errorResponse("r1", "timeout", TIMEOUT_SENTENCE));
    assert.ok(h.logs.some((line) => line.message === "cannot serialize the extension's response"));
    await finish(h, client);
  });

  it("ignores a malformed response, so the call times out", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    await h.out.next();
    writeFrame(h.stdin, { type: "response", ok: true, result: 1 });
    assert.deepEqual(await client.frames.next(), errorResponse("r1", "timeout", TIMEOUT_SENTENCE));
    await finish(h, client);
  });

  it("ignores a response with an unknown id", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    writeFrame(h.stdin, { type: "response", id: "h999", ok: true, result: 1 });
    await relay(h, client, "r1");
    assert.ok(h.logs.some((line) => line.message.includes("unknown id") && line.detail === "h999"));
    await finish(h, client);
  });
});

describe("runHost, socket side", () => {
  it("reports the extension status in the welcome", LIMIT, async () => {
    const h = start();
    const before = await connect(h);
    before.send(mcpHello());
    assert.deepEqual(await before.frames.next(), {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      extension: { connected: false },
    });
    await greetExtension(h, { allUrls: true });
    const afterHello = await connect(h);
    afterHello.send(mcpHello());
    assert.deepEqual(await afterHello.frames.next(), {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      extension: {
        connected: true,
        protocol: PROTOCOL_VERSION,
        version: EXTENSION_VERSION,
        allUrls: true,
      },
    });
    const withoutAllUrls = start();
    await greetExtension(withoutAllUrls);
    const third = await connect(withoutAllUrls);
    third.send(mcpHello());
    assert.deepEqual((await third.frames.next()).extension, {
      connected: true,
      protocol: PROTOCOL_VERSION,
      version: EXTENSION_VERSION,
    });
    await finish(h, before, afterHello);
    await finish(withoutAllUrls, third);
  });

  it("relays a request under a host id and routes the responses back", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1", { session: "s9", method: "navigate", params: { url: "x" } }));
    const forwarded = await h.out.next();
    assert.match(String(forwarded.id), /^h[0-9a-z]+$/);
    assert.deepEqual(forwarded, {
      type: "request",
      id: forwarded.id,
      session: "s9",
      method: "navigate",
      params: { url: "x" },
    });
    writeFrame(h.stdin, { type: "response", id: forwarded.id, ok: true, result: { tabs: [1] } });
    assert.deepEqual(await client.frames.next(), {
      type: "response",
      id: "r1",
      ok: true,
      result: { tabs: [1] },
    });

    client.send(request("r2", { session: "s9" }));
    const second = await h.out.next();
    writeFrame(h.stdin, {
      type: "response",
      id: second.id,
      ok: false,
      error: { code: "no_tab", message: "No such tab." },
    });
    assert.deepEqual(await client.frames.next(), errorResponse("r2", "no_tab", "No such tab."));

    client.send(request("r3", { session: "s9" }));
    const third = await h.out.next();
    h.stdin.write(
      rawFrame(
        `{"type":"response","id":${JSON.stringify(third.id)},"ok":true,"result":{"__proto__":{"polluted":true},"a":1}}`,
      ),
    );
    const reply = await client.frames.next();
    const result = record(reply.result);
    assert.ok(Object.hasOwn(result, "__proto__"));
    assert.equal(
      JSON.stringify(reply),
      '{"type":"response","id":"r3","ok":true,"result":{"__proto__":{"polluted":true},"a":1}}',
    );
    await finish(h, client);
  });

  it("relays an id __proto__ and a session constructor", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("__proto__", { session: "constructor" }));
    const forwarded = await h.out.next();
    assert.equal(forwarded.session, "constructor");
    writeFrame(h.stdin, { type: "response", id: forwarded.id, ok: true, result: 7 });
    assert.deepEqual(await client.frames.next(), {
      type: "response",
      id: "__proto__",
      ok: true,
      result: 7,
    });
    await finish(h, client);
  });

  it("destroys a socket hello with role extension and never registers it", LIMIT, async () => {
    const h = start();
    const impostor = await connect(h);
    impostor.send({ ...mcpHello(), role: "extension" });
    await within(impostor.closed);
    assert.equal(impostor.frames.received(), 0);
    const client = await greet(h);
    client.send(request("r1"));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse(
        "r1",
        "extension_disconnected",
        "The Foxleash extension has not connected to the native host yet.",
      ),
    );
    await tick();
    assert.equal(client.frames.received(), 2);
    assert.equal(h.out.received(), 0);
    assert.deepEqual(
      h.logs.filter((line) => line.message.endsWith("greeted")).map((line) => line.message),
      ["c2 greeted"],
    );
    await finish(h, client);
  });

  for (const [name, setup] of [
    ["a request before a hello", [request("r1")]],
    ["a second hello", [mcpHello(), mcpHello()]],
    ["a welcome", [mcpHello(), { type: "welcome", protocol: PROTOCOL_VERSION, version: VERSION }]],
    ["a response", [mcpHello(), { type: "response", id: "h1", ok: true, result: 1 }]],
    ["a malformed request without an id", [mcpHello(), { type: "request", session: "s1" }]],
  ] as const) {
    it(`destroys the connection on ${name}`, LIMIT, async () => {
      const h = start();
      const client = await connect(h);
      for (const message of setup) {
        client.send(message);
      }
      await within(client.closed);
      assert.ok(client.frames.received() <= 1);
      assert.ok(h.logs.some((line) => line.message.startsWith("dropped c1:")));
      await finish(h);
    });
  }

  it("answers a malformed request with an id with invalid_request", LIMIT, async () => {
    const h = start();
    const client = await greet(h);
    client.send({ ...request("r1"), params: 1 });
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r1", "invalid_request", "invalid params"),
    );
    await finish(h, client);
  });

  it("does not log refusals answered to the peer", LIMIT, async () => {
    const h = start();
    const client = await greet(h);
    const before = h.logs.length;
    const burst = Array.from({ length: 50 }, (_, index) =>
      encodeFrame(JSON.stringify({ ...request(`r${index}`), params: 1 })),
    );
    client.socket.write(Buffer.concat(burst));
    for (let index = 0; index < 50; index += 1) {
      assert.deepEqual(
        await client.frames.next(),
        errorResponse(`r${index}`, "invalid_request", "invalid params"),
      );
    }
    assert.equal(h.logs.length, before);
    await finish(h, client);
  });

  it("relays a request of exactly 1 MB and refuses one byte more", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    const base = Buffer.byteLength(JSON.stringify(forwardedShape("h1", "")));
    const pad = "x".repeat(NATIVE_MESSAGE_LIMIT - base);
    client.send(request("r1", { params: { pad } }));
    const forwarded = await h.out.next();
    assert.equal(forwarded.id, "h1");
    assert.equal(Buffer.byteLength(JSON.stringify(forwarded)), NATIVE_MESSAGE_LIMIT);
    writeFrame(h.stdin, { type: "response", id: forwarded.id, ok: true, result: 1 });
    assert.deepEqual(await client.frames.next(), {
      type: "response",
      id: "r1",
      ok: true,
      result: 1,
    });
    client.send(request("r2", { params: { pad: `${pad}x` } }));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse(
        "r2",
        "message_too_large",
        `The request is ${NATIVE_MESSAGE_LIMIT + 1} bytes; Firefox accepts at most 1 MB per message.`,
      ),
    );
    await tick();
    assert.equal(h.out.received(), 2);
    await finish(h, client);
  });

  it("refuses a deeply nested params with invalid_request and keeps relaying", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.socket.write(
      rawFrame(
        `{"type":"request","id":"d1","session":"s1","method":"tabs_list","params":{"a":${"[".repeat(DEEP)}${"]".repeat(DEEP)}}}`,
      ),
    );
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("d1", "invalid_request", "invalid params"),
    );
    await relay(h, client, "r1");
    assert.equal(h.out.received(), 2);
    await finish(h, client);
  });

  it("refuses a second session on a bound connection", LIMIT, async () => {
    const h = start();
    const client = await greet(h);
    client.send(request("r1", { session: "s1" }));
    await client.frames.next();
    client.send(request("r2", { session: "s2" }));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r2", "session_mismatch", "This connection is bound to another session."),
    );
    await tick();
    assert.equal(client.frames.received(), 3);
    await finish(h, client);
  });

  it("refuses a session owned by another connection until the owner closes", LIMIT, async () => {
    const h = start();
    const owner = await greet(h);
    owner.send(request("r1", { session: "shared" }));
    assert.equal((await owner.frames.next()).ok, false);
    const refused = await greet(h);
    const inUse = errorResponse(
      "r2",
      "session_in_use",
      "This session belongs to another connection.",
    );
    refused.send(request("r2", { session: "shared" }));
    assert.deepEqual(await refused.frames.next(), inUse);
    await end(refused);
    const waiting = await greet(h);
    waiting.send(request("r2", { session: "shared" }));
    assert.deepEqual(await waiting.frames.next(), inUse);
    await end(owner);
    waiting.send(request("r3", { session: "shared" }));
    assert.equal(record((await waiting.frames.next()).error).code, "extension_disconnected");
    await finish(h, waiting);
  });

  it("times out a request the extension never answers", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    await h.out.next();
    assert.deepEqual(await client.frames.next(), errorResponse("r1", "timeout", TIMEOUT_SENTENCE));
    await finish(h, client);
  });

  it("refuses a duplicate id while it is pending, and accepts it again later", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    const first = await h.out.next();
    client.send(request("r1"));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r1", "duplicate_id", "A request with this id is still pending."),
    );
    await tick();
    assert.equal(h.out.received(), 2);
    writeFrame(h.stdin, { type: "response", id: first.id, ok: true, result: 1 });
    assert.equal((await client.frames.next()).ok, true);
    client.send(request("r1"));
    assert.equal((await h.out.next()).id, "h2");
    assert.deepEqual(await client.frames.next(), errorResponse("r1", "timeout", TIMEOUT_SENTENCE));
    client.send(request("r1"));
    assert.equal((await h.out.next()).id, "h3");
    await finish(h, client);
  });

  it("refuses requests while the extension speaks another protocol", LIMIT, async () => {
    const h = start();
    writeFrame(h.stdin, { ...extensionHello(), protocol: PROTOCOL_VERSION + 1 });
    await h.out.next();
    const sentence = protocolMismatch(
      { part: "host", protocol: PROTOCOL_VERSION, version: VERSION },
      { part: "extension", protocol: PROTOCOL_VERSION + 1, version: EXTENSION_VERSION },
    );
    assert.ok(sentence !== null);
    assert.ok(
      h.logs.some(
        (line) =>
          line.message === "protocol mismatch with the extension" && line.detail === sentence,
      ),
    );
    const client = await greet(h);
    client.send(request("r1"));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r1", "protocol_mismatch", sentence),
    );
    await tick();
    assert.equal(h.out.received(), 1);
    await finish(h, client);
  });

  for (const oldestProtocol of [PROTOCOL_VERSION, PROTOCOL_VERSION - 1]) {
    it(
      `relays to a newer extension that serves protocol ${oldestProtocol} and later`,
      LIMIT,
      async () => {
        const h = start();
        await greetExtension(h, { protocol: PROTOCOL_VERSION + 1, oldestProtocol });
        assert.ok(!h.logs.some((line) => line.message === "protocol mismatch with the extension"));
        const client = await greet(h);
        await relay(h, client, "r1");
        await finish(h, client);
      },
    );
  }

  it("refuses requests while the host is older than the extension's window", LIMIT, async () => {
    const h = start();
    await greetExtension(h, {
      protocol: PROTOCOL_VERSION + 2,
      oldestProtocol: PROTOCOL_VERSION + 1,
    });
    const sentence =
      `The Foxleash native host (version ${VERSION}, protocol ${PROTOCOL_VERSION}) is older ` +
      `than the Foxleash extension (version ${EXTENSION_VERSION}, protocol ${PROTOCOL_VERSION + 2}, ` +
      `which works with protocol ${PROTOCOL_VERSION + 1} and later): Firefox is still running ` +
      "the old native host, so update Foxleash with `npx foxleash@latest setup` if " +
      "you have not yet and then restart Firefox.";
    const client = await greet(h);
    client.send(request("r1"));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r1", "protocol_mismatch", sentence),
    );
    await tick();
    assert.equal(h.out.received(), 1);
    await finish(h, client);
  });

  for (const oldestProtocol of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION - 2]) {
    it(
      `refuses an older extension that serves protocol ${oldestProtocol} and later`,
      LIMIT,
      async () => {
        const h = start();
        await greetExtension(h, { protocol: PROTOCOL_VERSION - 1, oldestProtocol });
        const sentence =
          `The Foxleash extension (version ${EXTENSION_VERSION}, protocol ${PROTOCOL_VERSION - 1}) ` +
          `is older than the Foxleash native host (version ${VERSION}, protocol ${PROTOCOL_VERSION}): ` +
          "update the add-on in Firefox (open about:addons and choose Check for Updates), or " +
          "install it again from https://addons.mozilla.org/firefox/addon/foxleash/.";
        const client = await greet(h);
        client.send(request("r1"));
        assert.deepEqual(
          await client.frames.next(),
          errorResponse("r1", "protocol_mismatch", sentence),
        );
        await tick();
        assert.equal(h.out.received(), 1);
        await finish(h, client);
      },
    );
  }

  it("refuses requests from a peer that speaks another protocol", LIMIT, async () => {
    const h = start();
    const client = await connect(h);
    client.send({ ...mcpHello(), protocol: PROTOCOL_VERSION + 1 });
    await client.frames.next();
    const sentence = protocolMismatch(
      { part: "mcp", protocol: PROTOCOL_VERSION + 1, version: "2.0.0" },
      { part: "host", protocol: PROTOCOL_VERSION, version: VERSION },
    );
    assert.ok(sentence !== null);
    client.send(request("r1"));
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r1", "protocol_mismatch", sentence),
    );
    await tick();
    assert.equal(client.frames.received(), 2);
    await finish(h, client);
  });

  it("logs an invalid-JSON frame and an oversize frame, then keeps relaying", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.socket.write(rawFrame("{"));
    await tick();
    const oversize = Buffer.alloc(4 + SOCKET_FRAME_LIMIT + 1);
    oversize.writeUInt32LE(SOCKET_FRAME_LIMIT + 1, 0);
    client.socket.write(oversize);
    await relay(h, client, "r1");
    assert.deepEqual(badFrameLines(h), [{ message: "bad frame from c1", detail: "invalid JSON" }]);
    await end(client);
    await until(() => badFrameLines(h).length === 2);
    assert.deepEqual(badFrameLines(h)[1], {
      message: "c1 sent more bad frames",
      detail: { count: 1 },
    });
    await finish(h);
  });

  it("logs many zero-length frames in one chunk as one line", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.socket.write(Buffer.alloc(4 * 1000));
    await relay(h, client, "r1");
    assert.deepEqual(badFrameLines(h), [{ message: "bad frame from c1", detail: "invalid JSON" }]);
    await finish(h, client);
  });

  it("logs one line for many separate bad writes on a connection", LIMIT, async () => {
    const h = start();
    const client = await connect(h);
    for (let index = 0; index < 200; index += 1) {
      client.socket.write(Buffer.alloc(4));
      await new Promise((resolve) => setImmediate(resolve));
    }
    client.send(mcpHello());
    await client.frames.next();
    assert.deepEqual(badFrameLines(h), [{ message: "bad frame from c1", detail: "invalid JSON" }]);
    await end(client);
    await until(() => badFrameLines(h).length === 2);
    assert.deepEqual(badFrameLines(h)[1], {
      message: "c1 sent more bad frames",
      detail: { count: 199 },
    });
    await finish(h);
  });

  it("delivers a response once and sends no timeout after it", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    const forwarded = await h.out.next();
    const response = { type: "response", id: forwarded.id, ok: true, result: 1 };
    writeFrame(h.stdin, response);
    writeFrame(h.stdin, response);
    assert.equal((await client.frames.next()).ok, true);
    await delay(REQUEST_TIMEOUT_MS * 3);
    assert.equal(client.frames.received(), 2);
    assert.ok(h.logs.some((line) => line.message.includes("unknown id")));
    await finish(h, client);
  });

  it("forgets the pending requests of a connection that closed", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    const forwarded = await h.out.next();
    await end(client);
    writeFrame(h.stdin, { type: "response", id: forwarded.id, ok: true, result: 1 });
    await until(() => h.logs.some((line) => line.message.includes("unknown id")));
    await finish(h);
  });

  it("logs a connection's open, greeting and close", LIMIT, async () => {
    const h = start();
    const client = await greet(h);
    client.socket.write(rawFrame("{"));
    await end(client);
    await until(() => h.logs.some((line) => line.message === "c1 disconnected"));
    assert.deepEqual(h.logs.slice(1), [
      { message: "c1 connected", detail: undefined },
      { message: "c1 greeted", detail: { version: "2.0.0", protocol: PROTOCOL_VERSION } },
      { message: "bad frame from c1", detail: "invalid JSON" },
      { message: "c1 disconnected", detail: undefined },
    ]);
    await finish(h);
  });

  it("survives a peer that closes before its replies are written", LIMIT, async () => {
    const h = start();
    const client = await greet(h);
    const burst = Array.from({ length: 200 }, (_, index) =>
      encodeFrame(JSON.stringify({ ...request(`r${index}`), params: 1 })),
    );
    client.socket.write(Buffer.concat(burst));
    client.socket.destroy();
    await until(() => h.logs.some((line) => line.message === "c1 socket error"));
    await finish(h);
  });

  it("stops reading a chunk at the frame that destroyed the connection", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.socket.write(
      Buffer.concat([
        encodeFrame(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION, version: "1" })),
        encodeFrame(JSON.stringify(request("r1", { session: "doomed" }))),
      ]),
    );
    await within(client.closed);
    const other = await greet(h);
    other.send(request("r2", { session: "other" }));
    assert.equal((await h.out.next()).session, "other");
    await finish(h, other);
  });
});

describe("runHost, session end", () => {
  it("tells Firefox when a bound connection closes", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    await relay(h, client, "r1");
    await end(client);
    assert.deepEqual(await h.out.next(), { type: "session_end", session: "s1" });
    await until(() => h.logs.some((line) => line.message === "c1 disconnected"));
    assert.deepEqual(h.logs.slice(-2), [
      { message: "c1 session ended", detail: undefined },
      { message: "c1 disconnected", detail: undefined },
    ]);
    await finish(h);
  });

  it("sends nothing for a connection that never sent a request", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    await end(client);
    await assertNothingSent(h, "c1", 1);
    await finish(h);
  });

  it("ends only the owner's session, once, when a refused connection closes", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const owner = await greet(h);
    owner.send(request("r1", { session: "shared" }));
    const forwarded = await h.out.next();
    writeFrame(h.stdin, { type: "response", id: forwarded.id, ok: true, result: null });
    await owner.frames.next();
    const refused = await greet(h);
    refused.send(request("r2", { session: "shared" }));
    assert.equal(record((await refused.frames.next()).error).code, "session_in_use");
    await end(refused);
    await assertNothingSent(h, "c2", 2);
    await end(owner);
    assert.deepEqual(await h.out.next(), { type: "session_end", session: "shared" });
    await until(() => h.logs.some((line) => line.message === "c1 disconnected"));
    await tick();
    assert.equal(h.out.received(), 3);
    await finish(h);
  });

  it("tells a newer extension that serves this protocol when a session ends", LIMIT, async () => {
    const h = start();
    await greetExtension(h, { protocol: PROTOCOL_VERSION + 1, oldestProtocol: PROTOCOL_VERSION });
    const client = await greet(h);
    await relay(h, client, "r1");
    await end(client);
    assert.deepEqual(await h.out.next(), { type: "session_end", session: "s1" });
    await finish(h);
  });

  it("sends nothing when the connection closes before the extension's hello", LIMIT, async () => {
    const h = start();
    const client = await greet(h);
    client.send(request("r1"));
    assert.equal(record((await client.frames.next()).error).code, "extension_disconnected");
    await end(client);
    await assertNothingSent(h, "c1", 0);
    await finish(h);
  });

  it("sends nothing while the extension speaks another protocol", LIMIT, async () => {
    const h = start();
    await greetExtension(h, { protocol: PROTOCOL_VERSION + 1 });
    const client = await greet(h);
    client.send(request("r1"));
    assert.equal(record((await client.frames.next()).error).code, "protocol_mismatch");
    await end(client);
    await assertNothingSent(h, "c1", 1);
    await finish(h);
  });

  it("sends nothing for the connections that close() ends", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    await relay(h, client, "r1");
    h.host.close("signal");
    assert.equal(await within(h.host.done), 0);
    await assertNothingSent(h, "c1", 2);
  });

  it("logs and ignores a session_end from Firefox", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    writeFrame(h.stdin, { type: "session_end", session: "s1" });
    const client = await greet(h);
    await relay(h, client, "r1");
    assert.ok(
      h.logs.some(
        (line) =>
          line.message === "ignored a message from Firefox in the wrong direction" &&
          line.detail === "session_end",
      ),
    );
    await finish(h, client);
  });

  it("drops an MCP peer that sends a session_end", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send({ type: "session_end", session: "s1" });
    await within(client.closed);
    await assertNothingSent(h, "c1", 1);
    assert.ok(
      h.logs.some(
        (line) =>
          line.message === "dropped c1: sent a message in the wrong direction" &&
          line.detail === "session_end",
      ),
    );
    await finish(h);
  });

  it("ends only its own session when a bound peer sends another's session_end", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    await relay(h, client, "r1");
    client.send({ type: "session_end", session: "other" });
    await within(client.closed);
    assert.deepEqual(await h.out.next(), { type: "session_end", session: "s1" });
    await until(() => h.logs.some((line) => line.message === "c1 disconnected"));
    await tick();
    assert.equal(h.out.received(), 3);
    await finish(h);
  });
});

describe("runHost, closing", () => {
  it("leaves stdin destroyed and is idempotent", LIMIT, async () => {
    const h = start();
    h.host.close("first");
    h.host.close("second");
    assert.equal(await within(h.host.done), 0);
    assert.equal(h.stdin.destroyed, true);
    assert.deepEqual(
      h.logs.filter((line) => line.message.startsWith("closing:")).map((line) => line.message),
      ["closing: first"],
    );
    assert.equal(existsSync(h.host.socketPath), false);
  });

  it("fails pending requests and removes the socket when stdin ends", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await greet(h);
    client.send(request("r1"));
    await h.out.next();
    const socketFile = h.host.socketPath;
    assert.equal(existsSync(socketFile), true);
    h.stdin.end();
    assert.deepEqual(
      await client.frames.next(),
      errorResponse("r1", "extension_disconnected", CLOSED_SENTENCE),
    );
    await within(client.closed);
    assert.equal(await within(h.host.done), 0);
    assert.equal(existsSync(socketFile), false);
    assert.equal(h.stdin.destroyed, true);
    for (const event of ["data", "end", "error"]) {
      assert.equal(h.stdin.listenerCount(event), 0, event);
    }
    assert.ok(
      h.logs.some((line) => line.message === "closing: Firefox closed the native messaging port"),
    );
  });

  it("relays nothing a half-open peer sends after close", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    const client = await connect(h, true);
    client.send(mcpHello());
    await client.frames.next();
    client.socket.once("end", () => {
      client.send(request("r1"));
      client.socket.end();
    });
    h.host.close("signal");
    assert.equal(await within(h.host.done), 0);
    await tick();
    assert.equal(h.out.received(), 1);
  });

  it("destroys a half-open peer after a second", LIMIT, async () => {
    const h = start();
    const client = await connect(h, true);
    client.send(mcpHello());
    await client.frames.next();
    const started = performance.now();
    h.host.close("signal");
    assert.equal(await within(h.host.done, 3000), 0);
    assert.ok(performance.now() - started >= 900);
    client.socket.destroy();
  });

  it("closes when stdin fails", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    h.stdin.emit("error", new Error("read failed"));
    assert.equal(await within(h.host.done), 0);
    assert.deepEqual(h.logs.slice(-2), [
      { message: "cannot read from Firefox", detail: "UNKNOWN" },
      { message: "closing: Firefox closed the native messaging port", detail: undefined },
    ]);
  });

  it("closes when stdout fails", LIMIT, async () => {
    const h = start();
    await greetExtension(h);
    h.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    assert.equal(await within(h.host.done), 0);
    assert.deepEqual(h.logs.slice(-2), [
      { message: "cannot write to Firefox", detail: "EPIPE" },
      { message: "closing: Firefox closed the native messaging port", detail: undefined },
    ]);
  });

  it("closes cleanly right after it starts", LIMIT, async () => {
    const h = start();
    h.host.close("signal");
    assert.equal(await within(h.host.done), 0);
    assert.equal(existsSync(h.host.socketPath), false);
  });
});

describe("runHost, startup", () => {
  it("refuses a socket directory that is a symlink", LIMIT, async () => {
    const target = privateDir("symlink-target");
    const socketDir = path.join(root, "symlink");
    symlinkSync(target, socketDir);
    await assertStartFails(
      start({ socketDir }),
      "cannot start",
      dirSentence(socketDir, "is not a directory"),
    );
  });

  it("refuses a socket directory owned by another uid", LIMIT, async () => {
    const socketDir = privateDir("other-uid");
    await assertStartFails(
      start({ socketDir, uid: uid + 1 }),
      "cannot start",
      dirSentence(socketDir, `belongs to uid ${uid}, not you (uid ${uid + 1})`),
    );
  });

  it("refuses a socket directory open to other users", LIMIT, async () => {
    const socketDir = privateDir("open");
    chmodSync(socketDir, 0o755);
    await assertStartFails(
      start({ socketDir }),
      "cannot start",
      dirSentence(socketDir, "is open to other users (mode 0755)"),
    );
  });

  it("refuses a socket path that is too long", LIMIT, async () => {
    const socketDir = path.join(root, "x".repeat(100));
    const h = start({ socketDir });
    h.host.close("signal");
    await assertStartFails(h, `cannot listen on ${h.host.socketPath}: EINVAL`, undefined);
  });

  it("removes stale sockets of dead processes and its own old socket", LIMIT, async () => {
    const socketDir = privateDir("sweep");
    const stale = path.join(socketDir, "2147483647.sock");
    const server = net.createServer();
    await listenOn(server, path.join(socketDir, "listening.sock"));
    renameSync(path.join(socketDir, "listening.sock"), stale);
    await new Promise((resolve) => server.close(resolve));
    assert.ok(statSync(stale).isSocket());
    const live = path.join(socketDir, `${process.pid}.sock`);
    const liveServer = net.createServer();
    servers.push(liveServer);
    await listenOn(liveServer, live);
    const own = path.join(socketDir, "4242.sock");
    writeFileSync(own, "");
    const h = start({ socketDir, pid: 4242 });
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(live), true);
    assert.equal(h.host.socketPath, own);
    assert.ok(statSync(own).isSocket());
    await finish(h);
  });

  it("never removes a path it could not bind", LIMIT, async () => {
    const socketDir = privateDir("blocked");
    const own = path.join(socketDir, "4343.sock");
    mkdirSync(own);
    const h = start({ socketDir, pid: 4343 });
    assert.equal(await within(h.host.done), 1);
    assert.deepEqual(h.logs, [
      { message: "cannot remove stale socket", detail: { path: own, code: "EISDIR" } },
      { message: `cannot listen on ${own}: EADDRINUSE`, detail: undefined },
    ]);
    h.host.close("signal");
    assert.equal(h.logs.length, 2);
    assert.ok(statSync(own).isDirectory());
    assert.equal(h.stdin.listenerCount("data"), 0);
  });

  it("creates the socket file owner-only and restores the umask", LIMIT, async () => {
    const saved = process.umask(0o002);
    let h: Harness;
    try {
      h = start();
    } finally {
      const current = process.umask(saved);
      assert.equal(current, 0o002);
    }
    assert.equal(statSync(h.host.socketPath).mode & 0o777, 0o600);
    await finish(h);
  });
});

describe("hostCommand", () => {
  it("exits 1 without getuid", LIMIT, async () => {
    const proc = fakeProcess({}, false);
    assert.equal(await hostCommand(proc), 1);
    assert.deepEqual(proc.exitCodes, [1]);
    assert.equal(proc.text(), "foxleash host: The Foxleash native host runs on Linux only.\n");
    assert.equal(proc.listeners.size, 0);
  });

  it("closes on SIGTERM while stdin is open and exits 0", LIMIT, async () => {
    const xdg = privateDir(`xdg-${nextId()}`);
    const proc = fakeProcess({ XDG_RUNTIME_DIR: xdg });
    const result = hostCommand(proc);
    await until(() => proc.text().includes("listening on"));
    assert.deepEqual([...proc.listeners.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM", "exit"]);
    for (const set of proc.listeners.values()) {
      assert.equal(set.size, 1);
    }
    const socketFile = path.join(xdg, "foxleash", `${proc.pid}.sock`);
    assert.equal(existsSync(socketFile), true);
    proc.emit("SIGTERM");
    assert.equal(await within(result), 0);
    assert.deepEqual(proc.exitCodes, [0]);
    for (const set of proc.listeners.values()) {
      assert.equal(set.size, 0);
    }
    assert.equal(existsSync(socketFile), false);
    assert.ok(proc.text().includes("foxleash host: closing: signal\n"));
  });

  for (const signal of ["SIGINT", "SIGHUP"]) {
    it(`closes on ${signal}`, LIMIT, async () => {
      const proc = fakeProcess({ XDG_RUNTIME_DIR: privateDir(`xdg-${nextId()}`) });
      const result = hostCommand(proc);
      await until(() => proc.text().includes("listening on"));
      proc.emit(signal);
      assert.equal(await within(result), 0);
    });
  }

  it("removes the socket file in its exit listener", LIMIT, async () => {
    const xdg = privateDir(`xdg-${nextId()}`);
    const proc = fakeProcess({ XDG_RUNTIME_DIR: xdg });
    const result = hostCommand(proc);
    await until(() => proc.text().includes("listening on"));
    const socketFile = path.join(xdg, "foxleash", `${proc.pid}.sock`);
    assert.equal(existsSync(socketFile), true);
    proc.emit("exit");
    assert.equal(existsSync(socketFile), false);
    proc.emit("exit");
    proc.emit("SIGTERM");
    assert.equal(await within(result), 0);
    assert.equal(proc.text().includes("cannot remove"), false);
  });

  it("keeps running after stderr fails and still exits 0 on SIGTERM", LIMIT, async () => {
    const proc = fakeProcess({ XDG_RUNTIME_DIR: privateDir(`xdg-${nextId()}`) });
    const result = hostCommand(proc);
    await until(() => proc.text().includes("listening on"));
    proc.stderr.emit("error", new Error("write EPIPE"));
    const before = proc.text();
    proc.emit("SIGTERM");
    assert.equal(await within(result), 0);
    assert.deepEqual(proc.exitCodes, [0]);
    assert.equal(proc.text(), before);
  });

  it("logs each skipped socket directory candidate", LIMIT, async () => {
    const proc = fakeProcess({ XDG_RUNTIME_DIR: "" });
    // This host binds in the user's real runtime directory: a pid above the kernel's limit (2^22)
    // cannot be a running host whose socket the sweep would remove.
    proc.pid = 0x7ffffffe;
    const result = hostCommand(proc);
    await until(() => proc.text().includes("listening on") || proc.text().includes("cannot"));
    proc.emit("SIGTERM");
    await within(result);
    assert.ok(
      proc
        .text()
        .startsWith('foxleash host: skipped socket directory "XDG_RUNTIME_DIR is empty"\n'),
    );
  });
});

describe("foxleash host as a child process", () => {
  it("welcomes the extension, listens, and exits 0 when stdin ends", CHILD_LIMIT, async () => {
    const xdg = privateDir(`child-${nextId()}`);
    const child = spawnHost(xdg);
    const output = collect(child.stdout);
    const exited = exitOf(child);
    child.stdin.write(encodeFrame(JSON.stringify(extensionHello())));
    await until(() => Buffer.concat(output).length > 0, CHILD_WAIT_MS);
    const socketFile = path.join(xdg, "foxleash", `${child.pid}.sock`);
    assert.equal(existsSync(socketFile), true);
    assert.equal(statSync(socketFile).mode & 0o777, 0o600);
    child.stdin.end();
    assert.deepEqual(await within(exited, CHILD_WAIT_MS), { code: 0, signal: null });
    assert.equal(existsSync(socketFile), false);
    assert.deepEqual(splitFrames(Buffer.concat(output)), [
      { type: "welcome", protocol: PROTOCOL_VERSION, version: SERVER_VERSION },
    ]);
  });

  it("exits 0 on SIGTERM with stdin still open", CHILD_LIMIT, async () => {
    const xdg = privateDir(`child-${nextId()}`);
    const child = spawnHost(xdg);
    const output = collect(child.stdout);
    const exited = exitOf(child);
    child.stdin.write(encodeFrame(JSON.stringify(extensionHello())));
    await until(() => Buffer.concat(output).length > 0, CHILD_WAIT_MS);
    child.kill("SIGTERM");
    assert.deepEqual(await within(exited, CHILD_WAIT_MS), { code: 0, signal: null });
    assert.equal(existsSync(path.join(xdg, "foxleash", `${child.pid}.sock`)), false);
  });
});

function start(options: StartOptions = {}): Harness {
  const id = nextId();
  const socketDir = options.socketDir ?? path.join(root, `host-${id}`);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logs: LogLine[] = [];
  const host = runHost({
    stdin,
    stdout,
    socketDir,
    pid: options.pid ?? 100_000 + id,
    uid: options.uid ?? uid,
    version: VERSION,
    log: (message, detail) => logs.push({ message, detail }),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  hosts.push(host);
  return { host, stdin, stdout, out: frameQueue(stdout), logs, socketDir };
}

function nextId(): number {
  counter += 1;
  return counter;
}

function frameQueue(stream: Readable): FrameQueue {
  const reader = createFrameReader(FRAME_LIMIT);
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  let received = 0;
  stream.on("data", (chunk: Buffer) => {
    for (const event of reader.push(chunk)) {
      assert.ok(event.ok, "the host wrote a bad frame");
      received += 1;
      const frame = record(event.value);
      const waiter = waiters.shift();
      if (waiter === undefined) {
        frames.push(frame);
      } else {
        waiter(frame);
      }
    }
  });
  return {
    next() {
      const frame = frames.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      return within(new Promise((resolve) => waiters.push(resolve)));
    },
    received: () => received,
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function isEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function writeFrame(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(encodeFrame(JSON.stringify(value)));
}

function rawFrame(json: string): Buffer {
  return encodeFrame(json);
}

function extensionHello(): Record<string, unknown> {
  return {
    type: "hello",
    role: "extension",
    protocol: PROTOCOL_VERSION,
    version: EXTENSION_VERSION,
  };
}

function mcpHello(): Record<string, unknown> {
  return { type: "hello", role: "mcp", protocol: PROTOCOL_VERSION, version: "2.0.0" };
}

function request(
  id: string,
  fields: { session?: string; method?: string; params?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    type: "request",
    id,
    session: fields.session ?? "s1",
    method: fields.method ?? "tabs_list",
    params: fields.params ?? {},
  };
}

function forwardedShape(id: string, pad: string): Record<string, unknown> {
  return { type: "request", id, session: "s1", method: "tabs_list", params: { pad } };
}

function errorResponse(id: string, code: string, message: string): Record<string, unknown> {
  return { type: "response", id, ok: false, error: { code, message } };
}

function tick(): Promise<void> {
  return delay(10);
}

async function until(condition: () => boolean, ms = WAIT_MS): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "condition not met in time");
    await delay(5);
  }
}

function within<T>(promise: Promise<T>, ms = WAIT_MS): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`not settled within ${ms} ms`);
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function greetExtension(h: Harness, extra: Record<string, unknown> = {}): Promise<void> {
  writeFrame(h.stdin, { ...extensionHello(), ...extra });
  assert.equal((await h.out.next()).type, "welcome");
}

async function connect(h: Harness, allowHalfOpen = false): Promise<Client> {
  const socket = net.createConnection({ path: h.host.socketPath, allowHalfOpen });
  sockets.push(socket);
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    frames: frameQueue(socket),
    closed,
    send: (value) => writeFrame(socket, value),
  };
}

async function greet(h: Harness): Promise<Client> {
  const client = await connect(h);
  client.send(mcpHello());
  assert.equal((await client.frames.next()).type, "welcome");
  return client;
}

async function relay(h: Harness, client: Client, id: string): Promise<void> {
  client.send(request(id));
  const forwarded = await h.out.next();
  assert.equal(forwarded.type, "request");
  writeFrame(h.stdin, { type: "response", id: forwarded.id, ok: true, result: null });
  assert.deepEqual(await client.frames.next(), { type: "response", id, ok: true, result: null });
}

async function end(client: Client): Promise<void> {
  client.socket.end();
  await within(client.closed);
}

async function finish(h: Harness, ...clients: Client[]): Promise<void> {
  await Promise.all(clients.map(end));
  h.host.close("test finished");
  assert.equal(await within(h.host.done), 0);
}

/** The host writes a session_end before it logs the disconnect, so waiting for that line is enough. */
async function assertNothingSent(h: Harness, label: string, frames: number): Promise<void> {
  await until(() => h.logs.some((line) => line.message === `${label} disconnected`));
  await tick();
  assert.equal(h.out.received(), frames);
  assert.equal(
    h.logs.some((line) => line.message === `${label} session ended`),
    false,
  );
}

function badFrameLines(h: Harness): LogLine[] {
  return h.logs.filter((line) => line.message.includes("bad frame"));
}

async function assertStartFails(h: Harness, message: string, detail: unknown): Promise<void> {
  assert.equal(await within(h.host.done), 1);
  assert.deepEqual(h.logs, [{ message, detail }]);
  assert.equal(existsSync(h.host.socketPath), false);
  assert.equal(h.stdin.listenerCount("data"), 0);
  h.host.close("signal");
  assert.equal(h.logs.length, 1);
}

function privateDir(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function dirSentence(dir: string, reason: string): string {
  return `The Foxleash socket directory ${dir} ${reason}; remove it, or set XDG_RUNTIME_DIR to a private directory, and try again.`;
}

function listenOn(server: net.Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
}

function fakeProcess(env: NodeJS.ProcessEnv, withUid = true): FakeProcess {
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  const listeners = new Map<string, Set<() => void>>();
  const exitCodes: number[] = [];
  const proc: FakeProcess = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    pid: 200_000 + nextId(),
    env,
    listeners,
    exitCodes,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return proc;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return proc;
    },
    exit(code) {
      exitCodes.push(code);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
  if (withUid) {
    proc.getuid = () => uid;
  }
  processes.push(proc);
  return proc;
}

function spawnHost(xdg: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [MAIN, "host"], {
    env: { ...process.env, XDG_RUNTIME_DIR: xdg },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function collect(stream: Readable): Buffer[] {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return chunks;
}

function exitOf(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function splitFrames(bytes: Buffer): unknown[] {
  const frames: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(offset + 4 <= bytes.length, "stdout ends inside a frame header");
    const length = bytes.readUInt32LE(offset);
    assert.ok(offset + 4 + length <= bytes.length, "stdout ends inside a frame body");
    frames.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  return frames;
}

function currentUid(): number {
  const getuid = process.getuid;
  assert.ok(getuid !== undefined, "process.getuid is unavailable");
  return getuid();
}
