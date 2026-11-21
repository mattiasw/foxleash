import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RequestDetails } from "./browser-api.ts";
import { createFakeBrowser, createFakeTimers } from "./fake-browser.ts";
import type { ToolError } from "./handlers.ts";
import { createLoadHops, LATE_START_MS } from "./load-hops.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, saveBlocklist } from "./settings.ts";
import {
  createSiteAccess,
  type SessionMemory,
  type SiteView,
  sessionStopped,
} from "./site-access.ts";

const TAB = 7;
const SITE = "https://a.example";
const UNAPPROVED = "https://c.example";
const BLOCKED = "https://www.paypal.com";
// The address a reload was checked on.
const GATED = `${SITE}/page?x=1`;

describe("load hops", { timeout: 10000 }, () => {
  it("lets a new request go on at once, unjudged", async () => {
    const { fake, viewReads } = await setup();
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    assert.equal(answer, undefined);
    assert.equal(viewReads(), 0);
  });

  it("cancels a hop to a blocked site and refuses with its site only", async () => {
    const { fake, refusals } = await setup();
    request1(fake);
    const answer = hop(fake, "r1", `${BLOCKED}:8443/pay/now?card=1#top`);
    assert.ok(answer instanceof Promise);
    assert.deepEqual(await answer, { cancel: true });
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.code, "site_blocked");
    assert.equal(
      refusals[0]?.message,
      `Tab ${TAB}'s load was redirected to ${BLOCKED}:8443, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`,
    );
  });

  it("lets a hop to an approved site or to a site that is only unapproved go on", async () => {
    const { fake, refusals, viewReads } = await setup();
    request1(fake);
    assert.equal(await hop(fake, "r1", `${SITE}/b`), undefined);
    assert.equal(await hop(fake, "r1", `${UNAPPROVED}/c`), undefined);
    assert.equal(viewReads(), 2);
    assert.deepEqual(refusals, []);
  });

  it("cancels a hop to a blocked site the user approved", async () => {
    const { fake, refusals } = await setup();
    await grantSite(fake.browser, BLOCKED);
    request1(fake);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    assert.equal(refusals[0]?.code, "site_blocked");
  });

  it("lets a hop to an address that is not http or https go on without reading the view", async () => {
    const { fake, refusals, viewReads } = await setup();
    request1(fake);
    assert.equal(await hop(fake, "r1", "data:text/html,hi"), undefined);
    assert.equal(await hop(fake, "r1", "not a url"), undefined);
    assert.equal(viewReads(), 0);
    assert.deepEqual(refusals, []);
  });

  it("cancels a hop to an http address with no site, without reading the view", async () => {
    const { fake, refusals, viewReads } = await setup();
    request1(fake);
    assert.deepEqual(await hop(fake, "r1", "http://bank.example../x"), { cancel: true });
    assert.equal(viewReads(), 0);
    assert.equal(refusals[0]?.code, "redirect_unchecked");
    assert.equal(
      refusals[0]?.message,
      `Tab ${TAB}'s load was redirected to an address Foxleash could not check, so Foxleash stopped it before anything was requested there.`,
    );
  });

  it("cancels and refuses with the view's own error when the session stopped", async () => {
    const { fake, refusals, failView } = await setup();
    request1(fake);
    const stopped = sessionStopped();
    failView(stopped);
    assert.deepEqual(await hop(fake, "r1", `${SITE}/b`), { cancel: true });
    assert.deepEqual(refusals, [stopped]);
  });

  it("cancels and refuses as unchecked when the view cannot be read", async () => {
    const { fake, refusals, failView } = await setup();
    request1(fake);
    failView(new Error("storage gone"));
    assert.deepEqual(await hop(fake, "r1", `${SITE}/b?secret=1`), { cancel: true });
    assert.equal(refusals[0]?.code, "redirect_unchecked");
    assert.equal(
      refusals[0]?.message,
      `Tab ${TAB}'s load was redirected to ${SITE}, which Foxleash could not check against its blocklist, so Foxleash stopped it before anything was requested there.`,
    );
  });

  it("lets a second new request go on at once", async () => {
    const { fake, viewReads } = await setup();
    request1(fake);
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r2", `${BLOCKED}/x`));
    assert.equal(answer, undefined);
    assert.equal(viewReads(), 0);
  });

  it("refuses before it answers with the cancel", async () => {
    const { fake, order } = await setup();
    request1(fake);
    const answer = hop(fake, "r1", `${BLOCKED}/x`);
    assert.ok(answer instanceof Promise);
    await answer.then(() => order.push("answered"));
    assert.deepEqual(order, ["refused", "answered"]);
  });

  it("still cancels when refusing throws", async () => {
    const { fake, hops } = await setup();
    hops.watch("s1", TAB, () => {
      throw new Error("refuse failed");
    });
    request1(fake);
    const answers = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    assert.deepEqual(await Promise.all(answers), [{ cancel: true }, { cancel: true }]);
  });

  it("reads the view anew for each hop", async () => {
    const { fake, refusals } = await setup();
    request1(fake);
    assert.equal(await hop(fake, "r1", `${SITE}/b`), undefined);
    await saveBlocklist(fake.browser, ["a.example"]);
    assert.deepEqual(await hop(fake, "r1", `${SITE}/c`), { cancel: true });
    assert.equal(refusals[0]?.code, "site_blocked");
  });

  it("hears only top-level requests of its tab, and ignores the end of a request it did not see", async () => {
    const { fake, refusals } = await setup();
    request1(fake);
    assert.deepEqual(
      fake.emitWebRequest("onBeforeRequest", { ...request("r1", `${BLOCKED}/x`), tabId: TAB + 1 }),
      [],
    );
    assert.deepEqual(
      fake.emitWebRequest("onBeforeRequest", { ...request("r1", `${BLOCKED}/x`), type: "image" }),
      [],
    );
    fake.emitWebRequest("onCompleted", ended("r9"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    assert.deepEqual(refusals, []);
  });

  it("listens blocking on the tab's top-level requests, and on their ends", async () => {
    const { fake } = await setup();
    const filter = { urls: ["<all_urls>"], types: ["main_frame"], tabId: TAB };
    assert.deepEqual(
      fake.activeWebRequestRegistrations().map(({ event, filter, extraInfoSpec }) => ({
        event,
        filter,
        extraInfoSpec,
      })),
      [
        { event: "onBeforeRequest", filter, extraInfoSpec: ["blocking"] },
        { event: "onCompleted", filter, extraInfoSpec: undefined },
        { event: "onErrorOccurred", filter, extraInfoSpec: undefined },
      ],
    );
  });

  it("keeps listening for the late start time after it stopped, also when every load it saw ended", async () => {
    const { fake, stop, timers } = await setup();
    request1(fake);
    fake.emitWebRequest("onCompleted", ended("r1"));
    stop();
    assert.equal(timers.pending(), 1);
    timers.advance(LATE_START_MS - 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    assert.equal(timers.pending(), 0);
  });

  it("adopts a new load after it stopped although it saw a load of the page's own", async () => {
    const { fake, stop, refusals } = await setup();
    request1(fake);
    fake.emitWebRequest("onCompleted", ended("r1"));
    stop();
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    assert.equal(answer, undefined);
    assert.deepEqual(await hop(fake, "r2", `${BLOCKED}/x`), { cancel: true });
    assert.deepEqual(refusals, []);
  });

  it("still cancels a hop judged when it stopped, without refusing", async () => {
    const { fake, stop, refusals, holdView } = await setup();
    request1(fake);
    const release = holdView();
    const answer = hop(fake, "r1", `${BLOCKED}/x`);
    fake.emitWebRequest("onErrorOccurred", ended("r1"));
    stop();
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    release();
    assert.deepEqual(await answer, { cancel: true });
    assert.deepEqual(refusals, []);
  });

  it("judges a hop that arrived while it waited by the session's view, also when that read settles after it stopped", async () => {
    const { fake, stop, refusals, holdView, access, viewReads, blocklistReads } = await setup();
    request1(fake);
    access.stop("s1");
    const release = holdView();
    const answer = hop(fake, "r1", `${SITE}/b`);
    stop();
    release();
    assert.deepEqual(await answer, { cancel: true });
    assert.deepEqual(refusals, []);
    assert.equal(viewReads(), 1);
    assert.equal(blocklistReads(), 0);
  });

  it("keeps judging a load still open when it stopped, until that load ends", async () => {
    const { fake, stop, refusals, reads, timers } = await setup();
    request1(fake);
    stop();
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    assert.deepEqual(refusals, []);
    timers.advance(LATE_START_MS);
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    const [later] = fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    assert.equal(later, undefined);
    const before = reads();
    assert.equal(await hop(fake, "r2", `${BLOCKED}/x`), undefined);
    assert.equal(reads(), before);
    fake.emitWebRequest("onCompleted", ended("r2"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/y`), { cancel: true });
    fake.emitWebRequest("onErrorOccurred", ended("r1"));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("waits for every load it saw to end", async () => {
    const { fake, stop, timers } = await setup();
    request1(fake);
    fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/b`));
    stop();
    timers.advance(LATE_START_MS);
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    fake.emitWebRequest("onCompleted", ended("r2"));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("adopts every new load of the tab during the window after it stopped", async () => {
    const { fake, stop, refusals, timers } = await setup();
    stop();
    stop();
    assert.equal(timers.pending(), 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(LATE_START_MS - 1);
    const [first] = fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    assert.equal(first, undefined);
    assert.equal(timers.pending(), 1);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    const [second] = fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    assert.equal(second, undefined);
    assert.deepEqual(await hop(fake, "r2", `${BLOCKED}/x`), { cancel: true });
    assert.deepEqual(refusals, []);
    fake.emitWebRequest("onCompleted", ended("r1"));
    fake.emitWebRequest("onErrorOccurred", ended("r2"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("after it stopped, judges a stopped session's hops by the blocklist alone, without refusing", async () => {
    const { fake, stop, refusals, access, viewReads, blocklistReads } = await setup();
    request1(fake);
    access.stop("s1");
    stop();
    assert.equal(await hop(fake, "r1", `${SITE}/b`), undefined);
    assert.equal(await hop(fake, "r1", `${UNAPPROVED}/c`), undefined);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    assert.deepEqual(refusals, []);
    assert.equal(viewReads(), 0);
    assert.equal(blocklistReads(), 3);
  });

  it("cancels and refuses with session_stopped while it waits for a session the user stopped", async () => {
    const { fake, refusals, access } = await setup();
    request1(fake);
    access.stop("s1");
    assert.deepEqual(await hop(fake, "r1", `${SITE}/b`), { cancel: true });
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.code, "session_stopped");
  });

  it("cancels without refusing when the blocklist cannot be read after it stopped", async () => {
    const { fake, stop, refusals, failView, blocklistReads } = await setup();
    request1(fake);
    stop();
    failView(new Error("storage gone"));
    assert.deepEqual(await hop(fake, "r1", `${SITE}/b`), { cancel: true });
    assert.deepEqual(refusals, []);
    assert.equal(blocklistReads(), 1);
  });

  it("stops listening when no load started within the late start time", async () => {
    const { fake, stop, timers } = await setup();
    stop();
    timers.advance(LATE_START_MS - 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("keeps the requests of each watch apart", async () => {
    const { fake, hops } = await setup();
    request1(fake);
    const other: ToolError[] = [];
    const stopOther = hops.watch("s1", TAB, (error) => other.push(error));
    // The first watch saw r1 already: the second one sees it new.
    const answers = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    assert.ok(answers[0] instanceof Promise);
    assert.equal(answers[1], undefined);
    assert.deepEqual(await answers[0], { cancel: true });
    assert.deepEqual(other, []);
    stopOther();
  });

  it("ends an older watch's window once a newer watch of the tab hears a request, and leaves other tabs alone", async () => {
    const { fake, stop, hops, refusals } = await setup();
    request1(fake);
    stop();
    const stopOtherTab = hops.watch("s1", TAB + 1, () => {});
    hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    // The older watch adopts no new load now.
    const [older, newer] = fake.emitWebRequest("onBeforeRequest", request("r3", `${SITE}/`));
    assert.equal(older, undefined);
    assert.equal(newer, undefined);
    const hopAnswers = fake.emitWebRequest("onBeforeRequest", request("r3", `${BLOCKED}/x`));
    assert.equal(hopAnswers[0], undefined);
    assert.ok(hopAnswers[1] instanceof Promise);
    // It still judges the loads it adopted.
    const [oldHop] = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    assert.deepEqual(await oldHop, { cancel: true });
    assert.deepEqual(refusals, []);
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(registrationsOn(fake, TAB), 6);
    fake.emitWebRequest("onCompleted", ended("r2"));
    assert.equal(registrationsOn(fake, TAB), 3);
    assert.equal(registrationsOn(fake, TAB + 1), 3);
    stopOtherTab();
    const otherTab = { ...request("c1", `${SITE}/`), tabId: TAB + 1 };
    assert.deepEqual(fake.emitWebRequest("onBeforeRequest", otherTab), [undefined]);
    const [otherHop] = fake.emitWebRequest("onBeforeRequest", {
      ...otherTab,
      url: `${BLOCKED}/x`,
    });
    assert.deepEqual(await otherHop, { cancel: true });
  });

  it("lets an older watch adopt until a newer watch of the tab hears its first request", async () => {
    const { fake, stop, hops, timers } = await setup();
    stop();
    const newerRefusals: ToolError[] = [];
    hops.watch("s1", TAB, (error) => newerRefusals.push(error));
    assert.deepEqual(fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`)), [
      undefined,
      undefined,
    ]);
    const both = fake.emitWebRequest("onBeforeRequest", request("r2", `${BLOCKED}/x`));
    assert.equal(both.length, 2);
    assert.deepEqual(await Promise.all(both), [{ cancel: true }, { cancel: true }]);
    assert.equal(newerRefusals.length, 1);
    fake.emitWebRequest("onBeforeRequest", request("r3", `${SITE}/`));
    const answers = fake.emitWebRequest("onBeforeRequest", request("r3", `${BLOCKED}/x`));
    assert.equal(answers[0], undefined);
    assert.deepEqual(await answers[1], { cancel: true });
    // One window for the tab, which the older watch's stop started.
    assert.equal(timers.pending(), 1);
  });

  it("ends every older watch of the tab that no newer watch heard a request for", async () => {
    const { fake, stop, hops } = await setup();
    stop();
    const stopMiddle = hops.watch("s1", TAB, () => {});
    stopMiddle();
    hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    const answers = fake.emitWebRequest("onBeforeRequest", request("r2", `${BLOCKED}/x`));
    assert.equal(answers.length, 3);
    assert.equal(answers[0], undefined);
    assert.equal(answers[1], undefined);
    assert.deepEqual(await answers[2], { cancel: true });
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
  });

  it("keeps adopting until the late start time after the tab's last wait, also when that wait's watch was taken over", async () => {
    const { fake, stop, hops, timers } = await setup();
    const stopNewer = hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    fake.emitWebRequest("onCompleted", ended("r1"));
    stopNewer();
    timers.advance(25_000);
    // The older call returns last; its watch was taken over and stops listening.
    stop();
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(LATE_START_MS - 1);
    assert.deepEqual(fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`)), [
      undefined,
    ]);
    assert.deepEqual(await hop(fake, "r2", `${BLOCKED}/x`), { cancel: true });
    fake.emitWebRequest("onCompleted", ended("r2"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("keeps adopting until the late start time after the tab's last wait when a newer watch that stopped first takes over later", async () => {
    const { fake, stop, hops, timers } = await setup();
    const stopNewer = hops.watch("s1", TAB, () => {});
    stopNewer();
    timers.advance(25_000);
    stop();
    timers.advance(5_000);
    fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(LATE_START_MS - 5_001);
    assert.deepEqual(fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`)), [
      undefined,
    ]);
    assert.deepEqual(await hop(fake, "r2", `${BLOCKED}/x`), { cancel: true });
    fake.emitWebRequest("onCompleted", ended("r2"));
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("keeps the tab's newer watches on record when an older watch stops listening", async () => {
    const { fake, stop, hops } = await setup();
    stop();
    const stopMiddle = hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    stopMiddle();
    hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    fake.emitWebRequest("onCompleted", ended("r2"));
    // The middle watch adopts no more and stopped listening.
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
  });

  it("keeps every adopting watch of the tab until the window after the tab's last wait ends", async () => {
    const { fake, stop, hops, timers } = await setup();
    const stopNewer = hops.watch("s1", TAB, () => {});
    stopNewer();
    timers.advance(1000);
    stop();
    assert.equal(timers.pending(), 1);
    timers.advance(LATE_START_MS - 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 6);
    assert.deepEqual(fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`)), [
      undefined,
      undefined,
    ]);
    const answers = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    assert.deepEqual(await Promise.all(answers), [{ cancel: true }, { cancel: true }]);
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("stops listening at its stop when a newer watch of the tab took over while it waited", async () => {
    const { fake, stop, hops, timers } = await setup();
    request1(fake);
    fake.emitWebRequest("onCompleted", ended("r1"));
    hops.watch("s1", TAB, () => {});
    // The older watch judges this hop of its load; the newer one hears its first request.
    const [judged] = fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/b`));
    stop();
    // The tab's window, for the newer watch.
    assert.equal(timers.pending(), 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    assert.equal(await judged, undefined);
  });

  it("stops listening once its loads ended when a newer watch of the tab took over while it waited", async () => {
    const { fake, stop, hops } = await setup();
    hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    stop();
    assert.equal(fake.activeWebRequestRegistrations().length, 6);
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
  });

  it("cancels a reload's first request to a blocked site off the checked site while it waits, refusing first", async () => {
    const { fake, refusals, order } = await setup({ gated: GATED });
    const [answer] = fake.emitWebRequest(
      "onBeforeRequest",
      request("r1", `${BLOCKED}:8443/pay?card=1#top`),
    );
    assert.ok(answer instanceof Promise);
    await answer.then((cancel) => {
      assert.deepEqual(cancel, { cancel: true });
      order.push("answered");
    });
    assert.deepEqual(order, ["refused", "answered"]);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.code, "site_blocked");
    assert.equal(
      refusals[0]?.message,
      `Tab ${TAB}'s load was redirected to ${BLOCKED}:8443, which is on Foxleash's blocklist; Foxleash stopped it before anything was requested there.`,
    );
  });

  it("lets a reload's first request on the checked site go on at once without reading the view", async () => {
    const { fake, refusals, viewReads } = await setup({ gated: GATED });
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/other?y=2`));
    assert.equal(answer, undefined);
    const [dotted] = fake.emitWebRequest("onBeforeRequest", request("r2", "https://a.example./x"));
    assert.equal(dotted, undefined);
    assert.equal(viewReads(), 0);
    assert.deepEqual(refusals, []);
  });

  it("lets a reload's first request to a site that is only unapproved go on, and judges its hops", async () => {
    const { fake, refusals, viewReads } = await setup({ gated: GATED });
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r1", `${UNAPPROVED}/c`));
    assert.ok(answer instanceof Promise);
    assert.equal(await answer, undefined);
    assert.equal(viewReads(), 1);
    assert.equal(refusals.length, 0);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    assert.equal(refusals[0]?.code, "site_blocked");
  });

  it("judges no first request off the checked site once the wait ended", async () => {
    const { fake, stop, refusals, reads } = await setup({ gated: GATED });
    stop();
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    assert.equal(answer, undefined);
    assert.equal(reads(), 0);
    assert.deepEqual(refusals, []);
  });

  it("lets a reload's first request to an address that is not http or https go on without reading the view", async () => {
    const { fake, refusals, viewReads } = await setup({ gated: GATED });
    const [answer] = fake.emitWebRequest("onBeforeRequest", request("r1", "data:text/html,hi"));
    assert.equal(await answer, undefined);
    assert.equal(viewReads(), 0);
    assert.deepEqual(refusals, []);
  });

  it("cancels a reload's first request to an http address with no site, without reading the view", async () => {
    const { fake, refusals, viewReads } = await setup({ gated: GATED });
    const [answer] = fake.emitWebRequest(
      "onBeforeRequest",
      request("r1", "http://bank.example../x"),
    );
    assert.deepEqual(await answer, { cancel: true });
    assert.equal(viewReads(), 0);
    assert.equal(refusals[0]?.code, "redirect_unchecked");
  });

  it("judges a reload's first request off the checked site also after a newer watch of the tab took over", async () => {
    const { fake, hops, refusals } = await setup({ gated: GATED });
    hops.watch("s1", TAB, () => {});
    fake.emitWebRequest("onBeforeRequest", request("r0", `${SITE}/`));
    const answers = fake.emitWebRequest("onBeforeRequest", request("r1", `${BLOCKED}/x`));
    const judged = answers.filter((answer) => answer !== undefined);
    assert.equal(judged.length, 1);
    assert.ok(judged[0] instanceof Promise);
    assert.deepEqual(await judged[0], { cancel: true });
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.code, "site_blocked");
  });
});

async function setup({ gated }: { gated?: string } = {}) {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  await grantSite(fake.browser, SITE);
  let viewReads = 0;
  let blocklistReads = 0;
  let failure: { error: unknown } | undefined;
  let hold: Promise<void> | undefined;
  const hops = createLoadHops({
    browser: fake.browser,
    access: {
      view: async (session: string): Promise<SiteView> => {
        viewReads += 1;
        await hold;
        if (failure !== undefined) throw failure.error;
        return access.view(session);
      },
      blocklisted: async (url: string): Promise<boolean> => {
        blocklistReads += 1;
        await hold;
        if (failure !== undefined) throw failure.error;
        return access.blocklisted(url);
      },
    },
    timers,
  });
  const refusals: ToolError[] = [];
  const order: string[] = [];
  const stop = hops.watch(
    "s1",
    TAB,
    (error) => {
      refusals.push(error);
      order.push("refused");
    },
    gated,
  );
  return {
    fake,
    timers,
    hops,
    stop,
    refusals,
    order,
    access,
    viewReads: () => viewReads,
    blocklistReads: () => blocklistReads,
    reads: () => viewReads + blocklistReads,
    failView: (error: unknown) => {
      failure = { error };
    },
    holdView: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      hold = promise;
      return () => resolve();
    },
  };
}

function registrationsOn(fake: ReturnType<typeof createFakeBrowser>, tabId: number): number {
  return fake
    .activeWebRequestRegistrations()
    .filter((registration) => registration.filter.tabId === tabId).length;
}

function request1(fake: ReturnType<typeof createFakeBrowser>): void {
  fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
}

/** A redirect hop of `requestId`: Firefox reports it with the first request's id. */
function hop(fake: ReturnType<typeof createFakeBrowser>, requestId: string, url: string): unknown {
  const [answer] = fake.emitWebRequest("onBeforeRequest", request(requestId, url));
  return answer;
}

function request(requestId: string, url: string): RequestDetails {
  return {
    requestId,
    url,
    tabId: TAB,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    timeStamp: 1,
  };
}

function ended(requestId: string) {
  return { requestId, tabId: TAB, timeStamp: 2, statusCode: 200, fromCache: false, error: "" };
}
