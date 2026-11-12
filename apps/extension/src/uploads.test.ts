import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from "@foxleash/protocol";
import { createFakeTimers } from "./fake-browser.ts";
import { ToolError } from "./handlers.ts";
import { createUploads, UPLOAD_IDLE_MS } from "./uploads.ts";

const FULL = base64(new Uint8Array(UPLOAD_CHUNK_BYTES).fill(7));

describe("uploads", () => {
  it("stages chunks in order and returns them joined", () => {
    const { uploads } = setup();
    assert.equal(uploads.add("s1", "u1", 0, base64([1, 2, 3])), 3);
    assert.equal(uploads.add("s1", "u1", 1, base64([4])), 4);
    assert.equal(uploads.add("s1", "u1", 2, base64([5, 6])), 6);
    assert.deepEqual(uploads.take("s1", "u1"), new Uint8Array([1, 2, 3, 4, 5, 6]));
    assert.equal(uploads.take("s1", "u1"), undefined);
  });

  it("decodes every byte value", () => {
    const { uploads } = setup();
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    uploads.add("s1", "u1", 0, base64(all));
    assert.deepEqual(uploads.take("s1", "u1"), all);
  });

  it("refuses a chunk out of order, and a first chunk that is not 0", () => {
    const { uploads } = setup();
    refuses(
      () => uploads.add("s1", "u1", 1, base64([1])),
      "upload_chunk got a chunk out of order; Foxleash expected chunk 0 of that upload.",
    );
    for (const index of [0, 2, "1", 1.5, null]) {
      uploads.add("s1", "u1", 0, base64([1]));
      refuses(
        () => uploads.add("s1", "u1", index, base64([2])),
        "upload_chunk got a chunk out of order; Foxleash expected chunk 1 of that upload.",
      );
      assert.equal(uploads.take("s1", "u1"), undefined, String(index));
    }
    uploads.add("s1", "u1", 0, base64([1]));
    assert.equal(uploads.add("s1", "u1", 1, base64([2])), 2);
  });

  it("drops an upload and its timer when one of its chunks is refused", () => {
    const { uploads, timers } = setup();
    uploads.add("s1", "u1", 0, base64([1]));
    uploads.add("s1", "u2", 0, base64([2]));
    refuses(() => uploads.add("s1", "u1", 1, "AA*A"), "upload_chunk needs data to be base64.");
    assert.equal(timers.pending(), 1);
    assert.equal(uploads.take("s1", "u1"), undefined);
    assert.deepEqual(uploads.take("s1", "u2"), new Uint8Array([2]));
  });

  it("refuses data that is not exact base64", () => {
    const { uploads } = setup();
    for (const data of ["", "AAA", "AA=A", "AA*A", "AAAAA", 12, null, ["AAAA"]]) {
      refuses(() => uploads.add("s1", "u1", 0, data), "upload_chunk needs data to be base64.");
    }
    assert.equal(uploads.take("s1", "u1"), undefined);
  });

  it("refuses a chunk over the chunk size, by its text and by its bytes", () => {
    const { uploads } = setup();
    // The longest text that can hold UPLOAD_CHUNK_BYTES, unpadded, holds one byte more.
    const longest = 4 * Math.ceil(UPLOAD_CHUNK_BYTES / 3);
    refuses(
      () => uploads.add("s1", "u1", 0, "A".repeat(longest)),
      `upload_chunk carries at most ${UPLOAD_CHUNK_BYTES} bytes in one chunk.`,
    );
    refuses(
      () => uploads.add("s1", "u1", 0, "A".repeat(longest + 4)),
      "upload_chunk needs data to be base64.",
    );
    assert.equal(uploads.add("s1", "u1", 0, FULL), UPLOAD_CHUNK_BYTES);
    assert.equal(FULL.length, longest);
  });

  it("refuses an upload id that is not a short string", () => {
    const { uploads } = setup();
    for (const upload of ["", "u".repeat(65), 7, undefined]) {
      refuses(
        () => uploads.add("s1", upload, 0, base64([1])),
        "upload_chunk needs an upload id of 1 to 64 characters.",
      );
    }
    assert.equal(uploads.add("s1", "u".repeat(64), 0, base64([1])), 1);
  });

  it("holds at most 10 MB per session across its uploads", () => {
    const { uploads } = setup();
    const chunks = UPLOAD_MAX_BYTES / UPLOAD_CHUNK_BYTES;
    for (let index = 0; index < chunks - 1; index += 1) uploads.add("s1", "a", index, FULL);
    assert.equal(uploads.add("s1", "b", 0, FULL), UPLOAD_CHUNK_BYTES);
    refuses(
      () => uploads.add("s1", "c", 0, base64([1])),
      "Foxleash holds at most 10 MB of uploads per session; an earlier upload may still be held for up to a minute.",
    );
    assert.equal(uploads.add("s2", "c", 0, base64([1])), 1);
    refuses(() => uploads.add("s1", "b", 1, base64([1])), /at most 10 MB/);
    // Lengths, not the arrays: a failure message holding megabytes of bytes runs out of memory.
    assert.equal(uploads.take("s1", "b")?.length, undefined);
    assert.equal(uploads.add("s1", "c", 0, base64([1])), 1);
  });

  it("frees a refused upload, so the other of two over the cap together finishes", () => {
    const { uploads } = setup();
    for (let index = 0; index < 10; index += 1) {
      uploads.add("s1", "a", index, FULL);
      uploads.add("s1", "b", index, FULL);
    }
    refuses(() => uploads.add("s1", "a", 10, FULL), /at most 10 MB/);
    assert.equal(uploads.add("s1", "b", 10, FULL), 11 * UPLOAD_CHUNK_BYTES);
    assert.equal(uploads.add("s1", "b", 11, FULL), 12 * UPLOAD_CHUNK_BYTES);
    assert.equal(uploads.take("s1", "a")?.length, undefined);
    assert.equal(uploads.take("s1", "b")?.length, 12 * UPLOAD_CHUNK_BYTES);
  });

  it("keeps sessions apart", () => {
    const { uploads } = setup();
    uploads.add("s1", "u1", 0, base64([1]));
    assert.equal(uploads.add("s2", "u1", 0, base64([2, 2])), 2);
    assert.equal(uploads.take("s2", "u1")?.length, 2);
    assert.deepEqual(uploads.take("s1", "u1"), new Uint8Array([1]));
  });

  it("drops a session's uploads and their timers when it ends", () => {
    const { uploads, timers } = setup();
    uploads.add("s1", "u1", 0, base64([1]));
    uploads.add("s1", "u2", 0, base64([2]));
    uploads.add("s2", "u1", 0, base64([3]));
    assert.equal(timers.pending(), 3);
    uploads.endSession("s1");
    assert.equal(timers.pending(), 1);
    assert.equal(uploads.take("s1", "u1"), undefined);
    assert.equal(uploads.take("s1", "u2"), undefined);
    assert.deepEqual(uploads.take("s2", "u1"), new Uint8Array([3]));
    assert.equal(timers.pending(), 0);
    uploads.endSession("s3");
  });

  it("drops an upload 60 s after its last chunk", () => {
    const { uploads, timers } = setup();
    uploads.add("s1", "u1", 0, base64([1]));
    uploads.add("s1", "u2", 0, base64([2]));
    timers.advance(UPLOAD_IDLE_MS - 1);
    assert.equal(uploads.add("s1", "u1", 1, base64([3])), 2);
    timers.advance(1);
    assert.equal(uploads.take("s1", "u2"), undefined);
    assert.equal(uploads.add("s1", "u1", 2, base64([4])), 3);
    timers.advance(UPLOAD_IDLE_MS - 1);
    assert.equal(timers.pending(), 1);
    timers.advance(1);
    assert.equal(timers.pending(), 0);
    assert.equal(uploads.take("s1", "u1"), undefined);
    assert.equal(uploads.add("s1", "u1", 0, base64([4])), 1);
  });

  it("clears the idle timer of an upload it takes, and keeps the session's others", () => {
    const { uploads, timers } = setup();
    uploads.add("s1", "u1", 0, base64([1]));
    uploads.add("s1", "u2", 0, base64([2]));
    uploads.take("s1", "u1");
    assert.equal(timers.pending(), 1);
    assert.deepEqual(uploads.take("s1", "u2"), new Uint8Array([2]));
    assert.equal(timers.pending(), 0);
  });
});

function setup() {
  const timers = createFakeTimers();
  return { timers, uploads: createUploads(timers) };
}

function refuses(action: () => unknown, message: string | RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "invalid_params");
    if (typeof message === "string") assert.equal(error.message, message);
    else assert.match(error.message, message);
    return true;
  });
}

function base64(bytes: ArrayLike<number>): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}
