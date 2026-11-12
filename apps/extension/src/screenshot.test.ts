import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CREDENTIAL_TOKENS } from "./page-tree.ts";
import {
  captureRect,
  FIELD_MASK_CSS,
  FRAME_HIDE_CSS,
  INPUT_MASK_CSS,
  MAX_SCREENSHOT_CHARS,
  MAX_VIEWPORT_SIDE,
  pngData,
  revealedReply,
  screenshotFailed,
} from "./screenshot.ts";

const PREFIX = "data:image/png;base64,";
const PAGE_ERROR = {
  code: "page_error",
  message: "Foxleash could not complete the request in the page in tab 7.",
};
const NOT_VISIBLE = {
  code: "element_not_visible",
  message: "The element has no visible area in tab 7.",
};
const FAILED = {
  code: "screenshot_failed",
  message: "Firefox could not take a screenshot of tab 7.",
};

interface Box {
  rect: { left: number; top: number; width: number; height: number };
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
}

function reply(
  rect: Partial<Box["rect"]> = {},
  viewport: Partial<Box["viewport"]> = {},
  scroll: Partial<Box["scroll"]> = {},
): Box {
  return {
    rect: { left: 10, top: 20, width: 120, height: 80, ...rect },
    viewport: { width: 1280, height: 720, ...viewport },
    scroll: { x: 0, y: 1500, ...scroll },
  };
}

describe("captureRect", () => {
  it("gives a box inside the viewport in page coordinates, with the scroll added", () => {
    assert.deepEqual(captureRect(reply(), 7), {
      rect: { x: 10, y: 1520, width: 120, height: 80 },
    });
    assert.deepEqual(captureRect(reply({}, {}, { x: 300, y: 0 }), 7), {
      rect: { x: 310, y: 20, width: 120, height: 80 },
    });
  });

  it("cuts a box partly outside the viewport to the part inside", () => {
    const cases: [Partial<Box["rect"]>, { x: number; y: number; width: number; height: number }][] =
      [
        [
          { left: -30, top: -10, width: 100, height: 50 },
          { x: 0, y: 1500, width: 70, height: 40 },
        ],
        [
          { left: 1200, top: 700, width: 200, height: 100 },
          { x: 1200, y: 2200, width: 80, height: 20 },
        ],
        [
          { left: -10, top: -10, width: 5000, height: 5000 },
          { x: 0, y: 1500, width: 1280, height: 720 },
        ],
      ];
    for (const [rect, expected] of cases) {
      assert.deepEqual(captureRect(reply(rect), 7), { rect: expected }, JSON.stringify(rect));
    }
  });

  it("refuses a box with no area inside the viewport", () => {
    const cases: Partial<Box["rect"]>[] = [
      { left: 1280 },
      { left: 1500 },
      { top: 720 },
      { top: 900 },
      { left: -120 },
      { left: -200 },
      { top: -80 },
      { top: -300 },
      { width: 0 },
      { height: 0 },
      { left: 0, top: 0, width: 0, height: 0 },
      // Zero-sized at a fraction, which rounding outward would turn into a whole pixel.
      { left: 10.5, width: 0 },
      { top: 20.5, height: 0 },
      // The sum is past the largest number; the box still starts right of the viewport.
      { left: 1e308, width: 1e308 },
    ];
    for (const rect of cases) {
      assert.deepEqual(captureRect(reply(rect), 7), NOT_VISIBLE, JSON.stringify(rect));
    }
  });

  it("rounds fractional edges outward to whole pixels", () => {
    assert.deepEqual(captureRect(reply({ left: 10.4, top: 20.6, width: 100.2, height: 50.1 }), 7), {
      rect: { x: 10, y: 1520, width: 101, height: 51 },
    });
  });

  it("keeps a rounded edge inside a fractional viewport, in whole pixels", () => {
    const viewport = { width: 1280.5, height: 720.5 };
    assert.deepEqual(
      captureRect(reply({ left: 1279.2, width: 1, top: 715.3, height: 10 }, viewport), 7),
      {
        rect: { x: 1279, y: 2215, width: 1, height: 5 },
      },
    );
    assert.deepEqual(captureRect(reply({ left: 1280.2, width: 5 }, viewport), 7), NOT_VISIBLE);
    assert.deepEqual(captureRect(reply({ top: 720.2, height: 5 }, viewport), 7), NOT_VISIBLE);
  });

  it("adds a fractional or negative scroll as it is", () => {
    assert.deepEqual(captureRect(reply({}, {}, { x: 0.5, y: 1500.25 }), 7), {
      rect: { x: 10.5, y: 20 + 1500.25, width: 120, height: 80 },
    });
    assert.deepEqual(captureRect(reply({}, {}, { x: -300, y: -2 }), 7), {
      rect: { x: -290, y: 18, width: 120, height: 80 },
    });
  });

  it("keeps the page coordinates finite at the largest scroll", () => {
    assert.deepEqual(captureRect(reply({}, {}, { x: Number.MAX_VALUE, y: -Number.MAX_VALUE }), 7), {
      rect: { x: Number.MAX_VALUE, y: -Number.MAX_VALUE, width: 120, height: 80 },
    });
  });

  it("takes a viewport side up to MAX_VIEWPORT_SIDE", () => {
    assert.equal(MAX_VIEWPORT_SIDE, 131_072);
    const side = MAX_VIEWPORT_SIDE;
    assert.deepEqual(
      captureRect(
        reply({ left: 0, top: 0, width: side, height: side }, { width: side, height: side }),
        7,
      ),
      { rect: { x: 0, y: 1500, width: side, height: side } },
    );
  });

  it("refuses a reply it cannot read as page_error", () => {
    const valid = reply();
    const bad: unknown[] = [
      undefined,
      null,
      "box",
      5,
      [valid.rect, valid.viewport, valid.scroll],
      {},
      { viewport: valid.viewport, scroll: valid.scroll },
      { rect: valid.rect, scroll: valid.scroll },
      { rect: valid.rect, viewport: valid.viewport },
      { ...valid, rect: [10, 20, 120, 80] },
      { ...valid, viewport: null },
      { ...valid, scroll: "0,0" },
      Object.create(valid),
      { ...valid, rect: Object.create(valid.rect) },
      { ...valid, viewport: Object.create(valid.viewport) },
      { ...valid, scroll: Object.create(valid.scroll) },
    ];
    const fields: [keyof Box, string][] = [
      ["rect", "left"],
      ["rect", "top"],
      ["rect", "width"],
      ["rect", "height"],
      ["viewport", "width"],
      ["viewport", "height"],
      ["scroll", "x"],
      ["scroll", "y"],
    ];
    for (const [part, key] of fields) {
      for (const value of [undefined, "1", null, Number.NaN, Infinity, -Infinity]) {
        bad.push({ ...valid, [part]: { ...valid[part], [key]: value } });
      }
      const rest = Object.fromEntries(Object.entries(valid[part]).filter(([name]) => name !== key));
      bad.push({ ...valid, [part]: rest });
      bad.push({ ...valid, [part]: Object.assign(Object.create({ [key]: 1 }), rest) });
    }
    for (const [part, key] of fields.slice(2, 6)) {
      bad.push({ ...valid, [part]: { ...valid[part], [key]: -1 } });
      bad.push({ ...valid, [part]: { ...valid[part], [key]: -0.5 } });
    }
    bad.push({ ...valid, viewport: { width: MAX_VIEWPORT_SIDE + 1, height: 720 } });
    bad.push({ ...valid, viewport: { width: 1280, height: MAX_VIEWPORT_SIDE + 0.5 } });
    for (const value of bad) {
      assert.deepEqual(captureRect(value, 7), PAGE_ERROR, JSON.stringify(value));
    }
  });
});

describe("the mask style sheets", () => {
  const DECLARATIONS = [
    "color: transparent !important",
    "-webkit-text-fill-color: transparent !important",
    "-webkit-text-stroke-color: transparent !important",
    "text-shadow: none !important",
    "text-emphasis-color: transparent !important",
    "text-decoration-color: transparent !important",
    "caret-color: transparent !important",
    "background-clip: border-box !important",
    "transition: none !important",
  ];

  it("hides password, credential autocomplete and autofilled fields, their selection and old snapshots", () => {
    const fields = [
      'input[type="password" i]',
      ...CREDENTIAL_TOKENS.flatMap((token) => [
        `input[*|autocomplete~="${token}" i]`,
        `textarea[*|autocomplete~="${token}" i]`,
      ]),
      "input:autofill",
      "textarea:autofill",
    ];
    assert.ok(fields.includes('input[*|autocomplete~="cc-number" i]'));
    assert.ok(fields.includes("input:autofill"));
    assert.deepEqual(rulesOf(FIELD_MASK_CSS), [
      { selectors: fields, declarations: DECLARATIONS },
      { selectors: fields.map((field) => `${field}::selection`), declarations: DECLARATIONS },
      {
        selectors: ["::view-transition-old(*)"],
        declarations: ["opacity: 0 !important", "transition: none !important"],
      },
    ]);
  });

  it("hides every input and its selection in the input mask", () => {
    assert.deepEqual(rulesOf(INPUT_MASK_CSS), [
      { selectors: ["input"], declarations: DECLARATIONS },
      { selectors: ["input::selection"], declarations: DECLARATIONS },
    ]);
  });

  it("hides every element that embeds a frame in the frame hiding sheet", () => {
    assert.deepEqual(rulesOf(FRAME_HIDE_CSS), [
      {
        selectors: ["iframe", "frame", "object", "embed", "browser", "editor"],
        declarations: [
          "visibility: hidden !important",
          "opacity: 0 !important",
          "transition: none !important",
        ],
      },
    ]);
  });

  it("marks every declaration important, so the page's own styles cannot win", () => {
    for (const css of [FIELD_MASK_CSS, INPUT_MASK_CSS, FRAME_HIDE_CSS]) {
      for (const { declarations } of rulesOf(css)) {
        assert.ok(declarations.every((declaration) => declaration.endsWith(" !important")));
      }
    }
  });
});

describe("revealedReply", () => {
  it("reads an own boolean revealed field", () => {
    assert.deepEqual(revealedReply({ revealed: true }, 7), { revealed: true });
    assert.deepEqual(revealedReply({ revealed: false }, 7), { revealed: false });
  });

  it("refuses a reply it cannot read as page_error", () => {
    const bad: unknown[] = [
      Object.create({ revealed: true }),
      {},
      { revealed: "true" },
      { revealed: 1 },
      null,
      [],
      "x",
      undefined,
    ];
    for (const value of bad) {
      assert.deepEqual(revealedReply(value, 7), PAGE_ERROR, JSON.stringify(value));
    }
  });
});

describe("pngData", () => {
  it("returns the base64 without the data URL prefix", () => {
    for (const data of ["AAAA", "AAA=", "AA==", "iVBORw0KGgoAAAAN+/8="]) {
      assert.deepEqual(pngData(`${PREFIX}${data}`, 7), { data });
    }
  });

  it("refuses what is not a PNG data URL with exact base64 as screenshot_failed", () => {
    const bad: unknown[] = [
      undefined,
      null,
      5,
      {},
      ["data:image/png;base64,AAAA"],
      "AAAA",
      "data:image/jpeg;base64,/9j/4AAQ",
      "DATA:image/png;base64,AAAA",
      "data:image/png,AAAA",
      ` ${PREFIX}AAAA`,
      PREFIX,
      `${PREFIX}A=`,
      `${PREFIX}AAAAA`,
      `${PREFIX}AAAA====`,
      `${PREFIX}AA=A`,
      `${PREFIX}====`,
      `${PREFIX}AA*A`,
      `${PREFIX}AAAA\n`,
      `${PREFIX}AA-_`,
    ];
    for (const value of bad) {
      assert.deepEqual(pngData(value, 7), FAILED, JSON.stringify(value));
    }
  });

  it("takes a payload of MAX_SCREENSHOT_CHARS characters and refuses one more", () => {
    assert.equal(MAX_SCREENSHOT_CHARS, 48 * 1024 * 1024);
    const fits = `${PREFIX}${"A".repeat(MAX_SCREENSHOT_CHARS)}`;
    const result = pngData(fits, 7);
    assert.ok("data" in result && result.data.length === MAX_SCREENSHOT_CHARS);
    assert.deepEqual(pngData(`${fits}A`, 7), {
      code: "screenshot_too_large",
      message:
        "The screenshot of tab 7 is too large to return; take one of a single element with ref.",
    });
  });

  it("names the tab in a failed capture", () => {
    assert.deepEqual(screenshotFailed(7), FAILED);
  });
});

/** The rules of a mask sheet, one per line: its selectors and its declarations. */
function rulesOf(css: string): { selectors: string[]; declarations: string[] }[] {
  assert.ok(css.endsWith("\n"));
  return css
    .slice(0, -1)
    .split("\n")
    .map((rule) => {
      const match = /^([^{}]+) \{ ([^{}]+); \}$/.exec(rule);
      assert.ok(match !== null, rule);
      return {
        selectors: (match[1] ?? "").split(", "),
        declarations: (match[2] ?? "").split("; "),
      };
    });
}
