import type { ConsoleKind, ConsoleLevel } from "@foxhand/protocol";

export interface RecorderOptions {
  maxMessages: number;
  maxText: number;
  /** The event the content script dispatches on the window to read the records. */
  readEvent: string;
  /** The event the recorder answers with; its detail is the records as a JSON string. */
  replyEvent: string;
}

/** What `recordConsole` did in the document it ran in. */
export type RecorderStatus = "started" | "present" | "elsewhere" | "refused";

/** What the recorder reads from the page's global. */
export interface RecorderPage {
  location: { protocol: string; hostname: string; port: string };
  console: Record<ConsoleLevel, unknown>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  CustomEvent: typeof CustomEvent;
  Error: ErrorConstructor;
}

/**
 * Records what the page writes to its console, its uncaught errors and its unhandled promise
 * rejections, in the page's own memory, and answers `options.readEvent` with them. Runs in the
 * page's main world, once per document, and does nothing in a document that is not on `site`.
 *
 * `scripting.executeScript` serializes this function with `toString()`, so everything it uses
 * lives inside it. Everything it calls after it starts is captured first, so a page that later
 * replaces a built-in cannot change what it does beyond its own records.
 *
 * Returns `"started"` when it started the recorder, `"present"` when the document already had
 * one, `"elsewhere"` in a document not on `site`, and `"refused"` when the page would not take
 * the marker.
 */
export function recordConsole(
  site: string,
  options: RecorderOptions,
  page: RecorderPage = globalThis,
): RecorderStatus {
  const where = page.location;
  // The site as `siteOf` in site.ts writes it: scheme, host without a trailing dot, port.
  const host = where.hostname.endsWith(".") ? where.hostname.slice(0, -1) : where.hostname;
  if (`${where.protocol}//${host}${where.port === "" ? "" : `:${where.port}`}` !== site)
    return "elsewhere";
  if (Object.hasOwn(page, "__foxhandConsole")) return "present";
  try {
    // Exactly { value: true }: Firefox's WindowProxy can throw on an explicit configurable: false.
    Object.defineProperty(page, "__foxhandConsole", { value: true });
  } catch {
    return "refused";
  }

  const apply = Reflect.apply;
  const stringify = JSON.stringify;
  const now = Date.now;
  const objectToString = Object.prototype.toString;
  const create = Object.create;
  const defineProperty = Object.defineProperty;
  const isView = ArrayBuffer.isView;
  const toText = String;
  const slice = String.prototype.slice;
  const charCodeAt = String.prototype.charCodeAt;
  const push = Array.prototype.push;
  const shift = Array.prototype.shift;
  const PageCustomEvent = page.CustomEvent;
  const dispatch = page.dispatchEvent;
  const PageError = page.Error;
  const pageConsole = page.console;
  const { maxMessages, maxText, readEvent, replyEvent } = options;

  const records: Record<string, unknown>[] = [];
  // Without it, JSON.stringify would use a toJSON the page sets on Array.prototype.
  defineProperty(records, "toJSON", { value: undefined });
  let dropped = 0;
  // Set while a record is made: formatting runs page code, which may log in turn.
  let busy = false;

  replace("debug");
  replace("log");
  replace("info");
  replace("warn");
  replace("error");

  page.addEventListener("error", (event) => {
    if (busy) return;
    busy = true;
    try {
      const message = fieldOf(event, "message");
      const filename = fieldOf(event, "filename");
      // Only an ErrorEvent carries a message; a resource that failed to load does not.
      if (typeof message === "string") {
        const text =
          typeof filename === "string" && filename !== ""
            ? `${message} (${filename}:${toText(fieldOf(event, "lineno"))}:${toText(fieldOf(event, "colno"))})`
            : message;
        record("error", "uncaught_error", text);
      }
    } catch {
      // Recording never throws into the page.
    } finally {
      busy = false;
    }
  });

  page.addEventListener("unhandledrejection", (event) => {
    if (busy) return;
    busy = true;
    try {
      record("error", "unhandled_rejection", describe(fieldOf(event, "reason")));
    } catch {
      // Recording never throws into the page.
    } finally {
      busy = false;
    }
  });

  page.addEventListener("pageshow", (event) => {
    try {
      // Back from the back-forward cache: what it recorded before belongs to its earlier life.
      if (fieldOf(event, "persisted") === true) {
        records.length = 0;
        dropped = 0;
      }
    } catch {
      // Recording never throws into the page.
    }
  });

  page.addEventListener(readEvent, () => {
    try {
      const reply: Record<string, unknown> = create(null);
      reply.messages = records;
      reply.dropped = dropped;
      const init: Record<string, unknown> = create(null);
      // A string: it crosses into the content script's world as it is, unlike an object.
      init.detail = stringify(reply);
      apply(dispatch, page, [new PageCustomEvent(replyEvent, init)]);
    } catch {
      // The content script then hears no reply.
    }
  });

  return "started";

  function replace(level: ConsoleLevel): void {
    try {
      const original = pageConsole[level];
      if (typeof original === "function") {
        pageConsole[level] = wrap(level, original as (...args: unknown[]) => unknown);
      }
    } catch {
      // A console method the page froze or guarded is left as it is.
    }
  }

  function wrap(level: ConsoleLevel, original: (...args: unknown[]) => unknown) {
    return function (this: unknown, ...args: unknown[]): unknown {
      if (!busy) {
        busy = true;
        try {
          record(level, "console", textOf(args));
        } catch {
          // Recording never throws into the page.
        } finally {
          busy = false;
        }
      }
      return apply(original, this, args);
    };
  }

  function fieldOf(event: Event, key: string): unknown {
    return (event as unknown as Record<string, unknown>)[key];
  }

  function record(level: ConsoleLevel, kind: ConsoleKind, text: string): void {
    const entry: Record<string, unknown> = create(null);
    entry.level = level;
    entry.kind = kind;
    entry.text = cut(text);
    entry.time = now();
    apply(push, records, [entry]);
    if (records.length > maxMessages) {
      apply(shift, records, []);
      dropped += 1;
    }
  }

  /** The arguments as text, one space apart; formatting stops once the text is long enough. */
  function textOf(args: unknown[]): string {
    let text = "";
    for (let index = 0; index < args.length && text.length <= maxText; index += 1) {
      const part = describe(args[index]);
      text = index === 0 ? part : `${text} ${part}`;
    }
    return text;
  }

  /** At most maxText UTF-16 units, without splitting a surrogate pair. */
  function cut(text: string): string {
    if (text.length <= maxText) return text;
    const last = apply(charCodeAt, text, [maxText - 1]) as number;
    const end = last >= 0xd800 && last <= 0xdbff ? maxText - 1 : maxText;
    return apply(slice, text, [0, end]) as string;
  }

  function describe(value: unknown): string {
    try {
      return describeValue(value);
    } catch {
      // When this throws too, the message is not recorded; the page's call still goes through.
      return tagOf(value);
    }
  }

  function describeValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return toText(value);
    }
    // The tag also covers an error from another realm, such as one of the page's frames.
    if (value instanceof PageError || tagOf(value) === "[object Error]") {
      const error = value as { name?: unknown; message?: unknown };
      return `${toText(error.name)}: ${toText(error.message)}`;
    }
    if (isBinary(value)) return tagOf(value);
    const json: unknown = stringify(value, budget());
    return typeof json === "string" ? json : tagOf(value);
  }

  /** Typed arrays, DataViews and buffers: stringifying one would walk every byte. */
  function isBinary(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    if (isView(value)) return true;
    const tag = tagOf(value);
    return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
  }

  function tagOf(value: unknown): string {
    return apply(objectToString, value, []) as string;
  }

  /**
   * A JSON.stringify replacer that throws once the keys and strings it has seen pass ten times
   * maxText, counting any other value as one, and writes nested binary values as their tag.
   */
  function budget(): (key: string, value: unknown) => unknown {
    let cost = 0;
    return (key, value) => {
      cost += key.length + (typeof value === "string" ? value.length : 1);
      if (cost > 10 * maxText) throw new PageError("too much to format");
      return isBinary(value) ? tagOf(value) : value;
    };
  }
}
