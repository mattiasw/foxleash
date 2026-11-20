import type { Timers } from "./browser-api.ts";

/** How long the prompt must be visible and focused before its buttons answer. */
export const ARMING_DELAY_MS = 1000;

/** How long after the input that opens a Firefox menu a keydown can still reach the page before the menu takes the keyboard. */
export const HOLD_JOIN_MS = 100;

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
  /** `chord`: a key other than a modifier, pressed with Alt and without Control or Meta. */
  keydown(key: string, code: string, chord: boolean): KeyEffect;
  /** `keeps`: the key is one whose keydown can leave an armed page armed (Tab, Space, a modifier). */
  keyup(key: string, code: string, keeps: boolean): KeyEffect;
  /** A pointer press; `secondary`: with the secondary (right) button, which opens a context menu. */
  press(secondary: boolean): KeyEffect;
  /** A click, which a screen reader's own activation sends without a pointer press. */
  click(): KeyEffect;
  /** A `contextmenu` event, which Firefox fires in the page before it shows a context menu. */
  contextmenu(): KeyEffect;
  blur(): void;
  held(): boolean;
}

/**
 * Tells which key and pointer events start the arming second again, and holds it after input that
 * can open a Firefox menu, which takes the keys after it without a blur and lets the page see only
 * some keyups once it lets go (ADR 0057). A hold starts at a lone Alt, at an Alt keyup it
 * did not see go down while fresh (no keydown or pointer press since creation or the last blur), at
 * an F10, Menu-key or Alt-chord keydown, at a secondary press and at a `contextmenu`; it forgets
 * the keys seen going down. It ends at the next primary press, click, keydown that neither starts
 * nor joins one, or keyup it does not keep. A keydown joins it, and a keyup keeps it, when it comes
 * less than `HOLD_JOIN_MS` after the trigger that started or last joined it, as `now` tells; a
 * keydown also when it repeats a key that opened the hold, and a keyup also when it is an Alt's,
 * that of a key that joined, or that of a key seen going down before an F10, Menu-key, chord,
 * secondary-press or contextmenu hold started or joined. Outside a hold a keyup restarts unless the
 * page saw its Tab, Space or non-Alt modifier go down since the last blur or hold.
 */
export function createKeyWatch(now: () => number): KeyWatch {
  const down = new Set<string>();
  // The keys the page saw go down before an F10, Menu-key, chord, secondary-press or contextmenu
  // hold started or joined, and the keys that joined it; their keyups keep it.
  const opening = new Set<string>();
  let altAlone = false;
  let fresh = true;
  let isHeld = false;
  // When the trigger that started or last joined the hold came; a keydown joining by the window
  // does not move it, so a stream of fast keys cannot keep the window open.
  let triggeredAt = 0;

  return {
    keydown: (key, code, chord) => {
      const id = keyId(key, code);
      // A repeat of a key that opened the hold, such as a Shift held through a right-click, joins
      // it, and so does a key pressed before the menu could take the keyboard.
      const joins = isHeld && (opening.has(id) || now() - triggeredAt < HOLD_JOIN_MS);
      down.add(id);
      altAlone = key === "Alt";
      fresh = false;
      if (key === "F10" || key === "ContextMenu" || chord) return trigger();
      return joins ? hold() : release();
    },
    keyup: (key, code, keeps) => {
      const id = keyId(key, code);
      const seen = down.delete(id);
      // Firefox opens the menu bar also at an Alt pressed before the page had focus.
      const alone = key === "Alt" && (altAlone || (!seen && fresh));
      if (key === "Alt") altAlone = false;
      // A key held through the trigger can come up before the menu takes the keyboard, also one
      // whose keydown the page did not see or has forgotten.
      if (isHeld && (key === "Alt" || opening.delete(id) || now() - triggeredAt < HOLD_JOIN_MS)) {
        return "none";
      }
      const quiet = seen && keeps && key !== "Alt";
      const effect = release() === "restart" || !quiet ? "restart" : "none";
      if (!alone) return effect;
      isHeld = true;
      down.clear();
      triggeredAt = now();
      return "hold";
    },
    press: (secondary) => {
      altAlone = false;
      fresh = false;
      return secondary ? trigger() : release();
    },
    // Firefox opens the menu bar also at an Alt with a click and no pointer press in between.
    click: () => release(),
    contextmenu: () => trigger(),
    blur: () => {
      down.clear();
      altAlone = false;
      fresh = true;
    },
    held: () => isHeld,
  };

  // Starts a hold, or joins the current one, and opens the window in which a keydown joins it and
  // a keyup keeps it.
  function trigger(): KeyEffect {
    triggeredAt = now();
    return hold();
  }

  // Starts a hold, or joins the current one, keeping the keys already down for their keyups.
  function hold(): KeyEffect {
    isHeld = true;
    for (const id of down) opening.add(id);
    down.clear();
    return "hold";
  }

  function release(): KeyEffect {
    if (!isHeld) return "none";
    isHeld = false;
    opening.clear();
    return "restart";
  }
}

// Prefixed, so a keydown without a code never matches a keyup's code of the same name.
function keyId(key: string, code: string): string {
  return code === "" ? `k:${key}` : `c:${code}`;
}
