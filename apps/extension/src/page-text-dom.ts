// biome-ignore-all lint/performance/useDomNodeTextContent: page text omits CSS-hidden text
import type { PageText, PageTextSource } from "@foxhand/protocol";
import { flatParentOf, inDetailsContent, shadowRootOf } from "./flat-tree.ts";
import { composePageText } from "./page-text.ts";
import { clean, explicitRole, WHITESPACE } from "./page-tree.ts";
import {
  childrenOf,
  detailsContent,
  documentElements,
  isBlock,
  UNREAD,
  walkChildren,
} from "./read-page.ts";

/** The least text, in characters, a block needs to count as the page's main content. */
const MIN_BLOCK_CHARS = 200;
const BLOCK_CHILDREN: ReadonlySet<string> = new Set(["p", "pre", "blockquote"]);
const EMPTY: ReadonlySet<Element> = new Set();
/** shadowText's step that ends a block's line once its children are read. */
const FLUSH = "flush";

interface Found {
  source: PageTextSource;
  element: HTMLElement;
}

/** What the searches for the main content look through. */
interface Candidates {
  /** The elements below the body, in flat-tree order. */
  elements: Iterable<Element>;
  /** The innermost article an article is nested in, if any. */
  outerArticle(article: Element): Element | undefined;
}

/** Where a node's text is laid out. */
interface Placement {
  /** The nearest flat-tree ancestor that is not display: contents. */
  holder: Element | null;
  /** The climb to `holder` passes into a details' content box. */
  inContent: boolean;
}

interface TextStep extends Placement {
  node: Node;
  /** The element whose flat-tree children the node is one of. */
  parent: Element;
}

type ShadowStep = TextStep | typeof FLUSH;

/** The lines shadowText has read, and the inline text of the line it is in. */
interface Lines {
  done: string[];
  run: string;
}

// innerText of an element that is not being rendered is its textContent, hidden text and script
// source included (HTML spec, innerText getter): it is read only from elements with a box and
// shown content, and a bare text node only when it has a box of its own. Firefox's innerText walks
// DOM children, not the flat tree, so it leaves out shadow-tree text and what a slot shows: an
// element holding a shadow host or a filled slot is read through its flat-tree children instead.

/** The rendered text of the document's top frame: its main content, then the rest. */
export function readPageText(doc: Document, maxChars: number): PageText {
  const body = doc.body;
  if (body === null) return composePageText("body", "", "", maxChars);
  const roots = authorShadowRoots();
  const shadowed = shadowedBy(roots, body);
  const found = findMain(body, candidatesOf(body, roots), shadowed);
  if (found.source === "body") {
    return composePageText("body", bodyText(body, shadowed), "", maxChars);
  }
  return composePageText(
    found.source,
    elementText(found.element, shadowed),
    flatText(body, found.element, mainPath(found.element, body), shadowed),
    maxChars,
  );
}

/** The text the document's body shows, in document order: what wait_for matches text in. */
export function renderedText(doc: Document): string {
  const body = doc.body;
  if (body === null) return "";
  return bodyText(body, shadowedBy(authorShadowRoots(), body));
}

/** The author shadow roots of the document and of the shadow roots in it, closed ones included. */
function authorShadowRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  for (const element of documentElements()) {
    const root = shadowRootOf(element);
    if (root !== null) roots.push(root);
  }
  return roots;
}

/**
 * The elements up to the body whose flat subtree, self included, holds an author shadow host or
 * a filled slot, so their innerText leaves text out.
 */
function shadowedBy(roots: readonly ShadowRoot[], body: HTMLElement): ReadonlySet<Element> {
  const filled: HTMLSlotElement[] = [];
  // flatParentOf finds a closed root's slot by searching them all, once per child of its host.
  const slotOf = new Map<Node, Element>();
  for (const root of roots) {
    for (const slot of root.querySelectorAll("slot")) {
      if (!isFilledSlot(slot)) continue;
      filled.push(slot);
      for (const node of slot.assignedNodes()) slotOf.set(node, slot);
    }
  }
  const shadowed = new Set<Element>();
  for (const root of roots) markFlatAncestors(shadowed, root.host, body, slotOf);
  for (const slot of filled) markFlatAncestors(shadowed, slot, body, slotOf);
  return shadowed;
}

/**
 * Marks `start` and its flat-tree ancestors, when the climb reaches the body or a marked element
 * before a canvas: a canvas's fallback is never shown, and a shadowed canvas would have it read.
 * `slotOf` gives the slot each assigned node is shown in.
 */
function markFlatAncestors(
  shadowed: Set<Element>,
  start: Element,
  body: HTMLElement,
  slotOf: ReadonlyMap<Node, Element>,
): void {
  // A start outside the flat tree marks ancestors that shadowText reads without reaching it.
  const chain: Element[] = [];
  let node: Element | null = start;
  while (node !== null && node !== body && !shadowed.has(node)) {
    if (node.localName === "canvas") return;
    chain.push(node);
    node = slotOf.get(node) ?? flatParentOf(node);
  }
  if (node === null) return;
  shadowed.add(node);
  for (const element of chain) shadowed.add(element);
}

function isFilledSlot(element: Element): boolean {
  return element instanceof HTMLSlotElement && element.assignedNodes().length > 0;
}

/** Without shadow roots the flat tree is the DOM tree, which the browser lists natively. */
function candidatesOf(body: HTMLElement, roots: readonly ShadowRoot[]): Candidates {
  if (roots.length > 0) return walkFlatTree(body);
  return {
    elements: body.querySelectorAll("*"),
    outerArticle: (article) => article.parentElement?.closest("article") ?? undefined,
  };
}

/** The body's flat tree in order, without a canvas's content. */
function walkFlatTree(body: HTMLElement): Candidates {
  const elements: Element[] = [];
  const outerArticles = new Map<Element, Element>();
  const articles: Element[] = [];
  walkChildren(body, {
    enter(element) {
      elements.push(element);
      const isArticle = element.localName === "article";
      const outer = articles.at(-1);
      if (isArticle && outer !== undefined) outerArticles.set(element, outer);
      // Firefox lays out a canvas's fallback content, which the user never sees.
      if (element.localName === "canvas") return false;
      if (isArticle) articles.push(element);
      return true;
    },
    leave(element) {
      if (element.localName === "article") articles.pop();
    },
    text() {},
    done: () => false,
  });
  return { elements, outerArticle: (article) => outerArticles.get(article) };
}

function findMain(
  body: HTMLElement,
  candidates: Candidates,
  shadowed: ReadonlySet<Element>,
): Found {
  for (const element of candidates.elements) {
    if (element.localName === "main" && isShown(element)) return { source: "main", element };
  }
  for (const element of candidates.elements) {
    if (explicitRole(element.getAttribute("role")) === "main" && isShown(element)) {
      return { source: "role_main", element };
    }
  }
  const article = longestArticle(candidates, shadowed);
  if (article !== undefined) return { source: "article", element: article };
  const block = largestBlock(body, candidates, shadowed);
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
function longestArticle(
  candidates: Candidates,
  shadowed: ReadonlySet<Element>,
): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestLength = -1;
  for (const element of candidates.elements) {
    if (element.localName !== "article" || !isShown(element)) continue;
    const outer = candidates.outerArticle(element);
    if (outer !== undefined && isShown(outer)) continue;
    const length = elementText(element, shadowed).length;
    if (length > bestLength) {
      best = element;
      bestLength = length;
    }
  }
  return best;
}

/** The rendered text of an element with a box and shown content. */
function elementText(element: HTMLElement, shadowed: ReadonlySet<Element>): string {
  return shadowed.has(element) ? shadowText(element, shadowed) : element.innerText;
}

/**
 * A shadowed element's rendered text, read through its flat-tree children without recursion:
 * inline content joins into one line as innerText joins it, and a block starts a new line.
 */
function shadowText(element: HTMLElement, shadowed: ReadonlySet<Element>): string {
  const range = element.ownerDocument.createRange();
  const lines: Lines = { done: [], run: "" };
  const steps: ShadowStep[] = [];
  pushChildren(steps, element, placementOf(element), true);
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if (step === FLUSH) {
      flush(lines);
      continue;
    }
    const node = step.node;
    if (node instanceof Text) {
      if (node.data.trim() !== "" && !textShown(node, step, range)) continue;
      const collapse = getComputedStyle(step.parent).whiteSpaceCollapse;
      const spaces = keepsSpaces(collapse);
      const breaks = spaces || collapse === "preserve-breaks";
      for (const [index, part] of (breaks ? node.data.split("\n") : [node.data]).entries()) {
        if (index > 0) breakLine(lines);
        append(lines, spaces ? part : part.replace(WHITESPACE, " "), !spaces);
      }
      continue;
    }
    if (!(node instanceof Element) || UNREAD.has(node.localName)) continue;
    const style = getComputedStyle(node);
    if (node.localName === "br") {
      if (style.display !== "none") breakLine(lines);
      continue;
    }
    if (hasBox(node)) {
      // An inline element's innerText drops the line breaks around a block in it. A canvas's
      // fallback is never shown, and closest("canvas") cannot see it from inside a shadow tree.
      if (shadowed.has(node) || (style.display === "inline" && node.localName !== "canvas")) {
        if (isBlock(style)) {
          flush(lines);
          steps.push(FLUSH);
        }
        pushChildren(steps, node, step, true);
      } else if (style.display.startsWith("inline")) {
        append(lines, node.innerText, !keepsSpaces(style.whiteSpaceCollapse));
      } else {
        flush(lines);
        const text = node.innerText;
        if (text !== "") lines.done.push(text);
      }
    } else if (!node.checkVisibility() && style.display === "contents") {
      pushChildren(steps, node, step, true);
    }
  }
  flush(lines);
  return lines.done.join("\n");
}

/** Adds text to the line; a collapsible space is dropped at the start of a line or after one. */
function append(lines: Lines, text: string, collapsible: boolean): void {
  const drop = collapsible && text.startsWith(" ") && (lines.run === "" || lines.run.endsWith(" "));
  lines.run += drop ? text.slice(1) : text;
}

function flush(lines: Lines): void {
  const line = lines.run.trimEnd();
  if (line !== "") lines.done.push(line);
  lines.run = "";
}

/** Ends the line at a forced line break, which keeps the line even when it is empty. */
function breakLine(lines: Lines): void {
  lines.done.push(lines.run.trimEnd());
  lines.run = "";
}

/** Whether text under this `white-space-collapse` keeps its spaces as written. */
function keepsSpaces(collapse: string): boolean {
  return collapse === "preserve" || collapse === "break-spaces";
}

/** The shown element with the most paragraph text directly in it, if it has enough. */
function largestBlock(
  body: HTMLElement,
  candidates: Candidates,
  shadowed: ReadonlySet<Element>,
): HTMLElement | undefined {
  const range = body.ownerDocument.createRange();
  let best: HTMLElement | undefined;
  let bestScore = -1;
  for (const candidate of [body, ...candidates.elements]) {
    if (UNREAD.has(candidate.localName) || !isShown(candidate)) continue;
    const score = blockScore(candidate, range, shadowed);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= MIN_BLOCK_CHARS ? best : undefined;
}

function blockScore(candidate: HTMLElement, range: Range, shadowed: ReadonlySet<Element>): number {
  let score = 0;
  const steps: TextStep[] = [];
  // isShown gave the candidate a box, which its children are laid out in.
  pushChildSteps(steps, candidate, { holder: candidate, inContent: false }, false);
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    // What a slot without a box shows is laid out in the candidate's box: it counts as its own.
    if (step.node instanceof HTMLSlotElement && isBoxlessFilledSlot(step.node)) {
      pushChildSteps(steps, step.node, step, false);
    } else {
      score += nodeScore(step, range, shadowed);
    }
  }
  return score;
}

function isBoxlessFilledSlot(slot: HTMLSlotElement): boolean {
  return getComputedStyle(slot).display === "contents" && isFilledSlot(slot);
}

function nodeScore(step: TextStep, range: Range, shadowed: ReadonlySet<Element>): number {
  const node = step.node;
  if (node instanceof Text) {
    const length = node.data.trim().length;
    return length > 0 && textShown(node, step, range) ? length : 0;
  }
  if (node instanceof Element && BLOCK_CHILDREN.has(node.localName) && isShown(node)) {
    return elementText(node, shadowed).length;
  }
  return 0;
}

function bodyText(body: HTMLElement, shadowed: ReadonlySet<Element>): string {
  return hasBox(body) ? elementText(body, shadowed) : flatText(body, undefined, EMPTY, shadowed);
}

/**
 * The text below `start` outside `main`, in flat-tree order, without recursion: elements with a
 * box are read whole, and only `entered` (main's flat-tree ancestors) and `display: contents`
 * wrappers are entered, a closed details only as far as its summary.
 */
function flatText(
  start: HTMLElement,
  main: HTMLElement | undefined,
  entered: ReadonlySet<Element>,
  shadowed: ReadonlySet<Element>,
): string {
  const range = start.ownerDocument.createRange();
  const pieces: string[] = [];
  const steps: TextStep[] = [];
  pushChildren(steps, start, placementOf(start), false);
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    const node = step.node;
    if (node instanceof Text) {
      const text = clean(node.data);
      if (text !== "" && textShown(node, step, range)) pieces.push(text);
      continue;
    }
    if (!(node instanceof Element) || node === main || UNREAD.has(node.localName)) continue;
    if (entered.has(node)) {
      pushChildren(steps, node, step, false);
    } else if (hasBox(node)) {
      const text = elementText(node, shadowed);
      if (text !== "") pieces.push(text);
    } else if (!node.checkVisibility() && getComputedStyle(node).display === "contents") {
      pushChildren(steps, node, step, false);
    }
  }
  return pieces.join("\n");
}

/** The flat-tree ancestors of `main` below the body. */
function mainPath(main: HTMLElement, body: HTMLElement): ReadonlySet<Element> {
  const path = new Set<Element>();
  for (let node = flatParentOf(main); node !== null && node !== body; node = flatParentOf(node)) {
    path.add(node);
  }
  return path;
}

/** Where a walk's start element lays out its content: its own box, or past `display: contents`. */
function placementOf(start: Element): Placement {
  let holder: Element | null = start;
  while (holder !== null && getComputedStyle(holder).display === "contents") {
    holder = flatParentOf(holder);
  }
  return { holder, inContent: false };
}

/**
 * Pushes the element's flat-tree children, laid out in its box, or where the element itself is
 * when it is `display: contents`.
 */
function pushChildren(
  steps: Pick<TextStep[], "push">,
  element: Element,
  own: Placement,
  judgeDetails: boolean,
): void {
  const contents = getComputedStyle(element).display === "contents";
  const placement = contents ? own : { holder: element, inContent: false };
  pushChildSteps(steps, element, placement, judgeDetails);
}

/**
 * Pushes the element's flat-tree children in reverse, so they pop in order, laid out as
 * `placement` says. Text in a details' content box is refused, as the box is
 * `content-visibility: hidden` while the details is closed, which still gives client rects, and
 * the page can hide it while open through `::details-content`; with `judgeDetails` the box's own
 * style decides instead, as innerText judges it.
 */
function pushChildSteps(
  steps: Pick<TextStep[], "push">,
  element: Element,
  placement: Placement,
  judgeDetails: boolean,
): void {
  const contentShown = judgeDetails && detailsContentShown(element);
  const children = childrenOf(element);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index];
    if (node === undefined) continue;
    const inContent = inDetailsContent(element, node);
    if (inContent && judgeDetails && !contentShown) continue;
    steps.push({
      node,
      parent: element,
      holder: placement.holder,
      inContent: placement.inContent || (inContent && !judgeDetails),
    });
  }
}

/** Whether the element is a details whose content box the user sees (visible implies boxed). */
function detailsContentShown(element: Element): boolean {
  return detailsContent(element, { boxed: true, visible: true })?.visible === true;
}

/**
 * Visible text with a box of its own (unslotted or replaced-element text has none), in the
 * nearest box, past `display: contents`, whose content is shown and not a canvas's fallback.
 */
function textShown(node: Text, step: TextStep, range: Range): boolean {
  const holder = step.holder;
  if (
    getComputedStyle(step.parent).visibility !== "visible" ||
    holder === null ||
    step.inContent ||
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
