import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FrameDetails } from "./browser-api.ts";
import { foreignFramePlan } from "./foreign-frames.ts";

const OWN = "moz-extension://8a7f9c1e-2b3d-4e5f-a6b7-c8d9e0f1a2b3/";
const OTHER = "moz-extension://0b5e2f4c-1d2e-4f3a-9b8c-7d6e5f4a3b2c/infield.html";
const TOP: FrameDetails = { frameId: 0, parentFrameId: -1, url: "https://a.example/" };

function frame(frameId: number, parentFrameId: number, url = "https://a.example/frame") {
  return { frameId, parentFrameId, url };
}

function hidesNothing(frames: FrameDetails[], ownUrl = OWN): void {
  const plan = foreignFramePlan(frames, ownUrl);
  assert.ok(plan !== undefined);
  assert.deepEqual(plan.hideIn, []);
  assert.deepEqual([...plan.hidden], []);
}

describe("foreignFramePlan", () => {
  it("hides nothing in a listing without another add-on's frame", () => {
    hidesNothing([TOP]);
    hidesNothing([TOP, frame(5, 0), frame(9, 5)]);
  });

  it("takes a frame of another add-on's host as foreign and hides it in its parent", () => {
    const plan = foreignFramePlan([TOP, frame(5, 0), frame(7, 0, OTHER)], OWN);
    assert.deepEqual(plan?.hideIn, [0]);
    assert.deepEqual([...(plan?.hidden ?? [])], [7]);
  });

  it("does not take Foxhand's own pages, web pages or the top frame as foreign", () => {
    hidesNothing([TOP, frame(7, 0, `${OWN}prompt.html`)]);
    hidesNothing([TOP, frame(7, 0, "https://0b5e2f4c-1d2e-4f3a-9b8c-7d6e5f4a3b2c/")]);
    hidesNothing([TOP, frame(7, 0, "about:blank"), frame(8, 0, "data:text/html,x")]);
    hidesNothing([{ ...TOP, url: OTHER }, frame(5, 0)]);
  });

  it("does not take a frame without an address, or with one it cannot read, as foreign", () => {
    hidesNothing([TOP, { frameId: 7, parentFrameId: 0 }]);
    hidesNothing([TOP, frame(7, 0, "moz-extension:")]);
    hidesNothing([TOP, frame(7, 0, "moz-extension:infield.html")]);
    hidesNothing([TOP, frame(7, 0, "not a url")]);
  });

  it("takes no frame as foreign when Foxhand's own host is unknown", () => {
    hidesNothing([TOP, frame(7, 0, OTHER)], "");
    hidesNothing([TOP, frame(7, 0, OTHER)], "moz-extension:");
  });

  it("hides another add-on's frame in a page subframe in that subframe only", () => {
    const plan = foreignFramePlan([TOP, frame(5, 0), frame(7, 5, OTHER)], OWN);
    assert.deepEqual(plan?.hideIn, [5]);
    assert.deepEqual([...(plan?.hidden ?? [])], [7]);
  });

  it("hides a foreign frame inside another one, and the page frames in it, in the outer one's parent", () => {
    const inner = "moz-extension://5c4d3e2f-1a2b-4c3d-8e9f-0a1b2c3d4e5f/menu.html";
    const plan = foreignFramePlan(
      [TOP, frame(5, 0), frame(9, 7), frame(8, 7, inner), frame(7, 5, OTHER), frame(6, 9)],
      OWN,
    );
    assert.deepEqual(plan?.hideIn, [5]);
    assert.deepEqual(new Set(plan?.hidden), new Set([9, 8, 7, 6]));
  });

  it("gives two foreign frames in one document one target", () => {
    const plan = foreignFramePlan([TOP, frame(7, 0, OTHER), frame(8, 0, OTHER)], OWN);
    assert.deepEqual(plan?.hideIn, [0]);
    assert.deepEqual([...(plan?.hidden ?? [])], [7, 8]);
  });

  it("refuses a foreign frame whose way to the top frame is broken", () => {
    const listings: FrameDetails[][] = [
      [TOP, { frameId: 7, url: OTHER }],
      [TOP, frame(7, 4, OTHER)],
      [TOP, frame(7, -1, OTHER)],
      [TOP, frame(5, 4), frame(7, 5, OTHER)],
      [TOP, { frameId: 5 }, frame(7, 5, OTHER)],
      [frame(7, 0, OTHER)],
    ];
    for (const frames of listings) {
      assert.equal(foreignFramePlan(frames, OWN), undefined, JSON.stringify(frames));
    }
  });

  it("refuses a foreign frame whose way up goes round", () => {
    assert.equal(
      foreignFramePlan([TOP, frame(5, 6), frame(6, 5), frame(7, 5, OTHER)], OWN),
      undefined,
    );
    assert.equal(foreignFramePlan([TOP, frame(7, 7, OTHER)], OWN), undefined);
    assert.equal(foreignFramePlan([TOP, frame(7, 8, OTHER), frame(8, 7)], OWN), undefined);
  });

  it("neither hides nor refuses a page frame whose way breaks or goes round before any foreign frame", () => {
    const plan = foreignFramePlan(
      [TOP, frame(7, 0, OTHER), frame(5, 6), frame(6, 5), frame(4, 3), { frameId: 2 }],
      OWN,
    );
    assert.deepEqual(plan?.hideIn, [0]);
    assert.deepEqual([...(plan?.hidden ?? [])], [7]);
  });

  it("refuses a listing that names a frame id twice beside a foreign frame", () => {
    assert.equal(foreignFramePlan([TOP, frame(7, 0, OTHER), frame(7, 0)], OWN), undefined);
    assert.equal(
      foreignFramePlan([TOP, frame(5, 0), frame(7, 0, OTHER), frame(5, 0)], OWN),
      undefined,
    );
    hidesNothing([TOP, frame(5, 0), frame(5, 0)]);
  });
});
