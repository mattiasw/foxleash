import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { createLog } from "./log.ts";

describe("createLog", () => {
  it("writes the prefix and the message as one line", () => {
    const { stream, chunks } = collector();
    createLog("[foxleash host]", stream)("listening");
    assert.deepEqual(chunks, ["[foxleash host] listening\n"]);
  });

  it("treats an explicit undefined detail as no detail", () => {
    const { stream, chunks } = collector();
    createLog("p", stream)("m", undefined);
    assert.deepEqual(chunks, ["p m\n"]);
  });

  it("appends the detail as JSON", () => {
    const { stream, chunks } = collector();
    const log = createLog("p", stream);
    log("m", { id: "a" });
    log("m", "text");
    log("m", null);
    log("m", 0);
    assert.deepEqual(chunks, ['p m {"id":"a"}\n', 'p m "text"\n', "p m null\n", "p m 0\n"]);
  });

  it("escapes a newline in the detail, so the entry stays one line", () => {
    const { stream, chunks } = collector();
    createLog("p", stream)("m", "a\nb\r\x1b[31m");
    assert.deepEqual(chunks, ['p m "a\\nb\\r\\u001b[31m"\n']);
  });

  it("escapes line separators, C1 controls and format characters", () => {
    const { stream, chunks } = collector();
    const codePoints = [0x2028, 0x2029, 0x85, 0x9b, 0x7f, 0x202e, 0x200b, 0xfeff, 0xe0001];
    const detail = `x${codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join("y")}z`;
    createLog("p", stream)("m", detail);
    assert.equal(chunks.length, 1);
    const line = chunks[0] ?? "";
    const escapes = ["2028", "2029", "0085", "009b", "007f", "202e", "200b", "feff"]
      .map((hex) => `\\u${hex}`)
      .concat(["\\udb40\\udc01"]);
    assert.equal(line, `p m "x${escapes.join("y")}z"\n`);
    for (const codePoint of codePoints) {
      assert.ok(!line.includes(String.fromCodePoint(codePoint)), codePoint.toString(16));
    }
    assert.equal(JSON.parse(line.slice("p m ".length)), detail);
  });

  it("leaves ordinary non-ASCII text as it is", () => {
    const { stream, chunks } = collector();
    createLog("p", stream)("m", "åäö 🦊");
    assert.deepEqual(chunks, ['p m "åäö 🦊"\n']);
  });

  it("writes [unserializable] for a detail JSON cannot represent, without throwing", () => {
    const { stream, chunks } = collector();
    const log = createLog("p", stream);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    log("m", 1n);
    log("m", cyclic);
    log("m", () => 1);
    log("m", Symbol("s"));
    assert.deepEqual(chunks, Array(4).fill("p m [unserializable]\n"));
  });

  it("writes to stderr by default", (t) => {
    const chunks: unknown[] = [];
    t.mock.method(process.stderr, "write", (chunk: unknown) => {
      chunks.push(chunk);
      return true;
    });
    createLog("x")("m");
    t.mock.restoreAll();
    assert.deepEqual(chunks, ["x m\n"]);
  });
});

function collector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, chunks };
}
