import {
  type HelloMessage,
  NATIVE_HOST_NAME,
  OLDEST_SERVED_PROTOCOL,
  PROTOCOL_VERSION,
  parseMessage,
  protocolMismatch,
  type RequestMessage,
  type ResponseMessage,
  type WelcomeMessage,
} from "@foxleash/protocol";
import type { BrowserApi, MessageSender, Port, Timers } from "./browser-api.ts";
import { WELCOME_PAGE } from "./first-run.ts";
import { ToolError } from "./handlers.ts";
import { warn } from "./log.ts";
import { fieldsOf, OPTIONS_PAGE } from "./site-access.ts";

export interface ConnectionDeps<Handle> {
  browser: BrowserApi;
  /** Answers a request in the shape of `protocol`, the protocol of the host it came from. */
  handleRequest: (request: RequestMessage, protocol: number) => Promise<unknown>;
  endSession: (session: string) => Promise<void>;
  timers: Timers<Handle>;
}

export type ProgramState = "checking" | "connected" | "missing";

export interface Connection {
  /** Connects to the native host, unless a port is open or a reconnect is already pending. */
  start(): void;
  /** Whether the Foxleash program answered: "checking" until the first outcome. */
  state(): ProgramState;
}

/** What the host's welcome on a port decided: whether the extension serves that host. */
type Verdict =
  | { served: true; protocol: number; version: string }
  | { served: false; protocol: number; version: string; mismatch: string };

const NO_WELCOME =
  "The Foxleash extension has not learned which version the native host is, so it cannot " +
  "answer; restart Firefox if this continues.";

const FIRST_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10000;

/** Keeps a native messaging port to the host open and answers the requests that arrive on it. */
export function createConnection<Handle>({
  browser,
  handleRequest,
  endSession,
  timers,
}: ConnectionDeps<Handle>): Connection {
  let port: Port | undefined;
  /** The hellos queued on `port`; each one is posted after the one before it. */
  let hellos: Promise<void> = Promise.resolve();
  let reconnectTimer: Handle | undefined;
  let delay = FIRST_RECONNECT_DELAY_MS;
  let programState: ProgramState = "checking";
  /** Per port, so a new port starts without one and a welcome never affects another port. */
  const verdicts = new WeakMap<Port, Verdict>();

  browser.permissions.onAdded.addListener(permissionsChanged);
  browser.permissions.onRemoved.addListener(permissionsChanged);
  browser.runtime.onMessage.addListener(receiveFromPage);

  return { start, state };

  function start(): void {
    if (port !== undefined || reconnectTimer !== undefined) return;
    connect().catch(logError);
  }

  function state(): ProgramState {
    return programState;
  }

  /** Not async: a listener that returns a promise replies, and only these pages get one. */
  function receiveFromPage(message: unknown, sender: MessageSender): Promise<unknown> | undefined {
    if (
      sender.id !== browser.runtime.id ||
      (sender.url !== browser.runtime.getURL(OPTIONS_PAGE) &&
        sender.url !== browser.runtime.getURL(WELCOME_PAGE)) ||
      fieldsOf(message)?.type !== "program_state"
    ) {
      return undefined;
    }
    start();
    return Promise.resolve({ state: programState });
  }

  async function connect(): Promise<void> {
    const current = openPort();
    if (current === undefined) return;
    port = current;
    hellos = Promise.resolve();
    // Listeners first, so nothing that arrives during the permission check is lost.
    current.onMessage.addListener((message) => receive(current, message));
    current.onDisconnect.addListener(() => disconnected(current));
    await queueHello(current);
  }

  function openPort(): Port | undefined {
    try {
      return browser.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      warn({ event: "connect_failed", error: String(error) });
      programState = "missing";
      scheduleReconnect();
      return undefined;
    }
  }

  function permissionsChanged(): void {
    if (port !== undefined) queueHello(port);
  }

  function queueHello(current: Port): Promise<void> {
    hellos = hellos.then(() => postHello(current)).catch(logError);
    return hellos;
  }

  async function postHello(current: Port): Promise<void> {
    const allUrls = await hasAllUrls();
    if (port !== current) return;
    const hello: HelloMessage = {
      type: "hello",
      role: "extension",
      protocol: PROTOCOL_VERSION,
      version: browser.runtime.getManifest().version,
      oldestProtocol: OLDEST_SERVED_PROTOCOL,
      ...(allUrls === undefined ? {} : { allUrls }),
    };
    current.postMessage(hello);
  }

  /** Undefined when Firefox could not answer; the hello then leaves the field out. */
  async function hasAllUrls(): Promise<boolean | undefined> {
    try {
      return await browser.permissions.contains({ origins: ["<all_urls>"] });
    } catch (error) {
      warn({ event: "permission_check_failed", error: String(error) });
      return undefined;
    }
  }

  function receive(current: Port, raw: unknown): void {
    // A message from another realm would fail the plain-object check; fix: structuredClone(raw).
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      if (parsed.id === undefined) {
        warn({ event: "invalid_message", error: parsed.error });
        return;
      }
      respond(current, {
        type: "response",
        id: parsed.id,
        ok: false,
        error: {
          code: "invalid_request",
          message: `Foxleash could not read the request: ${parsed.error}.`,
        },
      });
      return;
    }
    const message = parsed.message;
    if (message.type === "request") answer(current, message).catch(logError);
    else if (message.type === "welcome") welcomed(current, message);
    else if (message.type === "session_end") endSession(message.session).catch(logError);
    else warn({ event: "unexpected_message", type: message.type });
  }

  async function answer(current: Port, request: RequestMessage): Promise<void> {
    respond(current, await outcome(request, verdicts.get(current)));
  }

  async function outcome(
    request: RequestMessage,
    verdict: Verdict | undefined,
  ): Promise<ResponseMessage> {
    try {
      if (verdict === undefined) throw new ToolError("protocol_mismatch", NO_WELCOME);
      if (!verdict.served) throw new ToolError("protocol_mismatch", verdict.mismatch);
      const result = await handleRequest(request, verdict.protocol);
      return { type: "response", id: request.id, ok: true, result };
    } catch (error) {
      if (error instanceof ToolError) {
        return {
          type: "response",
          id: request.id,
          ok: false,
          error: { code: error.code, message: error.message },
        };
      }
      // Firefox's error text can repeat a param, such as a URL, so it stays in the log.
      warn({ event: "request_failed", method: request.method, error: String(error) });
      return {
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "browser_error", message: "Firefox could not complete the request." },
      };
    }
  }

  /** Posts only on the port the request came in on, and only while it is still open. */
  function respond(current: Port, response: ResponseMessage): void {
    if (port === current) current.postMessage(response);
  }

  function welcomed(current: Port, welcome: WelcomeMessage): void {
    delay = FIRST_RECONNECT_DELAY_MS;
    programState = "connected";
    const { protocol, version } = welcome;
    const mismatch = protocolMismatch(
      {
        part: "extension",
        protocol: PROTOCOL_VERSION,
        version: browser.runtime.getManifest().version,
        oldest: OLDEST_SERVED_PROTOCOL,
      },
      { part: "host", protocol, version },
    );
    if (mismatch === null) {
      verdicts.set(current, { served: true, protocol, version });
      return;
    }
    verdicts.set(current, { served: false, protocol, version, mismatch });
    // The host reports a mismatch to the MCP side, so the port stays open.
    warn({ event: "protocol_mismatch", message: mismatch });
  }

  function disconnected(current: Port): void {
    warn({ event: "disconnected", error: current.error?.message ?? null });
    port = undefined;
    programState = "missing";
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined;
      connect().catch(logError);
    }, delay);
    delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

function logError(error: unknown): void {
  warn({ event: "error", error: String(error) });
}
