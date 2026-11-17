import type { RequestMessage } from "@foxleash/protocol";

/** What differs between protocol `from` and `from + 1`, seen from a host of protocol `from`. */
export interface Step {
  from: number;
  /** Turns a request of `from` into one of `from + 1`; may refuse it by throwing a `ToolError`. */
  request?: (request: RequestMessage) => RequestMessage;
  /** Turns a result of `from + 1` into one of `from`; gets the request as it was in `from`. */
  result?: (result: unknown, request: RequestMessage) => unknown;
}

/** One step per protocol from `OLDEST_SERVED_PROTOCOL` up to the one before `PROTOCOL_VERSION`. */
export const STEPS: readonly Step[] = [];

/**
 * Answers `request`, sent by a host of `protocol`, with `handle`, which speaks the current
 * protocol: the request is rewritten up through each step from `protocol` on, and the result
 * back down through the same steps.
 */
export async function answerAs(
  protocol: number,
  request: RequestMessage,
  handle: (request: RequestMessage) => Promise<unknown>,
  steps: readonly Step[] = STEPS,
): Promise<unknown> {
  const applied = steps.filter((step) => step.from >= protocol).sort((a, b) => a.from - b.from);
  const passed: { step: Step; received: RequestMessage }[] = [];
  let current = request;
  for (const step of applied) {
    passed.push({ step, received: current });
    if (step.request !== undefined) current = step.request(current);
  }
  let result = await handle(current);
  for (const { step, received } of passed.reverse()) {
    if (step.result !== undefined) result = step.result(result, received);
  }
  return result;
}
