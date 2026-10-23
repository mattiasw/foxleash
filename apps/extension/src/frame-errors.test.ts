import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeBrowser } from "./fake-browser.ts";
import { MAX_ERROR_FRAMES, MAX_FAILED_URL_LENGTH, watchFrameErrors } from "./frame-errors.ts";

const FAILED = "http://a.example/frame?x=1&y=a+b#h";
const ERROR_PAGE =
  "about:neterror?e=connectionFailure&u=http%3A//a.example/frame%3Fx%3D1%26y%3Da+b%23h&c=UTF-8&d=x";

describe("watchFrameErrors", () => {
  it("records a subframe's error page with the URL that failed", () => {
    const { fake, errors } = setup();
    fake.emitDOMContentLoaded({ tabId: 1, frameId: 5, documentId: "d", url: ERROR_PAGE });
    assert.equal(errors.showsErrorPage(1, { frameId: 5, documentId: "d", url: FAILED }), true);
    assert.equal(errors.showsErrorPage(2, { frameId: 5, documentId: "d", url: FAILED }), false);
    assert.equal(errors.showsErrorPage(1, { frameId: 6, documentId: "d", url: FAILED }), false);
    assert.equal(errors.showsErrorPage(1, { frameId: 5, documentId: "e", url: FAILED }), false);
    assert.equal(
      errors.showsErrorPage(1, {
        frameId: 5,
        documentId: "d",
        url: "http://a.example/frame?x=1&y=a b#h",
      }),
      false,
    );
    assert.equal(errors.showsErrorPage(1, { frameId: 5, url: FAILED }), false);
    assert.equal(errors.showsErrorPage(1, { frameId: 5, documentId: "d" }), false);
  });

  it("never records the top frame", () => {
    const { fake, errors } = setup();
    fake.emitDOMContentLoaded({ tabId: 1, frameId: 0, documentId: "d", url: ERROR_PAGE });
    assert.equal(errors.showsErrorPage(1, { frameId: 0, documentId: "d", url: FAILED }), false);
  });

  it("records only Firefox's error page", () => {
    const { fake, errors } = setup();
    const urls = [
      "http://a.example/",
      "about:certerror?e=nssBadCert&u=http%3A//a.example/",
      "about:neterrorx?e=1&u=http%3A//a.example/",
      "moz-extension://x/about:neterror?u=http%3A//a.example/",
      "ABOUT:NETERROR?e=1&u=http%3A//a.example/",
      "about:neterror&u=http%3A//a.example/",
    ];
    for (const [index, url] of urls.entries()) {
      fake.emitDOMContentLoaded({ tabId: 1, frameId: index + 1, documentId: "d", url });
      const frame = { frameId: index + 1, documentId: "d", url: "http://a.example/" };
      assert.equal(errors.showsErrorPage(1, frame), false, url);
    }
  });

  it("needs the URL that failed", () => {
    const { fake, errors } = setup();
    fake.emitDOMContentLoaded({
      tabId: 1,
      frameId: 5,
      documentId: "d",
      url: "about:neterror?e=connectionFailure&c=UTF-8",
    });
    fake.emitDOMContentLoaded({
      tabId: 1,
      frameId: 6,
      documentId: "d",
      url: "about:neterror?e=connectionFailure&u=%E0%A4%A&c=UTF-8",
    });
    fake.emitDOMContentLoaded({
      tabId: 1,
      frameId: 7,
      documentId: "d",
      url: "about:neterror?e=connectionFailure&u=&c=UTF-8",
    });
    for (const frameId of [5, 6, 7]) {
      assert.equal(errors.showsErrorPage(1, { frameId, documentId: "d" }), false);
      assert.equal(errors.showsErrorPage(1, { frameId, documentId: "d", url: "" }), false);
      assert.equal(errors.showsErrorPage(1, { frameId, documentId: "d", url: "%E0%A4%A" }), false);
    }
  });

  it(`remembers a failed URL of at most ${MAX_FAILED_URL_LENGTH} characters`, () => {
    const { fake, errors } = setup();
    const longest = `http://a.example/${"a".repeat(MAX_FAILED_URL_LENGTH - "http://a.example/".length)}`;
    const longer = `${longest}a`;
    for (const [frameId, failed] of [
      [5, longest],
      [6, longer],
    ] as const) {
      const url = `about:neterror?e=connectionFailure&u=${encodeURIComponent(failed)}&c=UTF-8`;
      fake.emitDOMContentLoaded({ tabId: 1, frameId, documentId: "d", url });
    }
    assert.equal(errors.showsErrorPage(1, { frameId: 5, documentId: "d", url: longest }), true);
    assert.equal(errors.showsErrorPage(1, { frameId: 6, documentId: "d", url: longer }), false);
  });

  it("needs a document id", () => {
    const { fake, errors } = setup();
    fake.emitDOMContentLoaded({ tabId: 1, frameId: 5, url: ERROR_PAGE });
    assert.equal(errors.showsErrorPage(1, { frameId: 5, url: FAILED }), false);
  });

  it("replaces a frame's error page with its next one", () => {
    const { fake, errors } = setup();
    fake.emitDOMContentLoaded({ tabId: 1, frameId: 5, documentId: "d", url: ERROR_PAGE });
    fake.emitDOMContentLoaded({ tabId: 1, frameId: 5, documentId: "e", url: ERROR_PAGE });
    assert.equal(errors.showsErrorPage(1, { frameId: 5, documentId: "d", url: FAILED }), false);
    assert.equal(errors.showsErrorPage(1, { frameId: 5, documentId: "e", url: FAILED }), true);
  });

  it("forgets a tab when it closes, and only that tab", () => {
    const { fake, errors } = setup();
    const closed = fake.openTab();
    const kept = fake.openTab();
    for (const tab of [closed, kept]) {
      fake.emitDOMContentLoaded({ tabId: tab.id, frameId: 5, documentId: "d", url: ERROR_PAGE });
    }
    fake.removeTab(closed.id);
    const frame = { frameId: 5, documentId: "d", url: FAILED };
    assert.equal(errors.showsErrorPage(closed.id, frame), false);
    assert.equal(errors.showsErrorPage(kept.id, frame), true);
  });

  it(`keeps at most ${MAX_ERROR_FRAMES} frames per tab, dropping the oldest`, () => {
    const { fake, errors } = setup();
    const shown = (tabId: number, frameId: number) =>
      errors.showsErrorPage(tabId, { frameId, documentId: `d${frameId}`, url: FAILED });
    const emit = (tabId: number, frameId: number) =>
      fake.emitDOMContentLoaded({ tabId, frameId, documentId: `d${frameId}`, url: ERROR_PAGE });
    for (let frameId = 1; frameId <= MAX_ERROR_FRAMES; frameId += 1) emit(1, frameId);
    // Another tab's frames do not count.
    emit(2, 1);
    for (let frameId = 1; frameId <= MAX_ERROR_FRAMES; frameId += 1) {
      assert.equal(shown(1, frameId), true, String(frameId));
    }
    // Recorded again, frame 1 is the newest: frame 2 goes instead.
    emit(1, 1);
    emit(1, MAX_ERROR_FRAMES + 1);
    assert.equal(shown(1, 1), true);
    assert.equal(shown(1, 2), false);
    for (let frameId = 3; frameId <= MAX_ERROR_FRAMES + 1; frameId += 1) {
      assert.equal(shown(1, frameId), true, String(frameId));
    }
    emit(1, MAX_ERROR_FRAMES + 2);
    assert.equal(shown(1, 3), false);
    assert.equal(shown(1, 1), true);
    assert.equal(shown(2, 1), true);
  });

  it("drops the frame recorded first when one more comes", () => {
    const { fake, errors } = setup();
    for (let frameId = 1; frameId <= MAX_ERROR_FRAMES + 1; frameId += 1) {
      fake.emitDOMContentLoaded({ tabId: 1, frameId, documentId: "d", url: ERROR_PAGE });
    }
    const shown = (frameId: number) =>
      errors.showsErrorPage(1, { frameId, documentId: "d", url: FAILED });
    assert.equal(shown(1), false);
    for (let frameId = 2; frameId <= MAX_ERROR_FRAMES + 1; frameId += 1) {
      assert.equal(shown(frameId), true, String(frameId));
    }
  });
});

function setup() {
  const fake = createFakeBrowser();
  return { fake, errors: watchFrameErrors(fake.browser) };
}
