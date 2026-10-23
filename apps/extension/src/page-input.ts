import {
  type KeyAction,
  MAX_TYPE_CHARS,
  type Result,
  type TypeMethod,
  type TypeOutcome,
} from "@foxhand/protocol";
import { isRecord, ownField } from "./page-messages.ts";
import { siteOf } from "./site.ts";

export type TypeOptions = { ref: string; text: string };

export type PressKeyOptions = { key: string; ref?: string };

/** A key as press_key sends it: the KeyboardEvent key and code values and the modifiers held. */
export interface ParsedKey {
  key: string;
  code: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** The default action a key has, given the modifiers held; Shift only for Tab. */
export type KeyDefault = "enter" | "tab" | "shift_tab" | "escape" | "arrow_down" | "arrow_up";

/** How Enter submits a form implicitly: through its default button, without one, or not at all. */
export type ImplicitSubmission = "with_button" | "without_button" | "none";

const NAMED_KEYS: readonly string[] = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
];
const MODIFIERS: ReadonlyMap<string, "shift" | "control" | "alt" | "meta"> = new Map([
  ["shift", "shift"],
  ["control", "control"],
  ["ctrl", "control"],
  ["alt", "alt"],
  ["meta", "meta"],
]);
const KEY_NAMES =
  "press_key needs key to be one character or one of Enter, Tab, Escape, Space, Backspace, Delete, Insert, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown and F1 to F12, after any of the modifiers Shift, Control (or Ctrl), Alt and Meta joined with +, such as Control+a.";
const KEY_MODIFIERS =
  "press_key takes only Shift, Control (or Ctrl), Alt and Meta before the key, each at most once and joined with +, such as Control+Shift+a.";
const OUTCOMES: readonly unknown[] = ["typed", "sent_unconfirmed"] satisfies TypeOutcome[];
const METHODS: readonly unknown[] = [
  "exec_command",
  "native_setter",
  "beforeinput_dom",
] satisfies TypeMethod[];
const ACTIONS: readonly unknown[] = [
  "none",
  "submitted",
  "clicked",
  "focus_moved",
  "selected_option",
  "closed_dialog",
  "hid_popover",
] satisfies KeyAction[];
const TYPEABLE_INPUTS: ReadonlySet<string> = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);
const NOT_SUBMITTING_INPUTS: ReadonlySet<string> = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "checkbox",
  "radio",
  "file",
  "color",
  "range",
  "hidden",
]);
const BLOCKING_INPUTS: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
]);
const CLICK_INPUTS: ReadonlySet<string> = new Set(["button", "submit", "reset", "image"]);
const LATIN_LETTER = /^[a-z]$/i;
const DIGIT = /^[0-9]$/;
const CONTROL_OR_SURROGATE = /^[\p{Cc}\p{Cs}]$/u;

/** The options of a type request, or the sentence that refuses them. */
export function typeOptions(params: Record<string, unknown>): TypeOptions | string {
  const ref = ownField(params, "ref");
  if (typeof ref !== "string") return "type needs ref to be a string.";
  const text = ownField(params, "text");
  if (typeof text !== "string" || text.length < 1 || text.length > MAX_TYPE_CHARS) {
    return `type needs text to be a string of 1 to ${MAX_TYPE_CHARS} characters.`;
  }
  return { ref, text };
}

/** The options of a press_key request, or the sentence that refuses them. */
export function pressKeyOptions(params: Record<string, unknown>): PressKeyOptions | string {
  const key = ownField(params, "key");
  if (typeof key !== "string") return "press_key needs key to be a string.";
  const parsed = parseKey(key);
  if (typeof parsed === "string") return parsed;
  const ref = ownField(params, "ref");
  if (ref === undefined) return { key };
  if (typeof ref !== "string") return "press_key needs ref to be a string.";
  return { key, ref };
}

/**
 * A key written as modifiers joined by `+` before one named key or one character, or the
 * sentence that refuses it. The key is the text after the last `+`, except that a text ending in
 * `++`, or exactly `+`, has the key `+`.
 */
export function parseKey(text: string): ParsedKey | string {
  const split = splitKey(text);
  const named = namedKey(split.key);
  const key = named ?? characterKey(split.key);
  if (key === undefined) return KEY_NAMES;
  const held = { shift: false, control: false, alt: false, meta: false };
  for (const token of split.modifiers) {
    const modifier = MODIFIERS.get(token.toLowerCase());
    if (modifier === undefined || held[modifier]) return KEY_MODIFIERS;
    held[modifier] = true;
  }
  return { ...key, ...held };
}

function splitKey(text: string): { modifiers: string[]; key: string } {
  if (text === "+") return { modifiers: [], key: "+" };
  if (text.endsWith("++")) return { modifiers: text.slice(0, -2).split("+"), key: "+" };
  const cut = text.lastIndexOf("+");
  if (cut < 0) return { modifiers: [], key: text };
  return { modifiers: text.slice(0, cut).split("+"), key: text.slice(cut + 1) };
}

function namedKey(text: string): { key: string; code: string } | undefined {
  const lower = text.toLowerCase();
  const name = NAMED_KEYS.find((candidate) => candidate.toLowerCase() === lower);
  if (name === undefined) return undefined;
  return { key: name === "Space" ? " " : name, code: name };
}

/** One code point that is neither a control character nor a lone surrogate, kept as written. */
function characterKey(text: string): { key: string; code: string } | undefined {
  if ([...text].length !== 1 || CONTROL_OR_SURROGATE.test(text)) return undefined;
  if (text === " ") return { key: " ", code: "Space" };
  if (LATIN_LETTER.test(text)) return { key: text, code: `Key${text.toUpperCase()}` };
  if (DIGIT.test(text)) return { key: text, code: `Digit${text}` };
  return { key: text, code: "" };
}

/** The content script's reply to type, or undefined when it is not one. */
export function typeResultOf(value: unknown): Result<"type"> | undefined {
  if (!isRecord(value)) return undefined;
  const outcome = ownField(value, "outcome");
  const method = ownField(value, "method");
  if (!isOutcome(outcome) || !isMethod(method)) return undefined;
  return { outcome, method };
}

function isOutcome(value: unknown): value is TypeOutcome {
  return OUTCOMES.includes(value);
}

function isMethod(value: unknown): value is TypeMethod {
  return METHODS.includes(value);
}

/** The content script's reply to press_key, or undefined when it is not one. */
export function pressKeyResultOf(value: unknown): Result<"press_key"> | undefined {
  if (!isRecord(value)) return undefined;
  const action = ownField(value, "action");
  const prevented = ownField(value, "prevented");
  if (!isAction(action) || typeof prevented !== "boolean") return undefined;
  return { action, prevented };
}

function isAction(value: unknown): value is KeyAction {
  return ACTIONS.includes(value);
}

/**
 * The entry sequential focus navigation moves to from `current`, an index into `entries` (in
 * tree order) or -1 for none: entries with a positive tabIndex in ascending order, ties in tree
 * order, then those with tabIndex 0 in tree order. From an entry outside that sequence (a
 * negative tabIndex), forward goes to the next tabIndex-0 entry after it and backward to the last
 * one before it, else to the last positive one. Undefined past either end: a real Tab there
 * leaves the page.
 */
export function nextInTabOrder(
  entries: readonly { tabIndex: number }[],
  current: number,
  backwards: boolean,
): number | undefined {
  const indices = entries.map((_entry, index) => index);
  const positive = indices
    .filter((index) => tabIndexAt(entries, index) > 0)
    .sort((a, b) => tabIndexAt(entries, a) - tabIndexAt(entries, b));
  const zero = indices.filter((index) => tabIndexAt(entries, index) === 0);
  const sequence = [...positive, ...zero];
  if (entries[current] === undefined) return backwards ? sequence.at(-1) : sequence[0];
  const position = sequence.indexOf(current);
  if (position >= 0) return backwards ? sequence[position - 1] : sequence[position + 1];
  if (!backwards) return zero.find((index) => index > current);
  return zero.findLast((index) => index < current) ?? positive.at(-1);
}

function tabIndexAt(entries: readonly { tabIndex: number }[], index: number): number {
  return entries[index]?.tabIndex ?? -1;
}

/**
 * Whether a frame whose window has this origin is on the page's site. An about:blank or srcdoc
 * frame has its creator's origin; a sandboxed one has "null", which is on no site.
 */
export function frameOnSite(origin: string, pageUrl: string): boolean {
  const site = siteOf(origin);
  return site !== undefined && site === siteOf(pageUrl);
}

/** Whether type types into an input of this type. */
export function isTypeableInput(type: string): boolean {
  return TYPEABLE_INPUTS.has(type);
}

/** Whether Enter in an input of this type submits its form implicitly. */
export function submitsImplicitly(type: string): boolean {
  return !NOT_SUBMITTING_INPUTS.has(type);
}

/** Whether an input of this type is a field that blocks implicit submission (HTML). */
export function blocksImplicitSubmission(type: string): boolean {
  return BLOCKING_INPUTS.has(type);
}

/** Whether Enter on an input of this type clicks it. */
export function isClickInput(type: string): boolean {
  return CLICK_INPUTS.has(type);
}

/**
 * HTML's implicit submission: through the default button unless it is disabled; with none, only
 * when the form has exactly one field that blocks implicit submission.
 */
export function implicitSubmission(
  defaultButton: "enabled" | "disabled" | "none",
  blockingFields: number,
): ImplicitSubmission {
  if (defaultButton === "enabled") return "with_button";
  if (defaultButton === "disabled") return "none";
  return blockingFields === 1 ? "without_button" : "none";
}

/** The default action Foxhand performs for the key, if any. */
export function keyDefault(key: ParsedKey): KeyDefault | undefined {
  if (key.control || key.alt || key.meta) return undefined;
  if (key.shift) return key.key === "Tab" ? "shift_tab" : undefined;
  switch (key.key) {
    case "Enter":
      return "enter";
    case "Tab":
      return "tab";
    case "Escape":
      return "escape";
    case "ArrowDown":
      return "arrow_down";
    case "ArrowUp":
      return "arrow_up";
    default:
      return undefined;
  }
}

/** Whether the key sends a keypress: Enter or a character, without Control or Meta. */
export function sendsKeyPress(key: ParsedKey): boolean {
  if (key.control || key.meta) return false;
  return key.key === "Enter" || [...key.key].length === 1;
}

/** The text without CR and LF, as an input's value sanitization leaves it. */
export function singleLine(text: string): string {
  return text.replace(/[\r\n]/g, "");
}

/** The text with each CRLF and CR as LF, as a textarea's value gives it back. */
export function lineFeeds(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The field's maxLength where HTML applies it, else -1: a number input has none. */
export function lengthLimit(type: string, maxLength: number): number {
  return type === "number" ? -1 : maxLength;
}

/**
 * The value a field holds after the text is added at its end, cut to `maxLength` when that is 0
 * or more, never through a surrogate pair; a value already longer than that is never cut.
 */
export function expectedValue(before: string, text: string, maxLength: number): string {
  const value = before + text;
  if (maxLength < 0 || value.length <= maxLength) return value;
  const end = Math.max(maxLength, before.length);
  const splitsPair = end > before.length && [...value.slice(end - 1, end + 1)].length === 1;
  return value.slice(0, splitsPair ? end - 1 : end);
}

/**
 * The option an arrow key selects in a select: the next, or previous, one that is not disabled.
 * Forward from none selected, the first enabled one; undefined backward from none and at either
 * end.
 */
export function nextOption(
  disabled: readonly boolean[],
  selectedIndex: number,
  backwards: boolean,
): number | undefined {
  const enabled = disabled.flatMap((off, index) => (off ? [] : [index]));
  if (backwards) return enabled.findLast((index) => index < selectedIndex);
  return enabled.find((index) => index > selectedIndex);
}
