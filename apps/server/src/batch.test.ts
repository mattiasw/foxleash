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
        `Part of the result of step ${step} is left out: it is too large to return in a batch. The step ran.`,
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

interface FakeTool {
  shape: z.ZodRawShape;
  result: CallToolResult | ((args: Record<string, unknown>) => CallToolResult);
  failed?: (result: CallToolResult) => boolean;
}

/** Tools that record each call and return their fixed or computed result. */
function registry(fakes: Record<string, FakeTool>): {
  tools: Map<string, BatchTool<Extra>>;
  calls: { tool: string; args: Record<string, unknown> }[];
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
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
    tools.set(name, tool);
  }
  return { tools, calls };
}

function extra(): Extra {
  return { signal: new AbortController().signal };
}

function textItem(text: string): Item {
  return { type: "text", text };
}
