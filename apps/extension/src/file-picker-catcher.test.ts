import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import vm from "node:vm";
import { UPLOAD_PICKER_WAIT_MS } from "@foxleash/protocol";
import { createFakeTimers, type FakeTimers } from "./fake-browser.ts";
import {
  armPickerCatch,
  CATCHER_OPTIONS,
  type CatcherOptions,
  type CatcherPage,
  catchFilePickers,
  FILE_PICKER_ARM_EVENT,
  FILE_PICKER_ARMED_EVENT,
  FILE_PICKER_CAUGHT_EVENT,
  FILE_PICKER_DISARM_EVENT,
  type PickerCatch,
} from "./file-picker-catcher.ts";

const SITE = "https://a.example";
const OPTIONS: CatcherOptions = {
  armEvent: "test-arm",
  armedEvent: "test-armed",
  caughtEvent: "test-caught",
  disarmEvent: "test-disarm",
  maxArmedMs: 1000,
};

interface Call {
  method: string;
  self: unknown;
  args: unknown[];
}

interface FakeNode {
  readonly ownerDocument: object;
}

interface FakeInput extends FakeNode {
  readonly type: string;
  click(...args: unknown[]): unknown;
  showPicker(...args: unknown[]): unknown;
}

/**
 * A window as far as the catcher reads it: Node, HTMLElement and HTMLInputElement whose `type`
 * and `ownerDocument` getters throw on anything they did not make, as native getters do, and
 * whose `click` and `showPicker` note every call. `skew` moves `performance.now` ahead of the
 * timers, as Firefox's delayed timers in a hidden tab leave it.
 */
class FakePage extends EventTarget {
  readonly calls: Call[] = [];
  readonly location: { protocol: string; hostname: string; port: string };
  readonly document = { name: "the page's document" };
  readonly other = { name: "another document" };
  readonly Node: { prototype: object; new (owner: object): FakeNode };
  readonly HTMLElement: { prototype: object; new (owner: object): FakeNode };
  readonly HTMLInputElement: { prototype: object; new (owner: object, type: string): FakeInput };
  readonly CustomEvent = CustomEvent;
  readonly timers: FakeTimers = createFakeTimers();
  readonly performance = { now: () => this.timers.now() + this.skew };
  readonly setTimeout = this.timers.setTimeout;
  readonly clearTimeout = this.timers.clearTimeout;
  skew = 0;

  constructor(href = `${SITE}/page`) {
    super();
    const url = new URL(href);
    this.location = { protocol: url.protocol, hostname: url.hostname, port: url.port };
    const calls = this.calls;
    const owners = new WeakMap<object, object>();
    const types = new WeakMap<object, string>();
    class Node {
      constructor(owner: object) {
        owners.set(this, owner);
      }
    }
    Object.defineProperty(Node.prototype, "ownerDocument", {
      get(this: object) {
        const owner = owners.get(this);
        if (owner === undefined) throw new TypeError("not a node");
        return owner;
      },
      enumerable: true,
      configurable: true,
    });
    class HTMLElement extends Node {}
    class HTMLInputElement extends HTMLElement {
      constructor(owner: object, type: string) {
        super(owner);
        types.set(this, type);
      }
    }
    Object.defineProperty(HTMLInputElement.prototype, "type", {
      get(this: object) {
        const type = types.get(this);
        if (type === undefined) throw new TypeError("not an input");
        return type;
      },
      enumerable: true,
      configurable: true,
    });
    // As WebIDL defines operations: writable, enumerable and configurable.
    for (const [prototype, method] of [
      [HTMLElement.prototype, "click"],
      [HTMLInputElement.prototype, "showPicker"],
    ] as const) {
      Object.defineProperty(prototype, method, {
        value: function (this: unknown, ...args: unknown[]): unknown {
          // Not push: the call must not depend on what the catcher leaves on Array.prototype.
          calls[calls.length] = { method, self: this, args };
          if (args[0] === "throw") throw new Error(`${method} threw`);
          return `${method} returned`;
        },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    this.Node = Node as unknown as FakePage["Node"];
    this.HTMLElement = HTMLElement as FakePage["HTMLElement"];
    this.HTMLInputElement = HTMLInputElement as unknown as FakePage["HTMLInputElement"];
  }

  input(type = "file", owner: object = this.document): FakeInput {
    return new this.HTMLInputElement(owner, type);
  }

  element(): FakeInput {
    return new this.HTMLElement(this.document) as FakeInput;
  }

  /** The current own descriptors of the two methods. */
  descriptors(): (PropertyDescriptor | undefined)[] {
    return [
      Object.getOwnPropertyDescriptor(this.HTMLElement.prototype, "click"),
      Object.getOwnPropertyDescriptor(this.HTMLInputElement.prototype, "showPicker"),
    ];
  }

  /** Arms the catcher; whether it answered. */
  arm(): boolean {
    let answered = 0;
    const listener = () => {
      answered += 1;
    };
    this.addEventListener(OPTIONS.armedEvent, listener);
    this.dispatchEvent(new CustomEvent(OPTIONS.armEvent));
    this.removeEventListener(OPTIONS.armedEvent, listener);
    assert.ok(answered <= 1);
    return answered === 1;
  }

  disarm(): void {
    this.dispatchEvent(new CustomEvent(OPTIONS.disarmEvent));
  }

  /** Every detail the catcher dispatches from now on. */
  caught(): unknown[] {
    const details: unknown[] = [];
    this.addEventListener(OPTIONS.caughtEvent, (event) => {
      details.push((event as CustomEvent<unknown>).detail);
    });
    return details;
  }
}

describe("CATCHER_OPTIONS", () => {
  it("names the events, and stays armed at most twice the picker wait", () => {
    assert.deepEqual(CATCHER_OPTIONS, {
      armEvent: FILE_PICKER_ARM_EVENT,
      armedEvent: FILE_PICKER_ARMED_EVENT,
      caughtEvent: FILE_PICKER_CAUGHT_EVENT,
      disarmEvent: FILE_PICKER_DISARM_EVENT,
      maxArmedMs: 10_000,
    });
    assert.equal(FILE_PICKER_ARM_EVENT, "foxleash-file-picker-arm");
    assert.equal(FILE_PICKER_ARMED_EVENT, "foxleash-file-picker-armed");
    assert.equal(FILE_PICKER_CAUGHT_EVENT, "foxleash-file-picker-caught");
    assert.equal(FILE_PICKER_DISARM_EVENT, "foxleash-file-picker-disarm");
    assert.equal(UPLOAD_PICKER_WAIT_MS, 5_000);
  });
});

describe("catchFilePickers", () => {
  it("installs once per document", () => {
    const page = new FakePage();
    assert.equal(catchFilePickers(SITE, OPTIONS, asPage(page)), "installed");
    assert.deepEqual(Object.getOwnPropertyDescriptor(page, "__foxleashFilePicker"), {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    assert.equal(catchFilePickers(SITE, OPTIONS, asPage(page)), "present");
    assert.ok(page.arm());
    page.disarm();
  });

  it("matches the site by scheme, host without a trailing dot, and port", () => {
    assert.equal(
      catchFilePickers(SITE, OPTIONS, asPage(new FakePage("https://a.example./x"))),
      "installed",
    );
    assert.equal(
      catchFilePickers(
        "http://a.example:8080",
        OPTIONS,
        asPage(new FakePage("http://a.example:8080/")),
      ),
      "installed",
    );
    for (const href of ["http://a.example/", "https://b.example/", "https://a.example:8443/"]) {
      const page = new FakePage(href);
      assert.equal(catchFilePickers(SITE, OPTIONS, asPage(page)), "elsewhere", href);
      assert.equal(Object.hasOwn(page, "__foxleashFilePicker"), false, href);
      assert.equal(page.arm(), false, href);
    }
  });

  it("does nothing in a page that set its marker first", () => {
    const page = new FakePage();
    Object.defineProperty(page, "__foxleashFilePicker", { value: false });
    assert.equal(catchFilePickers(SITE, OPTIONS, asPage(page)), "present");
    assert.equal(page.arm(), false);
  });

  it("does nothing in a page where the marker cannot be set", () => {
    const page = new FakePage();
    Object.preventExtensions(page);
    assert.equal(catchFilePickers(SITE, OPTIONS, asPage(page)), "refused");
    assert.equal(page.arm(), false);
  });

  it("changes nothing until armed, and lets the page's own pickers through", () => {
    const page = new FakePage();
    const before = page.descriptors();
    installed(page);
    assert.deepEqual(page.descriptors(), before);
    const caught = page.caught();
    const input = page.input();
    assert.equal(input.click(), "click returned");
    assert.equal(input.showPicker(), "showPicker returned");
    assert.deepEqual(page.calls, [
      { method: "click", self: input, args: [] },
      { method: "showPicker", self: input, args: [] },
    ]);
    assert.deepEqual(caught, []);
  });

  for (const method of ["click", "showPicker"] as const) {
    it(`swallows the first ${method}() on a file field of the document while armed, and hands the field over`, () => {
      const page = installed(new FakePage());
      const caught = page.caught();
      assert.ok(page.arm());
      const input = page.input();
      assert.equal(input[method]("an argument"), undefined);
      assert.deepEqual(page.calls, []);
      assert.equal(caught.length, 1);
      assert.equal(caught[0], input);
      assert.equal(input[method](), `${method} returned`);
      assert.deepEqual(page.calls, [{ method, self: input, args: [] }]);
      assert.equal(caught.length, 1);
    });
  }

  it("passes every other call to the original, with its this, arguments, value and throw", () => {
    const page = installed(new FakePage());
    const caught = page.caught();
    assert.ok(page.arm());
    const text = page.input("text");
    const element = page.element();
    const foreign = page.input("file", page.other);
    const notANode = { name: "not a node" };
    const click = Object.getOwnPropertyDescriptor(page.HTMLElement.prototype, "click")?.value;
    const showPicker = Object.getOwnPropertyDescriptor(
      page.HTMLInputElement.prototype,
      "showPicker",
    )?.value;
    assert.equal(text.click(1, "two"), "click returned");
    assert.equal(text.showPicker(3), "showPicker returned");
    assert.equal(element.click(), "click returned");
    assert.equal(foreign.click(4), "click returned");
    assert.equal(foreign.showPicker(), "showPicker returned");
    assert.equal(Reflect.apply(click, notANode, [5]), "click returned");
    assert.equal(Reflect.apply(showPicker, undefined, []), "showPicker returned");
    assert.throws(() => text.click("throw"), { message: "click threw" });
    assert.throws(() => foreign.showPicker("throw"), { message: "showPicker threw" });
    assert.deepEqual(page.calls, [
      { method: "click", self: text, args: [1, "two"] },
      { method: "showPicker", self: text, args: [3] },
      { method: "click", self: element, args: [] },
      { method: "click", self: foreign, args: [4] },
      { method: "showPicker", self: foreign, args: [] },
      { method: "click", self: notANode, args: [5] },
      { method: "showPicker", self: undefined, args: [] },
      { method: "click", self: text, args: ["throw"] },
      { method: "showPicker", self: foreign, args: ["throw"] },
    ]);
    assert.deepEqual(caught, []);
    const input = page.input();
    input.click();
    assert.deepEqual(caught, [input]);
  });

  it("wraps with the original's attributes, and puts the original back exactly on disarm", () => {
    const page = new FakePage();
    const original = Object.getOwnPropertyDescriptor(page.HTMLElement.prototype, "click");
    Object.defineProperty(page.HTMLElement.prototype, "click", {
      ...original,
      writable: false,
      enumerable: false,
    });
    const before = page.descriptors();
    installed(page);
    assert.ok(page.arm());
    const [click, showPicker] = page.descriptors();
    assert.notEqual(click?.value, before[0]?.value);
    assert.notEqual(showPicker?.value, before[1]?.value);
    assert.deepEqual({ ...click, value: undefined }, { ...before[0], value: undefined });
    assert.deepEqual({ ...showPicker, value: undefined }, { ...before[1], value: undefined });
    page.disarm();
    assert.deepEqual(page.descriptors(), before);
    page.input().click();
    assert.equal(page.calls.length, 1);
  });

  it("puts the originals back once it caught a field", () => {
    const page = new FakePage();
    const before = page.descriptors();
    installed(page);
    assert.ok(page.arm());
    page.input().showPicker();
    assert.deepEqual(page.descriptors(), before);
    assert.equal(page.timers.pending(), 0);
  });

  it("keeps a method the page replaced while armed", () => {
    const page = new FakePage();
    const before = page.descriptors();
    installed(page);
    assert.ok(page.arm());
    const own = () => "the page's own";
    Object.defineProperty(page.HTMLElement.prototype, "click", { value: own });
    page.disarm();
    const [click, showPicker] = page.descriptors();
    assert.equal(click?.value, own);
    assert.deepEqual(showPicker, before[1]);
  });

  it("disarms itself after maxArmedMs", () => {
    const page = new FakePage();
    const before = page.descriptors();
    installed(page);
    const caught = page.caught();
    assert.ok(page.arm());
    page.timers.advance(OPTIONS.maxArmedMs - 1);
    assert.notDeepEqual(page.descriptors(), before);
    page.timers.advance(1);
    assert.deepEqual(page.descriptors(), before);
    page.input().click();
    assert.deepEqual(caught, []);
    assert.equal(page.calls.length, 1);
  });

  it("disarms at the next call once the clock passed maxArmedMs, though its timer did not fire", () => {
    const page = installed(new FakePage());
    const caught = page.caught();
    assert.ok(page.arm());
    page.skew = OPTIONS.maxArmedMs + 1;
    const input = page.input();
    assert.equal(input.click(), "click returned");
    assert.deepEqual(caught, []);
    assert.equal(page.calls.length, 1);
    assert.equal(page.timers.pending(), 0);
    assert.equal(input.showPicker(), "showPicker returned");
    assert.equal(page.calls.length, 2);
  });

  it("catches at the deadline itself", () => {
    const page = installed(new FakePage());
    const caught = page.caught();
    assert.ok(page.arm());
    page.skew = OPTIONS.maxArmedMs;
    const input = page.input();
    input.showPicker();
    assert.deepEqual(caught, [input]);
  });

  it("wraps once when armed twice, and starts its time again", () => {
    const page = new FakePage();
    const before = page.descriptors();
    installed(page);
    assert.ok(page.arm());
    page.timers.advance(OPTIONS.maxArmedMs - 1);
    assert.ok(page.arm());
    assert.equal(page.timers.pending(), 1);
    page.timers.advance(OPTIONS.maxArmedMs - 1);
    const caught = page.caught();
    const input = page.input();
    input.click();
    assert.deepEqual(caught, [input]);
    assert.deepEqual(page.descriptors(), before);
  });

  it("answers no arm when a method cannot be replaced, and leaves both as they were", () => {
    for (const frozen of ["HTMLElement", "HTMLInputElement"] as const) {
      const page = new FakePage();
      Object.freeze(page[frozen].prototype);
      const before = page.descriptors();
      installed(page);
      assert.equal(page.arm(), false, frozen);
      assert.deepEqual(page.descriptors(), before, frozen);
      assert.equal(page.timers.pending(), 0, frozen);
      page.input().click();
      assert.equal(page.calls.length, 1, frozen);
    }
  });

  it("catches click alone where the page has no showPicker", () => {
    const page = new FakePage();
    Reflect.deleteProperty(page.HTMLInputElement.prototype, "showPicker");
    installed(page);
    const caught = page.caught();
    assert.ok(page.arm());
    const input = page.input();
    input.click();
    assert.deepEqual(caught, [input]);
    assert.equal(Object.hasOwn(page.HTMLInputElement.prototype, "showPicker"), false);
  });

  it("disarms on the disarm event, and ignores one while unarmed", () => {
    const page = new FakePage();
    const cleared: unknown[] = [];
    Object.defineProperty(page, "clearTimeout", {
      value: (handle: number) => {
        cleared.push(handle);
        page.timers.clearTimeout(handle);
      },
    });
    const before = page.descriptors();
    installed(page);
    page.disarm();
    assert.deepEqual(cleared, []);
    assert.ok(page.arm());
    page.disarm();
    page.disarm();
    assert.equal(cleared.length, 1);
    assert.deepEqual(page.descriptors(), before);
    assert.equal(page.timers.pending(), 0);
    const caught = page.caught();
    page.input().click();
    assert.deepEqual(caught, []);
  });

  it("never throws into the page when it cannot hand the field over", () => {
    const page = new FakePage();
    const throwing = class extends CustomEvent<unknown> {
      constructor(type: string, init?: CustomEventInit<unknown>) {
        if (type === OPTIONS.caughtEvent) throw new Error("no event");
        super(type, init);
      }
    };
    Object.defineProperty(page, "CustomEvent", { value: throwing });
    installed(page);
    assert.ok(page.arm());
    assert.equal(page.input().click(), undefined);
    assert.deepEqual(page.calls, []);
  });

  it("never throws into the page when it cannot arm", () => {
    const page = new FakePage();
    Object.defineProperty(page, "setTimeout", {
      value: () => {
        throw new Error("no timer");
      },
    });
    const before = page.descriptors();
    installed(page);
    assert.equal(page.arm(), false);
    assert.deepEqual(page.descriptors(), before);
  });

  it("answers no arm when it cannot read the clock, and leaves both methods as they were", () => {
    const page = new FakePage();
    Object.defineProperty(page, "performance", {
      value: {
        now: () => {
          throw new Error("no clock");
        },
      },
    });
    const before = page.descriptors();
    installed(page);
    assert.equal(page.arm(), false);
    assert.deepEqual(page.descriptors(), before);
  });

  it("answers no arm when it cannot read a method", () => {
    const page = new FakePage();
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("no descriptor");
        },
      },
    );
    Object.defineProperty(page, "HTMLElement", { value: { prototype: throwing } });
    installed(page);
    assert.equal(page.arm(), false);
  });

  it("disarms when the page's clearTimeout throws", () => {
    const page = new FakePage();
    Object.defineProperty(page, "clearTimeout", {
      value: () => {
        throw new Error("no clearTimeout");
      },
    });
    const before = page.descriptors();
    installed(page);
    assert.ok(page.arm());
    page.disarm();
    assert.deepEqual(page.descriptors(), before);
    page.timers.advance(OPTIONS.maxArmedMs);
    assert.deepEqual(page.descriptors(), before);
  });

  it("leaves a wrapper the page froze in place, passing every call on once disarmed", () => {
    const page = installed(new FakePage());
    const caught = page.caught();
    assert.ok(page.arm());
    Object.freeze(page.HTMLElement.prototype);
    page.disarm();
    const input = page.input();
    assert.equal(input.click(), "click returned");
    assert.deepEqual(caught, []);
    assert.deepEqual(page.calls, [{ method: "click", self: input, args: [] }]);
  });

  it("does not take a value without the native getters as a file field", () => {
    const page = new FakePage();
    Reflect.deleteProperty(page.HTMLInputElement.prototype, "type");
    installed(page);
    const caught = page.caught();
    assert.ok(page.arm());
    assert.equal(page.input().click(), "click returned");
    assert.deepEqual(caught, []);
  });
});

describe("catchFilePickers from its own text", () => {
  // Firefox runs only the function's own text, so this runs it in a realm with nothing else.
  const MODULE = stripTypeScriptTypes(
    readFileSync(new URL("./file-picker-catcher.ts", import.meta.url), "utf8"),
  )
    .replaceAll(/^import .*$/gm, "")
    .replaceAll(/^export /gm, "");
  const FUNCTION = String(
    vm.runInNewContext(`${MODULE}\ncatchFilePickers.toString();`, { UPLOAD_PICKER_WAIT_MS }),
  );

  it("installs, arms and catches in a fresh realm", () => {
    const fresh: unknown = vm.runInNewContext(`(${FUNCTION})`);
    assert.equal(typeof fresh, "function");
    const page = new FakePage();
    const before = page.descriptors();
    assert.equal((fresh as typeof catchFilePickers)(SITE, OPTIONS, asPage(page)), "installed");
    const caught = page.caught();
    assert.ok(page.arm());
    const input = page.input();
    assert.equal(input.click(), undefined);
    assert.deepEqual(caught, [input]);
    assert.deepEqual(page.descriptors(), before);
  });
});

// A wait that never ends fails here instead of holding the run.
describe("armPickerCatch", { timeout: 5000 }, () => {
  it("refuses when no catcher answers, and leaves nothing behind", () => {
    const target = new CountingTarget();
    const timers = createFakeTimers();
    const details: unknown[] = [];
    const accept = (detail: unknown) => {
      details.push(detail);
      return detail;
    };
    assert.equal(armPickerCatch(target, accept, timers), "unanswered");
    assert.deepEqual(target.listening(), []);
    target.dispatchEvent(caughtEvent("late"));
    assert.deepEqual(details, []);
    answerArm(target);
    const caught = armPickerCatch(target, accept, timers);
    assert.notEqual(typeof caught, "string");
  });

  it("is busy while another catch of the target is live, without arming again", () => {
    const { target, seen } = catcherTarget();
    const timers = createFakeTimers();
    const first = live(armPickerCatch(target, String, timers));
    assert.equal(armPickerCatch(target, String, timers), "busy");
    assert.deepEqual(seen, [FILE_PICKER_ARM_EVENT]);
    first.disarm();
    const second = live(armPickerCatch(target, String, timers));
    second.disarm();
    assert.deepEqual(seen, [
      FILE_PICKER_ARM_EVENT,
      FILE_PICKER_DISARM_EVENT,
      FILE_PICKER_ARM_EVENT,
      FILE_PICKER_DISARM_EVENT,
    ]);
    assert.notEqual(typeof armPickerCatch(new EventTarget(), String, timers), "busy");
  });

  it("resolves at once with a field caught before it waits", async () => {
    const { target } = catcherTarget();
    const timers = createFakeTimers();
    const catcher = live(armPickerCatch(target, acceptFields, timers));
    target.dispatchEvent(caughtEvent("field 1"));
    target.dispatchEvent(caughtEvent("field 2"));
    assert.equal(await catcher.caught(UPLOAD_PICKER_WAIT_MS), "field 1");
    assert.equal(timers.pending(), 0);
    catcher.disarm();
  });

  it("resolves with the first field it accepts while it waits, and clears its timer", async () => {
    const { target } = catcherTarget();
    const timers = createFakeTimers();
    const catcher = live(armPickerCatch(target, acceptFields, timers));
    const waiting = catcher.caught(UPLOAD_PICKER_WAIT_MS);
    assert.equal(timers.pending(), 1);
    target.dispatchEvent(caughtEvent("junk"));
    target.dispatchEvent(caughtEvent("throws"));
    target.dispatchEvent(new CustomEvent(FILE_PICKER_CAUGHT_EVENT));
    timers.advance(UPLOAD_PICKER_WAIT_MS - 1);
    target.dispatchEvent(caughtEvent("field 1"));
    target.dispatchEvent(caughtEvent("field 2"));
    assert.equal(await waiting, "field 1");
    assert.equal(timers.pending(), 0);
    catcher.disarm();
  });

  it("resolves with nothing once the wait is over", async () => {
    const { target } = catcherTarget();
    const timers = createFakeTimers();
    const catcher = live(armPickerCatch(target, acceptFields, timers));
    const waiting = track(catcher.caught(UPLOAD_PICKER_WAIT_MS));
    timers.advance(UPLOAD_PICKER_WAIT_MS - 1);
    await Promise.resolve();
    assert.equal(waiting.settled(), false);
    timers.advance(1);
    assert.equal(await waiting.promise, undefined);
    target.dispatchEvent(caughtEvent("field 1"));
    catcher.disarm();
  });

  it("ignores a field after the deadline, though its timer did not fire", async () => {
    const { target } = catcherTarget();
    const timers = createFakeTimers();
    let skew = 0;
    const clock = { ...timers, now: () => timers.now() + skew };
    const catcher = live(armPickerCatch(target, acceptFields, clock));
    const waiting = catcher.caught(UPLOAD_PICKER_WAIT_MS);
    skew = UPLOAD_PICKER_WAIT_MS + 1;
    target.dispatchEvent(caughtEvent("field 1"));
    skew = 0;
    timers.advance(UPLOAD_PICKER_WAIT_MS);
    assert.equal(await waiting, undefined);
    catcher.disarm();
  });

  it("takes a field at the deadline itself", async () => {
    const { target } = catcherTarget();
    const timers = createFakeTimers();
    let skew = 0;
    const clock = { ...timers, now: () => timers.now() + skew };
    const catcher = live(armPickerCatch(target, acceptFields, clock));
    const waiting = catcher.caught(UPLOAD_PICKER_WAIT_MS);
    skew = UPLOAD_PICKER_WAIT_MS;
    target.dispatchEvent(caughtEvent("field 1"));
    assert.equal(await waiting, "field 1");
    catcher.disarm();
  });

  it("disarms once, stops listening, and ends a wait", async () => {
    const { target, seen } = catcherTarget(new CountingTarget());
    const timers = createFakeTimers();
    const details: unknown[] = [];
    const catcher = live(
      armPickerCatch(
        target,
        (detail) => {
          details.push(detail);
          return undefined;
        },
        timers,
      ),
    );
    const waiting = catcher.caught(UPLOAD_PICKER_WAIT_MS);
    assert.deepEqual(target.listening(), [FILE_PICKER_CAUGHT_EVENT]);
    catcher.disarm();
    catcher.disarm();
    assert.deepEqual(target.listening(), []);
    assert.equal(await waiting, undefined);
    assert.equal(timers.pending(), 0);
    assert.deepEqual(seen, [FILE_PICKER_ARM_EVENT, FILE_PICKER_DISARM_EVENT]);
    target.dispatchEvent(caughtEvent("field 1"));
    assert.deepEqual(details, []);
    assert.equal(await catcher.caught(UPLOAD_PICKER_WAIT_MS), undefined);
    assert.equal(timers.pending(), 0);
  });

  it("arms the page's catcher and gets the file field the page asks a picker for", async () => {
    const page = new FakePage();
    const before = page.descriptors();
    assert.equal(catchFilePickers(SITE, CATCHER_OPTIONS, asPage(page)), "installed");
    const timers = createFakeTimers();
    const input = page.input();
    const catcher = live(
      armPickerCatch(page, (detail) => (detail === input ? input : undefined), timers),
    );
    assert.notDeepEqual(page.descriptors(), before);
    const waiting = catcher.caught(UPLOAD_PICKER_WAIT_MS);
    page.input("file", page.other).click();
    input.click();
    assert.equal(await waiting, input);
    catcher.disarm();
    assert.deepEqual(page.descriptors(), before);
    assert.deepEqual(
      page.calls.map(({ method, self }) => [method, self === input]),
      [["click", false]],
    );
  });
});

function installed(page: FakePage): FakePage {
  assert.equal(catchFilePickers(SITE, OPTIONS, asPage(page)), "installed");
  return page;
}

function asPage(page: FakePage): CatcherPage {
  return page;
}

/**
 * An EventTarget that counts the listeners added through it, of the event types `armPickerCatch`
 * listens for.
 */
class CountingTarget extends EventTarget {
  readonly #counts = new Map<string, number>();

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.#count(args[0], 1);
    super.addEventListener(...args);
  }

  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
    this.#count(args[0], -1);
    super.removeEventListener(...args);
  }

  /** The types with a listener of `armPickerCatch`'s left. */
  listening(): string[] {
    return [...this.#counts].filter(([, count]) => count > 0).map(([type]) => type);
  }

  #count(type: string, change: number): void {
    if (type !== FILE_PICKER_CAUGHT_EVENT && type !== FILE_PICKER_ARMED_EVENT) return;
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + change);
  }
}

/** A target that answers the arm event as the catcher does, and notes the arm and disarm events. */
function catcherTarget<T extends EventTarget>(
  target: T = new EventTarget() as T,
): { target: T; seen: string[] } {
  const seen: string[] = [];
  for (const type of [FILE_PICKER_ARM_EVENT, FILE_PICKER_DISARM_EVENT]) {
    target.addEventListener(type, () => seen.push(type));
  }
  answerArm(target);
  return { target, seen };
}

function answerArm(target: EventTarget): void {
  target.addEventListener(FILE_PICKER_ARM_EVENT, () => {
    target.dispatchEvent(new CustomEvent(FILE_PICKER_ARMED_EVENT));
  });
}

function caughtEvent(detail: unknown): CustomEvent<unknown> {
  return new CustomEvent(FILE_PICKER_CAUGHT_EVENT, { detail });
}

/** Takes details that start with "field", and throws on "throws". */
function acceptFields(detail: unknown): string | undefined {
  if (detail === "throws") throw new Error("cannot read it");
  return typeof detail === "string" && detail.startsWith("field") ? detail : undefined;
}

function live<T>(catcher: PickerCatch<T> | "busy" | "unanswered"): PickerCatch<T> {
  assert.ok(typeof catcher !== "string", String(catcher));
  return catcher;
}

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise, settled: () => settled };
}
