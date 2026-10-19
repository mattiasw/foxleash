import { capText, ownField } from "./page-messages.ts";

/** The longest tree read_page returns, in UTF-16 units. */
export const READ_PAGE_MAX_CHARS = 50_000;
/** The longest name, value, href or text a line holds, before quoting and the cut mark. */
export const MAX_FIELD_CHARS = 200;

export type ReadPageOptions = { filter: "all" | "interactive"; depth?: number; ref?: string };

/** The states a line can carry; only `value` and `href` hold page text. */
export interface LineStates {
  checked?: "checked" | "mixed";
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  invalid?: boolean;
  focused?: boolean;
  /** A safe integer of 1 or more. */
  level?: number;
  /** A protected field has no value to write. */
  field?: { value: string } | { protected: true; filled: boolean };
  href?: string;
  frame?: true;
}

export interface Line {
  level: number;
  role: string;
  name?: string;
  ref?: string;
  states?: LineStates;
}

export interface TreeText {
  /** Appends a whole line; false, with nothing appended, once the line would pass the cap. */
  add(line: string): boolean;
  /** Ends the last line with ` …`, or marks the tree cut when that does not fit. */
  markCut(): void;
  /** True once nothing more can be added. */
  readonly full: boolean;
  result(): { tree: string; truncated: boolean };
}

export interface TextBuffer {
  /** Appends text, with runs of whitespace collapsed to one space. */
  add(text: string): void;
  /** True once the text holds more than its limit. */
  readonly full: boolean;
  text(): string;
}

export interface FieldFacts {
  localName: string;
  /** The element's `type` property. */
  type: string;
  /** The `autocomplete` attribute as written. */
  autocomplete: string | null;
  /** The field was a password field when read_page saw it before in this document. */
  wasPassword: boolean;
}

// NEL is not \s, and some tools split lines on it.
const WHITESPACE = /[\s\u0085]+/g;
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;
const CREDENTIAL_TOKENS: readonly string[] = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
];

/** The roles of ARIA 1.2 that are not abstract. */
export const ARIA_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "listbox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
  "treeitem",
]);

export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "form",
  "region",
  "dialog",
]);

export const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "heading",
  "cell",
  "columnheader",
  "rowheader",
  "option",
  "tab",
  "menuitem",
  "treeitem",
]);

/** The options of a read_page request, or the sentence that refuses them. */
export function readPageOptions(params: Record<string, unknown>): ReadPageOptions | string {
  const given = ownField(params, "filter");
  const filter = given === undefined ? "all" : given;
  if (filter !== "all" && filter !== "interactive") {
    return "read_page needs filter to be all or interactive.";
  }
  const options: ReadPageOptions = { filter };
  const depth = ownField(params, "depth");
  if (depth !== undefined) {
    if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 1) {
      return "read_page needs depth to be a whole number of 1 or more.";
    }
    options.depth = depth;
  }
  const ref = ownField(params, "ref");
  if (ref !== undefined) {
    if (typeof ref !== "string") return "read_page needs ref to be a string.";
    options.ref = ref;
  }
  return options;
}

/** One line of the tree: `<indent><role> <name> [<ref>] <states>`. */
export function formatLine({ level, role, name, ref, states = {} }: Line): string {
  const parts = [`${"  ".repeat(level)}${role}`];
  if (name !== undefined && clean(name) !== "") parts.push(quote(name));
  if (ref !== undefined) parts.push(`[${ref}]`);
  if (states.checked !== undefined) parts.push(states.checked);
  if (states.selected === true) parts.push("selected");
  if (states.expanded !== undefined) parts.push(`expanded=${states.expanded}`);
  if (states.pressed === true) parts.push("pressed");
  if (states.disabled === true) parts.push("disabled");
  if (states.readonly === true) parts.push("readonly");
  if (states.required === true) parts.push("required");
  if (states.invalid === true) parts.push("invalid");
  if (states.focused === true) parts.push("focused");
  if (states.level !== undefined) parts.push(`level=${states.level}`);
  const field = states.field;
  if (field !== undefined && "protected" in field) {
    parts.push(field.filled ? "protected filled" : "protected");
  } else if (field !== undefined && clean(field.value) !== "") {
    parts.push(`value=${quote(field.value)}`);
  }
  if (states.href !== undefined) parts.push(`href=${quote(states.href)}`);
  if (states.frame === true) parts.push("frame content not read");
  return parts.join(" ");
}

/** A `text` line, or undefined when the text is only whitespace. */
export function textLine(level: number, text: string): string | undefined {
  if (clean(text) === "") return undefined;
  return `${"  ".repeat(level)}text ${quote(text)}`;
}

/**
 * Page text as a JSON string on one line: whitespace collapsed, trimmed and cut to
 * MAX_FIELD_CHARS, ending with `…` when cut, so it can neither end the line nor close the quote.
 */
export function quote(text: string): string {
  const cut = capText(clean(text), MAX_FIELD_CHARS);
  return JSON.stringify(cut.truncated ? `${cut.text}…` : cut.text);
}

function clean(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/** Lines joined by newlines, never longer than `max`, cut only between whole lines. */
export function createTreeText(max: number = READ_PAGE_MAX_CHARS): TreeText {
  const lines: string[] = [];
  let length = 0;
  let full = false;
  let truncated = false;

  return {
    add,
    markCut,
    get full() {
      return full;
    },
    result: () => ({ tree: lines.join("\n"), truncated }),
  };

  function add(line: string): boolean {
    if (full) return false;
    const added = lines.length === 0 ? line.length : line.length + 1;
    if (length + added <= max) {
      lines.push(line);
      length += added;
      return true;
    }
    full = true;
    truncated = true;
    // A single line longer than the whole tree is still worth its start.
    if (lines.length === 0) lines.push(capText(line, max).text);
    return false;
  }

  function markCut(): void {
    const last = lines.length - 1;
    if (full || last < 0) return;
    const mark = " …";
    if (length + mark.length > max) {
      full = true;
      truncated = true;
      return;
    }
    lines[last] += mark;
    length += mark.length;
  }
}

/** Collects text with whitespace collapsed, keeping little more than `max` characters. */
export function createTextBuffer(max: number = MAX_FIELD_CHARS): TextBuffer {
  let text = "";

  return {
    add(piece) {
      if (text.trimStart().length > max) return;
      const collapsed = piece.replace(WHITESPACE, " ");
      text += text.endsWith(" ") && collapsed.startsWith(" ") ? collapsed.slice(1) : collapsed;
      // A single huge text node is not kept whole.
      if (text.length > 2 * max) text = text.trimStart().slice(0, 2 * max);
    },
    get full() {
      return text.trimStart().length > max;
    },
    text: () => text.trim(),
  };
}

/** True when an `autocomplete` value names a password, one-time code or card number field. */
export function isCredentialAutocomplete(value: string | null): boolean {
  if (value === null) return false;
  return value
    .toLowerCase()
    .split(ASCII_WHITESPACE)
    .some((token) => CREDENTIAL_TOKENS.includes(token));
}

/** True for a field whose value read_page never returns. */
export function isProtectedField({
  localName,
  type,
  autocomplete,
  wasPassword,
}: FieldFacts): boolean {
  if (localName === "input" && (type === "password" || wasPassword)) return true;
  return (
    (localName === "input" || localName === "textarea") && isCredentialAutocomplete(autocomplete)
  );
}

/** The first token of a `role` attribute that is an ARIA 1.2 role, lowercased. */
export function explicitRole(attribute: string | null): string | undefined {
  if (attribute === null) return undefined;
  return attribute
    .toLowerCase()
    .split(ASCII_WHITESPACE)
    .find((token) => ARIA_ROLES.has(token));
}
