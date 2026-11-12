import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import vm from "node:vm";
import type { ConsoleLevel } from "@foxleash/protocol";
import { type RecorderOptions, type RecorderPage, recordConsole } from "./console-recorder.ts";

const SITE = "https://a.example";
const LEVELS: ConsoleLevel[] = ["debug", "log", "info", "warn", "error"];
const OPTIONS: RecorderOptions = {
  maxMessages: 5,
  maxText: 50,
  readEvent: "test-read",
  replyEvent: "test-reply",
};

interface Call {
  level: string;
  self: unknown;
  args: unknown[];
}

interface Recorded {
  level: string;
  kind: string;
  text: string;
  time: number;
}

/** A window as far as the recorder reads it, with a console that notes every call. */
class FakePage extends EventTarget {
  readonly calls: Call[] = [];
  readonly location: { protocol: string; hostname: string; port: string };
  readonly console: { [level in ConsoleLevel]: unknown };
  readonly CustomEvent = CustomEvent;
  readonly Error = Error;

  constructor(href = `${SITE}/page`) {
    super();
    const url = new URL(href);
    this.location = { protocol: url.protocol, hostname: url.hostname, port: url.port };
    const calls = this.calls;
    const original = (level: ConsoleLevel) =>
      function (this: unknown, ...args: unknown[]): string {
        // Not push: a test replaces Array.prototype.push.
        calls[calls.length] = { level, self: this, args };
        return `${level} returned`;
      };
    this.console = {
      debug: original("debug"),
      log: original("log"),
      info: original("info"),
      warn: original("warn"),
      error: original("error"),
    };
  }

  log(level: ConsoleLevel, ...args: unknown[]): unknown {
    const method = this.console[level];
    assert.equal(typeof method, "function");
    // Not Reflect.apply: a test replaces it.
    return (method as (...args: unknown[]) => unknown).apply(this.console, args);
  }
}

describe("recordConsole", () => {
  it("passes each call to the original with its this and arguments, and returns its value", () => {
    const page = started();
    const args = [1, "two", { three: 3 }];
    for (const level of LEVELS) {
      assert.equal(page.log(level, ...args), `${level} returned`);
    }
    const other = { name: "another this" };
    Reflect.apply(page.console.log as (...args: unknown[]) => unknown, other, ["x"]);
    assert.deepEqual(page.calls, [
      ...LEVELS.map((level) => ({ level, self: page.console, args })),
      { level: "log", self: other, args: ["x"] },
    ]);
    assert.equal(page.calls[0]?.args[2], args[2]);
  });

  it("records the level, kind, text and time of each call", (t) => {
    t.mock.method(Date, "now", () => 1234.5);
    const page = started();
    for (const level of LEVELS) page.log(level, `${level} text`);
    assert.deepEqual(
      read(page).messages,
      LEVELS.map((level) => ({ level, kind: "console", text: `${level} text`, time: 1234.5 })),
    );
  });

  it("formats each argument as text, one space apart", () => {
    const cases: [unknown[], string][] = [
      [["plain", "words"], "plain words"],
      [[1, 2.5, -0, Number.NaN, 10n], "1 2.5 0 NaN 10"],
      [[undefined, null, true], "undefined null true"],
      [[Symbol("tag")], "Symbol(tag)"],
      [[new TypeError("bad type")], "TypeError: bad type"],
      [[{ a: 1, b: ["c"] }], '{"a":1,"b":["c"]}'],
      [[[1, "x"]], '[1,"x"]'],
      [[() => 1], "[object Function]"],
      [[new Float32Array(1_000_000)], "[object Float32Array]"],
      [[new DataView(new ArrayBuffer(4))], "[object DataView]"],
      [[new ArrayBuffer(8)], "[object ArrayBuffer]"],
      [[new SharedArrayBuffer(8)], "[object SharedArrayBuffer]"],
      [
        [{ data: new Uint8Array(3), buffer: new ArrayBuffer(2) }],
        '{"data":"[object Uint8Array]","buffer":"[object ArrayBuffer]"}',
      ],
      [[{ toJSON: () => "own" }], '"own"'],
      [
        [
          {
            toJSON() {
              throw new Error("no");
            },
          },
        ],
        "[object Object]",
      ],
      [[cyclic()], "[object Object]"],
      [[new Map([[1, 2]])], "{}"],
      [[{}, "after"], "{} after"],
    ];
    for (const [args, text] of cases) {
      const page = started({ ...OPTIONS, maxText: 200 });
      page.log("log", ...args);
      assert.equal(read(page).messages[0]?.text, text, text);
    }
  });

  it("writes nested strings and numbers as JSON when the page tags their prototypes", () => {
    const page = started({ ...OPTIONS, maxText: 200 });
    const tag = { get: () => "ArrayBuffer", configurable: true };
    Object.defineProperty(String.prototype, Symbol.toStringTag, tag);
    Object.defineProperty(Number.prototype, Symbol.toStringTag, tag);
    try {
      page.log("log", { a: "x", b: 1 });
    } finally {
      Reflect.deleteProperty(String.prototype, Symbol.toStringTag);
      Reflect.deleteProperty(Number.prototype, Symbol.toStringTag);
    }
    assert.equal(read(page).messages[0]?.text, '{"a":"x","b":1}');
  });

  it("formats an Error from another realm by its name and message", () => {
    const page = started();
    page.log("error", vm.runInNewContext('new RangeError("from a frame")'));
    assert.equal(read(page).messages[0]?.text, "RangeError: from a frame");
  });

  it("formats an Error by its name and message, even when they are not strings", () => {
    const page = started();
    const error = new Error("plain");
    Object.defineProperty(error, "name", { value: 42 });
    page.log("log", error);
    assert.equal(read(page).messages[0]?.text, "42: plain");
  });

  it("stops formatting a value at ten times maxText of keys and strings", () => {
    // maxText 50: the object costs 1, the key "a" 1, the string its length; the cap is 500.
    const page = started();
    page.log("log", { a: "x".repeat(498) });
    page.log("log", { a: "x".repeat(499) });
    page.log(
      "log",
      Array.from({ length: 100_000 }, () => 0),
    );
    const texts = read(page).messages.map((message) => message.text);
    assert.deepEqual(texts, [`{"a":"${"x".repeat(44)}`, "[object Object]", "[object Array]"]);
  });

  it("stops formatting arguments once the text is longer than maxText", () => {
    const page = started();
    let formatted = 0;
    const counted = {
      toJSON() {
        formatted += 1;
        return "z";
      },
    };
    page.log("log", "a".repeat(50), counted);
    page.log("log", "a".repeat(51), counted);
    assert.equal(formatted, 1);
    assert.deepEqual(
      read(page).messages.map((message) => message.text),
      ["a".repeat(50), "a".repeat(50)],
    );
  });

  it("cuts the text at maxText without splitting a surrogate pair", () => {
    const page = started({ ...OPTIONS, maxText: 5, maxMessages: 10 });
    page.log("log", "abcd\u{1F600}");
    page.log("log", "abcde\u{1F600}");
    page.log("log", "abc\u{1F600}");
    page.log("log", "abcdef");
    page.log("log", "abcd\u{10FFFF}");
    page.log("log", "abcd\uD800");
    assert.deepEqual(
      read(page).messages.map((message) => message.text),
      ["abcd", "abcde", "abc\u{1F600}", "abcde", "abcd", "abcd\uD800"],
    );
  });

  it("keeps the newest maxMessages and counts the dropped ones", () => {
    const page = started({ ...OPTIONS, maxMessages: 3 });
    for (let index = 0; index < 3; index += 1) page.log("log", `m${index}`);
    assert.deepEqual(read(page).dropped, 0);
    for (let index = 3; index < 5; index += 1) page.log("log", `m${index}`);
    const reply = read(page);
    assert.deepEqual(
      reply.messages.map((message) => message.text),
      ["m2", "m3", "m4"],
    );
    assert.equal(reply.dropped, 2);
  });

  it("does not record what the page logs while one of its values is formatted", () => {
    const page = started();
    const value = {
      get x() {
        page.log("warn", "from the getter");
        return 1;
      },
    };
    page.log("log", value);
    assert.deepEqual(
      page.calls.map((call) => [call.level, call.args[0]]),
      [
        ["warn", "from the getter"],
        ["log", value],
      ],
    );
    assert.deepEqual(read(page).messages, [
      { level: "log", kind: "console", text: '{"x":1}', time: read(page).messages[0]?.time },
    ]);
    page.log("info", "after");
    assert.equal(read(page).messages.length, 2);
  });

  it("still passes a call on when its value cannot be formatted at all", () => {
    const page = started();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(page.log("error", proxy), "error returned");
    assert.equal(page.calls.length, 1);
    assert.deepEqual(read(page).messages, []);
    page.log("log", "next");
    assert.equal(read(page).messages.length, 1);
  });

  it("records an uncaught error with its place, when it has one", (t) => {
    t.mock.method(Date, "now", () => 7);
    const page = started();
    page.dispatchEvent(
      errorEvent({ message: "Uncaught boom", filename: `${SITE}/a.js`, lineno: 3, colno: 9 }),
    );
    page.dispatchEvent(errorEvent({ message: "Script error.", filename: "", lineno: 0 }));
    page.dispatchEvent(errorEvent({ message: "No file" }));
    page.dispatchEvent(errorEvent({ message: 1, filename: "x.js" }));
    page.dispatchEvent(new Event("error"));
    assert.deepEqual(read(page).messages, [
      {
        level: "error",
        kind: "uncaught_error",
        text: `Uncaught boom (${SITE}/a.js:3:9)`,
        time: 7,
      },
      { level: "error", kind: "uncaught_error", text: "Script error.", time: 7 },
      { level: "error", kind: "uncaught_error", text: "No file", time: 7 },
    ]);
  });

  it("records an unhandled rejection by its reason", (t) => {
    t.mock.method(Date, "now", () => 8);
    const page = started();
    for (const reason of [new RangeError("Nope"), "plain", { code: 4 }, undefined]) {
      page.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    }
    assert.deepEqual(
      read(page).messages,
      ["RangeError: Nope", "plain", '{"code":4}', "undefined"].map((text) => ({
        level: "error",
        kind: "unhandled_rejection",
        text,
        time: 8,
      })),
    );
  });

  it("does not record an error or rejection raised while a value is formatted", () => {
    const page = started();
    page.log("log", {
      get x() {
        page.dispatchEvent(errorEvent({ message: "inner" }));
        page.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "inner" }));
        return 1;
      },
    });
    assert.deepEqual(
      read(page).messages.map((message) => message.text),
      ['{"x":1}'],
    );
  });

  it("records nothing, and throws nothing, for an event it cannot read", () => {
    const page = started();
    const unreadable = (type: string, key: string) =>
      Object.defineProperty(new Event(type), key, {
        get() {
          throw new Error("unreadable");
        },
      });
    page.log("log", "kept");
    page.dispatchEvent(unreadable("error", "message"));
    page.dispatchEvent(unreadable("unhandledrejection", "reason"));
    page.dispatchEvent(unreadable("pageshow", "persisted"));
    page.log("log", "after");
    assert.deepEqual(
      read(page).messages.map((message) => message.text),
      ["kept", "after"],
    );
  });

  it("sends no reply when it cannot build one", () => {
    const page = new FakePage();
    Object.defineProperty(page, "CustomEvent", {
      value: class {
        constructor() {
          throw new Error("no events");
        }
      },
    });
    recordConsole(SITE, OPTIONS, asPage(page));
    page.log("log", "recorded");
    assert.deepEqual(replies(page), []);
  });

  it("does not record what the page logs while an error or rejection is formatted", () => {
    const page = started();
    const event = new Event("error");
    Object.defineProperty(event, "message", {
      get() {
        page.log("log", "from the message");
        return "boom";
      },
    });
    page.dispatchEvent(event);
    const reason = {
      get x() {
        page.log("log", "from the reason");
        return 1;
      },
    };
    page.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    assert.equal(page.calls.length, 2);
    assert.deepEqual(
      read(page).messages.map((message) => [message.kind, message.text]),
      [
        ["uncaught_error", "boom"],
        ["unhandled_rejection", '{"x":1}'],
      ],
    );
  });

  it("forgets its records when the page comes back from the back-forward cache", () => {
    const page = started({ ...OPTIONS, maxMessages: 1 });
    page.log("log", "first");
    page.log("log", "second");
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    assert.deepEqual(read(page).dropped, 1);
    assert.equal(read(page).messages.length, 1);
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    assert.deepEqual(read(page), { messages: [], dropped: 0 });
    page.log("log", "third");
    assert.deepEqual(
      read(page).messages.map((message) => message.text),
      ["third"],
    );
  });

  it("answers each read with exactly one reply, its detail a JSON string", () => {
    const page = started();
    page.log("log", "hello");
    const details = replies(page);
    assert.equal(details.length, 1);
    assert.equal(typeof details[0], "string");
    assert.deepEqual(JSON.parse(String(details[0])), {
      messages: [
        { level: "log", kind: "console", text: "hello", time: read(page).messages[0]?.time },
      ],
      dropped: 0,
    });
  });

  it("replies with its records even when the page sets toJSON on the prototypes", () => {
    const page = started();
    page.log("log", "kept");
    const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        value: () => "array",
        configurable: true,
      });
      Object.defineProperty(Object.prototype, "toJSON", {
        value: () => "object",
        configurable: true,
      });
      const reply = read(page);
      assert.deepEqual(
        reply.messages.map((message) => message.text),
        ["kept"],
      );
    } finally {
      restore(Array.prototype, "toJSON", arrayToJson);
      restore(Object.prototype, "toJSON", objectToJson);
    }
  });

  it("keeps working when the page replaces the built-ins it uses", () => {
    const page = started({ ...OPTIONS, maxText: 3 });
    const saved = {
      apply: Reflect.apply,
      stringify: JSON.stringify,
      push: Array.prototype.push,
      slice: String.prototype.slice,
    };
    try {
      const broken = () => {
        throw new Error("replaced");
      };
      Reflect.apply = broken;
      JSON.stringify = broken;
      Array.prototype.push = broken;
      String.prototype.slice = broken;
      page.log("log", "abcdef", { a: 1 });
      Array.prototype.push = saved.push;
      String.prototype.slice = saved.slice;
      const details = replies(page);
      Reflect.apply = saved.apply;
      JSON.stringify = saved.stringify;
      assert.deepEqual(
        JSON.parse(String(details[0])).messages.map((message: Recorded) => message.text),
        ["abc"],
      );
    } finally {
      Reflect.apply = saved.apply;
      JSON.stringify = saved.stringify;
      Array.prototype.push = saved.push;
      String.prototype.slice = saved.slice;
    }
  });

  for (const href of [
    "https://b.example/x",
    "https://a.example:8443/",
    "http://a.example/",
    "https://sub.a.example/",
  ]) {
    it(`installs nothing in a document on ${href}`, () => {
      const page = new FakePage(href);
      const before = { ...page.console };
      assert.equal(recordConsole(SITE, OPTIONS, asPage(page)), "elsewhere");
      assert.deepEqual(page.console, before);
      assert.equal(Object.hasOwn(page, "__foxleashConsole"), false);
      page.dispatchEvent(errorEvent({ message: "boom" }));
      assert.deepEqual(replies(page), []);
    });
  }

  for (const href of ["https://a.example./x", "https://a.example:443/", "https://a.example/"]) {
    it(`records in a document on ${href}`, () => {
      const page = started({}, href);
      page.log("log", "here");
      assert.equal(read(page).messages.length, 1);
    });
  }

  it("records on a site with a port", () => {
    const page = new FakePage("http://127.0.0.1:4567/");
    assert.equal(recordConsole("http://127.0.0.1:4567", OPTIONS, asPage(page)), "started");
    page.log("log", "here");
    assert.equal(read(page).messages.length, 1);
  });

  it("starts only once in a document", () => {
    const page = started();
    const wrapped = page.console.log;
    assert.equal(recordConsole(SITE, OPTIONS, asPage(page)), "present");
    assert.equal(page.console.log, wrapped);
    page.log("log", "once");
    assert.equal(page.calls.length, 1);
    assert.equal(replies(page).length, 1);
    assert.equal(read(page).messages.length, 1);
    assert.deepEqual(Object.getOwnPropertyDescriptor(page, "__foxleashConsole"), {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  });

  it("does nothing in a page that set its marker first", () => {
    const page = new FakePage();
    Object.defineProperty(page, "__foxleashConsole", { value: false });
    const before = { ...page.console };
    assert.equal(recordConsole(SITE, OPTIONS, asPage(page)), "present");
    assert.deepEqual(page.console, before);
    assert.deepEqual(replies(page), []);
  });

  it("does nothing in a page where the marker cannot be set", () => {
    const page = new FakePage();
    const before = { ...page.console };
    Object.preventExtensions(page);
    assert.equal(recordConsole(SITE, OPTIONS, asPage(page)), "refused");
    assert.deepEqual(page.console, before);
    assert.deepEqual(replies(page), []);
  });

  it("leaves console methods it cannot replace, and records the rest", () => {
    const page = new FakePage();
    const frozenLog = page.console.log;
    page.console.debug = "not a function";
    Object.defineProperty(page.console, "log", { value: frozenLog, writable: false });
    recordConsole(SITE, OPTIONS, asPage(page));
    assert.equal(page.console.debug, "not a function");
    assert.equal(page.console.log, frozenLog);
    page.log("log", "unrecorded");
    page.log("warn", "recorded");
    page.dispatchEvent(errorEvent({ message: "boom" }));
    assert.deepEqual(
      read(page).messages.map((message) => message.text),
      ["recorded", "boom"],
    );
  });
});

describe("recordConsole from its own text", () => {
  // Firefox runs only the function's own text, so this runs it in a realm with nothing else.
  const MODULE = stripTypeScriptTypes(
    readFileSync(new URL("./console-recorder.ts", import.meta.url), "utf8"),
  ).replace("export function recordConsole", "function recordConsole");
  const FUNCTION = String(vm.runInNewContext(`${MODULE}\nrecordConsole.toString();`));

  it("records and replies in a fresh realm", () => {
    const fresh: unknown = vm.runInNewContext(`(${FUNCTION})`);
    assert.equal(typeof fresh, "function");
    const page = new FakePage();
    assert.equal((fresh as typeof recordConsole)(SITE, OPTIONS, asPage(page)), "started");
    page.log("warn", "from", { a: [1] }, new Error("boom"));
    page.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "late" }));
    const reply = read(page);
    assert.deepEqual(
      reply.messages.map(({ level, kind, text }) => ({ level, kind, text })),
      [
        { level: "warn", kind: "console", text: 'from {"a":[1]} Error: boom' },
        { level: "error", kind: "unhandled_rejection", text: "late" },
      ],
    );
    assert.equal(page.calls.length, 1);
  });
});

function started(options: Partial<RecorderOptions> = {}, href?: string): FakePage {
  const page = new FakePage(href);
  assert.equal(recordConsole(SITE, { ...OPTIONS, ...options }, asPage(page)), "started");
  return page;
}

function asPage(page: FakePage): RecorderPage {
  return page;
}

/** Every reply detail one read event brings. */
function replies(page: FakePage): unknown[] {
  const details: unknown[] = [];
  const listener = (event: Event) => details.push((event as CustomEvent<unknown>).detail);
  page.addEventListener(OPTIONS.replyEvent, listener);
  page.dispatchEvent(new CustomEvent(OPTIONS.readEvent));
  page.removeEventListener(OPTIONS.replyEvent, listener);
  return details;
}

function read(page: FakePage): { messages: Recorded[]; dropped: number } {
  const details = replies(page);
  assert.equal(details.length, 1);
  return JSON.parse(String(details[0]));
}

function errorEvent(fields: { [key: string]: unknown }): Event {
  return Object.assign(new Event("error"), fields);
}

function cyclic(): object {
  const value: { self?: object } = {};
  value.self = value;
  return value;
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
}
