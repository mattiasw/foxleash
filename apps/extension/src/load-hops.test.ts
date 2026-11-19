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

  it("stops listening at once when every load it saw ended", async () => {
    const { fake, stop, timers } = await setup();
    request1(fake);
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    stop();
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    assert.equal(timers.pending(), 0);
  });

  it("still cancels a hop judged when it stopped, without refusing", async () => {
    const { fake, stop, refusals, holdView } = await setup();
    request1(fake);
    const release = holdView();
    const answer = hop(fake, "r1", `${BLOCKED}/x`);
    fake.emitWebRequest("onErrorOccurred", ended("r1"));
    stop();
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    release();
    assert.deepEqual(await answer, { cancel: true });
    assert.deepEqual(refusals, []);
  });

  it("keeps judging a load still open when it stopped, until that load ends", async () => {
    const { fake, stop, refusals, viewReads } = await setup();
    request1(fake);
    stop();
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    assert.deepEqual(refusals, []);
    const [later] = fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    assert.equal(later, undefined);
    const reads = viewReads();
    assert.equal(await hop(fake, "r2", `${BLOCKED}/x`), undefined);
    assert.equal(viewReads(), reads);
    fake.emitWebRequest("onCompleted", ended("r2"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    fake.emitWebRequest("onErrorOccurred", ended("r1"));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("waits for every load it saw to end", async () => {
    const { fake, stop } = await setup();
    request1(fake);
    fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/b`));
    stop();
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    fake.emitWebRequest("onCompleted", ended("r2"));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("adopts the tab's next load when it stopped before any load started", async () => {
    const { fake, stop, refusals, timers } = await setup();
    stop();
    stop();
    assert.equal(timers.pending(), 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 3);
    timers.advance(LATE_START_MS - 1);
    const [first] = fake.emitWebRequest("onBeforeRequest", request("r1", `${SITE}/`));
    assert.equal(first, undefined);
    assert.equal(timers.pending(), 0);
    assert.deepEqual(await hop(fake, "r1", `${BLOCKED}/x`), { cancel: true });
    assert.deepEqual(refusals, []);
    const [second] = fake.emitWebRequest("onBeforeRequest", request("r2", `${SITE}/`));
    assert.equal(second, undefined);
    assert.equal(await hop(fake, "r2", `${BLOCKED}/x`), undefined);
    fake.emitWebRequest("onCompleted", ended("r1"));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
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
});

async function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  await grantSite(fake.browser, SITE);
  let reads = 0;
  let failure: { error: unknown } | undefined;
  let hold: Promise<void> | undefined;
  const hops = createLoadHops({
    browser: fake.browser,
    access: {
      view: async (session: string): Promise<SiteView> => {
        reads += 1;
        await hold;
        if (failure !== undefined) throw failure.error;
        return access.view(session);
      },
    },
    timers,
  });
  const refusals: ToolError[] = [];
  const order: string[] = [];
  const stop = hops.watch("s1", TAB, (error) => {
    refusals.push(error);
    order.push("refused");
  });
  return {
    fake,
    timers,
    hops,
    stop,
    refusals,
    order,
    viewReads: () => reads,
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
