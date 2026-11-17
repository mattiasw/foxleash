import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OLDEST_SERVED_PROTOCOL,
  PROTOCOL_VERSION,
  type RequestMessage,
  UPDATE_COMMAND,
} from "@foxleash/protocol";
import { ToolError } from "./handlers.ts";
import { answerAs, STEPS, type Step } from "./served-protocols.ts";

function request(
  method: RequestMessage["method"],
  params: Record<string, unknown>,
): RequestMessage {
  return { type: "request", id: "r1", session: "s1", method, params };
}

const tabs = request("tabs_list", {});

describe("served protocol steps", () => {
  it("has one step for each protocol from the oldest served one up to the current one", () => {
    const expected = Array.from(
      { length: PROTOCOL_VERSION - OLDEST_SERVED_PROTOCOL },
      (_, index) => OLDEST_SERVED_PROTOCOL + index,
    );
    assert.deepEqual(
      STEPS.map((step) => step.from),
      expected,
      "Add the step for the protocol a raise of PROTOCOL_VERSION leaves behind, with the " +
        "rewrite of its old shape and a test through the real handler, or a comment saying why " +
        "nothing differs; delete the steps below OLDEST_SERVED_PROTOCOL.",
    );
  });
});

describe("the protocol 6 step", () => {
  const refusal =
    "This Foxleash program is older than the extension and misses some private keys when it " +
    `checks a file, so the extension refuses its uploads: update Foxleash with \`${UPDATE_COMMAND}\` ` +
    "if you have not yet, then restart Firefox and your MCP client.";

  for (const method of ["upload_chunk", "upload_file"] as const) {
    it(`refuses ${method} with protocol_mismatch and never calls the handler`, async () => {
      let calls = 0;
      await assert.rejects(
        answerAs(6, request(method, { uploadId: "u1" }), async () => {
          calls += 1;
          return null;
        }),
        (error) =>
          error instanceof ToolError &&
          error.code === "protocol_mismatch" &&
          error.message === refusal,
      );
      assert.equal(calls, 0);
    });
  }

  it("passes every other request and its result through unchanged", async () => {
    const result = { tabs: [] };
    let handled: RequestMessage | undefined;
    const answered = await answerAs(6, tabs, async (received) => {
      handled = received;
      return result;
    });
    assert.equal(handled, tabs);
    assert.equal(answered, result);
  });

  it("does not apply to a host of the current protocol", async () => {
    const upload = request("upload_file", { uploadId: "u1" });
    let handled: RequestMessage | undefined;
    await answerAs(PROTOCOL_VERSION, upload, async (received) => {
      handled = received;
      return null;
    });
    assert.equal(handled, upload);
  });
});

describe("answerAs", () => {
  /** Steps that record each rewrite they make, in order, and tag what they return. */
  function recordingSteps(log: string[]): Step[] {
    return [2, 1].map((from) => ({
      from,
      request: (received) => {
        log.push(`request ${from} ${received.id}`);
        return { ...received, id: `${received.id}>${from}` };
      },
      result: (result, received) => {
        log.push(`result ${from} ${String(result)} ${received.id}`);
        return `${String(result)}<${from}`;
      },
    }));
  }

  it("rewrites the request up from the host's protocol and the result back down", async () => {
    const log: string[] = [];
    const result = await answerAs(
      1,
      tabs,
      async (received) => {
        log.push(`handle ${received.id}`);
        return "out";
      },
      recordingSteps(log),
    );
    assert.equal(result, "out<2<1");
    assert.deepEqual(log, [
      "request 1 r1",
      "request 2 r1>1",
      "handle r1>1>2",
      "result 2 out r1>1",
      "result 1 out<2 r1",
    ]);
  });

  it("applies only the steps from the host's protocol on", async () => {
    const log: string[] = [];
    const result = await answerAs(
      2,
      tabs,
      async (received) => {
        log.push(`handle ${received.id}`);
        return "out";
      },
      recordingSteps(log),
    );
    assert.equal(result, "out<2");
    assert.deepEqual(log, ["request 2 r1", "handle r1>2", "result 2 out r1"]);
  });

  it("passes the request and result through a step that has no rewrite", async () => {
    const result = { requests: [] };
    let handled: RequestMessage | undefined;
    const answered = await answerAs(
      1,
      tabs,
      async (received) => {
        handled = received;
        return result;
      },
      [{ from: 1 }],
    );
    assert.equal(handled, tabs);
    assert.equal(answered, result);
  });

  it("keeps a null that a result rewrite returns", async () => {
    const answered = await answerAs(1, tabs, async () => "out", [
      { from: 1, result: () => null },
      { from: 2 },
    ]);
    assert.equal(answered, null);
  });

  it("refuses with a step's error and never calls the handler", async () => {
    const refusal = new ToolError("protocol_mismatch", "This server version cannot do that.");
    let calls = 0;
    await assert.rejects(
      answerAs(
        1,
        tabs,
        async () => {
          calls += 1;
          return null;
        },
        [
          {
            from: 1,
            request: () => {
              throw refusal;
            },
          },
        ],
      ),
      (error) => error === refusal,
    );
    assert.equal(calls, 0);
  });

  it("passes the handler's error through unchanged", async () => {
    const failure = new ToolError("tab_not_found", "Tab 4 does not exist.");
    let rewrote = false;
    await assert.rejects(
      answerAs(
        1,
        tabs,
        async () => {
          throw failure;
        },
        [
          {
            from: 1,
            result: (result) => {
              rewrote = true;
              return result;
            },
          },
        ],
      ),
      (error) => error === failure,
    );
    assert.equal(rewrote, false);
  });

  for (const protocol of [PROTOCOL_VERSION, PROTOCOL_VERSION + 1]) {
    it(`rewrites nothing for protocol ${protocol}`, async () => {
      const network = request("read_network", { tabId: 1 });
      const result = { recording: false, requests: [], truncated: false };
      let handled: RequestMessage | undefined;
      const answered = await answerAs(protocol, network, async (received) => {
        handled = received;
        return result;
      });
      assert.equal(handled, network);
      assert.equal(answered, result);
    });
  }
});
