import type { BrowserApi } from "./browser-api.ts";
import { createElementRefs } from "./element-refs.ts";
import { handlePageMessage, PageError, type PageHandlers } from "./page-messages.ts";
import { pageTextOptions } from "./page-text.ts";
import { readPageText } from "./page-text-dom.ts";
import { readPage } from "./read-page.ts";
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
  const handlers: PageHandlers = {
    read_page: (params) => readPage(params, { refs, passwordFields }),
    get_page_text: (params) => {
      const options = pageTextOptions(params);
      if (typeof options === "string") throw new PageError("invalid_params", options);
      return readPageText(document, options.maxChars);
    },
  };
  browser.runtime.onMessage.addListener((message) =>
    handlePageMessage(message, { site: siteOf(location.href), handlers }),
  );
  // Last, so a throw above leaves the next injection free to try again.
  Object.defineProperty(globalThis, STARTED, { value: true });
}
