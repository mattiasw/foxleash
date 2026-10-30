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
 * armed; any other click while asking calls `onUnarmed`. `aria-disabled`, not `disabled`, keeps
 * the buttons focusable.
 */
export function armButtons<Handle>(options: {
  buttons: readonly HTMLButtonElement[];
  timers: Timers<Handle>;
  asking(): boolean;
  onAnswer(button: HTMLButtonElement): void;
  onUnarmed(): void;
}): ArmedButtons {
  const { buttons, timers, asking, onAnswer, onUnarmed } = options;
  const arming = createArming(timers, renderButtons);
  // Whether the press that starts the coming click happened while armed; undefined without one.
  let pressArmed: boolean | undefined;

  for (const button of buttons) {
    // Fires when the press starts, also for touch and pen, whose mousedown comes after the tap.
    button.addEventListener("pointerdown", () => {
      pressArmed = arming.armed();
    });
    button.addEventListener("keydown", (event) => {
      // A held key is one press, started when it went down. A held Enter would also answer
      // again as soon as the buttons re-arm.
      if (event.repeat) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      // Only the keys that click a button; Tab moving focus on is no press.
      if (event.key === "Enter" || event.key === " ") pressArmed = arming.armed();
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
    // Only the user's own click answers, and not the second click of a double click.
    if (!event.isTrusted || event.detail > 1 || !asking()) return;
    if (!arming.armed() || pressed === false) {
      onUnarmed();
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
  }

  function rearm(): void {
    // A press already under way began before what the page shows now.
    if (pressArmed !== undefined) pressArmed = false;
    arming.focused(false);
    arming.focused(document.hasFocus());
  }
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
