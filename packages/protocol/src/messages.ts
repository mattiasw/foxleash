import { METHOD_NAMES, type MethodName } from "./methods.ts";

export type Role = "extension" | "mcp";

export type ExtensionStatus =
  | { connected: false }
  | { connected: true; protocol: number; version: string; allUrls?: boolean };

/**
 * Keep these fields and their allowed values the same in every protocol version: a peer on
 * another protocol must still parse a hello to report which part is stale.
 */
export interface HelloMessage {
  type: "hello";
  role: Role;
  protocol: number;
  version: string;
  allUrls?: boolean;
}

/**
 * Keep these fields and their allowed values the same in every protocol version: a peer on
 * another protocol must still parse a welcome to report which part is stale.
 */
export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  version: string;
  extension?: ExtensionStatus;
}

/** A request as parsed: `params` is only known to be an object; the receiver validates it per method. */
export interface RequestMessage {
  type: "request";
  id: string;
  session: string;
  method: MethodName;
  params: Record<string, unknown>;
}

export interface ResponseError {
  code: string;
  message: string;
}

export type ResponseMessage =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: ResponseError };

/** Sent by the host when the MCP connection bound to `session` closes. */
export interface SessionEndMessage {
  type: "session_end";
  session: string;
}

export type Message =
  | HelloMessage
  | WelcomeMessage
  | RequestMessage
  | ResponseMessage
  | SessionEndMessage;

export type ParseResult =
  | { ok: true; message: Message }
  | { ok: false; error: string; id?: string };

type Fields = Record<string, unknown>;

/** Validates an envelope from another process and returns a fresh copy of its known fields. */
export function parseMessage(value: unknown): ParseResult {
  if (!isPlainObject(value)) return fail("message");
  switch (own(value, "type")) {
    case "hello":
      return parseHello(value);
    case "welcome":
      return parseWelcome(value);
    case "request":
      return parseRequest(value);
    case "response":
      return parseResponse(value);
    case "session_end":
      return parseSessionEnd(value);
    default:
      return fail("type");
  }
}

function parseHello(fields: Fields): ParseResult {
  const role = own(fields, "role");
  if (role !== "extension" && role !== "mcp") return fail("role");
  const protocol = own(fields, "protocol");
  if (!isProtocol(protocol)) return fail("protocol");
  const version = own(fields, "version");
  if (!isVersion(version)) return fail("version");
  const allUrls = own(fields, "allUrls");
  if (allUrls === undefined)
    return { ok: true, message: { type: "hello", role, protocol, version } };
  if (typeof allUrls !== "boolean") return fail("allUrls");
  return { ok: true, message: { type: "hello", role, protocol, version, allUrls } };
}

function parseWelcome(fields: Fields): ParseResult {
  const protocol = own(fields, "protocol");
  if (!isProtocol(protocol)) return fail("protocol");
  const version = own(fields, "version");
  if (!isVersion(version)) return fail("version");
  const extension = own(fields, "extension");
  if (extension === undefined) return { ok: true, message: { type: "welcome", protocol, version } };
  const status = parseExtensionStatus(extension);
  if (typeof status === "string") return fail(status);
  return { ok: true, message: { type: "welcome", protocol, version, extension: status } };
}

/** Returns the status, or the path of the field that failed. */
function parseExtensionStatus(value: unknown): ExtensionStatus | string {
  if (!isPlainObject(value)) return "extension";
  const connected = own(value, "connected");
  if (connected === false) return { connected: false };
  if (connected !== true) return "extension.connected";
  const protocol = own(value, "protocol");
  if (!isProtocol(protocol)) return "extension.protocol";
  const version = own(value, "version");
  if (!isVersion(version)) return "extension.version";
  const allUrls = own(value, "allUrls");
  if (allUrls === undefined) return { connected: true, protocol, version };
  if (typeof allUrls !== "boolean") return "extension.allUrls";
  return { connected: true, protocol, version, allUrls };
}

function parseRequest(fields: Fields): ParseResult {
  const id = own(fields, "id");
  if (!isToken(id)) return fail("id");
  const session = own(fields, "session");
  if (!isToken(session)) return fail("session", id);
  const method = own(fields, "method");
  if (!isMethodName(method)) return fail("method", id);
  const params = own(fields, "params");
  if (!isPlainObject(params)) return fail("params", id);
  return {
    ok: true,
    message: { type: "request", id, session, method, params: copyParams(params) },
  };
}

function copyParams(params: Fields): Fields {
  const copy: Fields = {};
  for (const key of Object.keys(params)) {
    // Assigning this key would replace the copy's prototype instead of adding a field.
    if (key === "__proto__") continue;
    copy[key] = params[key];
  }
  return copy;
}

function parseResponse(fields: Fields): ParseResult {
  const id = own(fields, "id");
  if (!isToken(id)) return fail("id");
  const ok = own(fields, "ok");
  if (ok === true) {
    // JSON.stringify drops a result of undefined, so a missing key means "no result".
    const result = own(fields, "result") ?? null;
    return { ok: true, message: { type: "response", id, ok, result } };
  }
  if (ok !== false) return fail("ok");
  const error = own(fields, "error");
  if (!isPlainObject(error)) return fail("error");
  const code = own(error, "code");
  if (!isToken(code)) return fail("error.code");
  const message = own(error, "message");
  if (typeof message !== "string") return fail("error.message");
  return { ok: true, message: { type: "response", id, ok, error: { code, message } } };
}

function parseSessionEnd(fields: Fields): ParseResult {
  const session = own(fields, "session");
  if (!isToken(session)) return fail("session");
  return { ok: true, message: { type: "session_end", session } };
}

function fail(field: string, id?: string): ParseResult {
  const error = `invalid ${field}`;
  return id === undefined ? { ok: false, error } : { ok: false, error, id };
}

function isPlainObject(value: unknown): value is Fields {
  if (value === null || value === undefined) return false;
  // Primitives are boxed here, and their prototypes are never one of these two.
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads only an own property, so a polluted `Object.prototype` never supplies a field. */
function own(fields: Fields, key: string): unknown {
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

function isProtocol(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Release version characters only: versions are quoted in the mismatch sentence users read.
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

// Printable ASCII without space: keeps newlines, escapes and invisible characters out of logs.
const TOKEN = /^[\x21-\x7E]{1,256}$/;

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function isMethodName(value: unknown): value is MethodName {
  return (METHOD_NAMES as readonly unknown[]).includes(value);
}
