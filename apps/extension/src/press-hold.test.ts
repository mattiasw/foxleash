import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeTimers, type FakeTimers } from "./fake-browser.ts";
import { createPressHold, type PressHold } from "./press-hold.ts";

describe("createPressHold", () => {
  it("runs an update at once when no button is down", () => {
    const { hold, timers } = setup();
    const ran: string[] = [];
    hold.run("sites", () => ran.push("sites"));
    assert.deepEqual(ran, ["sites"]);
    assert.equal(timers.pending(), 0);
  });

  it("holds an update while the primary button is down and runs it in a task after the release", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("sites", () => ran.push("sites"));
    assert.deepEqual(ran, []);
    page.dispatchEvent(pointer("pointerup", 0, 1));
    assert.deepEqual(ran, []);
    timers.advance(0);
    assert.deepEqual(ran, ["sites"]);
    timers.advance(1000);
    assert.deepEqual(ran, ["sites"]);
  });

  it("runs only the latest held update for a slot", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("sites", () => ran.push("first"));
    hold.run("sites", () => ran.push("second"));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    timers.advance(0);
    assert.deepEqual(ran, ["second"]);
  });

  it("runs the held slots in the order they were first held", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("answers", () => ran.push("answers 1"));
    hold.run("recipes", () => ran.push("recipes"));
    hold.run("answers", () => ran.push("answers 2"));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    timers.advance(0);
    assert.deepEqual(ran, ["answers 2", "recipes"]);
  });

  it("holds nothing for a secondary press or a press it cannot read", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 2, 1));
    hold.run("sites", () => ran.push("secondary"));
    page.dispatchEvent(new Event("pointerdown"));
    hold.run("sites", () => ran.push("unread"));
    page.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 3 }));
    hold.run("sites", () => ran.push("no button"));
    assert.deepEqual(ran, ["secondary", "unread", "no button"]);
    assert.equal(timers.pending(), 0);
  });

  it("ends the hold on pointercancel", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("sites", () => ran.push("sites"));
    page.dispatchEvent(pointer("pointercancel", 0, 1));
    timers.advance(0);
    assert.deepEqual(ran, ["sites"]);
  });

  it("ends the hold when the page loses focus, with no pointerup", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    page.dispatchEvent(pointer("pointerdown", 0, 2));
    hold.run("sites", () => ran.push("sites"));
    page.dispatchEvent(new Event("blur"));
    timers.advance(0);
    assert.deepEqual(ran, ["sites"]);
    hold.run("recipes", () => ran.push("recipes"));
    assert.deepEqual(ran, ["sites", "recipes"]);
  });

  it("holds until every pressed pointer is up", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    page.dispatchEvent(pointer("pointerdown", 0, 2));
    hold.run("sites", () => ran.push("sites"));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    page.dispatchEvent(new Event("pointerup"));
    assert.equal(timers.pending(), 0);
    timers.advance(0);
    assert.deepEqual(ran, []);
    page.dispatchEvent(pointer("pointerup", 2, 2));
    timers.advance(0);
    assert.deepEqual(ran, ["sites"]);
  });

  it("keeps holding when a new press starts before the held updates run", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("sites", () => ran.push("sites"));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    timers.advance(0);
    assert.deepEqual(ran, []);
    page.dispatchEvent(pointer("pointerup", 0, 1));
    timers.advance(0);
    assert.deepEqual(ran, ["sites"]);
  });

  it("holds an update that arrives after the release, before the held ones run", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("sites", () => ran.push("first"));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    hold.run("sites", () => ran.push("second"));
    assert.deepEqual(ran, []);
    timers.advance(0);
    assert.deepEqual(ran, ["second"]);
  });

  it("schedules one task for releases before it runs", () => {
    const { hold, page, timers } = setup();
    const ran: string[] = [];
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    hold.run("sites", () => ran.push("sites"));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    page.dispatchEvent(pointer("pointerdown", 0, 1));
    page.dispatchEvent(pointer("pointerup", 0, 1));
    assert.equal(timers.pending(), 1);
    timers.advance(0);
    assert.deepEqual(ran, ["sites"]);
  });
});

function setup(): { hold: PressHold; page: EventTarget; timers: FakeTimers } {
  const page = new EventTarget();
  const timers = createFakeTimers();
  return { hold: createPressHold(page, timers), page, timers };
}

function pointer(type: string, button: number, pointerId: number): Event {
  return Object.assign(new Event(type), { button, pointerId });
}
