import type { ProbeCheck, ProbeCheckName, ProbeOutcome, ProbeResult } from "@foxleash/protocol";

/**
 * Measures which kinds of synthetic input work in the page, in its isolated world. Returns null,
 * touching nothing, when the document is not on `site`; throws, touching nothing, when it starts
 * at or after `cutoff` (ms since the epoch), and acts on nothing after it.
 *
 * `scripting.executeScript` serializes this function with `toString()`, so everything it uses
 * lives inside it.
 */
export async function probePage(site: string, cutoff: number): Promise<ProbeResult | null> {
  if (siteOfLocation(location) !== site) return null;
  // The extension has stopped waiting for this run.
  if (Date.now() >= cutoff) throw new TypeError("the probe started after its cutoff");

  // About 20 s per page in all, well below the host's request timeout.
  const deadline = Math.min(Date.now() + 18_000, cutoff);
  const WAIT_MS = 250;
  const RESTORE_MS = 300;
  // Some pages set aria-expanded only when a transition ends.
  const TOGGLE_MS = 1000;
  // How long the submit guard outlasts the last check, for a page that reacts late.
  const SETTLE_MS = 1000;
  const TAG = /^[a-z][a-z0-9-]{0,39}$/;
  const ROLE = /^[a-z]{1,20}$/;
  const CLASS = /^[A-Za-z_-][A-Za-z0-9_-]{0,39}$/;
  const ERROR_NAME = /^[A-Za-z]{1,40}$/;
  const RECORDED = [
    "click",
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "focusin",
    "hashchange",
  ];
  // Event types that must not reach the page's bubble-phase handlers from the probe's elements.
  const CONTAINED = [
    "click",
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "submit",
    "focusin",
    "focusout",
    "change",
    "select",
    "selectionchange",
  ];
  const RICH_EDITORS: [string, string][] = [
    [".ProseMirror", "prosemirror"],
    [".cm-content", "codemirror"],
    ["[data-lexical-editor]", "lexical"],
    ["[data-slate-editor]", "slate"],
    [".ql-editor", "quill"],
    [".public-DraftEditor-content", "draft"],
    ['[g_editable="true"]', "gmail"],
    ['[contenteditable][role="textbox"]', "textbox"],
    [".docs-texteventtarget-iframe", "google_docs"],
  ];
  const DOCS_UNREADABLE = "effect not readable: Google Docs draws text on a canvas";
  const TEXT_TYPES = ["text", "search", "email", "url", "tel"];
  // A one-time code or a password shown as text: a typed marker could use up an attempt.
  const CREDENTIALS = ["one-time-code", "current-password", "new-password"];
  const CLICKABLE_ANCESTOR =
    "a, label, button, summary, [role=link], [role=row], [role=option], [role=menuitem], [role=tab], [onclick], [jsaction*=click]";

  const checks: ProbeCheck[] = [];
  const seen: Event[] = [];
  const cleanups: (() => void)[] = [];
  const listened = new Set<Window>();
  const focused = document.activeElement;
  let stopped = false;
  let hashStuck = false;
  let linkCount = 0;
  const container = document.createElement("div");

  try {
    listen(window);
    container.style.cssText =
      "position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none; z-index: 2147483647";
    for (const type of CONTAINED) {
      container.addEventListener(type, stopAtContainer);
    }
    (document.body ?? document.documentElement).append(container);
    await probeOwnChecks();
    container.remove();
    await siteChecks();
    // A page may react after a debounce, for example by submitting the restored text field.
    await wait(Math.max(0, Math.min(SETTLE_MS, cutoff - Date.now())));
  } finally {
    container.remove();
    for (const cleanup of cleanups) cleanup();
    if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body) {
      focused.focus();
    }
  }
  return { userAgent: navigator.userAgent, checks };

  function listen(view: Window): void {
    if (listened.has(view)) return;
    listened.add(view);
    for (const type of RECORDED) {
      view.addEventListener(type, remember, true);
      cleanups.push(() => view.removeEventListener(type, remember, true));
    }
    view.addEventListener("submit", guardSubmit, true);
    cleanups.push(() => view.removeEventListener("submit", guardSubmit, true));
  }

  function remember(event: Event): void {
    seen.push(event);
  }

  /** Nothing is ever submitted while the probe runs. */
  function guardSubmit(event: Event): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    seen.push(event);
  }

  function stopAtContainer(event: Event): void {
    event.stopPropagation();
  }

  async function probeOwnChecks(): Promise<void> {
    const button = document.createElement("button");
    button.type = "button";
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
    });
    container.append(button);
    for (const strategy of ["click_event", "pointer_sequence"]) {
      await attempt("click_button", "probe", button, undefined, strategy, async () => {
        const before = clicks;
        const click = clickWith(button, strategy);
        await wait(WAIT_MS);
        const worked = clicks > before;
        return result(worked, saw(click), worked ? "listener ran" : "listener did not run");
      });
    }

    const link = document.createElement("a");
    link.target = "_self";
    container.append(link);
    for (const strategy of ["click_event", "pointer_sequence"]) {
      linkCount += 1;
      link.href = `${withoutFragment(location.href)}#foxleash-probe-${linkCount}`;
      await attemptLink("probe", link, strategy);
    }

    const input = document.createElement("input");
    input.type = "text";
    container.append(input);
    await typeChecks("type_input", "probe", input, undefined, [
      "key_events",
      "native_setter",
      "exec_command",
    ]);

    const editable = document.createElement("div");
    editable.contentEditable = "true";
    container.append(editable);
    await typeChecks("type_contenteditable", "probe", editable, undefined, [
      "key_events",
      "beforeinput_dom",
      "exec_command",
    ]);

    const form = document.createElement("form");
    // A dialog-method form outside a dialog submits nowhere, even past the submit guard.
    form.method = "dialog";
    const field = document.createElement("input");
    field.type = "text";
    const submit = document.createElement("button");
    submit.type = "submit";
    form.append(field, submit);
    container.append(form);
    await attempt("enter_in_form", "probe", form, undefined, "enter_keydown", async () => {
      const mark = seen.length;
      if (!focusOn(field)) return couldNotFocus();
      const down = pressKey(field, "Enter", "Enter");
      await wait(WAIT_MS);
      const worked = submitted(mark, form);
      return result(worked, saw(down), worked ? "form submitted" : "form not submitted");
    });
    await attempt("enter_in_form", "probe", form, undefined, "request_submit", async () => {
      const mark = seen.length;
      form.requestSubmit();
      await wait(WAIT_MS);
      const worked = submitted(mark, form);
      return result(worked, worked, worked ? "form submitted" : "form not submitted");
    });

    const first = document.createElement("input");
    first.type = "text";
    const second = document.createElement("input");
    second.type = "text";
    container.append(first, second);
    await attempt("tab_focus", "probe", first, undefined, "tab_keydown", async () => {
      if (!focusOn(first)) return couldNotFocus();
      const view = viewOf(first);
      const init = { key: "Tab", code: "Tab", bubbles: true, cancelable: true, composed: true };
      const down = new view.KeyboardEvent("keydown", init);
      first.dispatchEvent(down);
      first.dispatchEvent(new view.KeyboardEvent("keyup", init));
      await wait(WAIT_MS);
      const worked = document.activeElement !== first;
      return result(worked, saw(down), worked ? "focus moved" : "focus did not move");
    });
    await attempt("tab_focus", "probe", first, undefined, "focus_call", async () => {
      if (!focusOn(first)) return couldNotFocus();
      const mark = seen.length;
      second.focus();
      await wait(WAIT_MS);
      const worked = document.activeElement === second;
      const delivered = seenSince(mark, "focusin").some((event) => event.target === second);
      return result(worked, delivered, worked ? "focus moved" : "focus did not move");
    });
  }

  async function siteChecks(): Promise<void> {
    const input = siteInput();
    if (input === undefined) {
      noTarget("type_input", "no visible, enabled text field");
    } else {
      await typeChecks("type_input", "site", input, undefined, [
        "key_events",
        "native_setter",
        "exec_command",
      ]);
    }

    const editable = siteEditable();
    if (editable === undefined) {
      noTarget("type_contenteditable", "no visible editable area outside a known editor");
    } else {
      await typeChecks("type_contenteditable", "site", editable, undefined, [
        "key_events",
        "beforeinput_dom",
        "exec_command",
      ]);
    }

    await richEditorChecks();
    await toggleChecks();

    const skip = skipLink();
    if (skip === undefined) {
      noTarget("click_link", "no visible link to an element in the page");
    } else {
      await attemptLink("site", skip, "click_event");
    }
  }

  async function richEditorChecks(): Promise<void> {
    const found = richEditor();
    if (found === undefined) {
      noTarget("type_rich_editor", "no known rich editor");
      return;
    }
    const strategies = ["key_events", "beforeinput_dom", "exec_command"];
    if (found.kind !== "google_docs") {
      await typeChecks("type_rich_editor", "site", found.el, found.kind, strategies);
      return;
    }
    const frame = found.el;
    const frameDocument = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    // document.domain lets a frame on another site share its document; about:blank is this site's.
    if (
      frameDocument !== null &&
      frameDocument.location.protocol !== "about:" &&
      siteOfLocation(frameDocument.location) !== site
    ) {
      noTarget("type_rich_editor", "the Google Docs input frame is on another site");
      return;
    }
    const body = frameDocument?.body ?? null;
    const editable = body?.isContentEditable
      ? body
      : frameDocument?.querySelector('[contenteditable]:not([contenteditable="false"])');
    const frameView = frameDocument?.defaultView ?? null;
    if (frameView === null || !(editable instanceof frameView.HTMLElement)) {
      noTarget("type_rich_editor", "the Google Docs input frame is not readable");
      return;
    }
    await typeChecks("type_rich_editor", "site", editable, found.kind, strategies);
  }

  async function toggleChecks(): Promise<void> {
    const toggle = disclosureToggle();
    if (toggle === undefined) {
      noTarget("click_button", "no expand or collapse toggle");
      return;
    }
    const initial = toggle.getAttribute("aria-expanded");
    const expanded = (): string | null => toggle.getAttribute("aria-expanded");
    for (const strategy of ["click_event", "pointer_sequence"]) {
      let restored = true;
      await attempt("click_button", "site", toggle, undefined, strategy, async () => {
        restored = false;
        const click = clickWith(toggle, strategy);
        if (!(await waitFor(() => expanded() !== initial, TOGGLE_MS))) {
          restored = true;
          return result(false, saw(click), "aria-expanded unchanged");
        }
        clickWith(toggle, strategy);
        restored = await waitFor(() => expanded() === initial, TOGGLE_MS);
        return result(true, saw(click), restored ? "restored" : "not restored");
      });
      if (!restored) return;
    }
  }

  async function typeChecks(
    check: ProbeCheckName,
    target: "probe" | "site",
    el: HTMLElement,
    editor: string | undefined,
    strategies: string[],
  ): Promise<void> {
    for (const strategy of strategies) {
      await attempt(check, target, el, editor, strategy, async () => {
        const marker = markerOf(strategy);
        const field = textField(el);
        const original = field?.value;
        if (target === "probe") clear(el);
        const hadFocus = el.ownerDocument.activeElement === el;
        try {
          const outcome = await typeWith(el, strategy, marker);
          if (editor === "google_docs" && outcome.outcome === "no_effect") {
            return { outcome: "unknown", delivered: outcome.delivered, detail: DOCS_UNREADABLE };
          }
          return outcome;
        } finally {
          if (target === "site" && field !== undefined && original !== undefined) {
            setValue(field, original);
            field.dispatchEvent(new (viewOf(field).Event)("input", { bubbles: true }));
            if (!hadFocus) field.blur();
          }
        }
      });
    }
  }

  async function typeWith(el: HTMLElement, strategy: string, marker: string): Promise<Outcome> {
    const view = viewOf(el);
    const doc = el.ownerDocument;
    // Markers from an earlier run stay in a site editor, so only a new one counts.
    const count = (): number => textOf(el).split(marker).length - 1;
    const already = count();
    const has = (): boolean => count() > already;
    const mark = seen.length;
    if (strategy === "key_events") {
      if (!focusOn(el)) return couldNotFocus();
      let first: Event | undefined;
      for (const character of marker) {
        const code = /[0-9]/.test(character)
          ? `Digit${character}`
          : `Key${character.toUpperCase()}`;
        const down = pressKey(el, character, code);
        first ??= down;
      }
      await wait(WAIT_MS);
      return result(has(), first !== undefined && saw(first), insertion(has()));
    }
    if (strategy === "native_setter") {
      const field = textField(el);
      if (field === undefined) return { outcome: "error", delivered: false, detail: "no value" };
      setValue(field, marker);
      const event = new view.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: marker,
      });
      field.dispatchEvent(event);
      await wait(WAIT_MS);
      return result(has(), saw(event), insertion(has()));
    }
    if (strategy === "beforeinput_dom") {
      const before = new view.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: marker,
      });
      const proceed = el.dispatchEvent(before);
      if (proceed) {
        el.append(doc.createTextNode(marker));
        el.dispatchEvent(
          new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: marker }),
        );
      }
      await wait(WAIT_MS);
      const detail = proceed ? insertion(has()) : `beforeinput cancelled, ${insertion(has())}`;
      return result(has(), saw(before), detail);
    }
    if (!focusOn(el)) return couldNotFocus();
    caretAtEnd(el);
    doc.execCommand("insertText", false, marker);
    await wait(WAIT_MS);
    const inputs = seenSince(mark, "input").filter(
      (event) => event.target instanceof view.Node && el.contains(event.target),
    );
    const trust =
      inputs.length === 0
        ? "no input event"
        : inputs.some((event) => event.isTrusted)
          ? "input event trusted"
          : "input event untrusted";
    return result(has(), inputs.length > 0, `${insertion(has())}, ${trust}`);
  }

  async function attemptLink(
    target: "probe" | "site",
    link: HTMLAnchorElement,
    strategy: string,
  ): Promise<void> {
    if (hashStuck) {
      record("click_link", target, describe(link), strategy, {
        outcome: "error",
        delivered: false,
        detail: "skipped: hash not restored",
      });
      return;
    }
    await attempt("click_link", target, link, undefined, strategy, async () => {
      const before = location.hash;
      const length = history.length;
      const mark = seen.length;
      const click = clickWith(link, strategy);
      await wait(WAIT_MS);
      const worked = location.hash !== before || seenSince(mark, "hashchange").length > 0;
      let detail = worked ? "hash changed" : "hash unchanged";
      if (location.hash !== before) {
        // After a restore the tab has a forward entry, which the next push replaces, so the
        // length stays the same; the link's own hashchange still shows the push.
        const pushed =
          history.length === length + 1 ||
          seenSince(mark, "hashchange").some(
            (event) =>
              event.isTrusted && event instanceof HashChangeEvent && event.newURL === link.href,
          );
        if (pushed) {
          history.back();
          await waitFor(() => location.hash === before, RESTORE_MS);
        }
        detail = location.hash === before ? "restored" : "hash not restored";
        if (location.hash !== before) hashStuck = true;
      }
      return result(worked, saw(click), detail);
    });
  }

  async function attempt(
    check: ProbeCheckName,
    target: "probe" | "site",
    el: Element,
    editor: string | undefined,
    strategy: string,
    run: () => Promise<Outcome>,
  ): Promise<void> {
    const element = describe(el, editor);
    if (stopped || Date.now() > deadline) {
      stopped = true;
      record(check, target, element, strategy, {
        outcome: "error",
        delivered: false,
        detail: "skipped: time limit",
      });
      return;
    }
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = { outcome: "error", delivered: false, detail: `threw ${errorName(error)}` };
    }
    record(check, target, element, strategy, outcome);
  }

  function record(
    check: ProbeCheckName,
    target: "probe" | "site",
    element: string | undefined,
    strategy: string,
    { outcome, delivered, detail }: Outcome,
  ): void {
    checks.push({
      check,
      target,
      ...(element === undefined ? {} : { element }),
      strategy,
      outcome,
      delivered,
      trustedOnly: delivered && outcome === "no_effect",
      detail,
    });
  }

  function noTarget(check: ProbeCheckName, detail: string): void {
    record(check, "site", undefined, "none", { outcome: "no_target", delivered: false, detail });
  }

  function result(worked: boolean, delivered: boolean, detail: string): Outcome {
    return { outcome: worked ? "worked" : "no_effect", delivered, detail };
  }

  function couldNotFocus(): Outcome {
    return { outcome: "error", delivered: false, detail: "could not focus" };
  }

  function insertion(present: boolean): string {
    return present ? "text inserted" : "no text inserted";
  }

  function clickWith(el: HTMLElement, strategy: string): Event {
    const view = viewOf(el);
    const box = el.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      button: 0,
    };
    if (strategy === "pointer_sequence") {
      const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new view.PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
      el.dispatchEvent(new view.MouseEvent("mousedown", { ...at, buttons: 1 }));
      el.dispatchEvent(new view.PointerEvent("pointerup", { ...pointer, buttons: 0 }));
      el.dispatchEvent(new view.MouseEvent("mouseup", { ...at, buttons: 0 }));
    }
    const click = new view.MouseEvent("click", { ...at, buttons: 0 });
    el.dispatchEvent(click);
    return click;
  }

  /** Dispatches keydown, keypress and keyup; returns the keydown. */
  function pressKey(el: HTMLElement, key: string, code: string): Event {
    const view = viewOf(el);
    const init = { key, code, bubbles: true, cancelable: true, composed: true };
    const down = new view.KeyboardEvent("keydown", init);
    el.dispatchEvent(down);
    el.dispatchEvent(new view.KeyboardEvent("keypress", init));
    el.dispatchEvent(new view.KeyboardEvent("keyup", init));
    return down;
  }

  function focusOn(el: HTMLElement): boolean {
    el.focus();
    return el.ownerDocument.activeElement === el;
  }

  function caretAtEnd(el: HTMLElement): void {
    const field = textField(el);
    if (field !== undefined) {
      const end = field.value.length;
      try {
        field.setSelectionRange(end, end);
      } catch {
        // Some input types, such as email, have no selection.
      }
      return;
    }
    const selection = viewOf(el).getSelection();
    if (selection === null) return;
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clear(el: HTMLElement): void {
    const field = textField(el);
    if (field === undefined) el.textContent = "";
    else setValue(field, "");
  }

  /** Sets the value with the element's own prototype setter, as a user's edit does. */
  function setValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const view = viewOf(field);
    const proto =
      field instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter === undefined) throw new TypeError("no value setter");
    setter.call(field, value);
  }

  function textField(el: Element): HTMLInputElement | HTMLTextAreaElement | undefined {
    const view = viewOf(el);
    return el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement
      ? el
      : undefined;
  }

  function textOf(el: HTMLElement): string {
    return textField(el)?.value ?? el.textContent ?? "";
  }

  function viewOf(el: Element): Window & typeof globalThis {
    const view = el.ownerDocument.defaultView;
    if (view === null) throw new TypeError("no window");
    listen(view);
    return view;
  }

  function submitted(mark: number, form: HTMLFormElement): boolean {
    return seenSince(mark, "submit").some((event) => event.target === form);
  }

  function saw(event: Event): boolean {
    return seen.includes(event);
  }

  function seenSince(mark: number, type: string): Event[] {
    return seen.slice(mark).filter((event) => event.type === type);
  }

  function siteInput(): HTMLInputElement | HTMLTextAreaElement | undefined {
    for (const el of document.querySelectorAll("input, textarea")) {
      if (inContainer(el) || !visible(el) || el.matches(":disabled") || isCredential(el)) continue;
      if (el instanceof HTMLTextAreaElement && !el.readOnly) return el;
      if (el instanceof HTMLInputElement && !el.readOnly && TEXT_TYPES.includes(el.type)) {
        return el;
      }
    }
    return undefined;
  }

  function isCredential(el: Element): boolean {
    const tokens = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    return tokens.some((token) => CREDENTIALS.includes(token));
  }

  function siteEditable(): HTMLElement | undefined {
    const editors = RICH_EDITORS.map(([selector]) => selector).join(", ");
    for (const el of document.querySelectorAll(
      '[contenteditable]:not([contenteditable="false"])',
    )) {
      if (!(el instanceof HTMLElement) || inContainer(el)) continue;
      if (el.isContentEditable && el.closest(editors) === null && visible(el)) return el;
    }
    return undefined;
  }

  function richEditor(): { el: HTMLElement; kind: string } | undefined {
    for (const [selector, kind] of RICH_EDITORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (!(el instanceof HTMLElement) || inContainer(el) || !visible(el)) continue;
        // A read-only render can carry an editor's class; Google Docs' frame is not editable.
        if (el.isContentEditable || kind === "google_docs") return { el, kind };
      }
    }
    return undefined;
  }

  function disclosureToggle(): HTMLElement | undefined {
    const candidates = document.querySelectorAll(
      'button[aria-expanded], [role="button"][aria-expanded]',
    );
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || inContainer(el) || !visible(el)) continue;
      if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") continue;
      if (["a", "input", "select", "textarea", "label", "summary"].includes(el.localName)) continue;
      if (el instanceof HTMLButtonElement && el.type !== "button" && el.form !== null) continue;
      if ((el.parentElement?.closest(CLICKABLE_ANCESTOR) ?? null) !== null) continue;
      return el;
    }
    return undefined;
  }

  function skipLink(): HTMLAnchorElement | undefined {
    const here = withoutFragment(location.href);
    for (const base of document.querySelectorAll("base[target]")) {
      if (base.getAttribute("target") !== "_self") return undefined;
    }
    for (const el of document.querySelectorAll('a[href^="#"]')) {
      if (!(el instanceof HTMLAnchorElement) || inContainer(el) || !visible(el)) continue;
      const fragment = (el.getAttribute("href") ?? "").slice(1);
      if (fragment === "" || !namesElement(fragment)) continue;
      if (withoutFragment(el.href) !== here) continue;
      const target = el.getAttribute("target");
      if (target !== null && target !== "_self") continue;
      if (el.hasAttribute("download") || el.hasAttribute("onclick")) continue;
      const role = el.getAttribute("role");
      if (role !== null && role !== "link") continue;
      return el;
    }
    return undefined;
  }

  function namesElement(fragment: string): boolean {
    if (document.getElementById(fragment) !== null) return true;
    return [...document.getElementsByName(fragment)].some((el) => el.localName === "a");
  }

  function visible(el: Element): boolean {
    return (
      el.checkVisibility({ visibilityProperty: true }) &&
      el.getClientRects().length > 0 &&
      el.closest('[aria-hidden="true"], [inert]') === null
    );
  }

  function inContainer(el: Element): boolean {
    return container.contains(el);
  }

  /** Tag, type, role, editor kind and up to three class names; nothing else from the page. */
  function describe(el: Element, editor?: string): string {
    const parts = [TAG.test(el.localName) ? el.localName : "custom"];
    const view = el.ownerDocument.defaultView;
    if (
      view !== null &&
      (el instanceof view.HTMLInputElement || el instanceof view.HTMLButtonElement)
    ) {
      parts.push(`type=${el.type}`);
    }
    const role = el.getAttribute("role");
    if (role !== null && ROLE.test(role)) parts.push(`role=${role}`);
    if (editor !== undefined) parts.push(`editor=${editor}`);
    const classes = [...el.classList].filter((name) => CLASS.test(name)).slice(0, 3);
    for (const name of classes) parts.push(`.${name}`);
    return parts.join(" ");
  }

  function markerOf(strategy: string): string {
    switch (strategy) {
      case "key_events":
        return "fxkeys";
      case "native_setter":
        return "fxsetter";
      case "beforeinput_dom":
        return "fxbeforeinput";
      default:
        return "fxexec";
    }
  }

  /** The site as `siteOf` in site.ts writes it: scheme, host without a trailing dot, port. */
  function siteOfLocation(where: Location): string {
    const host = where.hostname.endsWith(".") ? where.hostname.slice(0, -1) : where.hostname;
    return `${where.protocol}//${host}${where.port === "" ? "" : `:${where.port}`}`;
  }

  function withoutFragment(url: string): string {
    const index = url.indexOf("#");
    return index === -1 ? url : url.slice(0, index);
  }

  function errorName(error: unknown): string {
    try {
      const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
      return typeof name === "string" && ERROR_NAME.test(name) ? name : "an error";
    } catch {
      return "an error";
    }
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Whether the condition holds, at the latest after `ms`. */
  async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await wait(25);
    return condition();
  }
}

interface Outcome {
  outcome: ProbeOutcome;
  delivered: boolean;
  detail: string;
}
