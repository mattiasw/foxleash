import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { run } from "./build-amo.ts";

// Fixtures use record numbers from 9000 up, so a search of the tree for a real record's
// number never finds this file.

const ROOT = path.join(import.meta.dirname, "..");
const SELF = path.relative(ROOT, import.meta.filename);
const README = "docs/adr/README.md";
const MERGED_HEADING = "## Merged records";

const LEADER = String.raw`(?:\*|\/\/|#|>)`;
// Whitespace holding at most one line break, after which a comment leader or indentation may stand.
const GAP = String.raw`[ \t]*(?:\r?\n[ \t]*(?:${LEADER}[ \t]*)?)?`;
const ADR = /\bADRs?\b/g;
const FIRST = new RegExp(String.raw`${GAP}(\d{4})(?!\d)`, "y");
// A hyphen or dash takes no line break before it: one there starts a list bullet.
const RANGE = new RegExp(
  String.raw`(?:[ \t]*[-–—]|${GAP}\b(?:to|through)\b)${GAP}\d{4}(?!\d)`,
  "y",
);
const NEXT = new RegExp(
  String.raw`(?:${GAP},${GAP}(?:(?:and|or)\b${GAP})?|${GAP}(?:and|or)\b${GAP})(\d{4})`,
  "y",
);
// A date or a decimal, or a longer number.
const NOT_COUNTED = /\d|[-.]\d/y;
const RECORD_PATH = /^docs\/adr\/(\d{4})-[^/]+\.md$/;
const LINK = /\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const RECORD_TARGET = /^docs\/adr\/\d{4}/;
const MEASUREMENT_TARGET = /^docs\/measurements\/.*[^/]$/;
const WRITTEN_PATH = /(?<![\w-])docs\/(?:adr\/\d{4}-[\w.-]+|measurements\/[\w.-]+)\.md(?![\w-])/g;
const ROW = /^\|\s*\[(\d{4})\]\(([^)\s]+)\)\s*\|/;
const HOLDER = /\[(\d{4})\]\([^)]*\)/;
const ANY_LINK = /\[[^\]]*\]\([^)]*\)/g;
const NUMBER = /(?<!\d)\d{4}(?!\d)/g;

describe("ADR references", () => {
  const counted: [string, { number: string; line: number }[]][] = [
    ["ADR 9081", [{ number: "9081", line: 1 }]],
    [
      "ADR 9052, 9053",
      [
        { number: "9052", line: 1 },
        { number: "9053", line: 1 },
      ],
    ],
    [
      "ADR 9071, 9073, 9097",
      [
        { number: "9071", line: 1 },
        { number: "9073", line: 1 },
        { number: "9097", line: 1 },
      ],
    ],
    [
      "ADR 9071, 9073, and 9097",
      [
        { number: "9071", line: 1 },
        { number: "9073", line: 1 },
        { number: "9097", line: 1 },
      ],
    ],
    [
      "ADR 9010 and 9026",
      [
        { number: "9010", line: 1 },
        { number: "9026", line: 1 },
      ],
    ],
    [
      "ADR 9010 or 9026",
      [
        { number: "9010", line: 1 },
        { number: "9026", line: 1 },
      ],
    ],
    [
      "ADR 9010, 9011, or 9026",
      [
        { number: "9010", line: 1 },
        { number: "9011", line: 1 },
        { number: "9026", line: 1 },
      ],
    ],
    [
      "ADRs 9081 and 9091",
      [
        { number: "9081", line: 1 },
        { number: "9091", line: 1 },
      ],
    ],
    [
      "the guard (ADR 9063,\n * 9064) says",
      [
        { number: "9063", line: 1 },
        { number: "9064", line: 2 },
      ],
    ],
    ["  // as the record says (ADR\n  // 9100)", [{ number: "9100", line: 2 }]],
    [
      "x\nADR 9073 and\n9097",
      [
        { number: "9073", line: 2 },
        { number: "9097", line: 3 },
      ],
    ],
    ["# ADR\n# 9042", [{ number: "9042", line: 2 }]],
    [
      "> ADR 9043,\n> 9044",
      [
        { number: "9043", line: 1 },
        { number: "9044", line: 2 },
      ],
    ],
    ["- see\n  ADR\n  9045 too", [{ number: "9045", line: 3 }]],
    [
      "ADR 9046,\r\n  9047",
      [
        { number: "9046", line: 1 },
        { number: "9047", line: 2 },
      ],
    ],
    ["[ADR 9101](../adr/9101-x.md)", [{ number: "9101", line: 1 }]],
    ["as in ADR 9010.", [{ number: "9010", line: 1 }]],
    ["ADR 9101, 2026-11-19", [{ number: "9101", line: 1 }]],
    ["ADR 9010, 9011.5", [{ number: "9010", line: 1 }]],
    ["ADR 9010, 90115", [{ number: "9010", line: 1 }]],
    ["ADR 9010 or later", [{ number: "9010", line: 1 }]],
    ["ADR 9010 order 9011", [{ number: "9010", line: 1 }]],
  ];
  for (const [text, numbers] of counted) {
    test(`${JSON.stringify(text)} names ${numbers.map((n) => n.number).join(", ")}`, () => {
      assert.deepEqual(scanReferences(text), { numbers, ranges: [] });
    });
  }

  const refused: [string, { number: string; line: number }[], { text: string; line: number }][] = [
    ["ADR 9089-9094", [], { text: "9089-9094", line: 1 }],
    ["ADR 9089–9094", [], { text: "9089–9094", line: 1 }],
    ["ADR 9089—9094", [], { text: "9089—9094", line: 1 }],
    ["ADR 9089 - 9094", [], { text: "9089 - 9094", line: 1 }],
    ["ADRs 9060 to 9062", [], { text: "9060 to 9062", line: 1 }],
    ["ADR 9060 through 9062", [], { text: "9060 through 9062", line: 1 }],
    ["ADR 9081, 9089-9094", [{ number: "9081", line: 1 }], { text: "9089-9094", line: 1 }],
    ["ADR 9081 and 9089 to 9094", [{ number: "9081", line: 1 }], { text: "9089 to 9094", line: 1 }],
    ["ADR 9089-\n9094", [], { text: "9089-\n9094", line: 1 }],
    ["ADR 9081 to\n * 9094", [], { text: "9081 to\n * 9094", line: 1 }],
  ];
  for (const [text, numbers, range] of refused) {
    test(`${JSON.stringify(text)} is a range`, () => {
      assert.deepEqual(scanReferences(text), { numbers, ranges: [range] });
    });
  }

  for (const text of [
    "a 9700 directory",
    "Write a new ADR\nthat supersedes the old one",
    "ADR 12345",
    "ADR's 9081",
    "ADR\n\n9081",
    "ADR,\n9081",
    "MADR 9081",
  ]) {
    test(`${JSON.stringify(text)} names no record`, () => {
      assert.deepEqual(scanReferences(text), { numbers: [], ranges: [] });
    });
  }

  for (const text of [
    "see ADR 9081\n- 2026-11-19: x",
    "ADR 9081\n- 9094 ms",
    " * ADR 9081\n * - 9094 ms",
  ]) {
    test(`a list bullet after ${JSON.stringify(text.split("\n")[0])} is no range`, () => {
      assert.deepEqual(scanReferences(text), {
        numbers: [{ number: "9081", line: 1 }],
        ranges: [],
      });
    });
  }

  test("finds every reference in a text", () => {
    assert.deepEqual(scanReferences("ADR 9001 and\nADR 9002, then ADR 9003-9004 and ADR 9005"), {
      numbers: [
        { number: "9001", line: 1 },
        { number: "9002", line: 2 },
        { number: "9005", line: 2 },
      ],
      ranges: [{ text: "9003-9004", line: 2 }],
    });
  });

  test("names each number that has no record, with its file and line", () => {
    assert.deepEqual(
      referenceOffenders("docs/x.md", "ADR 9081\nSee ADR 9999.", new Set(["9081"])),
      ["docs/x.md:2: ADR 9999 names no record"],
    );
  });

  test("refuses a range, telling to write the numbers out", () => {
    assert.deepEqual(
      referenceOffenders("docs/x.md", "x\nADR 9089-\n9094", new Set(["9089", "9094"])),
      ['docs/x.md:2: ADR range "9089- 9094": write the numbers out'],
    );
  });
});

describe("links and written-out paths", () => {
  const existing = new Set(["docs/adr/9001-alpha.md", "docs/measurements/live.md"]);

  const clean: [string, string][] = [
    ["docs/adr/9001-alpha.md", "[m](../measurements/live.md)"],
    ["docs/adr/9002-beta.md", "[r](9001-alpha.md#consequences)"],
    ["docs/README.md", "[r](adr/9001-alpha.md#x)"],
    ["docs/README.md", '[r](adr/9001-alpha.md "the record")'],
    ["docs/README.md", "[r](/docs/adr/9001-alpha.md)"],
    ["docs/adr/0000-template.md", "[NNNN](NNNN-....md)"],
    ["README.md", "[records](docs/adr/)"],
    ["docs/security.md", "[records](adr/)"],
    ["docs/security.md", "[records](../adr)"],
    ["docs/security.md", "[measurements](measurements/)"],
    ["docs/measurements/live.md", "[a](https://example.org/gone.md)"],
    ["docs/measurements/live.md", "[a](mailto:someone@example.org)"],
    ["docs/adr/9001-alpha.md", "[a](#section)"],
    ["docs/adr/9001-alpha.md", "[a](../../outside.md)"],
    ["bin/x.ts", "[r](../adr/9999-gone.md)"],
    ["bin/x.ts", "see docs/adr/9001-alpha.md"],
    ["docs/README.md", "copy to docs/adr/NNNN-short-slug.md"],
  ];
  for (const [file, text] of clean) {
    test(`${text} in ${file} passes`, () => {
      assert.deepEqual(linkOffenders(file, text, existing), []);
    });
  }

  const dead: [string, string, string[]][] = [
    [
      "docs/adr/9001-alpha.md",
      "x\n[m](../measurements/missing.md#a)",
      [
        "docs/adr/9001-alpha.md:2: link ../measurements/missing.md#a names no file (docs/measurements/missing.md)",
      ],
    ],
    [
      "docs/adr/9001-alpha.md",
      "![m](../measurements/missing.png)",
      [
        "docs/adr/9001-alpha.md:1: link ../measurements/missing.png names no file (docs/measurements/missing.png)",
      ],
    ],
    [
      "docs/README.md",
      "[r](adr/9999-gone.md)",
      ["docs/README.md:1: link adr/9999-gone.md names no file (docs/adr/9999-gone.md)"],
    ],
    [
      "README.md",
      "[m](docs/measurements/missing.md)",
      [
        "README.md:1: link docs/measurements/missing.md names no file (docs/measurements/missing.md)",
      ],
    ],
    [
      "bin/x.ts",
      "// x\n// see docs/measurements/missing.md",
      ["bin/x.ts:2: docs/measurements/missing.md names no file"],
    ],
    [
      "docs/README.md",
      "Read docs/adr/9999-gone.md first.",
      ["docs/README.md:1: docs/adr/9999-gone.md names no file"],
    ],
    [
      "docs/README.md",
      "[a](adr/9998-a.md) and [b](adr/9999-b.md)",
      [
        "docs/README.md:1: link adr/9998-a.md names no file (docs/adr/9998-a.md)",
        "docs/README.md:1: link adr/9999-b.md names no file (docs/adr/9999-b.md)",
      ],
    ],
  ];
  for (const [file, text, offenders] of dead) {
    test(`${JSON.stringify(text)} in ${file} is dead`, () => {
      assert.deepEqual(linkOffenders(file, text, existing), offenders);
    });
  }
});

describe("the README table", () => {
  const rows =
    "| Record | Decision |\n|---|---|\n| [9001](9001-alpha.md) | A |\n| [9002](9002-beta.md) | B |\n";

  test("passes when every record has its row", () => {
    const records = recordsOf(["docs/adr/9001-alpha.md", "docs/adr/9002-beta.md"]);
    assert.deepEqual(tableOffenders(rows, records), []);
  });

  test("names a record with no row", () => {
    const records = recordsOf([
      "docs/adr/9001-alpha.md",
      "docs/adr/9002-beta.md",
      "docs/adr/9003-gamma.md",
    ]);
    assert.deepEqual(tableOffenders(rows, records), [
      "docs/adr/README.md: docs/adr/9003-gamma.md has no row [9003](9003-gamma.md)",
    ]);
  });

  test("names a record whose row links an older file name", () => {
    const records = recordsOf(["docs/adr/9001-new.md", "docs/adr/9002-beta.md"]);
    assert.deepEqual(tableOffenders(rows, records), [
      "docs/adr/README.md: docs/adr/9001-new.md has no row [9001](9001-new.md)",
    ]);
  });

  test("names a number that two records share", () => {
    const records = recordsOf(["docs/adr/9002-a.md", "docs/adr/9002-b.md"]);
    const table = "| [9002](9002-a.md) | A |\n| [9002](9002-b.md) | B |\n";
    assert.deepEqual(tableOffenders(table, records), [
      "docs/adr: 9002 has more than one record: docs/adr/9002-a.md, docs/adr/9002-b.md",
    ]);
  });

  test("records are the numbered files directly in docs/adr", () => {
    assert.deepEqual(
      recordsOf([
        "docs/adr/0000-template.md",
        "docs/adr/README.md",
        "docs/adr/9001-alpha.md",
        "docs/adr/9002-beta.txt",
        "docs/adr/old/9003-gamma.md",
        "docs/adr/90040-delta.md",
        "x/docs/adr/9005-epsilon.md",
      ]),
      [{ number: "9001", path: "docs/adr/9001-alpha.md", name: "9001-alpha.md" }],
    );
  });
});

describe("merged records", () => {
  // The item, when there is one, starts on line 7.
  const head = `# Records\n\n${MERGED_HEADING}\n\nA record merged into its topic's record is deleted.\n\n`;

  test("a section with no item has no merged numbers", () => {
    assert.deepEqual(mergedItems(head), []);
  });

  test("a README without the section has no items", () => {
    assert.equal(mergedItems("# Records\n\n- [9081](9081-x.md) holds 9089.\n"), undefined);
  });

  test("reads the holder and the merged numbers of an item", () => {
    assert.deepEqual(mergedItems(`${head}- [9081](9081-x.md) holds 9089, 9091 and 9103.\n`), [
      { line: 7, holder: "9081", merged: ["9089", "9091", "9103"] },
    ]);
  });

  test("reads an item wrapped onto an indented line", () => {
    assert.deepEqual(
      mergedItems(
        `${head}- [9081](9081-x.md) holds 9089, 9091,\n  9092 and 9094.\n- [9082](9082-y.md) holds 9095.\n`,
      ),
      [
        { line: 7, holder: "9081", merged: ["9089", "9091", "9092", "9094"] },
        { line: 9, holder: "9082", merged: ["9095"] },
      ],
    );
  });

  test("a line that is not indented ends an item", () => {
    assert.deepEqual(
      mergedItems(`${head}- [9081](9081-x.md) holds 9089.\nNote 9090.\n\n  9091\n`),
      [{ line: 7, holder: "9081", merged: ["9089"] }],
    );
  });

  test("the next heading ends the section", () => {
    assert.deepEqual(
      mergedItems(
        `${head}- [9081](9081-x.md) holds 9089.\n\n## Other\n\n- [9082](9082-y.md) holds 9090.\n`,
      ),
      [{ line: 7, holder: "9081", merged: ["9089"] }],
    );
  });

  test("an item with no link has no holder", () => {
    assert.deepEqual(mergedItems(`${head}- holds 9089 and [a note](x.md).\n`), [
      { line: 7, holder: undefined, merged: ["9089"] },
    ]);
  });

  const records = recordsOf(["docs/adr/9001-a.md", "docs/adr/9002-b.md"]);

  test("passes when every number up to the highest is a record or merged", () => {
    const clean = recordsOf(["docs/adr/9001-a.md", "docs/adr/9002-b.md", "docs/adr/9004-d.md"]);
    assert.deepEqual(mergedOffenders(`${head}- [9001](9001-a.md) holds 9003.\n`, clean, 9001), []);
  });

  test("names a merged number that has a record file", () => {
    assert.deepEqual(mergedOffenders(`${head}- [9001](9001-a.md) holds 9002.\n`, records, 9001), [
      "docs/adr/README.md:7: 9002 is merged but docs/adr/9002-b.md exists",
    ]);
  });

  test("names a number merged twice", () => {
    assert.deepEqual(
      mergedOffenders(
        `${head}- [9001](9001-a.md) holds 9003.\n- [9002](9002-b.md) holds 9004 and 9003.\n`,
        records,
        9001,
      ),
      ["docs/adr/README.md:8: 9003 is merged twice"],
    );
  });

  test("names a number merged twice in one item", () => {
    assert.deepEqual(
      mergedOffenders(`${head}- [9001](9001-a.md) holds 9003 and 9003.\n`, records, 9001),
      ["docs/adr/README.md:7: 9003 is merged twice"],
    );
  });

  test("names a holder that is not a record", () => {
    assert.deepEqual(mergedOffenders(`${head}- [9005](9005-e.md) holds 9003.\n`, records, 9001), [
      "docs/adr/README.md:7: holder 9005 is not a record",
    ]);
  });

  test("names an item with no holder", () => {
    assert.deepEqual(mergedOffenders(`${head}- holds 9003.\n`, records, 9001), [
      "docs/adr/README.md:7: item names no holder",
    ]);
  });

  test("names a number that is neither a record nor merged", () => {
    const gapped = recordsOf(["docs/adr/9001-a.md", "docs/adr/9003-c.md"]);
    assert.deepEqual(mergedOffenders(head, gapped, 9001), [
      "docs/adr/README.md: 9002 is neither a record nor a merged record",
    ]);
  });

  test("a merged number above the highest record extends the range checked", () => {
    assert.deepEqual(mergedOffenders(`${head}- [9001](9001-a.md) holds 9004.\n`, records, 9001), [
      "docs/adr/README.md: 9003 is neither a record nor a merged record",
    ]);
  });

  test("checks from the lower bound", () => {
    assert.deepEqual(mergedOffenders(head, recordsOf(["docs/adr/9002-b.md"]), 9001), [
      "docs/adr/README.md: 9001 is neither a record nor a merged record",
    ]);
  });

  test("checks from 0001 by default", () => {
    assert.equal(mergedOffenders(head, recordsOf(["docs/adr/9001-a.md"])).length, 9000);
  });

  test("with no record and nothing merged there is nothing to check", () => {
    assert.deepEqual(mergedOffenders(head, []), []);
  });

  test("names a README without the section", () => {
    assert.deepEqual(mergedOffenders("# Records\n", records, 9001), [
      'docs/adr/README.md: no "## Merged records" section',
    ]);
  });
});

describe("an empty scan", () => {
  test("names each count that is zero", () => {
    assert.deepEqual(emptyScanOffenders({ files: 0, records: 0, references: 0 }), [
      "no tracked files found",
      "no records found",
      "no ADR references found",
    ]);
  });

  test("passes when something was found", () => {
    assert.deepEqual(emptyScanOffenders({ files: 1, records: 1, references: 1 }), []);
  });
});

describe("the tracked tree", () => {
  const tree = readTree();
  const records = recordsOf([...tree.existing]);
  const recordNumbers = new Set(records.map((record) => record.number));
  const readme = tree.texts.get(README) ?? "";

  test("every ADR reference names a record", () => {
    const offenders = [...tree.texts].flatMap(([file, text]) =>
      referenceOffenders(file, text, recordNumbers),
    );
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test("every link and written-out path into docs/adr and docs/measurements names a file", () => {
    const offenders = [...tree.texts].flatMap(([file, text]) =>
      linkOffenders(file, text, tree.existing),
    );
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test("every record has a row in the README table and its own number", () => {
    const offenders = tableOffenders(readme, records);
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test("no merged number is used again or goes missing", () => {
    const offenders = mergedOffenders(readme, records);
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test("the scan found files, records and references", () => {
    const references = [...tree.texts.values()].reduce(
      (sum, text) => sum + scanReferences(text).numbers.length,
      0,
    );
    const offenders = emptyScanOffenders({
      files: tree.files.length,
      records: records.length,
      references,
    });
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });
});

type Reference = { number: string; line: number };
type Range = { text: string; line: number };
type AdrRecord = { number: string; path: string; name: string };
type MergedItem = { line: number; holder: string | undefined; merged: string[] };

/** The tracked files, those of them on disk, and the text of each but this file. */
function readTree(): { files: string[]; existing: Set<string>; texts: Map<string, string> } {
  const files = run("git", ["ls-files", "-z"], ROOT)
    .split("\0")
    .filter((file) => file !== "");
  const existing = new Set(
    files.filter(
      (file) => statSync(path.join(ROOT, file), { throwIfNoEntry: false })?.isFile() ?? false,
    ),
  );
  const texts = new Map<string, string>();
  for (const file of existing) {
    if (file !== SELF) texts.set(file, readFileSync(path.join(ROOT, file), "utf8"));
  }
  return { files, existing, texts };
}

function recordsOf(paths: Iterable<string>): AdrRecord[] {
  const records: AdrRecord[] = [];
  for (const file of paths) {
    const number = RECORD_PATH.exec(file)?.[1];
    if (number !== undefined && number !== "0000") {
      records.push({ number, path: file, name: path.posix.basename(file) });
    }
  }
  return records;
}

function referenceOffenders(
  file: string,
  text: string,
  recordNumbers: ReadonlySet<string>,
): string[] {
  const { numbers, ranges } = scanReferences(text);
  return [
    ...numbers
      .filter((reference) => !recordNumbers.has(reference.number))
      .map((reference) => `${file}:${reference.line}: ADR ${reference.number} names no record`),
    ...ranges.map(
      (range) =>
        `${file}:${range.line}: ADR range "${range.text.replace(/\s+/g, " ")}": write the numbers out`,
    ),
  ];
}

/**
 * The numbers each `ADR`/`ADRs` reference names, and the ranges it writes. A range is refused
 * at any position of a list, so it can never hide a number.
 */
function scanReferences(text: string): { numbers: Reference[]; ranges: Range[] } {
  const numbers: Reference[] = [];
  const ranges: Range[] = [];
  for (const adr of text.matchAll(ADR)) {
    FIRST.lastIndex = adr.index + adr[0].length;
    const first = FIRST.exec(text);
    if (first === null) continue;
    let end = FIRST.lastIndex;
    let token = first[1] ?? "";
    let isFirst = true;
    for (;;) {
      const start = end - token.length;
      RANGE.lastIndex = end;
      if (RANGE.test(text)) {
        ranges.push({ text: text.slice(start, RANGE.lastIndex), line: lineOf(text, start) });
        break;
      }
      NOT_COUNTED.lastIndex = end;
      if (!isFirst && NOT_COUNTED.test(text)) break;
      numbers.push({ number: token, line: lineOf(text, start) });
      NEXT.lastIndex = end;
      const next = NEXT.exec(text);
      if (next === null) break;
      end = NEXT.lastIndex;
      token = next[1] ?? "";
      isFirst = false;
    }
  }
  return { numbers, ranges };
}

/**
 * Relative links in a Markdown file, and written-out paths in any file, that point into
 * docs/adr or docs/measurements at a file that does not exist.
 */
function linkOffenders(file: string, text: string, existing: ReadonlySet<string>): string[] {
  const offenders = new Map<string, string>();
  if (file.endsWith(".md")) {
    for (const link of text.matchAll(LINK)) {
      const target = link[1] ?? "";
      const bare = target.split(/[#?]/)[0] ?? "";
      if (bare === "" || SCHEME.test(bare)) continue;
      const resolved = bare.startsWith("/")
        ? bare.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), bare));
      if (!RECORD_TARGET.test(resolved) && !MEASUREMENT_TARGET.test(resolved)) continue;
      if (existing.has(resolved)) continue;
      const line = lineOf(text, link.index);
      offenders.set(
        `${line}:${resolved}`,
        `${file}:${line}: link ${target} names no file (${resolved})`,
      );
    }
  }
  for (const written of text.matchAll(WRITTEN_PATH)) {
    if (existing.has(written[0])) continue;
    const line = lineOf(text, written.index);
    const key = `${line}:${written[0]}`;
    if (!offenders.has(key)) offenders.set(key, `${file}:${line}: ${written[0]} names no file`);
  }
  return [...offenders.values()];
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) {
    line += 1;
  }
  return line;
}

/** Records with no row of their own in the README table, and numbers two records share. */
function tableOffenders(readme: string, records: readonly AdrRecord[]): string[] {
  const rows = new Set<string>();
  for (const line of readme.split(/\r?\n/)) {
    const row = ROW.exec(line);
    if (row !== null) rows.add(`${row[1]} ${row[2]}`);
  }
  const offenders = records
    .filter((record) => !rows.has(`${record.number} ${record.name}`))
    .map((record) => `${README}: ${record.path} has no row [${record.number}](${record.name})`);
  const byNumber = Map.groupBy(records, (record) => record.number);
  for (const [number, sharing] of byNumber) {
    if (sharing.length > 1) {
      offenders.push(
        `docs/adr: ${number} has more than one record: ${sharing.map((record) => record.path).join(", ")}`,
      );
    }
  }
  return offenders;
}

/**
 * Merged numbers that a record has or that are merged twice, holders that are not records,
 * and numbers from `first` up to the highest known number that are neither a record nor merged.
 */
function mergedOffenders(readme: string, records: readonly AdrRecord[], first = 1): string[] {
  const items = mergedItems(readme);
  if (items === undefined) return [`${README}: no "${MERGED_HEADING}" section`];
  const byNumber = new Map(records.map((record) => [record.number, record]));
  const offenders: string[] = [];
  const merged = new Set<string>();
  for (const item of items) {
    const at = `${README}:${item.line}`;
    if (item.holder === undefined) offenders.push(`${at}: item names no holder`);
    else if (!byNumber.has(item.holder))
      offenders.push(`${at}: holder ${item.holder} is not a record`);
    for (const number of item.merged) {
      const record = byNumber.get(number);
      if (record !== undefined)
        offenders.push(`${at}: ${number} is merged but ${record.path} exists`);
      if (merged.has(number)) offenders.push(`${at}: ${number} is merged twice`);
      merged.add(number);
    }
  }
  const highest = Math.max(0, ...[...byNumber.keys(), ...merged].map(Number));
  for (let n = first; n <= highest; n += 1) {
    const number = String(n).padStart(4, "0");
    if (!byNumber.has(number) && !merged.has(number)) {
      offenders.push(`${README}: ${number} is neither a record nor a merged record`);
    }
  }
  return offenders;
}

/**
 * The list items of the README's merged-records section, an item's indented continuation lines
 * joined to it, or undefined when the section is missing.
 */
function mergedItems(readme: string): MergedItem[] | undefined {
  const lines = readme.split(/\r?\n/);
  const heading = lines.indexOf(MERGED_HEADING);
  if (heading === -1) return undefined;
  const items: { line: number; text: string }[] = [];
  let current: { line: number; text: string } | undefined;
  for (let i = heading + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) {
      current = { line: i + 1, text: line };
      items.push(current);
    } else if (current !== undefined && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`;
    } else {
      current = undefined;
    }
  }
  return items.map((item) => ({
    line: item.line,
    holder: HOLDER.exec(item.text)?.[1],
    merged: item.text.replace(ANY_LINK, "").match(NUMBER) ?? [],
  }));
}

function emptyScanOffenders(counts: {
  files: number;
  records: number;
  references: number;
}): string[] {
  const offenders: string[] = [];
  if (counts.files === 0) offenders.push("no tracked files found");
  if (counts.records === 0) offenders.push("no records found");
  if (counts.references === 0) offenders.push("no ADR references found");
  return offenders;
}
