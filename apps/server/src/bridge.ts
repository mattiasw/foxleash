import net from "node:net";
import {
  type MethodName,
  type Params,
  PROTOCOL_VERSION,
  parseMessage,
  protocolMismatch,
  type WelcomeMessage,
} from "@foxhand/protocol";
import {
  createFrameReader,
  encodeFrame,
  FRAME_LIMIT,
  type FrameEvent,
  type FrameReader,
  NATIVE_MESSAGE_LIMIT,
} from "./framing.ts";
import type { Log } from "./log.ts";
import { listSockets, SocketDirError, type SocketEntry } from "./socket-dir.ts";

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export class HostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

export interface HostConnection {
  socket: net.Socket;
  welcome: WelcomeMessage;
  reader: FrameReader;
}

export interface ConnectOptions {
  version: string;
  handshakeTimeoutMs?: number | undefined;
  log: Log;
}

export interface BridgeOptions {
  socketDir: string;
  uid: number;
  version: string;
  session: string;
  log: Log;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Connection {
  socket: net.Socket;
  reader: FrameReader;
  mismatch: string | null;
  lostReason: string | null;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const NO_HOST =
  "No Foxhand native host is running: start Firefox with the Foxhand extension installed, and run `npm run doctor` in your Foxhand folder if it still fails.";
const TIMEOUT = "The Foxhand native host did not answer in time.";
const CLOSING = "the MCP server is closing";
const HOST_CLOSED = "the host closed the connection";
const UNREADABLE = "the host sent an unreadable message";
// The host's frames are bounded by Firefox's own 64 MiB cap; the allowance covers the id swap.
const READER_LIMIT = FRAME_LIMIT + 1024;

export class Bridge {
  readonly #socketDir: string;
  readonly #uid: number;
  readonly #version: string;
  readonly #session: string;
  readonly #log: Log;
  readonly #connectOptions: ConnectOptions;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  #connection: Connection | null = null;
  #connecting: Promise<Connection> | null = null;
  #counter = 0;

  constructor(options: BridgeOptions) {
    this.#socketDir = options.socketDir;
    this.#uid = options.uid;
    this.#version = options.version;
    this.#session = options.session;
    this.#log = options.log;
    this.#connectOptions = {
      version: options.version,
      log: options.log,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    };
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 70_000;
  }

  async call<M extends MethodName>(method: M, params: Params<M>): Promise<unknown> {
    if (this.#closed) {
      throw lost(CLOSING);
    }
    const connection = await this.#connected();
    if (this.#closed) {
      throw lost(CLOSING);
    }
    // Destroyed a tick before its close event: never write to it.
    if (connection.socket.destroyed) {
      throw lost(reasonOf(connection));
    }
    if (connection.mismatch !== null) {
      throw new BridgeError(connection.mismatch);
    }
    this.#counter += 1;
    const id = `r${this.#counter}`;
    const json = JSON.stringify({ type: "request", id, session: this.#session, method, params });
    const bytes = Buffer.byteLength(json);
    if (bytes > NATIVE_MESSAGE_LIMIT) {
      throw new BridgeError(
        `The request is ${bytes} bytes; Firefox accepts at most 1 MB per message.`,
      );
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new BridgeError(TIMEOUT));
    }, this.#requestTimeoutMs).unref();
    this.#pending.set(id, { resolve, reject, timer });
    connection.socket.write(encodeFrame(json));
    return promise;
  }

  close(): void {
    this.#closed = true;
    this.#rejectAll(CLOSING);
    const connection = this.#connection;
    this.#connection = null;
    connection?.socket.destroy();
  }

  #connected(): Promise<Connection> {
    if (this.#connection !== null) {
      return Promise.resolve(this.#connection);
    }
    if (this.#connecting === null) {
      this.#connecting = this.#connect().finally(() => {
        this.#connecting = null;
      });
    }
    return this.#connecting;
  }

  async #connect(): Promise<Connection> {
    for (const entry of this.#list()) {
      const host = await this.#tryConnect(entry);
      // A connect that settles after close() never becomes the connection.
      if (this.#closed) {
        host?.socket.destroy();
        throw lost(CLOSING);
      }
      if (host !== null) {
        return this.#adopt(entry, host);
      }
    }
    throw new BridgeError(NO_HOST);
  }

  #list(): SocketEntry[] {
    try {
      return listSockets(this.#socketDir, this.#uid);
    } catch (error: unknown) {
      if (error instanceof SocketDirError) {
        throw new BridgeError(error.message);
      }
      throw error;
    }
  }

  async #tryConnect(entry: SocketEntry): Promise<HostConnection | null> {
    try {
      return await connectToHost(entry.path, this.#connectOptions);
    } catch (error: unknown) {
      this.#log("skipped a socket", { path: entry.path, error: errorMessage(error) });
      return null;
    }
  }

  #adopt(entry: SocketEntry, host: HostConnection): Connection {
    const { socket, welcome, reader } = host;
    const connection: Connection = {
      socket,
      reader,
      mismatch: protocolMismatch(
        { part: "mcp", protocol: PROTOCOL_VERSION, version: this.#version },
        { part: "host", protocol: welcome.protocol, version: welcome.version },
      ),
      lostReason: null,
    };
    socket.on("data", (chunk: Buffer) => this.#onData(connection, chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      connection.lostReason ??= `the socket failed with ${codeOf(error)}`;
    });
    socket.on("close", () => this.#onClose(connection));
    this.#connection = connection;
    this.#log("connected to the native host", {
      path: entry.path,
      version: welcome.version,
      protocol: welcome.protocol,
    });
    return connection;
  }

  #onData(connection: Connection, chunk: Buffer): void {
    for (const event of connection.reader.push(chunk)) {
      if (!event.ok) {
        this.#log("bad frame from the native host", event.error);
        connection.lostReason = UNREADABLE;
        connection.socket.destroy();
        return;
      }
      this.#onMessage(event.value);
    }
  }

  #onMessage(value: unknown): void {
    const parsed = parseMessage(value);
    if (!parsed.ok) {
      this.#log("ignored a malformed message from the native host", parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.type !== "response") {
      this.#log("ignored a message", message.type);
      return;
    }
    const entry = this.#pending.get(message.id);
    if (entry === undefined) {
      this.#log("ignored a response with an unknown id", message.id);
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new HostError(message.error.code, message.error.message));
    }
  }

  #onClose(connection: Connection): void {
    // close() has already let go of it and rejected what was pending.
    if (connection !== this.#connection) {
      return;
    }
    this.#connection = null;
    const reason = reasonOf(connection);
    this.#rejectAll(reason);
    this.#log("lost the native host", reason);
  }

  #rejectAll(reason: string): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(lost(reason));
    }
    this.#pending.clear();
  }
}

// The socket comes back flowing and with no error listener: attach yours before any await.
export function connectToHost(
  socketPath: string,
  options: ConnectOptions,
): Promise<HostConnection> {
  const { version, log } = options;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 2_000;
  const { promise, resolve, reject } = Promise.withResolvers<HostConnection>();
  const reader = createFrameReader(READER_LIMIT);
  const socket = net.connect(socketPath);
  let connected = false;
  const timer = setTimeout(() => {
    fail(
      `The Foxhand native host at ${socketPath} did not answer within ${handshakeTimeoutMs} ms.`,
    );
  }, handshakeTimeoutMs).unref();
  socket.once("connect", onConnect);
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  // Queued until the connection is up.
  socket.write(
    encodeFrame(
      JSON.stringify({ type: "hello", role: "mcp", protocol: PROTOCOL_VERSION, version }),
    ),
  );
  return promise;

  function onConnect(): void {
    connected = true;
  }

  function onData(chunk: Buffer): void {
    const [first, ...rest] = reader.push(chunk);
    if (first === undefined) {
      return;
    }
    const welcome = welcomeOf(first);
    if (welcome === null) {
      fail(`The Foxhand native host at ${socketPath} did not answer with a welcome.`);
      return;
    }
    // Nothing was requested yet, so nothing may follow the welcome.
    for (const event of rest) {
      // As after the handshake, a frame that cannot be read ends the connection.
      if (!event.ok) {
        fail(`The Foxhand native host at ${socketPath} sent an unreadable message.`);
        return;
      }
      log("ignored a message before any request", summary(event.value));
    }
    clearTimeout(timer);
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("close", onClose);
    resolve({ socket, welcome, reader });
  }

  function onError(error: NodeJS.ErrnoException): void {
    // After connect, an error is the peer going away (EPIPE, ECONNRESET on the queued hello).
    fail(
      connected
        ? closedEarly(socketPath)
        : `Cannot connect to the Foxhand native host at ${socketPath}: ${codeOf(error)}.`,
    );
  }

  function onClose(): void {
    fail(closedEarly(socketPath));
  }

  // Settling twice is harmless: a promise settles once, and destroy() is idempotent.
  function fail(message: string): void {
    clearTimeout(timer);
    socket.destroy();
    reject(new BridgeError(message));
  }
}

function welcomeOf(event: FrameEvent): WelcomeMessage | null {
  if (!event.ok) {
    return null;
  }
  const parsed = parseMessage(event.value);
  return parsed.ok && parsed.message.type === "welcome" ? parsed.message : null;
}

function summary(value: unknown): string {
  const parsed = parseMessage(value);
  return parsed.ok ? parsed.message.type : parsed.error;
}

function closedEarly(socketPath: string): string {
  return `The Foxhand native host at ${socketPath} closed the connection before answering.`;
}

function lost(reason: string): BridgeError {
  return new BridgeError(`The connection to the Foxhand native host was lost: ${reason}.`);
}

function reasonOf(connection: Connection): string {
  return connection.lostReason ?? HOST_CLOSED;
}

function codeOf(error: NodeJS.ErrnoException): string {
  return error.code ?? "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
