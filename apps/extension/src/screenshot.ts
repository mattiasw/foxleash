import type { CaptureArea } from "./browser-api.ts";
import type { ElementBox } from "./element-rect.ts";
import { isRecord, ownField } from "./page-messages.ts";
import { CREDENTIAL_TOKENS } from "./page-tree.ts";

/** Below the host's 64 MiB frame, with room for the envelope. */
export const MAX_SCREENSHOT_CHARS = 48 * 1024 * 1024;
/** Above the widest window X11 allows, 32,767 px, at Firefox's 30% minimum zoom. */
export const MAX_VIEWPORT_SIDE = 131_072;

/** A refusal for the handler to throw as a ToolError. */
export interface Refusal {
  code: string;
  message: string;
}

/**
 * User-origin declarations that hide a field's text and every copy of it the page could draw:
 * they beat the page's author `!important`, inline styles and animations.
 */
const MASK_DECLARATIONS: readonly string[] = [
  "color: transparent !important",
  // Firefox's forms.css forces `color: FieldText !important` on autofilled fields.
  "-webkit-text-fill-color: transparent !important",
  "-webkit-text-stroke-color: transparent !important",
  "text-shadow: none !important",
  "text-emphasis-color: transparent !important",
  "text-decoration-color: transparent !important",
  "caret-color: transparent !important",
  "background-clip: border-box !important",
  // Else a page transition on color animates the change, and the capture shows the text.
  "transition: none !important",
];
const MASK_BODY = `{ ${MASK_DECLARATIONS.join("; ")}; }`;
/** read_page's protected fields (ADR 0010, 0021), but for the remembered password fields. */
const FIELD_SELECTORS: readonly string[] = [
  'input[type="password" i]',
  ...CREDENTIAL_TOKENS.flatMap((token) => [
    `input[*|autocomplete~="${token}" i]`,
    `textarea[*|autocomplete~="${token}" i]`,
  ]),
  "input:autofill",
  "textarea:autofill",
];

/**
 * Hides a view transition's old snapshot, taken before the sheet went in, from a capture that
 * paints it: WebDriver's does, while Firefox 156's captureTab draws the live page. A rule of its
 * own, as Firefox before view transitions rejects the selector.
 */
const SNAPSHOT_RULE =
  "::view-transition-old(*) { opacity: 0 !important; transition: none !important; }\n";

/** The style sheet that hides the text of protected fields in every frame of a screenshot. */
export const FIELD_MASK_CSS = maskCss(FIELD_SELECTORS) + SNAPSHOT_RULE;
/** The style sheet that hides the text of every input in the top document of a screenshot. */
export const INPUT_MASK_CSS = maskCss(["input"]);
/**
 * The style sheet that keeps every frame of a document unpainted (ADR 0031), for a document that
 * holds another add-on's frame. Visibility and opacity change no layout; a page's transition
 * would beat the important declarations, so it is switched off.
 */
export const FRAME_HIDE_CSS =
  "iframe, frame, object, embed, browser, editor { visibility: hidden !important; opacity: 0 !important; transition: none !important; }\n";

const PNG_PREFIX = "data:image/png;base64,";
/** Base64 text; exact only together with a `length % 4` check. */
export const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The area of the page to capture for an element, from the content script's reply: the
 * element's box cut to the viewport and rounded outward to whole CSS pixels, then moved by the
 * page's scroll, which may be fractional, to be relative to the page. The reply comes from the
 * page's content process, so it is read as untrusted input: own fields, finite numbers.
 */
export function captureRect(reply: unknown, tabId: number): { rect: CaptureArea } | Refusal {
  const box = elementBox(reply);
  if (box === undefined) return pageError(tabId);
  const { rect, viewport, scroll } = box;
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.left + rect.width, viewport.width);
  const bottom = Math.min(rect.top + rect.height, viewport.height);
  if (right <= left || bottom <= top) return notVisible(tabId);
  const x = Math.floor(left);
  const y = Math.floor(top);
  const width = Math.min(Math.ceil(right), Math.floor(viewport.width)) - x;
  const height = Math.min(Math.ceil(bottom), Math.floor(viewport.height)) - y;
  if (width <= 0 || height <= 0) return notVisible(tabId);
  return { rect: { x: x + scroll.x, y: y + scroll.y, width, height } };
}

/**
 * Whether the page turned a remembered password field into another kind, from the content
 * script's reply, read as untrusted input: an own boolean field.
 */
export function revealedReply(reply: unknown, tabId: number): { revealed: boolean } | Refusal {
  const revealed = isRecord(reply) ? ownField(reply, "revealed") : undefined;
  return typeof revealed === "boolean" ? { revealed } : pageError(tabId);
}

/** The base64 PNG in the data URL that `tabs.captureTab` resolved to. */
export function pngData(dataUrl: unknown, tabId: number): { data: string } | Refusal {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_PREFIX)) {
    return screenshotFailed(tabId);
  }
  const data = dataUrl.slice(PNG_PREFIX.length);
  if (data.length > MAX_SCREENSHOT_CHARS) {
    return {
      code: "screenshot_too_large",
      message: `The screenshot of tab ${tabId} is too large to return; take one of a single element with ref.`,
    };
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) return screenshotFailed(tabId);
  return { data };
}

export function screenshotFailed(tabId: number): Refusal {
  return {
    code: "screenshot_failed",
    message: `Firefox could not take a screenshot of tab ${tabId}.`,
  };
}

/**
 * Two rules, so a selector Firefox rejects, which drops its whole rule, cannot drop the other:
 * the fields, and their selected text.
 */
function maskCss(selectors: readonly string[]): string {
  const selected = selectors.map((selector) => `${selector}::selection`);
  return `${selectors.join(", ")} ${MASK_BODY}\n${selected.join(", ")} ${MASK_BODY}\n`;
}

function elementBox(reply: unknown): ElementBox | undefined {
  if (!isRecord(reply)) return undefined;
  const rect = recordField(reply, "rect");
  const viewport = recordField(reply, "viewport");
  const scroll = recordField(reply, "scroll");
  if (rect === undefined || viewport === undefined || scroll === undefined) return undefined;
  const left = finiteField(rect, "left");
  const top = finiteField(rect, "top");
  const width = sizeField(rect, "width");
  const height = sizeField(rect, "height");
  const viewportWidth = sideField(viewport, "width");
  const viewportHeight = sideField(viewport, "height");
  const x = finiteField(scroll, "x");
  const y = finiteField(scroll, "y");
  if (
    left === undefined ||
    top === undefined ||
    width === undefined ||
    height === undefined ||
    viewportWidth === undefined ||
    viewportHeight === undefined ||
    x === undefined ||
    y === undefined
  ) {
    return undefined;
  }
  return {
    rect: { left, top, width, height },
    viewport: { width: viewportWidth, height: viewportHeight },
    scroll: { x, y },
  };
}

function recordField(value: object, key: string): Record<string, unknown> | undefined {
  const field = ownField(value, key);
  return isRecord(field) ? field : undefined;
}

function sideField(value: object, key: string): number | undefined {
  const side = sizeField(value, key);
  return side !== undefined && side <= MAX_VIEWPORT_SIDE ? side : undefined;
}

function sizeField(value: object, key: string): number | undefined {
  const size = finiteField(value, key);
  return size !== undefined && size >= 0 ? size : undefined;
}

function finiteField(value: object, key: string): number | undefined {
  const field = ownField(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function pageError(tabId: number): Refusal {
  return {
    code: "page_error",
    message: `Foxhand could not complete the request in the page in tab ${tabId}.`,
  };
}

function notVisible(tabId: number): Refusal {
  return {
    code: "element_not_visible",
    message: `The element has no visible area in tab ${tabId}.`,
  };
}
