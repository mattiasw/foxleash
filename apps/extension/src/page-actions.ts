import type { ClickButton, DragMode, Result, ScrollDirection } from "@foxhand/protocol";
import { REF } from "./element-refs.ts";
import { isRecord, ownField } from "./page-messages.ts";
import { siteOf } from "./site.ts";

/** An element by ref, or a point in the viewport in CSS pixels. */
export type PointTarget =
  | { ref: string; x?: never; y?: never }
  | { x: number; y: number; ref?: never };

export type ClickOptions = PointTarget & { button: ClickButton; doubleClick: boolean };

export type HoverOptions = PointTarget;

/**
 * Without a direction, `ref` scrolled into view; with one, a wheel at the target, or at the
 * viewport's centre when there is none.
 */
export type ScrollOptions = { ref: string; direction?: never; amount?: never } | ScrollByOptions;

export type ScrollByOptions = { direction: ScrollDirection; amount?: number } & (
  | PointTarget
  | NoTarget
);

type NoTarget = { ref?: never; x?: never; y?: never };

export type DragEndTarget =
  | { targetRef: string; targetX?: never; targetY?: never }
  | { targetX: number; targetY: number; targetRef?: never };

export type DragOptions = PointTarget & DragEndTarget;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** An element's computed `overflow-x` and `overflow-y`. */
export interface Overflow {
  x: string;
  y: string;
}

export type Axis = "x" | "y";

const DIRECTIONS: readonly unknown[] = ["up", "down", "left", "right"] satisfies ScrollDirection[];
const DRAG_STEPS = 5;

/** The options of a click request, or the sentence that refuses them. */
export function clickOptions(params: Record<string, unknown>): ClickOptions | string {
  const target = pointTarget(params, "click");
  if (typeof target === "string") return target;
  const button = orDefault(ownField(params, "button"), "left");
  if (button !== "left" && button !== "right") return "click needs button to be left or right.";
  const doubleClick = orDefault(ownField(params, "doubleClick"), false);
  if (typeof doubleClick !== "boolean") return "click needs doubleClick to be true or false.";
  if (doubleClick && button === "right")
    return "click takes doubleClick only with the left button.";
  return { ...target, button, doubleClick };
}

/** The options of a hover request, or the sentence that refuses them. */
export function hoverOptions(params: Record<string, unknown>): HoverOptions | string {
  return pointTarget(params, "hover");
}

/** The options of a scroll request, or the sentence that refuses them. */
export function scrollOptions(params: Record<string, unknown>): ScrollOptions | string {
  const ref = ownField(params, "ref");
  const x = ownField(params, "x");
  const y = ownField(params, "y");
  const direction = ownField(params, "direction");
  const amount = ownField(params, "amount");
  if (ref !== undefined && (x !== undefined || y !== undefined)) {
    return "scroll takes either ref or both x and y, not both.";
  }
  if ((x === undefined) !== (y === undefined)) return "scroll needs both x and y, not one of them.";
  if (ref !== undefined && typeof ref !== "string") return "scroll needs ref to be a string.";
  if (x !== undefined && !(isCoordinate(x) && isCoordinate(y))) {
    return "scroll needs x and y to be numbers of 0 or more.";
  }
  if (direction !== undefined && !isDirection(direction)) {
    return "scroll needs direction to be up, down, left or right.";
  }
  if (
    amount !== undefined &&
    (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1)
  ) {
    return "scroll needs amount to be a whole number of 1 or more.";
  }
  if (direction === undefined) {
    if (amount !== undefined) return "scroll takes amount only with a direction.";
    if (typeof ref !== "string") {
      return "scroll needs a direction to scroll at x and y or at the centre of the page, or a ref to scroll into view.";
    }
    return { ref };
  }
  const at = scrollPoint(ref, x, y);
  return typeof amount === "number" ? { ...at, direction, amount } : { ...at, direction };
}

function isDirection(value: unknown): value is ScrollDirection {
  return DIRECTIONS.includes(value);
}

/** Where scroll acts, from fields already checked: the ref, the point, or nothing given. */
function scrollPoint(ref: unknown, x: unknown, y: unknown): PointTarget | NoTarget {
  if (typeof ref === "string") return { ref };
  if (typeof x === "number" && typeof y === "number") return { x, y };
  return {};
}

/** The options of a drag request, or the sentence that refuses them. */
export function dragOptions(params: Record<string, unknown>): DragOptions | string {
  const start = pointTarget(params, "drag", " for the start");
  if (typeof start === "string") return start;
  const targetRef = ownField(params, "targetRef");
  const targetX = ownField(params, "targetX");
  const targetY = ownField(params, "targetY");
  if (
    (targetX === undefined) !== (targetY === undefined) ||
    (targetRef !== undefined) === (targetX !== undefined)
  ) {
    return "drag needs either targetRef or both targetX and targetY for the end, not both and not neither.";
  }
  if (targetRef !== undefined) {
    if (typeof targetRef !== "string") return "drag needs targetRef to be a string.";
    return { ...start, targetRef };
  }
  if (!isCoordinate(targetX) || !isCoordinate(targetY)) {
    return "drag needs targetX and targetY to be numbers of 0 or more.";
  }
  return { ...start, targetX, targetY };
}

/** The content script's reply to click or hover, or undefined when it is not one. */
export function pointResultOf(value: unknown): Result<"click"> | undefined {
  if (!isRecord(value)) return undefined;
  const ref = ownField(value, "ref");
  const x = ownField(value, "x");
  const y = ownField(value, "y");
  if (!isRef(ref) || !isCoordinate(x) || !isCoordinate(y)) return undefined;
  return { ref, x, y };
}

/** The content script's reply to scroll, or undefined when it is not one. */
export function scrollResultOf(value: unknown): Result<"scroll"> | undefined {
  if (!isRecord(value)) return undefined;
  const ref = ownField(value, "ref");
  const scrollLeft = ownField(value, "scrollLeft");
  const scrollTop = ownField(value, "scrollTop");
  const moved = ownField(value, "moved");
  if (
    (ref !== undefined && !isRef(ref)) ||
    typeof scrollLeft !== "number" ||
    !Number.isFinite(scrollLeft) ||
    typeof scrollTop !== "number" ||
    !Number.isFinite(scrollTop) ||
    typeof moved !== "boolean"
  ) {
    return undefined;
  }
  const position = { scrollLeft, scrollTop, moved };
  return ref === undefined ? position : { ref, ...position };
}

/** The content script's reply to drag, or undefined when it is not one. */
export function dragResultOf(value: unknown): Result<"drag"> | undefined {
  if (!isRecord(value)) return undefined;
  const ref = ownField(value, "ref");
  const targetRef = ownField(value, "targetRef");
  const mode = ownField(value, "mode");
  const dropped = ownField(value, "dropped");
  if (
    !isRef(ref) ||
    !isRef(targetRef) ||
    (mode !== "html5" && mode !== "pointer") ||
    typeof dropped !== "boolean"
  ) {
    return undefined;
  }
  const dragMode: DragMode = mode;
  return { ref, targetRef, mode: dragMode, dropped };
}

/**
 * The site a click would open a page on, when it is not the page's own: `destination` resolved
 * against `base`. Undefined when the click may go ahead: an unparseable destination, one that is
 * not http or https, or one on the page's site. A base that does not parse is refused.
 */
export function crossSiteDestination(
  destination: string,
  base: string,
  pageUrl: string,
): string | undefined {
  const baseUrl = URL.parse(base);
  if (baseUrl === null) return "an unknown site";
  const url = URL.parse(destination, baseUrl);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  const site = siteOf(url.href);
  const pageSite = siteOf(pageUrl);
  if (site !== undefined && site === pageSite) return undefined;
  return site ?? url.origin;
}

/**
 * Where a submit button sends its form, as HTML's form submission picks it: the button's
 * `formaction` attribute when present, else the form's `action` attribute when present; an
 * empty result is the document's URL.
 */
export function formDestination(
  formaction: string | null,
  action: string | null,
  documentUrl: string,
): string {
  const value = formaction ?? action ?? "";
  return value === "" ? documentUrl : value;
}

/**
 * The viewport's overflow on an axis, from the computed overflow of the root element and of
 * `body`, and whether `body` is a scroll container of its own. CSS propagates `body`'s overflow
 * to the viewport when the root's is `visible` on both axes; `visible` there acts as `auto`.
 */
export function viewportOverflow(
  root: Overflow,
  body: Overflow | undefined,
  axis: Axis,
): { viewport: string; bodyScrolls: boolean } {
  const fromBody = root.x === "visible" && root.y === "visible" && body !== undefined;
  const value = fromBody ? body[axis] : root[axis];
  return { viewport: value === "visible" ? "auto" : value, bodyScrolls: !fromBody };
}

/** Whether a wheel scrolls a box with this computed overflow. */
export function wheelScrolls(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * The centre of the part of the first rect that is inside the viewport with some width and
 * height, or undefined when no rect is.
 */
export function visiblePoint(rects: Iterable<Box>, viewport: Viewport): Point | undefined {
  for (const rect of rects) {
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, viewport.width);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, viewport.height);
    if (right > left && bottom > top) return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  return undefined;
}

export function fullyInside(rect: Box, viewport: Viewport): boolean {
  return (
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= viewport.width &&
    rect.bottom <= viewport.height
  );
}

/**
 * The elements a pointer leaves and enters when it moves from one chain (an element and its
 * ancestors, innermost first) to another: `leave` innermost first, `enter` outermost first.
 */
export function hoverTransitions<T>(
  oldChain: readonly T[],
  newChain: readonly T[],
): { leave: T[]; enter: T[] } {
  return {
    leave: oldChain.filter((element) => !newChain.includes(element)),
    enter: newChain.filter((element) => !oldChain.includes(element)).reverse(),
  };
}

/** The scroll offset of one step in a direction. */
export function scrollDelta(
  direction: ScrollDirection,
  amount: number,
): { left: number; top: number } {
  switch (direction) {
    case "up":
      return { left: 0, top: -amount };
    case "down":
      return { left: 0, top: amount };
    case "left":
      return { left: -amount, top: 0 };
    case "right":
      return { left: amount, top: 0 };
  }
}

/** A scroll step when none is given: most of the box, so some of what was shown stays. */
export function defaultAmount(clientSize: number): number {
  return Math.max(1, Math.round(0.8 * clientSize));
}

/** The points a pointer drag moves through after `from`, the last one exactly `to`. */
export function dragPoints(from: Point, to: Point): Point[] {
  return Array.from({ length: DRAG_STEPS }, (_, index) => {
    const step = index + 1;
    if (step === DRAG_STEPS) return { x: to.x, y: to.y };
    return {
      x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
      y: from.y + ((to.y - from.y) * step) / DRAG_STEPS,
    };
  });
}

/** The field's value, or the default when it is not given; null counts as given. */
function orDefault(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

/** A ref or both x and y, never both and never neither, for click, hover and drag's start. */
function pointTarget(
  params: Record<string, unknown>,
  tool: string,
  which = "",
): PointTarget | string {
  const ref = ownField(params, "ref");
  const x = ownField(params, "x");
  const y = ownField(params, "y");
  if ((x === undefined) !== (y === undefined) || (ref !== undefined) === (x !== undefined)) {
    return `${tool} needs either ref or both x and y${which}, not both and not neither.`;
  }
  if (ref !== undefined) {
    return typeof ref === "string" ? { ref } : `${tool} needs ref to be a string.`;
  }
  if (!isCoordinate(x) || !isCoordinate(y)) {
    return `${tool} needs x and y to be numbers of 0 or more.`;
  }
  return { x, y };
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRef(value: unknown): value is string {
  return typeof value === "string" && REF.test(value);
}
