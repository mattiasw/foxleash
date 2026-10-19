import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeTimers } from "./fake-browser.ts";
import { ARMING_DELAY_MS, createArming } from "./prompt-arming.ts";

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

function setup() {
  const timers = createFakeTimers();
  const changes: boolean[] = [];
  const arming = createArming(timers, (armed) => changes.push(armed));
  return { arming, timers, changes };
}
