import {
  type FillOutcome,
  type FillResult,
  type FillValue,
  fillChars,
  MAX_FILL_CHARS,
  MAX_FILL_FIELDS,
  MAX_TYPE_CHARS,
  type Result,
} from "@foxhand/protocol";
import { capText, isRecord, MAX_ERROR_MESSAGE, ownField } from "./page-messages.ts";

export type FillFormOptions = { fields: { ref: string; value: FillValue }[] };

/** An option of a select as optionMatcher compares it. */
export interface MatchableOption {
  value: string;
  label: string;
  disabled: boolean;
}

/** The index of the option a wanted string chooses, or why there is none. */
export type OptionMatch = number | "none" | "disabled";

const OUTCOMES: readonly unknown[] = [
  "typed",
  "selected",
  "clicked",
  "unchanged",
] satisfies FillOutcome[];
/** The codes a field's result may carry. */
const FILL_FIELD_CODES: readonly unknown[] = [
  "invalid_params",
  "invalid_ref",
  "stale_ref",
  "ref_not_found",
  "not_editable",
  "no_effect",
  "not_attempted",
  "page_error",
];
const FIELDS = `fill_form needs fields to be a list of 1 to ${MAX_FILL_FIELDS} fields.`;

/** The options of a fill_form request, or the sentence that refuses them. */
export function fillFormOptions(params: Record<string, unknown>): FillFormOptions | string {
  const given = ownField(params, "fields");
  if (!Array.isArray(given) || given.length < 1 || given.length > MAX_FILL_FIELDS) return FIELDS;
  const fields: FillFormOptions["fields"] = [];
  const refs = new Set<string>();
  for (let index = 0; index < given.length; index += 1) {
    const field = fieldOf(given, index);
    if (typeof field === "string") return field;
    if (refs.has(field.ref)) return "fill_form takes each ref at most once.";
    refs.add(field.ref);
    fields.push(field);
  }
  if (fillChars(fields) > MAX_FILL_CHARS) {
    return `fill_form takes at most ${MAX_FILL_CHARS} characters across all values, each string counting at least one.`;
  }
  return { fields };
}

/** Entry `index` of the request's fields as an own ref and value, or the sentence that refuses it. */
function fieldOf(
  fields: readonly unknown[],
  index: number,
): { ref: string; value: FillValue } | string {
  const entry = Object.hasOwn(fields, index) ? fields[index] : undefined;
  const position = index + 1;
  if (!isRecord(entry)) {
    return `fill_form needs field ${position} to be an object with a ref and a value.`;
  }
  const ref = ownField(entry, "ref");
  if (typeof ref !== "string") return `fill_form needs ref of field ${position} to be a string.`;
  const value = allowedValue(ownField(entry, "value"));
  if (value === undefined) {
    return `fill_form needs the value of field ${position} to be a string of at most ${MAX_TYPE_CHARS} characters, true or false, or a list of such strings.`;
  }
  return { ref, value };
}

/** A copy of a field's value when it has an allowed shape, else undefined. */
function allowedValue(value: unknown): FillValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return isText(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const copy: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = Object.hasOwn(value, index) ? value[index] : undefined;
    if (typeof entry !== "string" || !isText(entry)) return undefined;
    copy.push(entry);
  }
  return copy;
}

function isText(value: string): boolean {
  return value.length <= MAX_TYPE_CHARS;
}

/**
 * The content script's reply to fill_form, or undefined when it is not one: a result for each
 * requested field, in order and with its ref, rebuilt from its own fields so that nothing else the
 * page adds, such as a value, reaches the agent.
 */
export function fillFormResultOf(
  value: unknown,
  options: FillFormOptions,
): Result<"fill_form"> | undefined {
  if (!isRecord(value)) return undefined;
  const given = ownField(value, "fields");
  if (!Array.isArray(given) || given.length !== options.fields.length) return undefined;
  const fields: FillResult[] = [];
  for (const [index, requested] of options.fields.entries()) {
    const entry: unknown = Object.hasOwn(given, index) ? given[index] : undefined;
    const result = resultOf(entry, requested.ref);
    if (result === undefined) return undefined;
    fields.push(result);
  }
  return { fields };
}

function resultOf(entry: unknown, ref: string): FillResult | undefined {
  if (!isRecord(entry) || ownField(entry, "ref") !== ref) return undefined;
  const ok = ownField(entry, "ok");
  if (ok === true) {
    const outcome = ownField(entry, "outcome");
    return isOutcome(outcome) ? { ref, ok, outcome } : undefined;
  }
  if (ok !== false) return undefined;
  const code = ownField(entry, "code");
  const message = ownField(entry, "message");
  if (typeof code !== "string" || !FILL_FIELD_CODES.includes(code)) return undefined;
  if (typeof message !== "string") return undefined;
  return { ref, ok, code, message: capText(message, MAX_ERROR_MESSAGE).text };
}

function isOutcome(value: unknown): value is FillOutcome {
  return OUTCOMES.includes(value);
}

/**
 * Matches wanted strings against a select's options: the options whose value equals the string,
 * else those whose label does; the first enabled one of them, "disabled" when they all are, and
 * "none" when there are none. Built once, so matching takes the same time for every string.
 */
export function optionMatcher(
  options: readonly MatchableOption[],
): (wanted: string) => OptionMatch {
  const byValue = new Map<string, number | "disabled">();
  const byLabel = new Map<string, number | "disabled">();
  for (const [index, option] of options.entries()) {
    note(byValue, option.value, index, option.disabled);
    note(byLabel, option.label, index, option.disabled);
  }
  return (wanted) => byValue.get(wanted) ?? byLabel.get(wanted) ?? "none";
}

/** Records the option under a key unless an enabled option came first. */
function note(
  matches: Map<string, number | "disabled">,
  key: string,
  index: number,
  disabled: boolean,
): void {
  const known = matches.get(key);
  if (known === undefined || known === "disabled") {
    matches.set(key, disabled ? "disabled" : index);
  }
}
