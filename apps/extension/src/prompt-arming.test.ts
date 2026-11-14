import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeTimers } from "./fake-browser.ts";
import { ARMING_DELAY_MS, createArming, createKeyWatch, type KeyWatch } from "./prompt-arming.ts";

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
    const keys = createKeyWatch();
    assert.equal(keys.held(), false);
    assert.equal(keys.keydown("Alt", "AltLeft"), "none");
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.held(), true);
  });

  it("holds after an Alt held down long enough to repeat", () => {
    const keys = createKeyWatch();
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.equal(keys.keydown("Alt", "AltLeft"), "none");
    }
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.held(), true);
  });

  it("restarts, and does not hold, at an Alt with a key, a press or a blur in between", () => {
    const between = {
      key: (keys: KeyWatch) => keys.keydown("Tab", "Tab"),
      press: (keys: KeyWatch) => keys.press(),
      blur: (keys: KeyWatch) => keys.blur(),
    };
    for (const [name, step] of Object.entries(between)) {
      const keys = createKeyWatch();
      keys.keydown("Alt", "AltLeft");
      step(keys);
      assert.equal(keys.keyup("Alt", "AltLeft", true), "restart", name);
      assert.equal(keys.held(), false, name);
    }
  });

  it("does not hold at an Alt with Shift pressed and released in between", () => {
    const keys = createKeyWatch();
    keys.keydown("Alt", "AltLeft");
    keys.keydown("Shift", "ShiftLeft");
    assert.equal(keys.keyup("Shift", "ShiftLeft", true), "none");
    assert.equal(keys.keyup("Alt", "AltLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("restarts, and does not hold, at an Alt keyup whose keydown it did not see", () => {
    const keys = createKeyWatch();
    assert.equal(keys.keyup("Alt", "AltLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("ends a hold at the first key, keyup or press after it, and only there", () => {
    const releases = {
      keydown: (keys: KeyWatch) => keys.keydown("q", "KeyQ"),
      "unseen keyup": (keys: KeyWatch) => keys.keyup("Escape", "Escape", false),
      press: (keys: KeyWatch) => keys.press(),
    };
    for (const [name, release] of Object.entries(releases)) {
      const keys = createKeyWatch();
      keys.keydown("Alt", "AltLeft");
      keys.keyup("Alt", "AltLeft", true);
      assert.equal(release(keys), "restart", name);
      assert.equal(keys.held(), false, name);
      assert.equal(keys.press(), "none", name);
    }
  });

  it("ends a hold at the keyup of a modifier that went down before it", () => {
    const keys = createKeyWatch();
    keys.keydown("Shift", "ShiftLeft");
    keys.keydown("Alt", "AltLeft");
    assert.equal(keys.keyup("Alt", "AltLeft", true), "hold");
    assert.equal(keys.keyup("Shift", "ShiftLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("lets the keyup of the Tab that ended a hold leave the second running", () => {
    const keys = createKeyWatch();
    keys.keydown("Alt", "AltLeft");
    keys.keyup("Alt", "AltLeft", true);
    assert.equal(keys.keydown("Tab", "Tab"), "restart");
    assert.equal(keys.held(), false);
    assert.equal(keys.keyup("Tab", "Tab", true), "none");
  });

  it("does not hold again at a second Alt keyup after a hold ended", () => {
    const keys = createKeyWatch();
    keys.keydown("Alt", "AltLeft");
    keys.keyup("Alt", "AltLeft", true);
    assert.equal(keys.keyup("Escape", "Escape", false), "restart");
    assert.equal(keys.keyup("Alt", "AltLeft", true), "restart");
    assert.equal(keys.held(), false);
  });

  it("leaves the second running only at the keyup of a Tab, Space or modifier it saw go down", () => {
    const keys = createKeyWatch();
    keys.keydown("Tab", "Tab");
    assert.equal(keys.keyup("Tab", "Tab", true), "none");
    assert.equal(keys.keyup("Tab", "Tab", true), "restart");
    keys.keydown("q", "KeyQ");
    assert.equal(keys.keyup("q", "KeyQ", false), "restart");
    assert.equal(keys.keyup("Escape", "Escape", false), "restart");
    assert.equal(keys.held(), false);
  });

  it("forgets the keys that went down before a blur", () => {
    const keys = createKeyWatch();
    keys.keydown("Tab", "Tab");
    keys.blur();
    assert.equal(keys.keyup("Tab", "Tab", true), "restart");
  });

  it("keeps a hold across a blur", () => {
    const keys = createKeyWatch();
    keys.keydown("Alt", "AltLeft");
    keys.keyup("Alt", "AltLeft", true);
    keys.blur();
    assert.equal(keys.held(), true);
    assert.equal(keys.keydown("Tab", "Tab"), "restart");
    assert.equal(keys.held(), false);
  });

  it("matches a keyup to its keydown by code, or by key when there is no code", () => {
    const keys = createKeyWatch();
    keys.keydown("a", "KeyA");
    assert.equal(keys.keyup("A", "KeyA", true), "none");
    keys.keydown("a", "");
    assert.equal(keys.keyup("b", "", true), "restart");
    assert.equal(keys.keyup("a", "", true), "none");
    keys.keydown("Tab", "");
    assert.equal(keys.keyup("Tab", "Tab", true), "restart");
  });

  it("does nothing at a press while not held", () => {
    const keys = createKeyWatch();
    assert.equal(keys.press(), "none");
    assert.equal(keys.held(), false);
  });
});

function setup() {
  const timers = createFakeTimers();
  const changes: boolean[] = [];
  const arming = createArming(timers, (armed) => changes.push(armed));
  return { arming, timers, changes };
}
