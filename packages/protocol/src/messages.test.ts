import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import {
  type Message,
  type Params,
  type ProbeCheckName,
  type ProbeOutcome,
  parseMessage,
  type Request,
} from "./index.ts";

type Fields = Record<string, unknown>;

const hello = { type: "hello", role: "mcp", protocol: 1, version: "0.1.0" };
const welcome = { type: "welcome", protocol: 1, version: "0.1.0" };
const connectedWelcome = {
  ...welcome,
  extension: { connected: true, protocol: 1, version: "0.2.0" },
};
const request = { type: "request", id: "r1", session: "s1", method: "tabs_list", params: {} };
const success = { type: "response", id: "r1", ok: true, result: { tabs: [] } };
const failure = {
  type: "response",
  id: "r1",
  ok: false,
  error: { code: "no_tab", message: "No tab with id 4." },
};
const sessionEnd = { type: "session_end", session: "s1" };

class Envelope {
  type = "hello";
  role = "mcp";
  protocol = 1;
  version = "0.1.0";
}

const MISSING = Symbol("missing");

describe("parseMessage accepts", () => {
  const accepted: { name: string; input: unknown; expected: Message }[] = [
    {
      name: "a hello from an MCP server",
      input: hello,
      expected: { type: "hello", role: "mcp", protocol: 1, version: "0.1.0" },
    },
    {
      name: "a hello from the extension",
      input: { ...hello, role: "extension" },
      expected: { type: "hello", role: "extension", protocol: 1, version: "0.1.0" },
    },
    {
      name: "a welcome without extension status",
      input: welcome,
      expected: { type: "welcome", protocol: 1, version: "0.1.0" },
    },
    {
      name: "a welcome with a disconnected extension",
      input: { ...welcome, extension: { connected: false, protocol: 1 } },
      expected: { type: "welcome", protocol: 1, version: "0.1.0", extension: { connected: false } },
    },
    {
      name: "a welcome with a connected extension",
      input: connectedWelcome,
      expected: {
        type: "welcome",
        protocol: 1,
        version: "0.1.0",
        extension: { connected: true, protocol: 1, version: "0.2.0" },
      },
    },
    ...(
      [
        "tabs_list",
        "tab_open",
        "navigate",
        "read_page",
        "get_page_text",
        "screenshot",
        "probe_input",
      ] as const
    ).map((method) => ({
      name: `a ${method} request`,
      input: { ...request, method, params: { tabId: 2 } },
      expected: {
        type: "request",
        id: "r1",
        session: "s1",
        method,
        params: { tabId: 2 },
      } as const,
    })),
    ...[0, null, false].map((result) => ({
      name: `a successful response with the result ${String(result)}`,
      input: { ...success, result },
      expected: { type: "response", id: "r1", ok: true, result } as const,
    })),
    {
      name: "a successful response without a result key, as null",
      input: { type: "response", id: "r1", ok: true },
      expected: { type: "response", id: "r1", ok: true, result: null },
    },
    {
      name: "a failed response",
      input: failure,
      expected: {
        type: "response",
        id: "r1",
        ok: false,
        error: { code: "no_tab", message: "No tab with id 4." },
      },
    },
    {
      name: "an envelope without a prototype",
      input: Object.assign(Object.create(null), {
        ...request,
        params: Object.assign(Object.create(null), { url: "https://example.com/" }),
      }),
      expected: {
        type: "request",
        id: "r1",
        session: "s1",
        method: "tabs_list",
        params: { url: "https://example.com/" },
      },
    },
    ...[true, false].flatMap((allUrls) => [
      {
        name: `a hello from the extension with allUrls ${allUrls}`,
        input: { ...hello, role: "extension", allUrls },
        expected: {
          type: "hello",
          role: "extension",
          protocol: 1,
          version: "0.1.0",
          allUrls,
        } as const,
      },
      {
        name: `a hello from an MCP server with allUrls ${allUrls}`,
        input: { ...hello, allUrls },
        expected: { type: "hello", role: "mcp", protocol: 1, version: "0.1.0", allUrls } as const,
      },
      {
        name: `a welcome with a connected extension and allUrls ${allUrls}`,
        input: { ...welcome, extension: { ...connectedWelcome.extension, allUrls } },
        expected: {
          type: "welcome",
          protocol: 1,
          version: "0.1.0",
          extension: { connected: true, protocol: 1, version: "0.2.0", allUrls },
        } as const,
      },
    ]),
    {
      name: "a session end",
      input: sessionEnd,
      expected: { type: "session_end", session: "s1" },
    },
    {
      name: "a session end with a 256-character session",
      input: { ...sessionEnd, session: "s".repeat(256) },
      expected: { type: "session_end", session: "s".repeat(256) },
    },
    {
      name: "a 256-character token",
      input: { ...request, session: "s".repeat(256) },
      expected: {
        type: "request",
        id: "r1",
        session: "s".repeat(256),
        method: "tabs_list",
        params: {},
      },
    },
    {
      name: "a 64-character version",
      input: { ...hello, version: "1".repeat(64) },
      expected: { type: "hello", role: "mcp", protocol: 1, version: "1".repeat(64) },
    },
    {
      name: "a version made of the ends of each allowed character range",
      input: { ...hello, version: "0.9.0-Az.aZ+19" },
      expected: { type: "hello", role: "mcp", protocol: 1, version: "0.9.0-Az.aZ+19" },
    },
    {
      name: "a token made of the first and last allowed characters",
      input: { ...request, id: "!~" },
      expected: { type: "request", id: "!~", session: "s1", method: "tabs_list", params: {} },
    },
  ];

  for (const { name, input, expected } of accepted) {
    it(name, () => {
      assert.deepEqual(parseMessage(input), { ok: true, message: expected });
    });
  }

  it("a successful response's result object as is", () => {
    const result = { tabs: [{ id: 1 }] };
    const message = parsed({ ...success, result });
    assert.ok(message.type === "response" && message.ok);
    assert.equal(message.result, result);
  });

  it("a typed request unchanged", () => {
    const navigate: Request<"navigate"> = {
      type: "request",
      id: "r2",
      session: "s1",
      method: "navigate",
      params: { tabId: 3, action: "back" },
    };
    const message: Message = navigate;
    assert.deepEqual(parseMessage(message), { ok: true, message: navigate });
  });

  it("navigate params with a url or an action, not both (compile-time)", () => {
    const params: Params<"navigate">[] = [
      { tabId: 1, url: "https://example.com/" },
      { tabId: 1, action: "reload" },
      // @ts-expect-error a navigate request takes a url or an action, not both
      { tabId: 1, url: "https://example.com/", action: "back" },
    ];
    assert.equal(params.length, 3);
  });

  it("the probe's check names and outcomes, all of them (compile-time)", () => {
    const checks: Record<ProbeCheckName, true> = {
      click_button: true,
      click_link: true,
      type_input: true,
      type_contenteditable: true,
      type_rich_editor: true,
      enter_in_form: true,
      tab_focus: true,
    };
    const outcomes: Record<ProbeOutcome, true> = {
      worked: true,
      no_effect: true,
      no_target: true,
      unknown: true,
      error: true,
    };
    assert.equal(Object.keys(checks).length + Object.keys(outcomes).length, 12);
  });
});

describe("parseMessage rejects", () => {
  it("anything that is not a plain object", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      1,
      "hello",
      true,
      [],
      [hello],
      Object.create({ ...hello }),
      new Envelope(),
      new Map(Object.entries(hello)),
    ];
    for (const input of inputs) {
      assert.deepEqual(
        parseMessage(input),
        { ok: false, error: "invalid message" },
        inspect(input),
      );
    }
  });

  for (const type of [MISSING, "Hello", "constructor", "__proto__", "toString", 1]) {
    it(`the type ${inspect(type)}`, () => {
      assert.deepEqual(parseMessage(variant(hello, ["type"], type)), {
        ok: false,
        error: "invalid type",
      });
    });
  }

  const badTokens: unknown[] = [
    MISSING,
    1,
    "",
    "t".repeat(257),
    "a\nb",
    "ab\n",
    "a b",
    "a\x7fb",
    "a\u202eb",
    "\u00e9",
  ];
  const tokenFields: { base: Fields; path: string[]; id?: string }[] = [
    { base: request, path: ["id"] },
    { base: request, path: ["session"], id: "r1" },
    { base: success, path: ["id"] },
    { base: failure, path: ["error", "code"] },
    { base: sessionEnd, path: ["session"] },
  ];
  for (const { base, path, id } of tokenFields) {
    it(`a ${base.type} whose ${path.join(".")} is not a token`, () => {
      for (const value of badTokens) {
        assert.deepEqual(
          parseMessage(variant(base, path, value)),
          expectedFailure(path, id),
          inspect(value),
        );
      }
    });
  }

  const badVersions: unknown[] = [...badTokens, "1".repeat(65), "1.0`x`", "(1.0)", "1.0:x", "1_0"];
  const versionFields: { base: Fields; path: string[] }[] = [
    { base: hello, path: ["version"] },
    { base: welcome, path: ["version"] },
    { base: connectedWelcome, path: ["extension", "version"] },
  ];
  for (const { base, path } of versionFields) {
    it(`a ${base.type} whose ${path.join(".")} is not a release version`, () => {
      for (const value of badVersions) {
        assert.deepEqual(
          parseMessage(variant(base, path, value)),
          expectedFailure(path),
          inspect(value),
        );
      }
    });
  }

  const badProtocols: unknown[] = [
    MISSING,
    0,
    -0,
    -1,
    1.5,
    "1",
    true,
    2 ** 53,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];
  const protocolFields: { base: Fields; path: string[] }[] = [
    { base: hello, path: ["protocol"] },
    { base: welcome, path: ["protocol"] },
    { base: connectedWelcome, path: ["extension", "protocol"] },
  ];
  for (const { base, path } of protocolFields) {
    it(`a ${base.type} whose ${path.join(".")} is not a positive integer`, () => {
      for (const value of badProtocols) {
        assert.deepEqual(
          parseMessage(variant(base, path, value)),
          expectedFailure(path),
          inspect(value),
        );
      }
    });
  }

  const fieldCases: { base: Fields; path: string[]; values: unknown[]; id?: string }[] = [
    { base: hello, path: ["role"], values: [MISSING, "host", 1] },
    { base: hello, path: ["allUrls"], values: [null, "true", 1, 0, {}] },
    { base: connectedWelcome, path: ["extension", "allUrls"], values: [null, "true", 1, 0, {}] },
    { base: connectedWelcome, path: ["extension"], values: [null, "x", []] },
    { base: connectedWelcome, path: ["extension", "connected"], values: [MISSING, "true", 1] },
    {
      base: request,
      path: ["method"],
      values: [MISSING, "tabs_close", "constructor", 1],
      id: "r1",
    },
    {
      base: request,
      path: ["params"],
      values: [MISSING, null, [], "x", new Envelope()],
      id: "r1",
    },
    { base: success, path: ["ok"], values: [MISSING, "true", 1] },
    { base: failure, path: ["error"], values: [MISSING, null, []] },
    { base: failure, path: ["error", "message"], values: [MISSING, 1] },
  ];
  for (const { base, path, values, id } of fieldCases) {
    it(`a ${base.type} with an invalid ${path.join(".")}`, () => {
      for (const value of values) {
        assert.deepEqual(
          parseMessage(variant(base, path, value)),
          expectedFailure(path, id),
          inspect(value),
        );
      }
    });
  }

  it("a session_end without an id on the failure, even when it carries one", () => {
    assert.deepEqual(parseMessage({ ...sessionEnd, id: "r1", session: "a b" }), {
      ok: false,
      error: "invalid session",
    });
  });

  it("a response without an id on the failure, even when its id is valid", () => {
    assert.deepEqual(parseMessage({ ...failure, error: { code: "x" } }), {
      ok: false,
      error: "invalid error.message",
    });
  });

  it("without echoing the offending value", () => {
    for (const input of [
      { ...hello, type: "SECRET-VALUE" },
      { ...request, method: "SECRET-VALUE" },
    ]) {
      const result = parseMessage(input);
      assert.ok(!result.ok);
      assert.ok(!result.error.includes("SECRET-VALUE"), result.error);
    }
  });
});

describe("parseMessage returns only validated fields", () => {
  it("drops unknown and __proto__ keys and builds fresh objects", () => {
    const input: Fields = JSON.parse(
      '{"type":"request","id":"r1","session":"s1","method":"tab_open","extra":1,' +
        '"__proto__":{"polluted":true},' +
        '"params":{"url":"https://example.com/","extra":2,"__proto__":{"polluted":true}}}',
    );
    const message = parsed(input);
    assert.deepEqual(message, {
      type: "request",
      id: "r1",
      session: "s1",
      method: "tab_open",
      params: { url: "https://example.com/", extra: 2 },
    });
    assert.ok(message.type === "request");
    assert.notEqual(message, input);
    assert.notEqual(message.params, input.params);
    for (const object of [message, message.params]) {
      assert.equal(Object.hasOwn(object, "__proto__"), false);
      assert.equal(Object.getPrototypeOf(object), Object.prototype);
    }
  });

  it("leaves allUrls out when it is absent", () => {
    const helloMessage = parsed(hello);
    assert.equal(Object.hasOwn(helloMessage, "allUrls"), false);
    const welcomeMessage = parsed(connectedWelcome);
    assert.ok(welcomeMessage.type === "welcome" && welcomeMessage.extension);
    assert.equal(Object.hasOwn(welcomeMessage.extension, "allUrls"), false);
  });

  it("builds a fresh extension status", () => {
    const message = parsed(connectedWelcome);
    assert.ok(message.type === "welcome");
    assert.notEqual(message.extension, connectedWelcome.extension);
  });

  it("builds a fresh session end without unknown fields", () => {
    const input = { ...sessionEnd, id: "r1", extra: 1 };
    const message = parsed(input);
    assert.deepEqual(message, { type: "session_end", session: "s1" });
    assert.notEqual(message, input);
  });

  it("builds a fresh response error", () => {
    const message = parsed({ ...failure, error: { ...failure.error, extra: 1 } });
    assert.ok(message.type === "response" && !message.ok);
    assert.deepEqual(message.error, failure.error);
    assert.notEqual(message.error, failure.error);
  });

  it("never reads a field from Object.prototype", () => {
    const missing: { key: string; value: unknown; input: Fields; expected: unknown }[] = [
      {
        key: "type",
        value: "hello",
        input: {},
        expected: { ok: false, error: "invalid type" },
      },
      {
        key: "role",
        value: "mcp",
        input: variant(hello, ["role"], MISSING),
        expected: { ok: false, error: "invalid role" },
      },
      {
        key: "extension",
        value: { connected: false },
        input: welcome,
        expected: { ok: true, message: { type: "welcome", protocol: 1, version: "0.1.0" } },
      },
      {
        key: "allUrls",
        value: true,
        input: hello,
        expected: { ok: true, message: hello },
      },
      {
        key: "allUrls",
        value: true,
        input: connectedWelcome,
        expected: { ok: true, message: connectedWelcome },
      },
      {
        key: "result",
        value: 5,
        input: { type: "response", id: "r1", ok: true },
        expected: { ok: true, message: { type: "response", id: "r1", ok: true, result: null } },
      },
    ];
    const prototype: Fields = Object.prototype as Fields;
    for (const { key, value, input, expected } of missing) {
      let result: unknown;
      try {
        prototype[key] = value;
        result = parseMessage(input);
      } finally {
        delete prototype[key];
      }
      assert.deepEqual(result, expected, key);
    }
  });
});

function parsed(input: unknown): Message {
  const result = parseMessage(input);
  assert.ok(result.ok, inspect(result));
  return result.message;
}

/** A deep copy of `base` with the field at `path` replaced, or deleted for MISSING. */
function variant(base: Fields, path: readonly string[], value: unknown): Fields {
  const copy = structuredClone(base);
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Fields;
  const last = path.at(-1) as string;
  if (value === MISSING) delete target[last];
  else target[last] = value;
  return copy;
}

function expectedFailure(path: readonly string[], id?: string): Fields {
  const error = `invalid ${path.join(".")}`;
  return id === undefined ? { ok: false, error } : { ok: false, error, id };
}
