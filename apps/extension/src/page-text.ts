import {
  DEFAULT_PAGE_TEXT_CHARS,
  MAX_PAGE_TEXT_CHARS,
  type PageText,
  type PageTextSource,
} from "@foxhand/protocol";
import { capText, isRecord, ownField } from "./page-messages.ts";

const SOURCES: readonly unknown[] = [
  "main",
  "role_main",
  "article",
  "largest_block",
  "body",
] satisfies PageTextSource[];

/** The options of a get_page_text request, or the sentence that refuses them. */
export function pageTextOptions(params: Record<string, unknown>): { maxChars: number } | string {
  const maxChars = ownField(params, "maxChars");
  if (maxChars === undefined) return { maxChars: DEFAULT_PAGE_TEXT_CHARS };
  if (
    typeof maxChars !== "number" ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > MAX_PAGE_TEXT_CHARS
  ) {
    return `get_page_text needs maxChars to be a whole number from 1 to ${MAX_PAGE_TEXT_CHARS}.`;
  }
  return { maxChars };
}

/**
 * The content script's reply as page text, cut to `maxChars` again, or undefined when it is not
 * one: the reply comes from the page's content process, so only own fields of exact types count.
 */
export function pageTextOf(value: unknown, maxChars: number): PageText | undefined {
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
  const cut = cutToBudget(main, rest, maxChars);
  return {
    source,
    main: cut.main,
    rest: cut.rest,
    truncated: truncated || cut.truncated,
    totalChars,
  };
}

/** Main and rest tidied and cut to one budget, main first. */
export function composePageText(
  source: PageTextSource,
  main: string,
  rest: string,
  maxChars: number,
): PageText {
  const cut = cutToBudget(tidyText(main), tidyText(rest), maxChars);
  return {
    source,
    main: cut.main,
    rest: cut.rest,
    truncated: cut.truncated,
    totalChars: cut.total,
  };
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

/** A cut main leaves no budget for the rest, so a cut-off main is never followed by more text. */
function cutToBudget(
  main: string,
  rest: string,
  maxChars: number,
): { main: string; rest: string; truncated: boolean; total: number } {
  const m = capText(main, maxChars);
  const r = capText(rest, m.truncated ? 0 : maxChars - m.text.length);
  return {
    main: m.text,
    rest: r.text,
    truncated: m.truncated || r.truncated,
    total: m.total + r.total,
  };
}
