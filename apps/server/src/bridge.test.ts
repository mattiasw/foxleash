import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { PROTOCOL_VERSION } from "@foxleash/protocol";
import { Bridge, BridgeError, connectToHost, HostError } from "./bridge.ts";
import { createFrameReader, encodeFrame, FRAME_LIMIT, NATIVE_MESSAGE_LIMIT } from "./framing.ts";
import { type FakeHost, type FakeHostOptions, startFakeHost } from "./testing/fake-host.ts";
import { SERVER_VERSION } from "./version.ts";

interface LogLine {
  message: string;
  detail: unknown;
}

interface Harness {
  bridge: Bridge;
  logs: LogLine[];
}

interface StartOptions {
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  onLog?: (line: LogLine) => void;
}

interface Peer {
  path: string;
  events: EventEmitter;
  sockets: net.Socket[];
}

type OnFrame = (socket: net.Socket, value: unknown, index: number) => void;

const uid = currentUid();
const root = mkdtempSync("/tmp/foxleash-test-");
const VERSION = "1.2.3";
const SESSION = "session-1";
// As in production: a stall in the test process must not skip a live host.
const HANDSHAKE_MS = 2_000;
// For the tests about the handshake timer.
const SHORT_HANDSHAKE_MS = 200;
// A stall in the test process must not fail a call the host answers.
const REQUEST_MS = 2_000;
// For the tests about the request timer.
const SHORT_REQUEST_MS = 100;
const LIMIT = { timeout: 3000 };
const NO_HOST =
  "No Foxleash native host is running: start Firefox with the Foxleash extension installed, and run `npx foxleash doctor` (in a Foxleash checkout, `npm run doctor`) if it still fails.";
const TIMEOUT = "The Foxleash native host did not answer in time.";
const CLOSING = "The connection to the Foxleash native host was lost: the MCP server is closing.";
const HOST_CLOSED =
  "The connection to the Foxleash native host was lost: the host closed the connection.";
const UNREADABLE =
  "The connection to the Foxleash native host was lost: the host sent an unreadable message.";
const bridges: Bridge[] = [];
const hosts: FakeHost[] = [];
const servers: net.Server[] = [];
const peerSockets: net.Socket[] = [];
let counter = 0;

after(async () => {
  // A broken bridge can leave a socket open; it must fail the run, not hang it.
  setTimeout(() => process.exit(1), 5000).unref();
  // Hosts first: closing one must not wait for its clients to leave.
  await Promise.all(hosts.map((host) => host.close()));
  for (const bridge of bridges) {
    bridge.close();
  }
  for (const socket of peerSockets) {
    socket.destroy();
  }
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

describe("Bridge, finding the host", () => {
  it("connects to the newest answering socket", LIMIT, async () => {
    const dir = privateDir();
    const older = await fakeHost({ dir, pid: 11, respond: ok("older") });
    const newer = await fakeHost({ dir, pid: 12, respond: ok("newer") });
    age(older.path, 100);
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "newer");
    assert.equal(older.connections, 0);
    assert.equal(newer.connections, 1);
    assert.deepEqual(h.logs, [
      {
        message: "connected to the native host",
        detail: { path: newer.path, version: SERVER_VERSION, protocol: PROTOCOL_VERSION },
      },
    ]);
  });

  it("skips a stale socket file", LIMIT, async () => {
    const dir = privateDir();
    const live = await fakeHost({ dir, pid: 21, respond: ok("live") });
    age(live.path, 100);
    const stale = await staleSocket(dir, 22);
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "live");
    assert.deepEqual(h.logs[0], {
      message: "skipped a socket",
      detail: {
        path: stale,
        error: `Cannot connect to the Foxleash native host at ${stale}: ECONNREFUSED.`,
      },
    });
  });

  it("skips a listener that never answers", LIMIT, async () => {
    const dir = privateDir();
    const live = await fakeHost({ dir, pid: 31, respond: ok("live") });
    age(live.path, 100);
    const silent = await fakeHost({ dir, pid: 32, welcome: null, respond: silence });
    const silentClosed = once(silent.events, "close");
    const h = start(dir, { handshakeTimeoutMs: SHORT_HANDSHAKE_MS });
    assert.equal(await h.bridge.call("tabs_list", {}), "live");
    await silentClosed;
    assert.equal(silent.closes, 1);
    assert.deepEqual(h.logs[0], {
      message: "skipped a socket",
      detail: {
        path: silent.path,
        error: `The Foxleash native host at ${silent.path} did not answer within ${SHORT_HANDSHAKE_MS} ms.`,
      },
    });
  });

  it("skips peers that close early or do not answer with a welcome", LIMIT, async () => {
    const dir = privateDir();
    const reads = await rawPeer(dir, 41, (socket) => socket.end());
    const destroys = await rawPeer(
      dir,
      42,
      () => {},
      (socket) => socket.destroy(),
    );
    const responds = await rawPeer(dir, 43, (socket) =>
      writeFrame(socket, { type: "response", id: "r1", ok: true, result: null }),
    );
    const garbles = await rawPeer(dir, 44, (socket) => socket.write(encodeFrame("{")));
    age(reads.path, 400);
    age(destroys.path, 300);
    age(responds.path, 200);
    age(garbles.path, 100);
    const h = start(dir);
    await rejectsWith(h.bridge.call("tabs_list", {}), NO_HOST);
    assert.deepEqual(h.logs, [
      skipped(garbles.path, "did not answer with a welcome"),
      skipped(responds.path, "did not answer with a welcome"),
      skipped(destroys.path, "closed the connection before answering"),
      skipped(reads.path, "closed the connection before answering"),
    ]);
  });

  it("gives the no-host sentence without a directory", LIMIT, async () => {
    const h = start(path.join(root, "missing"));
    await rejectsWith(h.bridge.call("tabs_list", {}), NO_HOST);
    assert.deepEqual(h.logs, []);
  });

  it("gives the no-host sentence for an empty directory", LIMIT, async () => {
    const h = start(privateDir());
    await rejectsWith(h.bridge.call("tabs_list", {}), NO_HOST);
  });

  it("gives the no-host sentence with only stale sockets", LIMIT, async () => {
    const dir = privateDir();
    await staleSocket(dir, 51);
    await staleSocket(dir, 52);
    const h = start(dir);
    await rejectsWith(h.bridge.call("tabs_list", {}), NO_HOST);
    assert.equal(h.logs.length, 2);
  });

  it("gives the socket-directory sentence for a directory open to others", LIMIT, async () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    const h = start(dir);
    await rejectsWith(
      h.bridge.call("tabs_list", {}),
      `The Foxleash socket directory ${dir} is open to other users (mode 0755); remove it, or set XDG_RUNTIME_DIR to a private directory, and try again.`,
    );
  });

  it("retries a failed connect on the next call", LIMIT, async () => {
    const dir = privateDir();
    const h = start(dir);
    await rejectsWith(h.bridge.call("tabs_list", {}), NO_HOST);
    await fakeHost({ dir, pid: 61, respond: ok("later") });
    assert.equal(await h.bridge.call("tabs_list", {}), "later");
  });

  it("shares one connect between concurrent first calls", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 71, respond: ok("both") });
    const h = start(dir);
    assert.deepEqual(
      await Promise.all([h.bridge.call("tabs_list", {}), h.bridge.call("tabs_list", {})]),
      ["both", "both"],
    );
    assert.equal(host.connections, 1);
    assert.deepEqual(
      host.requests.map((request) => field(request, "id")),
      ["r1", "r2"],
    );
  });

  it("reports a protocol mismatch on every call without sending a request", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({
      dir,
      pid: 81,
      welcome: { type: "welcome", protocol: PROTOCOL_VERSION + 1, version: "9.9.9" },
      respond: ok(null),
    });
    const h = start(dir);
    const sentence =
      `The Foxleash MCP server (version ${VERSION}, protocol ${PROTOCOL_VERSION}) is older than the ` +
      `Foxleash native host (version 9.9.9, protocol ${PROTOCOL_VERSION + 1}): your MCP client is ` +
      "still running the old MCP server, so update Foxleash with `npx foxleash@latest setup` " +
      "if you have not yet and then restart your MCP client.";
    await rejectsWith(h.bridge.call("tabs_list", {}), sentence);
    await rejectsWith(h.bridge.call("tabs_list", {}), sentence);
    assert.equal(host.connections, 1);
    assert.deepEqual(host.requests, []);
  });
});

describe("Bridge, the handshake", () => {
  it("gives the errno code of a refused connect", LIMIT, async () => {
    const dir = privateDir();
    const stale = await staleSocket(dir, 101);
    const error = await caught(connectToHost(stale, { version: VERSION, log: () => {} }));
    assertBridgeError(
      error,
      `Cannot connect to the Foxleash native host at ${stale}: ECONNREFUSED.`,
    );
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "ECONNREFUSED");
  });

  it("gives no errno code for a socket error once connected", LIMIT, async () => {
    const dir = privateDir();
    const peerPath = path.join(dir, "103.sock");
    // Closing with the hello still unread makes the client's next read fail with ECONNRESET.
    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
      setTimeout(() => socket.destroy(), 50);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(peerPath, resolve));
    const error = await caught(connectToHost(peerPath, { version: VERSION, log: () => {} }));
    assertBridgeError(
      error,
      `The Foxleash native host at ${peerPath} closed the connection before answering.`,
    );
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, undefined);
  });

  it("gives no errno code for a failure once connected", LIMIT, async () => {
    const dir = privateDir();
    const peer = await rawPeer(dir, 102, (socket) => writeFrame(socket, {}));
    const error = await caught(connectToHost(peer.path, { version: VERSION, log: () => {} }));
    assertBridgeError(
      error,
      `The Foxleash native host at ${peer.path} did not answer with a welcome.`,
    );
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, undefined);
  });

  it("hands over the connection with none of its own listeners or timers", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 97, respond: silence });
    const logs: LogLine[] = [];
    const connection = await connectToHost(host.path, {
      version: VERSION,
      handshakeTimeoutMs: SHORT_HANDSHAKE_MS,
      log: (message, detail) => logs.push({ message, detail }),
    });
    peerSockets.push(connection.socket);
    assert.deepEqual(connection.welcome, welcomeOfHost());
    for (const event of ["connect", "data", "error", "close"]) {
      assert.equal(connection.socket.listenerCount(event), 0, event);
    }
    // Past the handshake timeout, the connection is still open.
    await delay(SHORT_HANDSHAKE_MS + 60);
    assert.equal(connection.socket.destroyed, false);
    assert.equal(host.closes, 0);
    assert.deepEqual(logs, []);
  });

  it("drops further frames that arrive with the welcome", LIMIT, async () => {
    const dir = privateDir();
    await rawPeer(dir, 91, (socket, value, index) => {
      if (index === 0) {
        socket.write(
          Buffer.concat([
            encodeFrame(JSON.stringify(welcome())),
            encodeFrame(JSON.stringify({ type: "response", id: "r1", ok: true, result: "early" })),
            encodeFrame("{}"),
          ]),
        );
      } else {
        writeFrame(socket, { type: "response", id: field(value, "id"), ok: true, result: "late" });
      }
    });
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "late");
    assert.deepEqual(h.logs.slice(0, 2), [
      { message: "ignored a message before any request", detail: "response" },
      { message: "ignored a message before any request", detail: "invalid type" },
    ]);
  });

  it("skips a peer that sends an unreadable frame with the welcome", LIMIT, async () => {
    const dir = privateDir();
    const older = await fakeHost({ dir, pid: 98, respond: ok("older") });
    age(older.path, 100);
    for (const [pid, bad] of [
      [99, encodeFrame("{")],
      [100, header(FRAME_LIMIT + 1025)],
    ] as const) {
      const peer = await rawPeer(dir, pid, (socket) =>
        socket.write(Buffer.concat([encodeFrame(JSON.stringify(welcome())), bad])),
      );
      age(peer.path, 100 - pid);
    }
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "older");
    assert.deepEqual(h.logs.slice(0, 2), [
      skipped(path.join(dir, "100.sock"), "sent an unreadable message"),
      skipped(path.join(dir, "99.sock"), "sent an unreadable message"),
    ]);
  });

  it("keeps a partial frame that arrived with the welcome", LIMIT, async () => {
    const dir = privateDir();
    const answer = encodeFrame(
      JSON.stringify({ type: "response", id: "r1", ok: true, result: "split" }),
    );
    const cut = 20;
    await rawPeer(dir, 92, (socket, _value, index) => {
      if (index === 0) {
        socket.write(
          Buffer.concat([encodeFrame(JSON.stringify(welcome())), answer.subarray(0, cut)]),
        );
      } else {
        socket.write(answer.subarray(cut));
      }
    });
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "split");
  });

  it("waits for a welcome split across chunks", LIMIT, async () => {
    const dir = privateDir();
    const frame = encodeFrame(JSON.stringify(welcome()));
    await rawPeer(dir, 96, (socket, value, index) => {
      if (index === 0) {
        socket.write(frame.subarray(0, 2));
        setTimeout(() => socket.write(frame.subarray(2)), 20);
      } else {
        writeFrame(socket, { type: "response", id: field(value, "id"), ok: true, result: "whole" });
      }
    });
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "whole");
  });

  it("closes a connect that settles after close()", LIMIT, async () => {
    const dir = privateDir();
    const hello = new EventEmitter();
    const peer = await rawPeer(dir, 93, (socket) => hello.emit("hello", socket));
    const h = start(dir);
    const greeted = once(hello, "hello");
    const call = h.bridge.call("tabs_list", {});
    const [socket] = await greeted;
    assert.ok(socket instanceof net.Socket);
    h.bridge.close();
    const closed = once(peer.events, "close");
    writeFrame(socket, welcome());
    await rejectsWith(call, CLOSING);
    await closed;
  });

  it("stops trying sockets once closed", LIMIT, async () => {
    const dir = privateDir();
    const older = await fakeHost({ dir, pid: 94, respond: ok(null) });
    age(older.path, 100);
    const hello = new EventEmitter();
    await rawPeer(dir, 95, (socket) => hello.emit("hello", socket));
    const h = start(dir);
    const greeted = once(hello, "hello");
    const call = h.bridge.call("tabs_list", {});
    const [socket] = await greeted;
    assert.ok(socket instanceof net.Socket);
    h.bridge.close();
    socket.destroy();
    await rejectsWith(call, CLOSING);
    assert.equal(older.connections, 0);
  });
});

describe("Bridge, requests", () => {
  it("sends the hello and the request and resolves the result", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 101, respond: ok({ tab: { id: 5 } }) });
    const h = start(dir);
    assert.deepEqual(await h.bridge.call("tab_open", { url: "https://example.com/" }), {
      tab: { id: 5 },
    });
    assert.deepEqual(host.hellos, [
      { type: "hello", role: "mcp", protocol: PROTOCOL_VERSION, version: VERSION },
    ]);
    assert.deepEqual(host.requests, [
      {
        type: "request",
        id: "r1",
        session: SESSION,
        method: "tab_open",
        params: { url: "https://example.com/" },
      },
    ]);
  });

  it("rejects with the extension's error code and message", LIMIT, async () => {
    const dir = privateDir();
    await fakeHost({
      dir,
      pid: 102,
      respond: (request) => ({
        type: "response",
        id: field(request, "id"),
        ok: false,
        error: { code: "not_in_group", message: "Tab 9 is not in this session's tab group." },
      }),
    });
    const h = start(dir);
    const error = await caught(h.bridge.call("navigate", { tabId: 9, action: "reload" }));
    assert.ok(error instanceof HostError);
    assert.equal(error.name, "HostError");
    assert.equal(error.code, "not_in_group");
    assert.equal(error.message, "Tab 9 is not in this session's tab group.");
  });

  it("ignores a response with an unknown id and times out", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({
      dir,
      pid: 103,
      respond: () => ({ type: "response", id: "nope", ok: true, result: null }),
    });
    const h = start(dir, { requestTimeoutMs: SHORT_REQUEST_MS });
    await rejectsWith(h.bridge.call("tabs_list", {}), TIMEOUT);
    // The timer can fire before the host's answer arrives.
    await until(() => h.logs.length === 2);
    host.send({ type: "response", id: "r1", ok: true, result: null });
    await until(() => h.logs.length === 3);
    assert.deepEqual(h.logs.slice(1), [
      { message: "ignored a response with an unknown id", detail: "nope" },
      { message: "ignored a response with an unknown id", detail: "r1" },
    ]);
  });

  it("ignores a second response to the same id", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 112, respond: ok("once") });
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "once");
    host.send({ type: "response", id: "r1", ok: true, result: "twice" });
    await until(() => h.logs.length === 2);
    assert.deepEqual(h.logs[1], { message: "ignored a response with an unknown id", detail: "r1" });
  });

  it("ignores malformed and wrong-direction messages", LIMIT, async () => {
    const dir = privateDir();
    const host: FakeHost = await fakeHost({
      dir,
      pid: 104,
      respond: (request) => {
        host.send({});
        host.send({ type: "hello", role: "extension", protocol: 1, version: "1.0.0" });
        host.send({ type: "welcome", protocol: 1, version: "1.0.0" });
        host.send({ type: "request", id: "x", session: "s", method: "tabs_list", params: {} });
        return { type: "response", id: field(request, "id"), ok: true, result: "fine" };
      },
    });
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "fine");
    assert.deepEqual(h.logs.slice(1), [
      { message: "ignored a malformed message from the native host", detail: "invalid type" },
      { message: "ignored a message", detail: "hello" },
      { message: "ignored a message", detail: "welcome" },
      { message: "ignored a message", detail: "request" },
    ]);
  });

  it("drops the connection on an unreadable frame", LIMIT, async () => {
    const dir = privateDir();
    await rawPeer(dir, 105, (socket, _value, index) => {
      socket.write(index === 0 ? encodeFrame(JSON.stringify(welcome())) : encodeFrame("{"));
    });
    const h = start(dir);
    await rejectsWith(h.bridge.call("tabs_list", {}), UNREADABLE);
    assert.deepEqual(h.logs.slice(1), [
      { message: "bad frame from the native host", detail: "invalid JSON" },
      { message: "lost the native host", detail: "the host sent an unreadable message" },
    ]);
  });

  it("refuses a frame over its limit", LIMIT, async () => {
    const dir = privateDir();
    await rawPeer(dir, 106, (socket, _value, index) => {
      socket.write(
        index === 0 ? encodeFrame(JSON.stringify(welcome())) : header(FRAME_LIMIT + 1025),
      );
    });
    const h = start(dir);
    await rejectsWith(h.bridge.call("tabs_list", {}), UNREADABLE);
    assert.deepEqual(h.logs[1], {
      message: "bad frame from the native host",
      detail: `frame of ${FRAME_LIMIT + 1025} bytes exceeds the limit of ${FRAME_LIMIT + 1024}`,
    });
  });

  it("accepts a frame at its limit", LIMIT, async () => {
    const dir = privateDir();
    await rawPeer(dir, 107, (socket, _value, index) => {
      if (index === 0) {
        socket.write(encodeFrame(JSON.stringify(welcome())));
      } else {
        // The header arrives before the end: a refused one fails the call as unreadable.
        socket.end(header(FRAME_LIMIT + 1024));
      }
    });
    const h = start(dir);
    await rejectsWith(h.bridge.call("tabs_list", {}), HOST_CLOSED);
  });

  it("refuses a call on a connection destroyed before its close event", LIMIT, async () => {
    const dir = privateDir();
    await rawPeer(dir, 108, (socket, _value, index) => {
      socket.write(index === 0 ? encodeFrame(JSON.stringify(welcome())) : encodeFrame("{"));
    });
    const second = Promise.withResolvers<unknown>();
    const h = start(dir, {
      onLog: (line) => {
        if (line.message === "bad frame from the native host") {
          second.resolve(caught(h.bridge.call("tabs_list", {})));
        }
      },
    });
    const first = caught(h.bridge.call("tabs_list", {}));
    assertBridgeError(await second.promise, UNREADABLE);
    // Refused at once, not failed later by the close event.
    assert.equal(
      h.logs.some((line) => line.message === "lost the native host"),
      false,
    );
    assertBridgeError(await first, UNREADABLE);
  });

  it("reports a socket error as the reason the connection was lost", LIMIT, async () => {
    const dir = privateDir();
    // Never reads: the unread hello makes the kernel reset the connection on destroy.
    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
      peerSockets.push(socket);
      writeFrame(socket, welcome());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path.join(dir, "111.sock"), resolve));
    const accepted = once(server, "connection");
    const h = start(dir);
    const call = h.bridge.call("tabs_list", {});
    const [socket] = await accepted;
    assert.ok(socket instanceof net.Socket);
    await until(() => h.logs.length === 1);
    socket.destroy();
    await rejectsWith(
      call,
      "The connection to the Foxleash native host was lost: the socket failed with ECONNRESET.",
    );
  });

  it("refuses a request over 1 MB without writing it", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 110, respond: ok("sent") });
    const h = start(dir);
    const overhead = Buffer.byteLength(
      JSON.stringify({
        type: "request",
        id: "r1",
        session: SESSION,
        method: "tab_open",
        params: { url: "" },
      }),
    );
    const url = "a".repeat(NATIVE_MESSAGE_LIMIT - overhead);
    assert.equal(await h.bridge.call("tab_open", { url }), "sent");
    await rejectsWith(
      h.bridge.call("tab_open", { url: `${url}a` }),
      `The request is ${NATIVE_MESSAGE_LIMIT + 1} bytes; Firefox accepts at most 1 MB per message.`,
    );
    assert.equal(host.requests.length, 1);
  });
});

describe("Bridge, losing and closing the connection", () => {
  it("rejects a pending call when the host drops it, and reconnects", LIMIT, async () => {
    const dir = privateDir();
    let answering = false;
    const host = await fakeHost({
      dir,
      pid: 121,
      respond: (request) => (answering ? ok("again")(request) : undefined),
    });
    const h = start(dir);
    const requested = once(host.events, "request");
    const call = h.bridge.call("tabs_list", {});
    await requested;
    host.dropAll();
    await rejectsWith(call, HOST_CLOSED);
    assert.deepEqual(h.logs[1], {
      message: "lost the native host",
      detail: "the host closed the connection",
    });
    answering = true;
    assert.equal(await h.bridge.call("tabs_list", {}), "again");
    host.send({ type: "response", id: "r1", ok: true, result: null });
    await until(() => h.logs.length === 4);
    assert.deepEqual(h.logs[3], { message: "ignored a response with an unknown id", detail: "r1" });
    assert.equal(host.connections, 2);
    assert.equal(host.hellos.length, 2);
    assert.deepEqual(
      host.requests.map((request) => [field(request, "id"), field(request, "session")]),
      [
        ["r1", SESSION],
        ["r2", SESSION],
      ],
    );
  });

  it("rejects a pending call on close() and closes the socket quietly", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 122, respond: silence });
    const h = start(dir);
    const requested = once(host.events, "request");
    const call = h.bridge.call("tabs_list", {});
    await requested;
    const closed = once(host.events, "close");
    h.bridge.close();
    // A write to the closed peer fails on the fake host's side without breaking it.
    host.send({ type: "response", id: "r1", ok: true, result: null });
    await rejectsWith(call, CLOSING);
    await closed;
    h.bridge.close();
    // Nothing to wait for: the bridge's own close event comes later and must log nothing.
    await delay(50);
    assert.deepEqual(
      h.logs.map((line) => line.message),
      ["connected to the native host"],
    );
  });

  it("sends nothing for a call made just before close()", LIMIT, async () => {
    const dir = privateDir();
    const host = await fakeHost({ dir, pid: 123, respond: ok("first") });
    const h = start(dir);
    assert.equal(await h.bridge.call("tabs_list", {}), "first");
    const call = h.bridge.call("tabs_list", {});
    h.bridge.close();
    await rejectsWith(call, CLOSING);
    assert.equal(host.requests.length, 1);
  });

  it("rejects a call after close() without reading the directory", LIMIT, async () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    const h = start(dir);
    h.bridge.close();
    await rejectsWith(h.bridge.call("tabs_list", {}), CLOSING);
  });
});

function start(socketDir: string, options: StartOptions = {}): Harness {
  const logs: LogLine[] = [];
  const bridge = new Bridge({
    socketDir,
    uid,
    version: VERSION,
    session: SESSION,
    log: (message, detail) => {
      const line = { message, detail };
      logs.push(line);
      options.onLog?.(line);
    },
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_MS,
  });
  bridges.push(bridge);
  return { bridge, logs };
}

function privateDir(): string {
  counter += 1;
  const dir = path.join(root, `d${counter}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

async function fakeHost(options: FakeHostOptions): Promise<FakeHost> {
  const host = await startFakeHost(options);
  hosts.push(host);
  return host;
}

function ok(result: unknown): (request: unknown) => unknown {
  return (request) => ({ type: "response", id: field(request, "id"), ok: true, result });
}

function silence(): undefined {
  return undefined;
}

function field(value: unknown, key: string): unknown {
  assert.ok(typeof value === "object" && value !== null);
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

// As the real host sends it, with the extension's status.
function welcome(): Record<string, unknown> {
  return {
    type: "welcome",
    protocol: PROTOCOL_VERSION,
    version: SERVER_VERSION,
    extension: { connected: false },
  };
}

function welcomeOfHost(): Record<string, unknown> {
  return { type: "welcome", protocol: PROTOCOL_VERSION, version: SERVER_VERSION };
}

function writeFrame(socket: net.Socket, value: unknown): void {
  socket.write(encodeFrame(JSON.stringify(value)));
}

function header(length: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(length, 0);
  return bytes;
}

function skipped(socketPath: string, ending: string): LogLine {
  return {
    message: "skipped a socket",
    detail: { path: socketPath, error: `The Foxleash native host at ${socketPath} ${ending}.` },
  };
}

function age(socketPath: string, seconds: number): void {
  const time = Date.now() / 1000 - seconds;
  utimesSync(socketPath, time, time);
}

async function staleSocket(dir: string, pid: number): Promise<string> {
  const server = net.createServer();
  const temporary = path.join(dir, "binding");
  await new Promise<void>((resolve) => server.listen(temporary, resolve));
  const target = path.join(dir, `${pid}.sock`);
  renameSync(temporary, target);
  await new Promise((resolve) => server.close(resolve));
  return target;
}

async function rawPeer(
  dir: string,
  pid: number,
  onFrame: OnFrame,
  onConnection: (socket: net.Socket) => void = () => {},
): Promise<Peer> {
  const events = new EventEmitter();
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    const reader = createFrameReader(FRAME_LIMIT);
    let index = 0;
    sockets.push(socket);
    peerSockets.push(socket);
    socket.on("error", () => {});
    socket.on("close", () => events.emit("close"));
    socket.on("data", (chunk: Buffer) => {
      for (const event of reader.push(chunk)) {
        assert.ok(event.ok);
        onFrame(socket, event.value, index);
        index += 1;
      }
    });
    onConnection(socket);
  });
  servers.push(server);
  const peerPath = path.join(dir, `${pid}.sock`);
  await new Promise<void>((resolve) => server.listen(peerPath, resolve));
  return { path: peerPath, events, sockets };
}

async function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  assertBridgeError(await caught(promise), message);
}

function assertBridgeError(error: unknown, message: string): void {
  assert.ok(error instanceof BridgeError, `not a BridgeError: ${String(error)}`);
  assert.equal(error.name, "BridgeError");
  assert.equal(error.message, message);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  assert.fail("the call did not reject");
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 1000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentUid(): number {
  const getuid = process.getuid;
  assert.ok(getuid !== undefined, "process.getuid is unavailable");
  return getuid();
}
