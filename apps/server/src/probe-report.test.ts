import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeCheck } from "@foxleash/protocol";
import { type ProbeReport, renderJson, renderMarkdown } from "./probe-report.ts";

const CHECK: ProbeCheck = {
  check: "tab_focus",
  target: "probe",
  element: "input type=text",
  strategy: "tab_keydown",
  outcome: "no_effect",
  delivered: true,
  trustedOnly: true,
  detail: "focus did not move",
};

const REPORT: ProbeReport = {
  date: "2026-10-19T08:30:00.000Z",
  foxleash: "0.1.0",
  pages: [
    {
      url: "https://a.example/",
      checks: [
        CHECK,
        {
          check: "type_rich_editor",
          target: "site",
          strategy: "none",
          outcome: "no_target",
          delivered: false,
          trustedOnly: false,
          detail: "no known rich editor",
        },
      ],
    },
    {
      url: "https://bank.example/",
      error: { code: "site_blocked", message: "Foxleash does not act on https://bank.example." },
    },
  ],
};

describe("renderMarkdown", () => {
  it("renders the header, a table per probed page and a line per refused page", () => {
    assert.equal(
      renderMarkdown(REPORT),
      [
        "# Foxleash probe report",
        "",
        "- Date: 2026-10-19T08:30:00.000Z",
        "- Foxleash: 0.1.0",
        "",
        "## https://a.example/",
        "",
        "| Check | Target | Element | Strategy | Outcome | isTrusted-dependent | Detail |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| tab\\_focus | probe | input type=text | tab\\_keydown | no\\_effect | yes | focus did not move |",
        "| type\\_rich\\_editor | site | - | none | no\\_target | no | no known rich editor |",
        "",
        "## https://bank.example/",
        "",
        "Not probed: site\\_blocked. Foxleash does not act on https://bank.example.",
        "",
      ].join("\n"),
    );
  });

  it("ends with the header when there is no page", () => {
    const markdown = renderMarkdown({ ...REPORT, pages: [] });
    assert.ok(markdown.endsWith("- Foxleash: 0.1.0\n"), markdown);
  });

  it("renders an empty element as a dash", () => {
    const markdown = renderMarkdown({
      ...REPORT,
      pages: [{ url: "https://a.example/", checks: [{ ...CHECK, element: "" }] }],
    });
    assert.ok(markdown.includes("| tab\\_focus | probe | - | tab\\_keydown |"), markdown);
  });

  const HOSTILE = "a|b`c<d>e&f[g]h*i_j~k\\l\nm\rn o‮p\u0000q";
  const ESCAPED = "a\\|b\\`c\\<d\\>e\\&f\\[g\\]h\\*i\\_j\\~k\\\\l m n o p q";

  it("escapes Markdown and turns line breaks and controls into spaces in a cell", () => {
    const markdown = renderMarkdown({
      ...REPORT,
      pages: [
        {
          url: "https://a.example/",
          checks: [
            {
              ...CHECK,
              element: HOSTILE,
              strategy: HOSTILE,
              detail: HOSTILE,
            },
          ],
        },
      ],
    });
    assert.ok(
      markdown.includes(
        `| tab\\_focus | probe | ${ESCAPED} | ${ESCAPED} | no\\_effect | yes | ${ESCAPED} |\n`,
      ),
      markdown,
    );
  });

  it("escapes a URL heading and a refusal", () => {
    const markdown = renderMarkdown({
      ...REPORT,
      date: HOSTILE,
      foxleash: HOSTILE,
      pages: [{ url: HOSTILE, error: { code: HOSTILE, message: HOSTILE } }],
    });
    assert.ok(markdown.includes(`- Date: ${ESCAPED}\n- Foxleash: ${ESCAPED}\n`), markdown);
    assert.ok(markdown.includes(`\n## ${ESCAPED}\n`), markdown);
    assert.ok(markdown.includes(`\nNot probed: ${ESCAPED}. ${ESCAPED}\n`), markdown);
  });

  it("keeps every table row on one line", () => {
    const markdown = renderMarkdown({
      ...REPORT,
      pages: [{ url: "https://a.example/", checks: [{ ...CHECK, detail: "x\ny\r\nz" }] }],
    });
    const rows = markdown.split("\n").filter((line) => line.startsWith("| tab"));
    assert.deepEqual(rows, [
      "| tab\\_focus | probe | input type=text | tab\\_keydown | no\\_effect | yes | x y  z |",
    ]);
  });
});

describe("renderJson", () => {
  it("round-trips the report, pretty-printed with a final newline", () => {
    const json = renderJson(REPORT);
    assert.deepEqual(JSON.parse(json), REPORT);
    assert.equal(json, `${JSON.stringify(REPORT, null, 2)}\n`);
  });
});
