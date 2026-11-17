import type { Timers } from "./browser-api.ts";

export interface PressHold {
  /**
   * Runs `update` now, or, while a primary pointer button is down, after its release; a later
   * update for the same `slot` replaces the held one.
   */
  run(slot: string, update: () => void): void;
}

/** Holds a page's updates while a primary pointer button is down on it. */
export function createPressHold<Handle>(page: EventTarget, timers: Timers<Handle>): PressHold {
  const pressed = new Set<number>();
  const held = new Map<string, () => void>();
  let flushPending = false;
  page.addEventListener("pointerdown", press, { capture: true });
  page.addEventListener("pointerup", release, { capture: true });
  page.addEventListener("pointercancel", release, { capture: true });
  // Not in the capture phase: there it would also get the blur of the element a press moves
  // focus away from, and end the hold at that press.
  page.addEventListener("blur", releaseAll);
  return {
    run: (slot, update) => {
      if (pressed.size === 0 && held.size === 0) update();
      else held.set(slot, update);
    },
  };

  function press(event: Event): void {
    const id = pointerIdOf(event);
    // The primary button only: after a secondary press on Linux, Firefox opens its context menu
    // and the page gets no pointerup. Only a primary press makes a click anyway.
    if (id !== undefined && "button" in event && event.button === 0) pressed.add(id);
  }

  function release(event: Event): void {
    const id = pointerIdOf(event);
    if (id !== undefined) pressed.delete(id);
    released();
  }

  function releaseAll(): void {
    pressed.clear();
    released();
  }

  function released(): void {
    if (pressed.size > 0 || held.size === 0 || flushPending) return;
    flushPending = true;
    // A later task: Firefox dispatches a release's pointerup, mouseup and click in one task, so
    // the click reaches the pressed button before a held update moves or replaces it.
    timers.setTimeout(flush, 0);
  }

  function flush(): void {
    flushPending = false;
    if (pressed.size > 0) return;
    const updates = [...held.values()];
    held.clear();
    for (const update of updates) update();
  }
}

function pointerIdOf(event: Event): number | undefined {
  return "pointerId" in event && typeof event.pointerId === "number" ? event.pointerId : undefined;
}
