import {
  DEFAULT_PAGE_TEXT_CHARS,
  MAX_PAGE_TEXT_CHARS,
  type PageText,
  type PageTextSource,
} from "@foxleash/protocol";
import { capText, isRecord, ownField } from "./page-messages.ts";

const SOURCES: readonly unknown[] = [
  "main",
  "role_main",
  "article",
  "largest_block",
  "body",
] satisfies PageTextSource[];

/** The parsed options of a get_page_text request. */
export type PageTextOptions = { maxChars: number; offset: number };

/** The options of a get_page_text request, or the sentence that refuses them. */
export function pageTextOptions(params: Record<string, unknown>): PageTextOptions | string {
  const given = ownField(params, "maxChars");
  const maxChars = given === undefined ? DEFAULT_PAGE_TEXT_CHARS : given;
  if (
    typeof maxChars !== "number" ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > MAX_PAGE_TEXT_CHARS
  ) {
    return `get_page_text needs maxChars to be a whole number from 1 to ${MAX_PAGE_TEXT_CHARS}.`;
  }
  const offset = ownField(params, "offset");
  if (offset === undefined) return { maxChars, offset: 0 };
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    return "get_page_text needs offset to be a whole number of 0 or more.";
  }
  return { maxChars, offset };
}

/**
 * The content script's reply as page text, cut to `maxChars` again, or undefined when it is not
 * one: the reply comes from the page's content process, so only own fields of exact types count.
 * `nextOffset` is computed from the request's offset, never read from the reply.
 */
export function pageTextOf(value: unknown, options: PageTextOptions): PageText | undefined {
  if (!isRecord(value)) return undefined;
  const source = ownField(value, "source");
  const main = ownField(value, "main");
  const rest = ownField(value, "rest");
  const truncated = ownField(value, "truncated");
  const totalChars = ownField(value, "totalChars");
  if (
    !isSource(source) ||
    typeof main !== "string" ||
    typeof rest !== "string" ||
    typeof truncated !== "boolean" ||
    typeof totalChars !== "number" ||
    !Number.isSafeInteger(totalChars) ||
    totalChars < 0
  ) {
    return undefined;
  }
  const cut = cutWindow(main, rest, 0, options.maxChars);
  const text = {
    source,
    main: cut.main,
    rest: cut.rest,
    truncated: truncated || cut.truncated,
    totalChars,
  };
  if (!text.truncated) return text;
  const nextOffset = options.offset + cut.end;
  if (!Number.isSafeInteger(nextOffset)) return undefined;
  return { ...text, nextOffset };
}

/** The window of main and rest, tidied, that the options select. */
export function composePageText(
  source: PageTextSource,
  main: string,
  rest: string,
  options: PageTextOptions,
): PageText {
  const cut = cutWindow(tidyText(main), tidyText(rest), options.offset, options.maxChars);
  const text = {
    source,
    main: cut.main,
    rest: cut.rest,
    truncated: cut.truncated,
    totalChars: cut.total,
  };
  return cut.truncated ? { ...text, nextOffset: cut.end } : text;
}

/**
 * Line ends made `\n`, trailing whitespace dropped from each line, blank runs collapsed to one
 * blank line, the whole trimmed. Linear time: a page controls this input.
 */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSource(value: unknown): value is PageTextSource {
  return SOURCES.includes(value);
}

/**
 * Positions [offset, offset + maxChars) of main followed by rest, and the position the window
 * ends at. A cut main leaves no budget for the rest, so a cut-off main is never followed by more
 * text.
 */
function cutWindow(
  main: string,
  rest: string,
  offset: number,
  maxChars: number,
): { main: string; rest: string; truncated: boolean; total: number; end: number } {
  const m = capText(main.slice(offset), maxChars);
  const r = capText(
    rest.slice(Math.max(0, offset - main.length)),
    m.truncated ? 0 : maxChars - m.text.length,
  );
  const total = main.length + rest.length;
  const end = offset + m.text.length + r.text.length;
  return { main: m.text, rest: r.text, truncated: end < total, total, end };
}
