import type { BrowserApi } from "./browser-api.ts";
import { readConsoleRecords } from "./console-messages.ts";
import { elementRect } from "./element-rect.ts";
import { createElementRefs } from "./element-refs.ts";
import { clickOptions, dragOptions, hoverOptions, scrollOptions } from "./page-actions.ts";
import * as actions from "./page-actions-dom.ts";
import { fillFormOptions } from "./page-fill.ts";
import { fillForm } from "./page-fill-dom.ts";
import { pressKeyOptions, typeOptions } from "./page-input.ts";
import * as input from "./page-input-dom.ts";
import { handlePageMessage, ownField, PageError, type PageHandlers } from "./page-messages.ts";
import { pageTextOptions, tidyText } from "./page-text.ts";
import { readPageText, renderedText } from "./page-text-dom.ts";
import { uploadFile } from "./page-upload.ts";
import { notePasswordFields, passwordFieldsRevealed, readPage } from "./read-page.ts";
import { siteOf } from "./site.ts";

declare const browser: Pick<BrowserApi, "runtime">;

// Set once per document on the content scripts' own global, which the page cannot see.
const STARTED = "foxhandPageScript";

// The background injects this on every request; only the first run in a document sets up.
if (!Object.hasOwn(globalThis, STARTED)) {
  // Not crypto.randomUUID, which plain http pages lack (secure contexts only).
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const docId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  // An element the page moved into another document, such as a frame's, is not this one's.
  const refs = createElementRefs<Element>(
    docId,
    (element) => element.isConnected && element.ownerDocument === document,
  );
  const passwordFields = new WeakSet<Element>();
  const pointer: actions.PointerState = { over: undefined };
  const handlers: PageHandlers = {
    read_page: (params) => readPage(params, { refs, passwordFields }),
    get_page_text: (params) => {
      const options = pageTextOptions(params);
      if (typeof options === "string") throw new PageError("invalid_params", options);
      return readPageText(document, options.maxChars);
    },
    element_rect: (params) => elementRect(params, { refs }),
    password_fields: () => passwordFieldsRevealed({ passwordFields }),
    upload_file: (params) => uploadFile(params, { refs }),
    click: (params) => actions.click(parsed(clickOptions(params)), { refs, pointer }),
    hover: (params) => actions.hover(parsed(hoverOptions(params)), { refs, pointer }),
    scroll: (params) => actions.scroll(parsed(scrollOptions(params)), { refs, pointer }),
    drag: (params) => actions.drag(parsed(dragOptions(params)), { refs, pointer }),
    type: (params) => input.typeText(parsed(typeOptions(params)), { refs }),
    press_key: (params) => input.pressKey(parsed(pressKeyOptions(params)), { refs }),
    fill_form: (params) =>
      fillForm(parsed(fillFormOptions(params)), {
        refs,
        notePasswordFields: () => notePasswordFields({ passwordFields }),
      }),
    read_console: () => readConsoleRecords(window),
    wait_for: (params) => conditionMet(params),
  };
  browser.runtime.onMessage.addListener((message) =>
    handlePageMessage(message, {
      site: siteOf(location.href),
      handlers,
      before: () => notePasswordFields({ passwordFields }),
    }),
  );
  // Last, so a throw above leaves the next injection free to try again.
  Object.defineProperty(globalThis, STARTED, { value: true });
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
