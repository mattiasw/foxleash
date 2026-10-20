import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clickOptions,
  crossSiteDestination,
  defaultAmount,
  dragOptions,
  dragPoints,
  dragResultOf,
  formDestination,
  fullyInside,
  hoverOptions,
  hoverTransitions,
  pointResultOf,
  scrollDelta,
  scrollOptions,
  scrollResultOf,
  viewportOverflow,
  visiblePoint,
  wheelScrolls,
} from "./page-actions.ts";

const REF = "0a1b2c3d-4";
const OTHER_REF = "0a1b2c3d-17";
const NOT_COORDINATES: readonly unknown[] = [
  -1,
  -0.001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "1",
  null,
  true,
];
const PAGE = "https://example.com/shop/cart?step=2";

describe("clickOptions", () => {
  it("takes a ref or a point, with the left button once by default", () => {
    assert.deepEqual(clickOptions({ ref: REF }), { ref: REF, button: "left", doubleClick: false });
    assert.deepEqual(clickOptions({ ref: "anything" }), {
      ref: "anything",
      button: "left",
      doubleClick: false,
    });
    assert.deepEqual(clickOptions({ x: 0, y: 12.5 }), {
      x: 0,
      y: 12.5,
      button: "left",
      doubleClick: false,
    });
    assert.deepEqual(clickOptions({ x: 3, y: 4, button: "right", doubleClick: false }), {
      x: 3,
      y: 4,
      button: "right",
      doubleClick: false,
    });
    assert.deepEqual(clickOptions({ ref: REF, button: "left", doubleClick: true }), {
      ref: REF,
      button: "left",
      doubleClick: true,
    });
  });

  it("keeps only the known fields", () => {
    const options = clickOptions({ tabId: 3, ref: REF, extra: true, x: undefined });
    assert.deepEqual(Object.keys(options), ["ref", "button", "doubleClick"]);
  });

  it("refuses a ref with a point, neither, or one coordinate alone", () => {
    const message = "click needs either ref or both x and y, not both and not neither.";
    for (const params of [
      {},
      { ref: REF, x: 1, y: 2 },
      { ref: REF, x: 1 },
      { ref: REF, y: 2 },
      { x: 1 },
      { y: 1 },
      { button: "left" },
    ]) {
      assert.equal(clickOptions(params), message, JSON.stringify(params));
    }
  });

  it("refuses a ref that is not a string", () => {
    for (const ref of [1, null, {}, ["a"]]) {
      assert.equal(clickOptions({ ref }), "click needs ref to be a string.");
    }
  });

  it("refuses coordinates that are not finite numbers of 0 or more", () => {
    for (const bad of NOT_COORDINATES) {
      assert.equal(
        clickOptions({ x: bad, y: 1 }),
        "click needs x and y to be numbers of 0 or more.",
      );
      assert.equal(
        clickOptions({ x: 1, y: bad }),
        "click needs x and y to be numbers of 0 or more.",
      );
    }
  });

  it("refuses a button other than left or right", () => {
    for (const button of ["middle", "Left", 0, null]) {
      assert.equal(clickOptions({ ref: REF, button }), "click needs button to be left or right.");
    }
  });

  it("refuses a doubleClick that is not a boolean", () => {
    for (const doubleClick of ["true", 1, null]) {
      assert.equal(
        clickOptions({ ref: REF, doubleClick }),
        "click needs doubleClick to be true or false.",
      );
    }
  });

  it("refuses doubleClick with the right button", () => {
    assert.equal(
      clickOptions({ ref: REF, button: "right", doubleClick: true }),
      "click takes doubleClick only with the left button.",
    );
  });

  it("ignores inherited fields", () => {
    assert.equal(
      clickOptions(Object.create({ ref: REF })),
      "click needs either ref or both x and y, not both and not neither.",
    );
    const inherited = Object.assign(Object.create({ button: "middle", doubleClick: "no" }), {
      ref: REF,
    });
    assert.deepEqual(clickOptions(inherited), { ref: REF, button: "left", doubleClick: false });
  });

  it("gives back the same options when it parses its own result", () => {
    for (const params of [
      { ref: REF },
      { x: 1, y: 2, button: "right" },
      { ref: REF, doubleClick: true },
    ]) {
      const options = clickOptions(params);
      assert.ok(typeof options !== "string");
      assert.deepEqual(clickOptions(options), options);
    }
  });
});

describe("hoverOptions", () => {
  it("takes a ref or a point", () => {
    assert.deepEqual(hoverOptions({ ref: REF, extra: 1 }), { ref: REF });
    assert.deepEqual(hoverOptions({ x: 5, y: 0 }), { x: 5, y: 0 });
  });

  it("refuses what click refuses about the target, naming hover", () => {
    assert.equal(
      hoverOptions({ ref: REF, x: 1, y: 1 }),
      "hover needs either ref or both x and y, not both and not neither.",
    );
    assert.equal(
      hoverOptions({}),
      "hover needs either ref or both x and y, not both and not neither.",
    );
    assert.equal(hoverOptions({ ref: 7 }), "hover needs ref to be a string.");
    assert.equal(hoverOptions({ x: -1, y: 1 }), "hover needs x and y to be numbers of 0 or more.");
  });
});

describe("scrollOptions", () => {
  const how =
    "scroll needs a direction to scroll at x and y or at the centre of the page, or a ref to scroll into view.";

  it("takes a ref alone to scroll it into view", () => {
    assert.deepEqual(scrollOptions({ ref: REF, tabId: 1 }), { ref: REF });
  });

  it("takes a direction at a ref, at a point or at the centre, with an amount or not", () => {
    assert.deepEqual(scrollOptions({ direction: "down" }), { direction: "down" });
    assert.deepEqual(scrollOptions({ ref: REF, direction: "up", amount: 1 }), {
      ref: REF,
      direction: "up",
      amount: 1,
    });
    assert.deepEqual(scrollOptions({ x: 0, y: 4, direction: "left", amount: 300 }), {
      x: 0,
      y: 4,
      direction: "left",
      amount: 300,
    });
    assert.deepEqual(scrollOptions({ direction: "right" }), { direction: "right" });
  });

  it("refuses a ref with a point, or one coordinate alone", () => {
    assert.equal(
      scrollOptions({ ref: REF, x: 1, direction: "down" }),
      "scroll takes either ref or both x and y, not both.",
    );
    assert.equal(
      scrollOptions({ ref: REF, y: 1, direction: "down" }),
      "scroll takes either ref or both x and y, not both.",
    );
    assert.equal(
      scrollOptions({ x: 1, direction: "down" }),
      "scroll needs both x and y, not one of them.",
    );
    assert.equal(
      scrollOptions({ y: 1, direction: "down" }),
      "scroll needs both x and y, not one of them.",
    );
  });

  it("refuses a bad ref, point, direction or amount", () => {
    assert.equal(scrollOptions({ ref: 3 }), "scroll needs ref to be a string.");
    for (const bad of NOT_COORDINATES) {
      assert.equal(
        scrollOptions({ x: bad, y: 1, direction: "down" }),
        "scroll needs x and y to be numbers of 0 or more.",
      );
      assert.equal(
        scrollOptions({ x: 1, y: bad, direction: "down" }),
        "scroll needs x and y to be numbers of 0 or more.",
      );
    }
    for (const direction of ["forward", "Down", 1, null]) {
      assert.equal(
        scrollOptions({ direction }),
        "scroll needs direction to be up, down, left or right.",
      );
    }
    for (const amount of [0, -5, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
      assert.equal(
        scrollOptions({ direction: "down", amount }),
        "scroll needs amount to be a whole number of 1 or more.",
      );
    }
  });

  it("refuses scrolling with no direction anywhere but into view of a ref", () => {
    assert.equal(scrollOptions({}), how);
    assert.equal(scrollOptions({ x: 1, y: 2 }), how);
    assert.equal(
      scrollOptions({ ref: REF, amount: 10 }),
      "scroll takes amount only with a direction.",
    );
    assert.equal(scrollOptions({ amount: 10 }), "scroll takes amount only with a direction.");
  });

  it("ignores inherited fields", () => {
    assert.equal(scrollOptions(Object.create({ direction: "down" })), how);
    const inherited = Object.assign(Object.create({ amount: 0, x: 1 }), { direction: "down" });
    assert.deepEqual(scrollOptions(inherited), { direction: "down" });
  });

  it("gives back the same options when it parses its own result", () => {
    for (const params of [
      { ref: REF },
      { direction: "down" },
      { ref: REF, direction: "up", amount: 5 },
      { x: 1, y: 2, direction: "left" },
    ]) {
      const options = scrollOptions(params);
      assert.ok(typeof options !== "string");
      assert.deepEqual(scrollOptions(options), options);
    }
  });
});

describe("dragOptions", () => {
  it("takes a ref or a point at each end", () => {
    assert.deepEqual(dragOptions({ ref: REF, targetRef: OTHER_REF, extra: 1 }), {
      ref: REF,
      targetRef: OTHER_REF,
    });
    assert.deepEqual(dragOptions({ x: 1, y: 2, targetX: 0, targetY: 4.5 }), {
      x: 1,
      y: 2,
      targetX: 0,
      targetY: 4.5,
    });
    assert.deepEqual(dragOptions({ ref: REF, targetX: 3, targetY: 4 }), {
      ref: REF,
      targetX: 3,
      targetY: 4,
    });
  });

  it("refuses a start with both or neither, or one coordinate", () => {
    const message =
      "drag needs either ref or both x and y for the start, not both and not neither.";
    for (const params of [
      { targetRef: REF },
      { ref: REF, x: 1, y: 2, targetRef: REF },
      { x: 1, targetRef: REF },
      { y: 1, targetRef: REF },
    ]) {
      assert.equal(dragOptions(params), message, JSON.stringify(params));
    }
  });

  it("refuses an end with both or neither, or one coordinate", () => {
    const message =
      "drag needs either targetRef or both targetX and targetY for the end, not both and not neither.";
    for (const params of [
      { ref: REF },
      { ref: REF, targetRef: REF, targetX: 1, targetY: 2 },
      { ref: REF, targetRef: REF, targetY: 2 },
      { ref: REF, targetX: 1 },
      { ref: REF, targetY: 1 },
    ]) {
      assert.equal(dragOptions(params), message, JSON.stringify(params));
    }
  });

  it("refuses bad values at either end", () => {
    assert.equal(dragOptions({ ref: 1, targetRef: REF }), "drag needs ref to be a string.");
    assert.equal(dragOptions({ ref: REF, targetRef: 1 }), "drag needs targetRef to be a string.");
    for (const bad of NOT_COORDINATES) {
      assert.equal(
        dragOptions({ x: bad, y: 0, targetRef: REF }),
        "drag needs x and y to be numbers of 0 or more.",
      );
      assert.equal(
        dragOptions({ ref: REF, targetX: bad, targetY: 0 }),
        "drag needs targetX and targetY to be numbers of 0 or more.",
      );
      assert.equal(
        dragOptions({ ref: REF, targetX: 0, targetY: bad }),
        "drag needs targetX and targetY to be numbers of 0 or more.",
      );
    }
  });

  it("ignores inherited fields", () => {
    assert.equal(
      dragOptions(Object.assign(Object.create({ targetRef: REF }), { ref: REF })),
      "drag needs either targetRef or both targetX and targetY for the end, not both and not neither.",
    );
  });

  it("gives back the same options when it parses its own result", () => {
    for (const params of [
      { ref: REF, targetRef: OTHER_REF },
      { x: 1, y: 2, targetX: 3, targetY: 4 },
    ]) {
      const options = dragOptions(params);
      assert.ok(typeof options !== "string");
      assert.deepEqual(dragOptions(options), options);
    }
  });
});

describe("pointResultOf", () => {
  it("accepts a ref and a point, and drops anything else", () => {
    assert.deepEqual(pointResultOf({ ref: REF, x: 0, y: 12.5, extra: "page" }), {
      ref: REF,
      x: 0,
      y: 12.5,
    });
  });

  it("refuses a reply of the wrong shape", () => {
    const good = { ref: REF, x: 1, y: 2 };
    for (const reply of [
      undefined,
      null,
      "reply",
      [good],
      { ...good, ref: "not a ref" },
      { ...good, ref: `${REF}\n` },
      { ...good, ref: 4 },
      { x: 1, y: 2 },
      ...NOT_COORDINATES.flatMap((bad) => [
        { ...good, x: bad },
        { ...good, y: bad },
      ]),
      { ref: REF, x: 1 },
      Object.create(good),
    ]) {
      assert.equal(pointResultOf(reply), undefined, JSON.stringify(reply));
    }
  });
});

describe("scrollResultOf", () => {
  it("accepts a position with or without a ref, of any sign", () => {
    assert.deepEqual(scrollResultOf({ scrollLeft: -40, scrollTop: 300, moved: true, extra: 1 }), {
      scrollLeft: -40,
      scrollTop: 300,
      moved: true,
    });
    assert.deepEqual(scrollResultOf({ ref: REF, scrollLeft: 0, scrollTop: 0.5, moved: false }), {
      ref: REF,
      scrollLeft: 0,
      scrollTop: 0.5,
      moved: false,
    });
    assert.deepEqual(
      Object.keys(
        scrollResultOf({ ref: undefined, scrollLeft: 0, scrollTop: 0, moved: false }) ?? {},
      ),
      ["scrollLeft", "scrollTop", "moved"],
    );
  });

  it("refuses a reply of the wrong shape", () => {
    const good = { scrollLeft: 0, scrollTop: 10, moved: true };
    for (const reply of [
      undefined,
      null,
      [],
      { ...good, ref: "x" },
      { ...good, ref: null },
      { ...good, scrollLeft: Number.NaN },
      { ...good, scrollTop: Number.POSITIVE_INFINITY },
      { ...good, scrollLeft: "0" },
      { ...good, scrollTop: undefined },
      { ...good, moved: "yes" },
      { scrollLeft: 0, scrollTop: 0 },
      Object.create(good),
    ]) {
      assert.equal(scrollResultOf(reply), undefined, JSON.stringify(reply));
    }
  });
});

describe("dragResultOf", () => {
  it("accepts both modes, and drops anything else", () => {
    for (const mode of ["html5", "pointer"]) {
      assert.deepEqual(
        dragResultOf({ ref: REF, targetRef: OTHER_REF, mode, dropped: false, extra: 1 }),
        { ref: REF, targetRef: OTHER_REF, mode, dropped: false },
      );
    }
  });

  it("refuses a reply of the wrong shape", () => {
    const good = { ref: REF, targetRef: OTHER_REF, mode: "pointer", dropped: true };
    for (const reply of [
      undefined,
      null,
      "drag",
      { ...good, ref: "bad" },
      { ...good, targetRef: "bad" },
      { ...good, targetRef: undefined },
      { ...good, mode: "native" },
      { ...good, dropped: 1 },
      Object.create(good),
    ]) {
      assert.equal(dragResultOf(reply), undefined, JSON.stringify(reply));
    }
  });
});

describe("crossSiteDestination", () => {
  it("lets a click go ahead to the page's own site", () => {
    for (const destination of [
      "/checkout",
      "next",
      "#reviews",
      "",
      "?page=3",
      "https://example.com/other",
      "https://example.com:443/",
      "https://EXAMPLE.com./",
      "  https://example.com/  ",
    ]) {
      assert.equal(crossSiteDestination(destination, PAGE, PAGE), undefined, destination);
    }
  });

  it("lets a click go ahead to what is not a web page, or does not parse", () => {
    for (const destination of [
      "javascript:alert(1)",
      "mailto:someone@example.org",
      "data:text/html,hello",
      "tel:+15550100",
      "ftp://example.org/file",
      "https://exa mple.org/",
      "http://[::1/",
    ]) {
      assert.equal(crossSiteDestination(destination, PAGE, PAGE), undefined, destination);
    }
  });

  it("names the site of a destination on another site", () => {
    const cases: [string, string][] = [
      ["https://example.org/", "https://example.org"],
      ["https://shop.example.com/", "https://shop.example.com"],
      ["https://example.com:8443/", "https://example.com:8443"],
      ["http://example.com/", "http://example.com"],
      ["//evil.example/path", "https://evil.example"],
      ["HTTPS://Other.Example./x", "https://other.example"],
    ];
    for (const [destination, site] of cases) {
      assert.equal(crossSiteDestination(destination, PAGE, PAGE), site, destination);
    }
  });

  it("resolves the destination against the base, not the page", () => {
    assert.equal(
      crossSiteDestination("/next", "https://cdn.example.net/assets/", PAGE),
      "https://cdn.example.net",
    );
    assert.equal(crossSiteDestination("/next", "https://example.com/a/", PAGE), undefined);
  });

  it("names the origin of an http URL that has no site", () => {
    assert.equal(crossSiteDestination("http://./", PAGE, PAGE), "http://.");
    assert.equal(crossSiteDestination("http://a../", PAGE, PAGE), "http://a..");
  });

  it("refuses everything when the base does not parse", () => {
    assert.equal(crossSiteDestination("#top", "not a url", PAGE), "an unknown site");
  });

  it("refuses every web destination when the page has no site", () => {
    assert.equal(crossSiteDestination("http://./x", "http://./", "http://./"), "http://.");
    assert.equal(crossSiteDestination("/x", "about:blank", "about:blank"), undefined);
  });
});

describe("formDestination", () => {
  const doc = "https://example.com/form";

  it("takes formaction first, then action", () => {
    assert.equal(formDestination("/a", "/b", doc), "/a");
    assert.equal(formDestination(null, "/b", doc), "/b");
  });

  it("takes an empty formaction over the form's action, as the document's URL", () => {
    assert.equal(formDestination("", "https://example.org/", doc), doc);
  });

  it("gives the document's URL with neither or an empty action", () => {
    assert.equal(formDestination(null, null, doc), doc);
    assert.equal(formDestination(null, "", doc), doc);
  });

  it("keeps an attribute of only spaces", () => {
    assert.equal(formDestination("  ", "/b", doc), "  ");
    assert.equal(formDestination(null, " ", doc), " ");
  });
});

describe("viewportOverflow", () => {
  const visible = { x: "visible", y: "visible" };

  it("takes body's overflow when the root's is visible, and body does not scroll", () => {
    assert.deepEqual(viewportOverflow(visible, { x: "hidden", y: "scroll" }, "x"), {
      viewport: "hidden",
      bodyScrolls: false,
    });
    assert.deepEqual(viewportOverflow(visible, { x: "hidden", y: "scroll" }, "y"), {
      viewport: "scroll",
      bodyScrolls: false,
    });
    assert.deepEqual(viewportOverflow(visible, visible, "y"), {
      viewport: "auto",
      bodyScrolls: false,
    });
  });

  it("takes the root's overflow otherwise, and body scrolls on its own", () => {
    assert.deepEqual(
      viewportOverflow({ x: "hidden", y: "hidden" }, { x: "auto", y: "auto" }, "y"),
      {
        viewport: "hidden",
        bodyScrolls: true,
      },
    );
    assert.deepEqual(viewportOverflow({ x: "visible", y: "clip" }, visible, "x"), {
      viewport: "auto",
      bodyScrolls: true,
    });
    assert.deepEqual(viewportOverflow({ x: "visible", y: "clip" }, visible, "y"), {
      viewport: "clip",
      bodyScrolls: true,
    });
  });

  it("takes the root's overflow when there is no body", () => {
    assert.deepEqual(viewportOverflow(visible, undefined, "y"), {
      viewport: "auto",
      bodyScrolls: true,
    });
  });
});

describe("wheelScrolls", () => {
  it("is true for auto, scroll and overlay only", () => {
    for (const overflow of ["auto", "scroll", "overlay"])
      assert.equal(wheelScrolls(overflow), true);
    for (const overflow of ["visible", "hidden", "clip", ""]) {
      assert.equal(wheelScrolls(overflow), false);
    }
  });
});

describe("visiblePoint", () => {
  const viewport = { width: 800, height: 600 };

  it("gives the centre of a rect inside the viewport", () => {
    assert.deepEqual(visiblePoint([{ left: 10, top: 20, right: 110, bottom: 60 }], viewport), {
      x: 60,
      y: 40,
    });
  });

  it("gives the centre of the part inside the viewport", () => {
    assert.deepEqual(visiblePoint([{ left: -100, top: 500, right: 100, bottom: 700 }], viewport), {
      x: 50,
      y: 550,
    });
    assert.deepEqual(visiblePoint([{ left: 700, top: -50, right: 900, bottom: 10 }], viewport), {
      x: 750,
      y: 5,
    });
  });

  it("skips rects outside the viewport or with no width or height", () => {
    const rects = [
      { left: 0, top: 600, right: 100, bottom: 700 },
      { left: 10, top: 10, right: 10, bottom: 50 },
      { left: 10, top: 10, right: 50, bottom: 10 },
      { left: -50, top: 10, right: 0, bottom: 50 },
      { left: 20, top: 30, right: 40, bottom: 50 },
    ];
    assert.deepEqual(visiblePoint(rects, viewport), { x: 30, y: 40 });
  });

  it("gives nothing when no rect shows", () => {
    assert.equal(visiblePoint([], viewport), undefined);
    assert.equal(
      visiblePoint([{ left: 800, top: 0, right: 900, bottom: 100 }], viewport),
      undefined,
    );
  });
});

describe("fullyInside", () => {
  const viewport = { width: 800, height: 600 };

  it("is true only when every edge is inside the viewport", () => {
    assert.equal(fullyInside({ left: 0, top: 0, right: 800, bottom: 600 }, viewport), true);
    assert.equal(fullyInside({ left: -1, top: 0, right: 10, bottom: 10 }, viewport), false);
    assert.equal(fullyInside({ left: 0, top: -1, right: 10, bottom: 10 }, viewport), false);
    assert.equal(fullyInside({ left: 0, top: 0, right: 801, bottom: 10 }, viewport), false);
    assert.equal(fullyInside({ left: 0, top: 0, right: 10, bottom: 601 }, viewport), false);
  });
});

describe("hoverTransitions", () => {
  it("leaves every old element and enters every new one when the chains share none", () => {
    assert.deepEqual(hoverTransitions(["a", "b"], ["c", "d"]), {
      leave: ["a", "b"],
      enter: ["d", "c"],
    });
  });

  it("leaves and enters only below the shared ancestors", () => {
    assert.deepEqual(
      hoverTransitions(["a", "b", "body", "html"], ["c", "d", "e", "body", "html"]),
      {
        leave: ["a", "b"],
        enter: ["e", "d", "c"],
      },
    );
  });

  it("enters only the child when moving into it", () => {
    assert.deepEqual(hoverTransitions(["b", "html"], ["a", "b", "html"]), {
      leave: [],
      enter: ["a"],
    });
  });

  it("does nothing for the same chain, and enters everything from nowhere", () => {
    assert.deepEqual(hoverTransitions(["a", "html"], ["a", "html"]), { leave: [], enter: [] });
    assert.deepEqual(hoverTransitions([], ["a", "html"]), { leave: [], enter: ["html", "a"] });
  });
});

describe("scrollDelta", () => {
  it("signs the amount by direction", () => {
    assert.deepEqual(scrollDelta("up", 30), { left: 0, top: -30 });
    assert.deepEqual(scrollDelta("down", 30), { left: 0, top: 30 });
    assert.deepEqual(scrollDelta("left", 30), { left: -30, top: 0 });
    assert.deepEqual(scrollDelta("right", 30), { left: 30, top: 0 });
  });
});

describe("defaultAmount", () => {
  it("is 80% of the client size, rounded, and at least 1", () => {
    assert.equal(defaultAmount(600), 480);
    assert.equal(defaultAmount(101), 81);
    assert.equal(defaultAmount(103), 82);
    assert.equal(defaultAmount(0), 1);
  });
});

describe("dragPoints", () => {
  it("moves in 5 even steps and ends exactly at the end", () => {
    assert.deepEqual(dragPoints({ x: 0, y: 100 }, { x: 50, y: 0 }), [
      { x: 10, y: 80 },
      { x: 20, y: 60 },
      { x: 30, y: 40 },
      { x: 40, y: 20 },
      { x: 50, y: 0 },
    ]);
    const points = dragPoints({ x: 0.1, y: 0.2 }, { x: 0.7, y: 0.3 });
    assert.equal(points.length, 5);
    assert.deepEqual(points.at(-1), { x: 0.7, y: 0.3 });
  });
});
