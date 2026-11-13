import { MAX_TAG_LETTERS, PageError } from "./page-messages.ts";

export type RefError = "invalid_ref" | "stale_ref" | "ref_not_found";

export type RefLookup<T> = { element: T } | { error: RefError };

/** The element references one document hands out. */
export interface ElementRefs<T> {
  /** The element's ref: the same one every time for the same element. */
  refFor(element: T): string;
  resolve(ref: unknown): RefLookup<T>;
}

/** The refs of one document, which takes its tag from the first request it gets. */
export interface DocumentRefs<T> extends ElementRefs<T> {
  /** Fixes the document's tag; a later call changes nothing. */
  adopt(tag: string): void;
}

/** The number of document tags: every word of 1 to MAX_TAG_LETTERS lowercase letters. */
export const MAX_TAG_NUMBER = tagCount(MAX_TAG_LETTERS);

/** A ref: the document's tag, then the element's number in that document. */
export const REF = new RegExp(`^([a-z]{1,${MAX_TAG_LETTERS}})([1-9][0-9]{0,15})$`);
const SWEEP_AT = 10_000;

/**
 * The tag numbered `n` from 1: a bijective base-26 numeral in lowercase letters, so 1 is `a`,
 * 26 is `z`, 27 is `aa` and 703 is `aaa`. Distinct numbers give distinct tags.
 */
export function documentTag(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TAG_NUMBER) {
    throw new RangeError(`There is no document tag numbered ${n}.`);
  }
  let tag = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    tag = String.fromCharCode(97 + ((rest - 1) % 26)) + tag;
  }
  return tag;
}

/**
 * A registry of refs `${tag}${n}`, with `tag` the document's, which no other document has, and
 * `n` counting from 1, never reused. It holds elements weakly.
 */
export function createElementRefs<T extends object>(
  isLive: (element: T) => boolean,
  holdWeakly: (element: T) => { deref(): T | undefined } = (element) => new WeakRef(element),
): DocumentRefs<T> {
  const refs = new WeakMap<T, string>();
  const elements = new Map<string, { deref(): T | undefined }>();
  let tag: string | undefined;
  let count = 0;
  let sweepAt = SWEEP_AT;

  return { adopt, refFor, resolve };

  function adopt(next: string): void {
    tag ??= next;
  }

  function refFor(element: T): string {
    const known = refs.get(element);
    if (known !== undefined) return known;
    if (tag === undefined) throw new Error("The document has no tag yet.");
    if (elements.size >= sweepAt) {
      for (const [ref, weak] of elements) {
        if (weak.deref() === undefined) elements.delete(ref);
      }
      // Doubling keeps a document with many live refs from sweeping on every new one.
      sweepAt = Math.max(SWEEP_AT, 2 * elements.size);
    }
    count += 1;
    const ref = `${tag}${count}`;
    refs.set(element, ref);
    elements.set(ref, holdWeakly(element));
    return ref;
  }

  function resolve(ref: unknown): RefLookup<T> {
    const match = typeof ref === "string" ? REF.exec(ref) : null;
    if (match === null) return { error: "invalid_ref" };
    // A document without a tag has given out no ref.
    if (match[1] !== tag) return { error: "stale_ref" };
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

/** The number of tags of 1 to `letters` letters. */
function tagCount(letters: number): number {
  let count = 0;
  for (let length = 1; length <= letters; length += 1) count += 26 ** length;
  return count;
}
