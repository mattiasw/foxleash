import {
  type HelloMessage,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  parseMessage,
  protocolMismatch,
  type RequestMessage,
  type ResponseMessage,
  type WelcomeMessage,
} from "@foxhand/protocol";
import type { BrowserApi, Port, Timers } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";

export interface ConnectionDeps<Handle> {
  browser: BrowserApi;
  handleRequest: (request: RequestMessage) => Promise<unknown>;
  timers: Timers<Handle>;
}

export interface Connection {
  /** Connects to the native host, unless a port is open or a reconnect is already pending. */
  start(): void;
}

const FIRST_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10000;

/** Keeps a native messaging port to the host open and answers the requests that arrive on it. */
export function createConnection<Handle>({
  browser,
  handleRequest,
  timers,
}: ConnectionDeps<Handle>): Connection {
  let port: Port | undefined;
  let reconnectTimer: Handle | undefined;
  let delay = FIRST_RECONNECT_DELAY_MS;

  return { start };

  function start(): void {
    if (port !== undefined || reconnectTimer !== undefined) return;
    connect().catch(logError);
  }

  async function connect(): Promise<void> {
    const current = openPort();
    if (current === undefined) return;
    port = current;
    // Listeners first, so nothing that arrives during the permission check is lost.
    current.onMessage.addListener((message) => receive(current, message));
    current.onDisconnect.addListener(() => disconnected(current));
    const allUrls = await hasAllUrls();
    if (port !== current) return;
    const hello: HelloMessage = {
      type: "hello",
      role: "extension",
      protocol: PROTOCOL_VERSION,
      version: browser.runtime.getManifest().version,
      ...(allUrls === undefined ? {} : { allUrls }),
    };
    current.postMessage(hello);
  }

  function openPort(): Port | undefined {
    try {
      return browser.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      warn({ event: "connect_failed", error: String(error) });
      scheduleReconnect();
      return undefined;
    }
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
          message: `Foxhand could not read the request: ${parsed.error}.`,
        },
      });
      return;
    }
    const message = parsed.message;
    if (message.type === "request") answer(current, message).catch(logError);
    else if (message.type === "welcome") welcomed(message);
    else warn({ event: "unexpected_message", type: message.type });
  }

  async function answer(current: Port, request: RequestMessage): Promise<void> {
    respond(current, await outcome(request));
  }

  async function outcome(request: RequestMessage): Promise<ResponseMessage> {
    try {
      return { type: "response", id: request.id, ok: true, result: await handleRequest(request) };
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

  function welcomed(welcome: WelcomeMessage): void {
    delay = FIRST_RECONNECT_DELAY_MS;
    const mismatch = protocolMismatch(
      {
        part: "extension",
        protocol: PROTOCOL_VERSION,
        version: browser.runtime.getManifest().version,
      },
      { part: "host", protocol: welcome.protocol, version: welcome.version },
    );
    // The host reports a mismatch to the MCP side, so the port stays open.
    if (mismatch !== null) warn({ event: "protocol_mismatch", message: mismatch });
  }

  function disconnected(current: Port): void {
    warn({ event: "disconnected", error: current.error?.message ?? null });
    port = undefined;
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

function warn(fields: Record<string, unknown>): void {
  console.warn(JSON.stringify(fields));
}
