import type { FoundLines } from "@foxleash/protocol";
import { type ElementRefs, refError } from "./element-refs.ts";
import {
  detailsSummaryOf,
  flatParentOf,
  inDetailsContent,
  isClosedDetails,
  shadowRootOf,
} from "./flat-tree.ts";
import { PageError } from "./page-messages.ts";
import {
  createLineFinder,
  createTextBuffer,
  createTreeLines,
  explicitRole,
  INTERACTIVE_ROLES,
  isProtectedField,
  LANDMARK_ROLES,
  type Line,
  type LineStates,
  linkAddress,
  NAME_FROM_CONTENT_ROLES,
  type ReadPageOptions,
  readPageOptions,
  type TreeLines,
  textLine,
} from "./page-tree.ts";

/** What the content script keeps per document for its page requests. */
export interface PageMemory {
  refs: ElementRefs<Element>;
  /** Every input that had type password at the start of any page request, which stays protected. */
  passwordFields: WeakSet<Element>;
}

export interface Walker {
  /** Called for each element; true walks its flat-tree children and calls `leave` after. */
  enter(element: Element): boolean;
  leave(element: Element): void;
  /** Text directly inside the innermost element the walk is in, or the root: a slot for slotted text. */
  text(value: string): void;
  done(): boolean;
}

type Step = { node: Node } | { leave: Element };

/** One element the tree walk is inside of. */
interface Scope {
  element: Element;
  /** The level of this element's line; undefined while it has none. */
  lineLevel: number | undefined;
  /** The level of the next line inside this element. */
  childLevel: number;
  /** The nearest scope, this one included, that has a line. */
  owner: Scope | undefined;
  /** A landmark whose line waits for an interactive element inside it (filter interactive). */
  pending: { role: string; name: string } | undefined;
  /** Text inside is already this element's name, or inside one whose name it is. */
  quiet: boolean;
  /** Text directly inside has a box: not under content-visibility hidden. */
  boxed: boolean;
  textVisible: boolean;
  block: boolean;
  /** For a details: the state of what its content box holds. */
  content: TextState | undefined;
}

/** Text here has a box, and the user sees it. */
export interface TextState {
  boxed: boolean;
  visible: boolean;
}

type Presence = "skip" | "noLine" | "shown";

/** One element the text collection for a name is inside of. */
interface TextScope {
  element: Element;
  block: boolean;
  /** Text directly inside has a box: not under content-visibility hidden. */
  boxed: boolean;
  /** Text directly inside counts. */
  shown: boolean;
  /** For a details: the state of what its content box holds. */
  content: TextState | undefined;
}

// Their child nodes are default values or fallback content, which the user does not see.
const CHILDLESS: ReadonlySet<string> = new Set([
  "input",
  "textarea",
  "img",
  "video",
  "audio",
  "iframe",
  "frame",
  "progress",
  "meter",
  "script",
  "style",
  "template",
  "noscript",
]);
export const UNREAD: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);
const HEADING = /^h([1-6])$/;
const WHOLE_NUMBER = /^[0-9]+$/;
const VALUE_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);
const BUTTON_INPUTS: ReadonlySet<string> = new Set(["submit", "reset", "button"]);
const SECTIONING = "article, aside, main, nav, section";

/** read_page in the page: the tree of the document, or of the element `ref` names. */
export function readPage(
  params: Record<string, unknown>,
  page: PageMemory,
): { tree: string; truncated: boolean; found?: FoundLines } {
  const options = readPageOptions(params);
  if (typeof options === "string") throw new PageError("invalid_params", options);
  const tree =
    options.find === undefined ? createTreeLines() : createLineFinder(options.find, options.role);
  if (options.ref === undefined) {
    const start = document.body ?? document.documentElement;
    if (start !== null) {
      walkTree(start, undefined, { options, page, tree, focused: focusedElement() });
    }
    return tree.result();
  }
  const lookup = page.refs.resolve(options.ref);
  if ("error" in lookup) throw refError(options.ref, lookup.error);
  const element = lookup.element;
  if (isFrame(element)) {
    tree.add(frameLine(element, 0, page));
    return tree.result();
  }
  const role = roleOf(element, page) ?? "generic";
  const rootState = rootTextState(element, getComputedStyle(element));
  const { name } = nameOf(element, role, page, rootState);
  const focused = focusedElement();
  tree.add({
    level: 0,
    role,
    name,
    ref: page.refs.refFor(element),
    states: statesOf(element, role, focused, page, rootState),
  });
  // Nothing below a root without a box is shown, but an option in a select would get a line.
  if (!withinHidden(element) && rootState.boxed) {
    walkTree(element, role, { options, page, tree, focused });
  }
  return tree.result();
}

/**
 * Whether the page turned a remembered password field into another kind, so a screenshot must
 * hide the text of every input.
 */
export function passwordFieldsRevealed(page: Pick<PageMemory, "passwordFields">): {
  revealed: boolean;
} {
  for (const element of documentElements()) {
    if (
      element instanceof HTMLInputElement &&
      page.passwordFields.has(element) &&
      element.type !== "password"
    ) {
      return { revealed: true };
    }
  }
  return { revealed: false };
}

interface TreeContext {
  options: ReadPageOptions;
  page: PageMemory;
  tree: TreeLines;
  focused: Element | null;
}

/**
 * Adds the lines of what `root` contains to the tree. `rootRole` is the role of the root's own
 * line at level 0, or undefined when the root has no line.
 */
function walkTree(root: Element, rootRole: string | undefined, context: TreeContext): void {
  const { options, page, tree, focused } = context;
  const all = options.filter === "all";
  // A root given by ref may be hidden by its own style or its flat-tree ancestors.
  const rootState = rootTextState(root, getComputedStyle(root));
  const rootScope: Scope = {
    element: root,
    lineLevel: rootRole === undefined ? undefined : 0,
    childLevel: rootRole === undefined ? 0 : 1,
    owner: undefined,
    pending: undefined,
    quiet: rootRole !== undefined && nameOf(root, rootRole, page, rootState).fromContent,
    boxed: rootState.boxed,
    textVisible: rootState.visible,
    block: true,
    content: detailsContent(root, rootState),
  };
  if (rootRole !== undefined) rootScope.owner = rootScope;
  const scopes: Scope[] = [rootScope];
  // Where pending landmarks start in `scopes`, outermost first.
  const pending: Scope[] = [];
  let run = createTextBuffer();
  let runScope: Scope | undefined;
  // The scope whose rest was cut by depth; nothing inside it is read any more.
  let cutAt: Scope | undefined;

  walkChildren(
    root,
    {
      enter(element) {
        if (cutAt !== undefined) return false;
        if (skipped(element)) return false;
        if (element.localName === "br") {
          if (all) addText(" ");
          return false;
        }
        const style = getComputedStyle(element);
        if (rendersNothing(element, style)) return false;
        const presence = presenceOf(element, style);
        if (presence === "skip") return false;
        const block = isBlock(style);
        if (isFrame(element)) {
          // Frames are noted, never read: the content script runs in the top frame only.
          if (all && presence === "shown") {
            flushRun();
            if (cutAt !== undefined) return false;
            const { childLevel, owner } = top();
            place(childLevel, owner, () => frameLine(element, childLevel, page));
          }
          return false;
        }
        const role = presence === "shown" ? roleOf(element, page) : undefined;
        const lined = role !== undefined && (all || isInteractive(element, role));
        if (block || lined) flushRun();
        if (cutAt !== undefined) return false;
        const parent = top();
        // What a details' content box holds passes on that box's state through display contents.
        const parentBoxed =
          parent.content !== undefined && inDetailsContent(parent.element, element)
            ? parent.content.boxed
            : parent.boxed;
        const boxed =
          style.contentVisibility !== "hidden" && (style.display !== "contents" || parentBoxed);
        const textVisible = style.visibility === "visible" && boxed;
        const state: TextState = { boxed, visible: textVisible };
        const scope: Scope = {
          element,
          lineLevel: undefined,
          childLevel: parent.childLevel,
          owner: parent.owner,
          pending: undefined,
          quiet: parent.quiet,
          boxed,
          textVisible,
          block,
          content: detailsContent(element, state),
        };
        if (lined) {
          if (!flushPending()) return false;
          const named = nameOf(element, role, page, state);
          const level = top().childLevel;
          const placed = place(level, top().owner, () => ({
            level,
            role,
            name: named.name,
            ref: page.refs.refFor(element),
            states: statesOf(element, role, focused, page, state),
          }));
          if (!placed) return false;
          scope.lineLevel = level;
          scope.childLevel = level + 1;
          scope.owner = scope;
          scope.quiet = scope.quiet || named.fromContent;
        } else if (role !== undefined && LANDMARK_ROLES.has(role)) {
          scope.pending = { role, name: nameOf(element, role, page).name };
          pending.push(scope);
        }
        scopes.push(scope);
        return true;
      },
      leave(element) {
        const scope = top();
        if (scope.block || scope.lineLevel !== undefined) flushRun();
        scopes.pop();
        if (pending.at(-1) === scope) pending.pop();
        if (cutAt?.element === element) cutAt = undefined;
      },
      text(value) {
        const scope = top();
        // Text directly in a details is laid out in its content box (it is never the summary).
        const visible = scope.content?.visible ?? scope.textVisible;
        if (!all || cutAt !== undefined || scope.quiet || !visible) return;
        addText(value);
      },
      done: () => tree.full,
    },
    renderedChildrenOf,
  );
  flushRun();

  function top(): Scope {
    return scopes.at(-1) ?? rootScope;
  }

  function addText(value: string): void {
    if (runScope === undefined) runScope = top();
    run.add(value);
  }

  function flushRun(): void {
    const scope = runScope;
    const text = run.text();
    run = createTextBuffer();
    runScope = undefined;
    if (scope === undefined || cutAt !== undefined) return;
    const line = textLine(scope.childLevel, text);
    if (line !== undefined) place(scope.childLevel, scope.owner, () => line);
  }

  /** Gives the pending landmarks their lines, outermost first; false when depth cut them. */
  function flushPending(): boolean {
    const first = pending[0];
    if (first === undefined) return true;
    const from = scopes.indexOf(first);
    let level = scopes[from - 1]?.childLevel ?? 0;
    let owner = scopes[from - 1]?.owner;
    for (const scope of scopes.slice(from)) {
      const landmark = scope.pending;
      if (landmark !== undefined) {
        const at = level;
        const placed = place(at, owner, () => ({
          level: at,
          role: landmark.role,
          name: landmark.name,
          ref: page.refs.refFor(scope.element),
          states: statesOf(scope.element, landmark.role, focused, page),
        }));
        if (!placed) {
          // Those placed before the cut are pending no more.
          pending.splice(0, pending.indexOf(scope));
          return false;
        }
        scope.pending = undefined;
        scope.lineLevel = at;
      }
      if (scope.lineLevel !== undefined) {
        level = scope.lineLevel + 1;
        owner = scope;
      }
      scope.childLevel = level;
      scope.owner = owner;
    }
    pending.length = 0;
    return true;
  }

  /**
   * Adds a line at `level`, or, below the depth asked for, ends the line of `owner` with the
   * cut mark and skips the rest of what it contains.
   */
  function place(level: number, owner: Scope | undefined, line: () => Line): boolean {
    if (options.depth !== undefined && level >= options.depth) {
      tree.markCut();
      cutAt = owner;
      return false;
    }
    return tree.add(line());
  }
}

/**
 * Walks the flat tree below `root`, each element's children as `children` gives them, without
 * recursion, so deep nesting cannot overflow.
 */
export function walkChildren(
  root: Element,
  walker: Walker,
  children: (element: Element) => ArrayLike<Node> = childrenOf,
): void {
  const steps: Step[] = [];
  pushChildren(steps, root, children);
  while (!walker.done()) {
    const step = steps.pop();
    if (step === undefined) return;
    if ("leave" in step) {
      walker.leave(step.leave);
    } else if (step.node.nodeType === Node.TEXT_NODE) {
      walker.text(step.node.nodeValue ?? "");
    } else if (step.node instanceof Element && walker.enter(step.node)) {
      steps.push({ leave: step.node });
      pushChildren(steps, step.node, children);
    }
  }
}

function pushChildren(
  steps: Step[],
  parent: Element,
  children: (element: Element) => ArrayLike<Node>,
): void {
  const nodes = children(parent);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node !== undefined) steps.push({ node });
  }
}

/**
 * An element's children in the flat tree, as far as the user can see them. A slot assigned to
 * another slot is a step of its own, so its style decides whether what it passes on is shown.
 */
export function childrenOf(element: Element): ArrayLike<Node> {
  if (CHILDLESS.has(element.localName)) return [];
  if (isClosedDetails(element)) {
    const summary = detailsSummaryOf(element);
    return summary === undefined ? [] : [summary];
  }
  const shadow = shadowRootOf(element);
  if (shadow !== null) return shadow.childNodes;
  if (element instanceof HTMLSlotElement) {
    const assigned = element.assignedNodes();
    if (assigned.length > 0) return assigned;
  }
  return element.childNodes;
}

/** read_page's children of an element: those of `childrenOf` that Firefox renders. */
function renderedChildrenOf(element: Element): ArrayLike<Node> {
  // Firefox's drop-down lists the options wherever they sit in the select, and nothing else.
  if (element instanceof HTMLSelectElement) return element.options;
  const nodes = childrenOf(element);
  if (element instanceof SVGElement) {
    return Array.from(nodes).filter((node) => svgRendersChild(element, node));
  }
  return rendersChildren(element) ? nodes : [];
}

/** Whether Firefox renders the children of an element outside SVG. */
function rendersChildren(element: Element): boolean {
  // Firefox lays out canvas fallback, but never shows it.
  if (element instanceof HTMLCanvasElement) return false;
  // An object or embed that shows its data gives its children no box.
  if (element instanceof HTMLObjectElement || element instanceof HTMLEmbedElement) {
    return hasRects(element);
  }
  // Firefox's drop-down shows an option's label instead of its content.
  if (element instanceof HTMLOptionElement) return (element.getAttribute("label") ?? "") === "";
  return !(element instanceof HTMLElement && element.localName === "wbr");
}

function hasRects(holder: Element): boolean {
  const range = holder.ownerDocument.createRange();
  range.selectNodeContents(holder);
  return range.getClientRects().length > 0;
}

/**
 * Whether Firefox renders `node` in an SVG element: SVG elements in a container or text, text
 * only in the text elements, and anything in a foreignObject. Any other SVG element draws no
 * content as text, or draws it in a way the content script cannot tell (`switch`).
 */
function svgRendersChild(holder: SVGElement, node: Node): boolean {
  if (holder instanceof SVGForeignObjectElement) return true;
  const text = holder instanceof SVGTextContentElement;
  if (
    !(
      text ||
      holder instanceof SVGSVGElement ||
      holder instanceof SVGGElement ||
      holder instanceof SVGAElement
    )
  ) {
    return false;
  }
  if (node instanceof Element) return node instanceof SVGElement;
  return (
    node.nodeType === Node.TEXT_NODE &&
    (text ||
      (holder instanceof SVGAElement && holder.parentElement instanceof SVGTextContentElement))
  );
}

/** The focused element, followed into shadow roots. */
export function focusedElement(): Element | null {
  let focused = document.activeElement;
  while (focused !== null) {
    const inner = shadowRootOf(focused)?.activeElement ?? null;
    if (inner === null) return focused;
    focused = inner;
  }
  return null;
}

/**
 * Remembers every password field in the document, in shadow roots and hidden parts too, so it
 * stays protected after the page turns it into text. The content script runs it before every page
 * request.
 */
export function notePasswordFields(page: Pick<PageMemory, "passwordFields">): void {
  for (const element of documentElements()) {
    if (element instanceof HTMLInputElement && element.type === "password") {
      page.passwordFields.add(element);
    }
  }
}

/** Every element of the document and of the shadow roots in it, closed ones included. */
export function* documentElements(): Generator<Element> {
  const roots: ParentNode[] = [document];
  for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
    for (const element of root.querySelectorAll("*")) {
      yield element;
      const shadow = shadowRootOf(element);
      if (shadow !== null) roots.push(shadow);
    }
  }
}

/** True for an element that is hidden with all it contains, whatever its style. */
function skipped(element: Element): boolean {
  if (isAriaHidden(element) || isInert(element)) return true;
  if (element instanceof HTMLInputElement && element.type === "hidden") return true;
  return UNREAD.has(element.localName);
}

function isAriaHidden(element: Element): boolean {
  return element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true";
}

function isInert(element: Element): boolean {
  return element instanceof HTMLElement && element.inert;
}

/** True when the element or an ancestor, shadow hosts included, hides everything inside it. */
function withinHidden(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = parentOf(current)) {
    if (isAriaHidden(current) || isInert(current)) return true;
  }
  return false;
}

/** The parent element, or the host for an element at the top of a shadow root. */
function parentOf(element: Element): Element | null {
  const parent = element.parentNode;
  return parent instanceof ShadowRoot ? parent.host : element.parentElement;
}

/**
 * Whether the element renders nothing, by its own style or attributes, though Firefox may still
 * call it visible.
 */
function rendersNothing(element: Element, style: CSSStyleDeclaration): boolean {
  // A column box never holds content.
  if (style.display === "table-column" || style.display === "table-column-group") return true;
  // In SVG, display contents shows nothing, and Firefox may skip an element for its conditional
  // attributes while it stays visible.
  return (
    element instanceof SVGElement &&
    (style.display === "contents" ||
      element.hasAttribute("systemLanguage") ||
      element.hasAttribute("requiredExtensions"))
  );
}

/**
 * Whether an element that `skipped` let through has a line (`shown`), only children
 * (`noLine`), or is hidden with what it contains (`skip`).
 */
function presenceOf(element: Element, style: CSSStyleDeclaration): Presence {
  const select = isOptionInSelect(element) ? element.closest("select") : null;
  if (select !== null) {
    if (optionHidden(element, select)) return "skip";
  } else if (!element.checkVisibility()) {
    return style.display === "contents" ? "noLine" : "skip";
  }
  return style.visibility === "visible" ? "shown" : "noLine";
}

/**
 * Whether an option or optgroup is hidden by itself, by an element between it and its select, by
 * the select's content-visibility, or by the visibility of a drop-down, which cannot be opened
 * while hidden. Firefox may give the options of a closed drop-down no box, so checkVisibility()
 * cannot tell, and a list box lays out what is between, so each element there must render the
 * next.
 */
function optionHidden(option: Element, select: Element): boolean {
  let current: Element | null = option;
  while (current !== null && current !== select) {
    if (skipped(current) || current.hasAttribute("hidden")) return true;
    const style = getComputedStyle(current);
    if (style.display === "none" || rendersNothing(current, style)) return true;
    // On the option itself it hides only the content, which the option's scope leaves out.
    if (current !== option && style.contentVisibility === "hidden") return true;
    const parent: Element | null = current.parentElement;
    if (
      parent !== null &&
      parent !== select &&
      (!rendersChildOf(parent, current) ||
        (inDetailsContent(parent, current) &&
          detailsContent(parent, { boxed: true, visible: true })?.boxed === false))
    ) {
      return true;
    }
    current = parent;
  }
  const style = getComputedStyle(select);
  if (style.contentVisibility === "hidden") return true;
  return (
    select instanceof HTMLSelectElement && !isListBox(select) && style.visibility !== "visible"
  );
}

function isListBox(select: HTMLSelectElement): boolean {
  return select.multiple || select.size > 1;
}

/** The state of the text directly inside `root`, judged by its flat-tree ancestors too. */
function rootTextState(root: Element, style: CSSStyleDeclaration): TextState {
  const boxed = style.contentVisibility !== "hidden" && laidOut(root, style);
  // visibility is inherited through the flat tree, the details content box included.
  return { boxed, visible: boxed && style.visibility === "visible" };
}

/** Whether the element's content is laid out in a box the user can see. */
function laidOut(start: Element, startStyle: CSSStyleDeclaration): boolean {
  if (rendersNothing(start, startStyle)) return false;
  let element = start;
  let style = startStyle;
  const select = listingSelect(start);
  if (select !== undefined) {
    if (optionHidden(start, select)) return false;
    element = select;
    style = getComputedStyle(select);
    if (rendersNothing(select, style)) return false;
  }
  // The first ancestor with a box decides what checkVisibility() decides; above it only what
  // Firefox renders of each holder's children does.
  let shown = style.display === "contents" ? undefined : element.checkVisibility();
  if (shown === false) return false;
  let child = element;
  for (let holder = flatParentOf(child); holder !== null; holder = flatParentOf(child)) {
    if (!rendersChildOf(holder, child)) return false;
    const holderStyle = getComputedStyle(holder);
    if (rendersNothing(holder, holderStyle)) return false;
    if (shown === undefined) {
      if (
        inDetailsContent(holder, child) &&
        (isClosedDetails(holder) ||
          detailsContent(holder, { boxed: true, visible: true })?.boxed === false)
      ) {
        return false;
      }
      if (holderStyle.contentVisibility === "hidden") return false;
      if (holderStyle.display !== "contents") {
        shown = holder.checkVisibility();
        if (!shown) return false;
      }
    }
    child = holder;
  }
  return shown === true;
}

/** The select that lists `element` among its options, if it is such an option. */
function listingSelect(element: Element): HTMLSelectElement | undefined {
  if (!(element instanceof HTMLOptionElement)) return undefined;
  const select = element.closest("select");
  return select instanceof HTMLSelectElement && Array.from(select.options).includes(element)
    ? select
    : undefined;
}

/** Whether `child` is among the children read_page walks in `holder`. */
function rendersChildOf(holder: Element, child: Element): boolean {
  if (holder.localName === "br") return false;
  // The same answers as the lists below, without building a list per call.
  if (holder instanceof SVGElement) {
    return child.parentNode === holder && svgRendersChild(holder, child);
  }
  if (holder instanceof HTMLSlotElement && child.assignedSlot === holder) return true;
  const nodes = renderedChildrenOf(holder);
  // A node is always among its parent's childNodes, the same object on every call.
  if (nodes === child.parentNode?.childNodes) return true;
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index] === child) return true;
  }
  return false;
}

/**
 * The state of what a details' content box holds, from the details' own state: Firefox lays out
 * every child but the shown summary in its ::details-content box, styled from that box, which a
 * page can hide while the details is open. Undefined for any other element, a details in another
 * namespace included: it has no such box, but a page may still give that pseudo a style.
 */
export function detailsContent(element: Element, own: TextState): TextState | undefined {
  if (!(element instanceof HTMLDetailsElement)) return undefined;
  // Before Firefox 143 there is no ::details-content, and no page can style that box.
  if (!CSS.supports("selector(::details-content)")) return own;
  const style = getComputedStyle(element, "::details-content");
  // checkVisibility() cannot be asked of the pseudo, so it takes the details' own state. An
  // unresolved style (empty display) counts as hidden.
  const boxed =
    own.boxed &&
    style.display !== "" &&
    style.display !== "none" &&
    style.contentVisibility !== "hidden";
  return { boxed, visible: boxed && style.visibility === "visible" };
}

function isOptionInSelect(element: Element): boolean {
  return (
    (element.localName === "option" || element.localName === "optgroup") &&
    element.closest("select") !== null
  );
}

export function isBlock(style: CSSStyleDeclaration): boolean {
  return !style.display.startsWith("inline") && style.display !== "contents";
}

function isFrame(element: Element): boolean {
  return element.localName === "iframe" || element.localName === "frame";
}

function frameLine(element: Element, level: number, page: PageMemory): Line {
  return {
    level,
    role: "iframe",
    name: element.getAttribute("title") ?? "",
    ref: page.refs.refFor(element),
    states: { frame: true },
  };
}

/**
 * The role an element's line shows, or undefined when it has no line of its own: no role,
 * generic, none or presentation, unless it is interactive.
 */
function roleOf(element: Element, page: PageMemory): string | undefined {
  const explicit = explicitRole(element.getAttribute("role"));
  const implicit = implicitRole(element, page);
  let role: string | undefined;
  if (explicit === "none" || explicit === "presentation") {
    // ARIA's presentational role conflict: an interactive element keeps its own role.
    role = isInteractive(element, implicit) ? implicit : undefined;
  } else if (explicit === "generic") {
    role = undefined;
  } else {
    role = explicit ?? implicit;
  }
  if (role !== undefined) return role;
  if (!isInteractive(element, undefined)) return undefined;
  return isEditingHost(element) ? "textbox" : "generic";
}

/** HTML-AAM's role for the common HTML elements. */
function implicitRole(element: Element, page: PageMemory): string | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  const heading = HEADING.exec(element.localName);
  if (heading !== null) return "heading";
  switch (element.localName) {
    case "a":
      return element.hasAttribute("href") ? "link" : undefined;
    case "button":
    case "summary":
      return "button";
    case "input":
      return element instanceof HTMLInputElement ? inputRole(element) : undefined;
    case "textarea":
      return "textbox";
    case "select":
      return element instanceof HTMLSelectElement && isListBox(element) ? "listbox" : "combobox";
    case "option":
      return "option";
    case "img":
      return element.getAttribute("alt") === "" ? undefined : "img";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "header":
      return element.parentElement?.closest(SECTIONING) ? undefined : "banner";
    case "footer":
      return element.parentElement?.closest(SECTIONING) ? undefined : "contentinfo";
    case "aside":
      return "complementary";
    case "form":
      return nameOf(element, "form", page).name === "" ? undefined : "form";
    case "section":
      return nameOf(element, "region", page).name === "" ? undefined : "region";
    case "search":
      return "search";
    case "dialog":
      return "dialog";
    case "details":
    case "fieldset":
      return "group";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "td":
      return "cell";
    case "th":
      return element.getAttribute("scope")?.trim().toLowerCase() === "row"
        ? "rowheader"
        : "columnheader";
    case "figure":
      return "figure";
    case "hr":
      return "separator";
    default:
      return undefined;
  }
}

function inputRole(input: HTMLInputElement): string {
  const listed = input.hasAttribute("list");
  switch (input.type) {
    case "checkbox":
    case "radio":
      return input.type;
    case "number":
      return "spinbutton";
    case "range":
      return "slider";
    case "submit":
    case "reset":
    case "button":
    case "image":
    case "file":
    case "color":
      return "button";
    case "search":
      return listed ? "combobox" : "searchbox";
    case "text":
    case "email":
    case "tel":
    case "url":
      return listed ? "combobox" : "textbox";
    default:
      return "textbox";
  }
}

/** True for an element the user can act on: read_page's filter interactive keeps these. */
function isInteractive(element: Element, role: string | undefined): boolean {
  switch (element.localName) {
    case "a":
      if (element.hasAttribute("href")) return true;
      break;
    case "button":
    case "select":
    case "textarea":
    case "summary":
      return true;
    case "input":
      return !(element instanceof HTMLInputElement && element.type === "hidden");
  }
  if (role !== undefined && INTERACTIVE_ROLES.has(role)) return true;
  const explicit = explicitRole(element.getAttribute("role"));
  if (explicit !== undefined && INTERACTIVE_ROLES.has(explicit)) return true;
  if (isEditingHost(element)) return true;
  return (
    element.hasAttribute("tabindex") &&
    (element instanceof HTMLElement || element instanceof SVGElement) &&
    element.tabIndex >= 0
  );
}

export function isEditingHost(element: Element): boolean {
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return false;
  const parent = element.parentElement;
  return !(parent instanceof HTMLElement && parent.isContentEditable);
}

/**
 * The element's accessible name, a subset of accname, and whether it came from the element's
 * own text, read in `startState` when given; that state also decides which labels name a
 * field. Never a form control's value.
 */
function nameOf(
  element: Element,
  role: string,
  page: PageMemory,
  startState?: TextState,
): { name: string; fromContent: boolean } {
  const labelledBy = labelledByText(element);
  if (labelledBy !== "") return { name: labelledBy, fromContent: false };
  const label = element.getAttribute("aria-label")?.trim() ?? "";
  if (label !== "") return { name: label, fromContent: false };
  const own = ownName(element, page, startState);
  if (own !== undefined) return { name: own, fromContent: false };
  if (NAME_FROM_CONTENT_ROLES.has(role)) {
    const content = collectText(element, false, startState);
    if (content !== "") return { name: content, fromContent: true };
  }
  return { name: element.getAttribute("title") ?? "", fromContent: false };
}

/** The text of the elements `aria-labelledby` names, hidden ones included. */
function labelledByText(element: Element): string {
  const ids = element.getAttribute("aria-labelledby")?.trim() ?? "";
  if (ids === "") return "";
  const root = element.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return "";
  const buffer = createTextBuffer();
  for (const id of ids.split(/\s+/)) {
    const target = root.getElementById(id);
    if (target !== null) buffer.add(` ${collectText(target, true)} `);
    if (buffer.full) break;
  }
  return buffer.text();
}

/** The name an element gets from its own markup, or undefined to go on with the content. */
function ownName(element: Element, page: PageMemory, startState?: TextState): string | undefined {
  if (element instanceof HTMLInputElement) {
    return first(
      labelsText(element.labels, startState),
      ...(element.type === "image" ? [element.getAttribute("alt")] : []),
      // A label, not user data, unless the page made a credential field a button; it names
      // the button only while the user sees it.
      ...(BUTTON_INPUTS.has(element.type) &&
      !isProtected(element, page) &&
      (startState === undefined || startState.visible)
        ? [element.value]
        : []),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
    );
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return first(
      labelsText(element.labels, startState),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
    );
  }
  if (element instanceof HTMLOptionElement) {
    return nonEmpty(element.getAttribute("label")?.trim() ?? "");
  }
  switch (element.localName) {
    case "img":
    case "area":
      return first(element.getAttribute("alt"), element.getAttribute("title"));
    case "fieldset":
      return childText(element, "legend");
    case "figure":
      return childText(element, "figcaption");
    case "table":
      return element instanceof HTMLTableElement && element.caption !== null
        ? nonEmpty(
            collectText(
              element.caption,
              false,
              rootTextState(element.caption, getComputedStyle(element.caption)),
            ),
          )
        : undefined;
    default:
      return undefined;
  }
}

/** The first of the values that is not empty; an empty string when none is. */
function first(...values: (string | null)[]): string {
  return values.map((value) => value?.trim() ?? "").find((value) => value !== "") ?? "";
}

/**
 * A label hidden on purpose names a field the user sees, as `aria-label` does; a field the user
 * cannot see (`fieldState` not visible) keeps only the labels the user sees.
 */
function labelsText(labels: NodeListOf<HTMLLabelElement> | null, fieldState?: TextState): string {
  if (labels === null) return "";
  const buffer = createTextBuffer();
  for (const label of labels) {
    const state =
      fieldState === undefined || fieldState.visible
        ? undefined
        : rootTextState(label, getComputedStyle(label));
    buffer.add(` ${collectText(label, false, state)} `);
  }
  return buffer.text();
}

function childText(element: Element, localName: string): string | undefined {
  for (const child of element.children) {
    if (child.localName === localName) {
      return nonEmpty(collectText(child, false, rootTextState(child, getComputedStyle(child))));
    }
  }
  return undefined;
}

function nonEmpty(text: string): string | undefined {
  return text === "" ? undefined : text;
}

/**
 * The text inside `start`, as the user sees it unless `withHidden`, cut a little past the
 * longest name. It never reads into a form control. `startState`, when given, is the state of
 * the text directly inside `start`, else it comes from `start`'s own style. Unless
 * `withLabels` is false, a descendant's `aria-label` stands for its content, as in a name.
 */
function collectText(
  start: Element,
  withHidden: boolean,
  startState?: TextState,
  withLabels = true,
): string {
  if (start.localName === "select" || CHILDLESS.has(start.localName)) return "";
  const buffer = createTextBuffer();
  let state = startState;
  if (state === undefined) {
    const startStyle = getComputedStyle(start);
    const boxed = startStyle.contentVisibility !== "hidden";
    state = { boxed, visible: startStyle.visibility === "visible" && boxed };
  }
  // Nothing inside a start without a box is shown, though a boxed child may call itself visible.
  if (!withHidden && !state.boxed) return "";
  const outer: TextScope = {
    element: start,
    block: false,
    boxed: state.boxed,
    shown: withHidden || state.visible,
    content: detailsContent(start, state),
  };
  const scopes: TextScope[] = [];
  walkChildren(
    start,
    {
      enter(element) {
        if (element.localName === "br") {
          buffer.add(" ");
          return false;
        }
        const image = element.localName === "img";
        if (element.localName === "select" || (CHILDLESS.has(element.localName) && !image)) {
          return false;
        }
        const style = getComputedStyle(element);
        if (rendersNothing(element, style)) return false;
        if (!withHidden && (skipped(element) || presenceOf(element, style) === "skip")) {
          return false;
        }
        const parent = scopes.at(-1) ?? outer;
        // As in walkTree: content-visibility is not inherited, but display contents passes it on.
        const parentBoxed =
          parent.content !== undefined && inDetailsContent(parent.element, element)
            ? parent.content.boxed
            : parent.boxed;
        const boxed =
          style.contentVisibility !== "hidden" && (style.display !== "contents" || parentBoxed);
        const visible = style.visibility === "visible" && boxed;
        const shown = withHidden || visible;
        // As in accname, a descendant's own label (when `withLabels`) or an image's alt stands
        // for its content.
        const alternative = shown ? alternativeOf(element, withLabels) : "";
        if (alternative !== "") {
          buffer.add(` ${alternative} `);
          return false;
        }
        if (image) return false;
        const block = isBlock(style);
        if (block) buffer.add(" ");
        scopes.push({
          element,
          block,
          boxed,
          shown,
          content: detailsContent(element, { boxed, visible }),
        });
        return true;
      },
      leave() {
        if (scopes.pop()?.block === true) buffer.add(" ");
      },
      text(value) {
        const scope = scopes.at(-1) ?? outer;
        if (scope.content === undefined ? scope.shown : withHidden || scope.content.visible) {
          buffer.add(value);
        }
      },
      done: () => buffer.full,
    },
    renderedChildrenOf,
  );
  return buffer.text();
}

/** An element's `aria-label` when `withLabels`, or an image's `alt`; empty when it has neither. */
function alternativeOf(element: Element, withLabels: boolean): string {
  const label = withLabels ? (element.getAttribute("aria-label")?.trim() ?? "") : "";
  if (label !== "" || element.localName !== "img") return label;
  return element.getAttribute("alt")?.trim() ?? "";
}

/** The states of an element's line. */
function statesOf(
  element: Element,
  role: string,
  focused: Element | null,
  page: PageMemory,
  state?: TextState,
): LineStates {
  const states: LineStates = {};
  if (element instanceof HTMLInputElement && element.type === "file") states.file = true;
  const checked = checkedOf(element);
  if (checked !== undefined) states.checked = checked;
  if ((element instanceof HTMLOptionElement && element.selected) || ariaTrue(element, "selected")) {
    states.selected = true;
  }
  const expanded = element.getAttribute("aria-expanded")?.trim().toLowerCase();
  if (expanded === "true" || expanded === "false") states.expanded = expanded === "true";
  if (ariaTrue(element, "pressed")) states.pressed = true;
  if (element.matches(":disabled") || ariaTrue(element, "disabled")) states.disabled = true;
  if (
    ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.readOnly) ||
    ariaTrue(element, "readonly")
  ) {
    states.readonly = true;
  }
  if (isRequired(element) || ariaTrue(element, "required")) states.required = true;
  const invalid = element.getAttribute("aria-invalid")?.trim().toLowerCase();
  if (invalid !== undefined && invalid !== "" && invalid !== "false") states.invalid = true;
  if (element === focused) states.focused = true;
  if (role === "heading") states.level = headingLevel(element);
  const field = fieldOf(element, role, page, state);
  if (field !== undefined) states.field = field;
  if (role === "link" && element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
    states.href = linkAddress(element.href, document.URL);
  }
  return states;
}

function checkedOf(element: Element): "checked" | "mixed" | undefined {
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  ) {
    if (element.indeterminate) return "mixed";
    return element.checked ? "checked" : undefined;
  }
  const checked = element.getAttribute("aria-checked")?.trim().toLowerCase();
  if (checked === "true") return "checked";
  return checked === "mixed" ? "mixed" : undefined;
}

function ariaTrue(element: Element, state: string): boolean {
  return element.getAttribute(`aria-${state}`)?.trim().toLowerCase() === "true";
}

function isRequired(element: Element): boolean {
  return (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement) &&
    element.required
  );
}

function headingLevel(element: Element): number {
  const level = element.getAttribute("aria-level")?.trim() ?? "";
  if (WHOLE_NUMBER.test(level)) {
    const number = Number(level);
    if (Number.isSafeInteger(number) && number >= 1) return number;
  }
  const heading = HEADING.exec(element.localName);
  return heading === null ? 2 : Number(heading[1]);
}

/**
 * The value a field shows, the text an editable area shows, or that a field is protected;
 * undefined for anything else, and no value for a file field or when `state` says the user
 * cannot see the field or area.
 */
function fieldOf(
  element: Element,
  role: string,
  page: PageMemory,
  state?: TextState,
): LineStates["field"] {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (isProtected(element, page)) return { protected: true, filled: element.value !== "" };
    if (element.type === "file") return undefined;
    if (state !== undefined && !state.visible) return undefined;
    if (element instanceof HTMLTextAreaElement || VALUE_ROLES.has(role)) {
      return { value: element.value };
    }
    return undefined;
  }
  if (element instanceof HTMLSelectElement) {
    if (state !== undefined && !state.visible) return undefined;
    const selected = Array.from(element.selectedOptions);
    // Firefox draws a closed drop-down's selected option's whole label however the option, its
    // group or its content is hidden; a list box shows only what its rows paint.
    const labels = isListBox(element)
      ? selected
          .filter((option) => optionPainted(option, element))
          .map((option) => paintedLabel(option))
      : selected.map((option) => option.label || option.text);
    return { value: labels.join(", ") };
  }
  if (isEditingHost(element)) {
    if (state !== undefined && !state.visible) return undefined;
    // The text the user sees: a descendant's aria-label does not stand for its content.
    return { value: collectText(element, false, state, false) };
  }
  return undefined;
}

function isProtected(field: HTMLInputElement | HTMLTextAreaElement, page: PageMemory): boolean {
  return isProtectedField({
    localName: field.localName,
    type: field.type,
    autocomplete: field.getAttribute("autocomplete"),
    wasPassword: page.passwordFields.has(field),
    autofilled: field.matches(":autofill"),
  });
}

/** Whether a list box the user sees paints the option's text, as the option's line says. */
function optionPainted(option: HTMLOptionElement, select: HTMLSelectElement): boolean {
  if (optionHidden(option, select)) return false;
  const style = getComputedStyle(option);
  return style.visibility === "visible" && style.contentVisibility !== "hidden";
}

/** What a painted list box row shows: the option's label attribute, or its shown content. */
function paintedLabel(option: HTMLOptionElement): string {
  if ((option.getAttribute("label") ?? "") !== "") return option.label;
  return collectText(option, false, { boxed: true, visible: true });
}
