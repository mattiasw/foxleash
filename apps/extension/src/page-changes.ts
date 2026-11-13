import { shadowRootOf } from "./flat-tree.ts";
import { documentElements } from "./read-page.ts";

/** A watch stops counting this long after its start: longer than any page request polls it. */
const WATCH_LIMIT_MS = 60_000;

const OBSERVED: MutationObserverInit = {
  childList: true,
  attributes: true,
  characterData: true,
  subtree: true,
};

/**
 * current: the document's latest watch, with its count of changes and the ms since the last one
 * (since its start when none); superseded: a later act started another watch in this document;
 * other: not a watch of this document.
 */
export type WatchRead =
  | { state: "current"; changes: number; quietMs: number }
  | { state: "superseded" }
  | { state: "other" };

/** What changed in a document since an act began in it. */
export interface PageChanges {
  /** Starts a watch for the act about to run and returns its id. */
  start(): string;
  read(watch: unknown): WatchRead;
}

interface Watch {
  id: string;
  start: number;
  changes: number;
  lastChange: number;
  stopped: boolean;
}

/**
 * Watches the document, and the shadow roots in it, for changes after an act: DOM mutations, and
 * input and change events, since a field's value or a checkbox's state changes no attribute. It
 * runs no timer: Firefox runs a hidden tab's timers late, but not its observers and listeners.
 */
export function createPageChanges(doc: Document): PageChanges {
  // Per document: a page restored from the back-forward cache keeps its content script.
  const nonce = documentNonce();
  let started = 0;
  let watch: Watch | undefined;
  const observer = new MutationObserver((records) => noted(records));
  doc.addEventListener("input", changed, true);
  doc.addEventListener("change", changed, true);
  return { start, read };

  function start(): string {
    observer.disconnect();
    started += 1;
    const now = performance.now();
    watch = { id: `${nonce}.${started}`, start: now, changes: 0, lastChange: now, stopped: false };
    observer.observe(doc, OBSERVED);
    observeShadowRoots(doc);
    return watch.id;
  }

  function read(id: unknown): WatchRead {
    if (watch === undefined || typeof id !== "string" || !id.startsWith(`${nonce}.`)) {
      return { state: "other" };
    }
    if (id !== watch.id) return { state: "superseded" };
    noted(observer.takeRecords());
    const quietMs = Math.floor(performance.now() - watch.lastChange);
    return { state: "current", changes: watch.changes, quietMs };
  }

  function noted(records: MutationRecord[]): void {
    if (records.length === 0 || !counting(watch)) return;
    watch.changes += records.length;
    watch.lastChange = performance.now();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        // A component the change rendered is watched too.
        const own = shadowRootOf(node);
        if (own !== null) {
          observer.observe(own, OBSERVED);
          observeShadowRoots(own);
        }
        observeShadowRoots(node);
      }
    }
  }

  function changed(): void {
    if (!counting(watch)) return;
    watch.changes += 1;
    watch.lastChange = performance.now();
  }

  /** Whether the watch still counts; one past WATCH_LIMIT_MS stops, and so does the observer. */
  function counting(current: Watch | undefined): current is Watch {
    if (current === undefined || current.stopped) return false;
    if (performance.now() - current.start <= WATCH_LIMIT_MS) return true;
    current.stopped = true;
    observer.disconnect();
    return false;
  }

  function observeShadowRoots(from: ParentNode): void {
    for (const element of documentElements(from)) {
      const shadow = shadowRootOf(element);
      if (shadow !== null) observer.observe(shadow, OBSERVED);
    }
  }
}

/** Drawn with getRandomValues: randomUUID is missing on pages that are not a secure context. */
function documentNonce(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}
