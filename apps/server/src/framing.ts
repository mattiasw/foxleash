// Firefox's cap on a message from a native host to the extension.
export const NATIVE_MESSAGE_LIMIT = 1_048_576;
export const FRAME_LIMIT = 64 * 1024 * 1024;

const HEADER_SIZE = 4;
const INITIAL_BODY_CAPACITY = 65_536;

export type FrameEvent = { ok: true; value: unknown } | { ok: false; error: string };

export interface FrameReader {
  push(chunk: Buffer): FrameEvent[];
}

export function encodeFrame(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, HEADER_SIZE);
  return frame;
}

export function createFrameReader(limit: number): FrameReader {
  const header = Buffer.alloc(HEADER_SIZE);
  let headerFilled = 0;
  let state: "header" | "body" | "discard" = "header";
  let length = 0;
  let remaining = 0;
  let body: Buffer | undefined;
  let bodyFilled = 0;

  return {
    push(chunk: Buffer): FrameEvent[] {
      const events: FrameEvent[] = [];
      let offset = 0;
      while (offset < chunk.length) {
        if (state === "header") {
          const count = Math.min(HEADER_SIZE - headerFilled, chunk.length - offset);
          chunk.copy(header, headerFilled, offset, offset + count);
          headerFilled += count;
          offset += count;
          if (headerFilled < HEADER_SIZE) {
            break;
          }
          headerFilled = 0;
          length = header.readUInt32LE(0);
          if (length > limit) {
            events.push({
              ok: false,
              error: `frame of ${length} bytes exceeds the limit of ${limit}`,
            });
            state = "discard";
            remaining = length;
          } else if (length === 0) {
            events.push(decode(Buffer.alloc(0)));
          } else {
            state = "body";
            bodyFilled = 0;
          }
        } else if (state === "discard") {
          const count = Math.min(remaining, chunk.length - offset);
          remaining -= count;
          offset += count;
          if (remaining === 0) {
            state = "header";
          }
        } else {
          if (body === undefined) {
            body = Buffer.allocUnsafe(Math.min(length, INITIAL_BODY_CAPACITY));
          } else if (bodyFilled === body.length) {
            const grown = Buffer.allocUnsafe(Math.min(2 * body.length, length));
            body.copy(grown, 0, 0, bodyFilled);
            body = grown;
          }
          const count = Math.min(body.length - bodyFilled, chunk.length - offset);
          chunk.copy(body, bodyFilled, offset, offset + count);
          bodyFilled += count;
          offset += count;
          if (bodyFilled === length) {
            events.push(decode(body));
            body = undefined;
            state = "header";
          }
        }
      }
      return events;
    },
  };
}

// fatal: bytes that are not UTF-8 are invalid JSON (RFC 8259 section 8.1), not U+FFFD.
// ignoreBOM: a leading BOM stays in the text, so JSON.parse refuses it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(body: Buffer): FrameEvent {
  try {
    const value: unknown = JSON.parse(decoder.decode(body));
    return { ok: true, value };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}
