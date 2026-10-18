import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { PROTOCOL_VERSION } from "@foxhand/protocol";
import { createFrameReader, encodeFrame, FRAME_LIMIT } from "../framing.ts";
import { SERVER_VERSION } from "../version.ts";

export interface FakeHostOptions {
  /** An existing private directory, e.g. from mkdtempSync("/tmp/foxhand-test-"). */
  dir: string;
  pid: number;
  /** The frame answering a hello; null never answers. */
  welcome?: unknown;
  /** The frame answering a request; undefined stays silent. */
  respond: (request: unknown) => unknown;
}

export interface FakeHost {
  readonly path: string;
  /** Emits "request" and "close". */
  readonly events: EventEmitter;
  readonly hellos: unknown[];
  readonly requests: unknown[];
  connections: number;
  closes: number;
  send(value: unknown): void;
  dropAll(): void;
  close(): Promise<void>;
}

export async function startFakeHost(options: FakeHostOptions): Promise<FakeHost> {
  const welcome =
    options.welcome === undefined
      ? { type: "welcome", protocol: PROTOCOL_VERSION, version: SERVER_VERSION }
      : options.welcome;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(onConnection);
  const host: FakeHost = {
    path: path.join(options.dir, `${options.pid}.sock`),
    events: new EventEmitter(),
    hellos: [],
    requests: [],
    connections: 0,
    closes: 0,
    send(value) {
      for (const socket of sockets) {
        write(socket, value);
      }
    },
    dropAll() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    async close() {
      host.dropAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  await new Promise<void>((resolve) => server.listen(host.path, resolve));
  return host;

  function onConnection(socket: net.Socket): void {
    const reader = createFrameReader(FRAME_LIMIT);
    let greeted = false;
    sockets.add(socket);
    host.connections += 1;
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      host.closes += 1;
      host.events.emit("close");
    });
    socket.on("data", (chunk: Buffer) => {
      for (const event of reader.push(chunk)) {
        assert.ok(event.ok, "the bridge sent a bad frame");
        if (greeted) {
          onRequest(socket, event.value);
        } else {
          greeted = true;
          onHello(socket, event.value);
        }
      }
    });
  }

  function onHello(socket: net.Socket, value: unknown): void {
    host.hellos.push(value);
    if (welcome !== null) {
      write(socket, welcome);
    }
  }

  function onRequest(socket: net.Socket, value: unknown): void {
    host.requests.push(value);
    host.events.emit("request", value);
    const reply = options.respond(value);
    if (reply !== undefined) {
      write(socket, reply);
    }
  }
}

function write(socket: net.Socket, value: unknown): void {
  socket.write(encodeFrame(JSON.stringify(value)));
}
