// Copies the text of a response as it passes to the page (ADR 0071, 0073). Every chunk is written
// on, in order, before anything else happens to it; the copy stops at the cap and on any fault,
// and the filter is handed back to Firefox only when the capture ends before the response starts,
// so the page always gets the whole response, unchanged and in order.
import {
  MAX_NETWORK_RESPONSE_BYTES,
  MAX_NETWORK_RESPONSE_TEXT,
  type NetworkResponseBody,
} from "@foxleash/protocol";
import type { HttpHeader, StreamFilter } from "./browser-api.ts";
import { capText } from "./page-messages.ts";

export const REDACTED = "[redacted]";

/** Whether the body may still be kept: "unknown" while the site check has no answer yet. */
export type Wanted = "yes" | "no" | "unknown";

export interface CaptureHooks {
  wanted(): Wanted;
  /** Called at most once, after `end`. */
  store(body: NetworkResponseBody): void;
  /** Called exactly once, however the capture ends. */
  end(): void;
}

export interface ResponseCapture {
  /** The response's headers: the capture goes on only for a text-like Content-Type. */
  headers(responseHeaders: readonly HttpHeader[] | undefined): void;
  /** Ends the capture with nothing stored; the rest of the response still passes on to the page. */
  release(): void;
  /** Asks `wanted` again, as after the site check's answer changed. */
  check(): void;
}

/** Names whose value is a token: any prefix before access or refresh, none before id. */
const TOKEN_NAME = "(?:[A-Za-z0-9_]*(?:access|refresh)[_-]?token|id[_-]?token)";
// Each pattern starts where a name or token can only start, so none rescans a long run of text
// from every position inside it.
const QUOTED_TOKEN = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(${TOKEN_NAME}["']?\s*[:=]\s*)(?:"((?:[^"\\]|\\[\s\S]?)+)("|$)|'((?:[^'\\]|\\[\s\S]?)+)('|$))`,
  "gi",
);
/** The element's text, also inside a CDATA section, up to the next tag or the section's end. */
const ELEMENT_TOKEN = new RegExp(
  String.raw`(<${TOKEN_NAME}\s*>(?:\s*<!\[CDATA\[)?)(?:[^<\]]|\](?!\]>))+`,
  "gi",
);
const FIELD_TOKEN = new RegExp(String.raw`(?<![A-Za-z0-9_])(${TOKEN_NAME}=)[^&\s"'<]+`, "gi");
/** Where a JWT starts: not inside a base64url run, or right after a %-escape such as %20. */
const JWT_START = "(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))eyJ";
const JWT = new RegExp(String.raw`${JWT_START}[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){1,4}`, "g");
/** A JWT cut inside its first segment at the end of the text. */
const UNFINISHED_JWT = new RegExp(`${JWT_START}[A-Za-z0-9_-]*$`);
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
]);
/**
 * Decoders in which ASCII bytes need not decode to the same ASCII text, which would hide a token
 * from the patterns above: UTF-16, ISO-2022-JP's escapes, and the multi-byte encodings whose lead
 * byte takes an ASCII byte as its second (EUC-JP's never does).
 */
const UNSAFE_ENCODINGS: ReadonlySet<string> = new Set([
  "utf-16le",
  "utf-16be",
  "iso-2022-jp",
  "shift_jis",
  "gbk",
  "gb18030",
  "big5",
  "euc-kr",
]);

/**
 * Takes over the filter's events: passes every chunk on, keeps a copy of the first
 * MAX_NETWORK_RESPONSE_BYTES, and once the response ended, its headers said it is text and
 * `wanted` says yes, stores its text, decoded and redacted.
 */
export function captureResponse(filter: StreamFilter, hooks: CaptureHooks): ResponseCapture {
  let chunks: Uint8Array[] = [];
  let bytes = 0;
  // A chunk carried bytes past the cap; no more data is copied.
  let cut = false;
  // No more data will be copied: the response ended, or the cap cut it.
  let stopped = false;
  let ended = false;
  // undefined until the headers came, null when they are not text-like.
  let encoding: string | null | undefined;

  filter.ondata = (event) => {
    try {
      filter.write(event.data);
    } catch {
      fail();
    }
    if (ended || stopped) return;
    try {
      copy(event.data);
    } catch {
      fail();
    }
  };
  filter.onstop = () => {
    try {
      filter.close();
    } catch {
      // Nothing more can reach the page through this filter either way.
    }
    if (ended) return;
    stopped = true;
    try {
      settle();
    } catch {
      fail();
    }
  };
  filter.onerror = () => {
    chunks = [];
    if (!ended) end();
  };

  return { headers, release, check };

  function copy(data: ArrayBuffer): void {
    // Bytes that arrive while the site check has no answer could come from a gap in access.
    if (hooks.wanted() !== "yes") {
      release();
      return;
    }
    const left = MAX_NETWORK_RESPONSE_BYTES - bytes;
    if (data.byteLength <= left) {
      chunks.push(new Uint8Array(data.slice(0)));
      bytes += data.byteLength;
      return;
    }
    chunks.push(new Uint8Array(data.slice(0, left)));
    cut = true;
    stopped = true;
    settle();
  }

  function headers(responseHeaders: readonly HttpHeader[] | undefined): void {
    if (ended || encoding !== undefined) return;
    try {
      encoding = textEncoding(responseHeaders) ?? null;
      if (encoding === null) release();
      else settle();
    } catch {
      fail();
    }
  }

  /** Stores the body once it is complete or cut, its type is known to be text and it is wanted. */
  function settle(): void {
    if (!stopped || ended || typeof encoding !== "string") return;
    const wanted = hooks.wanted();
    if (wanted === "no") {
      release();
      return;
    }
    if (wanted === "unknown") return;
    const body = responseBody(chunks, encoding, cut);
    chunks = [];
    end();
    if (body !== undefined) hooks.store(body);
  }

  function release(): void {
    if (ended) return;
    chunks = [];
    end();
  }

  function check(): void {
    if (ended) return;
    try {
      if (hooks.wanted() === "no") release();
      else settle();
    } catch {
      fail();
    }
  }

  function fail(): void {
    chunks = [];
    if (!ended) end();
  }

  function end(): void {
    ended = true;
    passOn(filter);
    hooks.end();
  }
}

/**
 * Takes over the filter's events once the capture ended, holding nothing but the filter, so the
 * capture and its hooks can be freed while a long response still streams. A response that has not
 * started is handed back to Firefox; one that has gets every chunk written on and is closed at the
 * stop, since a disconnect while data flows can reorder or drop the chunks still on their way
 * (ADR 0073).
 */
function passOn(filter: StreamFilter): void {
  filter.onstart = () => {
    try {
      filter.disconnect();
    } catch {
      // The handlers below keep writing and close at the stop.
    }
  };
  filter.ondata = (event) => {
    try {
      filter.write(event.data);
    } catch {
      // Only this chunk is lost; the later ones are still written.
    }
  };
  filter.onstop = () => {
    try {
      filter.close();
    } catch {
      // Nothing more can reach the page through this filter either way.
    }
  };
  filter.onerror = null;
}

/**
 * The name of the decoder for a text-like response, from its one Content-Type header; undefined
 * when there is none, more than one, or the type is not text, is an event stream or names a
 * charset whose decoder is not ASCII-compatible.
 */
export function textEncoding(headers: readonly HttpHeader[] | undefined): string | undefined {
  const types = (headers ?? []).filter(({ name }) => name.toLowerCase() === "content-type");
  if (types.length !== 1) return undefined;
  const [essence = "", ...parameters] = (types[0]?.value ?? "").split(";");
  if (!isTextLike(essence.trim().toLowerCase())) return undefined;
  const encoding = decoderName(charsetOf(parameters));
  return UNSAFE_ENCODINGS.has(encoding) ? undefined : encoding;
}

function isTextLike(essence: string): boolean {
  // An event stream has no end at which its body is complete.
  if (essence === "text/event-stream") return false;
  if (essence.startsWith("text/")) return true;
  if (TEXT_TYPES.has(essence)) return true;
  return essence.startsWith("application/") && /\+(?:json|xml)$/.test(essence);
}

function charsetOf(parameters: readonly string[]): string | undefined {
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    if (equals < 0 || parameter.slice(0, equals).trim().toLowerCase() !== "charset") continue;
    const value = parameter.slice(equals + 1).trim();
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return undefined;
}

/** The decoder a charset label names; UTF-8 when there is none or Firefox does not know it. */
function decoderName(label: string | undefined): string {
  if (label === undefined) return "utf-8";
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return "utf-8";
  }
}

/**
 * The copied bytes as a body: decoded, redacted, then cut to MAX_NETWORK_RESPONSE_TEXT. A cut body
 * drops a character the cut split. Undefined for UTF-16 text, which the redaction cannot read.
 */
export function responseBody(
  chunks: readonly Uint8Array[],
  encoding: string,
  cut: boolean,
): NetworkResponseBody | undefined {
  if (startsWithUtf16Mark(chunks)) return undefined;
  const decoder = new TextDecoder(encoding);
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  if (!cut) text += decoder.decode();
  // UTF-16 text without a byte order mark: every other byte of ASCII text is 0.
  if (text.includes("\0")) return undefined;
  const capped = capText(redactTokens(text), MAX_NETWORK_RESPONSE_TEXT);
  return cut || capped.truncated ? { text: capped.text, truncated: true } : { text: capped.text };
}

function startsWithUtf16Mark(chunks: readonly Uint8Array[]): boolean {
  const [first, second] = chunks.flatMap((chunk) => [...chunk.subarray(0, 2)]);
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
}

/**
 * Replaces the values of access, refresh and ID token fields in JSON, JavaScript, XML and form
 * text, and JWT-shaped strings, also when the text ends inside one. A best effort: other names
 * and other encodings of a token pass.
 */
export function redactTokens(text: string): string {
  return text
    .replace(
      QUOTED_TOKEN,
      (
        _match: string,
        key: string,
        doubled: string | undefined,
        doubleEnd: string | undefined,
        _single: string | undefined,
        singleEnd: string | undefined,
      ) =>
        doubled === undefined
          ? `${key}'${REDACTED}${singleEnd ?? ""}`
          : `${key}"${REDACTED}${doubleEnd ?? ""}`,
    )
    .replace(ELEMENT_TOKEN, `$1${REDACTED}`)
    .replace(FIELD_TOKEN, `$1${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(UNFINISHED_JWT, REDACTED);
}
