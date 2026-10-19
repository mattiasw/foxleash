import type { Timers } from "./browser-api.ts";

/** How long the prompt must be visible and focused before its buttons answer. */
export const ARMING_DELAY_MS = 1000;

export interface Arming {
  visible(visible: boolean): void;
  focused(focused: boolean): void;
  armed(): boolean;
}

/**
 * Arms one full second after the page is both visible and focused, and disarms at once when
 * either ends, so a click aimed at another window cannot land on a button that just appeared.
 * `onChange` runs on each change of `armed()`.
 */
export function createArming<Handle>(
  timers: Timers<Handle>,
  onChange: (armed: boolean) => void,
): Arming {
  let isVisible = false;
  let isFocused = false;
  let isArmed = false;
  let timer: Handle | undefined;

  return {
    visible: (visible) => {
      isVisible = visible;
      update();
    },
    focused: (focused) => {
      isFocused = focused;
      update();
    },
    armed: () => isArmed,
  };

  function update(): void {
    if (isVisible && isFocused) {
      if (isArmed || timer !== undefined) return;
      timer = timers.setTimeout(() => {
        timer = undefined;
        isArmed = true;
        onChange(true);
      }, ARMING_DELAY_MS);
      return;
    }
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
    if (isArmed) {
      isArmed = false;
      onChange(false);
    }
  }
}
