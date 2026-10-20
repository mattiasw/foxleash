import type { Result } from "@foxhand/protocol";
import { type ElementRefs, refError } from "./element-refs.ts";
import { flatParentOf, shadowRootOf } from "./flat-tree.ts";
import {
  type Axis,
  type ClickOptions,
  crossSiteDestination,
  type DragOptions,
  defaultAmount,
  dragPoints,
  formDestination,
  fullyInside,
  type HoverOptions,
  hoverTransitions,
  type Point,
  type PointTarget,
  type ScrollByOptions,
  type ScrollOptions,
  scrollDelta,
  type Viewport,
  viewportOverflow,
  visiblePoint,
  wheelScrolls,
} from "./page-actions.ts";
import { PageError } from "./page-messages.ts";
import { focusedElement, isEditingHost } from "./read-page.ts";

// Firefox's waiver of Xray vision, in content scripts only.
declare const window: Window & typeof globalThis & { wrappedJSObject: PageRealm };

interface PageRealm {
  DataTransfer: typeof DataTransfer;
}

/** The element Foxhand's synthetic pointer is over in a document, held weakly. */
export interface PointerState {
  over: WeakRef<Element> | undefined;
}

export interface ActionPage {
  refs: ElementRefs<Element>;
  pointer: PointerState;
}

/** Where the events go: the element hit at the point, and the ref that names the target. */
interface Located {
  hit: Element;
  point: Point;
  ref: string;
  /** Scrolls back what bringing the target into view scrolled, for a refusal before any event. */
  scrollBack?: () => void;
}

interface Candidate {
  element: Element;
  /** The page's own scrolling, reported as the window's scroll position and with no ref. */
  page: boolean;
}

const HTML = "http://www.w3.org/1999/xhtml";
const MATHML = "http://www.w3.org/1998/Math/MathML";
const XLINK = "http://www.w3.org/1999/xlink";
const FRAMES: ReadonlySet<string> = new Set(["iframe", "frame", "object", "embed"]);
// HTML's rules for parsing integers: a tabindex Firefox ignores does not make a click focus.
const TABINDEX = /^[\t\n\f\r ]*[-+]?[0-9]/;
const LEFT = 0;
const RIGHT = 2;

/**
 * click in the page: moves the pointer onto the target and sends a full pointer and mouse
 * click, refusing first when the click would open a page on another site.
 */
export function click(options: ClickOptions, page: ActionPage): Result<"click"> {
  const target = locate(options, page.refs, true);
  const { hit, point } = target;
  if (options.button === "right") {
    moveTo(hit, point, page.pointer, 0);
    press(hit, point, RIGHT, 1);
    sendMouse(hit, "contextmenu", mouseInit(point, RIGHT, 0, 1));
    return { ref: page.refs.refFor(hit), x: point.x, y: point.y };
  }
  orScrollBack(target.scrollBack, () => refuseCrossSite(target));
  moveTo(hit, point, page.pointer, 0);
  for (let detail = 1; detail <= (options.doubleClick ? 2 : 1); detail += 1) {
    press(hit, point, LEFT, detail);
    // The page's own down and up listeners may have changed where the click leads.
    refuseCrossSite(target);
    sendMouse(hit, "click", mouseInit(point, LEFT, 0, detail));
  }
  if (options.doubleClick) sendMouse(hit, "dblclick", mouseInit(point, LEFT, 0, 2));
  return { ref: page.refs.refFor(hit), x: point.x, y: point.y };
}

/** hover in the page: moves the pointer onto the target. */
export function hover(options: HoverOptions, page: ActionPage): Result<"hover"> {
  const { hit, point } = locate(options, page.refs, true);
  moveTo(hit, point, page.pointer, 0);
  return { ref: page.refs.refFor(hit), x: point.x, y: point.y };
}

/**
 * scroll in the page: without a direction, scrolls the element into view; with one, sends a
 * wheel event and scrolls the box that wheel would scroll.
 */
export function scroll(options: ScrollOptions, page: ActionPage): Result<"scroll"> {
  if (options.direction === undefined) return bringIntoView(options.ref, page.refs);
  return wheel(options, page);
}

/**
 * drag in the page: presses at the start, then emulates HTML drag and drop from a draggable
 * element, else moves the pointer to the end and releases it there.
 */
export function drag(options: DragOptions, page: ActionPage): Result<"drag"> {
  // Scrolling to the start would move an end given as a point of the tab as it shows now.
  const start = locate(
    options.ref === undefined ? { x: options.x, y: options.y } : { ref: options.ref },
    page.refs,
    options.targetRef !== undefined,
  );
  const end = orScrollBack(start.scrollBack, () =>
    locate(
      options.targetRef === undefined
        ? { x: options.targetX, y: options.targetY }
        : { ref: options.targetRef },
      page.refs,
      false,
    ),
  );
  const refs = { ref: page.refs.refFor(start.hit), targetRef: page.refs.refFor(end.hit) };
  moveTo(start.hit, start.point, page.pointer, 0);
  const mouse = sendPointer(start.hit, "pointerdown", pointerInit(start.point, LEFT, 1));
  const pressed = mouse && sendMouse(start.hit, "mousedown", mouseInit(start.point, LEFT, 1, 1));
  const source = pressed ? draggableFrom(start.hit) : undefined;
  if (source !== undefined) {
    moveTo(start.hit, start.point, page.pointer, 1);
    const dropped = dragAndDrop(source, start, end);
    if (dropped !== undefined) {
      page.pointer.over = new WeakRef(end.hit);
      return { ...refs, mode: "html5", dropped };
    }
  }
  let last = start.hit;
  for (const point of dragPoints(start.point, end.point)) {
    last = deepElementAt(point) ?? document.documentElement;
    moveTo(last, point, page.pointer, 1, mouse);
  }
  sendPointer(last, "pointerup", pointerInit(end.point, LEFT, 0));
  if (mouse) sendMouse(last, "mouseup", mouseInit(end.point, LEFT, 0, 1));
  return { ...refs, mode: "pointer", dropped: true };
}

/**
 * The target's point and the element hit there. An element is scrolled into view first when
 * `scrollFirst` is set, and must then show some of itself, uncovered, at the point.
 */
function locate(target: PointTarget, refs: ElementRefs<Element>, scrollFirst: boolean): Located {
  if (target.ref === undefined) return locatePoint({ x: target.x, y: target.y }, refs);
  const { ref } = target;
  const lookup = refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const element = lookup.element;
  const scrollBack = scrollFirst && wantsScroll(element) ? scrollToCentre(element) : undefined;
  const located = orScrollBack(scrollBack, () => pointOn(element, ref, refs));
  return scrollBack === undefined ? located : { ...located, scrollBack };
}

/** What `find` returns; when it refuses, the page is first scrolled back as it was. */
function orScrollBack<T>(scrollBack: (() => void) | undefined, find: () => T): T {
  try {
    return find();
  } catch (error) {
    scrollBack?.();
    throw error;
  }
}

function locatePoint(point: Point, refs: ElementRefs<Element>): Located {
  const hit = elementAt(point);
  refuseFrame(hit, refs);
  return { hit, point, ref: refs.refFor(hit) };
}

function elementAt(point: Point): Element {
  const hit = deepElementAt(point);
  if (hit === null) {
    throw new PageError(
      "no_element_at_point",
      `There is no element at x ${point.x}, y ${point.y} in the tab's viewport.`,
    );
  }
  return hit;
}

/**
 * Whether scrolling may show more of the element: part of it is outside the viewport, or
 * something else shows at its visible centre, such as a scrolling box around it that clips it
 * or a fixed header over it.
 */
function wantsScroll(element: Element): boolean {
  if (!fullyInside(element.getBoundingClientRect(), viewport())) return true;
  const point = visiblePointOf(element);
  if (point === undefined) return false;
  const hit = deepElementAt(point);
  return hit === null || !isWithin(hit, element);
}

/** Scrolls the element to the viewport's centre, and returns how to scroll everything back. */
function scrollToCentre(element: Element): () => void {
  const boxes = chainOf(element)
    .slice(1)
    .map((box) => ({ box, left: box.scrollLeft, top: box.scrollTop }));
  const page = { left: window.scrollX, top: window.scrollY };
  // Instant, so scroll-behavior: smooth cannot leave the element mid-scroll.
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return () => {
    for (const { box, left, top } of boxes) box.scrollTo({ left, top, behavior: "instant" });
    window.scrollTo({ ...page, behavior: "instant" });
  };
}

/** The element's visible centre and the element hit there, which must be it or inside it. */
function pointOn(element: Element, ref: string, refs: ElementRefs<Element>): Located {
  const point = visiblePointOf(element);
  const hit = point === undefined ? null : deepElementAt(point);
  if (point === undefined || hit === null) {
    throw new PageError(
      "element_not_visible",
      `Element ${ref} has no visible part in the tab's viewport, so Foxhand cannot point at it.`,
    );
  }
  if (!isWithin(hit, element)) {
    throw new PageError(
      "element_covered",
      `Element ${ref} is covered at its visible centre by element ${refs.refFor(hit)} (${hit.localName}); close or act on that element first.`,
    );
  }
  refuseFrame(hit, refs);
  return { hit, point, ref };
}

/** The centre of the element's visible part in the viewport, if it shows any. */
function visiblePointOf(element: Element): Point | undefined {
  if (!element.checkVisibility({ visibilityProperty: true })) return undefined;
  return visiblePoint(Array.from(element.getClientRects()), viewport());
}

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The innermost element at the point, inside shadow roots too, closed ones included. */
function deepElementAt(point: Point): Element | null {
  let hit = document.elementFromPoint(point.x, point.y);
  while (hit !== null) {
    const inner = shadowRootOf(hit)?.elementFromPoint(point.x, point.y) ?? null;
    // A shadow root with nothing of its own at the point answers with its host.
    if (inner === null || inner === hit) return hit;
    hit = inner;
  }
  return null;
}

/** Whether `inner` is `outer` or inside it in the flat tree. */
function isWithin(inner: Element, outer: Element): boolean {
  return chainOf(inner).includes(outer);
}

/** The element and its flat-tree ancestors, innermost first. */
function chainOf(element: Element): Element[] {
  const chain: Element[] = [];
  for (let current: Element | null = element; current !== null; current = flatParentOf(current)) {
    chain.push(current);
  }
  return chain;
}

function refuseFrame(hit: Element, refs: ElementRefs<Element>): void {
  if (hit.namespaceURI === HTML && FRAMES.has(hit.localName)) {
    throw new PageError(
      "in_frame",
      `Element ${refs.refFor(hit)} at that point is a frame (${hit.localName}); Foxhand acts only in the top page, not inside frames.`,
    );
  }
}

/** Refuses a left click on the target that would open a page on another site. */
function refuseCrossSite(target: Located): void {
  const site = crossSiteOf(target.hit);
  if (site !== undefined) {
    throw new PageError(
      "cross_site_navigation",
      `Element ${target.ref} leads to a page on ${site}, which Foxhand does not open by clicking; call navigate with that address, and Foxhand asks the user first if the site is not approved.`,
    );
  }
}

/**
 * The other site a click on `hit` would open a page on: through a link or submit button around
 * it, or through the control of a label around it, which the click is forwarded to once.
 */
function crossSiteOf(hit: Element): string | undefined {
  for (const element of chainOf(hit)) {
    const site = crossSiteFrom(element);
    if (site !== undefined) return site;
    const control = element instanceof HTMLLabelElement ? element.control : null;
    if (control !== null) {
      for (const around of chainOf(control)) {
        const forwarded = crossSiteFrom(around);
        if (forwarded !== undefined) return forwarded;
      }
    }
  }
  return undefined;
}

function crossSiteFrom(element: Element): string | undefined {
  for (const { value, base } of destinationsOf(element)) {
    const site = crossSiteDestination(value, base, location.href);
    if (site !== undefined) return site;
  }
  return undefined;
}

/** Where activating the element would navigate: its link targets or its form's action. */
function destinationsOf(element: Element): { value: string; base: string }[] {
  const base = element.baseURI;
  if (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) {
    // In no namespace: getAttribute can answer with a namespaced attribute of the same name.
    const href = element.getAttributeNS(null, "href");
    return href === null ? [] : [{ value: href, base }];
  }
  if (element instanceof SVGAElement) {
    // Firefox follows the animated value, which a SMIL <set> can give with no attribute. An
    // empty href, set or animated, still links: to the base URL.
    const given = [
      element.getAttributeNS(null, "href"),
      element.getAttributeNS(XLINK, "href"),
      ...animatedHrefs(element),
    ].filter((value): value is string => value !== null);
    const animated = element.href.animVal;
    const values = given.length === 0 && animated === "" ? [] : [animated, ...given];
    return values.map((value) => ({ value, base }));
  }
  if (element.namespaceURI === MATHML) {
    const href = element.getAttributeNS(null, "href");
    return href === null ? [] : [{ value: href, base }];
  }
  const form = submittedForm(element);
  if (form === null) return [];
  // Through Element.prototype: a form control named action or getAttributeNS shadows the form's own.
  const action = Element.prototype.getAttributeNS.call(form, null, "action");
  const formaction = element.getAttributeNS(null, "formaction");
  const destination = formDestination(formaction, action, location.href);
  return [{ value: destination, base }];
}

/**
 * Every value SMIL animations of the link's href can give it, begun or not: one that begins on
 * the click itself changes the href after both checks.
 */
function animatedHrefs(link: SVGAElement): string[] {
  const root = link.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return [];
  const values: string[] = [];
  for (const animation of root.querySelectorAll("set, animate")) {
    if (!(animation instanceof SVGAnimationElement) || animation.targetElement !== link) continue;
    const name = (animation.getAttributeNS(null, "attributeName") ?? "").trim();
    if (!/^(?:[^:]+:)?href$/.test(name)) continue;
    const to = animation.getAttributeNS(null, "to");
    const from = animation.getAttributeNS(null, "from");
    const list = animation.getAttributeNS(null, "values");
    if (to !== null) values.push(to);
    if (from !== null) values.push(from);
    if (list !== null) values.push(...list.split(";"));
  }
  return values;
}

/** The form a click on the element submits, if it is a submit button. */
function submittedForm(element: Element): HTMLFormElement | null {
  if (element instanceof HTMLButtonElement && element.type === "submit") return element.form;
  if (
    element instanceof HTMLInputElement &&
    (element.type === "submit" || element.type === "image")
  ) {
    return element.form;
  }
  return null;
}

/**
 * Moves the synthetic pointer onto `element`: out and leave events on the element it was over,
 * over and enter events on the new one, then a move. A pressed pointer whose pointerdown the page
 * cancelled sends no mousemove (Pointer Events: compatibility mouse events).
 */
function moveTo(
  element: Element,
  point: Point,
  pointer: PointerState,
  buttons: number,
  mouseMove = true,
): void {
  const remembered = pointer.over?.deref();
  const previous =
    remembered?.isConnected === true && remembered.ownerDocument === element.ownerDocument
      ? remembered
      : undefined;
  if (previous !== element) {
    const { leave, enter } = hoverTransitions(
      previous === undefined ? [] : chainOf(previous),
      chainOf(element),
    );
    const moving = pointerInit(point, -1, buttons);
    const mouse = mouseInit(point, LEFT, buttons, 0);
    if (previous !== undefined) {
      sendPointer(previous, "pointerout", { ...moving, relatedTarget: element });
      for (const left of leave) {
        sendPointer(left, "pointerleave", boundary({ ...moving, relatedTarget: element }));
      }
      sendMouse(previous, "mouseout", { ...mouse, relatedTarget: element });
      for (const left of leave) {
        sendMouse(left, "mouseleave", boundary({ ...mouse, relatedTarget: element }));
      }
    }
    const related = previous ?? null;
    sendPointer(element, "pointerover", { ...moving, relatedTarget: related });
    for (const entered of enter) {
      sendPointer(entered, "pointerenter", boundary({ ...moving, relatedTarget: related }));
    }
    sendMouse(element, "mouseover", { ...mouse, relatedTarget: related });
    for (const entered of enter) {
      sendMouse(entered, "mouseenter", boundary({ ...mouse, relatedTarget: related }));
    }
    pointer.over = new WeakRef(element);
  }
  sendPointer(element, "pointermove", pointerInit(point, -1, buttons));
  if (mouseMove) sendMouse(element, "mousemove", mouseInit(point, LEFT, buttons, 0));
}

/**
 * A button pressed and released at the point. As a real mousedown does, an uncancelled one
 * focuses the nearest element around the hit that a click focuses, or takes focus away when
 * there is none. A pointerdown the page cancels holds back the mousedown, its focus change and
 * the mouseup, as Firefox does for a real press.
 */
function press(hit: Element, point: Point, button: number, detail: number): void {
  const buttons = button === RIGHT ? 2 : 1;
  const mouse = sendPointer(hit, "pointerdown", pointerInit(point, button, buttons));
  if (mouse && sendMouse(hit, "mousedown", mouseInit(point, button, buttons, detail))) {
    focusFrom(hit);
  }
  sendPointer(hit, "pointerup", pointerInit(point, button, 0));
  if (mouse) sendMouse(hit, "mouseup", mouseInit(point, button, 0, detail));
}

function focusFrom(hit: Element): void {
  const before = focusedElement();
  if (chainOf(hit).some((element) => clickFocus(element, before))) return;
  const focused = focusedElement();
  if (focused instanceof HTMLElement || focused instanceof SVGElement) focused.blur();
}

/**
 * Focuses the element as a click does, and whether focus moved or was there already. A host
 * that delegates focus passes it on as a click does, even from an element inside it: `focus()`
 * on the host would keep focus there or pick a scrolling box.
 */
function clickFocus(element: Element, before: Element | null): boolean {
  const root = shadowRootOf(element);
  if (root?.delegatesFocus === true) return delegateFocus(root, before);
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
  if (!clickFocuses(element)) return false;
  element.focus({ preventScroll: true });
  return tookFocus(element, before);
}

/** Focuses the first element in the shadow tree a click focuses, those with autofocus first. */
function delegateFocus(root: ShadowRoot, before: Element | null): boolean {
  const elements = [...root.querySelectorAll("*")];
  const autofocused = elements.filter((element) => element.hasAttribute("autofocus"));
  return [...autofocused, ...elements].some((element) => clickFocus(element, before));
}

/**
 * Whether a click may focus the element: a valid tabindex, a kind focusable by default, or an
 * editing host. `focus()` alone also takes a scrolling box, the page's root among them, which
 * Firefox focuses from script but not from a click.
 */
function clickFocuses(element: HTMLElement | SVGElement): boolean {
  const tabindex = element.getAttributeNS(null, "tabindex");
  return (
    (tabindex !== null && TABINDEX.test(tabindex)) ||
    element.tabIndex >= 0 ||
    isEditingHost(element)
  );
}

/**
 * Whether focusing the element moved focus, or found it there already. Not `:focus`: a shadow
 * host matches it whenever focus is anywhere in its shadow tree, focusable or not.
 */
function tookFocus(element: Element, before: Element | null): boolean {
  const now = focusedElement();
  return now !== before || now === element;
}

/** The element a drag from `hit` picks up in HTML drag and drop, if any. */
function draggableFrom(hit: Element): HTMLElement | undefined {
  for (const element of chainOf(hit)) {
    if (element instanceof HTMLElement && element.draggable) return element;
  }
  return undefined;
}

/**
 * HTML drag and drop from `source` at the start to the end: whether the end accepted the drop,
 * or undefined when no drag starts: the page cancelled dragstart, or broke its DataTransfer.
 */
function dragAndDrop(source: HTMLElement, start: Located, end: Located): boolean | undefined {
  const transfer = pageTransfer();
  if (transfer === undefined || !sendDrag(source, "dragstart", start.point, transfer)) {
    return undefined;
  }
  // A drag that starts cancels the pointer (Pointer Events: suppressing a pointer event stream).
  sendPointer(start.hit, "pointercancel", {
    ...pointerInit(start.point, -1, 0),
    cancelable: false,
  });
  sendDrag(source, "drag", start.point, transfer);
  sendDrag(end.hit, "dragenter", end.point, transfer);
  const accepted = !sendDrag(end.hit, "dragover", end.point, transfer);
  sendDrag(end.hit, accepted ? "drop" : "dragleave", end.point, transfer);
  sendDrag(source, "dragend", start.point, transfer);
  return accepted;
}

/** A DataTransfer of the page's realm, unless the page replaced the constructor with a throwing one. */
function pageTransfer(): DataTransfer | undefined {
  try {
    // Made in the page's realm: Firefox hides from the page the items another principal added.
    return new window.wrappedJSObject.DataTransfer();
  } catch {
    return undefined;
  }
}

/** Scrolls the element into view, unless all of it is in view already. */
function bringIntoView(ref: string, refs: ElementRefs<Element>): Result<"scroll"> {
  const lookup = refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const element = lookup.element;
  const before = element.getBoundingClientRect();
  if (wantsScroll(element)) scrollToCentre(element);
  if (element.getClientRects().length === 0) {
    throw new PageError(
      "element_not_visible",
      `Element ${ref} has no box on the page, so Foxhand cannot scroll it into view.`,
    );
  }
  const after = element.getBoundingClientRect();
  const moved = before.left !== after.left || before.top !== after.top;
  return { ref, scrollLeft: window.scrollX, scrollTop: window.scrollY, moved };
}

/**
 * A wheel event at the target or the viewport's centre, then the scroll it would cause: the
 * first box around the hit that scrolls that way and moves, else the page.
 */
function wheel(options: ScrollByOptions, page: ActionPage): Result<"scroll"> {
  const start = { left: window.scrollX, top: window.scrollY };
  const { hit, point } =
    options.ref !== undefined
      ? locate({ ref: options.ref }, page.refs, true)
      : options.x !== undefined
        ? locate({ x: options.x, y: options.y }, page.refs, true)
        : atCentre();
  moveTo(hit, point, page.pointer, 0);
  const axis: Axis = options.direction === "left" || options.direction === "right" ? "x" : "y";
  const candidates = scrollCandidates(hit, axis);
  const step = (clientSize: number) =>
    scrollDelta(options.direction, options.amount ?? defaultAmount(clientSize));
  const wheelDelta = step(clientSizeOf(candidates, axis));
  const event = new (viewOf(hit).WheelEvent)("wheel", {
    ...mouseInit(point, LEFT, 0, 0),
    deltaMode: 0,
    deltaX: wheelDelta.left,
    deltaY: wheelDelta.top,
    deltaZ: 0,
  });
  // Synthetic wheel events do not scroll by themselves.
  if (!hit.dispatchEvent(event)) return pagePosition(start);
  for (const candidate of candidates) {
    const { element } = candidate;
    const delta = step(axis === "x" ? element.clientWidth : element.clientHeight);
    const before = positionOf(candidate);
    element.scrollBy({ left: delta.left, top: delta.top, behavior: "instant" });
    const after = positionOf(candidate);
    if (after.scrollLeft !== before.scrollLeft || after.scrollTop !== before.scrollTop) {
      return candidate.page
        ? { ...after, moved: true }
        : { ref: page.refs.refFor(candidate.element), ...after, moved: true };
    }
  }
  return pagePosition(start);
}

/** The viewport's centre and the element there; a frame there takes the wheel in the top page. */
function atCentre(): { hit: Element; point: Point } {
  const point = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { hit: elementAt(point), point };
}

/**
 * The boxes a wheel at `hit` may scroll along the axis, innermost first: the scroll containers
 * around it, then the page unless its overflow is hidden or clip on that axis.
 */
function scrollCandidates(hit: Element, axis: Axis): Candidate[] {
  const root = document.documentElement;
  const body = document.body instanceof HTMLBodyElement ? document.body : undefined;
  const { viewport: pageOverflow, bodyScrolls } = viewportOverflow(
    overflowOf(root),
    body === undefined ? undefined : overflowOf(body),
    axis,
  );
  const candidates: Candidate[] = [];
  for (const element of chainOf(hit)) {
    if (element === root) break;
    if (element === body && !bodyScrolls) continue;
    if (wheelScrolls(overflowOf(element)[axis])) candidates.push({ element, page: false });
  }
  if (wheelScrolls(pageOverflow)) {
    candidates.push({ element: document.scrollingElement ?? root, page: true });
  }
  return candidates;
}

function overflowOf(element: Element): { x: string; y: string } {
  const style = getComputedStyle(element);
  return { x: style.overflowX, y: style.overflowY };
}

/** The client size along the axis of the first candidate with more to show, else the page's. */
function clientSizeOf(candidates: readonly Candidate[], axis: Axis): number {
  for (const { element } of candidates) {
    if (axis === "x" && element.scrollWidth > element.clientWidth) return element.clientWidth;
    if (axis === "y" && element.scrollHeight > element.clientHeight) return element.clientHeight;
  }
  const page = document.scrollingElement ?? document.documentElement;
  return axis === "x" ? page.clientWidth : page.clientHeight;
}

function positionOf(candidate: Candidate): { scrollLeft: number; scrollTop: number } {
  if (candidate.page) return { scrollLeft: window.scrollX, scrollTop: window.scrollY };
  return { scrollLeft: candidate.element.scrollLeft, scrollTop: candidate.element.scrollTop };
}

/** The page's position, and whether it moved from `start`, as bringing the target into view can. */
function pagePosition(start: { left: number; top: number }): Result<"scroll"> {
  const scrollLeft = window.scrollX;
  const scrollTop = window.scrollY;
  return { scrollLeft, scrollTop, moved: scrollLeft !== start.left || scrollTop !== start.top };
}

function mouseInit(point: Point, button: number, buttons: number, detail: number): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    button,
    buttons,
    detail,
  };
}

/** Firefox gives the mouse pointer id 0; setPointerCapture throws for an id it does not know. */
function pointerInit(point: Point, button: number, buttons: number): PointerEventInit {
  return {
    ...mouseInit(point, button, buttons, 0),
    pointerId: 0,
    pointerType: "mouse",
    isPrimary: true,
  };
}

/** Enter and leave events neither bubble nor can be cancelled. */
function boundary<T extends MouseEventInit>(init: T): T {
  return { ...init, bubbles: false, cancelable: false, composed: false };
}

/** Whether the page let the event's default happen. */
function sendPointer(target: Element, type: string, init: PointerEventInit): boolean {
  return target.dispatchEvent(new (viewOf(target).PointerEvent)(type, init));
}

function sendMouse(target: Element, type: string, init: MouseEventInit): boolean {
  return target.dispatchEvent(new (viewOf(target).MouseEvent)(type, init));
}

function sendDrag(target: Element, type: string, point: Point, transfer: DataTransfer): boolean {
  const event = new (viewOf(target).DragEvent)(type, {
    bubbles: true,
    cancelable: type !== "dragleave" && type !== "dragend",
    composed: true,
    clientX: point.x,
    clientY: point.y,
    dataTransfer: transfer,
  });
  return target.dispatchEvent(event);
}

/** The page window's constructors, so events are made in the page's realm. */
function viewOf(element: Element): Window & typeof globalThis {
  return element.ownerDocument.defaultView ?? window;
}
