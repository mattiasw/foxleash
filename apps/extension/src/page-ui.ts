import type { Timers } from "./browser-api.ts";
import { createArming } from "./prompt-arming.ts";

export type TextField = HTMLInputElement | HTMLTextAreaElement;

/** One thing to fix in a field; `line` and `column` count from 1, the column in code points. */
export interface FieldProblem<F extends string> {
  field: F;
  text: string;
  line?: number;
  column?: number;
}

export interface ArmedButtons {
  /** Marks the buttons as answering or not, from `asking()` and the arming. */
  renderButtons(): void;
  /** Starts arming, from when the question can be read. Call once. */
  watch(): void;
  /**
   * Disarms and arms again a full second from now, after `watch`, so a click meant for what the
   * page showed before does not answer what it shows now.
   */
  rearm(): void;
}

/** What a refused key press on an answer button says; focus has gone back before the buttons. */
export const REFOCUS =
  "Not answered. Wait a second, then use Tab to move to the button and press it.";

// The UI Events modifier key values; pressing one while armed keeps the page armed.
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

// Each live region's latest announcement, written to it on the next frame.
const messages = new Map<HTMLElement, string>();

export function element(id: string, page: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The ${page} has no #${id}.`);
  return found;
}

/** Clears the live region first, so a repeated message is announced again. */
export function announce(region: HTMLElement, text: string): void {
  messages.set(region, text);
  region.textContent = "";
  if (text !== "") {
    requestAnimationFrame(() => {
      region.textContent = messages.get(region) ?? "";
    });
  }
}

/** The region's latest announcement, written or not yet. */
export function announced(region: HTMLElement): string {
  return messages.get(region) ?? "";
}

/** A message's own fields, or undefined when it is not an object. */
export function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return { ...value };
}

/**
 * Wires answer buttons that respond only to the user's own single click, while `asking()` and
 * armed. A pointer press counts only when it started armed.
 *
 * An Enter or Space answers only at the end of an armed Tab path from before the buttons: once
 * armed, with only Tab, Shift+Tab and modifier keydowns since, focus moved from an element before
 * the buttons onto the first button and on from button to neighbouring button. A button's focus
 * counts only when it arrives that way while armed; a focus from no element, from after the
 * buttons, or from a button whose focus did not count never counts (ADR 0061). Every other
 * Enter or Space keydown on an answer button while asking is refused: no click, the arming second
 * starts again, focus goes back to `rest()` and `onUnarmed("refocus")` is called. A refused click
 * calls `onUnarmed("arming")`. An answer starts the arming second again. Any keydown in the page while unarmed, and while armed any key but
 * a modifier, Tab while no counted Space is down, or a counted Enter or Space and that Space's
 * repeats, starts the arming second again.
 * `aria-disabled`, not `disabled`, keeps the buttons focusable.
 */
export function armButtons<Handle>(options: {
  buttons: readonly HTMLButtonElement[];
  timers: Timers<Handle>;
  asking(): boolean;
  onAnswer(button: HTMLButtonElement): void;
  onUnarmed(reason: "arming" | "refocus"): void;
  /** Where focus goes after a refused key press: before the buttons, not reached by Tab. */
  rest(): HTMLElement;
}): ArmedButtons {
  const { buttons, timers, asking, onAnswer, onUnarmed, rest } = options;
  // The answer button whose focus counts: reached along an armed Tab path, in the current arming.
  let armedFocus: HTMLButtonElement | undefined;
  // Whether the press that starts the coming click happened while armed; undefined without one.
  let pressArmed: boolean | undefined;
  // The answer button a counted Space went down on, until its keyup or a disarm.
  let spacePress: HTMLButtonElement | undefined;
  const arming = createArming(timers, (armed) => {
    if (!armed) {
      armedFocus = undefined;
      spacePress = undefined;
    }
    renderButtons();
  });

  for (const button of buttons) {
    // Firefox fires focus again on the focused button when its window or tab comes back, unarmed,
    // and from no element.
    button.addEventListener("focus", (event) => {
      armedFocus = arming.armed() && countsFrom(event.relatedTarget, button) ? button : undefined;
    });
    // Fires when the press starts, also for touch and pen, whose mousedown comes after the tap.
    button.addEventListener("pointerdown", () => {
      pressArmed = arming.armed();
    });
    // Firefox clicks the button at the end of a Space keyup when any Space keydown reached it,
    // also a repeat of a Space that went down elsewhere, and also after a click in between.
    button.addEventListener("keyup", (event) => {
      if (!isSpace(event)) return;
      pressArmed = spacePress === button;
      spacePress = undefined;
    });
    button.addEventListener("click", (event) => onClick(event, button));
  }

  return { renderButtons, watch, rearm };

  function countsFrom(from: EventTarget | null, button: HTMLButtonElement): boolean {
    const index = buttons.indexOf(button);
    if (armedFocus !== undefined && from === armedFocus) {
      return Math.abs(buttons.indexOf(armedFocus) - index) === 1;
    }
    if (index !== 0 || !(from instanceof Node) || buttons.some((other) => other === from)) {
      return false;
    }
    const position = from.compareDocumentPosition(button);
    return (
      (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
      (position & (Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_DISCONNECTED)) === 0
    );
  }

  function renderButtons(): void {
    const enabled = asking() && arming.armed();
    for (const button of buttons) {
      if (enabled) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
    }
  }

  function onClick(event: MouseEvent, button: HTMLButtonElement): void {
    const pressed = pressArmed;
    pressArmed = undefined;
    // Only the user's own click answers, and not the second click of a double click.
    if (!event.isTrusted || event.detail > 1 || !asking()) return;
    if (!arming.armed() || pressed === false) {
      onUnarmed("arming");
      return;
    }
    // An answer ends the Tab path and starts the second again: if the page asks again, a key
    // answers only along a new path after a pause.
    restartDelay();
    onAnswer(button);
  }

  function watch(): void {
    arming.visible(document.visibilityState === "visible");
    arming.focused(document.hasFocus());
    document.addEventListener("visibilitychange", () => {
      arming.visible(document.visibilityState === "visible");
    });
    window.addEventListener("focus", () => arming.focused(true));
    window.addEventListener("blur", () => arming.focused(false));
    // Capture, so every keydown in the page is seen before it reaches its target. Typing keeps the
    // page unarmed until it stops for a second, also once armed.
    window.addEventListener("keydown", onKeydown, { capture: true });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (isSpace(event) && !event.repeat) spacePress = undefined;
    const button = isPress(event)
      ? buttons.find((candidate) => candidate === event.target)
      : undefined;
    if (button !== undefined && event.repeat) {
      // A held key is one press. Enter clicks at keypress, so a reply that returns the page to
      // asking before a repeat's keypress must not get a click.
      if (isSpace(event) && spacePress === button) return;
      event.preventDefault();
      restartDelay();
      return;
    }
    if (button !== undefined && asking()) {
      if (arming.armed() && armedFocus === button) {
        if (isSpace(event)) spacePress = button;
        else pressArmed = true;
      } else {
        refuse(event);
      }
      return;
    }
    const keeps = event.key === "Tab" ? spacePress === undefined : MODIFIER_KEYS.has(event.key);
    if (!arming.armed() || !keeps) restartDelay();
  }

  function refuse(event: KeyboardEvent): void {
    // Measured in Firefox: no click follows, also at a Space keyup.
    event.preventDefault();
    pressArmed = undefined;
    restartDelay();
    rest().focus();
    onUnarmed("refocus");
  }

  function rearm(): void {
    // A press already under way began before what the page shows now.
    if (pressArmed !== undefined) pressArmed = false;
    restartDelay();
  }

  function restartDelay(): void {
    arming.focused(false);
    arming.focused(document.hasFocus());
  }
}

function isPress(event: KeyboardEvent): boolean {
  return event.key === "Enter" || isSpace(event);
}

// Firefox clicks a focused button on the Space key's keyup also when the layout types another
// character with it, so Space counts by its code too.
function isSpace(event: KeyboardEvent): boolean {
  return event.key === " " || event.code === "Space";
}

/**
 * Marks each invalid field, focuses the first and selects what its first problem points at;
 * returns how many fields are invalid. Announcing stays with the caller.
 */
export function showProblems<F extends string>(
  fields: Record<F, { field: TextField; errors: HTMLElement }>,
  order: readonly F[],
  problems: readonly FieldProblem<F>[],
): number {
  const invalid = order.filter((name) => problems.some(({ field }) => field === name));
  for (const name of invalid) {
    const { field, errors } = fields[name];
    const texts = problems.filter((problem) => problem.field === name).map(({ text }) => text);
    showErrors(field, errors, texts);
  }
  const first = invalid[0];
  if (first !== undefined) {
    const { field } = fields[first];
    field.focus();
    const at = problems.find(
      (problem) =>
        problem.field === first && (problem.line !== undefined || problem.column !== undefined),
    );
    if (at?.column !== undefined) selectCharacter(field, at.line ?? 1, at.column);
    else if (at?.line !== undefined) selectLine(field, at.line);
  }
  return invalid.length;
}

/** Lists `texts` under the field and marks it invalid; focus and announcing stay with the caller. */
export function showErrors(field: TextField, errors: HTMLElement, texts: string[]): void {
  errors.replaceChildren(
    ...texts.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
  errors.hidden = false;
  field.setAttribute("aria-invalid", "true");
}

/** Selects the character at `column` of line `line`, both counted from 1, in code points. */
export function selectCharacter(field: TextField, line: number, column: number): void {
  const lines = field.value.split("\n");
  let offset = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  let position = 1;
  for (const character of lines[line - 1] ?? "") {
    if (position === column) {
      field.setSelectionRange(offset, offset + character.length);
      return;
    }
    offset += character.length;
    position += 1;
  }
}

/** Selects line `line`, counted from 1; a textarea's value separates lines with "\n" only. */
export function selectLine(field: TextField, line: number): void {
  const lines = field.value.split("\n");
  const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  field.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
}

export function clearErrors(field: TextField, errors: HTMLElement): void {
  errors.replaceChildren();
  errors.hidden = true;
  field.removeAttribute("aria-invalid");
}
