import { PageError } from "./page-messages.ts";

export type RefError = "invalid_ref" | "stale_ref" | "ref_not_found";

export type RefLookup<T> = { element: T } | { error: RefError };

/** The element references one document hands out. */
export interface ElementRefs<T> {
  /** The element's ref: the same one every time for the same element. */
  refFor(element: T): string;
  resolve(ref: unknown): RefLookup<T>;
}

const REF = /^([0-9a-f]{8})-[1-9][0-9]{0,15}$/;
const SWEEP_AT = 10_000;

/**
 * A registry of refs `${docId}-${n}`, with `docId` 8 lowercase hex characters unique to the
 * document and `n` counting from 1, never reused. It holds elements weakly.
 */
export function createElementRefs<T extends object>(
  docId: string,
  isLive: (element: T) => boolean,
  holdWeakly: (element: T) => { deref(): T | undefined } = (element) => new WeakRef(element),
): ElementRefs<T> {
  const refs = new WeakMap<T, string>();
  const elements = new Map<string, { deref(): T | undefined }>();
  let count = 0;
  let sweepAt = SWEEP_AT;

  return { refFor, resolve };

  function refFor(element: T): string {
    const known = refs.get(element);
    if (known !== undefined) return known;
    if (elements.size >= sweepAt) {
      for (const [ref, weak] of elements) {
        if (weak.deref() === undefined) elements.delete(ref);
      }
      // Doubling keeps a document with many live refs from sweeping on every new one.
      sweepAt = Math.max(SWEEP_AT, 2 * elements.size);
    }
    count += 1;
    const ref = `${docId}-${count}`;
    refs.set(element, ref);
    elements.set(ref, holdWeakly(element));
    return ref;
  }

  function resolve(ref: unknown): RefLookup<T> {
    const match = typeof ref === "string" ? REF.exec(ref) : null;
    if (match === null) return { error: "invalid_ref" };
    if (match[1] !== docId) return { error: "stale_ref" };
    const element = elements.get(match[0])?.deref();
    if (element === undefined || !isLive(element)) return { error: "ref_not_found" };
    return { element };
  }
}

/** The refusal for a ref that `resolve` did not find. */
export function refError(ref: string, error: RefError): PageError {
  switch (error) {
    case "invalid_ref":
      // The input can be anything, so it is not repeated.
      return new PageError(error, "That is not an element reference that read_page gave out.");
    case "stale_ref":
      return new PageError(
        error,
        `Element ${ref} is from a page the tab no longer shows; read the page again with read_page.`,
      );
    case "ref_not_found":
      return new PageError(
        error,
        `Element ${ref} is no longer on the page; read the page again with read_page.`,
      );
  }
}
