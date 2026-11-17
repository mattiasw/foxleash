import { unlinkSync } from "node:fs";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  type ExtensionStatus,
  type HelloMessage,
  PROTOCOL_VERSION,
  parseMessage,
  protocolMismatch,
  type RequestMessage,
  type ResponseMessage,
  type SessionEndMessage,
  type WelcomeMessage,
} from "@foxleash/protocol";
import {
  createFrameReader,
  encodeFrame,
  FRAME_LIMIT,
  type FrameReader,
  NATIVE_MESSAGE_LIMIT,
} from "./framing.ts";
import { createLog, type Log } from "./log.ts";
import {
  ensureSocketDir,
  isAlive,
  listSockets,
  resolveSocketDir,
  socketPath as socketPathIn,
} from "./socket-dir.ts";
import { SERVER_VERSION } from "./version.ts";

export type HostSignal = "SIGTERM" | "SIGINT" | "SIGHUP";

export interface HostProcess {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  pid: number;
  env: NodeJS.ProcessEnv;
  getuid?: () => number;
  on(event: HostSignal | "exit", listener: () => void): unknown;
  off(event: HostSignal | "exit", listener: () => void): unknown;
  exit(code: number): void;
}

export interface HostOptions {
  stdin: Readable;
  stdout: Writable;
  socketDir: string;
  pid: number;
  uid: number;
  version: string;
  log: Log;
  requestTimeoutMs?: number;
}

export interface Host {
  socketPath: string;
  close(reason: string): void;
  done: Promise<number>;
}

type ExtensionState =
  | { greeted: false }
  | {
      greeted: true;
      protocol: number;
      version: string;
      allUrls?: boolean;
      oldestProtocol?: number;
    };

interface Conn {
  socket: net.Socket;
  label: string;
  greeted: boolean;
  session: string | null;
  mismatch: string | null;
  reader: FrameReader;
  // Original id -> host id.
  inFlight: Map<string, string>;
  badFrames: number;
}

interface Pending {
  conn: Conn;
  id: string;
  timer: NodeJS.Timeout;
}

// A request over 1 MB can never be forwarded; the allowance covers the id swap, so anything the
// host could still refuse with message_too_large is parsed and answered.
const SOCKET_FRAME_LIMIT = NATIVE_MESSAGE_LIMIT + 64 * 1024;
const SIGNALS: readonly HostSignal[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const FORCE_CLOSE_MS = 1000;
const STDIN_CLOSED = "Firefox closed the native messaging port";

export async function hostCommand(proc: HostProcess): Promise<number> {
  let stderrBroken = false;
  // A closed stderr (Firefox gone) must not turn the next log line into an uncaught EPIPE.
  proc.stderr.on("error", () => {
    stderrBroken = true;
  });
  const write = createLog("foxleash host:", proc.stderr);
  const log: Log = (message, detail) => {
    if (!stderrBroken) {
      write(message, detail);
    }
  };
  if (proc.getuid === undefined) {
    log("The Foxleash native host runs on Linux only.");
    proc.exit(1);
    return 1;
  }
  const uid = proc.getuid();
  const { dir, skipped } = resolveSocketDir(proc.env, uid);
  for (const reason of skipped) {
    log("skipped socket directory", reason);
  }
  const host = runHost({
    stdin: proc.stdin,
    stdout: proc.stdout,
    socketDir: dir,
    pid: proc.pid,
    uid,
    version: SERVER_VERSION,
    log,
  });
  const onSignal = (): void => host.close("signal");
  const onExit = (): void => {
    try {
      unlinkSync(host.socketPath);
    } catch {
      // Best effort: the socket may already be gone.
    }
  };
  for (const signal of SIGNALS) {
    proc.on(signal, onSignal);
  }
  proc.on("exit", onExit);
  const code = await host.done;
  for (const signal of SIGNALS) {
    proc.off(signal, onSignal);
  }
  proc.off("exit", onExit);
  proc.exit(code);
  return code;
}

export function runHost(options: HostOptions): Host {
  const { stdin, stdout, socketDir, pid, uid, version, log } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const path = socketPathIn(socketDir, pid);
  const { promise: done, resolve: settle } = Promise.withResolvers<number>();
  const server = net.createServer();
  const stdinReader = createFrameReader(FRAME_LIMIT);
  const pending = new Map<string, Pending>();
  const sessions = new Map<string, Conn>();
  const connections = new Set<Conn>();
  let extension: ExtensionState = { greeted: false };
  let extensionMismatch: string | null = null;
  let requestCounter = 0;
  let connCounter = 0;
  // True once this host created the socket file; only then may it remove that path.
  let bound = false;
  let closed = false;

  start();
  return { socketPath: path, close, done };

  function start(): void {
    try {
      ensureSocketDir(socketDir, uid);
      sweep();
    } catch (error: unknown) {
      log("cannot start", errorMessage(error));
      settle(1);
      return;
    }
    server.on("connection", onConnection);
    server.on("error", onServerError);
    server.on("listening", onListening);
    const previous = process.umask(0o177);
    try {
      // A Unix socket binds synchronously in here; a bind error arrives as an error event.
      server.listen(path);
    } finally {
      process.umask(previous);
    }
    bound = server.listening;
  }

  function sweep(): void {
    for (const entry of listSockets(socketDir, uid)) {
      if (!isAlive(entry.pid)) {
        removeFile(entry.path, "cannot remove stale socket");
      }
    }
    removeFile(path, "cannot remove stale socket");
  }

  function removeFile(target: string, message: string): void {
    try {
      unlinkSync(target);
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code !== "ENOENT") {
        log(message, { path: target, code });
      }
    }
  }

  function onServerError(error: unknown): void {
    if (!bound) {
      log(`cannot listen on ${path}: ${errorCode(error)}`);
      settle(1);
      return;
    }
    log("socket server error", errorCode(error));
  }

  function onListening(): void {
    log(`listening on ${path}`);
    stdin.on("data", onStdinData);
    stdin.on("end", onStdinEnd);
    stdin.on("error", onStdinError);
    stdout.on("error", onStdoutError);
  }

  function onStdinData(chunk: Buffer): void {
    let first: string | undefined;
    let count = 0;
    for (const event of stdinReader.push(chunk)) {
      if (event.ok) {
        handleNative(event.value);
      } else {
        first ??= event.error;
        count += 1;
      }
    }
    if (first !== undefined) {
      log("bad frame from Firefox", { error: first, more: count - 1 });
    }
  }

  function handleNative(value: unknown): void {
    const parsed = parseMessage(value);
    if (!parsed.ok) {
      log("ignored a malformed message from Firefox", parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.type === "hello") {
      onExtensionHello(message);
    } else if (message.type === "response") {
      onResponse(message);
    } else {
      log("ignored a message from Firefox in the wrong direction", message.type);
    }
  }

  function onExtensionHello(hello: HelloMessage): void {
    if (hello.role !== "extension") {
      log("ignored a hello from Firefox with another role", hello.role);
      return;
    }
    if (extension.greeted) {
      if (hello.allUrls === undefined) {
        log("ignored a repeated hello from the extension");
        return;
      }
      extension.allUrls = hello.allUrls;
      log("permission status updated", { allUrls: hello.allUrls });
      return;
    }
    const oldest =
      hello.oldestProtocol === undefined ? {} : { oldestProtocol: hello.oldestProtocol };
    extension = {
      greeted: true,
      protocol: hello.protocol,
      version: hello.version,
      ...(hello.allUrls === undefined ? {} : { allUrls: hello.allUrls }),
      ...oldest,
    };
    const welcome: WelcomeMessage = { type: "welcome", protocol: PROTOCOL_VERSION, version };
    stdout.write(encodeFrame(JSON.stringify(welcome)));
    extensionMismatch = protocolMismatch(
      { part: "host", protocol: PROTOCOL_VERSION, version },
      {
        part: "extension",
        protocol: hello.protocol,
        version: hello.version,
        ...(hello.oldestProtocol === undefined ? {} : { oldest: hello.oldestProtocol }),
      },
    );
    log("extension connected", { version: hello.version, protocol: hello.protocol, ...oldest });
    if (extensionMismatch !== null) {
      log("protocol mismatch with the extension", extensionMismatch);
    }
  }

  function onResponse(response: ResponseMessage): void {
    const entry = pending.get(response.id);
    if (entry === undefined) {
      log("ignored a response with an unknown id", response.id);
      return;
    }
    const reply: ResponseMessage = response.ok
      ? { type: "response", id: entry.id, ok: true, result: response.result }
      : { type: "response", id: entry.id, ok: false, error: response.error };
    let json: string;
    try {
      json = JSON.stringify(reply);
    } catch (error: unknown) {
      // The entry stays, so the call ends with the timeout error.
      log("cannot serialize the extension's response", errorMessage(error));
      return;
    }
    endPending(response.id, entry);
    sendJson(entry.conn, json);
  }

  function endPending(hostId: string, entry: Pending): void {
    clearTimeout(entry.timer);
    pending.delete(hostId);
    entry.conn.inFlight.delete(entry.id);
  }

  function onStdinEnd(): void {
    close(STDIN_CLOSED);
  }

  function onStdinError(error: unknown): void {
    log("cannot read from Firefox", errorCode(error));
    close(STDIN_CLOSED);
  }

  function onStdoutError(error: unknown): void {
    log("cannot write to Firefox", errorCode(error));
    close(STDIN_CLOSED);
  }

  function onConnection(socket: net.Socket): void {
    connCounter += 1;
    const conn: Conn = {
      socket,
      label: `c${connCounter}`,
      greeted: false,
      session: null,
      mismatch: null,
      reader: createFrameReader(SOCKET_FRAME_LIMIT),
      inFlight: new Map(),
      badFrames: 0,
    };
    connections.add(conn);
    log(`${conn.label} connected`);
    socket.on("data", (chunk: Buffer) => onSocketData(conn, chunk));
    socket.on("error", (error: unknown) => log(`${conn.label} socket error`, errorCode(error)));
    socket.on("close", () => onSocketClose(conn));
  }

  function onSocketData(conn: Conn, chunk: Buffer): void {
    if (closed) {
      return;
    }
    for (const event of conn.reader.push(chunk)) {
      if (event.ok) {
        handleSocketMessage(conn, event.value);
        if (conn.socket.destroyed) {
          return;
        }
      } else {
        badSocketFrame(conn, event.error);
      }
    }
  }

  function handleSocketMessage(conn: Conn, value: unknown): void {
    const parsed = parseMessage(value);
    if (!conn.greeted) {
      if (parsed.ok && parsed.message.type === "hello") {
        greetPeer(conn, parsed.message);
      } else {
        drop(conn, "did not start with a hello");
      }
      return;
    }
    if (!parsed.ok) {
      if (parsed.id === undefined) {
        drop(conn, "sent a malformed message", parsed.error);
      } else {
        sendError(conn, parsed.id, "invalid_request", parsed.error);
      }
      return;
    }
    const message = parsed.message;
    if (message.type === "request") {
      relayRequest(conn, message);
    } else {
      drop(conn, "sent a message in the wrong direction", message.type);
    }
  }

  function greetPeer(conn: Conn, hello: HelloMessage): void {
    if (hello.role !== "mcp") {
      drop(conn, "claimed a role other than mcp", hello.role);
      return;
    }
    conn.greeted = true;
    conn.mismatch = protocolMismatch(
      { part: "mcp", protocol: hello.protocol, version: hello.version },
      { part: "host", protocol: PROTOCOL_VERSION, version },
    );
    log(`${conn.label} greeted`, { version: hello.version, protocol: hello.protocol });
    send(conn, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version,
      extension: extensionStatus(),
    });
  }

  function drop(conn: Conn, reason: string, detail?: unknown): void {
    log(`dropped ${conn.label}: ${reason}`, detail);
    conn.socket.destroy();
  }

  function extensionStatus(): ExtensionStatus {
    if (!extension.greeted) {
      return { connected: false };
    }
    const { protocol, allUrls, oldestProtocol } = extension;
    return {
      connected: true,
      protocol,
      version: extension.version,
      ...(allUrls === undefined ? {} : { allUrls }),
      ...(oldestProtocol === undefined ? {} : { oldestProtocol }),
    };
  }

  function relayRequest(conn: Conn, request: RequestMessage): void {
    const { id, session } = request;
    if (conn.session !== null && conn.session !== session) {
      sendError(conn, id, "session_mismatch", "This connection is bound to another session.");
      return;
    }
    if (conn.session === null) {
      if (sessions.has(session)) {
        sendError(conn, id, "session_in_use", "This session belongs to another connection.");
        return;
      }
      conn.session = session;
      sessions.set(session, conn);
    }
    if (conn.mismatch !== null) {
      sendError(conn, id, "protocol_mismatch", conn.mismatch);
      return;
    }
    if (!extension.greeted) {
      sendError(
        conn,
        id,
        "extension_disconnected",
        "The Foxleash extension has not connected to the native host yet.",
      );
      return;
    }
    if (extensionMismatch !== null) {
      sendError(conn, id, "protocol_mismatch", extensionMismatch);
      return;
    }
    if (conn.inFlight.has(id)) {
      sendError(conn, id, "duplicate_id", "A request with this id is still pending.");
      return;
    }
    requestCounter += 1;
    const hostId = `h${requestCounter.toString(36)}`;
    const forwarded: RequestMessage = {
      type: "request",
      id: hostId,
      session,
      method: request.method,
      params: request.params,
    };
    let json: string;
    try {
      json = JSON.stringify(forwarded);
    } catch {
      sendError(conn, id, "invalid_request", "invalid params");
      return;
    }
    const bytes = Buffer.byteLength(json);
    if (bytes > NATIVE_MESSAGE_LIMIT) {
      sendError(
        conn,
        id,
        "message_too_large",
        `The request is ${bytes} bytes; Firefox accepts at most 1 MB per message.`,
      );
      return;
    }
    const entry: Pending = {
      conn,
      id,
      timer: setTimeout(() => onTimeout(hostId, entry), requestTimeoutMs).unref(),
    };
    pending.set(hostId, entry);
    conn.inFlight.set(id, hostId);
    stdout.write(encodeFrame(json));
  }

  // Every path that ends an entry clears its timer, so the entry is still pending here.
  function onTimeout(hostId: string, entry: Pending): void {
    endPending(hostId, entry);
    sendError(
      entry.conn,
      entry.id,
      "timeout",
      `The extension did not answer within ${Math.round(requestTimeoutMs / 1000)} s.`,
    );
  }

  function sendError(conn: Conn, id: string, code: string, message: string): void {
    send(conn, { type: "response", id, ok: false, error: { code, message } });
  }

  function send(conn: Conn, message: WelcomeMessage | ResponseMessage): void {
    sendJson(conn, JSON.stringify(message));
  }

  function sendJson(conn: Conn, json: string): void {
    if (conn.socket.destroyed || !conn.socket.writable) {
      return;
    }
    conn.socket.write(encodeFrame(json));
  }

  function badSocketFrame(conn: Conn, error: string): void {
    conn.badFrames += 1;
    if (conn.badFrames === 1) {
      log(`bad frame from ${conn.label}`, error);
    }
  }

  function onSocketClose(conn: Conn): void {
    connections.delete(conn);
    for (const hostId of conn.inFlight.values()) {
      const entry = pending.get(hostId);
      if (entry !== undefined) {
        endPending(hostId, entry);
      }
    }
    if (conn.session !== null && sessions.get(conn.session) === conn) {
      sessions.delete(conn.session);
      sendSessionEnd(conn.label, conn.session);
    }
    if (conn.badFrames > 1) {
      log(`${conn.label} sent more bad frames`, { count: conn.badFrames - 1 });
    }
    log(`${conn.label} disconnected`);
  }

  function sendSessionEnd(label: string, session: string): void {
    if (closed || !extension.greeted || extensionMismatch !== null) {
      return;
    }
    const message: SessionEndMessage = { type: "session_end", session };
    stdout.write(encodeFrame(JSON.stringify(message)));
    log(`${label} session ended`);
  }

  function close(reason: string): void {
    // Before a bind there is nothing to close, and a failed start settles done by itself.
    if (closed || !bound) {
      return;
    }
    closed = true;
    for (const [hostId, entry] of pending) {
      endPending(hostId, entry);
      sendError(
        entry.conn,
        entry.id,
        "extension_disconnected",
        "Firefox closed the connection to the Foxleash native host.",
      );
    }
    for (const conn of connections) {
      conn.socket.end();
    }
    // Unref'ed: a half-open peer must not keep the process alive or block server.close().
    setTimeout(() => {
      for (const conn of connections) {
        conn.socket.destroy();
      }
    }, FORCE_CLOSE_MS).unref();
    server.close(() => settle(0));
    // libuv has already unlinked a bound socket in server.close(); this does not rely on that.
    removeFile(path, "cannot remove the socket");
    stdin.off("data", onStdinData);
    stdin.off("end", onStdinEnd);
    stdin.off("error", onStdinError);
    stdin.destroy();
    log(`closing: ${reason}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") {
      return code;
    }
  }
  return "UNKNOWN";
}
