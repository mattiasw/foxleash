import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { ALL_WEBSITES_ACCESS_STEPS } from "@foxleash/protocol";
import type { Permissions } from "./browser-api.ts";
import { createFakeBrowser, type FakeBrowser, flush } from "./fake-browser.ts";
import { SENTENCES, watchWebsiteAccess } from "./website-access.ts";

describe("watchWebsiteAccess", { timeout: 10000 }, () => {
  it("fills in the steps before any answer, and keeps the warning hidden until one", (t) => {
    const { elements, events, fake } = setup(t);
    assert.equal(elements.steps.textContent, ALL_WEBSITES_ACCESS_STEPS);
    assert.equal(elements.warning.hidden, true);
    assert.deepEqual(events, []);
    assert.deepEqual(fake.permissionChecks, [["<all_urls>"]]);
  });

  it("changes nothing on a first answer of granted", async (t) => {
    const { elements, events } = setup(t);
    await flush();
    assert.equal(elements.warning.hidden, true);
    assert.deepEqual(events, []);
  });

  it("shows the warning and announces it when Firefox withholds the access", async (t) => {
    const { elements, events } = setup(t, { allUrls: false });
    await flush();
    assert.equal(elements.warning.hidden, false);
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["hidden", false],
      ["announce", SENTENCES.withheld],
    ]);
  });

  it("follows the access as it is removed and given, announcing each change once", async (t) => {
    const { elements, events, fake } = setup(t);
    await flush();
    fake.setAllUrls(false);
    await flush();
    assert.equal(elements.warning.hidden, false);
    fake.setAllUrls(true);
    await flush();
    assert.equal(elements.warning.hidden, true);
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["hidden", false],
      ["announce", SENTENCES.withheld],
      ["beforeChange", true],
      ["hidden", true],
      ["announce", SENTENCES.granted],
    ]);
  });

  it("changes nothing when a permission event leaves the access as it was", async (t) => {
    const { events, fake, fire } = setup(t, { allUrls: false });
    await flush();
    events.length = 0;
    fake.grantedOrigins.add("https://a.example/*");
    fire({ permissions: [], origins: ["https://a.example/*"] });
    await flush();
    assert.equal(fake.permissionChecks.length, 2);
    assert.deepEqual(events, []);
  });

  it("never lets an older answer overwrite a newer one", async (t) => {
    const { elements, events, answers } = setupManual(t);
    answers.check();
    answers.check();
    answers.resolve(2, false);
    await flush();
    answers.resolve(1, true);
    await flush();
    assert.equal(elements.warning.hidden, false);
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["hidden", false],
      ["announce", SENTENCES.withheld],
    ]);
  });

  it("applies a newer answer after an older one", async (t) => {
    const { elements, events, answers } = setupManual(t);
    answers.check();
    answers.resolve(0, false);
    await flush();
    answers.resolve(1, true);
    await flush();
    assert.equal(elements.warning.hidden, true);
    assert.deepEqual(events.at(-1), ["announce", SENTENCES.granted]);
  });

  it("logs a failed check and keeps what it shows", async (t) => {
    const { elements, events, answers, warnings } = setupManual(t);
    answers.resolve(0, false);
    await flush();
    answers.check();
    answers.reject(1, new Error("No such extension."));
    await flush();
    assert.equal(elements.warning.hidden, false);
    assert.equal(events.length, 3);
    assert.deepEqual(warnings(), [
      { event: "website_access_check_failed", error: "Error: No such extension." },
    ]);
  });

  it("asks Firefox for exactly <all_urls> before the click listener returns", async (t) => {
    const { click, fake } = setup(t, { allUrls: false });
    await flush();
    click();
    assert.deepEqual(fake.permissionRequests, [["<all_urls>"]]);
  });

  it("hides the warning and announces the grant once when the request is granted", async (t) => {
    const { click, elements, events, fake } = setup(t, { allUrls: false });
    await flush();
    events.length = 0;
    click();
    await flush();
    assert.equal(elements.warning.hidden, true);
    assert.deepEqual(events, [
      ["beforeChange", true],
      ["hidden", true],
      ["announce", SENTENCES.granted],
    ]);
    assert.equal(fake.allUrls, true);
  });

  it("checks again when a request is granted with no permission event", async (t) => {
    const { click, elements, events, fake } = setup(t, { allUrls: false });
    await flush();
    events.length = 0;
    fake.allUrls = true;
    click();
    await flush();
    assert.equal(elements.warning.hidden, true);
    assert.deepEqual(events, [
      ["beforeChange", true],
      ["hidden", true],
      ["announce", SENTENCES.granted],
    ]);
  });

  it("announces a refusal and asks again on the next click", async (t) => {
    const { click, elements, events, fake } = setup(t, { allUrls: false });
    await flush();
    events.length = 0;
    fake.requestAnswer = false;
    click();
    await flush();
    assert.equal(elements.warning.hidden, false);
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["announce", SENTENCES.refused],
    ]);
    click();
    assert.equal(fake.permissionRequests.length, 2);
  });

  it("announces nothing for a refusal once the page shows the access as given", async (t) => {
    const { click, events, fake } = setup(t, { allUrls: false });
    await flush();
    let refuse: (granted: boolean) => void = () => {};
    fake.browser.permissions.request = () =>
      new Promise<boolean>((resolve) => {
        refuse = resolve;
      });
    click();
    fake.setAllUrls(true);
    await flush();
    events.length = 0;
    refuse(false);
    await flush();
    assert.deepEqual(events, []);
  });

  it("only logs a failed request once the page shows the access as given", async (t) => {
    const { click, events, fake, warnings } = setup(t, { allUrls: false });
    await flush();
    let fail: (error: Error) => void = () => {};
    fake.browser.permissions.request = () =>
      new Promise<boolean>((_resolve, reject) => {
        fail = reject;
      });
    click();
    fake.setAllUrls(true);
    await flush();
    events.length = 0;
    fail(new Error("The page went away."));
    await flush();
    assert.deepEqual(events, []);
    assert.deepEqual(warnings(), [
      { event: "website_access_request_failed", error: "Error: The page went away." },
    ]);
  });

  it("says Firefox could not ask when the request fails, and asks again", async (t) => {
    const { click, elements, events, fake, warnings } = setup(t, { allUrls: false });
    await flush();
    events.length = 0;
    fake.requestAnswer = new Error("Not now.");
    click();
    await flush();
    assert.equal(elements.warning.hidden, false);
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["announce", SENTENCES.failed],
    ]);
    assert.ok(SENTENCES.failed.includes(ALL_WEBSITES_ACCESS_STEPS));
    assert.deepEqual(warnings(), [
      { event: "website_access_request_failed", error: "Error: Not now." },
    ]);
    click();
    assert.equal(fake.permissionRequests.length, 2);
  });

  it("says Firefox could not ask when the request throws, and asks again", async (t) => {
    const { click, events, fake, warnings } = setup(t, { allUrls: false });
    await flush();
    events.length = 0;
    let calls = 0;
    fake.browser.permissions.request = () => {
      calls += 1;
      throw new Error("Type error for parameter permissions.");
    };
    click();
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["announce", SENTENCES.failed],
    ]);
    assert.deepEqual(warnings(), [
      {
        event: "website_access_request_failed",
        error: "Error: Type error for parameter permissions.",
      },
    ]);
    click();
    assert.equal(calls, 2);
  });

  it("asks nothing on a second click while a request is out", async (t) => {
    const { click, fake } = setup(t, { allUrls: false });
    await flush();
    fake.requestAnswer = false;
    click();
    click();
    assert.equal(fake.permissionRequests.length, 1);
    await flush();
  });

  it("tells the page a request is out until its answer, before the grant changes anything", async (t) => {
    const { click, events, fake } = setup(t, { allUrls: false, onRequest: true });
    await flush();
    events.length = 0;
    let answer: (granted: boolean) => void = () => {};
    fake.browser.permissions.request = () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    click();
    assert.deepEqual(events, [["request", true]]);
    await flush();
    assert.deepEqual(events, [["request", true]]);
    fake.allUrls = true;
    answer(true);
    await flush();
    assert.deepEqual(events, [
      ["request", true],
      ["request", false],
      ["beforeChange", true],
      ["hidden", true],
      ["announce", SENTENCES.granted],
    ]);
  });

  it("tells the page a refused request is no longer out before announcing the refusal", async (t) => {
    const { click, events, fake } = setup(t, { allUrls: false, onRequest: true });
    await flush();
    events.length = 0;
    fake.requestAnswer = false;
    click();
    await flush();
    assert.deepEqual(events, [
      ["request", true],
      ["request", false],
      ["beforeChange", false],
      ["announce", SENTENCES.refused],
    ]);
  });

  it("tells the page a failed request is no longer out before saying Firefox could not ask", async (t) => {
    const { click, events, fake } = setup(t, { allUrls: false, onRequest: true });
    await flush();
    events.length = 0;
    fake.requestAnswer = new Error("Not now.");
    click();
    await flush();
    assert.deepEqual(events, [
      ["request", true],
      ["request", false],
      ["beforeChange", false],
      ["announce", SENTENCES.failed],
    ]);
  });

  it("tells the page of no request when asking throws, nor of a second click while one is out", async (t) => {
    const { click, events, fake } = setup(t, { allUrls: false, onRequest: true });
    await flush();
    events.length = 0;
    const request = fake.browser.permissions.request;
    fake.browser.permissions.request = () => {
      throw new Error("Type error for parameter permissions.");
    };
    click();
    assert.deepEqual(events, [
      ["beforeChange", false],
      ["announce", SENTENCES.failed],
    ]);
    events.length = 0;
    fake.browser.permissions.request = request;
    fake.requestAnswer = false;
    click();
    click();
    assert.deepEqual(events, [["request", true]]);
    await flush();
  });

  it("works without beforeChange", async (t) => {
    const { click, elements, events, fake } = setup(t, { allUrls: false, beforeChange: false });
    await flush();
    fake.requestAnswer = false;
    click();
    await flush();
    assert.equal(elements.warning.hidden, false);
    assert.deepEqual(events, [
      ["hidden", false],
      ["announce", SENTENCES.withheld],
      ["announce", SENTENCES.refused],
    ]);
  });
});

type Event =
  | ["beforeChange", boolean]
  | ["hidden", boolean]
  | ["announce", string]
  | ["request", boolean];

function setup(
  t: TestContext,
  options: { allUrls?: boolean; beforeChange?: boolean; onRequest?: boolean } = {},
) {
  const warn = t.mock.method(console, "warn", () => {});
  const fake = createFakeBrowser();
  fake.allUrls = options.allUrls ?? true;
  const fire = captureAdded(fake);
  const events: Event[] = [];
  const elements = createElements(events);
  let listener: (() => void) | undefined;
  const button = {
    addEventListener(_type: "click", added: () => void): void {
      listener = added;
    },
  };
  watchWebsiteAccess({
    elements: { ...elements, button },
    browser: fake.browser,
    announce: (text) => events.push(["announce", text]),
    ...(options.beforeChange === false
      ? {}
      : { beforeChange: (hiding: boolean) => events.push(["beforeChange", hiding]) }),
    ...(options.onRequest === true
      ? { onRequest: (pending: boolean) => events.push(["request", pending]) }
      : {}),
  });

  function click(): void {
    assert.ok(listener !== undefined, "no click listener");
    listener();
  }

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { click, elements, events, fake, fire, warnings };
}

interface Check {
  resolve(granted: boolean): void;
  reject(error: unknown): void;
}

/** A setup whose `contains` answers only when the test says, in any order. */
function setupManual(t: TestContext) {
  const warn = t.mock.method(console, "warn", () => {});
  const fake = createFakeBrowser();
  const checks: Check[] = [];
  fake.browser.permissions.contains = () =>
    new Promise<boolean>((resolve, reject) => {
      checks.push({ resolve, reject });
    });
  const fire = captureAdded(fake);
  const events: Event[] = [];
  const elements = createElements(events);
  watchWebsiteAccess({
    elements: { ...elements, button: { addEventListener: () => {} } },
    browser: fake.browser,
    announce: (text) => events.push(["announce", text]),
    beforeChange: (hiding) => events.push(["beforeChange", hiding]),
  });

  const answers = {
    /** Asks again, as a permission event does. */
    check(): void {
      fire({ permissions: [], origins: ["https://a.example/*"] });
    },
    resolve(index: number, granted: boolean): void {
      checkAt(index).resolve(granted);
    },
    reject(index: number, error: unknown): void {
      checkAt(index).reject(error);
    },
  };

  function checkAt(index: number): Check {
    const check = checks[index];
    assert.ok(check !== undefined, `no check ${index}`);
    return check;
  }

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { elements, events, answers, warnings };
}

function createElements(events: Event[]) {
  let hidden = true;
  return {
    warning: {
      get hidden(): boolean {
        return hidden;
      },
      set hidden(value: boolean) {
        hidden = value;
        events.push(["hidden", value]);
      },
    },
    steps: { textContent: "" },
  };
}

/** Records the listeners added to `permissions.onAdded`, and returns what fires them. */
function captureAdded(fake: FakeBrowser): (permissions: Permissions) => void {
  const listeners: ((permissions: Permissions) => void)[] = [];
  const event = fake.browser.permissions.onAdded;
  const addListener = event.addListener;
  event.addListener = (listener) => {
    listeners.push(listener);
    addListener(listener);
  };
  return (permissions) => {
    for (const listener of listeners) listener(permissions);
  };
}
