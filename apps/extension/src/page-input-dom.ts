import type { KeyAction, Result } from "@foxhand/protocol";
import { type ElementRefs, refError } from "./element-refs.ts";
import { flatParentOf } from "./flat-tree.ts";
import { crossSiteDestination, formDestination, leavesSiteText } from "./page-actions.ts";
import { crossSiteOf, tookFocus, viewOf } from "./page-actions-dom.ts";
import {
  blocksImplicitSubmission,
  expectedValue,
  frameOnSite,
  implicitSubmission,
  isClickInput,
  isTypeableInput,
  keyDefault,
  lengthLimit,
  lineFeeds,
  nextInTabOrder,
  nextOption,
  type PressKeyOptions,
  parseKey,
  sendsKeyPress,
  singleLine,
  submitsImplicitly,
  type TypeOptions,
} from "./page-input.ts";
import { PageError } from "./page-messages.ts";
import { childrenOf, focusedElement, isEditingHost } from "./read-page.ts";

export interface InputPage {
  refs: ElementRefs<Element>;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Where type puts the text: a field, or an editable element and the editing host around it. */
type TypeTarget =
  | { field: Field; editable?: never; host?: never; readable: true }
  | { editable: HTMLElement; host: HTMLElement; readable: boolean; field?: never };

interface TabEntry {
  element: HTMLElement | SVGElement;
  tabIndex: number;
}

// About how long a page's framework takes to re-render or undo an insertion.
const SETTLE_MS = 100;
// No fallback starts after this, so nothing is inserted after the page reply could time out.
const FALLBACK_BEFORE_MS = 5_000;
const EDITABLE = '[contenteditable]:not([contenteditable="false"])';
const DOCS_INPUT_FRAME = ".docs-texteventtarget-iframe";

/**
 * type in the page: focuses the element, inserts the text after what it holds with
 * execCommand insertText, reads it back, and falls back once to the native value setter or to
 * beforeinput plus DOM insertion when nothing changed.
 */
export async function typeText(options: TypeOptions, page: InputPage): Promise<Result<"type">> {
  const started = performance.now();
  const { ref, text } = options;
  const lookup = page.refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const target = typeTarget(lookup.element, ref);
  focusTarget(target, ref);
  const caretKnown = caretAtEnd(target);
  const before = contentOf(target);
  // execCommand inserts at the caret, which is unknown in a field without a selection.
  const execFirst = target.field === undefined || caretKnown || before === "";
  // The page's focus listeners may have run past the bound.
  if (late(started)) throw noEffect(ref);
  if (execFirst) {
    const inserted = await execInsert(target, text, before);
    if (inserted === "sent") return { outcome: "sent_unconfirmed", method: "exec_command" };
    if (inserted === "changed") return { outcome: "typed", method: "exec_command" };
    // The page took the text, as an editor's self-clearing input does, or refused it: a fallback
    // could give it the text twice.
    if (inserted === "received") throw takenOrRefused(ref);
  }
  if (late(started)) throw noEffect(ref);
  if (target.field !== undefined) {
    setFieldText(target.field, text, ref);
    await wait(SETTLE_MS);
    if (contentOf(target) !== before) return { outcome: "typed", method: "native_setter" };
    throw noEffect(ref);
  }
  // The page may have replaced the editable's content, and the caret with it.
  caretAtEnd(target);
  if (sendBeforeInput(target.host, text)) {
    // The page's beforeinput listener may have run past the bound.
    if (late(started)) throw noEffect(ref);
    insertAtCaret(target.editable, target.host, text);
  }
  if (!target.readable) return { outcome: "sent_unconfirmed", method: "beforeinput_dom" };
  await wait(SETTLE_MS);
  if (contentOf(target) !== before) return { outcome: "typed", method: "beforeinput_dom" };
  throw noEffect(ref);
}

/** The field or editable area type puts the text in, or the refusal. */
function typeTarget(element: Element, ref: string): TypeTarget {
  const view = viewOf(element);
  if (
    (element instanceof view.HTMLInputElement && isTypeableInput(element.type)) ||
    element instanceof view.HTMLTextAreaElement
  ) {
    if (element.matches(":disabled") || element.readOnly) {
      throw new PageError(
        "not_editable",
        `Element ${ref} is a disabled or read-only field, so type cannot change it.`,
      );
    }
    if (element.matches(":autofill")) {
      throw new PageError(
        "not_editable",
        `Firefox filled in element ${ref} from the user's saved logins, addresses or cards, so type cannot change it until the user edits it.`,
      );
    }
    return { field: element, readable: true };
  }
  if (element instanceof view.HTMLElement && element.isContentEditable) {
    return { editable: element, host: editingHostOf(element), readable: true };
  }
  if (element instanceof view.HTMLIFrameElement || element instanceof view.HTMLFrameElement) {
    const editable = frameEditable(element);
    if (editable !== undefined) {
      return {
        editable,
        host: editingHostOf(editable),
        readable: !element.matches(DOCS_INPUT_FRAME),
      };
    }
  }
  throw notEditable(ref);
}

/**
 * The nearest editing host around an editable element: it and its ancestors while their parent
 * is editable too, never above `body`, which takes the focus of a designMode document.
 */
function editingHostOf(element: HTMLElement): HTMLElement {
  let host = element;
  const body = element.ownerDocument.body;
  while (host !== body) {
    const parent = host.parentElement;
    if (!(parent instanceof viewOf(host).HTMLElement) || !parent.isContentEditable) break;
    host = parent;
  }
  return host;
}

/**
 * The editable element of a frame whose document is on the page's site, as an editor's input
 * frame is: its body when editable, else its first editable element.
 */
function frameEditable(frame: HTMLIFrameElement | HTMLFrameElement): HTMLElement | undefined {
  const frameDocument = frame.contentDocument;
  const frameView = frameDocument?.defaultView ?? null;
  if (frameDocument === null || frameView === null) return undefined;
  if (!frameOnSite(frameView.origin, location.href)) return undefined;
  const body = frameDocument.body;
  const candidates = [body, ...frameDocument.querySelectorAll(EDITABLE)];
  return candidates.find(
    (element): element is HTMLElement =>
      element instanceof frameView.HTMLElement && element.isContentEditable,
  );
}

function notEditable(ref: string): PageError {
  return new PageError(
    "not_editable",
    `type needs a text field or an editable area, and element ${ref} is neither.`,
  );
}

/**
 * Focuses the field or the editing host. Checked against the active element of the element's
 * own root: a document's is a shadow host when focus is inside its shadow tree.
 */
function focusTarget(target: TypeTarget, ref: string): void {
  const element = target.field ?? target.host;
  element.focus();
  const view = viewOf(element);
  const root = element.getRootNode();
  const active =
    root instanceof view.Document || root instanceof view.ShadowRoot ? root.activeElement : null;
  if (active !== element) {
    throw new PageError(
      "not_editable",
      `Foxhand could not focus element ${ref}, so type cannot type into it.`,
    );
  }
}

/** Puts the caret at the end, and whether it could: some inputs, such as email, have none. */
function caretAtEnd(target: TypeTarget): boolean {
  const { field } = target;
  if (field !== undefined) {
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
      return true;
    } catch {
      return false;
    }
  }
  const editable = target.editable;
  const selection = viewOf(editable).getSelection();
  if (selection === null) return false;
  const range = editable.ownerDocument.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * What the read-back compares: the field's value, or the editing host's number of elements and
 * its text, since a typed line break can add a `<br>` and no text.
 */
function contentOf(target: TypeTarget): string {
  if (target.field !== undefined) return target.field.value;
  const { host } = target;
  return `${host.getElementsByTagName("*").length}:${host.textContent ?? ""}`;
}

/**
 * execCommand insertText in the target's document, and what came of it: sent to an editor that
 * cannot be read back, a changed content, an `input` event from the browser that left the
 * content as it was, or nothing at all.
 */
async function execInsert(
  target: TypeTarget,
  text: string,
  before: string,
): Promise<"sent" | "changed" | "received" | "nothing"> {
  const doc = (target.field ?? target.host).ownerDocument;
  let received = false;
  const onInput = (event: Event): void => {
    if (event.isTrusted) received = true;
  };
  doc.addEventListener("input", onInput, true);
  try {
    const sent = execCommand(doc, text);
    if (!target.readable) return sent ? "sent" : "nothing";
    await wait(SETTLE_MS);
    if (contentOf(target) !== before) return "changed";
    return received ? "received" : "nothing";
  } finally {
    doc.removeEventListener("input", onInput, true);
  }
}

/** execCommand insertText, and whether Firefox says it ran. */
function execCommand(doc: Document, text: string): boolean {
  try {
    return doc.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function takenOrRefused(ref: string): PageError {
  return new PageError(
    "no_effect",
    `The text did not appear in element ${ref}; the page received it as typed input and took it or refused it, so read the page before typing it again.`,
  );
}

function late(started: number): boolean {
  return performance.now() - started > FALLBACK_BEFORE_MS;
}

function noEffect(ref: string): PageError {
  return new PageError(
    "no_effect",
    `The text did not appear in element ${ref}; the page may accept only real typing.`,
  );
}

/**
 * The field's value with the text added, through the native setter of the field's own window
 * as a framework's own edit is, then an input event. Nothing is changed when the field is full
 * or would not keep that value, such as a number input given letters.
 */
function setFieldText(field: Field, text: string, ref: string): void {
  const view = viewOf(field);
  const before = field.value;
  const added = field instanceof view.HTMLInputElement ? singleLine(text) : lineFeeds(text);
  const expected = expectedValue(before, added, lengthLimit(field.type, field.maxLength));
  if (expected === before) throw noEffect(ref);
  setValue(field, expected);
  // Sanitization runs inside the setter; the page's own reformatting only after the event.
  if (field.value !== expected) {
    setValue(field, before);
    throw noEffect(ref);
  }
  field.dispatchEvent(
    new view.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: expected.slice(before.length),
    }),
  );
}

/** Sets the value with the prototype setter of the field's own window, past any own `value`. */
function setValue(field: Field, value: string): void {
  const view = viewOf(field);
  const proto =
    field instanceof view.HTMLTextAreaElement
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter === undefined) throw new TypeError("no value setter");
  setter.call(field, value);
}

/** A cancelable beforeinput on the editing host, and whether the editor left the insertion to us. */
function sendBeforeInput(host: HTMLElement, text: string): boolean {
  return host.dispatchEvent(
    new (viewOf(host).InputEvent)("beforeinput", { ...insertTextInit(text), cancelable: true }),
  );
}

function insertTextInit(text: string): InputEventInit {
  return { bubbles: true, composed: true, inputType: "insertText", data: text };
}

/**
 * The text at the caret, or at the end when the caret left the editable, then an input event on
 * the editing host.
 */
function insertAtCaret(editable: HTMLElement, host: HTMLElement, text: string): void {
  const view = viewOf(host);
  const node = editable.ownerDocument.createTextNode(text);
  const selection = view.getSelection();
  const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (selection !== null && range !== null && editable.contains(range.commonAncestorContainer)) {
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    editable.append(node);
  }
  host.dispatchEvent(new view.InputEvent("input", insertTextInit(text)));
}

/**
 * press_key in the page: keydown, keypress for Enter and characters, the key's default action
 * unless the page cancelled one of them, then keyup. Enter that would open a page on another
 * site is refused after keyup.
 */
export function pressKey(options: PressKeyOptions, page: InputPage): Result<"press_key"> {
  const key = parseKey(options.key);
  if (typeof key === "string") throw new PageError("invalid_params", key);
  const { element: target, focused } = keyTarget(options.ref, page.refs);
  const view = viewOf(target);
  const init: KeyboardEventInit = {
    key: key.key,
    code: key.code,
    shiftKey: key.shift,
    ctrlKey: key.control,
    altKey: key.alt,
    metaKey: key.meta,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const down = target.dispatchEvent(new view.KeyboardEvent("keydown", init));
  // UI Events: a cancelled keydown sends no keypress.
  const pressed =
    down && sendsKeyPress(key)
      ? target.dispatchEvent(new view.KeyboardEvent("keypress", init))
      : down;
  let action: KeyAction = "none";
  if (pressed) {
    try {
      action = defaultAction(keyDefault(key), target, focused, page.refs);
    } catch (error) {
      target.dispatchEvent(new view.KeyboardEvent("keyup", init));
      throw error;
    }
  }
  // A real key is released where focus went.
  const released = action === "focus_moved" ? (focusedElement() ?? target) : target;
  released.dispatchEvent(new (viewOf(released).KeyboardEvent)("keyup", init));
  return { action, prevented: !pressed };
}

/**
 * The element the key goes to: the ref'd one, focused first, else the focused element followed
 * into shadow roots; a focused frame is its frame element, since press_key stays in the top page.
 * Also whether it has focus, which a ref'd element a keyboard cannot reach does not take.
 */
function keyTarget(
  ref: string | undefined,
  refs: ElementRefs<Element>,
): { element: Element; focused: boolean } {
  if (ref === undefined) {
    const element = focusedElement() ?? document.body ?? document.documentElement;
    return { element, focused: true };
  }
  const lookup = refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const element = lookup.element;
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus();
  return { element, focused: focusedElement() === element };
}

function defaultAction(
  which: ReturnType<typeof keyDefault>,
  target: Element,
  focused: boolean,
  refs: ElementRefs<Element>,
): KeyAction {
  switch (which) {
    case "enter":
      // A disabled field, or one a modal dialog blocks, takes no key from a real keyboard.
      return focused && !target.matches(":disabled") ? enter(target, refs) : "none";
    case "tab":
      return tab(false);
    case "shift_tab":
      return tab(true);
    case "escape":
      return closeTopmost();
    case "arrow_down":
      return focused ? chooseOption(target, false) : "none";
    case "arrow_up":
      return focused ? chooseOption(target, true) : "none";
    case undefined:
      return "none";
  }
}

/** Enter: implicit submission from a field of a form, else a click on a button, link or summary. */
function enter(target: Element, refs: ElementRefs<Element>): KeyAction {
  if (target instanceof HTMLInputElement && submitsImplicitly(target.type)) {
    const form = target.form;
    if (form !== null) return submitImplicitly(form, target, refs);
  }
  if (!isClickTarget(target)) return "none";
  refuseCrossSite(crossSiteOf(target), target, refs);
  target.click();
  return "clicked";
}

/**
 * HTML's implicit submission, refused when it would open a page on another site. Submitted only
 * when constraint validation lets the form through; when it does not, the page still shows its
 * validation as for a real Enter.
 */
function submitImplicitly(
  form: HTMLFormElement,
  target: Element,
  refs: ElementRefs<Element>,
): KeyAction {
  const button = defaultButtonOf(form);
  const state =
    button === undefined ? "none" : button.matches(":disabled") ? "disabled" : "enabled";
  const how = implicitSubmission(state, blockingFieldsOf(form));
  if (how === "none") return "none";
  refuseCrossSite(
    how === "with_button" && button !== undefined ? crossSiteOf(button) : formCrossSite(form),
    target,
    refs,
  );
  const valid = passesValidation(form, how === "with_button" ? button : undefined);
  if (how === "with_button" && button !== undefined) {
    // HTML and Firefox click the default button, so the page's click listeners run as for a
    // real Enter.
    button.click();
  } else {
    HTMLFormElement.prototype.requestSubmit.call(form);
  }
  return valid ? "submitted" : "none";
}

/** The form's first submit button in tree order: `elements` leaves out image buttons. */
function defaultButtonOf(form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | undefined {
  const root = Node.prototype.getRootNode.call(form);
  for (const element of queryAll(root, "button, input")) {
    if (element instanceof HTMLButtonElement) {
      if (element.form === form && element.type === "submit") return element;
    } else if (element instanceof HTMLInputElement && element.form === form) {
      if (element.type === "submit" || element.type === "image") return element;
    }
  }
  return undefined;
}

/** querySelectorAll through the prototype: a document's named elements can shadow its own. */
function queryAll(root: Node, selectors: string): Element[] {
  if (root instanceof Document) {
    return [...Document.prototype.querySelectorAll.call(root, selectors)];
  }
  if (root instanceof DocumentFragment) {
    return [...DocumentFragment.prototype.querySelectorAll.call(root, selectors)];
  }
  return [];
}

function blockingFieldsOf(form: HTMLFormElement): number {
  return formElements(form).filter(
    (element) => element instanceof HTMLInputElement && blocksImplicitSubmission(element.type),
  ).length;
}

/** The form's listed controls, through the prototype: a control named elements shadows them. */
function formElements(form: HTMLFormElement): Element[] {
  const elements: unknown = Object.getOwnPropertyDescriptor(
    HTMLFormElement.prototype,
    "elements",
  )?.get?.call(form);
  return elements instanceof HTMLFormControlsCollection ? [...elements] : [];
}

/** Where the form goes without a submitter, when that is another site. */
function formCrossSite(form: HTMLFormElement): string | undefined {
  const action = Element.prototype.getAttributeNS.call(form, null, "action");
  const base: unknown = Object.getOwnPropertyDescriptor(Node.prototype, "baseURI")?.get?.call(form);
  return crossSiteDestination(
    formDestination(null, action, location.href),
    typeof base === "string" ? base : "",
    location.href,
  );
}

function refuseCrossSite(
  site: string | undefined,
  target: Element,
  refs: ElementRefs<Element>,
): void {
  if (site === undefined) return;
  throw new PageError(
    "cross_site_navigation",
    `Enter on element ${refs.refFor(target)} ${leavesSiteText(site, "with press_key")}`,
  );
}

/**
 * Whether constraint validation lets the form be submitted, read without firing `invalid` as
 * checkValidity would.
 */
function passesValidation(
  form: HTMLFormElement,
  submitter: HTMLButtonElement | HTMLInputElement | undefined,
): boolean {
  const noValidate: unknown = Object.getOwnPropertyDescriptor(
    HTMLFormElement.prototype,
    "noValidate",
  )?.get?.call(form);
  if (noValidate === true || submitter?.formNoValidate === true) return true;
  return formElements(form).every(
    (element) =>
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLButtonElement
      ) ||
      !element.willValidate ||
      element.validity.valid,
  );
}

function isClickTarget(target: Element): target is HTMLElement {
  if (target instanceof HTMLButtonElement) return true;
  if (target instanceof HTMLInputElement) return isClickInput(target.type);
  if (target instanceof HTMLAnchorElement || target instanceof HTMLAreaElement) {
    return target.getAttributeNS(null, "href") !== null;
  }
  return target instanceof HTMLElement && target.localName === "summary";
}

/**
 * Tab: focus the next element in sequential focus order, stepping on past one that does not take
 * focus, such as one a modal dialog blocks. Focus on body or the root element starts nowhere.
 */
function tab(backwards: boolean): KeyAction {
  const before = focusedElement();
  const start = before === document.body || before === document.documentElement ? null : before;
  const entries = tabEntries(start);
  let current = start === null ? -1 : entries.findIndex((entry) => entry.element === start);
  for (let tries = 0; tries < entries.length; tries += 1) {
    const next = nextInTabOrder(entries, current, backwards);
    const candidate = next === undefined ? undefined : entries[next];
    if (next === undefined || candidate === undefined) return "none";
    candidate.element.focus({ focusVisible: true });
    if (tookFocus(candidate.element, before)) return "focus_moved";
    current = next;
  }
  return "none";
}

/**
 * The elements sequential focus navigation may reach, in flat-tree order, and the navigation's
 * starting point at its place with tabIndex -1 when it is not one of them.
 */
function tabEntries(start: Element | null): TabEntry[] {
  const entries: TabEntry[] = [];
  for (const element of flatTreeElements()) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
    const tabIndex = candidateTabIndex(element);
    if (tabIndex !== undefined) entries.push({ element, tabIndex });
    else if (element === start) entries.push({ element, tabIndex: -1 });
  }
  return withoutUnselectedRadios(entries, start);
}

/** The document's elements in flat-tree order: shadow trees, slotted nodes where their slot is. */
function* flatTreeElements(): Generator<Element> {
  const stack: Node[] = [document.documentElement];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (!(node instanceof Element)) continue;
    yield node;
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
}

/**
 * The element's tab index when it is in sequential focus order, else undefined: rendered, not
 * inert, not disabled, a tab index of 0 or more (an editing host without a tabindex counts as
 * 0, and a link without href is left out unless it has a tabindex).
 */
function candidateTabIndex(element: HTMLElement | SVGElement): number | undefined {
  const tabindex = element.hasAttributeNS(null, "tabindex");
  if (
    (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) &&
    !tabindex &&
    element.getAttributeNS(null, "href") === null
  ) {
    return undefined;
  }
  const tabIndex = !tabindex && isEditingHost(element) ? 0 : element.tabIndex;
  if (tabIndex < 0) return undefined;
  if (element.matches(":disabled") || isInert(element) || !isRendered(element)) return undefined;
  return tabIndex;
}

/** Inert itself or inside an inert element, shadow hosts included. */
function isInert(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = flatParentOf(current)) {
    if (current instanceof HTMLElement && current.inert) return true;
  }
  return false;
}

function isRendered(element: Element): boolean {
  return (
    element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0
  );
}

/**
 * Of each radio group (one non-empty name, form owner and root), only its checked button, or its
 * first when none is checked; the focused element stays as the starting point.
 */
function withoutUnselectedRadios(entries: TabEntry[], start: Element | null): TabEntry[] {
  const radios = entries.flatMap(({ element }) =>
    element instanceof HTMLInputElement && element.type === "radio" && element.name !== ""
      ? [element]
      : [],
  );
  return entries.flatMap((entry) => {
    const { element } = entry;
    if (!(element instanceof HTMLInputElement) || !radios.includes(element)) return [entry];
    const group = radios.filter((other) => sameGroup(other, element));
    const chosen = group.find((radio) => radio.checked) ?? group[0];
    if (chosen === element) return [entry];
    return element === start ? [{ element, tabIndex: -1 }] : [];
  });
}

function sameGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  return a.name === b.name && a.form === b.form && a.getRootNode() === b.getRootNode();
}

/** Escape: hide the last open auto popover, else close the last modal dialog. */
function closeTopmost(): KeyAction {
  const elements = [...flatTreeElements()];
  const popover = elements.findLast(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      element.popover === "auto" &&
      element.matches(":popover-open"),
  );
  if (popover !== undefined) {
    popover.hidePopover();
    return popover.matches(":popover-open") ? "none" : "hid_popover";
  }
  const dialog = elements.findLast(
    (element): element is HTMLDialogElement =>
      element instanceof HTMLDialogElement && element.matches(":modal"),
  );
  // closedby="none": the page lets no close request close it, Escape included.
  if (dialog === undefined || dialog.closedBy === "none") return "none";
  if (typeof dialog.requestClose === "function") {
    dialog.requestClose();
  } else if (dialog.dispatchEvent(new (viewOf(dialog).Event)("cancel", { cancelable: true }))) {
    dialog.close();
  }
  return dialog.open ? "none" : "closed_dialog";
}

/** ArrowDown or ArrowUp on a single-choice select: the next or previous enabled option. */
function chooseOption(target: Element, backwards: boolean): KeyAction {
  if (!(target instanceof HTMLSelectElement) || target.multiple || target.matches(":disabled")) {
    return "none";
  }
  const disabled = Array.from(target.options, (option) => option.matches(":disabled"));
  const next = nextOption(disabled, target.selectedIndex, backwards);
  if (next === undefined) return "none";
  target.selectedIndex = next;
  const view = viewOf(target);
  target.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  target.dispatchEvent(new view.Event("change", { bubbles: true }));
  return "selected_option";
}
