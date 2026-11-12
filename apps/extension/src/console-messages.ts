import {
  CONSOLE_KINDS,
  CONSOLE_LEVELS,
  type ConsoleMessage,
  MAX_CONSOLE_MESSAGES,
  MAX_CONSOLE_TEXT,
  type Result,
} from "@foxleash/protocol";
import type { RecorderOptions } from "./console-recorder.ts";
import { capText, isRecord, MAX_PAGE_REPLY_CHARS, ownField } from "./page-messages.ts";

export const CONSOLE_READ_EVENT = "foxleash-console-read";
export const CONSOLE_RECORDS_EVENT = "foxleash-console-records";

export const RECORDER_OPTIONS: RecorderOptions = {
  maxMessages: MAX_CONSOLE_MESSAGES,
  maxText: MAX_CONSOLE_TEXT,
  readEvent: CONSOLE_READ_EVENT,
  replyEvent: CONSOLE_RECORDS_EVENT,
};

/**
 * Asks the page's recorder for its records, synchronously, and reads its reply as untrusted
 * input. With no recorder in the document, `recording` is false.
 */
export function readConsoleRecords(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">,
): Result<"read_console"> {
  let replied = false;
  let detail: unknown;
  const listener = (event: Event) => {
    if (replied) return;
    replied = true;
    try {
      detail = (event as CustomEvent<unknown>).detail;
    } catch {
      detail = null;
    }
  };
  target.addEventListener(CONSOLE_RECORDS_EVENT, listener);
  try {
    target.dispatchEvent(new CustomEvent(CONSOLE_READ_EVENT));
  } finally {
    target.removeEventListener(CONSOLE_RECORDS_EVENT, listener);
  }
  const result = parseRecorderReply(replied ? detail : undefined);
  if (result === undefined) throw new Error("The page's console records cannot be read.");
  return result;
}

/** The recorder's reply as a result; undefined when it is not one. No reply: not recording. */
export function parseRecorderReply(detail: unknown): Result<"read_console"> | undefined {
  if (detail === undefined) return { recording: false, messages: [], dropped: 0 };
  if (typeof detail !== "string" || detail.length > MAX_PAGE_REPLY_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    // Not JSON: refused below with anything else that is not a record.
  }
  if (!isRecord(parsed)) return undefined;
  return parseConsoleResult({
    recording: true,
    messages: ownField(parsed, "messages"),
    dropped: ownField(parsed, "dropped"),
  });
}

/**
 * A read_console result built afresh from a value that came from the page: own fields only, at
 * most MAX_CONSOLE_MESSAGES messages, each text cut to MAX_CONSOLE_TEXT. Undefined for anything
 * else.
 */
export function parseConsoleResult(value: unknown): Result<"read_console"> | undefined {
  if (!isRecord(value)) return undefined;
  const recording = ownField(value, "recording");
  const dropped = ownField(value, "dropped");
  const messages = ownField(value, "messages");
  if (typeof recording !== "boolean") return undefined;
  if (typeof dropped !== "number" || !Number.isSafeInteger(dropped) || dropped < 0) {
    return undefined;
  }
  if (!Array.isArray(messages) || messages.length > MAX_CONSOLE_MESSAGES) return undefined;
  const parsed: ConsoleMessage[] = [];
  for (const message of messages) {
    const entry = consoleMessageOf(message);
    if (entry === undefined) return undefined;
    parsed.push(entry);
  }
  return { recording, messages: parsed, dropped };
}

function consoleMessageOf(value: unknown): ConsoleMessage | undefined {
  if (!isRecord(value)) return undefined;
  const level = ownField(value, "level");
  const kind = ownField(value, "kind");
  const text = ownField(value, "text");
  const time = ownField(value, "time");
  const knownLevel = CONSOLE_LEVELS.find((known) => known === level);
  const knownKind = CONSOLE_KINDS.find((known) => known === kind);
  if (
    knownLevel === undefined ||
    knownKind === undefined ||
    typeof text !== "string" ||
    typeof time !== "number" ||
    !Number.isFinite(time)
  ) {
    return undefined;
  }
  return { level: knownLevel, kind: knownKind, text: capText(text, MAX_CONSOLE_TEXT).text, time };
}
