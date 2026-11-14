import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeTimers } from "./fake-browser.ts";
import {
  ARMING_DELAY_MS,
  createArming,
  createKeyWatch,
  HOLD_JOIN_MS,
  type KeyWatch,
} from "./prompt-arming.ts";

describe("createArming", () => {
  it("arms one full second after the page is visible and focused", () => {
    const { arming, timers, changes } = setup();
    assert.equal(arming.armed(), false);
    arming.visible(true);
    arming.focused(true);
    timers.advance(ARMING_DELAY_MS - 1);
    assert.equal(arming.armed(), false);
    assert.deepEqual(changes, []);
    timers.advance(1);
    assert.equal(arming.armed(), true);
    assert.deepEqual(changes, [true]);
  });

  it("arms whichever of visible and focused comes first", () => {
    const { arming, timers } = setup();
    arming.focused(true);
    timers.advance(ARMING_DELAY_MS * 2);
    assert.equal(arming.armed(), false);
    arming.visible(true);
    timers.advance(ARMING_DELAY_MS);
    assert.equal(arming.armed(), true);
  });

  it("starts neither visible nor focused", () => {
    const { arming, timers } = setup();
    arming.visible(true);
    timers.advance(ARMING_DELAY_MS * 2);
    assert.equal(arming.armed(), false);
    assert.equal(timers.pending(), 0);
  });

  it("disarms at once when the page is hidden or loses focus", () => {
    for (const lose of ["visible", "focused"] as const) {
      const { arming, timers, changes } = setup();
      arming.visible(true);
      arming.focused(true);
      timers.advance(ARMING_DELAY_MS);
      arming[lose](false);
      assert.equal(arming.armed(), false, lose);
      assert.deepEqual(changes, [true, false], lose);
    }
  });

  it("re-arms only a new full second after the page is back", () => {
    const { arming, timers, changes } = setup();
    arming.visible(true);
    arming.focused(true);
    timers.advance(ARMING_DELAY_MS);
    arming.focused(false);
    arming.focused(true);
    timers.advance(ARMING_DELAY_MS - 1);
    assert.equal(arming.armed(), false);
    timers.advance(1);
    assert.equal(arming.armed(), true);
    assert.deepEqual(changes, [true, false, true]);
  });

  it("stops the clock when the page is left before it arms", () => {
    const { arming, timers, changes } = setup();
    arming.visible(true);
    arming.focused(true);
    timers.advance(ARMING_DELAY_MS - 1);
    arming.visible(false);
    assert.equal(timers.pending(), 0);
    arming.visible(true);
    timers.advance(ARMING_DELAY_MS - 1);
    assert.equal(arming.armed(), false);
    timers.advance(1);
    assert.equal(arming.armed(), true);
    assert.deepEqual(changes, [true]);
  });

  it("neither restarts the clock nor disarms on a repeated true", () => {
    const { arming, timers, changes } = setup();
    arming.visible(true);
    arming.focused(true);
    timers.advance(ARMING_DELAY_MS - 1);
    arming.focused(true);
    arming.visible(true);
    assert.equal(timers.pending(), 1);
    timers.advance(1);
    assert.equal(arming.armed(), true);
    arming.focused(true);
    arming.visible(true);
    assert.equal(arming.armed(), true);
    assert.equal(timers.pending(), 0);
    assert.deepEqual(changes, [true]);
  });

  it("reports no change for a repeated false", () => {
    const { arming, changes } = setup();
    arming.visible(false);
    arming.focused(false);
    assert.deepEqual(changes, []);
  });
});

describe("createKeyWatch", () => {
  it("holds at the keyup of a lone Alt", () => {
    const keys = createKeyWatch(slowClock());
    assert.equal(keys.held(), false);
    assert.equal(keys.keydown("Alt", "AltLeft", false), "none");
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.held(), true);
  });

  it("holds after an Alt held down long enough to repeat", () => {
    const keys = createKeyWatch(slowClock());
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.equal(keys.keydown("Alt", "AltLeft", false), "none");
    }
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.held(), true);
  });

  it("restarts, and does not hold, at an Alt with a key or a pointer press in between", () => {
    const between = {
      key: (keys: KeyWatch) => keys.keydown("Tab", "Tab", false),
      press: (keys: KeyWatch) => keys.press(false),
    };
    for (const [name, step] of Object.entries(between)) {
      const keys = createKeyWatch(slowClock());
      keys.keydown("Alt", "AltLeft", false);
      step(keys);
      assert.equal(keys.keyup("Alt", "AltLeft", true), "restart", name);
      assert.equal(keys.held(), false, name);
    }
  });

  it("does not hold at an Alt with Shift pressed and released in between", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Alt", "AltLeft", false);
    keys.keydown("Shift", "ShiftLeft", false);
    assert.equal(keys.keyup("Shift", "ShiftLeft", true), "none");
    assert.equal(keys.keyup("Alt", "AltLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("holds at an Alt keyup it did not see go down only before any keydown or pointer press", () => {
    const fresh = createKeyWatch(slowClock());
    assert.equal(fresh.keyup("Escape", "Escape", false), "restart");
    assert.equal(fresh.click(), "none");
    assert.equal(fresh.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(fresh.held(), true);
    const before = {
      keydown: (keys: KeyWatch) => keys.keydown("q", "KeyQ", false),
      press: (keys: KeyWatch) => keys.press(false),
    };
    for (const [name, step] of Object.entries(before)) {
      const keys = createKeyWatch(slowClock());
      step(keys);
      assert.equal(keys.keyup("Alt", "AltLeft", true), "restart", name);
      assert.equal(keys.held(), false, name);
      keys.blur();
      assert.equal(keys.keyup("Alt", "AltRight", true), "hold", `${name}, then a blur`);
      assert.equal(keys.held(), true, `${name}, then a blur`);
    }
    const alt = createKeyWatch(slowClock());
    alt.keydown("Alt", "AltLeft", false);
    alt.blur();
    assert.equal(alt.keyup("Alt", "AltLeft", true), "hold");
  });

  it("ends a hold at the first key, keyup or press after it, and only there", () => {
    const releases = {
      keydown: (keys: KeyWatch) => keys.keydown("q", "KeyQ", false),
      "unseen keyup": (keys: KeyWatch) => keys.keyup("Escape", "Escape", false),
      press: (keys: KeyWatch) => keys.press(false),
      click: (keys: KeyWatch) => keys.click(),
    };
    for (const [name, release] of Object.entries(releases)) {
      const keys = createKeyWatch(slowClock());
      keys.keydown("Alt", "AltLeft", false);
      keys.keyup("Alt", "AltLeft", true);
      assert.equal(release(keys), "restart", name);
      assert.equal(keys.held(), false, name);
      assert.equal(keys.press(false), "none", name);
    }
  });

  it("ends a hold at the keyup of a modifier that went down before it", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Shift", "ShiftLeft", false);
    keys.keydown("Alt", "AltLeft", false);
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.keyup("Shift", "ShiftLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("lets the keyup of the Tab that ended a hold leave the second running", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Alt", "AltLeft", false);
    keys.keyup("Alt", "AltLeft", true);
    assert.equal(keys.keydown("Tab", "Tab", false), "restart");
    assert.equal(keys.held(), false);
    assert.equal(keys.keyup("Tab", "Tab", true), "none");
  });

  it("does not hold again at a second Alt keyup after a hold ended", () => {
    const releases = {
      "unseen keyup": (keys: KeyWatch) => keys.keyup("Escape", "Escape", false),
      click: (keys: KeyWatch) => keys.click(),
    };
    for (const [name, release] of Object.entries(releases)) {
      const keys = createKeyWatch(slowClock());
      keys.keydown("Alt", "AltLeft", false);
      keys.keyup("Alt", "AltLeft", true);
      assert.equal(release(keys), "restart", name);
      assert.equal(keys.keyup("Alt", "AltLeft", true), "restart", name);
      assert.equal(keys.held(), false, name);
    }
  });

  it("leaves the second running only at the keyup of a Tab, Space or modifier it saw go down", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Tab", "Tab", false);
    assert.equal(keys.keyup("Tab", "Tab", true), "none");
    assert.equal(keys.keyup("Tab", "Tab", true), "restart");
    keys.keydown("q", "KeyQ", false);
    assert.equal(keys.keyup("q", "KeyQ", false), "restart");
    assert.equal(keys.keyup("Escape", "Escape", false), "restart");
    assert.equal(keys.held(), false);
  });

  it("forgets the keys that went down before a blur", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Tab", "Tab", false);
    keys.blur();
    assert.equal(keys.keyup("Tab", "Tab", true), "restart");
  });

  it("keeps a hold across a blur", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Alt", "AltLeft", false);
    keys.keyup("Alt", "AltLeft", true);
    keys.blur();
    assert.equal(keys.held(), true);
    assert.equal(keys.keydown("Tab", "Tab", false), "restart");
    assert.equal(keys.held(), false);
  });

  it("matches a keyup to its keydown by code, or by key when there is no code", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("a", "KeyA", false);
    assert.equal(keys.keyup("A", "KeyA", true), "none");
    keys.keydown("a", "", false);
    assert.equal(keys.keyup("b", "", true), "restart");
    assert.equal(keys.keyup("a", "", true), "none");
    keys.keydown("Tab", "", false);
    assert.equal(keys.keyup("Tab", "Tab", true), "restart");
  });

  it("does nothing at a press or a click while not held", () => {
    const keys = createKeyWatch(slowClock());
    assert.equal(keys.press(false), "none");
    assert.equal(keys.click(), "none");
    assert.equal(keys.held(), false);
  });

  it("holds at each input that can open a Firefox menu, and not at a plain key or press", () => {
    const opens = {
      F10: (keys: KeyWatch) => keys.keydown("F10", "F10", false),
      "Menu key": (keys: KeyWatch) => keys.keydown("ContextMenu", "ContextMenu", false),
      "Alt chord": (keys: KeyWatch) => keys.keydown("v", "KeyV", true),
      contextmenu: (keys: KeyWatch) => keys.contextmenu(),
      "secondary press": (keys: KeyWatch) => keys.press(true),
    };
    for (const [name, open] of Object.entries(opens)) {
      const keys = createKeyWatch(slowClock());
      assert.equal(open(keys), "hold", name);
      assert.equal(keys.held(), true, name);
      assert.equal(keys.keyup("Escape", "Escape", false), "restart", name);
      assert.equal(keys.held(), false, name);
    }
    const keys = createKeyWatch(slowClock());
    assert.equal(keys.keydown("v", "KeyV", false), "none");
    assert.equal(keys.press(false), "none");
    assert.equal(keys.held(), false);
  });

  it("keeps a hold at the keyups of the keys that opened it, and ends it at other input", () => {
    const chord = createKeyWatch(slowClock());
    chord.keydown("Alt", "AltLeft", false);
    assert.equal(chord.keydown("v", "KeyV", true), "hold");
    assert.equal(chord.keyup("v", "KeyV", false), "none");
    assert.equal(chord.keyup("Alt", "AltLeft", true), "none");
    assert.equal(chord.held(), true);

    const releases = {
      keydown: (keys: KeyWatch) => keys.keydown("q", "KeyQ", false),
      "unseen keyup": (keys: KeyWatch) => keys.keyup("Escape", "Escape", false),
      "keyup of the chord's key again": (keys: KeyWatch) => keys.keyup("v", "KeyV", false),
      press: (keys: KeyWatch) => keys.press(false),
      click: (keys: KeyWatch) => keys.click(),
    };
    for (const [name, release] of Object.entries(releases)) {
      const keys = createKeyWatch(slowClock());
      keys.keydown("Alt", "AltLeft", false);
      keys.keydown("v", "KeyV", true);
      keys.keyup("v", "KeyV", false);
      assert.equal(release(keys), "restart", name);
      assert.equal(keys.held(), false, name);
    }

    const shiftF10 = createKeyWatch(slowClock());
    shiftF10.keydown("Shift", "ShiftLeft", false);
    assert.equal(shiftF10.keydown("F10", "F10", false), "hold");
    assert.equal(shiftF10.keydown("F10", "F10", false), "hold");
    assert.equal(shiftF10.contextmenu(), "hold");
    assert.equal(shiftF10.keyup("F10", "F10", false), "none");
    assert.equal(shiftF10.keyup("Shift", "ShiftLeft", true), "none");
    assert.equal(shiftF10.held(), true);
    assert.equal(shiftF10.keyup("Shift", "ShiftLeft", true), "restart");
    assert.equal(shiftF10.held(), false);

    const rightClicks = {
      contextmenu: (keys: KeyWatch) => keys.contextmenu(),
      "secondary press": (keys: KeyWatch) => keys.press(true),
    };
    for (const [name, open] of Object.entries(rightClicks)) {
      const keys = createKeyWatch(slowClock());
      keys.keydown("Shift", "ShiftLeft", false);
      open(keys);
      assert.equal(keys.keyup("Shift", "ShiftLeft", true), "none", name);
      assert.equal(keys.held(), true, name);
    }
  });

  it("keeps a hold at a repeat of a key that opened it", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Shift", "ShiftLeft", false);
    keys.press(true);
    assert.equal(keys.keydown("Shift", "ShiftLeft", false), "hold");
    assert.equal(keys.contextmenu(), "hold");
    assert.equal(keys.keyup("Shift", "ShiftLeft", true), "none");
    assert.equal(keys.held(), true);
    assert.equal(keys.keydown("Shift", "ShiftLeft", false), "restart");
    assert.equal(keys.held(), false);
  });

  it("joins a hold at a menu-opening input while held, keeping the keys that opened it", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Alt", "AltLeft", false);
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.keydown("F10", "F10", false), "hold");
    assert.equal(keys.held(), true);
    assert.equal(keys.keyup("F10", "F10", false), "none");
    assert.equal(keys.held(), true);
  });

  it("does not keep a later hold at the keyup of a key that opened an ended one", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Shift", "ShiftLeft", false);
    keys.keydown("F10", "F10", false);
    assert.equal(keys.keydown("q", "KeyQ", false), "restart");
    assert.equal(keys.contextmenu(), "hold");
    assert.equal(keys.keyup("Shift", "ShiftLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("forgets the keys that went down before a hold", () => {
    const holds = {
      F10: (keys: KeyWatch) => {
        keys.keydown("F10", "F10", false);
      },
      "lone Alt": (keys: KeyWatch) => {
        keys.keydown("Alt", "AltLeft", false);
        keys.keyup("Alt", "AltLeft", true);
      },
    };
    for (const [name, hold] of Object.entries(holds)) {
      const keys = createKeyWatch(slowClock());
      keys.keydown("Tab", "Tab", false);
      hold(keys);
      assert.equal(keys.keydown("q", "KeyQ", false), "restart", name);
      assert.equal(keys.keyup("Tab", "Tab", true), "restart", name);
    }
  });

  it("keeps a hold at a second Alt keyup", () => {
    const keys = createKeyWatch(slowClock());
    keys.keydown("Alt", "AltLeft", false);
    keys.keydown("Alt", "AltRight", false);
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.keyup("Alt", "AltRight", true), "none");
    assert.equal(keys.held(), true);
  });

  it("holds at a lone Alt with a click in between, but not with a pointer press", () => {
    const clicked = createKeyWatch(slowClock());
    clicked.keydown("Alt", "AltLeft", false);
    assert.equal(clicked.click(), "none");
    assert.equal(clicked.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(clicked.held(), true);

    const pressed = createKeyWatch(slowClock());
    pressed.keydown("Alt", "AltLeft", false);
    assert.equal(pressed.press(false), "none");
    assert.equal(pressed.keyup("Alt", "AltLeft", true), "restart");
    assert.equal(pressed.held(), false);
  });

  it("joins a hold at a keydown less than HOLD_JOIN_MS after the input that started it", () => {
    const holds = {
      F10: (keys: KeyWatch) => {
        keys.keydown("F10", "F10", false);
      },
      "lone Alt": (keys: KeyWatch) => {
        keys.keydown("Alt", "AltLeft", false);
        keys.keyup("Alt", "AltLeft", true);
      },
      "secondary press": (keys: KeyWatch) => {
        keys.press(true);
      },
    };
    for (const [name, hold] of Object.entries(holds)) {
      let time = 1000;
      const joined = createKeyWatch(() => time);
      hold(joined);
      time += HOLD_JOIN_MS - 1;
      assert.equal(joined.keydown("ArrowDown", "ArrowDown", false), "hold", name);
      assert.equal(joined.held(), true, name);
      time += 1000;
      assert.equal(joined.keyup("ArrowDown", "ArrowDown", false), "none", name);
      assert.equal(joined.held(), true, name);

      time = 1000;
      const ended = createKeyWatch(() => time);
      hold(ended);
      time += HOLD_JOIN_MS;
      assert.equal(ended.keydown("ArrowDown", "ArrowDown", false), "restart", name);
      assert.equal(ended.held(), false, name);
    }
  });

  it("keeps a hold at a keyup less than HOLD_JOIN_MS after the input that started it", () => {
    const holds = {
      F10: (keys: KeyWatch) => {
        keys.keydown("F10", "F10", false);
      },
      "lone Alt": (keys: KeyWatch) => {
        keys.keydown("Alt", "AltLeft", false);
        keys.keyup("Alt", "AltLeft", true);
      },
      "secondary press": (keys: KeyWatch) => {
        keys.press(true);
      },
    };
    for (const [name, hold] of Object.entries(holds)) {
      // A Shift whose keydown the page did not see, as for one held since before the last blur.
      let time = 1000;
      const kept = createKeyWatch(() => time);
      hold(kept);
      time += HOLD_JOIN_MS - 1;
      assert.equal(kept.keyup("Shift", "ShiftLeft", true), "none", name);
      assert.equal(kept.held(), true, name);

      time = 1000;
      const ended = createKeyWatch(() => time);
      hold(ended);
      time += HOLD_JOIN_MS;
      assert.equal(ended.keyup("Shift", "ShiftLeft", true), "restart", name);
      assert.equal(ended.held(), false, name);
    }
  });

  it("does not move the window at a keydown that joined by it", () => {
    let time = 1000;
    const keys = createKeyWatch(() => time);
    keys.keydown("F10", "F10", false);
    time += 50;
    assert.equal(keys.keydown("ArrowDown", "ArrowDown", false), "hold");
    time += HOLD_JOIN_MS - 50;
    assert.equal(keys.keydown("ArrowUp", "ArrowUp", false), "restart");
    assert.equal(keys.held(), false);
  });

  it("moves the window at a menu-opening input that joins the hold", () => {
    let time = 1000;
    const keys = createKeyWatch(() => time);
    keys.keydown("F10", "F10", false);
    time += 50;
    assert.equal(keys.contextmenu(), "hold");
    time += 70;
    assert.equal(keys.keydown("ArrowDown", "ArrowDown", false), "hold");
    assert.equal(keys.held(), true);
  });
});

function setup() {
  const timers = createFakeTimers();
  const changes: boolean[] = [];
  const arming = createArming(timers, (armed) => changes.push(armed));
  return { arming, timers, changes };
}

// A clock that moves well past HOLD_JOIN_MS between any two readings, so no keydown joins a hold
// by time.
function slowClock(): () => number {
  let time = 0;
  return () => {
    time += 1000;
    return time;
  };
}
