import { type ElementRefs, refError } from "./element-refs.ts";
import { PageError } from "./page-messages.ts";

/** What the background needs to capture an element: its box after the scroll, in CSS pixels. */
export interface ElementBox {
  rect: { left: number; top: number; width: number; height: number };
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
}

/**
 * element_rect in the page: scrolls the element `ref` names into view and returns its box
 * relative to the viewport, the viewport's size and the page's scroll offset.
 */
export function elementRect(
  params: Record<string, unknown>,
  page: { refs: ElementRefs<Element> },
): ElementBox {
  const ref = Object.hasOwn(params, "ref") ? params.ref : undefined;
  if (typeof ref !== "string") {
    throw new PageError("invalid_params", "screenshot needs ref to be a string.");
  }
  const lookup = page.refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  // Instant, so scroll-behavior: smooth does not leave the capture mid-scroll. No
  // requestAnimationFrame wait: it does not run in background tabs.
  lookup.element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const box = lookup.element.getBoundingClientRect();
  return {
    rect: { left: box.left, top: box.top, width: box.width, height: box.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
  };
}
