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
  /**
   * Whether a step with args `next` can run in one call with the run of steps that starts with a
   * step with args `first`; both passed the shape. Only for a tool whose steps neither act nor
   * load a page.
   */
  joins?(first: Record<string, unknown>, next: Record<string, unknown>): boolean;
  /**
   * Runs two or more joined steps as one call: the results of the first steps, in order, at least
   * the first one's. The batch runs the steps it got no result for as usual.
   */
  callMany?(
    argsList: Record<string, unknown>[],
    extra: Extra,
  ): Promise<[CallToolResult, ...CallToolResult[]]>;
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
  // The results a joined call already gave for the steps ahead, in order.
  const ready: CallToolResult[] = [];
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
    let result = ready.shift();
    if (result === undefined) {
      const [first, ...rest] = await runFrom(steps, index, step, tool, extra, view);
      result = first;
      ready.push(...rest);
    }
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
 * The results of the step at `index` and, when its tool joins them with it, of the steps right
 * after it, each with isError set when it failed in any way.
 */
async function runFrom<Extra>(
  steps: readonly BatchStep[],
  index: number,
  step: BatchStep,
  tool: BatchTool<Extra> | undefined,
  extra: Extra,
  view: boolean | undefined,
): Promise<[CallToolResult, ...CallToolResult[]]> {
  if (tool === undefined) return [errorResult(`${step.tool} is not a tool batch can run.`)];
  const args = await stepArgs(step, tool, viewedAt(steps, index, view));
  if (!args.ok) return [args.error];
  if (tool.joins === undefined || tool.callMany === undefined) {
    return [await callStep(tool, args.args, extra)];
  }
  const argsList = [args.args];
  for (const [offset, next] of steps.slice(index + 1).entries()) {
    if (next.tool !== step.tool) break;
    const nextArgs = await stepArgs(next, tool, viewedAt(steps, index + 1 + offset, view));
    if (!nextArgs.ok || !tool.joins(args.args, nextArgs.args)) break;
    argsList.push(nextArgs.args);
  }
  if (argsList.length === 1) return [await callStep(tool, args.args, extra)];
  let results: [CallToolResult, ...CallToolResult[]];
  try {
    results = await tool.callMany(argsList, extra);
  } catch (error: unknown) {
    return [thrownResult(error)];
  }
  const [first, ...rest] = results;
  return [
    checked(tool, first),
    ...rest.slice(0, argsList.length - 1).map((each) => checked(tool, each)),
  ];
}

/** Whether the step at `index` is the last one and its result ends with a view of the page. */
function viewedAt(steps: readonly BatchStep[], index: number, view: boolean | undefined): boolean {
  return index === steps.length - 1 && view !== false;
}

/**
 * The step's args as its shape parses them, or the error result for args it refuses. Unless
 * `viewed`, a tool whose result ends with a view of the page runs with it left out; a step never
 * gets one it left out.
 */
async function stepArgs<Extra>(
  step: BatchStep,
  tool: BatchTool<Extra>,
  viewed: boolean,
): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; error: CallToolResult }> {
  const parsed = await z.object(tool.shape).safeParseAsync(step.args ?? {});
  if (!parsed.success) {
    const text = `Invalid arguments for ${step.tool}: ${issuesText(parsed.error.issues)}`;
    return { ok: false, error: errorResult(text) };
  }
  if (!viewed && Object.hasOwn(tool.shape, "view")) parsed.data.view = false;
  return { ok: true, args: parsed.data };
}

/** The result of one call of the tool's callback. */
async function callStep<Extra>(
  tool: BatchTool<Extra>,
  args: Record<string, unknown>,
  extra: Extra,
): Promise<CallToolResult> {
  try {
    return checked(tool, await tool.callback(args, extra));
  } catch (error: unknown) {
    return thrownResult(error);
  }
}

/** The result, with isError set when the tool says it failed without it. */
function checked<Extra>(tool: BatchTool<Extra>, result: CallToolResult): CallToolResult {
  if (result.isError !== true && tool.failed?.(result) === true) {
    return { ...result, isError: true };
  }
  return result;
}

function thrownResult(error: unknown): CallToolResult {
  return errorResult(error instanceof Error ? error.message : String(error));
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
