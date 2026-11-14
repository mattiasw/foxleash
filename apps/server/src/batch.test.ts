import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type BatchTool, MAX_BATCH_STEPS, NOTE_ALLOWANCE, runBatch } from "./batch.ts";

interface Extra {
  signal: AbortSignal;
}

type Item = CallToolResult["content"][number];

const MAX_BYTES = 64 * 1024;
const IMAGE: Item = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("runBatch", () => {
  it("allows twenty steps", () => {
    assert.equal(MAX_BATCH_STEPS, 20);
  });

  it("runs every step in order and returns each header and result unchanged", async () => {
    const { tools, calls } = registry({
      one: { shape: { n: z.number() }, result: { content: [textItem("one")] } },
      two: {
        shape: { s: z.string(), flag: z.boolean().optional() },
        result: { content: [textItem("note"), IMAGE] },
      },
    });
    const result = await runBatch(
      [
        { tool: "one", args: { n: 1, dropped: true } },
        { tool: "two", args: { s: "a" } },
        { tool: "one", args: { n: 2 } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 3, one: ok"),
        textItem("one"),
        textItem("Step 2 of 3, two: ok"),
        textItem("note"),
        IMAGE,
        textItem("Step 3 of 3, one: ok"),
        textItem("one"),
      ],
    });
    assert.equal(Object.hasOwn(result, "isError"), false);
    assert.deepEqual(calls, [
      { tool: "one", args: { n: 1 } },
      { tool: "two", args: { s: "a" } },
      { tool: "one", args: { n: 2 } },
    ]);
  });

  it("passes the request's extra to each step", async () => {
    const seen: Extra[] = [];
    const tools = new Map<string, BatchTool<Extra>>([
      [
        "one",
        {
          shape: {},
          callback(_args, given) {
            seen.push(given);
            return { content: [] };
          },
        },
      ],
    ]);
    const given = extra();
    await runBatch([{ tool: "one" }, { tool: "one" }], tools, given, MAX_BYTES);
    assert.deepEqual(seen.length, 2);
    assert.ok(seen.every((each) => each === given));
  });

  it("stops at the first failed step and names the one step not run", async () => {
    const { tools, calls } = registry({
      ok: { shape: {}, result: { content: [textItem("fine")] } },
      bad: { shape: {}, result: { content: [textItem("broken")], isError: true } },
    });
    const result = await runBatch(
      [{ tool: "ok" }, { tool: "bad" }, { tool: "ok" }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 3, ok: ok"),
        textItem("fine"),
        textItem("Step 2 of 3, bad: failed"),
        textItem("broken"),
        textItem("Step 3 (ok) was not run because step 2 failed."),
      ],
      isError: true,
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["ok", "bad"],
    );
  });

  it("names every step not run after a failure", async () => {
    const { tools, calls } = registry({
      ok: { shape: {}, result: { content: [textItem("fine")] } },
      other: { shape: {}, result: { content: [textItem("fine too")] } },
      bad: { shape: {}, result: { content: [textItem("broken")], isError: true } },
    });
    const result = await runBatch(
      [{ tool: "bad" }, { tool: "ok" }, { tool: "other" }, { tool: "ok" }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 4, bad: failed"),
        textItem("broken"),
        textItem("Steps 2 to 4 (ok, other, ok) were not run because step 1 failed."),
      ],
      isError: true,
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["bad"],
    );
  });

  it("adds no note when the last step fails", async () => {
    const { tools } = registry({
      ok: { shape: {}, result: { content: [textItem("fine")] } },
      bad: { shape: {}, result: { content: [textItem("broken")], isError: true } },
    });
    const result = await runBatch([{ tool: "ok" }, { tool: "bad" }], tools, extra(), MAX_BYTES);
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 2, ok: ok"),
        textItem("fine"),
        textItem("Step 2 of 2, bad: failed"),
        textItem("broken"),
      ],
      isError: true,
    });
  });

  it("fails a step whose own check says its result failed", async () => {
    const { tools, calls } = registry({
      checked: {
        shape: { fail: z.boolean() },
        result: (args) => ({ content: [textItem(`fail ${String(args.fail)}`)] }),
        failed: (result) =>
          result.content[0]?.type === "text" && result.content[0].text === "fail true",
      },
      after: { shape: {}, result: { content: [textItem("after")] } },
    });
    const passing = await runBatch(
      [{ tool: "checked", args: { fail: false } }, { tool: "after" }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(passing, {
      content: [
        textItem("Step 1 of 2, checked: ok"),
        textItem("fail false"),
        textItem("Step 2 of 2, after: ok"),
        textItem("after"),
      ],
    });
    calls.length = 0;
    const failing = await runBatch(
      [{ tool: "checked", args: { fail: true } }, { tool: "after" }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(failing, {
      content: [
        textItem("Step 1 of 2, checked: failed"),
        textItem("fail true"),
        textItem("Step 2 (after) was not run because step 1 failed."),
      ],
      isError: true,
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["checked"],
    );
  });

  it("does not ask a step's own check about a result that already failed", async () => {
    let asked = 0;
    const { tools } = registry({
      bad: {
        shape: {},
        result: { content: [textItem("broken")], isError: true },
        failed: () => {
          asked += 1;
          return false;
        },
      },
    });
    const result = await runBatch([{ tool: "bad" }], tools, extra(), MAX_BYTES);
    assert.equal(result.isError, true);
    assert.equal(asked, 0);
  });

  it("fails a step that throws, with the error's message", async () => {
    const { tools, calls } = registry({
      throws: {
        shape: {},
        result: () => {
          throw new TypeError("boom");
        },
      },
      after: { shape: {}, result: { content: [textItem("after")] } },
    });
    const result = await runBatch(
      [{ tool: "throws" }, { tool: "after" }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 2, throws: failed"),
        textItem("boom"),
        textItem("Step 2 (after) was not run because step 1 failed."),
      ],
      isError: true,
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["throws"],
    );
  });

  it("fails a step that rejects with a value that is not an Error", async () => {
    const tools = new Map<string, BatchTool<Extra>>([
      [
        "rejects",
        {
          shape: {},
          callback() {
            return Promise.reject(42);
          },
        },
      ],
    ]);
    const result = await runBatch([{ tool: "rejects" }], tools, extra(), MAX_BYTES);
    assert.deepEqual(result, {
      content: [textItem("Step 1 of 1, rejects: failed"), textItem("42")],
      isError: true,
    });
  });

  it("fails a step with invalid args without calling it", async () => {
    const { tools, calls } = registry({
      nested: {
        shape: {
          a: z.object({ b: z.number() }),
          list: z.array(z.object({ c: z.string() })).optional(),
        },
        result: { content: [textItem("ran")] },
      },
      after: { shape: {}, result: { content: [textItem("after")] } },
    });
    const result = await runBatch(
      [
        { tool: "after" },
        { tool: "nested", args: { a: { b: "x" }, list: [{ c: "ok" }, { c: 1 }] } },
        { tool: "after" },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 3, after: ok"),
        textItem("after"),
        textItem("Step 2 of 3, nested: failed"),
        textItem(
          "Invalid arguments for nested: Invalid input: expected number, received string at a.b\nInvalid input: expected string, received number at list[1].c",
        ),
        textItem("Step 3 (after) was not run because step 2 failed."),
      ],
      isError: true,
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["after"],
    );
  });

  it("validates args asynchronously, as the SDK does", async () => {
    const { tools, calls } = registry({
      checked: {
        shape: { s: z.string().refine(async (value) => value === "yes", "Not yes") },
        result: { content: [textItem("ran")] },
      },
    });
    const refused = await runBatch(
      [{ tool: "checked", args: { s: "no" } }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(
      refused.content[1]?.type === "text" && refused.content[1].text,
      "Invalid arguments for checked: Not yes at s",
    );
    const passed = await runBatch(
      [{ tool: "checked", args: { s: "yes" } }],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(passed.isError, undefined);
    assert.deepEqual(calls, [{ tool: "checked", args: { s: "yes" } }]);
  });

  it("calls a step without args with an empty object", async () => {
    const { tools, calls } = registry({
      optional: { shape: { n: z.number().optional() }, result: { content: [textItem("ran")] } },
    });
    const result = await runBatch([{ tool: "optional" }], tools, extra(), MAX_BYTES);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ tool: "optional", args: {} }]);
  });

  it("fails a step whose tool it does not know", async () => {
    const { tools, calls } = registry({
      ok: { shape: {}, result: { content: [textItem("fine")] } },
    });
    const result = await runBatch([{ tool: "missing" }, { tool: "ok" }], tools, extra(), MAX_BYTES);
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 2, missing: failed"),
        textItem("missing is not a tool batch can run."),
        textItem("Step 2 (ok) was not run because step 1 failed."),
      ],
      isError: true,
    });
    assert.deepEqual(calls, []);
  });

  it("runs no step once the call is cancelled", async () => {
    const controller = new AbortController();
    const { tools, calls } = registry({
      cancels: {
        shape: {},
        result: () => {
          controller.abort();
          return { content: [textItem("ran")] };
        },
      },
      after: { shape: {}, result: { content: [textItem("after")] } },
    });
    const several = await runBatch(
      [{ tool: "cancels" }, { tool: "after" }, { tool: "after" }],
      tools,
      { signal: controller.signal },
      MAX_BYTES,
    );
    assert.deepEqual(several, {
      content: [
        textItem("Step 1 of 3, cancels: ok"),
        textItem("ran"),
        textItem("Steps 2 to 3 (after, after) were not run because the call was cancelled."),
      ],
      isError: true,
    });
    const one = await runBatch(
      [{ tool: "after" }],
      tools,
      { signal: controller.signal },
      MAX_BYTES,
    );
    assert.deepEqual(one, {
      content: [textItem("Step 1 (after) was not run because the call was cancelled.")],
      isError: true,
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["cancels"],
    );
  });

  describe("size cap", () => {
    const LARGE = "a".repeat(20_000);
    const LEFT_OUT = (step: number) =>
      textItem(
        `Part of the result of step ${step} is left out: it is too large to return in a batch. The step ran; read_page reads the page.`,
      );

    it("leaves out an item that does not fit, keeps the step's later items and runs on", async () => {
      const { tools, calls } = registry({
        large: {
          shape: {},
          result: { content: [textItem(LARGE), textItem(LARGE), textItem("saved")] },
        },
        small: { shape: {}, result: { content: [textItem("small")] } },
      });
      const steps = [{ tool: "large" }, { tool: "small" }];
      const maxBytes = budgetFor(steps.length) + cost(textItem(LARGE)) + 100;
      const result = await runBatch(steps, tools, extra(), maxBytes);
      assert.deepEqual(result, {
        content: [
          textItem("Step 1 of 2, large: ok"),
          textItem(LARGE),
          LEFT_OUT(1),
          textItem("saved"),
          textItem("Step 2 of 2, small: ok"),
          textItem("small"),
        ],
      });
      assert.ok(Buffer.byteLength(JSON.stringify(result.content)) <= maxBytes);
      assert.deepEqual(
        calls.map((call) => call.tool),
        ["large", "small"],
      );
    });

    it("notes once per step and leaves out the items of later steps that do not fit", async () => {
      const { tools } = registry({
        large: {
          shape: {},
          result: { content: [textItem(LARGE), textItem(LARGE), textItem(LARGE)] },
        },
        small: { shape: {}, result: { content: [textItem("small")] } },
      });
      const steps = [{ tool: "large" }, { tool: "large" }, { tool: "small" }];
      const maxBytes = budgetFor(steps.length) + cost(textItem(LARGE)) + cost(textItem("small"));
      const result = await runBatch(steps, tools, extra(), maxBytes);
      assert.deepEqual(result, {
        content: [
          textItem("Step 1 of 3, large: ok"),
          textItem(LARGE),
          LEFT_OUT(1),
          textItem("Step 2 of 3, large: ok"),
          LEFT_OUT(2),
          textItem("Step 3 of 3, small: ok"),
          textItem("small"),
        ],
      });
      assert.ok(Buffer.byteLength(JSON.stringify(result.content)) <= maxBytes);
    });

    it("still stops after a failed step whose result is left out", async () => {
      const { tools, calls } = registry({
        large: { shape: {}, result: { content: [textItem(LARGE)], isError: true } },
        small: { shape: {}, result: { content: [textItem("small")] } },
      });
      const steps = [{ tool: "large" }, { tool: "small" }];
      const maxBytes = budgetFor(steps.length) + 100;
      const result = await runBatch(steps, tools, extra(), maxBytes);
      assert.deepEqual(result, {
        content: [
          textItem("Step 1 of 2, large: failed"),
          LEFT_OUT(1),
          textItem("Step 2 (small) was not run because step 1 failed."),
        ],
        isError: true,
      });
      assert.deepEqual(
        calls.map((call) => call.tool),
        ["large"],
      );
    });

    it("keeps an item that exactly fits and leaves out one a byte larger", async () => {
      const { tools } = registry({
        exact: { shape: {}, result: { content: [textItem(LARGE)] } },
        over: { shape: {}, result: { content: [textItem(`${LARGE}a`)] } },
      });
      const maxBytes = budgetFor(1) + cost(textItem(LARGE));
      const kept = await runBatch([{ tool: "exact" }], tools, extra(), maxBytes);
      assert.deepEqual(kept.content, [textItem("Step 1 of 1, exact: ok"), textItem(LARGE)]);
      assert.ok(Buffer.byteLength(JSON.stringify(kept.content)) <= maxBytes);
      const leftOut = await runBatch([{ tool: "over" }], tools, extra(), maxBytes);
      assert.deepEqual(leftOut.content, [textItem("Step 1 of 1, over: ok"), LEFT_OUT(1)]);
    });

    it("keeps the result within the cap with the most steps and the longest notes", async () => {
      const names = Array.from(
        { length: MAX_BATCH_STEPS },
        (_, index) => `tool_${index}_${"n".repeat(20)}`,
      );
      const { tools } = registry(
        Object.fromEntries([
          [names[0] ?? "", { shape: {}, result: { content: [textItem(LARGE)], isError: true } }],
          ...names.slice(1).map((name) => [name, { shape: {}, result: { content: [] } }]),
        ]),
      );
      const steps = names.map((tool) => ({ tool }));
      const maxBytes = budgetFor(steps.length) + 10;
      const result = await runBatch(steps, tools, extra(), maxBytes);
      assert.equal(result.content.length, 3);
      assert.ok(Buffer.byteLength(JSON.stringify(result.content)) <= maxBytes);
    });

    function budgetFor(steps: number): number {
      return (steps * 2 + 1) * NOTE_ALLOWANCE;
    }

    function cost(item: Item): number {
      return Buffer.byteLength(JSON.stringify(item)) + 1;
    }
  });
});

describe("runBatch on a tab an earlier step loaded another page in", () => {
  const LOADED = textItem("loaded");
  const STAYED = textItem("stayed");
  const ACT_SHAPE = {
    tabId: z.number(),
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    targetRef: z.string().optional(),
    targetX: z.number().optional(),
    targetY: z.number().optional(),
    key: z.string().optional(),
  };
  const loads = (result: CallToolResult) => result.content[0] === LOADED;
  const act: FakeTool = {
    shape: ACT_SHAPE,
    result: (args) => ({ content: [args.ref === "link" ? LOADED : STAYED] }),
    loaded: loads,
  };
  const acts = () =>
    registry({
      click: act,
      drag: act,
      press_key: act,
      hover: act,
      scroll: act,
      navigate: { shape: { tabId: z.number() }, result: { content: [STAYED] }, loaded: () => true },
      read_page: { shape: { tabId: z.number() }, result: { content: [textItem("tree")] } },
    });

  for (const [tool, args] of [
    ["click", { x: 1, y: 2 }],
    ["drag", { ref: "a1", targetX: 3, targetY: 4 }],
    ["drag", { x: 1, y: 2, targetRef: "a2" }],
    ["press_key", { key: "Enter" }],
  ] as const) {
    it(`stops before ${tool} ${JSON.stringify(args)} after an act loaded a page in that tab`, async () => {
      const { tools, calls } = acts();
      const result = await runBatch(
        [
          { tool: "click", args: { tabId: 7, ref: "link" } },
          { tool: "read_page", args: { tabId: 7 } },
          { tool, args: { tabId: 7, ...args } },
          { tool: "read_page", args: { tabId: 7 } },
        ],
        tools,
        extra(),
        MAX_BYTES,
      );
      assert.deepEqual(result, {
        content: [
          textItem("Step 1 of 4, click: ok"),
          LOADED,
          textItem("Step 2 of 4, read_page: ok"),
          textItem("tree"),
          textItem(
            `Steps 3 to 4 (${tool}, read_page) were not run because step 1 loaded another page in tab 7, and step 3 aims at a point or at the focused element chosen before that page was seen; read the page, then act.`,
          ),
        ],
        isError: true,
      });
      assert.equal(calls.length, 2);
    });
  }

  it("stops in tab 0 too", async () => {
    const { tools, calls } = acts();
    const result = await runBatch(
      [
        { tool: "click", args: { tabId: 0, ref: "link" } },
        { tool: "click", args: { tabId: 0, x: 1, y: 2 } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(result.isError, true);
    assert.equal(calls.length, 1);
  });

  it("names the last loading step, and stops before a last step", async () => {
    const { tools, calls } = acts();
    const result = await runBatch(
      [
        { tool: "navigate", args: { tabId: 7 } },
        { tool: "click", args: { tabId: 7, ref: "link" } },
        { tool: "click", args: { tabId: 7, x: 1, y: 2 } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result.content.at(-1), {
      type: "text",
      text: "Step 3 (click) was not run because step 2 loaded another page in tab 7, and step 3 aims at a point or at the focused element chosen before that page was seen; read the page, then act.",
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 2);
  });

  it("stops after a navigate step in that tab", async () => {
    const { tools, calls } = acts();
    const result = await runBatch(
      [
        { tool: "navigate", args: { tabId: 3 } },
        { tool: "press_key", args: { tabId: 3, key: "Tab" } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(result.isError, true);
    assert.deepEqual(
      calls.map(({ tool }) => tool),
      ["navigate"],
    );
  });

  it("runs on for a ref step, another tab, hover and scroll at a point, and after no load", async () => {
    const { tools, calls } = acts();
    const result = await runBatch(
      [
        { tool: "click", args: { tabId: 1, x: 1, y: 2 } },
        { tool: "click", args: { tabId: 7, ref: "link" } },
        { tool: "click", args: { tabId: 7, ref: "b2" } },
        { tool: "drag", args: { tabId: 7, ref: "a1", targetRef: "a2" } },
        { tool: "press_key", args: { tabId: 7, key: "Enter", ref: "a3" } },
        { tool: "hover", args: { tabId: 7, x: 1, y: 2 } },
        { tool: "scroll", args: { tabId: 7, x: 1, y: 2 } },
        { tool: "click", args: { tabId: 8, x: 1, y: 2 } },
        { tool: "press_key", args: { tabId: 1, key: "Enter" } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(Object.hasOwn(result, "isError"), false);
    assert.equal(calls.length, 9);
  });

  it("does not count a failed step's result, or a tab id that is not a whole number", async () => {
    const { tools, calls } = registry({
      click: {
        shape: { tabId: z.unknown(), x: z.number().optional(), ref: z.string().optional() },
        result: (args) => ({ content: [LOADED], isError: args.x === 0 }),
        loaded: loads,
      },
    });
    const failed = await runBatch(
      [
        { tool: "click", args: { tabId: 7, x: 0 } },
        { tool: "click", args: { tabId: 7, x: 1 } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(
      failed.content.at(-1),
      textItem("Step 2 (click) was not run because step 1 failed."),
    );
    const odd = await runBatch(
      [
        { tool: "click", args: { tabId: "7", ref: "x" } },
        { tool: "click", args: { tabId: "7", x: 1 } },
        { tool: "click", args: { tabId: 1.5, ref: "x" } },
        { tool: "click", args: { tabId: 1.5, x: 1 } },
        { tool: "click", args: { tabId: -1, ref: "x" } },
        { tool: "click", args: { tabId: -1, x: 1 } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(Object.hasOwn(odd, "isError"), false);
    assert.equal(calls.length, 7);
  });
});

describe("runBatch with tools whose results end with a view of the page", () => {
  const VIEWED = { tabId: z.number(), view: z.boolean().optional() };

  function viewTools() {
    return registry({
      acts: { shape: VIEWED, result: { content: [textItem("acted")] } },
      reads: { shape: { tabId: z.number() }, result: { content: [textItem("read")] } },
    });
  }

  it("leaves the view out of every step but the last", async () => {
    const { tools, calls } = viewTools();
    const steps = [
      { tool: "acts", args: { tabId: 1 } },
      { tool: "reads", args: { tabId: 1 } },
      { tool: "acts", args: { tabId: 1, view: true } },
      { tool: "acts", args: { tabId: 1 } },
    ];
    const result = await runBatch(steps, tools, extra(), MAX_BYTES);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      { tool: "acts", args: { tabId: 1, view: false } },
      { tool: "reads", args: { tabId: 1 } },
      { tool: "acts", args: { tabId: 1, view: false } },
      { tool: "acts", args: { tabId: 1 } },
    ]);
    // The batch's own view true changes nothing.
    await runBatch(steps.slice(2), tools, extra(), MAX_BYTES, true);
    assert.deepEqual(calls.slice(4), [
      { tool: "acts", args: { tabId: 1, view: false } },
      { tool: "acts", args: { tabId: 1 } },
    ]);
  });

  it("leaves the last step's view out too when the batch's view is false", async () => {
    const { tools, calls } = viewTools();
    await runBatch(
      [
        { tool: "acts", args: { tabId: 1 } },
        { tool: "acts", args: { tabId: 2, view: true } },
      ],
      tools,
      extra(),
      MAX_BYTES,
      false,
    );
    assert.deepEqual(calls, [
      { tool: "acts", args: { tabId: 1, view: false } },
      { tool: "acts", args: { tabId: 2, view: false } },
    ]);
  });

  it("keeps a step's own view false, also on the last step", async () => {
    const { tools, calls } = viewTools();
    await runBatch([{ tool: "acts", args: { tabId: 1, view: false } }], tools, extra(), MAX_BYTES);
    assert.deepEqual(calls, [{ tool: "acts", args: { tabId: 1, view: false } }]);
  });

  it("adds nothing to a tool without a view, last step or not", async () => {
    const { tools, calls } = viewTools();
    await runBatch(
      [
        { tool: "reads", args: { tabId: 1 } },
        { tool: "reads", args: { tabId: 2 } },
      ],
      tools,
      extra(),
      MAX_BYTES,
      false,
    );
    assert.deepEqual(calls, [
      { tool: "reads", args: { tabId: 1 } },
      { tool: "reads", args: { tabId: 2 } },
    ]);
  });
});

describe("runBatch with a tool that joins steps", () => {
  const SHAPE = { tab: z.number(), q: z.string(), view: z.boolean().optional() };
  const answer = (args: Record<string, unknown>): CallToolResult => ({
    content: [textItem(`${String(args.tab)}:${String(args.q)}`)],
  });
  const fake = (many: NonNullable<FakeTool["many"]>): FakeTool => ({
    shape: SHAPE,
    result: answer,
    joins: (first, next) => first.tab === next.tab,
    many,
  });
  const all = (argsList: Record<string, unknown>[]): [CallToolResult, ...CallToolResult[]] => {
    const [first, ...rest] = argsList.map(answer);
    assert.ok(first !== undefined);
    return [first, ...rest];
  };

  it("runs consecutive steps it joins as one call, with the same content as alone", async () => {
    const { tools, calls } = registry({ find: fake(all), other: { shape: {}, result: answer } });
    const steps = [
      { tool: "find", args: { tab: 1, q: "a", dropped: true } },
      { tool: "find", args: { tab: 1, q: "b" } },
      { tool: "find", args: { tab: 1, q: "c" } },
      { tool: "find", args: { tab: 2, q: "d" } },
      { tool: "find", args: { tab: 2, q: "e" } },
    ];
    const joined = await runBatch(steps, tools, extra(), MAX_BYTES);
    assert.deepEqual(calls, [
      {
        tool: "find",
        many: [
          { tab: 1, q: "a", view: false },
          { tab: 1, q: "b", view: false },
          { tab: 1, q: "c", view: false },
        ],
      },
      {
        tool: "find",
        many: [
          { tab: 2, q: "d", view: false },
          { tab: 2, q: "e" },
        ],
      },
    ]);
    const alone = registry({ find: { shape: SHAPE, result: answer } });
    assert.deepEqual(joined, await runBatch(steps, alone.tools, extra(), MAX_BYTES));
    assert.equal(alone.calls.length, 5);
  });

  it("runs a step alone when the next step is another tool, another run or the last", async () => {
    const { tools, calls } = registry({ find: fake(all), other: { shape: {}, result: answer } });
    const result = await runBatch(
      [
        { tool: "find", args: { tab: 1, q: "a" } },
        { tool: "other" },
        { tool: "find", args: { tab: 1, q: "b" } },
        { tool: "find", args: { tab: 2, q: "c" } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      { tool: "find", args: { tab: 1, q: "a", view: false } },
      { tool: "other", args: {} },
      { tool: "find", args: { tab: 1, q: "b", view: false } },
      { tool: "find", args: { tab: 2, q: "c" } },
    ]);
  });

  it("ends a run before a step with invalid args, which fails with its own message", async () => {
    const { tools, calls } = registry({ find: fake(all) });
    const result = await runBatch(
      [
        { tool: "find", args: { tab: 1, q: "a" } },
        { tool: "find", args: { tab: 1, q: "b" } },
        { tool: "find", args: { tab: 1 } },
        { tool: "find", args: { tab: 1, q: "c" } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result.content.slice(4), [
      textItem("Step 3 of 4, find: failed"),
      textItem(
        "Invalid arguments for find: Invalid input: expected string, received undefined at q",
      ),
      textItem("Step 4 (find) was not run because step 3 failed."),
    ]);
    assert.deepEqual(calls, [
      {
        tool: "find",
        many: [
          { tab: 1, q: "a", view: false },
          { tab: 1, q: "b", view: false },
        ],
      },
    ]);
  });

  it("runs the steps a joined call gave no result for again, which may join again", async () => {
    const { tools, calls } = registry({
      find: fake((argsList) => [answer(argsList[0] ?? {})]),
    });
    const steps = ["a", "b", "c"].map((q) => ({ tool: "find", args: { tab: 1, q } }));
    const result = await runBatch(steps, tools, extra(), MAX_BYTES, false);
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 3, find: ok"),
        textItem("1:a"),
        textItem("Step 2 of 3, find: ok"),
        textItem("1:b"),
        textItem("Step 3 of 3, find: ok"),
        textItem("1:c"),
      ],
    });
    assert.deepEqual(
      calls.map((call) => ("many" in call ? call.many.map((args) => args.q) : call.args.q)),
      [["a", "b", "c"], ["b", "c"], "c"],
    );
  });

  it("ignores results past the steps it joined", async () => {
    const { tools, calls } = registry({
      find: fake((argsList) => [...all(argsList), { content: [textItem("extra")] }]),
      other: { shape: {}, result: { content: [textItem("other")] } },
    });
    const result = await runBatch(
      [
        { tool: "find", args: { tab: 1, q: "a" } },
        { tool: "find", args: { tab: 1, q: "b" } },
        { tool: "other" },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result.content.slice(4), [
      textItem("Step 3 of 3, other: ok"),
      textItem("other"),
    ]);
    assert.equal(calls.length, 2);
  });

  it("fails the first step when the joined call throws or fails, and runs no other", async () => {
    for (const many of [
      (): never => {
        throw new Error("The host is gone.");
      },
      (): [CallToolResult] => [{ content: [textItem("The host is gone.")], isError: true }],
    ]) {
      const { tools } = registry({ find: fake(many) });
      const result = await runBatch(
        ["a", "b", "c"].map((q) => ({ tool: "find", args: { tab: 1, q } })),
        tools,
        extra(),
        MAX_BYTES,
      );
      assert.deepEqual(result, {
        content: [
          textItem("Step 1 of 3, find: failed"),
          textItem("The host is gone."),
          textItem("Steps 2 to 3 (find, find) were not run because step 1 failed."),
        ],
        isError: true,
      });
    }
  });

  it("asks the tool's own check about each joined result", async () => {
    const { tools } = registry({
      find: {
        ...fake(all),
        failed: (result) =>
          result.content.some((item) => item.type === "text" && item.text === "1:bad"),
      },
    });
    const result = await runBatch(
      ["a", "bad", "c"].map((q) => ({ tool: "find", args: { tab: 1, q } })),
      tools,
      extra(),
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 3, find: ok"),
        textItem("1:a"),
        textItem("Step 2 of 3, find: failed"),
        textItem("1:bad"),
        textItem("Step 3 (find) was not run because step 2 failed."),
      ],
      isError: true,
    });
  });

  it("reports the joined steps after a cancel during the joined call not run", async () => {
    const controller = new AbortController();
    const { tools } = registry({
      find: fake((argsList) => {
        controller.abort();
        return all(argsList);
      }),
    });
    const result = await runBatch(
      ["a", "b", "c"].map((q) => ({ tool: "find", args: { tab: 1, q } })),
      tools,
      { signal: controller.signal },
      MAX_BYTES,
    );
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 3, find: ok"),
        textItem("1:a"),
        textItem("Steps 2 to 3 (find, find) were not run because the call was cancelled."),
      ],
      isError: true,
    });
  });

  it("leaves out each joined step's items that do not fit, step by step", async () => {
    const large = "a".repeat(20_000);
    const { tools } = registry({
      find: fake((argsList) => {
        const [first, ...rest] = argsList.map(() => ({ content: [textItem(large)] }));
        assert.ok(first !== undefined);
        return [first, ...rest];
      }),
    });
    const steps = ["a", "b"].map((q) => ({ tool: "find", args: { tab: 1, q } }));
    const maxBytes = (steps.length * 2 + 1) * NOTE_ALLOWANCE + 20_100;
    const result = await runBatch(steps, tools, extra(), maxBytes);
    assert.deepEqual(result, {
      content: [
        textItem("Step 1 of 2, find: ok"),
        textItem(large),
        textItem("Step 2 of 2, find: ok"),
        textItem(
          "Part of the result of step 2 is left out: it is too large to return in a batch. The step ran; read_page reads the page.",
        ),
      ],
    });
  });

  it("runs each step alone for a tool with only one of the two hooks", async () => {
    const joins = (first: Record<string, unknown>, next: Record<string, unknown>): boolean =>
      first.tab === next.tab;
    for (const hooks of [{ joins }, { many: all }]) {
      const { tools, calls } = registry({ find: { shape: SHAPE, result: answer, ...hooks } });
      const result = await runBatch(
        ["a", "b"].map((q) => ({ tool: "find", args: { tab: 1, q } })),
        tools,
        extra(),
        MAX_BYTES,
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls, [
        { tool: "find", args: { tab: 1, q: "a", view: false } },
        { tool: "find", args: { tab: 1, q: "b" } },
      ]);
    }
  });

  it("joins the steps' args as each step would run alone, the view left out but on the last", async () => {
    const seen: [Record<string, unknown>, Record<string, unknown>][] = [];
    const { tools, calls } = registry({
      find: {
        ...fake(all),
        joins: (first, next) => {
          seen.push([first, next]);
          return true;
        },
      },
    });
    await runBatch(
      [
        { tool: "find", args: { tab: 1, q: "a", view: true } },
        { tool: "find", args: { tab: 2, q: "b" } },
      ],
      tools,
      extra(),
      MAX_BYTES,
    );
    const first = { tab: 1, q: "a", view: false };
    assert.deepEqual(seen, [[first, { tab: 2, q: "b" }]]);
    assert.deepEqual(calls, [{ tool: "find", many: [first, { tab: 2, q: "b" }] }]);
  });
});

interface FakeTool {
  shape: z.ZodRawShape;
  result: CallToolResult | ((args: Record<string, unknown>) => CallToolResult);
  failed?: (result: CallToolResult) => boolean;
  loaded?: (result: CallToolResult) => boolean;
  joins?: (first: Record<string, unknown>, next: Record<string, unknown>) => boolean;
  many?: (argsList: Record<string, unknown>[]) => [CallToolResult, ...CallToolResult[]];
}

/** Tools that record each call and return their fixed or computed result. */
function registry(fakes: Record<string, FakeTool>): {
  tools: Map<string, BatchTool<Extra>>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const tools = new Map<string, BatchTool<Extra>>();
  for (const [name, fake] of Object.entries(fakes)) {
    const tool: BatchTool<Extra> = {
      shape: fake.shape,
      callback(args) {
        calls.push({ tool: name, args });
        return typeof fake.result === "function" ? fake.result(args) : fake.result;
      },
    };
    if (fake.failed !== undefined) tool.failed = fake.failed;
    if (fake.loaded !== undefined) tool.loaded = fake.loaded;
    if (fake.joins !== undefined) tool.joins = fake.joins;
    const many = fake.many;
    if (many !== undefined) {
      tool.callMany = async (argsList) => {
        calls.push({ tool: name, many: argsList });
        return many(argsList);
      };
    }
    tools.set(name, tool);
  }
  return { tools, calls };
}

type Call =
  | { tool: string; args: Record<string, unknown> }
  | { tool: string; many: Record<string, unknown>[] };

function extra(): Extra {
  return { signal: new AbortController().signal };
}

function textItem(text: string): Item {
  return { type: "text", text };
}
