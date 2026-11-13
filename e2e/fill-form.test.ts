import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  AUTOFILL_LOGIN,
  FILL_KEY,
  FILL_PASSWORD,
  type FixtureServer,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  tabOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
// Long enough for a navigation Firefox itself would queue to have started.
const SETTLE_MS = 300;
const AUTOFILLED = 'document.getElementById("login-name").matches(":autofill")';

interface Page {
  url: string;
  tabId: number;
  context: string;
  tree: string;
}

type FieldResult = Record<string, unknown>;

// One Firefox for the file: the tests run in order, most of them on the same page.
describe("fill_form in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let form: Page;
  let opened = 0;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
      form = await open("/fill-form", TITLES.fillForm);
    },
    { timeout: 120_000 },
  );

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

  test("one call fills text fields, a password, a React input, selects, checkboxes and a radio", async () => {
    const lines = [
      'textbox "Text"',
      'textbox "Area"',
      'textbox "Email"',
      'spinbutton "Number"',
      'textbox "Password"',
      'textbox "React"',
      'combobox "Single"',
      'listbox "Multi"',
      'checkbox "Off box"',
      'checkbox "On box"',
      'radio "Second pick"',
    ];
    const values = [
      "New text",
      "First\nSecond",
      "new@example.com",
      "41",
      "pw-fill-new-Lm8",
      "react text",
      "se",
      ["Green", "Blue"],
      true,
      false,
      true,
    ];
    const fields = lines.map((line, index) => ({
      ref: refOf(form.tree, line),
      value: values[index],
    }));
    const result = await harness.call(session, "fill_form", { tabId: form.tabId, fields });
    assert.equal(result.isError, false, result.text);
    for (const secret of [FILL_PASSWORD, "pw-fill-new-Lm8"]) {
      assert.equal(result.text.includes(secret), false, result.text);
    }
    const outcomes = [
      "typed",
      "typed",
      "typed",
      "typed",
      "typed",
      "typed",
      "selected",
      "selected",
      "clicked",
      "clicked",
      "clicked",
    ];
    assert.deepEqual(parseResult(result.text), {
      fields: fields.map(({ ref }, index) => ({ ref, ok: true, outcome: outcomes[index] })),
    });
    assert.deepEqual(
      await evaluate(
        form,
        `["text", "area", "email", "number", "password", "react"].map((id) => document.getElementById(id).value)`,
      ),
      ["New text", "First\nSecond", "new@example.com", "41", "pw-fill-new-Lm8", "react text"],
    );
    assert.equal(await evaluate(form, "window.reactState.react"), "react text");
    assert.equal(await evaluate(form, 'document.getElementById("single").value'), "se");
    assert.deepEqual(
      await evaluate(
        form,
        'Array.from(document.getElementById("multi").selectedOptions, (option) => option.value)',
      ),
      ["g", "b"],
    );
    assert.deepEqual(
      await evaluate(
        form,
        `["off", "on", "first", "second"].map((id) => document.getElementById(id).checked)`,
      ),
      [true, false, false, true],
    );
    const changed = ["text", "area", "email", "number", "password", "react", "single", "multi"];
    assert.deepEqual(
      await evaluate(
        form,
        `${JSON.stringify([...changed, "off", "on", "second"])}.map((id) => window.countOf(id, "change"))`,
      ),
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    );
    assert.equal(await evaluate(form, 'window.countOf("first", "change")'), 0);
    await sleep(SETTLE_MS);
    assert.equal(await evaluate(form, "window.submits"), 0);
    assert.equal(await evaluate(form, "location.href"), form.url);
  });

  test("a field that fails fails only its own entry", async () => {
    const entries: [string, unknown][] = [
      ['textbox "Disabled"', "x"],
      ['textbox "Second text"', "Second new"],
      ['listbox "Multi"', ["Red", "Purple"]],
      ['combobox "Single"', "Norway"],
      ['spinbutton "Number"', "abc"],
      ['radio "First pick"', false],
      ['textbox "Area"', true],
      ['checkbox "Stubborn box"', true],
      ['combobox "Sticky"', "b"],
      ['textbox "Suggest"', "abc"],
      ['textbox "Locking"', "Locking new"],
      ['textbox "Shifty"', "Shifty new"],
      ['textbox "Short"', "Too long"],
      ['textbox "Guarded"', "Guarded new"],
      ['checkbox "Off box"', false],
    ];
    const fields: { ref: string; value: unknown }[] = [
      ...entries.map(([line, value]) => ({ ref: refOf(form.tree, line), value })),
      { ref: "not-a-ref", value: "x" },
    ];
    const results = await fill(form, fields);
    assert.deepEqual(
      results.map((result) => [
        result.ref,
        result.ok,
        result.ok === true ? result.outcome : result.code,
      ]),
      [
        [fields[0]?.ref, false, "not_editable"],
        [fields[1]?.ref, true, "typed"],
        [fields[2]?.ref, false, "invalid_params"],
        [fields[3]?.ref, false, "invalid_params"],
        [fields[4]?.ref, false, "invalid_params"],
        [fields[5]?.ref, false, "invalid_params"],
        [fields[6]?.ref, false, "invalid_params"],
        [fields[7]?.ref, false, "no_effect"],
        [fields[8]?.ref, false, "no_effect"],
        [fields[9]?.ref, false, "no_effect"],
        [fields[10]?.ref, false, "not_editable"],
        [fields[11]?.ref, false, "not_editable"],
        [fields[12]?.ref, false, "invalid_params"],
        [fields[13]?.ref, false, "not_editable"],
        [fields[14]?.ref, true, "clicked"],
        ["not-a-ref", false, "invalid_ref"],
      ],
    );
    const phrases: [number, string][] = [
      [0, "disabled or read-only field, so fill_form cannot"],
      [2, "no option with that value or label (entry 2)"],
      [3, "that matches is disabled"],
      [4, "would not keep that value"],
      [5, "turned off by choosing another one"],
      [6, "needs a string for text field"],
      [7, "the page cancelled the click"],
      [8, "did not keep the chosen options"],
      [9, "lost the given text when it lost focus"],
      [10, "disabled or read-only field, so fill_form cannot"],
      [11, "is none of them"],
      [12, "takes at most 4 characters"],
      [13, "disabled or read-only field, so fill_form cannot"],
    ];
    for (const [index, phrase] of phrases) {
      const message = String(results[index]?.message);
      assert.ok(message.includes(phrase), message);
    }
    assert.deepEqual(
      await evaluate(
        form,
        `["disabled", "second-text", "single", "number", "sticky", "suggest", "locking", "shifty", "short", "guarded"].map((id) => document.getElementById(id).value)`,
      ),
      [
        "Off",
        "Second new",
        "se",
        "41",
        "a",
        "",
        "Locking before",
        "Shifty before",
        "Ab",
        "Guarded before",
      ],
    );
    assert.deepEqual(
      await evaluate(
        form,
        'Array.from(document.getElementById("multi").selectedOptions, (option) => option.value)',
      ),
      ["g", "b"],
    );
    assert.deepEqual(
      await evaluate(
        form,
        `["off", "stubborn", "first", "second"].map((id) => document.getElementById(id).checked)`,
      ),
      [false, false, false, true],
    );
  });

  test("a select and a checkbox that already hold the value are unchanged, with no events", async () => {
    const before = await evaluate(form, "window.events.length");
    const fields = [
      { ref: refOf(form.tree, 'combobox "Single"'), value: "Sweden" },
      { ref: refOf(form.tree, 'checkbox "On box"'), value: false },
      { ref: refOf(form.tree, 'radio "Second pick"'), value: true },
    ];
    assert.deepEqual(
      await fill(form, fields),
      fields.map(({ ref }) => ({ ref, ok: true, outcome: "unchanged" })),
    );
    assert.equal(await evaluate(form, "window.events.length"), before);
  });

  test("an empty string clears a text field", async () => {
    const ref = refOf(form.tree, 'textbox "Text"');
    const changes = Number(await evaluate(form, 'window.countOf("text", "change")'));
    assert.deepEqual(await fill(form, [{ ref, value: "" }]), [{ ref, ok: true, outcome: "typed" }]);
    assert.equal(await evaluate(form, 'document.getElementById("text").value'), "");
    assert.equal(await evaluate(form, 'window.countOf("text", "change")'), changes + 1);
  });

  test("a field whose page cancels the browser's insertion takes the text through the setter", async () => {
    const ref = refOf(form.tree, 'textbox "Cancelling"');
    // Other text than the field holds, then the text it holds.
    const sequences: unknown[][] = [];
    for (const value of ["After", "After"]) {
      const start = (await eventTypes(form, "cancelling")).length;
      assert.deepEqual(await fill(form, [{ ref, value }]), [{ ref, ok: true, outcome: "typed" }]);
      assert.equal(await evaluate(form, 'document.getElementById("cancelling").value'), "After");
      sequences.push((await eventTypes(form, "cancelling")).slice(start));
    }
    // The page sees the same events in the same order, one change each.
    assert.deepEqual(sequences[0], sequences[1]);
    assert.equal(sequences[0]?.filter((type) => type === "change").length, 1, String(sequences[0]));
  });

  test("filling a password field with what it holds answers as with any other text", async () => {
    const ref = refOf(form.tree, 'textbox "Password"');
    const trusted =
      'window.events.filter((event) => event.id === "password" && event.type === "input" && event.trusted).length';
    const before = Number(await evaluate(form, trusted));
    // The text the field holds, then other text: from an unfocused field, then from one that
    // has focus when fill_form starts.
    for (const [focused, held, other] of [
      [false, "pw-fill-new-Lm8", "pw-fill-other-Zt2"],
      [true, "pw-fill-other-Zt2", "pw-fill-new-Lm8"],
    ] as const) {
      const results: unknown[] = [];
      const sequences: unknown[][] = [];
      for (const value of [held, other]) {
        if (focused) {
          await harness.ok(session, "press_key", { tabId: form.tabId, key: "ArrowLeft", ref });
        }
        const start = (await eventTypes(form, "password")).length;
        const result = await harness.call(session, "fill_form", {
          tabId: form.tabId,
          fields: [{ ref, value }],
        });
        assert.equal(result.isError, false, result.text);
        results.push(parseResult(result.text));
        sequences.push((await eventTypes(form, "password")).slice(start));
      }
      const typed = { fields: [{ ref, ok: true, outcome: "typed" }] };
      assert.deepEqual(results, [typed, typed]);
      // The page sees the same events in the same order, one change each.
      assert.deepEqual(sequences[0], sequences[1], `focused: ${focused}`);
      assert.equal(sequences[0]?.filter((type) => type === "change").length, 1);
    }
    // Firefox fires its own input for every fill: the identical text took the same path.
    assert.equal(await evaluate(form, trusted), before + 4);
    assert.equal(
      await evaluate(form, 'document.getElementById("password").value'),
      "pw-fill-new-Lm8",
    );
  });

  test("a checkbox inside a link is checked and the link is not followed", async () => {
    const ref = refOf(form.tree, 'checkbox "Linked box"');
    assert.deepEqual(await fill(form, [{ ref, value: true }]), [
      { ref, ok: true, outcome: "clicked" },
    ]);
    await sleep(SETTLE_MS);
    assert.equal(await evaluate(form, "location.href"), form.url);
    assert.equal(await evaluate(form, 'document.getElementById("linked").checked'), true);
  });

  test("a ref given twice is refused before the page changes", async () => {
    const ref = refOf(form.tree, 'textbox "Second text"');
    const text = await harness.refused(session, "fill_form", {
      tabId: form.tabId,
      fields: [
        { ref, value: "Twice" },
        { ref: refOf(form.tree, 'checkbox "Off box"'), value: true },
        { ref, value: "Again" },
      ],
    });
    assert.ok(text.includes("fill_form takes each ref at most once."), text);
    assert.equal(
      await evaluate(form, 'document.getElementById("second-text").value'),
      "Second new",
    );
    assert.equal(await evaluate(form, 'document.getElementById("off").checked'), false);
  });

  test("a password field that one field adds and the next shows as text stays protected", async () => {
    const page = await open("/fill-form", TITLES.fillForm);
    const fields = [
      { ref: refOf(page.tree, 'combobox "Security"'), value: "WPA2" },
      { ref: refOf(page.tree, 'checkbox "Show key"'), value: true },
    ];
    assert.deepEqual(await fill(page, fields), [
      { ref: fields[0]?.ref, ok: true, outcome: "selected" },
      { ref: fields[1]?.ref, ok: true, outcome: "clicked" },
    ]);
    assert.equal(await evaluate(page, 'document.getElementById("key").type'), "text");
    const tree = await readTree(page.tabId);
    assert.equal(tree.includes(FILL_KEY), false, tree);
    assert.match(tree, /textbox "Key" \[[^\]]+\] protected filled/);
  });

  test("no field is started after 4 seconds, and the call still returns", {
    timeout: 60_000,
  }, async () => {
    const page = await open("/fill-form", TITLES.fillForm);
    const slow = refOf(page.tree, 'textbox "Slow"');
    const text = refOf(page.tree, 'textbox "Text"');
    const results = await fill(page, [
      { ref: slow, value: "Slow after" },
      { ref: text, value: "Late" },
    ]);
    assert.deepEqual(results[0], { ref: slow, ok: true, outcome: "typed" });
    assert.equal(results[1]?.code, "not_attempted");
    assert.equal(results[1]?.ok, false);
    assert.ok(String(results[1]?.message).includes("ran out of time before element"));
    assert.equal(await evaluate(page, 'document.getElementById("slow").value'), "Slow after");
    assert.equal(await evaluate(page, 'document.getElementById("text").value'), "Old text");
  });

  test("no text goes in after 5 seconds, and the call still returns", {
    timeout: 60_000,
  }, async () => {
    const page = await open("/fill-form", TITLES.fillForm);
    const slower = refOf(page.tree, 'textbox "Slower"');
    const results = await fill(page, [{ ref: slower, value: "Slower after" }]);
    assert.equal(results[0]?.code, "no_effect");
    assert.ok(
      String(results[0]?.message).includes("ran out of time before it could put the text in"),
      String(results[0]?.message),
    );
    assert.equal(await evaluate(page, 'document.getElementById("slower").value'), "Slower before");
  });

  test("no text goes in through the setter after 5 seconds, and the call still returns", {
    timeout: 60_000,
  }, async () => {
    const page = await open("/fill-form", TITLES.fillForm);
    const ref = refOf(page.tree, 'textbox "Late cancelling"');
    const results = await fill(page, [{ ref, value: "Late after" }]);
    assert.equal(results[0]?.code, "no_effect");
    assert.ok(
      String(results[0]?.message).includes("ran out of time before it could put the text in"),
      String(results[0]?.message),
    );
    assert.equal(
      await evaluate(page, 'document.getElementById("late-cancelling").value'),
      "Late before",
    );
  });

  test("five text fields in a tab that is not the active one are all filled in one call", async () => {
    const page = await open("/fill-form", TITLES.fillForm);
    await open("/fill-form", TITLES.fillForm);
    await pollUntil(
      async () =>
        (await evaluate(page, "document.visibilityState")) === "hidden" ? true : undefined,
      PAGE_TIMEOUT_MS,
      "the tab to be hidden",
    );
    const lines = [
      'textbox "Text"',
      'textbox "Area"',
      'textbox "Email"',
      'textbox "Password"',
      'textbox "React"',
    ];
    const values = [
      "New text",
      "First\nSecond",
      "new@example.com",
      "pw-fill-new-Lm8",
      "react text",
    ];
    const fields = lines.map((line, index) => ({
      ref: refOf(page.tree, line),
      value: values[index],
    }));
    const started = Date.now();
    const results = await fill(page, fields);
    const took = Date.now() - started;
    assert.deepEqual(
      results,
      fields.map(({ ref }) => ({ ref, ok: true, outcome: "typed" })),
    );
    assert.deepEqual(
      await evaluate(
        page,
        '["text", "area", "email", "password", "react"].map((id) => document.getElementById(id).value)',
      ),
      values,
    );
    // Each text field waits 100 ms for the page, and Firefox delays a hidden tab's timers to a
    // second.
    assert.ok(took < 2_000, `fill_form took ${took} ms`);
  });

  test("a field Firefox autofilled from a saved login is refused and stays autofilled", async () => {
    let page: Page;
    await firefox.saveLogin(fixtures.site, AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password);
    try {
      // tab_open makes the tab active: login autofill waits for a visible document.
      page = await open("/autofill", TITLES.autofill);
      const context = page.context;
      await pollUntil(
        async () => ((await firefox.evaluate(context, AUTOFILLED)) === true ? true : undefined),
        PAGE_TIMEOUT_MS,
        "Firefox to fill the saved login",
      );
    } finally {
      await firefox.removeLogins();
    }
    const tree = await readTree(page.tabId);
    const ref = refOf(tree, 'textbox "Login name"');
    const results = await fill({ ...page, tree }, [{ ref, value: "x" }]);
    assert.equal(results[0]?.code, "not_editable");
    assert.ok(String(results[0]?.message).includes(`Firefox filled in element ${ref}`));
    assert.equal(await firefox.evaluate(page.context, AUTOFILLED), true);
    assert.equal(
      await firefox.evaluate(page.context, 'document.getElementById("login-name").value'),
      AUTOFILL_LOGIN.username,
    );
  });

  async function open(path: string, title: string): Promise<Page> {
    opened += 1;
    const url = fixtures.url(`${path}?tab=${opened}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal(tab.title, title, `unexpected tab ${JSON.stringify(tab)}`);
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    return { url, tabId: tab.id, context: found.context, tree: await readTree(tab.id) };
  }

  async function readTree(tabId: number): Promise<string> {
    const read = await harness.call(session, "read_page", { tabId });
    assert.equal(read.isError, false, read.text);
    return untrustedContent(read.text) ?? "";
  }

  /** fill_form's results, one per field. */
  async function fill(
    page: Page,
    fields: { ref: string; value: unknown }[],
  ): Promise<FieldResult[]> {
    const result = record(await harness.ok(session, "fill_form", { tabId: page.tabId, fields }));
    assert.ok(Array.isArray(result.fields), JSON.stringify(result));
    return result.fields.map(record);
  }

  /** The types of the input, change and blur events the page logged for an element, in order. */
  async function eventTypes(page: Page, id: string): Promise<unknown[]> {
    const types = await evaluate(
      page,
      `window.events.filter((event) => event.id === ${JSON.stringify(id)}).map((event) => event.type)`,
    );
    assert.ok(Array.isArray(types));
    return types;
  }

  /** The page's value of a JavaScript expression, through JSON. */
  async function evaluate(page: Page, expression: string): Promise<unknown> {
    const json = await firefox.evaluate(page.context, `JSON.stringify(${expression}) ?? "null"`);
    return JSON.parse(String(json));
  }
});

function refOf(tree: string, line: string): string {
  const ref = new RegExp(`${line} \\[${REF}\\]`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line} in:\n${tree}`);
  return ref;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
