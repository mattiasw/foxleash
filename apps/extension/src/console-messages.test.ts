import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CONSOLE_MESSAGES, MAX_CONSOLE_TEXT } from "@foxleash/protocol";
import {
  CONSOLE_READ_EVENT,
  CONSOLE_RECORDS_EVENT,
  parseConsoleResult,
  parseRecorderReply,
  RECORDER_OPTIONS,
  readConsoleRecords,
} from "./console-messages.ts";
import { type RecorderPage, recordConsole } from "./console-recorder.ts";
import { MAX_PAGE_REPLY_CHARS } from "./page-messages.ts";

const MESSAGE = { level: "warn", kind: "console", text: "careful", time: 1700000000000.5 };

describe("RECORDER_OPTIONS", () => {
  it("names the events and the protocol's limits", () => {
    assert.deepEqual(RECORDER_OPTIONS, {
      maxMessages: MAX_CONSOLE_MESSAGES,
      maxText: MAX_CONSOLE_TEXT,
      readEvent: CONSOLE_READ_EVENT,
      replyEvent: CONSOLE_RECORDS_EVENT,
    });
    assert.equal(CONSOLE_READ_EVENT, "foxleash-console-read");
    assert.equal(CONSOLE_RECORDS_EVENT, "foxleash-console-records");
  });
});

describe("readConsoleRecords", () => {
  it("returns what the page's recorder recorded", (t) => {
    t.mock.method(Date, "now", () => 42);
    const page = recordedPage();
    page.console.error("one", 2);
    assert.deepEqual(readConsoleRecords(page), {
      recording: true,
      messages: [{ level: "error", kind: "console", text: "one 2", time: 42 }],
      dropped: 0,
    });
  });

  it("says the page is not recorded when nothing replies", () => {
    assert.deepEqual(readConsoleRecords(new EventTarget()), {
      recording: false,
      messages: [],
      dropped: 0,
    });
  });

  it("keeps only the first reply", () => {
    const page = new EventTarget();
    page.addEventListener(CONSOLE_READ_EVENT, () => {
      page.dispatchEvent(reply({ messages: [MESSAGE], dropped: 1 }));
      page.dispatchEvent(reply({ messages: [], dropped: 0 }));
    });
    assert.deepEqual(readConsoleRecords(page), {
      recording: true,
      messages: [MESSAGE],
      dropped: 1,
    });
  });

  it("removes its listener, also when the read throws", () => {
    const page = new EventTarget();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const target = {
      addEventListener: (type: string, listener: unknown) => added.push([type, listener]),
      removeEventListener: (type: string, listener: unknown) => removed.push([type, listener]),
      dispatchEvent: (event: Event) => page.dispatchEvent(event),
    };
    readConsoleRecords(target);
    assert.equal(added.length, 1);
    assert.deepEqual(removed, added);
    assert.equal((added[0] as unknown[])[0], CONSOLE_RECORDS_EVENT);

    const failing = {
      ...target,
      dispatchEvent: () => {
        throw new Error("dispatch failed");
      },
    };
    assert.throws(() => readConsoleRecords(failing), /dispatch failed/);
    assert.equal(removed.length, 2);
    assert.deepEqual(removed[1], added[1]);
  });

  it("throws on a reply it cannot read, and on a detail that cannot be read", () => {
    const page = new EventTarget();
    page.addEventListener(CONSOLE_READ_EVENT, () => page.dispatchEvent(reply("not json")));
    assert.throws(() => readConsoleRecords(page), /cannot be read/);

    const guarded = new EventTarget();
    guarded.addEventListener(CONSOLE_READ_EVENT, () => {
      const event = new Event(CONSOLE_RECORDS_EVENT);
      Object.defineProperty(event, "detail", {
        get() {
          throw new Error("Permission denied");
        },
      });
      guarded.dispatchEvent(event);
    });
    assert.throws(() => readConsoleRecords(guarded), /cannot be read/);
  });

  it("does not take a reply sent outside its own read", () => {
    const page = new EventTarget();
    page.dispatchEvent(reply({ messages: [MESSAGE], dropped: 0 }));
    assert.equal(readConsoleRecords(page).recording, false);
  });
});

describe("parseRecorderReply", () => {
  it("reads the recorder's JSON as a recording result", () => {
    assert.deepEqual(parseRecorderReply(JSON.stringify({ messages: [MESSAGE], dropped: 3 })), {
      recording: true,
      messages: [MESSAGE],
      dropped: 3,
    });
  });

  it("refuses anything but a JSON string of a record", () => {
    for (const detail of [
      null,
      1,
      { messages: [], dropped: 0 },
      "{",
      "[]",
      "null",
      '"text"',
      JSON.stringify({ messages: [], dropped: -1 }),
      JSON.stringify({ messages: [{ ...MESSAGE, level: "fatal" }], dropped: 0 }),
    ]) {
      assert.equal(parseRecorderReply(detail), undefined, String(detail));
    }
  });

  it("refuses a string longer than the background's cap before parsing it", () => {
    const json = JSON.stringify({ messages: [], dropped: 0 });
    const longest = json + " ".repeat(MAX_PAGE_REPLY_CHARS - json.length);
    assert.equal(parseRecorderReply(longest)?.recording, true);
    assert.equal(parseRecorderReply(`${longest} `), undefined);
  });

  it("reads only the reply's own fields", () => {
    const json = '{"__proto__":{"messages":[],"dropped":0}}';
    assert.equal(parseRecorderReply(json), undefined);
  });
});

describe("parseConsoleResult", () => {
  const valid = { recording: true, messages: [MESSAGE], dropped: 0 };

  it("returns a fresh result with only the known fields", () => {
    const result = parseConsoleResult({
      ...valid,
      extra: 1,
      messages: [{ ...MESSAGE, extra: "page text" }],
    });
    assert.deepEqual(result, valid);
    assert.notEqual(result?.messages[0], valid.messages[0]);
  });

  it("takes every level and kind", () => {
    for (const level of ["debug", "log", "info", "warn", "error"]) {
      for (const kind of ["console", "uncaught_error", "unhandled_rejection"]) {
        const message = { ...MESSAGE, level, kind };
        assert.deepEqual(parseConsoleResult({ ...valid, messages: [message] }), {
          ...valid,
          messages: [message],
        });
      }
    }
  });

  it("takes a result that is not recording, and the largest dropped count", () => {
    const result = { recording: false, messages: [], dropped: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(parseConsoleResult(result), result);
  });

  it("refuses a result of the wrong shape", () => {
    const cases: unknown[] = [
      undefined,
      null,
      "text",
      [],
      { ...valid, recording: "yes" },
      { messages: [MESSAGE], dropped: 0 },
      { ...valid, dropped: -1 },
      { ...valid, dropped: 1.5 },
      { ...valid, dropped: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, dropped: "0" },
      { ...valid, messages: undefined },
      { ...valid, messages: { 0: MESSAGE, length: 1 } },
      { ...valid, messages: [null] },
      { ...valid, messages: [[]] },
      { ...valid, messages: [{ ...MESSAGE, level: "fatal" }] },
      { ...valid, messages: [{ ...MESSAGE, level: "toString" }] },
      { ...valid, messages: [{ ...MESSAGE, kind: "warning" }] },
      { ...valid, messages: [{ ...MESSAGE, text: 1 }] },
      { ...valid, messages: [{ ...MESSAGE, time: "1" }] },
      { ...valid, messages: [{ ...MESSAGE, time: Number.NaN }] },
      { ...valid, messages: [{ ...MESSAGE, time: Number.POSITIVE_INFINITY }] },
      { ...valid, messages: [{ ...MESSAGE, time: Number.NEGATIVE_INFINITY }] },
      { ...valid, messages: holed() },
    ];
    for (const value of cases) {
      assert.equal(parseConsoleResult(value), undefined, JSON.stringify(value));
    }
  });

  it("reads only own fields", () => {
    assert.equal(parseConsoleResult(Object.create(valid)), undefined);
    assert.equal(parseConsoleResult({ ...valid, messages: [Object.create(MESSAGE)] }), undefined);
    for (const [key, value] of Object.entries(MESSAGE)) {
      const inherited: object = Object.assign(
        Object.create({ [key]: value }),
        Object.fromEntries(Object.entries(MESSAGE).filter(([other]) => other !== key)),
      );
      assert.equal(parseConsoleResult({ ...valid, messages: [inherited] }), undefined, key);
    }
  });

  it("takes at most MAX_CONSOLE_MESSAGES messages, counting before reading any", () => {
    const most = Array.from({ length: MAX_CONSOLE_MESSAGES }, () => MESSAGE);
    assert.equal(parseConsoleResult({ ...valid, messages: most })?.messages.length, 300);
    const read: number[] = [];
    const tooMany = new Proxy([...most, MESSAGE], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) read.push(Number(key));
        return Reflect.get(target, key, receiver);
      },
    });
    assert.equal(parseConsoleResult({ ...valid, messages: tooMany }), undefined);
    assert.deepEqual(read, []);
  });

  it("cuts an over-long text again without splitting a surrogate pair", () => {
    const long = { ...MESSAGE, text: `${"a".repeat(MAX_CONSOLE_TEXT - 1)}\u{1F600}b` };
    const exact = { ...MESSAGE, text: "a".repeat(MAX_CONSOLE_TEXT) };
    assert.deepEqual(parseConsoleResult({ ...valid, messages: [long, exact] })?.messages, [
      { ...MESSAGE, text: "a".repeat(MAX_CONSOLE_TEXT - 1) },
      exact,
    ]);
  });

  it("keeps the largest reply under the background's cap as JSON", () => {
    // Every character of the text escapes to six as JSON.
    const messages = Array.from({ length: MAX_CONSOLE_MESSAGES }, () => ({
      level: "error",
      kind: "unhandled_rejection",
      text: "\u0001".repeat(MAX_CONSOLE_TEXT),
      time: -Number.MAX_VALUE,
    }));
    const result = parseConsoleResult({
      recording: true,
      messages,
      dropped: Number.MAX_SAFE_INTEGER,
    });
    assert.ok(result !== undefined);
    const reply = { ok: true, site: `https://${"a".repeat(292)}`, result };
    assert.equal(reply.site.length, 300);
    assert.ok(JSON.stringify(reply).length < MAX_PAGE_REPLY_CHARS);
  });
});

/** A page with Foxleash's recorder running in it, with a console that does nothing. */
function recordedPage(): EventTarget & { console: { error(...args: unknown[]): void } } {
  const target = new EventTarget();
  const page = Object.assign(target, {
    location: { protocol: "https:", hostname: "a.example", port: "" },
    console: { debug() {}, log() {}, info() {}, warn() {}, error(..._args: unknown[]) {} },
    CustomEvent,
    Error,
  });
  const recorderPage: RecorderPage = page;
  recordConsole("https://a.example", RECORDER_OPTIONS, recorderPage);
  return page;
}

/** Two messages with a hole before them, as a structured clone can carry. */
function holed(): unknown[] {
  const messages: unknown[] = new Array(2);
  messages[1] = MESSAGE;
  return messages;
}

function reply(detail: unknown): CustomEvent<unknown> {
  return new CustomEvent(CONSOLE_RECORDS_EVENT, {
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
  });
}
