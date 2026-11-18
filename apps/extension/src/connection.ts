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
  /** Called when the program's state changes, not when it stays the same. */
  onStateChange?: (state: ProgramState) => void;
}

export type ProgramState = "checking" | "connected" | "missing" | "too_old" | "addon_older";

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
// The shortest gap between two re-checks of a program that is too old.
const RECHECK_INTERVAL_MS = 10000;

/** Keeps a native messaging port to the host open and answers the requests that arrive on it. */
export function createConnection<Handle>({
  browser,
  handleRequest,
  endSession,
  timers,
  onStateChange,
}: ConnectionDeps<Handle>): Connection {
  let port: Port | undefined;
  /** The hellos queued on `port`; each one is posted after the one before it. */
  let hellos: Promise<void> = Promise.resolve();
  let reconnectTimer: Handle | undefined;
  let delay = FIRST_RECONNECT_DELAY_MS;
  let programState: ProgramState = "checking";
  let rechecked = false;
  /** Per port, so a new port starts without one and a welcome never affects another port. */
  const verdicts = new WeakMap<Port, Verdict>();
  /** Per port, the sessions whose requests it passed on; a new port starts with none. */
  const admitted = new WeakMap<Port, Set<string>>();

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
    if (programState === "too_old" && !rechecked) recheck();
    start();
    return Promise.resolve({ state: programState });
  }

  /** Opens the native port again, so a program the user updated is found without a restart. */
  function recheck(): void {
    rechecked = true;
    timers.setTimeout(() => {
      rechecked = false;
    }, RECHECK_INTERVAL_MS);
    const replaced = port;
    port = undefined;
    if (replaced !== undefined) {
      replaced.disconnect();
      endAdmitted(replaced);
    }
    connect().catch(logError);
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
      setProgramState("missing");
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
    else if (message.type === "session_end") {
      admitted.get(current)?.delete(message.session);
      endSession(message.session).catch(logError);
    } else warn({ event: "unexpected_message", type: message.type });
  }

  async function answer(current: Port, request: RequestMessage): Promise<void> {
    // Nothing would end a session recorded on a port that is already gone.
    if (port !== current) return;
    respond(current, await outcome(current, request, verdicts.get(current)));
  }

  async function outcome(
    current: Port,
    request: RequestMessage,
    verdict: Verdict | undefined,
  ): Promise<ResponseMessage> {
    try {
      if (verdict === undefined) throw new ToolError("protocol_mismatch", NO_WELCOME);
      if (!verdict.served) throw new ToolError("protocol_mismatch", verdict.mismatch);
      const sessions = admitted.get(current) ?? new Set<string>();
      admitted.set(current, sessions.add(request.session));
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
    // A welcome on a port the extension replaced says nothing about the current one.
    if (port !== current) return;
    delay = FIRST_RECONNECT_DELAY_MS;
    const { protocol, version } = welcome;
    setProgramState(programStateOf(protocol));
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
    // A late event of a port the extension replaced must not drop the new one.
    if (port !== current) return;
    warn({ event: "disconnected", error: current.error?.message ?? null });
    port = undefined;
    setProgramState("missing");
    scheduleReconnect();
    endAdmitted(current);
  }

  /** A host that went away sends no session_end; a live bridge's next request admits it again. */
  function endAdmitted(lost: Port): void {
    const sessions = admitted.get(lost);
    admitted.delete(lost);
    for (const session of sessions ?? []) {
      try {
        endSession(session).catch(logError);
      } catch (error) {
        logError(error);
      }
    }
  }

  function setProgramState(next: ProgramState): void {
    if (next === programState) return;
    programState = next;
    onStateChange?.(next);
  }

  function scheduleReconnect(): void {
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined;
      connect().catch(logError);
    }, delay);
    delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

/** What a host on `protocol` means for the user: the welcome's verdict, as a state. */
function programStateOf(protocol: number): ProgramState {
  if (protocol < OLDEST_SERVED_PROTOCOL) return "too_old";
  if (protocol > PROTOCOL_VERSION) return "addon_older";
  return "connected";
}

function logError(error: unknown): void {
  warn({ event: "error", error: String(error) });
}
