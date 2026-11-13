import { aimsWithoutRef } from "@foxleash/protocol";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** The most steps one batch call takes. */
export const MAX_BATCH_STEPS = 20;
/** Room in the result for one of Foxleash's own headers or notes, in bytes of JSON. */
export const NOTE_ALLOWANCE = 1024;

/** A tool a batch step can call: its input shape and the callback a direct call runs. */
export interface BatchTool<Extra> {
  shape: z.ZodRawShape;
  // Method syntax on purpose: each tool's callback takes its own args type, which its shape has
  // checked before the call; a property type would reject those callbacks.
  callback(args: Record<string, unknown>, extra: Extra): CallToolResult | Promise<CallToolResult>;
  /** Whether a result without isError still fails the step. */
  failed?(result: CallToolResult): boolean;
  /** Whether the step's result says its tab loaded, or is loading, another page. */
  loaded?(result: CallToolResult): boolean;
}

interface BatchStep {
  tool: string;
  args?: Record<string, unknown> | undefined;
}

type Content = CallToolResult["content"];

/**
 * Runs the steps in order, each as a direct call of its tool runs, and stops at the first step
 * that fails or when the call is cancelled. It also stops before a step that aims at a point or at
 * the focused element in a tab an earlier step loaded another page in: its args were fixed before
 * that page was seen. The result's content stays within `maxBytes` as JSON. Only the last step's
 * result ends with a view of the page, unless `view` is false.
 */
export async function runBatch<Extra extends { signal: AbortSignal }>(
  steps: readonly BatchStep[],
  tools: ReadonlyMap<string, BatchTool<Extra>>,
  extra: Extra,
  maxBytes: number,
  view?: boolean,
): Promise<CallToolResult> {
  const content: Content = [];
  let budget = maxBytes - (steps.length * 2 + 1) * NOTE_ALLOWANCE;
  // The tabs an earlier step loaded another page in, with that step's index.
  const loadedIn = new Map<number, number>();
  for (const [index, step] of steps.entries()) {
    if (extra.signal.aborted) {
      content.push(notRunNote(steps, index, "the call was cancelled"));
      return { content, isError: true };
    }
    const tabId = tabOf(step);
    const loader = tabId === undefined ? undefined : loadedIn.get(tabId);
    if (loader !== undefined && aimsWithoutRef(step.tool, step.args ?? {})) {
      const reason = `step ${loader + 1} loaded another page in tab ${tabId}, and step ${index + 1} aims at a point or at the focused element chosen before that page was seen; read the page, then act`;
      content.push(notRunNote(steps, index, reason));
      return { content, isError: true };
    }
    const tool = tools.get(step.tool);
    const viewed = index === steps.length - 1 && view !== false;
    const result = await runStep(step, tool, extra, viewed);
    const failed = result.isError === true;
    if (!failed && tabId !== undefined && tool?.loaded?.(result) === true) {
      loadedIn.set(tabId, index);
    }
    content.push(header(index, steps.length, step.tool, failed));
    let leftOut = false;
    for (const item of result.content) {
      const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (cost <= budget) {
        content.push(item);
        budget -= cost;
      } else if (!leftOut) {
        content.push(tooLargeNote(index));
        leftOut = true;
      }
    }
    if (failed) {
      if (index + 1 < steps.length)
        content.push(notRunNote(steps, index + 1, `step ${index + 1} failed`));
      return { content, isError: true };
    }
  }
  return { content };
}

/** The step's own tabId argument, when it is a whole number of 0 or more. */
function tabOf(step: BatchStep): number | undefined {
  const args = step.args ?? {};
  const tabId: unknown = Object.hasOwn(args, "tabId") ? args.tabId : undefined;
  return typeof tabId === "number" && Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

/**
 * The step's result, with isError set when it failed in any way. Unless `viewed`, a tool whose
 * result ends with a view of the page runs with it left out; a step never gets one it left out.
 */
async function runStep<Extra>(
  step: BatchStep,
  tool: BatchTool<Extra> | undefined,
  extra: Extra,
  viewed: boolean,
): Promise<CallToolResult> {
  if (tool === undefined) return errorResult(`${step.tool} is not a tool batch can run.`);
  const parsed = await z.object(tool.shape).safeParseAsync(step.args ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments for ${step.tool}: ${issuesText(parsed.error.issues)}`);
  }
  if (!viewed && Object.hasOwn(tool.shape, "view")) parsed.data.view = false;
  let result: CallToolResult;
  try {
    result = await tool.callback(parsed.data, extra);
  } catch (error: unknown) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  if (result.isError !== true && tool.failed?.(result) === true) {
    return { ...result, isError: true };
  }
  return result;
}

/**
 * The issues as the SDK words them for a direct call. Every issue has a path: the shape's fields
 * are the only schemas, and the args are always an object.
 */
function issuesText(issues: readonly { message: string; path: readonly PropertyKey[] }[]): string {
  return issues.map((issue) => `${issue.message} at ${dotPath(issue.path)}`).join("\n");
}

/** A path such as fields[0].value. */
function dotPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function header(index: number, total: number, tool: string, failed: boolean): Content[number] {
  return {
    type: "text",
    text: `Step ${index + 1} of ${total}, ${tool}: ${failed ? "failed" : "ok"}`,
  };
}

function tooLargeNote(index: number): Content[number] {
  return {
    type: "text",
    text: `Part of the result of step ${index + 1} is left out: it is too large to return in a batch. The step ran; read_page reads the page.`,
  };
}

/** Which steps, from `first` on, were not run, and why. */
function notRunNote(steps: readonly BatchStep[], first: number, reason: string): Content[number] {
  const names = steps
    .slice(first)
    .map((step) => step.tool)
    .join(", ");
  const text =
    first === steps.length - 1
      ? `Step ${first + 1} (${names}) was not run because ${reason}.`
      : `Steps ${first + 1} to ${steps.length} (${names}) were not run because ${reason}.`;
  return { type: "text", text };
}
