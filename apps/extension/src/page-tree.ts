import { type FoundLines, READ_PAGE_MAX_CHARS, READ_PAGE_MAX_MATCHES } from "@foxleash/protocol";
import { capText, ownField } from "./page-messages.ts";
import { siteOf } from "./site.ts";

export { READ_PAGE_MAX_CHARS };

/** The longest name, value, href or text a line holds, before quoting and the cut mark. */
export const MAX_FIELD_CHARS = 200;

export type ReadPageOptions = {
  filter: "all" | "interactive";
  depth?: number;
  ref?: string;
  find?: string;
  role?: string;
};

/** The states a line can carry; only `value` and `href` hold page text. */
export interface LineStates {
  /** An <input type="file">: upload_file sets its files. */
  file?: true;
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

export interface TreeLines {
  /** Takes a line; false when it was not placed, and the walker skips what the element contains. */
  add(line: Line): boolean;
  /** Ends the last line given with ` …`, as TreeText's markCut does. */
  markCut(): void;
  /** True once the walk may stop. */
  readonly full: boolean;
  result(): { tree: string; truncated: boolean; found?: FoundLines };
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
  /** The field was a password field at the start of a page request in this document. */
  wasPassword: boolean;
  /** The field matches `:autofill`: Firefox filled it and it was not edited since. */
  autofilled: boolean;
}

// NEL is not \s, and some tools split lines on it.
export const WHITESPACE = /[\s\u0085]+/g;
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;
export const CREDENTIAL_TOKENS: readonly string[] = [
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
  const find = ownField(params, "find");
  if (find !== undefined) {
    if (typeof find !== "string" || clean(find) === "") {
      return "read_page needs find to be text that is not only spaces.";
    }
    options.find = find;
  }
  const role = ownField(params, "role");
  if (role !== undefined) {
    if (typeof role !== "string" || clean(role) === "") {
      return "read_page needs role to be a role name, such as link or heading.";
    }
    if (options.find === undefined) return "read_page takes role only together with find.";
    options.role = role;
  }
  return options;
}

/** One line of the tree: `<indent><role> <name> [<ref>] <states>`, one space per level. */
export function formatLine({ level, role, name, ref, states = {} }: Line): string {
  const parts = [`${" ".repeat(level)}${role}`];
  if (name !== undefined && clean(name) !== "") parts.push(quote(name));
  if (ref !== undefined) parts.push(`[${ref}]`);
  if (states.file === true) parts.push("file field");
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
export function textLine(level: number, text: string): Line | undefined {
  if (clean(text) === "") return undefined;
  return { level, role: "text", name: text };
}

/**
 * The address a link line shows: the part after the origin for a link to the page's own origin,
 * which navigate takes on that site, else the whole address. The rest after the origin keeps a
 * bare `?` or `#`, which `pathname + search + hash` would drop.
 */
export function linkAddress(href: string, pageUrl: string): string {
  const parsed = URL.parse(href);
  const page = URL.parse(pageUrl);
  if (
    parsed === null ||
    page === null ||
    siteOf(href) === undefined ||
    // A blob: page has its creator's origin, but navigate takes a path only on a web page.
    siteOf(pageUrl) === undefined ||
    // As written: a site with a trailing dot is the same site, but not the same origin.
    parsed.origin !== page.origin ||
    // A path cannot carry a user name or password.
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return href;
  }
  const path = parsed.href.slice(parsed.origin.length);
  // `//host/x` reads as an address on another site.
  return path.startsWith("//") ? href : path;
}

/**
 * Page text as a JSON string on one line: whitespace collapsed, trimmed and cut to
 * MAX_FIELD_CHARS, ending with `…` when cut, so it can neither end the line nor close the quote.
 */
export function quote(text: string): string {
  return JSON.stringify(shownText(text));
}

/** What a line shows of page text between its quotes, before escaping. */
export function shownText(text: string): string {
  const cut = capText(clean(text), MAX_FIELD_CHARS);
  return cut.truncated ? `${cut.text}…` : cut.text;
}

export function clean(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/** The lines of a full read, formatted into a TreeText. */
export function createTreeLines(max: number = READ_PAGE_MAX_CHARS): TreeLines {
  const text = createTreeText(max);
  return {
    add: (line) => text.add(formatLine(line)),
    markCut: () => text.markCut(),
    get full() {
      return text.full;
    },
    result: () => text.result(),
  };
}

/**
 * The lines of a read with find: each of the first READ_PAGE_MAX_MATCHES matching lines after its
 * ancestor lines, each line written once. Takes every line, so the walk reaches the end of the
 * page and the counts cover all of it.
 */
export function createLineFinder(
  find: string,
  role: string | undefined,
  max: number = READ_PAGE_MAX_CHARS,
): TreeLines {
  const query = caseless(clean(find));
  const wanted = role === undefined ? undefined : clean(role).toLowerCase();
  const text = createTreeText(max);
  // The ancestor chain of the last line given, outermost first, ending with that line.
  const chain: { line: Line; written: boolean; cut: boolean }[] = [];
  let shown = 0;
  let matches = 0;
  let searched = 0;

  return {
    add,
    markCut,
    full: false,
    result: () => ({ ...text.result(), found: { shown, matches, searched } }),
  };

  function add(line: Line): boolean {
    while ((chain.at(-1)?.line.level ?? -1) >= line.level) chain.pop();
    const entry = { line, written: false, cut: false };
    chain.push(entry);
    searched += 1;
    if (!lineMatches(line, query, wanted)) return true;
    matches += 1;
    if (matches > READ_PAGE_MAX_MATCHES || text.full) return true;
    for (const each of chain) {
      if (each.written) continue;
      each.written = text.add(each.cut ? `${formatLine(each.line)} …` : formatLine(each.line));
      if (!each.written) break;
    }
    if (entry.written) shown += 1;
    return true;
  }

  function markCut(): void {
    const last = chain.at(-1);
    if (last === undefined) return;
    if (last.written) text.markCut();
    else last.cut = true;
  }
}

/**
 * Whether the text the line shows as its name, unprotected field value or link address contains
 * `query`, and the line has `role` when one is given. Role words, states and refs never match.
 */
function lineMatches(line: Line, query: string, role: string | undefined): boolean {
  if (role !== undefined && line.role !== role) return false;
  const field = line.states?.field;
  const value = field === undefined || "protected" in field ? undefined : field.value;
  return [line.name, value, line.states?.href].some(
    (text) => text !== undefined && caseless(shownText(text)).includes(query),
  );
}

/** Text in lower case, with a final sigma as any other, since lowering it depends on what follows. */
function caseless(text: string): string {
  return text.toLowerCase().replaceAll("ς", "σ");
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
  autofilled,
}: FieldFacts): boolean {
  if (localName === "input" && (type === "password" || wasPassword)) return true;
  return (
    (localName === "input" || localName === "textarea") &&
    (autofilled || isCredentialAutocomplete(autocomplete))
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
