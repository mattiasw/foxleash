import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import {
  createFrameReader,
  encodeFrame,
  FRAME_LIMIT,
  type FrameEvent,
  NATIVE_MESSAGE_LIMIT,
} from "./framing.ts";

const MESSAGE = { type: "request", id: "r1", params: { text: "åäö 🦊" } };

describe("framing constants", () => {
  it("has Firefox's native message cap and the frame cap", () => {
    assert.equal(NATIVE_MESSAGE_LIMIT, 1024 * 1024);
    assert.equal(FRAME_LIMIT, 67_108_864);
  });
});

describe("encodeFrame", () => {
  it("writes the UTF-8 byte length as a little-endian header", () => {
    const json = JSON.stringify("åäö 🦊");
    const frame = encodeFrame(json);
    assert.notEqual(Buffer.byteLength(json), json.length);
    assert.equal(frame.length, 4 + Buffer.byteLength(json));
    assert.equal(frame.readUInt32LE(0), Buffer.byteLength(json));
    assert.equal(frame.subarray(4).toString("utf8"), json);
  });

  it("writes a length above 255 in little-endian byte order", () => {
    const json = JSON.stringify("x".repeat(300));
    assert.deepEqual([...encodeFrame(json).subarray(0, 4)], [0x2e, 0x01, 0, 0]);
  });

  it("encodes an empty string as a bare header", () => {
    assert.deepEqual([...encodeFrame("")], [0, 0, 0, 0]);
  });
});

describe("createFrameReader", () => {
  it("round-trips a frame in one chunk", () => {
    const reader = createFrameReader(FRAME_LIMIT);
    assert.deepEqual(reader.push(encodeFrame(JSON.stringify(MESSAGE))), [
      { ok: true, value: MESSAGE },
    ]);
  });

  it("decodes a frame split at every byte boundary", () => {
    const frame = encodeFrame(JSON.stringify(MESSAGE));
    for (let split = 1; split < frame.length; split += 1) {
      const reader = createFrameReader(FRAME_LIMIT);
      const events = [
        ...reader.push(frame.subarray(0, split)),
        ...reader.push(frame.subarray(split)),
      ];
      assert.deepEqual(events, [{ ok: true, value: MESSAGE }], `split at ${split}`);
    }
  });

  it("decodes a frame fed one byte at a time", () => {
    const frame = encodeFrame(JSON.stringify(MESSAGE));
    const reader = createFrameReader(FRAME_LIMIT);
    const events: FrameEvent[] = [];
    for (const byte of frame) {
      events.push(...reader.push(Buffer.from([byte])));
    }
    assert.deepEqual(events, [{ ok: true, value: MESSAGE }]);
  });

  it("decodes several frames in one chunk, in order", () => {
    const reader = createFrameReader(FRAME_LIMIT);
    const chunk = Buffer.concat([encodeFrame('{"n":1}'), encodeFrame('{"n":2}'), encodeFrame("3")]);
    assert.deepEqual(reader.push(chunk), [
      { ok: true, value: { n: 1 } },
      { ok: true, value: { n: 2 } },
      { ok: true, value: 3 },
    ]);
  });

  it("decodes a body larger than the initial buffer, fed in uneven chunks", () => {
    const value = { text: "å".repeat(200_000) };
    const frame = encodeFrame(JSON.stringify(value));
    const reader = createFrameReader(FRAME_LIMIT);
    const events: FrameEvent[] = [];
    for (let offset = 0; offset < frame.length; offset += 70_001) {
      events.push(...reader.push(frame.subarray(offset, offset + 70_001)));
    }
    assert.deepEqual(events, [{ ok: true, value }]);
  });

  it("reports an oversize frame once, skips its body over several chunks, then reads on", () => {
    const reader = createFrameReader(16);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(40);
    assert.deepEqual(reader.push(header), [
      { ok: false, error: "frame of 40 bytes exceeds the limit of 16" },
    ]);
    assert.deepEqual(reader.push(Buffer.alloc(15, 0x7b)), []);
    assert.deepEqual(reader.push(Buffer.alloc(15, 0x7b)), []);
    assert.deepEqual(reader.push(Buffer.alloc(9, 0x7b)), []);
    assert.deepEqual(reader.push(Buffer.concat([Buffer.alloc(1, 0x7b), encodeFrame("[1]")])), [
      { ok: true, value: [1] },
    ]);
  });

  it("skips an oversize body and decodes the next frame from the same chunk", () => {
    const reader = createFrameReader(16);
    const chunk = Buffer.concat([encodeFrame(JSON.stringify("x".repeat(30))), encodeFrame("{}")]);
    assert.deepEqual(reader.push(chunk), [
      { ok: false, error: "frame of 32 bytes exceeds the limit of 16" },
      { ok: true, value: {} },
    ]);
  });

  it("reads the length as unsigned", () => {
    const reader = createFrameReader(16);
    assert.deepEqual(reader.push(Buffer.from([0xff, 0xff, 0xff, 0xff])), [
      { ok: false, error: "frame of 4294967295 bytes exceeds the limit of 16" },
    ]);
  });

  it("accepts a body of exactly the limit and refuses one byte more", () => {
    const exact = JSON.stringify("x".repeat(14));
    assert.equal(Buffer.byteLength(exact), 16);
    assert.deepEqual(createFrameReader(16).push(encodeFrame(exact)), [
      { ok: true, value: "x".repeat(14) },
    ]);
    const over = JSON.stringify("x".repeat(15));
    assert.deepEqual(createFrameReader(16).push(encodeFrame(over)), [
      { ok: false, error: "frame of 17 bytes exceeds the limit of 16" },
    ]);
  });

  it("reports invalid JSON once and decodes the next frame", () => {
    const reader = createFrameReader(FRAME_LIMIT);
    const chunk = Buffer.concat([encodeFrame("{nope"), encodeFrame("true")]);
    assert.deepEqual(reader.push(chunk), [
      { ok: false, error: "invalid JSON" },
      { ok: true, value: true },
    ]);
  });

  it("reports a 0-length frame as invalid JSON and reads on", () => {
    const reader = createFrameReader(FRAME_LIMIT);
    assert.deepEqual(reader.push(Buffer.concat([encodeFrame(""), encodeFrame("1")])), [
      { ok: false, error: "invalid JSON" },
      { ok: true, value: 1 },
    ]);
  });

  it("reports a body that is not UTF-8 as invalid JSON", () => {
    const reader = createFrameReader(FRAME_LIMIT);
    const frame = Buffer.from([3, 0, 0, 0, 0x22, 0xff, 0x22]);
    assert.deepEqual(reader.push(frame), [{ ok: false, error: "invalid JSON" }]);
  });

  it("reports a body with a leading byte order mark as invalid JSON", () => {
    const reader = createFrameReader(FRAME_LIMIT);
    const body = Buffer.from([0xef, 0xbb, 0xbf, 0x31]);
    assert.deepEqual(reader.push(Buffer.concat([Buffer.from([4, 0, 0, 0]), body])), [
      { ok: false, error: "invalid JSON" },
    ]);
  });

  it("keeps no skipped body bytes", async () => {
    const gc = collectGarbage();
    const reader = createFrameReader(16);
    assert.equal(reader.push(Buffer.from([0xff, 0xff, 0xff, 0xff])).length, 1);
    await gc();
    const before = process.memoryUsage().arrayBuffers;
    for (let index = 0; index < 64; index += 1) {
      assert.deepEqual(reader.push(Buffer.alloc(1024 * 1024)), []);
    }
    await gc();
    assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024);
  });

  it("grows the body buffer with the bytes received, not the length claimed", async () => {
    const gc = collectGarbage();
    const reader = createFrameReader(FRAME_LIMIT);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(FRAME_LIMIT);
    const chunk = Buffer.concat([header, Buffer.alloc(65_537, 0x20)]);
    await gc();
    const before = process.memoryUsage().arrayBuffers;
    assert.deepEqual(reader.push(chunk), []);
    assert.ok(process.memoryUsage().arrayBuffers - before < 4 * 1024 * 1024);
    assert.deepEqual(reader.push(Buffer.alloc(0)), []);
  });

  it("buffers a body fed one byte per chunk without per-chunk overhead", async () => {
    const gc = collectGarbage();
    const text = "y".repeat(256 * 1024 - 2);
    const frame = encodeFrame(JSON.stringify(text));
    const reader = createFrameReader(FRAME_LIMIT);
    await gc();
    const before = used();
    for (let index = 0; index < frame.length - 1; index += 1) {
      assert.deepEqual(reader.push(Buffer.alloc(1, frame[index])), []);
    }
    await gc();
    assert.ok(used() - before < 16 * 1024 * 1024);
    assert.deepEqual(reader.push(Buffer.alloc(1, frame[frame.length - 1])), [
      { ok: true, value: text },
    ]);
  });
});

function collectGarbage(): () => Promise<void> {
  v8.setFlagsFromString("--expose-gc");
  const gc: unknown = vm.runInNewContext("gc");
  assert.ok(typeof gc === "function");
  // V8 frees ArrayBuffer memory on a background thread after a collection: yield so it finishes.
  return async () => {
    gc();
    await setImmediate();
    gc();
    await setImmediate();
  };
}

function used(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}
