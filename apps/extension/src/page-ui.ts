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

/** What a key press on an answer button says when its focus came before the buttons armed. */
export const REFOCUS =
  "Move to the button beside it and back with Shift+Tab and Tab, then press it.";

// The UI Events modifier key values; pressing one between a focus and a press keeps the focus.
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
 * armed. A press counts only when it started armed, and an Enter or Space press only on a button
 * that got focus in the current arming with no other key pressed since. The click Firefox makes
 * on a Space keyup counts only as the press of a Space that went down on that button in the
 * current arming. Any other click while asking calls `onUnarmed`, with `"refocus"` when only the
 * button's focus refused it and `"arming"` otherwise. Any keydown in the page while unarmed, and
 * while armed any key but Tab, a modifier, or Enter or Space on an answer button, starts the
 * arming second again. `aria-disabled`, not `disabled`, keeps the buttons focusable.
 */
export function armButtons<Handle>(options: {
  buttons: readonly HTMLButtonElement[];
  timers: Timers<Handle>;
  asking(): boolean;
  onAnswer(button: HTMLButtonElement): void;
  onUnarmed(reason: "arming" | "refocus"): void;
}): ArmedButtons {
  const { buttons, timers, asking, onAnswer, onUnarmed } = options;
  // The answer button that got focus while armed, in the current arming.
  let armedFocus: HTMLButtonElement | undefined;
  // Whether the press that starts the coming click happened while armed; undefined without one.
  let pressArmed: boolean | undefined;
  // Whether that press was a key press refused only because its button's focus did not count.
  let pressRefocus = false;
  // What the page's last Space keydown that was not a repeat recorded, when it went down on an
  // answer button in the current arming.
  let spacePress: { button: HTMLButtonElement; armed: boolean; refocus: boolean } | undefined;
  const arming = createArming(timers, (armed) => {
    if (!armed) {
      armedFocus = undefined;
      spacePress = undefined;
    }
    renderButtons();
  });

  for (const button of buttons) {
    // Firefox fires focus again on the focused button when its window or tab comes back, unarmed.
    button.addEventListener("focus", () => {
      armedFocus = arming.armed() ? button : undefined;
    });
    // Fires when the press starts, also for touch and pen, whose mousedown comes after the tap.
    button.addEventListener("pointerdown", () => {
      pressArmed = arming.armed();
      pressRefocus = false;
    });
    button.addEventListener("keydown", (event) => {
      // A held key is one press, started when it went down. A held Enter would also answer
      // again as soon as the buttons re-arm.
      if (event.repeat) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      // Only the keys that click a button, and only on a button focused in the current arming:
      // Tab moving focus on is no press.
      if (isPress(event)) {
        pressArmed = arming.armed() && armedFocus === button;
        pressRefocus = arming.armed() && armedFocus !== button;
        if (isSpace(event)) spacePress = { button, armed: pressArmed, refocus: pressRefocus };
      }
    });
    // Firefox clicks the button at the end of a Space keyup when any Space keydown reached it,
    // also a repeat of a Space that went down elsewhere, and also after a click in between.
    button.addEventListener("keyup", (event) => {
      if (!isSpace(event)) return;
      const press = spacePress?.button === button ? spacePress : undefined;
      spacePress = undefined;
      pressArmed = press?.armed ?? false;
      pressRefocus = press?.refocus ?? false;
    });
    button.addEventListener("click", (event) => onClick(event, button));
  }

  return { renderButtons, watch, rearm };

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
    const refocus = pressRefocus;
    pressRefocus = false;
    // Only the user's own click answers, and not the second click of a double click.
    if (!event.isTrusted || event.detail > 1 || !asking()) return;
    if (!arming.armed() || pressed === false) {
      onUnarmed(arming.armed() && refocus ? "refocus" : "arming");
      return;
    }
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
    // Capture runs before the button's own keydown. Typing keeps the page unarmed until it stops
    // for a second, also once armed; Tab there only voids the focus it moves away from.
    window.addEventListener(
      "keydown",
      (event) => {
        if (isSpace(event) && !event.repeat) spacePress = undefined;
        const pressOnButton = isPress(event) && buttons.some((button) => button === event.target);
        if (!arming.armed()) restartDelay();
        else if (event.key === "Tab") armedFocus = undefined;
        else if (!pressOnButton && !MODIFIER_KEYS.has(event.key)) restartDelay();
      },
      { capture: true },
    );
  }

  function rearm(): void {
    // A press already under way began before what the page shows now.
    if (pressArmed !== undefined) pressArmed = false;
    pressRefocus = false;
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
