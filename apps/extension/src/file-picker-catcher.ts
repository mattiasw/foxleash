import { UPLOAD_PICKER_WAIT_MS } from "@foxleash/protocol";
import type { Timers } from "./browser-api.ts";

export const FILE_PICKER_ARM_EVENT = "foxleash-file-picker-arm";
export const FILE_PICKER_ARMED_EVENT = "foxleash-file-picker-armed";
export const FILE_PICKER_CAUGHT_EVENT = "foxleash-file-picker-caught";
export const FILE_PICKER_DISARM_EVENT = "foxleash-file-picker-disarm";

export interface CatcherOptions {
  /** The event the content script dispatches on the window to arm the catcher. */
  armEvent: string;
  /** The event the catcher answers `armEvent` with, once armed. */
  armedEvent: string;
  /** The event the catcher dispatches with the file field it caught as its detail. */
  caughtEvent: string;
  /** The event the content script dispatches on the window to disarm the catcher. */
  disarmEvent: string;
  /** The longest the catcher stays armed when nothing disarms it. */
  maxArmedMs: number;
}

export const CATCHER_OPTIONS: CatcherOptions = {
  armEvent: FILE_PICKER_ARM_EVENT,
  armedEvent: FILE_PICKER_ARMED_EVENT,
  caughtEvent: FILE_PICKER_CAUGHT_EVENT,
  disarmEvent: FILE_PICKER_DISARM_EVENT,
  maxArmedMs: 2 * UPLOAD_PICKER_WAIT_MS,
};

/** What `catchFilePickers` did in the document it ran in. */
export type CatcherStatus = "installed" | "present" | "elsewhere" | "refused";

/** What the catcher reads from the page's global. */
export interface CatcherPage {
  location: { protocol: string; hostname: string; port: string };
  document: object;
  Node: { prototype: object };
  HTMLElement: { prototype: object };
  HTMLInputElement: { prototype: object };
  performance: { now(): number };
  addEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  CustomEvent: typeof CustomEvent;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A wrapped method: where it lives, what was there, and the wrapper put in its place. */
interface Wrapped {
  target: object;
  key: string;
  saved: PropertyDescriptor;
  wrapper: unknown;
}

/**
 * Installs, once per document and only in a document on `site`, a catcher that upload_file arms
 * around its click on a button or link: while armed, the page's first call of `click()` or
 * `showPicker()` on a file field of this document opens no picker, and the catcher hands the field
 * to the content script in the detail of `options.caughtEvent`, then disarms. Every other call
 * goes to the original method. Unarmed, it changes nothing in the page. Runs in the page's main
 * world.
 *
 * `scripting.executeScript` serializes this function with `toString()`, so everything it uses
 * lives inside it. Everything it calls after it returns is captured first, so a page that later
 * replaces a built-in cannot change what it does beyond its own page.
 */
export function catchFilePickers(
  site: string,
  options: CatcherOptions,
  page: CatcherPage = globalThis,
): CatcherStatus {
  const where = page.location;
  // The site as `siteOf` in site.ts writes it: scheme, host without a trailing dot, port.
  const host = where.hostname.endsWith(".") ? where.hostname.slice(0, -1) : where.hostname;
  if (`${where.protocol}//${host}${where.port === "" ? "" : `:${where.port}`}` !== site)
    return "elsewhere";
  if (Object.hasOwn(page, "__foxleashFilePicker")) return "present";
  try {
    // Exactly { value: true }: Firefox's WindowProxy can throw on an explicit configurable: false.
    Object.defineProperty(page, "__foxleashFilePicker", { value: true });
  } catch {
    return "refused";
  }

  const apply = Reflect.apply;
  const create = Object.create;
  const defineProperty = Object.defineProperty;
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  const pageDocument = page.document;
  const elementPrototype = page.HTMLElement.prototype;
  const inputPrototype = page.HTMLInputElement.prototype;
  const typeGetter = ownDescriptor(inputPrototype, "type")?.get;
  const ownerDocumentGetter = ownDescriptor(page.Node.prototype, "ownerDocument")?.get;
  const pagePerformance = page.performance;
  const performanceNow = pagePerformance.now;
  const dispatch = page.dispatchEvent;
  const PageCustomEvent = page.CustomEvent;
  const setTimer = page.setTimeout;
  const clearTimer = page.clearTimeout;
  const { armEvent, armedEvent, caughtEvent, disarmEvent, maxArmedMs } = options;

  let armed = false;
  let armedAt = 0;
  let timer: unknown;
  let clickWrap: Wrapped | undefined;
  let pickerWrap: Wrapped | undefined;

  page.addEventListener(armEvent, () => {
    try {
      arm();
    } catch {
      // The content script then hears no answer and does not click.
    }
  });
  page.addEventListener(disarmEvent, disarm);

  return "installed";

  function arm(): void {
    if (armed) disarm();
    const click = wrap(elementPrototype, "click");
    if (click === null) return;
    const picker = wrap(inputPrototype, "showPicker");
    if (picker === null) {
      if (click !== undefined) restore(click);
      return;
    }
    clickWrap = click;
    pickerWrap = picker;
    armed = true;
    try {
      armedAt = now();
      // For a content script that went away mid-call, which would leave the page's pickers dead.
      timer = apply(setTimer, page, [disarm, maxArmedMs]);
      apply(dispatch, page, [new PageCustomEvent(armedEvent)]);
    } catch {
      // Unanswered, the content script does not click, so nothing stays armed for it.
      disarm();
    }
  }

  /** The method wrapped in place; undefined when it is absent, null when it cannot be replaced. */
  function wrap(target: object, key: string): Wrapped | undefined | null {
    const saved = ownDescriptor(target, key);
    if (saved === undefined || typeof saved.value !== "function") return undefined;
    const wrapper = wrapperOf(saved.value);
    try {
      defineProperty(target, key, valueOnly(wrapper));
    } catch {
      return null;
    }
    return { target, key, saved, wrapper };
  }

  function wrapperOf(original: unknown) {
    return function (this: unknown, ...args: unknown[]): unknown {
      // A failsafe timer Firefox delayed, as it does in a hidden tab.
      if (armed && now() - armedAt > maxArmedMs) disarm();
      if (armed && isOwnFileInput(this)) {
        disarm();
        hand(this);
        return undefined;
      }
      return apply(original as (...args: unknown[]) => unknown, this, args);
    };
  }

  /** Whether the value is a file field of this document; the native getters are the brand check. */
  function isOwnFileInput(value: unknown): boolean {
    try {
      return (
        typeGetter !== undefined &&
        ownerDocumentGetter !== undefined &&
        apply(typeGetter, value, []) === "file" &&
        apply(ownerDocumentGetter, value, []) === pageDocument
      );
    } catch {
      return false;
    }
  }

  function hand(input: unknown): void {
    try {
      const init: Record<string, unknown> = create(null);
      // The element itself: it reaches the content script through Firefox's Xray wrapper.
      init.detail = input;
      apply(dispatch, page, [new PageCustomEvent(caughtEvent, init)]);
    } catch {
      // The content script then hears no catch.
    }
  }

  function disarm(): void {
    if (!armed) return;
    armed = false;
    try {
      apply(clearTimer, page, [timer]);
    } catch {
      // The timer then finds the catcher disarmed.
    }
    if (clickWrap !== undefined) restore(clickWrap);
    if (pickerWrap !== undefined) restore(pickerWrap);
  }

  /** Puts the saved method back, unless the page replaced the wrapper meanwhile. */
  function restore({ target, key, saved, wrapper }: Wrapped): void {
    try {
      if (ownDescriptor(target, key)?.value !== wrapper) return;
      defineProperty(target, key, valueOnly(saved.value));
    } catch {
      // A property the page made unchangeable keeps what it holds.
    }
  }

  /**
   * A descriptor that changes only the value, so the property keeps its writable, enumerable and
   * configurable. Without a prototype: a `get` or `set` the page put on Object.prototype would
   * otherwise make it a refused mix.
   */
  function valueOnly(value: unknown): PropertyDescriptor {
    const descriptor: Record<string, unknown> = create(null);
    descriptor.value = value;
    return descriptor as PropertyDescriptor;
  }

  function now(): number {
    return apply(performanceNow, pagePerformance, []) as number;
  }
}

/** A catch armed in the page around upload_file's click. */
export interface PickerCatch<T> {
  /** The first detail `accept` took, from arming until `ms` after this call; undefined after that. */
  caught(ms: number): Promise<T | undefined>;
  /** Stops listening and tells the catcher to disarm; safe to call twice. */
  disarm(): void;
}

// The targets with a live catch: one per document at a time.
const live = new WeakSet<object>();

/**
 * Arms the page's catcher, synchronously, and listens for the file field it catches, read as
 * untrusted input through `accept`. `"busy"` while another catch of the target is live,
 * `"unanswered"` when no catcher answered, which leaves nothing behind.
 */
export function armPickerCatch<T, Handle>(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">,
  accept: (detail: unknown) => T | undefined,
  clock: Timers<Handle> & { now(): number },
): PickerCatch<T> | "busy" | "unanswered" {
  if (live.has(target)) return "busy";
  let kept: { value: T } | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  let waiting: ((value: T | undefined) => void) | undefined;
  let ended = false;
  const onCaught = (event: Event) => {
    // A detail after the deadline is ignored even when Firefox delayed the timer.
    if (kept !== undefined || clock.now() > deadline) return;
    let value: T | undefined;
    try {
      value = accept((event as CustomEvent<unknown>).detail);
    } catch {
      // A detail `accept` cannot read is skipped, as one it refuses.
    }
    if (value === undefined) return;
    kept = { value };
    waiting?.(value);
  };
  let answered = false;
  const onArmed = () => {
    answered = true;
  };
  target.addEventListener(FILE_PICKER_CAUGHT_EVENT, onCaught);
  target.addEventListener(FILE_PICKER_ARMED_EVENT, onArmed);
  try {
    // Synchronous: the catcher's answer arrives before this returns.
    target.dispatchEvent(new CustomEvent(FILE_PICKER_ARM_EVENT));
  } finally {
    target.removeEventListener(FILE_PICKER_ARMED_EVENT, onArmed);
  }
  if (!answered) {
    target.removeEventListener(FILE_PICKER_CAUGHT_EVENT, onCaught);
    return "unanswered";
  }
  live.add(target);
  return { caught, disarm };

  function caught(ms: number): Promise<T | undefined> {
    if (kept !== undefined) return Promise.resolve(kept.value);
    if (ended) return Promise.resolve(undefined);
    deadline = clock.now() + ms;
    return new Promise((resolve) => {
      const timer = clock.setTimeout(() => finish(undefined), ms);
      waiting = finish;
      function finish(value: T | undefined): void {
        clock.clearTimeout(timer);
        resolve(value);
      }
    });
  }

  function disarm(): void {
    if (ended) return;
    ended = true;
    waiting?.(undefined);
    target.removeEventListener(FILE_PICKER_CAUGHT_EVENT, onCaught);
    target.dispatchEvent(new CustomEvent(FILE_PICKER_DISARM_EVENT));
    live.delete(target);
  }
}
