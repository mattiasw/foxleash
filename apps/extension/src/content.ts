import type { BrowserApi } from "./browser-api.ts";
import { readConsoleRecords } from "./console-messages.ts";
import { elementRect } from "./element-rect.ts";
import { createElementRefs, type ElementRefs } from "./element-refs.ts";
import { shadowRootOf } from "./flat-tree.ts";
import {
  clickOptions,
  dragOptions,
  hoverOptions,
  scrollOptions,
  submissionMethod,
} from "./page-actions.ts";
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
  documentElements,
  focusedElement,
  isProtected,
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
    upload_file: act(
      watched,
      (params) =>
        uploadFile(params, {
          refs,
          passwordFields,
          pointer,
          click: (ref) =>
            withoutProtectedGetSubmit(memory, () =>
              actions.click({ ref, button: "left", doubleClick: false }, { refs, pointer }),
            ),
        }),
      byRef,
    ),
    click: act(
      watched,
      (params) =>
        withoutProtectedGetSubmit(memory, () =>
          actions.click(parsed(clickOptions(params)), { refs, pointer }),
        ),
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
      (params) =>
        withoutProtectedGetSubmit(memory, () =>
          input.pressKey(parsed(pressKeyOptions(params)), { refs }),
        ),
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
 * The act's handler, with a watch of the page started right before it runs, the focus moves made
 * during it told to a page without focus when it ends, and its result with the watch's id and the
 * element that took the act: `target`'s, described before the act can remove it, or, with
 * `fromResult` when the act had no target up front, the element of the result's ref. The act's
 * own result never has fields of these names.
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
    const finish = actions.watchFocusMoves();
    let result: unknown;
    try {
      result = await handler(params);
    } finally {
      finish();
    }
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

/**
 * `run`, refused when it sets off a submission that the page does not cancel, that is sent with
 * GET and that would send a protected field's value, which GET puts in the page's address. The
 * submission is then cancelled. `run` must be synchronous: the listeners go when it returns.
 */
function withoutProtectedGetSubmit<T>(memory: PageMemory, run: () => T): T {
  // A submit event is not composed: a form in a shadow root sends one that never reaches window.
  const shadows: ShadowRoot[] = [];
  for (const element of documentElements()) {
    const shadow = shadowRootOf(element);
    if (shadow !== null) shadows.push(shadow);
  }
  let stopped: { field?: Element } | undefined;
  // Each event is decided once, by the listener on the last node of its path: added during the
  // act, it runs after every listener the page had there when the act started.
  const watch =
    (root: ShadowRoot | undefined) =>
    (event: Event): void => {
      try {
        if (event.defaultPrevented) return;
        if (root !== undefined && event.composedPath().at(-1) !== root) return;
        const field = protectedFieldSent(event, memory);
        if (field === undefined) return;
        event.preventDefault();
        stopped ??= { field };
      } catch {
        event.preventDefault();
        stopped ??= {};
      }
    };
  const onWindow = watch(undefined);
  const onShadows = shadows.map((shadow) => ({ shadow, listener: watch(shadow) }));
  let result: T;
  try {
    window.addEventListener("submit", onWindow);
    for (const { shadow, listener } of onShadows) shadow.addEventListener("submit", listener);
    result = run();
  } finally {
    window.removeEventListener("submit", onWindow);
    for (const { shadow, listener } of onShadows) shadow.removeEventListener("submit", listener);
  }
  if (stopped === undefined) return result;
  throw new PageError(
    "protected_get_form",
    stopped.field === undefined
      ? "Foxleash could not check whether the form would put the value of a protected field in the page's address, so it cancelled its submission: ask the user to send this form."
      : `The form would put the value of protected field ${memory.refs.refFor(stopped.field)} in the page's address, as it is sent with GET, so Foxleash cancelled its submission: ask the user to send this form.`,
  );
}

/** The first protected field whose value the submit event's form would send with GET, if any. */
function protectedFieldSent(event: Event, memory: PageMemory): Element | undefined {
  if (!(event instanceof SubmitEvent)) return undefined;
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return undefined;
  const submitter = event.submitter;
  const method = submissionMethod(
    submitter === null
      ? null
      : Element.prototype.getAttributeNS.call(submitter, null, "formmethod"),
    Element.prototype.getAttributeNS.call(form, null, "method"),
  );
  return method === "get" ? protectedFieldOf(form, memory) : undefined;
}

/**
 * The form's first listed field that it sends with a protected value. A form-associated custom
 * element sends what its script passes on, so a protected field with a value inside it, in its
 * shadow tree or among its descendants, counts, named or not.
 */
function protectedFieldOf(form: HTMLFormElement, memory: PageMemory): Element | undefined {
  for (const element of input.formElements(form)) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const name = Element.prototype.getAttributeNS.call(element, null, "name");
      if (
        isProtected(element, memory) &&
        !element.matches(":disabled") &&
        name !== null &&
        name !== "" &&
        element.value !== ""
      ) {
        return element;
      }
      continue;
    }
    // Of the listed elements, only a form-associated custom element has a hyphen in its name.
    if (!element.localName.includes("-") || element.matches(":disabled")) continue;
    const shadow = shadowRootOf(element);
    for (const root of shadow === null ? [element] : [shadow, element]) {
      for (const inner of documentElements(root)) {
        if (
          (inner instanceof HTMLInputElement || inner instanceof HTMLTextAreaElement) &&
          isProtected(inner, memory) &&
          inner.value !== ""
        ) {
          return inner;
        }
      }
    }
  }
  return undefined;
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
