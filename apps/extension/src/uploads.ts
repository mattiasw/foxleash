import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from "@foxleash/protocol";
import type { Timers } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { BASE64 } from "./screenshot.ts";

/** The bytes upload_chunk stages for upload_file, per session and upload id. */
export interface Uploads {
  /** Stages one chunk and returns the bytes staged for that upload so far. */
  add(session: string, upload: unknown, index: unknown, data: unknown): number;
  /** Removes the upload's bytes and returns them, or undefined when none are staged. */
  take(session: string, upload: string): Uint8Array | undefined;
  endSession(session: string): void;
}

/** An upload that gets no chunk and is not taken for this long is dropped. */
export const UPLOAD_IDLE_MS = 60_000;

const MAX_UPLOAD_ID = 64;
const MAX_CHUNK_CHARS = 4 * Math.ceil(UPLOAD_CHUNK_BYTES / 3);

interface Staged<Handle> {
  chunks: Uint8Array[];
  bytes: number;
  next: number;
  timer: Handle;
}

export function createUploads<Handle>(timers: Timers<Handle>): Uploads {
  const sessions = new Map<string, Map<string, Staged<Handle>>>();
  return { add, take, endSession };

  function add(session: string, upload: unknown, index: unknown, data: unknown): number {
    if (typeof upload !== "string" || upload === "" || upload.length > MAX_UPLOAD_ID) {
      throw new ToolError(
        "invalid_params",
        `upload_chunk needs an upload id of 1 to ${MAX_UPLOAD_ID} characters.`,
      );
    }
    const uploads = sessions.get(session) ?? new Map<string, Staged<Handle>>();
    const staged = uploads.get(upload);
    let bytes: Uint8Array;
    try {
      bytes = checkedChunk(uploads, staged, index, data);
    } catch (error: unknown) {
      // The server stops an upload at its first refused chunk, so what it staged is freed.
      if (staged !== undefined) {
        timers.clearTimeout(staged.timer);
        drop(session, uploads, upload);
      }
      throw error;
    }
    if (staged === undefined) {
      uploads.set(upload, {
        chunks: [bytes],
        bytes: bytes.length,
        next: 1,
        timer: idleTimer(session, upload),
      });
      sessions.set(session, uploads);
      return bytes.length;
    }
    timers.clearTimeout(staged.timer);
    staged.chunks.push(bytes);
    staged.bytes += bytes.length;
    staged.next += 1;
    staged.timer = idleTimer(session, upload);
    return staged.bytes;
  }

  function take(session: string, upload: string): Uint8Array | undefined {
    const uploads = sessions.get(session);
    const staged = uploads?.get(upload);
    if (uploads === undefined || staged === undefined) return undefined;
    timers.clearTimeout(staged.timer);
    drop(session, uploads, upload);
    const joined = new Uint8Array(staged.bytes);
    let offset = 0;
    for (const chunk of staged.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return joined;
  }

  function endSession(session: string): void {
    for (const staged of sessions.get(session)?.values() ?? []) timers.clearTimeout(staged.timer);
    sessions.delete(session);
  }

  function idleTimer(session: string, upload: string): Handle {
    return timers.setTimeout(() => {
      const uploads = sessions.get(session);
      if (uploads !== undefined) drop(session, uploads, upload);
    }, UPLOAD_IDLE_MS);
  }

  function drop(session: string, uploads: Map<string, Staged<Handle>>, upload: string): void {
    uploads.delete(upload);
    if (uploads.size === 0) sessions.delete(session);
  }
}

/** The chunk's bytes, when it is the one the upload expects next and fits the session's cap. */
function checkedChunk<Handle>(
  uploads: ReadonlyMap<string, Staged<Handle>>,
  staged: Staged<Handle> | undefined,
  index: unknown,
  data: unknown,
): Uint8Array {
  const expected = staged?.next ?? 0;
  if (index !== expected) {
    throw new ToolError(
      "invalid_params",
      `upload_chunk got a chunk out of order; Foxleash expected chunk ${expected} of that upload.`,
    );
  }
  const bytes = decodeChunk(data);
  let held = 0;
  for (const other of uploads.values()) held += other.bytes;
  if (held + bytes.length > UPLOAD_MAX_BYTES) {
    throw new ToolError(
      "invalid_params",
      "Foxleash holds at most 10 MB of uploads per session; an earlier upload may still be held for up to a minute.",
    );
  }
  return bytes;
}

/** The chunk's bytes from exact base64 of at most UPLOAD_CHUNK_BYTES bytes. */
function decodeChunk(data: unknown): Uint8Array {
  if (
    typeof data !== "string" ||
    data.length > MAX_CHUNK_CHARS ||
    data.length % 4 !== 0 ||
    !BASE64.test(data)
  ) {
    throw new ToolError("invalid_params", "upload_chunk needs data to be base64.");
  }
  // Not Uint8Array.fromBase64, which Node 24 lacks.
  const text = atob(data);
  if (text.length > UPLOAD_CHUNK_BYTES) {
    throw new ToolError(
      "invalid_params",
      `upload_chunk carries at most ${UPLOAD_CHUNK_BYTES} bytes in one chunk.`,
    );
  }
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
