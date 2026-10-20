import type { PageText, PageTextSource } from "@foxhand/protocol";
import { detailsSummaryOf, isClosedDetails, slottedAway } from "./flat-tree.ts";
import { composePageText } from "./page-text.ts";
import { clean, explicitRole } from "./page-tree.ts";
import { UNREAD } from "./read-page.ts";

/** The least text, in characters, a block needs to count as the page's main content. */
const MIN_BLOCK_CHARS = 200;
const BLOCK_CHILDREN: ReadonlySet<string> = new Set(["p", "pre", "blockquote"]);

interface Found {
  source: PageTextSource;
  element: HTMLElement;
}

// innerText of an element that is not being rendered is its textContent, hidden text and script
// source included (HTML spec, innerText getter): it is read only from elements with a box and
// shown content, and a bare text node only when it has a box of its own.

/** The rendered text of the document's top frame: its main content, then the rest. */
export function readPageText(doc: Document, maxChars: number): PageText {
  const body = doc.body;
  if (body === null) return composePageText("body", "", "", maxChars);
  const found = findMain(body);
  if (found.source === "body") {
    const main = hasBox(body) ? body.innerText : restText(body, undefined);
    return composePageText("body", main, "", maxChars);
  }
  return composePageText(
    found.source,
    found.element.innerText,
    restText(body, found.element),
    maxChars,
  );
}

function findMain(body: HTMLElement): Found {
  for (const element of body.querySelectorAll("main")) {
    if (isShown(element)) return { source: "main", element };
  }
  for (const element of body.querySelectorAll("[role]")) {
    if (explicitRole(element.getAttribute("role")) === "main" && isShown(element)) {
      return { source: "role_main", element };
    }
  }
  const article = longestArticle(body);
  if (article !== undefined) return { source: "article", element: article };
  const block = largestBlock(body);
  if (block === undefined || block === body) return { source: "body", element: body };
  return { source: "largest_block", element: block };
}

/**
 * A shown element whose own content is shown; only HTML elements have innerText. Firefox lays
 * out a canvas's fallback content, which the user never sees.
 */
function isShown(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.checkVisibility({ visibilityProperty: true }) &&
    getComputedStyle(element).contentVisibility !== "hidden" &&
    element.closest("canvas") === null
  );
}

/** The shown outermost article with the longest text, the first on a tie. */
function longestArticle(body: HTMLElement): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestLength = -1;
  for (const element of body.querySelectorAll("article")) {
    if (!isShown(element)) continue;
    const outer = element.parentElement?.closest("article");
    if (outer != null && isShown(outer)) continue;
    const length = element.innerText.length;
    if (length > bestLength) {
      best = element;
      bestLength = length;
    }
  }
  return best;
}

/** The shown element with the most paragraph text directly in it, if it has enough. */
function largestBlock(body: HTMLElement): HTMLElement | undefined {
  const range = body.ownerDocument.createRange();
  let best: HTMLElement | undefined;
  let bestScore = -1;
  for (const candidate of [body, ...body.querySelectorAll("*")]) {
    if (UNREAD.has(candidate.localName) || !isShown(candidate)) continue;
    const score = blockScore(candidate, range);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= MIN_BLOCK_CHARS ? best : undefined;
}

function blockScore(element: HTMLElement, range: Range): number {
  let score = 0;
  for (const child of shownChildren(element)) {
    if (child instanceof Text) {
      const length = child.data.trim().length;
      if (length > 0 && textShown(child, range)) score += length;
    } else if (child instanceof Element && BLOCK_CHILDREN.has(child.localName) && isShown(child)) {
      score += child.innerText.length;
    }
  }
  return score;
}

/**
 * The text of the page outside `main`, in document order, without recursion: elements with a
 * box are read whole, and only `main`'s ancestors and `display: contents` wrappers are entered,
 * a closed details only as far as its summary.
 */
function restText(body: HTMLElement, main: HTMLElement | undefined): string {
  const ancestors = new Set<Node>();
  for (let node = main?.parentNode; node != null && node !== body; node = node.parentNode) {
    ancestors.add(node);
  }
  const range = body.ownerDocument.createRange();
  const pieces: string[] = [];
  const steps: Node[] = [];
  pushChildren(steps, body);
  for (let node = steps.pop(); node !== undefined; node = steps.pop()) {
    if (node instanceof Text) {
      const text = clean(node.data);
      if (text !== "" && textShown(node, range)) pieces.push(text);
      continue;
    }
    if (!(node instanceof Element) || node === main || UNREAD.has(node.localName)) continue;
    if (ancestors.has(node)) {
      pushChildren(steps, node);
    } else if (hasBox(node)) {
      const text = node.innerText;
      if (text !== "") pieces.push(text);
    } else if (!node.checkVisibility() && getComputedStyle(node).display === "contents") {
      pushChildren(steps, node);
    }
  }
  return pieces.join("\n");
}

function pushChildren(steps: Node[], parent: Element): void {
  const children = shownChildren(parent);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) steps.push(child);
  }
}

/** An element's child nodes, except that a closed details has only its summary. */
function shownChildren(element: Element): ArrayLike<Node> & Iterable<Node> {
  if (!isClosedDetails(element)) return element.childNodes;
  const summary = detailsSummaryOf(element);
  return summary === undefined ? [] : [summary];
}

/**
 * Visible text with a box of its own (unslotted or replaced-element text has none), in the
 * nearest box, past `display: contents`, whose content is shown and not a canvas's fallback.
 * The climb stops where the text takes its style from a box of a shadow tree rather than from
 * its light-DOM parent, so such text is not read here.
 */
function textShown(node: Text, range: Range): boolean {
  let holder = node.parentElement;
  if (holder === null || getComputedStyle(holder).visibility !== "visible") return false;
  let child: Node = node;
  while (
    holder !== null &&
    !slottedAway(holder, child) &&
    getComputedStyle(holder).display === "contents"
  ) {
    child = holder;
    holder = holder.parentElement;
  }
  if (
    holder === null ||
    slottedAway(holder, child) ||
    !holder.checkVisibility() ||
    getComputedStyle(holder).contentVisibility === "hidden" ||
    holder.closest("canvas") !== null
  ) {
    return false;
  }
  range.selectNodeContents(node);
  return range.getClientRects().length > 0;
}

/** An element with a box whose own content is shown, so its innerText is its rendered text. */
function hasBox(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.checkVisibility() &&
    getComputedStyle(element).contentVisibility !== "hidden"
  );
}
