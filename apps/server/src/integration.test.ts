import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { PROTOCOL_VERSION } from "@foxhand/protocol";
import { Bridge } from "./bridge.ts";
import { createFrameReader, encodeFrame, FRAME_LIMIT } from "./framing.ts";
import { type Host, runHost } from "./host.ts";

interface FakeExtension {
  stdin: PassThrough;
  stdout: PassThrough;
  welcomed: Promise<void>;
  requests: Record<string, unknown>[];
}

const uid = currentUid();
const root = mkdtempSync("/tmp/foxhand-test-");
const VERSION = "1.2.3";
const SESSION = "session-1";
const LIMIT = { timeout: 5000 };
const bridges: Bridge[] = [];
const hosts: Host[] = [];

after(async () => {
  // A broken relay or a leftover socket must fail the file, not hang it.
  setTimeout(() => process.exit(1), 5000).unref();
  for (const bridge of bridges) {
    bridge.close();
  }
  for (const host of hosts) {
    host.close("test over");
  }
  await Promise.all(hosts.map((host) => host.done));
  rmSync(root, { recursive: true, force: true });
});

describe("the bridge and the real host", () => {
  it("relays a call, and reconnects after the host restarts", LIMIT, async () => {
    const socketDir = path.join(root, "sockets");
    mkdirSync(socketDir, { mode: 0o700 });
    const lost = Promise.withResolvers<void>();
    const bridge = new Bridge({
      socketDir,
      uid,
      version: VERSION,
      session: SESSION,
      log: (message) => {
        if (message === "lost the native host") {
          lost.resolve();
        }
      },
      requestTimeoutMs: 2000,
    });
    bridges.push(bridge);

    const first = fakeExtension("first");
    const host1 = startHost(socketDir, process.pid, first);
    await first.welcomed;
    assert.equal(await bridge.call("tabs_list", {}), "first");
    assert.equal(first.requests.length, 1);
    const [request] = first.requests;
    assert.equal(request?.type, "request");
    assert.equal(request?.session, SESSION);
    assert.equal(request?.method, "tabs_list");
    assert.deepEqual(request?.params, {});
    assert.equal(typeof request?.id, "string");
    assert.notEqual(request?.id, "r1");

    first.stdin.end();
    assert.equal(await host1.done, 0);
    // So the next call cannot race the old connection's close.
    await lost.promise;

    const second = fakeExtension("second");
    const host2 = startHost(socketDir, process.ppid, second);
    await second.welcomed;
    assert.equal(await bridge.call("tabs_list", {}), "second");
    assert.equal(second.requests.length, 1);
    assert.equal(first.requests.length, 1);
    assert.ok(host2.socketPath.endsWith(`${process.ppid}.sock`));
  });
});

function startHost(socketDir: string, pid: number, extension: FakeExtension): Host {
  const host = runHost({
    stdin: extension.stdin,
    stdout: extension.stdout,
    socketDir,
    pid,
    uid,
    version: VERSION,
    log: () => {},
    requestTimeoutMs: 2000,
  });
  hosts.push(host);
  return host;
}

// Plays the extension on the host's stdio: says hello, then answers every relayed request.
function fakeExtension(result: unknown): FakeExtension {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const reader = createFrameReader(FRAME_LIMIT);
  const { promise: welcomed, resolve } = Promise.withResolvers<void>();
  stdout.on("data", (chunk: Buffer) => {
    for (const event of reader.push(chunk)) {
      assert.ok(event.ok, "the host sent a bad frame");
      const message = event.value;
      assert.ok(typeof message === "object" && message !== null && !Array.isArray(message));
      const fields = Object.fromEntries(Object.entries(message));
      if (fields.type === "welcome") {
        resolve();
      } else {
        requests.push(fields);
        write(stdin, { type: "response", id: fields.id, ok: true, result });
      }
    }
  });
  write(stdin, { type: "hello", role: "extension", protocol: PROTOCOL_VERSION, version: VERSION });
  return { stdin, stdout, welcomed, requests };
}

function write(stream: PassThrough, value: unknown): void {
  stream.write(encodeFrame(JSON.stringify(value)));
}

function currentUid(): number {
  const getuid = process.getuid;
  assert.ok(getuid !== undefined, "process.getuid is unavailable");
  return getuid();
}
