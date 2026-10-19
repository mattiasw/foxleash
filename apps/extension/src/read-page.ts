import { type ElementRefs, refError } from "./element-refs.ts";
import { PageError } from "./page-messages.ts";
import {
  createTextBuffer,
  createTreeText,
  explicitRole,
  formatLine,
  INTERACTIVE_ROLES,
  isProtectedField,
  LANDMARK_ROLES,
  type LineStates,
  NAME_FROM_CONTENT_ROLES,
  type ReadPageOptions,
  readPageOptions,
  type TreeText,
  textLine,
} from "./page-tree.ts";

/** What read_page keeps per document, in the content script. */
export interface PageMemory {
  refs: ElementRefs<Element>;
  /** Every input that had type password at a read, which stays protected. */
  passwordFields: WeakSet<Element>;
}

interface Walker {
  /** Called for each element; true walks its flattened children and calls `leave` after. */
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
}

type Presence = "skip" | "noLine" | "shown";

/** One element the text collection for a name is inside of. */
interface TextScope {
  block: boolean;
  /** Text directly inside has a box: not under content-visibility hidden. */
  boxed: boolean;
  /** Text directly inside counts. */
  shown: boolean;
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
const UNREAD: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);
// Firefox also exposes its own widget roots (video controls, date inputs) as shadow roots.
const SHADOW_HOSTS: ReadonlySet<string> = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "span",
]);
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

interface ShadowAccess {
  readonly shadowRoot: ShadowRoot | null;
  /** Firefox's, for content scripts only: the shadow root, closed ones included. */
  readonly openOrClosedShadowRoot?: ShadowRoot | null;
}

/** read_page in the page: the tree of the document, or of the element `ref` names. */
export function readPage(
  params: Record<string, unknown>,
  page: PageMemory,
): { tree: string; truncated: boolean } {
  const options = readPageOptions(params);
  if (typeof options === "string") throw new PageError("invalid_params", options);
  noteFields(page);
  const tree = createTreeText();
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
  const { name } = nameOf(element, role, page);
  const focused = focusedElement();
  tree.add(
    formatLine({
      level: 0,
      role,
      name,
      ref: page.refs.refFor(element),
      states: statesOf(element, role, focused, page),
    }),
  );
  if (!withinHidden(element)) walkTree(element, role, { options, page, tree, focused });
  return tree.result();
}

interface TreeContext {
  options: ReadPageOptions;
  page: PageMemory;
  tree: TreeText;
  focused: Element | null;
}

/**
 * Adds the lines of what `root` contains to the tree. `rootRole` is the role of the root's own
 * line at level 0, or undefined when the root has no line.
 */
function walkTree(root: Element, rootRole: string | undefined, context: TreeContext): void {
  const { options, page, tree, focused } = context;
  const all = options.filter === "all";
  const rootStyle = getComputedStyle(root);
  // A root given by ref may itself be hidden, and then so is its text.
  const rootBoxed =
    rootStyle.contentVisibility !== "hidden" &&
    (root.checkVisibility() || rootStyle.display === "contents");
  const rootScope: Scope = {
    element: root,
    lineLevel: rootRole === undefined ? undefined : 0,
    childLevel: rootRole === undefined ? 0 : 1,
    owner: undefined,
    pending: undefined,
    quiet: rootRole !== undefined && nameOf(root, rootRole, page).fromContent,
    boxed: rootBoxed,
    textVisible: rootStyle.visibility === "visible" && rootBoxed,
    block: true,
  };
  if (rootRole !== undefined) rootScope.owner = rootScope;
  const scopes: Scope[] = [rootScope];
  // Where pending landmarks start in `scopes`, outermost first.
  const pending: Scope[] = [];
  let run = createTextBuffer();
  let runScope: Scope | undefined;
  // The scope whose rest was cut by depth; nothing inside it is read any more.
  let cutAt: Scope | undefined;

  walkChildren(root, {
    enter(element) {
      if (cutAt !== undefined) return false;
      if (skipped(element)) return false;
      if (element.localName === "br") {
        if (all) addText(" ");
        return false;
      }
      const style = getComputedStyle(element);
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
      const boxed =
        style.contentVisibility !== "hidden" && (style.display !== "contents" || parent.boxed);
      const scope: Scope = {
        element,
        lineLevel: undefined,
        childLevel: parent.childLevel,
        owner: parent.owner,
        pending: undefined,
        quiet: parent.quiet,
        boxed,
        textVisible: style.visibility === "visible" && boxed,
        block,
      };
      if (lined) {
        if (!flushPending()) return false;
        const named = nameOf(element, role, page);
        const level = top().childLevel;
        const placed = place(level, top().owner, () =>
          formatLine({
            level,
            role,
            name: named.name,
            ref: page.refs.refFor(element),
            states: statesOf(element, role, focused, page),
          }),
        );
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
      if (!all || cutAt !== undefined || scope.quiet || !scope.textVisible) return;
      addText(value);
    },
    done: () => tree.full,
  });
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
        const placed = place(at, owner, () =>
          formatLine({
            level: at,
            role: landmark.role,
            name: landmark.name,
            ref: page.refs.refFor(scope.element),
            states: statesOf(scope.element, landmark.role, focused, page),
          }),
        );
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
  function place(level: number, owner: Scope | undefined, line: () => string): boolean {
    if (options.depth !== undefined && level >= options.depth) {
      tree.markCut();
      cutAt = owner;
      return false;
    }
    return tree.add(line());
  }
}

/** Walks the flattened tree below `root` without recursion, so deep nesting cannot overflow. */
function walkChildren(root: Element, walker: Walker): void {
  const steps: Step[] = [];
  pushChildren(steps, root);
  while (!walker.done()) {
    const step = steps.pop();
    if (step === undefined) return;
    if ("leave" in step) {
      walker.leave(step.leave);
    } else if (step.node.nodeType === Node.TEXT_NODE) {
      walker.text(step.node.nodeValue ?? "");
    } else if (step.node instanceof Element && walker.enter(step.node)) {
      steps.push({ leave: step.node });
      pushChildren(steps, step.node);
    }
  }
}

function pushChildren(steps: Step[], parent: Element): void {
  const children = childrenOf(parent);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index];
    if (node !== undefined) steps.push({ node });
  }
}

/** An element's children in the flattened tree, as far as the user can see them. */
function childrenOf(element: Element): ArrayLike<Node> {
  if (CHILDLESS.has(element.localName)) return [];
  if (element.localName === "details" && !element.hasAttribute("open")) {
    for (const child of element.children) {
      if (child.localName === "summary") return [child];
    }
    return [];
  }
  const shadow = shadowRootOf(element);
  if (shadow !== null) return shadow.childNodes;
  if (element instanceof HTMLSlotElement) {
    const assigned = element.assignedNodes({ flatten: true });
    if (assigned.length > 0) return assigned;
  }
  return element.childNodes;
}

/** The author shadow root of an element that may carry one, open or closed. */
function shadowRootOf(element: Element): ShadowRoot | null {
  if (!element.localName.includes("-") && !SHADOW_HOSTS.has(element.localName)) return null;
  const access: ShadowAccess = element;
  const root = access.openOrClosedShadowRoot;
  return root === undefined ? element.shadowRoot : root;
}

/** The focused element, followed into shadow roots. */
function focusedElement(): Element | null {
  let focused = document.activeElement;
  while (focused !== null) {
    const inner = shadowRootOf(focused)?.activeElement ?? null;
    if (inner === null) return focused;
    focused = inner;
  }
  return null;
}

/**
 * Remembers every password field in the document, in shadow roots and hidden parts too and
 * whatever the walk reaches, so it stays protected after the page turns it into text.
 */
function noteFields(page: PageMemory): void {
  const roots: ParentNode[] = [document];
  for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
    for (const element of root.querySelectorAll("*")) {
      if (element instanceof HTMLInputElement && element.type === "password") {
        page.passwordFields.add(element);
      }
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
 * Whether an element that `skipped` let through has a line (`shown`), only children
 * (`noLine`), or is hidden with what it contains (`skip`).
 */
function presenceOf(element: Element, style: CSSStyleDeclaration): Presence {
  if (isOptionInSelect(element)) {
    // Firefox may give the options of a closed drop-down no box.
    if (element.hasAttribute("hidden") || style.display === "none") return "skip";
  } else if (!element.checkVisibility()) {
    return style.display === "contents" ? "noLine" : "skip";
  }
  return style.visibility === "visible" ? "shown" : "noLine";
}

function isOptionInSelect(element: Element): boolean {
  return (
    (element.localName === "option" || element.localName === "optgroup") &&
    element.closest("select") !== null
  );
}

function isBlock(style: CSSStyleDeclaration): boolean {
  return !style.display.startsWith("inline") && style.display !== "contents";
}

function isFrame(element: Element): boolean {
  return element.localName === "iframe" || element.localName === "frame";
}

function frameLine(element: Element, level: number, page: PageMemory): string {
  return formatLine({
    level,
    role: "iframe",
    name: element.getAttribute("title") ?? "",
    ref: page.refs.refFor(element),
    states: { frame: true },
  });
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
      return element instanceof HTMLSelectElement && (element.multiple || element.size > 1)
        ? "listbox"
        : "combobox";
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

function isEditingHost(element: Element): boolean {
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return false;
  const parent = element.parentElement;
  return !(parent instanceof HTMLElement && parent.isContentEditable);
}

/**
 * The element's accessible name, a subset of accname, and whether it came from the element's
 * own text. Never a form control's value.
 */
function nameOf(
  element: Element,
  role: string,
  page: PageMemory,
): { name: string; fromContent: boolean } {
  const labelledBy = labelledByText(element);
  if (labelledBy !== "") return { name: labelledBy, fromContent: false };
  const label = element.getAttribute("aria-label")?.trim() ?? "";
  if (label !== "") return { name: label, fromContent: false };
  const own = ownName(element, page);
  if (own !== undefined) return { name: own, fromContent: false };
  if (NAME_FROM_CONTENT_ROLES.has(role)) {
    const content = collectText(element, false);
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
function ownName(element: Element, page: PageMemory): string | undefined {
  if (element instanceof HTMLInputElement) {
    return first(
      labelsText(element.labels),
      ...(element.type === "image" ? [element.getAttribute("alt")] : []),
      // A label, not user data, unless the page made a credential field a button.
      ...(BUTTON_INPUTS.has(element.type) && !isProtected(element, page) ? [element.value] : []),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
    );
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return first(
      labelsText(element.labels),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
    );
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
        ? nonEmpty(collectText(element.caption, false))
        : undefined;
    default:
      return undefined;
  }
}

/** The first of the values that is not empty; an empty string when none is. */
function first(...values: (string | null)[]): string {
  return values.map((value) => value?.trim() ?? "").find((value) => value !== "") ?? "";
}

function labelsText(labels: NodeListOf<HTMLLabelElement> | null): string {
  if (labels === null) return "";
  const buffer = createTextBuffer();
  for (const label of labels) buffer.add(` ${collectText(label, false)} `);
  return buffer.text();
}

function childText(element: Element, localName: string): string | undefined {
  for (const child of element.children) {
    if (child.localName === localName) return nonEmpty(collectText(child, false));
  }
  return undefined;
}

function nonEmpty(text: string): string | undefined {
  return text === "" ? undefined : text;
}

/**
 * The text inside `start`, as the user sees it unless `withHidden`, cut a little past the
 * longest name. It never reads into a form control.
 */
function collectText(start: Element, withHidden: boolean): string {
  if (start.localName === "select" || CHILDLESS.has(start.localName)) return "";
  const buffer = createTextBuffer();
  const startStyle = getComputedStyle(start);
  const startBoxed = startStyle.contentVisibility !== "hidden";
  const outer: TextScope = {
    block: false,
    boxed: startBoxed,
    shown: withHidden || (startStyle.visibility === "visible" && startBoxed),
  };
  const scopes: TextScope[] = [];
  walkChildren(start, {
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
      if (!withHidden && (skipped(element) || presenceOf(element, style) === "skip")) return false;
      const parent = scopes.at(-1) ?? outer;
      // As in walkTree: content-visibility is not inherited, but display contents passes it on.
      const boxed =
        style.contentVisibility !== "hidden" && (style.display !== "contents" || parent.boxed);
      const shown = withHidden || (style.visibility === "visible" && boxed);
      // As in accname, a descendant's own label or an image's alt stands for its content.
      const alternative = shown ? alternativeOf(element) : "";
      if (alternative !== "") {
        buffer.add(` ${alternative} `);
        return false;
      }
      if (image) return false;
      const block = isBlock(style);
      if (block) buffer.add(" ");
      scopes.push({ block, boxed, shown });
      return true;
    },
    leave() {
      if (scopes.pop()?.block === true) buffer.add(" ");
    },
    text(value) {
      if ((scopes.at(-1) ?? outer).shown) buffer.add(value);
    },
    done: () => buffer.full,
  });
  return buffer.text();
}

/** An element's `aria-label`, or an image's `alt`; empty when it has neither. */
function alternativeOf(element: Element): string {
  const label = element.getAttribute("aria-label")?.trim() ?? "";
  if (label !== "" || element.localName !== "img") return label;
  return element.getAttribute("alt")?.trim() ?? "";
}

/** The states of an element's line. */
function statesOf(
  element: Element,
  role: string,
  focused: Element | null,
  page: PageMemory,
): LineStates {
  const states: LineStates = {};
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
  const field = fieldOf(element, role, page);
  if (field !== undefined) states.field = field;
  if (role === "link" && element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
    states.href = element.href;
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

/** The value a field shows, or that it is protected; undefined for anything else. */
function fieldOf(element: Element, role: string, page: PageMemory): LineStates["field"] {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (isProtected(element, page)) return { protected: true, filled: element.value !== "" };
    if (element instanceof HTMLTextAreaElement || VALUE_ROLES.has(role)) {
      return { value: element.value };
    }
    return undefined;
  }
  if (element instanceof HTMLSelectElement) {
    return { value: Array.from(element.selectedOptions, (option) => option.label).join(", ") };
  }
  return undefined;
}

function isProtected(field: HTMLInputElement | HTMLTextAreaElement, page: PageMemory): boolean {
  return isProtectedField({
    localName: field.localName,
    type: field.type,
    autocomplete: field.getAttribute("autocomplete"),
    wasPassword: page.passwordFields.has(field),
  });
}
