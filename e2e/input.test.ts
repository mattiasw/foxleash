import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
  withoutAfter,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
// Long enough for a submission or click Firefox itself would queue to have happened.
const SETTLE_MS = 300;

interface Page {
  url: string;
  tabId: number;
  context: string;
  tree: string;
}

// One Firefox for the file: the tests run in order, several on the same page.
describe("type and press_key in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let other = "";
  let input: Page;
  let opened = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      other = `http://localhost:${fixtures.port}`;
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
      input = await open("/input", TITLES.input);
    },
    { timeout: 120_000 },
  );

  /** Calls an act that must succeed and returns its result without its checked after. */
  async function acted(
    on: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return withoutAfter(await harness.ok(on, name, args));
  }

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("type adds the text after what a field and a textarea hold, and at the start of an editable area", async () => {
    assert.deepEqual(await type(input, 'textbox "Plain"', " world"), typed("exec_command"));
    assert.equal(await evaluate(input, 'document.getElementById("plain").value'), "Hello world");
    assert.deepEqual(await type(input, 'textbox "Area"', "\nmore"), typed("exec_command"));
    assert.equal(await evaluate(input, 'document.getElementById("area").value'), "Line\nmore");
    assert.deepEqual(await type(input, 'textbox "Editable"', "!"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("editable").textContent'),
      "!Start",
    );
  });

  test("type into a paragraph of an editable area puts the text at that paragraph's start when the caret is not in it", async () => {
    const result = await type(input, 'group "First paragraph"', "+");
    assert.equal(result.outcome, "typed");
    assert.equal(await evaluate(input, 'document.getElementById("first").textContent'), "+One");
    assert.equal(await evaluate(input, 'document.getElementById("second").textContent'), "Two");
    // The caret is now in the first paragraph: inside the editing host, not the target.
    assert.equal((await type(input, 'group "Second paragraph"', "-")).outcome, "typed");
    assert.equal(await evaluate(input, 'document.getElementById("second").textContent'), "-Two");
    assert.equal(await evaluate(input, 'document.getElementById("first").textContent'), "+One");
  });

  test("type adds the text at the caret the page put in an editable area, and goes on from there", async () => {
    await evaluate(input, 'getSelection().collapse(document.getElementById("reply-line"), 0)');
    assert.deepEqual(await type(input, 'textbox "Reply"', "Thanks"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("reply-line").textContent'),
      "Thanks",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("greeting").textContent'),
      "Hi Ann,",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("reply-signature").textContent'),
      "-- Signature",
    );
    assert.equal((await type(input, 'textbox "Reply"', " again")).outcome, "typed");
    assert.equal(
      await evaluate(input, 'document.getElementById("reply").textContent'),
      "Hi Ann,Thanks again-- Signature",
    );
  });

  test("type into an editable area after a field puts the text at its start, above a signature", async () => {
    await evaluate(input, 'getSelection().collapse(document.getElementById("signature"), 1)');
    // Focusing a field moves the caret after the signature out of the body, as in a compose
    // window where the recipients and subject are filled in first.
    assert.equal((await type(input, 'textbox "Subject"', "Hi")).outcome, "typed");
    assert.deepEqual(await type(input, 'textbox "Compose"', "Hello"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("signature").textContent'),
      "-- Signature",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose").textContent'),
      "Hello-- Signature",
    );
  });

  test("type makes each newline a line in an editable area, so a newline at the end leaves a blank line above a signature", async () => {
    // A field first, as in a compose window: the caret leaves the area, so the text goes on
    // its empty first line.
    assert.equal((await type(input, 'textbox "Subject"', "Hi")).outcome, "typed");
    assert.deepEqual(
      await type(input, 'textbox "Compose lines"', "Hi Ann,\n\nThanks.\n"),
      typed("exec_command"),
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-signature").textContent'),
      "-- Signature",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").lastElementChild.id'),
      "compose-lines-signature",
    );
    await assertOneEmptyLineEach(input);
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").innerText'),
      "Hi Ann,\n\nThanks.\n\n\n-- Signature",
    );
  });

  test("type puts the text on an editable area's empty first line when the page left the caret in front of it", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "compose-lines",
        '<div id="compose-lines-top"><br></div><div id="compose-lines-signature">-- Signature</div>',
        0,
      ),
      { id: "compose-lines", offset: 0 },
    );
    assert.deepEqual(
      await type(input, 'textbox "Compose lines"', "Hi Ann,\n\nThanks.\n"),
      typed("exec_command"),
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-top").textContent'),
      "Hi Ann,Thanks.",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").firstChild.id'),
      "compose-lines-top",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").lastElementChild.id'),
      "compose-lines-signature",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-signature").textContent'),
      "-- Signature",
    );
    await assertOneEmptyLineEach(input);
  });

  test("type puts the text on the first line of nested blocks when the page left the caret before whitespace and a comment", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "compose-lines",
        '\n<!-- c -->\n<div dir="ltr">\n<div id="compose-lines-top"><br></div></div>\n<div id="compose-lines-signature">-- Signature</div>',
        0,
      ),
      { id: "compose-lines", offset: 0 },
    );
    assert.deepEqual(await type(input, 'textbox "Compose lines"', "x"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-top").textContent'),
      "x",
    );
  });

  test("type leaves a caret the page put after an editable area's first line where it is, out of the signature", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "compose-lines",
        '<div id="compose-lines-top">Hello</div><div><div id="compose-lines-signature">-- Signature</div></div>',
        1,
      ),
      { id: "compose-lines", offset: 1 },
    );
    assert.deepEqual(await type(input, 'textbox "Compose lines"', "x"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-signature").textContent'),
      "-- Signature",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").textContent'),
      "Hellox-- Signature",
    );
  });

  test("type leaves a caret the page put in front of a later block where it is, out of the signature", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "compose-lines",
        '<div id="compose-lines-top">Hello</div><div id="compose-lines-wrap"><div id="compose-lines-signature">-- Signature</div></div>',
        0,
        "compose-lines-wrap",
      ),
      { id: "compose-lines-wrap", offset: 0 },
    );
    assert.deepEqual(await type(input, 'textbox "Compose lines"', "x"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-signature").textContent'),
      "-- Signature",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").textContent'),
      "Hellox-- Signature",
    );
  });

  test("type never puts the text in an invisible block at the start of an editable area", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "compose-lines",
        '<div id="compose-lines-hidden" style="visibility: hidden"><br></div><div id="compose-lines-top"><br></div>',
        0,
      ),
      { id: "compose-lines", offset: 0 },
    );
    assert.deepEqual(await type(input, 'textbox "Compose lines"', "x"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines-hidden").textContent'),
      "",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").textContent'),
      "x",
    );
  });

  test("type never puts the text inside a table at the start of an editable area", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "compose-lines",
        '<table><tbody><tr><td>A</td></tr></tbody></table><div id="compose-lines-top"><br></div>',
        0,
      ),
      { id: "compose-lines", offset: 0 },
    );
    assert.deepEqual(await type(input, 'textbox "Compose lines"', "x"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.querySelector("#compose-lines table").textContent'),
      "A",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("compose-lines").textContent'),
      "xA",
    );
  });

  test("type keeps a selection the page made in an editable area and adds the text after it", async () => {
    await evaluate(
      input,
      '(() => { const text = document.getElementById("selected").firstChild; getSelection().setBaseAndExtent(text, 6, text, 11); })()',
    );
    assert.equal((await type(input, 'textbox "Selected"', "!")).outcome, "typed");
    assert.equal(
      await evaluate(input, 'document.getElementById("selected").textContent'),
      "Hello world!, bye",
    );
  });

  test("type puts the text at the start of an editable area when the caret is in a part the page made not editable", async () => {
    await evaluate(
      input,
      '(() => { document.getElementById("island-host").focus(); getSelection().collapse(document.getElementById("island").firstChild, 2); })()',
    );
    assert.equal((await type(input, 'textbox "Island"', "x")).outcome, "typed");
    assert.equal(
      await evaluate(input, 'document.getElementById("island-host").textContent'),
      "xFixed text",
    );
    assert.equal(await evaluate(input, 'document.getElementById("island").textContent'), "Fixed");
  });

  test("type never puts the text in a block the page made not editable at the start of an editable area", async () => {
    assert.deepEqual(
      await caretAt(
        input,
        "island-host",
        '<div id="island-block" contenteditable="false">Fixed</div><div id="island-line"><br></div>',
        0,
      ),
      { id: "island-host", offset: 0 },
    );
    assert.deepEqual(await type(input, 'textbox "Island"', "x"), typed("exec_command"));
    assert.equal(
      await evaluate(input, 'document.getElementById("island-block").textContent'),
      "Fixed",
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("island-host").textContent'),
      "xFixed",
    );
  });

  test("type into a field in a shadow root", async () => {
    assert.equal((await type(input, 'textbox "Shadow field"', "!")).outcome, "typed");
    assert.equal(await evaluate(input, "window.shadowField.value"), "In!");
  });

  test("type into an email field that holds text adds the text after it", async () => {
    // An email field has no caret to put at the end, so execCommand is not used.
    assert.deepEqual(await type(input, 'textbox "Email"', "d"), typed("native_setter"));
    assert.equal(await evaluate(input, 'document.getElementById("email").value'), "a@b.cd");
  });

  test("type changes nothing in a number field given letters, or in a full field", async () => {
    const number = refOf(input.tree, 'spinbutton "Number"');
    const text = await harness.refused(session, "type", {
      tabId: input.tabId,
      ref: number,
      text: "x",
    });
    assert.ok(text.includes(`The text did not appear in element ${number};`), text);
    assert.equal(await evaluate(input, 'document.getElementById("number").value'), "12");
    const full = refOf(input.tree, 'textbox "Full"');
    const fullText = await harness.refused(session, "type", {
      tabId: input.tabId,
      ref: full,
      text: "d",
    });
    assert.ok(fullText.includes(`The text did not appear in element ${full};`), fullText);
    assert.equal(await evaluate(input, 'document.getElementById("full").value'), "abc");
  });

  test("type inserts once into a field whose maxlength cuts the text", async () => {
    assert.equal((await type(input, 'textbox "Short"', "cdefgh")).outcome, "typed");
    assert.equal(await evaluate(input, 'document.getElementById("short").value'), "abcde");
  });

  test("type into a React-style controlled input updates the component's state", async () => {
    assert.equal((await type(input, 'textbox "React"', "abc")).outcome, "typed");
    assert.equal(await evaluate(input, 'document.getElementById("react").value'), "abc");
    assert.equal(await evaluate(input, "window.reactState.react"), "abc");
    // A component that never takes the change sets the value back every time.
    const frozen = refOf(input.tree, 'textbox "React frozen"');
    const text = await harness.refused(session, "type", {
      tabId: input.tabId,
      ref: frozen,
      text: "x",
    });
    assert.ok(text.includes(`The text did not appear in element ${frozen};`), text);
    assert.equal(await evaluate(input, 'document.getElementById("react-frozen").value'), "Fixed");
  });

  test("type falls back when the browser's input reaches nothing and is undone", async () => {
    assert.deepEqual(await type(input, 'textbox "Untrusting"', "!"), typed("native_setter"));
    assert.equal(await evaluate(input, 'document.getElementById("untrusting").value'), "Keep!");
    assert.deepEqual(
      await type(input, 'textbox "Untrusting editable"', "!"),
      typed("beforeinput_dom"),
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("untrusting-editable").textContent'),
      "!Keep",
    );
    assert.deepEqual(
      await type(input, 'textbox "Wandering editable"', "!"),
      typed("beforeinput_dom"),
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("wandering").textContent'),
      "!Keep",
    );
    assert.deepEqual(
      await type(input, 'textbox "Selecting editable"', "!"),
      typed("beforeinput_dom"),
    );
    assert.equal(
      await evaluate(input, 'document.getElementById("selecting").textContent'),
      "Kee!p",
    );
  });

  test("type gives a field that takes the text and clears itself the text once", async () => {
    const consumer = refOf(input.tree, 'textbox "Consumer"');
    const text = await harness.refused(session, "type", {
      tabId: input.tabId,
      ref: consumer,
      text: "abc",
    });
    assert.ok(
      text.includes(`The text did not appear in element ${consumer}; the page received it`),
      text,
    );
    assert.deepEqual(await evaluate(input, "window.consumed"), ["abc"]);
  });

  test("type refuses a disabled or read-only field and an element that is not editable", async () => {
    for (const line of ['textbox "Disabled"', 'textbox "Read only"']) {
      const ref = refOf(input.tree, line);
      const text = await harness.refused(session, "type", { tabId: input.tabId, ref, text: "x" });
      assert.ok(text.includes(`Element ${ref} is a disabled or read-only field`), text);
    }
    const block = refOf(input.tree, 'group "Plain block"');
    const text = await harness.refused(session, "type", {
      tabId: input.tabId,
      ref: block,
      text: "x",
    });
    assert.ok(
      text.includes(
        `type needs a text field or an editable area, and element ${block} is neither.`,
      ),
      text,
    );
    assert.equal(await evaluate(input, 'document.getElementById("disabled").value'), "Off");
    assert.equal(await evaluate(input, 'document.getElementById("readonly").value'), "Fixed");
  });

  test("a newline typed into a field of a form on another site submits nothing", async () => {
    assert.equal((await type(input, 'textbox "Away field"', "x\n")).outcome, "typed");
    await sleep(SETTLE_MS);
    assert.equal(await evaluate(input, "window.submits"), 0);
    assert.equal(await evaluate(input, "location.href"), input.url);
  });

  test("type into an editor's input frame on the page's site is sent but unconfirmed", async () => {
    const frames = await open("/input-frames", TITLES.inputFrames);
    assert.deepEqual(await type(frames, 'iframe "Docs input"', "abc"), {
      outcome: "sent_unconfirmed",
      method: "exec_command",
    });
    assert.deepEqual(await evaluate(frames, "window.received"), ["abc"]);
    assert.equal((await type(frames, 'iframe "Design input"', "def")).outcome, "sent_unconfirmed");
    assert.deepEqual(await evaluate(frames, "window.received"), ["abc", "def"]);
    const sandboxed = refOf(frames.tree, 'iframe "Sandboxed"');
    const text = await harness.refused(session, "type", {
      tabId: frames.tabId,
      ref: sandboxed,
      text: "x",
    });
    assert.ok(text.includes(`and element ${sandboxed} is neither.`), text);
  });

  test("type into a tab that is not the active one", async () => {
    const background = await open("/input", TITLES.input);
    await open("/input-frames", TITLES.inputFrames);
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.equal(tabs.find(({ id }) => id === background.tabId)?.active, false);
    await pollUntil(
      async () =>
        (await evaluate(background, "document.visibilityState")) === "hidden" ? true : undefined,
      PAGE_TIMEOUT_MS,
      "the tab to be hidden",
    );
    const started = Date.now();
    const typed = await type(background, 'textbox "Plain"', "!", { view: false });
    assert.equal(typed.outcome, "typed");
    const took = Date.now() - started;
    // type waits 100 ms for the page, and Firefox delays a hidden tab's timers to a second.
    assert.ok(took >= 100, `type took ${took} ms`);
    assert.ok(took < 500, `type took ${took} ms`);
    assert.equal(await evaluate(background, 'document.getElementById("plain").value'), "Hello!");
  });

  test("Enter in a field submits its form once, through the default button", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Name"'), submitted());
    await sleep(SETTLE_MS);
    assert.deepEqual(await evaluate(forms, "window.submits"), ["with-button:send"]);
    // As in Firefox, the default button is clicked, so the page's click listeners see it.
    assert.deepEqual(await evaluate(forms, "window.clicks"), ["send"]);
  });

  test("Enter submits a form with one blocking field and no button, not one with two", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Only"'), submitted());
    assert.deepEqual(await press(forms, "Enter", 'textbox "First of two"'), {
      action: "none",
      prevented: false,
    });
    assert.deepEqual(await evaluate(forms, "window.submits"), ["one-field:"]);
  });

  test("Enter on a field a keyboard cannot reach submits nothing", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Disabled field"'), {
      action: "none",
      prevented: false,
    });
    await sleep(SETTLE_MS);
    assert.deepEqual(await evaluate(forms, "window.submits"), []);
  });

  test("Enter that the page cancels does nothing and sends no keypress", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Prevented"'), {
      action: "none",
      prevented: true,
    });
    assert.deepEqual(await evaluate(forms, "window.keys"), [
      "keydown:prevented-field:Enter",
      "keyup:prevented-field:Enter",
    ]);
    assert.deepEqual(await evaluate(forms, "window.submits"), []);
  });

  test("Enter in a form its validation stops reports none and submits nothing", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Required"'), {
      action: "none",
      prevented: false,
    });
    assert.deepEqual(await evaluate(forms, "window.submits"), []);
  });

  test("Enter submits through an image button, and in a form whose controls shadow its own properties", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Image first"'), submitted());
    assert.deepEqual(await press(forms, "Enter", 'textbox "Shadowed"'), submitted());
    // No default button: the form itself is submitted, through its prototype.
    assert.deepEqual(await press(forms, "Enter", 'textbox "Shadowed alone"'), submitted());
    assert.deepEqual(await evaluate(forms, "window.submits"), [
      "image-only:image-send",
      "shadowed:shadowed-send",
      "shadowed-alone:",
    ]);
  });

  test("Enter on a button clicks it", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'button "Plain button"'), {
      action: "clicked",
      prevented: false,
    });
    assert.deepEqual(await evaluate(forms, "window.clicks"), ["plain-button"]);
  });

  test("Enter that leads to another site is refused after the page's key listeners", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    const web = `leads to a page on ${other}, which Foxleash does not open with press_key; call navigate with that address`;
    const mail =
      "leads to an address outside the site (mailto:), which Foxleash does not open with press_key or with navigate.";
    // A form posting there, one whose only field is named action, a default button with a
    // formaction there, a link there, a same-site form whose keydown listener points its
    // action there, and a one-field form and a link that lead to an email address.
    for (const [line, id, expected] of [
      ['textbox "Away"', "away-field", web],
      ['textbox "Away named"', "away-named-field", web],
      ['textbox "Away by button"', "away-button-field", web],
      ['link "Away link"', "away-link", web],
      ['textbox "Rewritten"', "rewritten-field", web],
      ['textbox "Mail"', "mail-field", mail],
      ['link "Mail link"', "mail-link", mail],
    ] as const) {
      await evaluate(forms, "window.keys.length = 0");
      const ref = refOf(forms.tree, line);
      const text = await harness.refused(session, "press_key", {
        tabId: forms.tabId,
        key: "Enter",
        ref,
      });
      assert.ok(text.includes(`Enter on element ${ref} ${expected}`), `${line}: ${text}`);
      assert.deepEqual(
        await evaluate(forms, "window.keys"),
        [`keydown:${id}:Enter`, `keypress:${id}:Enter`, `keyup:${id}:Enter`],
        line,
      );
    }
    await sleep(SETTLE_MS);
    assert.deepEqual(await evaluate(forms, "window.submits"), []);
    assert.deepEqual(await evaluate(forms, "window.clicks"), []);
    assert.equal(await evaluate(forms, "location.href"), forms.url);
  });

  test("Enter in a form whose submit button has no type attribute and leads to another site is refused", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    const ref = refOf(forms.tree, 'textbox "Away plain"');
    const hits = fixtures.hits("/a");
    const text = await harness.refused(session, "press_key", {
      tabId: forms.tabId,
      key: "Enter",
      ref,
    });
    assert.ok(
      text.includes(
        `Enter on element ${ref} leads to a page on ${other}, which Foxleash does not open with press_key; call navigate with that address`,
      ),
      text,
    );
    await sleep(SETTLE_MS);
    assert.deepEqual(await evaluate(forms, "window.submits"), []);
    assert.deepEqual(await evaluate(forms, "window.clicks"), []);
    assert.equal(await evaluate(forms, "location.href"), forms.url);
    assert.equal(fixtures.hits("/a"), hits);
  });

  test("Enter in a form with no button whose relative action resolves against a base on another site is refused", async () => {
    const based = await open("/act-base", TITLES.actBase);
    const ref = refOf(based.tree, 'textbox "Based field"');
    const hits = fixtures.hits("/a");
    const text = await harness.refused(session, "press_key", {
      tabId: based.tabId,
      key: "Enter",
      ref,
    });
    assert.ok(text.includes(`Enter on element ${ref} leads to a page on ${other},`), text);
    await sleep(SETTLE_MS);
    assert.equal(await evaluate(based, "location.href"), based.url);
    assert.equal(fixtures.hits("/a"), hits);
  });

  test("Enter on an SVG link does nothing but still sends keyup", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    await evaluate(forms, 'document.getElementById("svg-link").focus()');
    assert.deepEqual(await acted(session, "press_key", { tabId: forms.tabId, key: "Enter" }), {
      action: "none",
      prevented: false,
    });
    const keys = await evaluate(forms, "window.keys");
    assert.ok(Array.isArray(keys) && keys.includes("keyup:svg-link:Enter"), JSON.stringify(keys));
    assert.equal(await evaluate(forms, "location.href"), forms.url);
  });

  test("Enter without a ref goes to the field focused in a shadow root", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.equal((await type(forms, 'textbox "Shadow name"', "n")).outcome, "typed");
    assert.deepEqual(
      await acted(session, "press_key", { tabId: forms.tabId, key: "Enter" }),
      submitted(),
    );
    assert.deepEqual(await evaluate(forms, "window.submits"), ["shadow-form:"]);
  });

  test("Enter in a form that navigates replies first, then the tab loads the target", async () => {
    const forms = await open("/input-forms", TITLES.inputForms);
    assert.deepEqual(await press(forms, "Enter", 'textbox "Navigating"'), submitted());
    await pollUntil(
      async () => {
        const listed = tabsOf(await harness.ok(session, "tabs_list")).find(
          ({ id }) => id === forms.tabId,
        );
        if (listed?.title === TITLES.b) return listed;
        throw new Error(`tab ${forms.tabId} is listed as ${JSON.stringify(listed)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${forms.tabId} to show ${TITLES.b}`,
    );
  });

  test("Tab and Shift+Tab follow the tab order", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    await evaluate(keys, "document.activeElement.blur()");
    for (const id of ["one", "two", "zero-a", "green", "zero-b"]) {
      assert.deepEqual(await tab(keys, "Tab"), focusMoved(), id);
      assert.equal(await evaluate(keys, "window.focusedId()"), id);
    }
    for (const id of ["green", "zero-a", "two", "one"]) {
      assert.deepEqual(await tab(keys, "Shift+Tab"), focusMoved(), id);
      assert.equal(await evaluate(keys, "window.focusedId()"), id);
    }
    assert.deepEqual(await tab(keys, "Shift+Tab"), { action: "none", prevented: false });
    assert.equal(await evaluate(keys, "window.focusedId()"), "one");
  });

  test("Tab goes into a focused container, through shadow roots and slots, to an editing host", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    await evaluate(keys, 'document.getElementById("container").focus()');
    for (const id of ["inner", "open-inner", "closed-inner", "slot-a", "slot-light", "slot-b"]) {
      assert.deepEqual(await tab(keys, "Tab"), focusMoved(), id);
      assert.equal(await evaluate(keys, "window.focusedId()"), id);
    }
    await evaluate(keys, "window.keys.length = 0");
    assert.deepEqual(await tab(keys, "Tab"), focusMoved());
    assert.equal(await evaluate(keys, "window.focusedId()"), "editable");
    // The key is released where focus went.
    assert.deepEqual(await evaluate(keys, "window.keys"), [
      "keydown:slot-host:Tab",
      "keyup:editable:Tab",
    ]);
  });

  test("the arrow keys choose the next enabled option in a select", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    assert.deepEqual(await press(keys, "ArrowDown", 'combobox "Fruit"'), {
      action: "selected_option",
      prevented: false,
    });
    assert.equal(await evaluate(keys, 'document.getElementById("fruit").value'), "Date");
    assert.deepEqual(await evaluate(keys, "window.changes"), ["input:Date", "change:Date"]);
    assert.deepEqual(await press(keys, "ArrowDown", 'combobox "Fruit"'), {
      action: "none",
      prevented: false,
    });
    assert.deepEqual(await press(keys, "ArrowUp", 'combobox "Fruit"'), {
      action: "selected_option",
      prevented: false,
    });
    assert.equal(await evaluate(keys, 'document.getElementById("fruit").value'), "Apple");
  });

  test("the arrow keys change no select that a modal dialog blocks", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    await evaluate(keys, 'document.getElementById("dialog").showModal()');
    assert.deepEqual(await press(keys, "ArrowDown", 'combobox "Fruit"'), {
      action: "none",
      prevented: false,
    });
    assert.equal(await evaluate(keys, 'document.getElementById("fruit").value'), "Apple");
    assert.deepEqual(await evaluate(keys, "window.changes"), []);
  });

  test("Escape hides an open popover, then closes a modal dialog", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    await evaluate(keys, 'document.getElementById("pop").showPopover()');
    assert.deepEqual(await acted(session, "press_key", { tabId: keys.tabId, key: "Escape" }), {
      action: "hid_popover",
      prevented: false,
    });
    assert.equal(
      await evaluate(keys, 'document.getElementById("pop").matches(":popover-open")'),
      false,
    );
    await evaluate(keys, 'document.getElementById("dialog").showModal()');
    assert.deepEqual(await acted(session, "press_key", { tabId: keys.tabId, key: "Escape" }), {
      action: "closed_dialog",
      prevented: false,
    });
    assert.equal(await evaluate(keys, 'document.getElementById("dialog").open'), false);
  });

  test("Escape leaves open a modal dialog that no close request may close", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    await evaluate(keys, 'document.getElementById("fixed-dialog").showModal()');
    // Firefox's own Escape honours closedby where Firefox knows the attribute.
    const honoured = (await evaluate(keys, '"closedBy" in HTMLDialogElement.prototype')) === true;
    assert.deepEqual(await acted(session, "press_key", { tabId: keys.tabId, key: "Escape" }), {
      action: honoured ? "none" : "closed_dialog",
      prevented: false,
    });
    assert.equal(await evaluate(keys, 'document.getElementById("fixed-dialog").open'), honoured);
  });

  test("a key with no default action reaches the page's listener with its modifiers", async () => {
    const keys = await open("/input-keys", TITLES.inputKeys);
    await evaluate(keys, "window.keys.length = 0");
    assert.deepEqual(await acted(session, "press_key", { tabId: keys.tabId, key: "Control+k" }), {
      action: "none",
      prevented: false,
    });
    assert.deepEqual(await evaluate(keys, "window.keys"), ["keydown::k:ctrl", "keyup::k:ctrl"]);
  });

  async function open(path: string, title: string): Promise<Page> {
    opened += 1;
    const url = fixtures.url(`${path}?tab=${opened}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    const read = await harness.call(session, "read_page", { tabId: tab.id });
    assert.equal(read.isError, false, read.text);
    return { url, tabId: tab.id, context: found.context, tree: untrustedContent(read.text) ?? "" };
  }

  async function type(
    page: Page,
    line: string,
    text: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const ref = refOf(page.tree, line);
    return record(await acted(session, "type", { tabId: page.tabId, ref, text, ...args }));
  }

  async function press(page: Page, key: string, line: string): Promise<unknown> {
    const ref = refOf(page.tree, line);
    return acted(session, "press_key", { tabId: page.tabId, key, ref });
  }

  async function tab(page: Page, key: string): Promise<unknown> {
    return acted(session, "press_key", { tabId: page.tabId, key });
  }

  /**
   * That the typed "Hi Ann," and "Thanks." lines of #compose-lines have one empty line between
   * them and one above the signature.
   */
  async function assertOneEmptyLineEach(page: Page): Promise<void> {
    // A <br> at the end of a block is in the DOM and in innerText but not rendered, so the
    // blank lines are measured.
    const gaps = record(
      await evaluate(
        page,
        `(() => {
          const host = document.getElementById("compose-lines");
          const signature = document.getElementById("compose-lines-signature").getBoundingClientRect();
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          const boxes = {};
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            boxes[node.data] = range.getBoundingClientRect();
          }
          const hi = boxes["Hi Ann,"];
          const thanks = boxes["Thanks."];
          return {
            line: signature.height,
            between: hi && thanks ? thanks.top - hi.bottom : null,
            above: thanks ? signature.top - thanks.bottom : null,
          };
        })()`,
      ),
    );
    const { line, between, above } = gaps;
    const seen = JSON.stringify(gaps);
    assert.ok(typeof line === "number" && line > 0, seen);
    assert.ok(typeof between === "number", seen);
    assert.ok(typeof above === "number", seen);
    assert.ok(Math.abs(between - line) < line / 2, `one empty line between the lines: ${seen}`);
    assert.ok(Math.abs(above - line) < line / 2, `one empty line above the signature: ${seen}`);
  }

  /**
   * Replaces the children of the editable area with the id, focuses it and collapses the caret at
   * the offset in it or in the element with the id `inId`, then where the caret is.
   */
  async function caretAt(
    page: Page,
    id: string,
    html: string,
    offset: number,
    inId = id,
  ): Promise<Record<string, unknown>> {
    return record(
      await evaluate(
        page,
        `(() => {
          const host = document.getElementById(${JSON.stringify(id)});
          host.innerHTML = ${JSON.stringify(html)};
          host.focus();
          getSelection().collapse(document.getElementById(${JSON.stringify(inId)}), ${offset});
          const selection = getSelection();
          return { id: selection.anchorNode.id, offset: selection.anchorOffset };
        })()`,
      ),
    );
  }

  /** The page's value of a JavaScript expression, through JSON. */
  async function evaluate(page: Page, expression: string): Promise<unknown> {
    const json = await firefox.evaluate(page.context, `JSON.stringify(${expression}) ?? "null"`);
    return JSON.parse(String(json));
  }
});

function typed(method: string): { outcome: string; method: string } {
  return { outcome: "typed", method };
}

function submitted(): { action: string; prevented: boolean } {
  return { action: "submitted", prevented: false };
}

function focusMoved(): { action: string; prevented: boolean } {
  return { action: "focus_moved", prevented: false };
}

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
