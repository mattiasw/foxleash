import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION, type RequestMessage } from "@foxleash/protocol";
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

describe("the protocol 3 step", () => {
  async function handledAs(protocol: number, sent: RequestMessage): Promise<RequestMessage> {
    let handled: RequestMessage | undefined;
    await answerAs(protocol, sent, async (received) => {
      handled = received;
      return null;
    });
    assert.ok(handled !== undefined);
    return handled;
  }

  it("asks read_network for headers and keeps only the params protocol 3 had", async () => {
    const sent = request("read_network", {
      tabId: 4,
      pattern: "/api",
      limit: 7,
      types: ["script"],
      failed: true,
      headers: false,
      body: true,
      responseBody: true,
      extra: 1,
    });
    assert.deepEqual(await handledAs(3, sent), {
      ...sent,
      params: { tabId: 4, pattern: "/api", limit: 7, headers: true },
    });
  });

  it("leaves out the params a protocol 3 request did not carry", async () => {
    const handled = await handledAs(3, request("read_network", { tabId: 0 }));
    assert.deepEqual(handled.params, { tabId: 0, headers: true });
  });

  it("reads no param through the prototype", async () => {
    const params: Record<string, unknown> = Object.create({ pattern: "inherited", limit: 2 });
    params.tabId = 1;
    const handled = await handledAs(3, request("read_network", params));
    assert.deepEqual(handled.params, { tabId: 1, headers: true });
  });

  it("passes every other method through as it is", async () => {
    const sent = request("read_console", { tabId: 1, pattern: "x", headers: false, extra: 1 });
    assert.equal(await handledAs(3, sent), sent);
  });

  for (const protocol of [4, 5]) {
    it(`passes a protocol ${protocol} read_network request and its result through`, async () => {
      const sent = request("read_network", { tabId: 1, failed: true });
      const result = { recording: true, requests: [], truncated: false };
      let handled: RequestMessage | undefined;
      const answered = await answerAs(protocol, sent, async (received) => {
        handled = received;
        return result;
      });
      assert.equal(handled, sent);
      assert.equal(answered, result);
    });
  }
});
