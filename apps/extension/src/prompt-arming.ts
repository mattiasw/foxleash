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

/** What an input event means for the arming: "restart" starts the second again; "hold" disarms until the next event. */
export type KeyEffect = "none" | "restart" | "hold";

export interface KeyWatch {
  keydown(key: string, code: string): KeyEffect;
  /** `keeps`: the key is one whose keydown can leave an armed page armed (Tab, Space, a modifier). */
  keyup(key: string, code: string, keeps: boolean): KeyEffect;
  /** A pointer press, or a click, which a screen reader's own activation sends without one. */
  press(): KeyEffect;
  blur(): void;
  held(): boolean;
}

/**
 * Tells which key and pointer events start the arming second again, and holds it after a lone
 * Alt: on Linux that opens Firefox's menu bar, which takes the keys after it without a blur and
 * lets the page see only keyups once it lets go (ADR 0063). A hold lasts until the next key or
 * press the page sees; a keyup restarts unless the page saw its Tab, Space or non-Alt modifier
 * go down since the last blur.
 */
export function createKeyWatch(): KeyWatch {
  const down = new Set<string>();
  let altAlone = false;
  let isHeld = false;

  return {
    keydown: (key, code) => {
      const effect = release();
      down.add(keyId(key, code));
      altAlone = key === "Alt";
      return effect;
    },
    keyup: (key, code, keeps) => {
      const seen = down.delete(keyId(key, code));
      const quiet = seen && keeps && key !== "Alt";
      const effect = release() === "restart" || !quiet ? "restart" : "none";
      if (key !== "Alt" || !altAlone) return effect;
      altAlone = false;
      isHeld = true;
      return "hold";
    },
    press: () => {
      altAlone = false;
      return release();
    },
    blur: () => {
      down.clear();
      altAlone = false;
    },
    held: () => isHeld,
  };

  function release(): KeyEffect {
    if (!isHeld) return "none";
    isHeld = false;
    return "restart";
  }
}

// Prefixed, so a keydown without a code never matches a keyup's code of the same name.
function keyId(key: string, code: string): string {
  return code === "" ? `k:${key}` : `c:${code}`;
}
