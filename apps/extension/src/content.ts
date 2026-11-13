import type { BrowserApi } from "./browser-api.ts";
import { readConsoleRecords } from "./console-messages.ts";
import { elementRect } from "./element-rect.ts";
import { createElementRefs, type ElementRefs } from "./element-refs.ts";
import { clickOptions, dragOptions, hoverOptions, scrollOptions } from "./page-actions.ts";
import * as actions from "./page-actions-dom.ts";
import { createPageChanges, type PageChanges } from "./page-changes.ts";
import { fillFormOptions } from "./page-fill.ts";
import { fillForm } from "./page-fill-dom.ts";
import { pressKeyOptions, typeOptions } from "./page-input.ts";
import * as input from "./page-input-dom.ts";
import {
  handlePageMessage,
  isRecord,
  ownField,
  PageError,
  type PageHandlers,
} from "./page-messages.ts";
import { pageTextOptions, tidyText } from "./page-text.ts";
import { readPageText, renderedText } from "./page-text-dom.ts";
import { uploadFile } from "./page-upload.ts";
import {
  describeElement,
  focusedElement,
  notePasswordFields,
  type PageMemory,
  passwordFieldsRevealed,
  readPage,
} from "./read-page.ts";
import { siteOf } from "./site.ts";

declare const browser: Pick<BrowserApi, "runtime">;

// Set once per document on the content scripts' own global, which the page cannot see.
const STARTED = "foxleashPageScript";

// The background injects this on every request; only the first run in a document sets up.
if (!Object.hasOwn(globalThis, STARTED)) {
  // An element the page moved into another document, such as a frame's, is not this one's.
  const refs = createElementRefs<Element>(
    (element) => element.isConnected && element.ownerDocument === document,
  );
  const passwordFields = new WeakSet<Element>();
  const pointer: actions.PointerState = { over: undefined };
  const changes = createPageChanges(document);
  const memory: PageMemory = { refs, passwordFields };
  const watched: Watched = { memory, changes };
  const byRef = (params: Record<string, unknown>) => refTarget(refs, ownField(params, "ref"));
  const handlers: PageHandlers = {
    read_page: (params) => readPage(params, memory),
    get_page_text: (params) => {
      const options = pageTextOptions(params);
      if (typeof options === "string") throw new PageError("invalid_params", options);
      return readPageText(document, options);
    },
    element_rect: (params) => elementRect(params, { refs }),
    password_fields: () => passwordFieldsRevealed({ passwordFields }),
    upload_file: act(watched, (params) => uploadFile(params, { refs }), byRef),
    click: act(
      watched,
      (params) => actions.click(parsed(clickOptions(params)), { refs, pointer }),
      byRef,
      true,
    ),
    hover: act(
      watched,
      (params) => actions.hover(parsed(hoverOptions(params)), { refs, pointer }),
      byRef,
      true,
    ),
    scroll: act(
      watched,
      (params) => actions.scroll(parsed(scrollOptions(params)), { refs, pointer }),
      byRef,
    ),
    drag: act(
      watched,
      (params) => actions.drag(parsed(dragOptions(params)), { refs, pointer }),
      byRef,
      true,
    ),
    type: act(watched, (params) => input.typeText(parsed(typeOptions(params)), { refs }), byRef),
    press_key: act(
      watched,
      (params) => input.pressKey(parsed(pressKeyOptions(params)), { refs }),
      (params) => (Object.hasOwn(params, "ref") ? byRef(params) : (focusedElement() ?? undefined)),
    ),
    fill_form: act(
      watched,
      (params) =>
        fillForm(parsed(fillFormOptions(params)), {
          refs,
          notePasswordFields: () => notePasswordFields({ passwordFields }),
        }),
      () => undefined,
    ),
    page_changes: (params) => changes.read(ownField(params, "watch")),
    read_console: () => readConsoleRecords(window),
    wait_for: (params) => conditionMet(params),
  };
  browser.runtime.onMessage.addListener((message) =>
    handlePageMessage(message, {
      site: siteOf(location.href),
      handlers,
      adopt: (tag) => refs.adopt(tag),
      before: () => notePasswordFields({ passwordFields }),
    }),
  );
  // Last, so a throw above leaves the next injection free to try again.
  Object.defineProperty(globalThis, STARTED, { value: true });
}

interface Watched {
  memory: PageMemory;
  changes: PageChanges;
}

/**
 * The act's handler, with a watch of the page started right before it runs, and its result with
 * the watch's id and the element that took the act: `target`'s, described before the act can
 * remove it, or, with `fromResult` when the act had no target up front, the element of the
 * result's ref. The act's own result never has fields of these names.
 */
function act(
  { memory, changes }: Watched,
  handler: (params: Record<string, unknown>) => unknown,
  target: (params: Record<string, unknown>) => Element | undefined,
  fromResult = false,
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params) => {
    const before = target(params);
    const described = before === undefined ? undefined : describeElement(before, memory);
    const watch = changes.start();
    const result: unknown = await handler(params);
    if (!isRecord(result)) return result;
    let element = described;
    if (before === undefined && fromResult) {
      const after = refTarget(memory.refs, ownField(result, "ref"));
      element = after === undefined ? undefined : describeElement(after, memory);
    }
    return element === undefined ? { ...result, watch } : { ...result, watch, element };
  };
}

/** The element a ref names, or undefined for none, without throwing: the act refuses a bad ref. */
function refTarget(refs: ElementRefs<Element>, ref: unknown): Element | undefined {
  if (ref === undefined) return undefined;
  const lookup = refs.resolve(ref);
  return "element" in lookup ? lookup.element : undefined;
}

/** Parsed options, or the refusal as the page's error. */
function parsed<T>(options: T | string): T {
  if (typeof options === "string") throw new PageError("invalid_params", options);
  return options;
}

/** Whether the page shows the text, or has an element matching the selector, wait_for asks for. */
function conditionMet(params: Record<string, unknown>): boolean {
  const text = ownField(params, "text");
  if (typeof text === "string") return tidyText(renderedText(document)).includes(text);
  const selector = ownField(params, "selector");
  if (typeof selector !== "string") {
    throw new PageError("invalid_params", "wait_for needs a text or a selector.");
  }
  try {
    return document.querySelector(selector) !== null;
  } catch {
    // querySelector throws only for a selector that does not parse.
    throw new PageError("invalid_params", "The selector is not valid CSS.");
  }
}
