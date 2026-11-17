// No value is kept: a body carries what protected fields hold (ADR 0010, 0021). No length or count
// of a value either: an agent that can add to a field could read one off any edge (ADR 0067).
import {
  MAX_NETWORK_BODY_DEPTH,
  MAX_NETWORK_BODY_FIELDS,
  NETWORK_BODY_ELEMENT,
  NETWORK_BODY_NAME,
  NETWORK_BODY_NAME_WITHHELD,
  type NetworkBody,
  type NetworkBodyField,
} from "@foxleash/protocol";
import type { RequestBody, UploadChunk } from "./browser-api.ts";
import { isRecord } from "./page-messages.ts";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

type Container = Record<string, unknown> | unknown[];

interface FieldNode {
  field: NetworkBodyField;
  children: FieldNode[];
}

/** A container whose entries are still to be walked, at `depth`. */
interface Pending {
  children: FieldNode[];
  entries: [string, unknown][];
  depth: number;
}

/** The shape of Firefox's requestBody: names, kinds and whether each is filled, never a value. */
export function bodyShape(body: RequestBody | null | undefined): NetworkBody | undefined {
  if (body === null || body === undefined) return undefined;
  if (body.formData !== undefined) return formShape(body.formData);
  if (body.raw !== undefined) return rawShape(body.raw);
  return { kind: "other" };
}

function formShape(formData: Record<string, (string | undefined)[]>): NetworkBody {
  const entries: [string, string[]][] = [];
  for (const [name, values] of Object.entries(formData)) {
    // Firefox's trace of an empty part, as a leading `&` or `&&` leaves.
    if (name === "" && values.every((value) => value === undefined)) continue;
    if (!values.every(isText)) return { kind: "other" };
    if (/^[{[]/.test(name.trimStart())) return { kind: "other" };
    if (values.length > 0) entries.push([name, values]);
  }
  // Body text that is not a form, such as a token with `=` padding and maybe a line break after:
  // Firefox gives it as one name.
  const [only] = entries;
  if (entries.length === 1 && only?.[1].length === 1 && only[1][0]?.trim() === "") {
    return { kind: "other" };
  }
  const fields: NetworkBodyField[] = [];
  let truncated = false;
  // A name's first value only, as of a JSON array: an array sent as a form repeats a name.
  for (const [name, [value = ""]] of listed(entries)) {
    if (fields.length === MAX_NETWORK_BODY_FIELDS) {
      truncated = true;
      break;
    }
    fields.push({
      name,
      depth: 1,
      kind: "text",
      filled: value.length > 0,
    });
  }
  return truncated ? { kind: "form", fields, truncated } : { kind: "form", fields };
}

function isText(value: string | undefined): value is string {
  return typeof value === "string";
}

/**
 * The entries to list: of names that differ only in indices in brackets (an array as a form sends
 * it: `a[0]`, `a[1]`) the first only, whatever their lengths, and one withheld entry, at the
 * first, for all the names shownName refuses. Their count could follow a value.
 */
function listed<Value>(entries: Iterable<[string, Value]>): [string, Value][] {
  const seen = new Set<string>();
  const kept: [string, Value][] = [];
  let withheld = false;
  for (const [name, value] of entries) {
    const key = name.replace(/\[\d+\]/g, "[]");
    if (seen.has(key)) continue;
    seen.add(key);
    if (shownName(name)) kept.push([name, value]);
    else if (!withheld) {
      withheld = true;
      kept.push([NETWORK_BODY_NAME_WITHHELD, value]);
    }
  }
  return kept;
}

/** Names are withheld, never cut: a cut keeps the start of whatever was there. */
function shownName(name: string): boolean {
  return NETWORK_BODY_NAME.test(name);
}

function rawShape(raw: readonly UploadChunk[]): NetworkBody {
  const chunks: ArrayBuffer[] = [];
  let cut = false;
  for (const chunk of raw) {
    // A file stream: Firefox gives no bytes, and its `file` is never read.
    if (chunk.bytes === undefined) return { kind: "other" };
    chunks.push(chunk.bytes);
    if (chunk.truncated === true) cut = true;
  }
  const total = chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  // A cut prefix can parse as JSON the whole does not.
  const json = cut ? undefined : parsedJson(chunks, total);
  if (json === undefined) return { kind: "other", filled: total > 0 };
  return jsonShape(json);
}

function parsedJson(chunks: readonly ArrayBuffer[], total: number): Container | undefined {
  try {
    const value: unknown = JSON.parse(UTF8.decode(joined(chunks, total)));
    return Array.isArray(value) || isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function joined(chunks: readonly ArrayBuffer[], total: number): ArrayBuffer | Uint8Array {
  const [first] = chunks;
  if (chunks.length === 1 && first !== undefined) return first;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Chooses fields breadth-first, so a large early object cannot hide later keys, and lists them
 * depth-first, each followed by its children.
 */
function jsonShape(root: Container): NetworkBody {
  const top: FieldNode[] = [];
  const queue: Pending[] = [{ children: top, entries: entriesOf(root), depth: 1 }];
  let chosen = 0;
  let truncated = false;
  walk: for (const { children, entries, depth } of queue) {
    for (const [name, value] of entries) {
      if (chosen === MAX_NETWORK_BODY_FIELDS) {
        truncated = true;
        break walk;
      }
      chosen += 1;
      const node: FieldNode = { field: { name, depth, kind: "null" }, children: [] };
      children.push(node);
      if (Array.isArray(value) || isRecord(value)) {
        const inner = entriesOf(value);
        node.field = {
          name,
          depth,
          kind: Array.isArray(value) ? "array" : "object",
          filled: inner.length > 0,
        };
        if (inner.length === 0) continue;
        if (depth === MAX_NETWORK_BODY_DEPTH) truncated = true;
        else queue.push({ children: node.children, entries: inner, depth: depth + 1 });
      } else if (typeof value === "string") {
        node.field = { name, depth, kind: "string", filled: value.length > 0 };
      } else if (value !== null) {
        node.field = { name, depth, kind: typeof value === "number" ? "number" : "boolean" };
      }
    }
  }
  const fields: NetworkBodyField[] = [];
  flatten(top, fields);
  return truncated ? { kind: "json", fields, truncated } : { kind: "json", fields };
}

/** An object's keys as listed() keeps them; an array's first element only. */
function entriesOf(container: Container): [string, unknown][] {
  if (Array.isArray(container)) {
    return container.length === 0 ? [] : [[NETWORK_BODY_ELEMENT, container[0]]];
  }
  return listed(Object.entries(container));
}

function flatten(nodes: readonly FieldNode[], fields: NetworkBodyField[]): void {
  for (const { field, children } of nodes) {
    fields.push(field);
    flatten(children, fields);
  }
}
