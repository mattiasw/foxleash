import type { RequestMessage } from "@foxleash/protocol";
import { ownField } from "./page-messages.ts";

/** What differs between protocol `from` and `from + 1`, seen from a host of protocol `from`. */
export interface Step {
  from: number;
  /** Turns a request of `from` into one of `from + 1`; may refuse it by throwing a `ToolError`. */
  request?: (request: RequestMessage) => RequestMessage;
  /** Turns a result of `from + 1` into one of `from`; gets the request as it was in `from`. */
  result?: (result: unknown, request: RequestMessage) => unknown;
}

/** One step per protocol from `OLDEST_SERVED_PROTOCOL` up to the one before `PROTOCOL_VERSION`. */
export const STEPS: readonly Step[] = [
  {
    from: 3,
    // Protocol 4 gave read_network the params types, failed and headers, and leaves the header
    // lists out unless headers is true; a protocol 3 server sends only these three and needs both
    // lists on every request. Left as it is: since ADR 0066 read_network and read_console can
    // record a page already open from its approval on, which a protocol 3 server describes as
    // recorded since its load.
    request: (request) => {
      if (request.method !== "read_network") return request;
      const params: Record<string, unknown> = {};
      for (const key of ["tabId", "pattern", "limit"]) {
        const value = ownField(request.params, key);
        if (value !== undefined) params[key] = value;
      }
      return { ...request, params: { ...params, headers: true } };
    },
  },
  {
    from: 4,
    // Protocol 5 added body to read_network, off unless true, and requestBody to its result only
    // then: a request of 4 gets a result of 4.
  },
  {
    from: 5,
    // Protocol 6 added responseBody to read_network, off unless true, and responseBody to its
    // result only then: a request of 5 gets a result of 5.
  },
];

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
