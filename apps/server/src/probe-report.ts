import type { ProbeCheck } from "@foxleash/protocol";

export interface ProbeReport {
  date: string;
  foxleash: string;
  userAgent: string | null;
  pages: PageReport[];
}

export type PageReport =
  | { url: string; checks: ProbeCheck[] }
  | { url: string; error: { code: string; message: string } };

// Markdown syntax that could break a table cell or turn page text into markup.
const MARKDOWN = /[\\`*_[\]<>|&~]/g;
// Line breaks, controls, and invisible or display-reordering format characters.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function renderJson(report: ProbeReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: ProbeReport): string {
  const lines = [
    "# Foxleash probe report",
    "",
    `- Date: ${cell(report.date)}`,
    `- Foxleash: ${cell(report.foxleash)}`,
    `- Browser: ${report.userAgent === null ? "unknown" : cell(report.userAgent)}`,
  ];
  for (const page of report.pages) {
    lines.push("", `## ${cell(page.url)}`, "");
    if ("error" in page) {
      lines.push(`Not probed: ${cell(page.error.code)}. ${cell(page.error.message)}`);
      continue;
    }
    lines.push(
      "| Check | Target | Element | Strategy | Outcome | isTrusted-dependent | Detail |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const check of page.checks) lines.push(row(check));
  }
  return `${lines.join("\n")}\n`;
}

function row(check: ProbeCheck): string {
  const cells = [
    cell(check.check),
    cell(check.target),
    check.element === undefined || check.element === "" ? "-" : cell(check.element),
    cell(check.strategy),
    cell(check.outcome),
    check.trustedOnly ? "yes" : "no",
    cell(check.detail),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** Text that stays plain text on one line, inside a table cell or anywhere else. */
function cell(text: string): string {
  return text.replace(UNSAFE, " ").replace(MARKDOWN, "\\$&");
}
