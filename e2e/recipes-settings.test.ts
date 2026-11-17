import assert from "node:assert/strict";
import { after, before, describe, type TestContext, test } from "node:test";
import type { Recipe } from "@foxleash/protocol";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { createHarness, EXTENSION_DIST, type Harness } from "./harness.ts";

const SAVED_AT = "2026-10-01T08:00:00.000Z";
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SEEDED = recipe("Check mail", "Reads the new mail");

// The recipes section: its rows, the live region's text, whether the editor and Undo are shown,
// and the focused element's accessible name from aria-label, else its id.
const RECIPES_STATE = `JSON.stringify({
  rows: [...document.querySelectorAll("#recipes li span")].map((span) => span.textContent),
  status: document.getElementById("recipes-status").textContent,
  editor: !document.getElementById("recipe-editor").hidden,
  undo: !document.getElementById("recipe-undo").hidden,
  focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.id || null,
})`;

interface RecipesState {
  rows: string[];
  status: string;
  editor: boolean;
  undo: boolean;
  focus: string | null;
}

// The editor: its heading, each field's value, error list (null while hidden) and aria-invalid.
const EDITOR_STATE = `JSON.stringify({
  heading: document.getElementById("recipe-editor-heading").textContent,
  fields: Object.fromEntries(["name", "description", "sites", "steps"].map((name) => {
    const field = document.getElementById("recipe-" + name);
    const errors = document.getElementById("recipe-" + name + "-errors");
    return [name, {
      value: field.value,
      errors: errors.hidden ? null : [...errors.children].map((item) => item.textContent),
      invalid: field.getAttribute("aria-invalid"),
    }];
  })),
})`;

interface FieldState {
  value: string;
  errors: string[] | null;
  invalid: string | null;
}

interface EditorState {
  heading: string;
  fields: Record<"name" | "description" | "sites" | "steps", FieldState>;
}

const STORED_RECIPES = `browser.storage.local.get(null).then((items) => JSON.stringify(
  Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith("recipe:")).sort())
))`;

// One Firefox for the file: the tests run in order, and each opens its own settings page.
describe("recipes on the settings page, in real Firefox", () => {
  let harness: Harness;
  let firefox: Firefox;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({ [`recipe:${SEEDED.name}`]: SEEDED });
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      await harness?.close();
    },
    { timeout: 60_000 },
  );

  test("a stored recipe is listed with its description", async (t) => {
    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    await waitForRecipes(page, {
      rows: ["Check mail: Reads the new mail"],
      status: "",
      editor: false,
      undo: false,
      focus: null,
    });
    assert.equal(
      await firefox.evaluate(page, `document.getElementById("recipes-empty").hidden`),
      true,
    );
  });

  test("a recipe written in the editor is stored and listed, with focus on its Edit button", async (t) => {
    const page = await openWith(t, []);
    await firefox.click(page, "#recipe-add");
    await waitForFocus(page, "recipe-editor-heading");
    assert.equal(
      await firefox.evaluate(page, `document.getElementById("recipe-editor-heading").textContent`),
      "New recipe",
    );
    await fill(page, {
      name: "Pay invoices",
      description: "Pays this month's invoices",
      sites: "https://bank.example/invoices?month=10\nhttps://bank.example",
      steps: "Open the bank.\nPay each invoice.",
    });
    await firefox.click(page, "#recipe-save");
    await waitForRecipes(page, {
      rows: ["Pay invoices: Pays this month's invoices"],
      status: "Saved Pay invoices",
      editor: false,
      undo: false,
      focus: "Edit Pay invoices",
    });
    const stored = await storedRecipes(page);
    assert.deepEqual(Object.keys(stored), ["recipe:Pay invoices"]);
    const saved = stored["recipe:Pay invoices"];
    assert.match(String(saved?.savedAt), ISO_TIME);
    assert.deepEqual(saved, {
      name: "Pay invoices",
      description: "Pays this month's invoices",
      sites: ["https://bank.example"],
      steps: "Open the bank.\nPay each invoice.",
      savedAt: saved?.savedAt,
    });
  });

  test("a recipe with problems is not saved; the first invalid field takes focus", async (t) => {
    const page = await openWith(t, []);
    await firefox.click(page, "#recipe-add");
    await waitForFocus(page, "recipe-editor-heading");
    const steps = `Line one\n${String.fromCodePoint(0x1f600, 0xad)}x`;
    await fill(page, { name: "", description: "Reads mail", sites: "not an address", steps });
    await firefox.click(page, "#recipe-save");
    await waitForEditor(page, {
      heading: "New recipe",
      fields: {
        name: { value: "", errors: ["Give the recipe a name."], invalid: "true" },
        description: { value: "Reads mail", errors: null, invalid: null },
        sites: {
          value: "not an address",
          errors: ["Line 1: this is not an http or https address."],
          invalid: "true",
        },
        steps: {
          value: steps,
          errors: ["Line 2, column 2: U+00AD (soft hyphen) is invisible; remove it."],
          invalid: "true",
        },
      },
    });
    await waitForRecipes(page, {
      rows: [],
      status: "Not saved: 3 fields need fixing",
      editor: true,
      undo: false,
      focus: "recipe-name",
    });
    assert.deepEqual(await storedRecipes(page), {});

    await fill(page, { name: "Mail", sites: "https://mail.example" });
    await firefox.click(page, "#recipe-save");
    await waitForRecipes(page, {
      rows: [],
      status: "Not saved: 1 field needs fixing",
      editor: true,
      undo: false,
      focus: "recipe-steps",
    });
    // The soft hyphen follows an emoji, two UTF-16 units: "Line one\n" is 9.
    const selection = await firefox.evaluate(
      page,
      `(() => {
        const area = document.getElementById("recipe-steps");
        return JSON.stringify([area.selectionStart, area.selectionEnd]);
      })()`,
    );
    assert.equal(selection, JSON.stringify([11, 12]));
    const { fields } = await editorState(page);
    assert.deepEqual(fields.name, { value: "Mail", errors: null, invalid: null });
    assert.deepEqual(await storedRecipes(page), {});
  });

  test("Edit opens a recipe filled in, and a rename removes the old key", async (t) => {
    const old = recipe("Old name", "Does a thing", ["https://a.example", "https://b.example"]);
    const page = await openWith(t, [old]);
    await firefox.click(page, 'button[aria-label="Edit Old name"]');
    await waitForFocus(page, "recipe-editor-heading");
    assert.deepEqual(await editorState(page), {
      heading: "Edit Old name",
      fields: {
        name: { value: "Old name", errors: null, invalid: null },
        description: { value: "Does a thing", errors: null, invalid: null },
        sites: { value: "https://a.example\nhttps://b.example", errors: null, invalid: null },
        steps: { value: old.steps, errors: null, invalid: null },
      },
    });
    await fill(page, { name: "New name" });
    await firefox.click(page, "#recipe-save");
    await waitForRecipes(page, {
      rows: ["New name: Does a thing"],
      status: "Saved New name",
      editor: false,
      undo: false,
      focus: "Edit New name",
    });
    const stored = await storedRecipes(page);
    assert.deepEqual(Object.keys(stored), ["recipe:New name"]);
    assert.deepEqual(stored["recipe:New name"]?.sites, old.sites);
  });

  test("Delete moves focus to Undo, and Undo restores the recipe", async (t) => {
    const deleted = recipe("Alpha", "First", ["https://a.example"]);
    const page = await openWith(t, [deleted, recipe("Beta", "Second")]);
    await firefox.click(page, 'button[aria-label="Delete Alpha"]');
    await waitForRecipes(page, {
      rows: ["Beta: Second"],
      status: "Deleted Alpha",
      editor: false,
      undo: true,
      focus: "Undo deleting Alpha",
    });
    assert.deepEqual(Object.keys(await storedRecipes(page)), ["recipe:Beta"]);

    await firefox.click(page, "#recipe-undo");
    await waitForRecipes(page, {
      rows: ["Alpha: First", "Beta: Second"],
      status: "Restored Alpha",
      editor: false,
      undo: false,
      focus: "Edit Alpha",
    });
    const { savedAt: _savedAt, ...restored } = (await storedRecipes(page))["recipe:Alpha"] ?? {};
    const { savedAt: _deletedAt, ...fields } = deleted;
    assert.deepEqual(restored, fields);
  });

  test("a scripted click neither saves nor restores, and a held Enter presses no Undo or Add", async (t) => {
    const page = await openWith(t, [recipe("Alpha", "First")]);
    await firefox.click(page, 'button[aria-label="Delete Alpha"]');
    await waitFor(
      page,
      `JSON.stringify([
        document.getElementById("recipes-status").textContent,
        !document.getElementById("recipe-undo").hidden,
      ])`,
      JSON.stringify(["Deleted Alpha", true]),
      "the deleted recipe's Undo",
    );
    await firefox.click(page, "#recipe-add");
    await waitForFocus(page, "recipe-editor-heading");
    // A click Save took would mark the empty name at once; one Undo took would hide it at once.
    const pressed = await firefox.evaluate(
      page,
      `(() => {
        document.getElementById("recipe-save").click();
        const undo = document.getElementById("recipe-undo");
        undo.click();
        const cancels = (id, repeat) =>
          !document.getElementById(id).dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", repeat }),
          );
        return JSON.stringify({
          invalid: document.getElementById("recipe-name").getAttribute("aria-invalid"),
          undoHidden: undo.hidden,
          held: [cancels("recipe-undo", true), cancels("recipe-undo", false), cancels("recipe-add", true)],
        });
      })()`,
    );
    assert.equal(
      pressed,
      JSON.stringify({ invalid: null, undoHidden: false, held: [true, false, true] }),
    );
    assert.deepEqual(await storedRecipes(page), {});
  });

  test("a change elsewhere keeps focus on the same row's Delete button, else the next row's", async (t) => {
    const page = await openWith(t, [recipe("Beta", "Second"), recipe("Gamma", "Third")]);
    await firefox.evaluate(
      page,
      `document.querySelector('button[aria-label="Delete Beta"]').focus()`,
    );
    await setStorage(page, { "recipe:Alpha": recipe("Alpha", "First") });
    await waitForRecipes(page, {
      rows: ["Alpha: First", "Beta: Second", "Gamma: Third"],
      status: "",
      editor: false,
      undo: false,
      focus: "Delete Beta",
    });
    const removed = await firefox.evaluate(
      page,
      `browser.storage.local.remove("recipe:Beta").then(() => true)`,
    );
    assert.equal(removed, true);
    await waitForRecipes(page, {
      rows: ["Alpha: First", "Gamma: Third"],
      status: "",
      editor: false,
      undo: false,
      focus: "Delete Gamma",
    });
  });

  test("Cancel returns focus to the button that opened the editor", async (t) => {
    const page = await openWith(t, [recipe("Alpha", "First")]);
    await firefox.click(page, 'button[aria-label="Edit Alpha"]');
    await waitForFocus(page, "recipe-editor-heading");
    await firefox.click(page, "#recipe-cancel");
    await waitForRecipes(page, {
      rows: ["Alpha: First"],
      status: "",
      editor: false,
      undo: false,
      focus: "Edit Alpha",
    });
    await firefox.click(page, "#recipe-add");
    await waitForFocus(page, "recipe-editor-heading");
    await firefox.click(page, "#recipe-cancel");
    await waitForRecipes(page, {
      rows: ["Alpha: First"],
      status: "",
      editor: false,
      undo: false,
      focus: "recipe-add",
    });
  });

  test("a save over a recipe changed since the editor opened stores nothing", async (t) => {
    const page = await openWith(t, [recipe("Alpha", "First")]);
    await firefox.click(page, 'button[aria-label="Edit Alpha"]');
    await waitForFocus(page, "recipe-editor-heading");
    const elsewhere = {
      ...recipe("Alpha", "Changed elsewhere"),
      savedAt: new Date().toISOString(),
    };
    await setStorage(page, { "recipe:Alpha": elsewhere });
    await waitForRecipes(page, {
      rows: ["Alpha: Changed elsewhere"],
      status: "",
      editor: true,
      undo: false,
      focus: "recipe-editor-heading",
    });
    const { fields } = await editorState(page);
    assert.equal(fields.description.value, "First");
    await fill(page, { steps: "My change" });
    await firefox.click(page, "#recipe-save");
    await waitForRecipes(page, {
      rows: ["Alpha: Changed elsewhere"],
      status:
        "Alpha changed since you opened it. Cancel and open it again to see the current version.",
      editor: true,
      undo: false,
      focus: "recipe-save",
    });
    assert.deepEqual(await storedRecipes(page), { "recipe:Alpha": elsewhere });
  });

  test("an Edit click lands when a recipe is added above it between press and release", async (t) => {
    const page = await openWith(t, [recipe("Beta", "Second"), recipe("Gamma", "Third")]);
    // Focus is elsewhere, so the press moves it.
    await firefox.evaluate(
      page,
      `document.querySelector('button[aria-label="Edit Gamma"]').scrollIntoView({ block: "center" });
      document.getElementById("recipes-heading").focus({ preventScroll: true })`,
    );
    await firefox.press(page, 'button[aria-label="Edit Gamma"]');
    try {
      await storeDuringPress(page, { "recipe:Alpha": recipe("Alpha", "First") });
    } finally {
      await firefox.release(page);
    }
    await waitForRecipes(page, {
      rows: ["Alpha: First", "Beta: Second", "Gamma: Third"],
      status: "",
      editor: true,
      undo: false,
      focus: "recipe-editor-heading",
    });
    assert.equal((await editorState(page)).heading, "Edit Gamma");
  });

  /**
   * Stores exactly `recipes`, then opens a settings page once it lists them. The writes run in
   * another page first: each storage change re-renders the list, and a render arriving after the
   * rows show would replace the buttons a test is about to click.
   */
  async function openWith(t: TestContext, recipes: Recipe[]): Promise<string> {
    const writer = await harness.settingsPage();
    try {
      const entries = JSON.stringify(
        JSON.stringify(
          Object.fromEntries(recipes.map((stored) => [`recipe:${stored.name}`, stored])),
        ),
      );
      const reset = await firefox.evaluate(
        writer,
        `browser.storage.local.get(null)
          .then((items) => browser.storage.local.remove(
            Object.keys(items).filter((key) => key.startsWith("recipe:")),
          ))
          .then(() => browser.storage.local.set(JSON.parse(${entries})))
          .then(() => true)`,
      );
      assert.equal(reset, true);
    } finally {
      await firefox.closeContext(writer);
    }
    const page = await harness.settingsPage();
    t.after(() => firefox.closeContext(page));
    await waitFor(
      page,
      `JSON.stringify([...document.querySelectorAll("#recipes li span")].map((span) => span.textContent))`,
      JSON.stringify(recipes.map(({ name, description }) => `${name}: ${description}`)),
      "the recipes",
    );
    return page;
  }

  async function fill(page: string, values: Record<string, string>): Promise<void> {
    await firefox.evaluate(
      page,
      `for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
        document.getElementById("recipe-" + name).value = value;
      }`,
    );
  }

  async function setStorage(page: string, entries: Record<string, unknown>): Promise<void> {
    const stored = await firefox.evaluate(
      page,
      `browser.storage.local.set(${JSON.stringify(entries)}).then(() => true)`,
    );
    assert.equal(stored, true);
  }

  /**
   * Stores `entries` and returns once the page has handled the reads the change started: its own
   * storage listener runs first, and reads finish in the order they started.
   */
  async function storeDuringPress(page: string, entries: Record<string, unknown>): Promise<void> {
    const stored = await firefox.evaluate(
      page,
      `new Promise((resolve, reject) => {
        const seen = (changes, area) => {
          if (area !== "local") return;
          browser.storage.onChanged.removeListener(seen);
          browser.storage.local.get(null).then(() => resolve(true), reject);
        };
        browser.storage.onChanged.addListener(seen);
        browser.storage.local.set(${JSON.stringify(entries)}).catch((error) => {
          browser.storage.onChanged.removeListener(seen);
          reject(error);
        });
      })`,
    );
    assert.equal(stored, true);
  }

  async function storedRecipes(page: string): Promise<Record<string, Record<string, unknown>>> {
    return JSON.parse(String(await firefox.evaluate(page, STORED_RECIPES)));
  }

  async function editorState(page: string): Promise<EditorState> {
    return JSON.parse(String(await firefox.evaluate(page, EDITOR_STATE)));
  }

  async function waitForFocus(page: string, id: string): Promise<void> {
    await waitFor(page, "document.activeElement?.id ?? null", id, "the focused element");
  }

  async function waitForRecipes(page: string, expected: RecipesState): Promise<void> {
    await waitFor(page, RECIPES_STATE, JSON.stringify(expected), "the recipes section");
  }

  async function waitForEditor(page: string, expected: EditorState): Promise<void> {
    await waitFor(page, EDITOR_STATE, JSON.stringify(expected), "the recipe editor");
  }

  async function waitFor(
    context: string,
    expression: string,
    expected: string,
    what: string,
  ): Promise<void> {
    await pollUntil(
      async () => {
        const value = await firefox.evaluate(context, expression);
        if (value === expected) return true;
        throw new Error(`the page shows ${String(value)}`);
      },
      PAGE_TIMEOUT_MS,
      `${what}: ${expected}`,
    );
  }
});

function recipe(name: string, description: string, sites = ["https://a.example"]): Recipe {
  return { name, description, sites, steps: `The steps of ${name}.`, savedAt: SAVED_AT };
}
