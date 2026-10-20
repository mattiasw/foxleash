// Firefox also exposes its own widget roots (video controls, date inputs) as shadow roots.
const SHADOW_HOSTS: ReadonlySet<string> = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "span",
]);

interface ShadowAccess {
  readonly shadowRoot: ShadowRoot | null;
  /** Firefox's, for content scripts only: the shadow root, closed ones included. */
  readonly openOrClosedShadowRoot?: ShadowRoot | null;
}

/**
 * Whether the element is a closed details. Only an `open` attribute in no namespace opens one, as
 * only that one matches the `details[open]` UA style.
 */
export function isClosedDetails(element: Element): boolean {
  return element.localName === "details" && !element.hasAttributeNS(null, "open");
}

/** The summary a details shows, if it has one. */
export function detailsSummaryOf(details: Element): Element | undefined {
  for (const child of details.children) {
    if (isDetailsSummary(child)) return child;
  }
  return undefined;
}

/**
 * Whether `child` is assigned to a slot of `holder`'s shadow tree: every child of an author
 * shadow host, and every child of a details but its summary, which goes to the details' content
 * box. That box is hidden with `content-visibility: hidden` while the details is closed, which
 * still gives client rects, and the page can hide it while open through `::details-content`.
 */
export function slottedAway(holder: Element, child: Node): boolean {
  return shadowRootOf(holder) !== null || inDetailsContent(holder, child);
}

/** The author shadow root of an element that may carry one, open or closed. */
export function shadowRootOf(element: Element): ShadowRoot | null {
  if (!element.localName.includes("-") && !SHADOW_HOSTS.has(element.localName)) return null;
  const access: ShadowAccess = element;
  const root = access.openOrClosedShadowRoot;
  return root === undefined ? element.shadowRoot : root;
}

/**
 * Whether `child` of `holder` goes to a details' content box: every child but its shown
 * summary, text included.
 */
export function inDetailsContent(holder: Element, child: Node): boolean {
  return holder.localName === "details" && !(child instanceof Element && isDetailsSummary(child));
}

/** Whether the element is the first HTML summary among its siblings, the one a details shows. */
function isDetailsSummary(element: Element): boolean {
  return (
    element instanceof HTMLElement &&
    element.localName === "summary" &&
    element.matches(":first-of-type")
  );
}
