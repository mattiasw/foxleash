import { type RequestMessage, UPDATE_COMMAND } from "@foxleash/protocol";
import { ToolError } from "./handlers.ts";

/** What differs between protocol `from` and `from + 1`, seen from a host of protocol `from`. */
export interface Step {
  from: number;
  /** Turns a request of `from` into one of `from + 1`; may refuse it by throwing a `ToolError`. */
  request?: (request: RequestMessage) => RequestMessage;
  /** Turns a result of `from + 1` into one of `from`; gets the request as it was in `from`. */
  result?: (result: unknown, request: RequestMessage) => unknown;
}

const OLD_UPLOAD_CHECK =
  "This Foxleash program is older than the extension and misses some private keys when it " +
  `checks a file, so the extension refuses its uploads: update Foxleash with \`${UPDATE_COMMAND}\` ` +
  "if you have not yet, then restart Firefox and your MCP client.";

/** One step per protocol from `OLDEST_SERVED_PROTOCOL` up to the one before `PROTOCOL_VERSION`. */
export const STEPS: readonly Step[] = [
  // Protocol 7 refuses a binary PGP secret key in the program's upload check (ADR 0074); a
  // program of 6 reads one, so its uploads are refused, upload_chunk too so nothing it read is
  // staged.
  {
    from: 6,
    request: (request) => {
      if (request.method === "upload_chunk" || request.method === "upload_file") {
        throw new ToolError("protocol_mismatch", OLD_UPLOAD_CHECK);
      }
      return request;
    },
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
