import type { FrameDetails } from "./browser-api.ts";

/** What a screenshot does about other add-ons' frames in one frame listing (ADR 0031). */
export interface ForeignFramePlan {
  /** The frames whose document holds another add-on's frame: each takes the frame hiding sheet. */
  hideIn: number[];
  /** The frames that are, or lie inside, another add-on's frame. */
  hidden: ReadonlySet<number>;
}

/**
 * The plan for one screenshot's listing, or undefined when it must refuse: another add-on's frame
 * whose way up to the top frame is broken or goes round, or such a frame in a listing that names a
 * frame id twice. `ownUrl` is a URL of Foxhand's own pages.
 */
export function foreignFramePlan(
  frames: readonly FrameDetails[],
  ownUrl: string,
): ForeignFramePlan | undefined {
  const ownHost = URL.parse(ownUrl)?.host ?? "";
  const listed = new Map(frames.map((frame) => [frame.frameId, frame]));
  const hideIn = new Set<number>();
  const hidden = new Set<number>();
  for (const frame of frames) {
    const walk = topForeignFrame(frame, listed, ownHost, frames.length);
    if (walk === "broken") return undefined;
    if (walk === undefined) continue;
    hidden.add(frame.frameId);
    hideIn.add(walk);
  }
  if (hidden.size > 0 && listed.size !== frames.length) return undefined;
  return { hideIn: [...hideIn], hidden };
}

/**
 * The parent of the top-most foreign frame on the way from `frame` up to the top frame;
 * "broken" when a parent on the way is missing, or the way goes round, after a foreign frame.
 */
function topForeignFrame(
  frame: FrameDetails,
  listed: ReadonlyMap<number, FrameDetails>,
  ownHost: string,
  steps: number,
): number | "broken" | undefined {
  let current = frame;
  let hideIn: number | undefined;
  for (let step = 0; step < steps; step++) {
    if (current.frameId === 0) return hideIn;
    const foreign = isForeignFrame(current, ownHost);
    const { parentFrameId } = current;
    const parent = typeof parentFrameId === "number" ? listed.get(parentFrameId) : undefined;
    if (parent === undefined) return foreign || hideIn !== undefined ? "broken" : undefined;
    if (foreign) hideIn = parent.frameId;
    current = parent;
  }
  return hideIn === undefined ? undefined : "broken";
}

/** Whether the frame shows a page of another add-on than Foxhand, whose host is `ownHost`. */
function isForeignFrame(frame: FrameDetails, ownHost: string): boolean {
  if (frame.frameId === 0 || ownHost === "" || typeof frame.url !== "string") return false;
  const url = URL.parse(frame.url);
  // Not by origin: a moz-extension: URL's origin is "null" outside Firefox.
  return url?.protocol === "moz-extension:" && url.host !== "" && url.host !== ownHost;
}
