import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Recipe, RecipeFields } from "@foxhand/protocol";
import { createFakeBrowser, type FakeBrowser } from "./fake-browser.ts";
import {
  checkRecipe,
  deleteRecipe,
  type RecipeProblem,
  readRecipes,
  recipeOf,
  saveRecipe,
} from "./recipes.ts";

const NOW = "2026-10-30T12:00:00.000Z";
const EARLIER = "2026-10-01T08:00:00.000Z";
const SITE = "https://a.example";
const VALID = {
  name: "Pay invoices",
  description: "Pays this month's invoices",
  sites: SITE,
  steps: "Open the bank and pay each invoice.",
};

/** The characters always refused, with the name a problem gives them. */
const HIDDEN: [number, string | undefined][] = [
  [0xe0041, "tag character"],
  [0xad, "soft hyphen"],
  [0x200b, "zero width space"],
  [0x2060, "word joiner"],
  [0xfeff, "zero width no-break space"],
  [0x202e, "right-to-left override"],
  [0x202a, "left-to-right embedding"],
  [0x2066, "left-to-right isolate"],
  [0x200e, "left-to-right mark"],
  [0x61c, "Arabic letter mark"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0x2800, "braille pattern blank"],
  [0x7, "control character"],
  [0x85, "control character"],
  [0xfff9, "interlinear annotation character"],
  [0xfffb, "interlinear annotation character"],
  [0xe0000, "tag character"],
  [0xe007f, "tag character"],
  [0x0, "control character"],
  [0x1f, "control character"],
  [0x7f, "control character"],
  [0x9f, "control character"],
  [0xe0001, "tag character"],
  [0x600, undefined],
  [0x13430, undefined],
  [0x115f, undefined],
  [0x16fe4, "Khitan small script filler"],
  [0x1d159, "musical symbol null notehead"],
];

/** Joiners and variation selectors where emoji and scripts need them. */
const KEPT: Record<string, string> = {
  family: c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
  "heart on fire": c(0x2764, 0xfe0f, 0x200d, 0x1f525),
  "rainbow flag": c(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
  "keycap 1": c(0x31, 0xfe0f, 0x20e3),
  "keycap #": c(0x23, 0xfe0f, 0x20e3),
  "woman running": c(0x1f3c3, 0x200d, 0x2640, 0xfe0f),
  "skin tone": c(0x1f44d, 0x1f3fb),
  Persian: `می${c(0x200c)}خواهم`,
  Devanagari: c(0x915, 0x94d, 0x200d, 0x937),
  "ideographic variation": c(0x845b, 0xe0100),
  German: `Auf${c(0x200c)}lage`,
};

/** Joiners and variation selectors out of place, with the first one's column. */
const MISPLACED: Record<string, [string, number, number, string]> = {
  "50 selectors after an emoji": [
    c(0x1f600) + Array.from({ length: 50 }, (_, index) => c(0xe0100 + index)).join(""),
    2,
    0xe0100,
    "variation selector",
  ],
  "a selector after a letter": [`a${c(0xfe0f)}`, 2, 0xfe0f, "variation selector"],
  "an ideographic selector after a letter": [`a${c(0xe0100)}`, 2, 0xe0100, "variation selector"],
  "the last ideographic selector after a letter": [
    `a${c(0xe01ef)}`,
    2,
    0xe01ef,
    "variation selector",
  ],
  "the first selector after a letter": [`a${c(0xfe00)}`, 2, 0xfe00, "variation selector"],
  "an ideographic selector after an emoji": [c(0x1f600, 0xe0100), 2, 0xe0100, "variation selector"],
  "two emoji selectors": [c(0x1f600, 0xfe0f, 0xfe0f), 3, 0xfe0f, "variation selector"],
  "a leading joiner": [`${c(0x200d)}ab`, 1, 0x200d, "zero width joiner"],
  "two non-joiners between letters": [`a${c(0x200c, 0x200c)}b`, 2, 0x200c, "zero width non-joiner"],
  "a non-joiner before a space": [`a${c(0x200c)} b`, 2, 0x200c, "zero width non-joiner"],
  "a trailing joiner": [`ab${c(0x200d)}`, 3, 0x200d, "zero width joiner"],
};

describe("readRecipes", () => {
  it("returns the stored recipes sorted by name, ignoring other keys silently", async (t) => {
    const { fake, warnings } = setup(t);
    const decomposed = `Caf${c(0x65, 0x301)}`;
    const composed = `Caf${c(0xe9)}`;
    const names = ["Oslo", composed, "Zebra", "Apple", decomposed, "Ölands", "apple"];
    await seed(fake, ...names.map((name) => recipe(name)));
    await fake.browser.storage.local.set({
      "site:https://a.example": { grantedAt: EARLIER },
      blocklist: ["example.com"],
      other: 1,
    });
    assert.deepEqual(
      (await readRecipes(fake.browser)).map(({ name }) => name),
      ["apple", "Apple", decomposed, composed, "Ölands", "Oslo", "Zebra"],
    );
    assert.deepEqual(warnings(), []);
  });

  it("returns each recipe with its five fields", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("Pay invoices"));
    assert.deepEqual(await readRecipes(fake.browser), [recipe("Pay invoices")]);
  });

  it("ignores each malformed recipe with one warning naming its key", async (t) => {
    const { fake, warnings } = setup(t);
    const valid = recipe("a");
    const { savedAt: _savedAt, ...unsaved } = valid;
    const holey: string[] = [];
    holey[0] = SITE;
    holey[2] = SITE;
    const malformed: Record<string, unknown> = {
      "recipe:a": "text",
      "recipe:b": null,
      "recipe:c": [valid],
      "recipe:d": { ...valid, name: "d2" },
      "recipe:e": { ...unsaved, name: "e" },
      "recipe:f": { ...valid, name: "f", description: 1 },
      "recipe:g": { ...valid, name: "g", steps: undefined },
      "recipe:h": { ...valid, name: "h", savedAt: 1 },
      "recipe:i": { ...valid, name: "i", sites: SITE },
      "recipe:j": { ...valid, name: "j", sites: ["https://a.example/"] },
      "recipe:k": { ...valid, name: "k", sites: [SITE, 1] },
      // A hole, which every() would skip.
      "recipe:l": { ...valid, name: "l", sites: holey },
      "recipe:m": { ...valid, name: 1 },
    };
    await fake.browser.storage.local.set({ ...malformed, "recipe:kept": recipe("kept") });
    assert.deepEqual(await readRecipes(fake.browser), [recipe("kept")]);
    assert.deepEqual(
      warnings(),
      Object.keys(malformed).map((key) => ({ event: "ignored_recipe", key })),
    );
  });

  it("reads a recipe named __proto__", async (t) => {
    const { fake, warnings } = setup(t);
    await fake.browser.storage.local.set(
      JSON.parse(`{"recipe:__proto__": ${JSON.stringify(recipe("__proto__"))}}`),
    );
    assert.deepEqual(await readRecipes(fake.browser), [recipe("__proto__")]);
    assert.deepEqual(warnings(), []);
  });
});

describe("recipeOf", () => {
  it("returns a new object with exactly the five fields", () => {
    const sites = [SITE];
    const value = { ...recipe("a"), sites, extra: "x" };
    const read = recipeOf("recipe:a", value);
    assert.deepEqual(read, recipe("a"));
    assert.notEqual(read?.sites, sites);
  });

  it("refuses a key without the recipe prefix", () => {
    assert.equal(recipeOf("site:a", recipe("a")), undefined);
    assert.equal(recipeOf("a", recipe("a")), undefined);
  });

  it("refuses a value whose fields are inherited", () => {
    const { name, ...rest } = recipe("a");
    assert.equal(recipeOf("recipe:a", Object.assign(Object.create({ name }), rest)), undefined);
    for (const field of ["description", "sites", "steps", "savedAt"] as const) {
      const own: Record<string, unknown> = { ...recipe("a") };
      const inherited = own[field];
      delete own[field];
      const value = Object.assign(Object.create({ [field]: inherited }), own);
      assert.equal(recipeOf("recipe:a", value), undefined, field);
    }
  });
});

describe("checkRecipe", () => {
  it("normalizes a valid recipe", () => {
    const result = checkRecipe({
      name: `  Caf${c(0x65, 0x301)}${c(0xa0)}and  ${c(0x2003)}tea  `,
      description: ` Pays${c(0x3000)}the invoices `,
      sites: `\n  https://a.example/path?q=1  \n\nhttps://b.example\r\nhttps://a.example\n`,
      steps: "Open\r\nPay",
    });
    assert.deepEqual(result, {
      ok: true,
      recipe: {
        name: `Caf${c(0xe9)} and tea`,
        description: "Pays the invoices",
        sites: [SITE, "https://b.example"],
        steps: "Open\nPay",
      },
    });
  });

  it("takes the sites as a list", () => {
    const result = checkRecipe({
      ...VALID,
      sites: ["https://a.example/x", "", " http://127.0.0.1:8080/ ", SITE],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.recipe.sites, [SITE, "http://127.0.0.1:8080"]);
  });

  it("refuses a field that is not text", () => {
    assert.deepEqual(problems({ name: 1, description: null, sites: 2, steps: undefined }), [
      { field: "name", text: "The name must be text." },
      { field: "description", text: "The description must be text." },
      { field: "sites", text: "The sites must be a list of addresses." },
      { field: "steps", text: "The steps must be text." },
    ]);
  });

  it("refuses empty fields", () => {
    assert.deepEqual(problems({ name: " ", description: "", sites: "\n \n", steps: " \n\t" }), [
      { field: "name", text: "Give the recipe a name." },
      { field: "description", text: "Give the recipe a one-line description." },
      { field: "sites", text: "List at least one site, such as https://example.com." },
      { field: "steps", text: "Write the steps." },
    ]);
    assert.deepEqual(problems({ ...VALID, sites: [] }), [
      { field: "sites", text: "List at least one site, such as https://example.com." },
    ]);
  });

  it("takes each field at its limit and refuses one character more, counting an emoji once", () => {
    const emoji = c(0x1f600);
    const atLimit = checkRecipe({
      name: emoji.repeat(100),
      description: emoji.repeat(200),
      sites: Array.from({ length: 20 }, (_, index) => `https://s${index}.example`),
      steps: emoji.repeat(20_000),
    });
    assert.ok(atLimit.ok);
    assert.deepEqual(
      problems({
        name: emoji.repeat(101),
        description: "d".repeat(201),
        sites: Array.from({ length: 21 }, (_, index) => `https://s${index}.example`),
        steps: emoji.repeat(20_001),
      }),
      [
        { field: "name", text: "The name has 101 characters; the most is 100." },
        { field: "description", text: "The description has 201 characters; the most is 200." },
        { field: "sites", text: "The recipe lists 21 sites; the most is 20." },
        { field: "steps", text: "The steps have 20,001 characters; the most is 20,000." },
      ],
    );
  });

  it("counts the sites after dropping duplicates", () => {
    const sites = Array.from({ length: 20 }, (_, index) => `https://s${index}.example`);
    const result = checkRecipe({ ...VALID, sites: [...sites, "https://s0.example/again"] });
    assert.ok(result.ok);
    assert.deepEqual(result.recipe.sites, sites);
  });

  it("measures lengths after trimming", () => {
    assert.ok(checkRecipe({ ...VALID, name: ` ${"n".repeat(100)} ` }).ok);
  });

  it("refuses every site line that is not an http or https site, by line", () => {
    const host253 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    assert.equal(host253.length, 253);
    assert.ok(checkRecipe({ ...VALID, sites: `https://${host253}/path` }).ok);
    const sites = [
      "https://ok.example",
      "",
      "example.com",
      "ftp://a.example/",
      "https://pay\tpal.com/",
      "https://a@b.example/",
      "https://:secret@b.example/",
      `https://a${host253}/path`,
      "https://medium.com/@a/b",
      "https://*.example.com/",
    ].join("\n");
    assert.deepEqual(problems({ ...VALID, sites }), [
      { field: "sites", text: "Line 3: this is not an http or https address.", line: 3 },
      { field: "sites", text: "Line 4: this is not an http or https address.", line: 4 },
      { field: "sites", text: "Line 5: this is not an http or https address.", line: 5 },
      {
        field: "sites",
        text: "Line 6: this address has a user name before the site; give the site only.",
        line: 6,
      },
      {
        field: "sites",
        text: "Line 7: this address has a user name before the site; give the site only.",
        line: 7,
      },
      {
        field: "sites",
        text: "Line 8: this address's host is longer than 253 characters.",
        line: 8,
      },
      { field: "sites", text: "Line 10: this address has a wildcard; list each site.", line: 10 },
    ]);
    assert.deepEqual(problems({ ...VALID, sites: [SITE, 1] }), [
      { field: "sites", text: "Line 2: this is not an http or https address.", line: 2 },
    ]);
  });

  it("keeps an @ in a path", () => {
    const result = checkRecipe({ ...VALID, sites: "https://medium.com/@a/b" });
    assert.ok(result.ok);
    assert.deepEqual(result.recipe.sites, ["https://medium.com"]);
  });

  it("refuses each always-hidden character in every field, naming it and where it is", () => {
    for (const [codePoint, name] of HIDDEN) {
      const character = c(codePoint);
      const code = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
      const what =
        name === undefined
          ? `${code} is a hidden or formatting character`
          : `${code} (${name}) is invisible`;
      assert.deepEqual(
        problems({
          name: `a${character}b`,
          description: `ab${character}`,
          sites: SITE,
          steps: `first\nab${character}c`,
        }),
        [
          { field: "name", text: `Character 2: ${what}; remove it.`, column: 2 },
          { field: "description", text: `Character 3: ${what}; remove it.`, column: 3 },
          {
            field: "steps",
            text: `Line 2, column 3: ${what}; remove it.`,
            line: 2,
            column: 3,
          },
        ],
        code,
      );
    }
  });

  it("formats a code point with at least four upper-case hex digits", () => {
    assert.deepEqual(problems({ ...VALID, name: `a${c(0x1f)}` }), [
      {
        field: "name",
        text: "Character 2: U+001F (control character) is invisible; remove it.",
        column: 2,
      },
    ]);
  });

  it("keeps line breaks and tabs in the steps only", () => {
    const result = checkRecipe({ ...VALID, steps: "a\n\tb  c" });
    assert.ok(result.ok);
    assert.equal(result.recipe.steps, "a\n\tb  c");
    assert.deepEqual(problems({ ...VALID, name: "a\tb", description: "a\nb" }), [
      { field: "name", text: "Character 2: U+0009 (tab) is invisible; remove it.", column: 2 },
      {
        field: "description",
        text: "Character 2: U+000A (line feed) is invisible; remove it.",
        column: 2,
      },
    ]);
    assert.deepEqual(problems({ ...VALID, steps: "a\rb" }), [
      {
        field: "steps",
        text: "Line 1, column 2: U+000D (carriage return) is invisible; remove it.",
        line: 1,
        column: 2,
      },
    ]);
  });

  it("keeps joiners and variation selectors where emoji and scripts need them", () => {
    for (const [what, text] of Object.entries(KEPT)) {
      const result = checkRecipe({ name: text, description: text, sites: SITE, steps: text });
      assert.ok(result.ok, what);
      assert.deepEqual(
        result.recipe,
        { name: text, description: text, sites: [SITE], steps: text },
        what,
      );
    }
  });

  it("refuses joiners and variation selectors out of place", () => {
    for (const [what, [text, column, codePoint, name]] of Object.entries(MISPLACED)) {
      const code = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
      const message = `${code} (${name}) is invisible here; remove it.`;
      const found = problems({ name: text, description: text, sites: SITE, steps: text });
      assert.deepEqual(
        [
          found[0],
          ...["description", "steps"].map((name) => found.find(({ field }) => field === name)),
        ],
        [
          { field: "name", text: `Character ${column}: ${message}`, column },
          { field: "description", text: `Character ${column}: ${message}`, column },
          { field: "steps", text: `Line 1, column ${column}: ${message}`, line: 1, column },
        ],
        what,
      );
    }
  });

  it("judges joiners after NFC, which can compose a mark beside one into a symbol", () => {
    const negated = c(0x3c, 0x338);
    assert.deepEqual(
      problems({
        ...VALID,
        // A kept non-joiner first, so the composed joiner is not the field's first.
        name: `Auf${c(0x200c)}lage${negated}${c(0x200d)}b`,
        description: `a${c(0xa8, 0x301, 0x200c)}b`,
        steps: `x ${negated}${c(0x200d)}a`,
      }),
      [
        {
          field: "name",
          text: "Character 11: U+200D (zero width joiner) is invisible here; remove it.",
          column: 11,
        },
        {
          field: "description",
          text: "Character 4: U+200C (zero width non-joiner) is invisible here; remove it.",
          column: 4,
        },
        {
          field: "steps",
          text: "Line 1, column 5: U+200D (zero width joiner) is invisible here; remove it.",
          line: 1,
          column: 5,
        },
      ],
    );
    const accented = checkRecipe({ ...VALID, name: `a${c(0x301, 0x200d)}b` });
    assert.ok(accented.ok);
    assert.equal(accented.recipe.name, `${c(0xe1, 0x200d)}b`);
  });

  it("reports a hidden character the trimming would drop, where the field shows it", () => {
    assert.deepEqual(problems({ ...VALID, name: `${c(0xfeff)}Pay` }), [
      {
        field: "name",
        text: "Character 1: U+FEFF (zero width no-break space) is invisible; remove it.",
        column: 1,
      },
    ]);
  });

  it("counts a column in code points, from the start of its line", () => {
    assert.deepEqual(problems({ ...VALID, steps: `a\r\n${c(0x1f600)}${c(0xad)}` }), [
      {
        field: "steps",
        text: "Line 2, column 2: U+00AD (soft hyphen) is invisible; remove it.",
        line: 2,
        column: 2,
      },
    ]);
    assert.deepEqual(problems({ ...VALID, name: `${c(0x1f600)} ${c(0x200b)}` }), [
      {
        field: "name",
        text: "Character 3: U+200B (zero width space) is invisible; remove it.",
        column: 3,
      },
    ]);
  });

  it("lists at most ten problems in a field and counts the rest", () => {
    const shy = c(0xad);
    const listed: RecipeProblem[] = Array.from({ length: 10 }, (_, index) => ({
      field: "steps",
      text: `Line ${index + 1}, column 2: U+00AD (soft hyphen) is invisible; remove it.`,
      line: index + 1,
      column: 2,
    }));
    const steps = (count: number) => Array.from({ length: count }, () => `a${shy}`).join("\n");
    assert.deepEqual(problems({ ...VALID, steps: steps(10) }), listed);
    assert.deepEqual(problems({ ...VALID, steps: steps(11) }), [
      ...listed,
      { field: "steps", text: "1 more problem in this field is not listed." },
    ]);
    assert.deepEqual(problems({ ...VALID, steps: steps(12) }), [
      ...listed,
      { field: "steps", text: "2 more problems in this field are not listed." },
    ]);
    const sites = Array.from({ length: 1012 }, () => "x").join("\n");
    const siteProblems = problems({ ...VALID, sites });
    assert.equal(siteProblems.length, 11);
    assert.deepEqual(siteProblems.at(-1), {
      field: "sites",
      text: "1,002 more problems in this field are not listed.",
    });
  });

  it("lists the problems of a long paste of hidden characters in linear time", () => {
    const start = performance.now();
    const found = problems({ ...VALID, steps: `a${c(0xad)}`.repeat(30_000) });
    assert.equal(found.length, 11);
    assert.deepEqual(found.at(-1), {
      field: "steps",
      text: "29,990 more problems in this field are not listed.",
    });
    assert.ok(performance.now() - start < 1000);
  });

  it("reports only the hidden characters of a field that has them", () => {
    const space = c(0x200b);
    assert.deepEqual(problems({ ...VALID, name: space, steps: `${"s".repeat(20_001)}${space}` }), [
      {
        field: "name",
        text: "Character 1: U+200B (zero width space) is invisible; remove it.",
        column: 1,
      },
      {
        field: "steps",
        text: "Line 1, column 20002: U+200B (zero width space) is invisible; remove it.",
        line: 1,
        column: 20_002,
      },
    ]);
  });

  it("folds spacing in a name and description, and invisible spacing in the steps", () => {
    const result = checkRecipe({
      ...VALID,
      name: `Pay${c(0xa0)}invoices`,
      description: "Pays  the invoices",
      steps: `  Open the bank \t\n${c(0x2003)}Pay${c(0x2002)}each${c(0x3000)}invoice${c(0x200a, 0x3000)}\nDone\t`,
    });
    assert.ok(result.ok);
    assert.equal(result.recipe.name, "Pay invoices");
    assert.equal(result.recipe.description, "Pays the invoices");
    assert.equal(result.recipe.steps, `  Open the bank\n Pay each${c(0x3000)}invoice\nDone`);
  });

  it("looks for trailing spacing after a long run of spaces in linear time", () => {
    const start = performance.now();
    assert.deepEqual(problems({ ...VALID, steps: `${" ".repeat(60_000)}x` }), [
      { field: "steps", text: "The steps have 60,001 characters; the most is 20,000." },
    ]);
    assert.ok(performance.now() - start < 1000);
  });

  it("normalizes the steps to NFC", () => {
    const result = checkRecipe({ ...VALID, steps: `Caf${c(0x65, 0x301)}` });
    assert.ok(result.ok);
    assert.equal(result.recipe.steps, `Caf${c(0xe9)}`);
  });
});

describe("saveRecipe", () => {
  it("rejects a recipe that checkRecipe refuses, storing nothing", async (t) => {
    const { fake } = setup(t);
    const hidden = { ...fieldsOf("a"), steps: `a${c(0xad)}b` };
    await assert.rejects(
      saveRecipe(fake.browser, hidden, { shown: { name: "a", savedAt: null } }),
      /checkRecipe/,
    );
    assert.deepEqual(await fake.browser.storage.local.get(null), {});
  });

  it("stores the recipe as checkRecipe normalizes it", async (t) => {
    const { fake } = setup(t);
    const given = { ...fieldsOf("Pay invoices"), name: " Pay  invoices ", sites: [`${SITE}/x`] };
    const result = await saveRecipe(fake.browser, given, {
      shown: { name: "Pay invoices", savedAt: null },
    });
    const saved = { ...fieldsOf("Pay invoices"), savedAt: NOW };
    assert.deepEqual(result, { ok: true, recipe: saved });
    assert.deepEqual(await fake.browser.storage.local.get(null), { "recipe:Pay invoices": saved });
  });

  it("stores a new recipe with exactly its five fields", async (t) => {
    const { fake } = setup(t);
    const fields = { ...fieldsOf("Pay invoices"), extra: "not stored" };
    const result = await saveRecipe(fake.browser, fields, {
      shown: { name: "Pay invoices", savedAt: null },
    });
    const saved = { ...fieldsOf("Pay invoices"), savedAt: NOW };
    assert.deepEqual(result, { ok: true, recipe: saved });
    assert.deepEqual(await fake.browser.storage.local.get(null), { "recipe:Pay invoices": saved });
  });

  it("stores a copy of the sites", async (t) => {
    const { fake } = setup(t);
    const fields = fieldsOf("a");
    const result = await saveRecipe(fake.browser, fields, { shown: { name: "a", savedAt: null } });
    assert.ok(result.ok);
    assert.notEqual(result.recipe.sites, fields.sites);
  });

  it("replaces the recipe the editor showed", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"));
    const fields = { ...fieldsOf("a"), steps: "New steps" };
    const result = await saveRecipe(fake.browser, fields, {
      shown: { name: "a", savedAt: EARLIER },
      replaceShown: true,
    });
    assert.deepEqual(result, { ok: true, recipe: { ...fields, savedAt: NOW } });
    assert.deepEqual(await readRecipes(fake.browser), [{ ...fields, savedAt: NOW }]);
  });

  it("refuses a recipe changed or deleted since the editor showed it", async (t) => {
    const { fake } = setup(t);
    const changed = { ...recipe("a"), savedAt: "2026-10-02T00:00:00.000Z" };
    await seed(fake, changed);
    const shown = { name: "a", savedAt: EARLIER };
    assert.deepEqual(await saveRecipe(fake.browser, fieldsOf("a"), { shown, replaceShown: true }), {
      ok: false,
      reason: "changed",
      current: changed,
    });
    assert.deepEqual(
      await saveRecipe(fake.browser, fieldsOf("b"), { shown: { name: "b", savedAt: EARLIER } }),
      {
        ok: false,
        reason: "changed",
      },
    );
    assert.deepEqual(await readRecipes(fake.browser), [changed]);
  });

  it("refuses a new recipe whose name is stored", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"));
    assert.deepEqual(
      await saveRecipe(fake.browser, fieldsOf("a"), { shown: { name: "a", savedAt: null } }),
      {
        ok: false,
        reason: "changed",
        current: recipe("a"),
      },
    );
  });

  it("refuses a name that is taken", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"), recipe("b"));
    const result = await saveRecipe(fake.browser, fieldsOf("b"), {
      shown: { name: "a", savedAt: EARLIER },
      replaceShown: true,
    });
    assert.deepEqual(result, { ok: false, reason: "exists", current: recipe("b") });
    assert.deepEqual(await readRecipes(fake.browser), [recipe("a"), recipe("b")]);
  });

  it("refuses a name that differs from a stored one only by joiners or selectors", async (t) => {
    const { fake } = setup(t);
    const cafe = `Caf${c(0xe9)}`;
    await seed(fake, recipe("Pay invoices"), recipe("請求"), recipe(cafe));
    const twins: [string, string][] = [
      [`Pay in${c(0x200c)}voices`, "Pay invoices"],
      [`請求${c(0xe0100)}`, "請求"],
      // The non-joiner keeps NFC from composing the e and its accent.
      [`Cafe${c(0x200c, 0x301)}`, cafe],
    ];
    for (const [name, stored] of twins) {
      const result = await saveRecipe(fake.browser, fieldsOf(name), {
        shown: { name, savedAt: null },
      });
      assert.deepEqual(result, { ok: false, reason: "exists", current: recipe(stored) }, name);
    }
    const other = await saveRecipe(fake.browser, fieldsOf("b"), {
      shown: { name: "Pay invoices", savedAt: EARLIER },
    });
    assert.ok(other.ok);
  });

  it("refuses a rename to a name that looks like another stored recipe's", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("Old"), recipe("Pay invoices"));
    const result = await saveRecipe(fake.browser, fieldsOf(`Pay in${c(0x200c)}voices`), {
      shown: { name: "Old", savedAt: EARLIER },
      replaceShown: true,
    });
    assert.deepEqual(result, { ok: false, reason: "exists", current: recipe("Pay invoices") });
  });

  it("renames a recipe to a name that differs only by joiners", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("Pay invoices"));
    const name = `Pay in${c(0x200c)}voices`;
    const result = await saveRecipe(fake.browser, fieldsOf(name), {
      shown: { name: "Pay invoices", savedAt: EARLIER },
      replaceShown: true,
    });
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(await fake.browser.storage.local.get(null)), [`recipe:${name}`]);
  });

  it("renames a recipe, removing its old key after the write", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"), recipe("c"));
    const result = await saveRecipe(fake.browser, fieldsOf("b"), {
      shown: { name: "a", savedAt: EARLIER },
      replaceShown: true,
    });
    assert.deepEqual(result, { ok: true, recipe: { ...fieldsOf("b"), savedAt: NOW } });
    assert.deepEqual(await readRecipes(fake.browser), [
      { ...fieldsOf("b"), savedAt: NOW },
      recipe("c"),
    ]);
  });

  it("refuses a rename when the old recipe changed or was deleted meanwhile", async (t) => {
    const { fake } = setup(t);
    const changed = { ...recipe("a"), savedAt: "2026-10-02T00:00:00.000Z" };
    await seed(fake, changed);
    const options = { shown: { name: "a", savedAt: EARLIER }, replaceShown: true };
    assert.deepEqual(await saveRecipe(fake.browser, fieldsOf("b"), options), {
      ok: false,
      reason: "changed",
      current: changed,
    });
    await deleteRecipe(fake.browser, "a");
    assert.deepEqual(await saveRecipe(fake.browser, fieldsOf("b"), options), {
      ok: false,
      reason: "changed",
    });
    assert.deepEqual(await readRecipes(fake.browser), []);
  });

  it("keeps the old key under another name without replaceShown", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"));
    const result = await saveRecipe(fake.browser, fieldsOf("b"), {
      shown: { name: "a", savedAt: "anything" },
    });
    assert.ok(result.ok);
    assert.deepEqual(
      (await readRecipes(fake.browser)).map(({ name }) => name),
      ["a", "b"],
    );
  });

  it("refuses a recipe that would be the 101st, and counts no malformed key", async (t) => {
    const { fake, warnings } = setup(t);
    const names = Array.from({ length: 99 }, (_, index) => `r${String(index).padStart(3, "0")}`);
    await seed(fake, ...names.map((name) => recipe(name)));
    await fake.browser.storage.local.set({ "recipe:broken": 1 });
    const hundredth = await saveRecipe(fake.browser, fieldsOf("new"), {
      shown: { name: "new", savedAt: null },
    });
    assert.ok(hundredth.ok);
    assert.deepEqual(
      await saveRecipe(fake.browser, fieldsOf("newer"), {
        shown: { name: "newer", savedAt: null },
      }),
      { ok: false, reason: "full" },
    );
    const edited = await saveRecipe(
      fake.browser,
      { ...fieldsOf("new"), steps: "Edited" },
      {
        shown: { name: "new", savedAt: NOW },
      },
    );
    assert.ok(edited.ok);
    const renamed = await saveRecipe(fake.browser, fieldsOf("renamed"), {
      shown: { name: "r000", savedAt: EARLIER },
      replaceShown: true,
    });
    assert.ok(renamed.ok);
    const kept = await saveRecipe(fake.browser, fieldsOf("copy"), {
      shown: { name: "r001", savedAt: EARLIER },
    });
    assert.deepEqual(kept, { ok: false, reason: "full" });
    assert.equal((await readRecipes(fake.browser)).length, 100);
    assert.deepEqual(warnings(), [{ event: "ignored_recipe", key: "recipe:broken" }]);
  });

  it("rejects when the write fails, and leaves the old key", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"));
    fake.failNextSet();
    await assert.rejects(
      saveRecipe(fake.browser, fieldsOf("b"), {
        shown: { name: "a", savedAt: EARLIER },
        replaceShown: true,
      }),
      /Storage is full/,
    );
    assert.deepEqual(await readRecipes(fake.browser), [recipe("a")]);
  });

  it("rejects when a rename's removal fails, leaving both recipes", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"));
    t.mock.method(fake.browser.storage.local, "remove", async () => {
      throw new Error("No remove");
    });
    await assert.rejects(
      saveRecipe(fake.browser, fieldsOf("b"), {
        shown: { name: "a", savedAt: EARLIER },
        replaceShown: true,
      }),
      /No remove/,
    );
    assert.deepEqual(
      (await readRecipes(fake.browser)).map(({ name }) => name),
      ["a", "b"],
    );
  });

  it("saves and reads a recipe named __proto__", async (t) => {
    const { fake } = setup(t);
    const result = await saveRecipe(fake.browser, fieldsOf("__proto__"), {
      shown: { name: "__proto__", savedAt: null },
    });
    assert.ok(result.ok);
    assert.deepEqual(await readRecipes(fake.browser), [{ ...fieldsOf("__proto__"), savedAt: NOW }]);
    assert.deepEqual(
      await saveRecipe(fake.browser, fieldsOf("__proto__"), {
        shown: { name: "__proto__", savedAt: null },
      }),
      { ok: false, reason: "changed", current: { ...fieldsOf("__proto__"), savedAt: NOW } },
    );
  });
});

describe("deleteRecipe", () => {
  it("removes the recipe's key only", async (t) => {
    const { fake } = setup(t);
    await seed(fake, recipe("a"), recipe("b"));
    await deleteRecipe(fake.browser, "a");
    assert.deepEqual(await readRecipes(fake.browser), [recipe("b")]);
  });
});

function setup(t: TestContext) {
  const fake = createFakeBrowser();
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });

  function warnings(): unknown[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  }

  return { fake, warnings };
}

function c(...codePoints: number[]): string {
  return String.fromCodePoint(...codePoints);
}

function recipe(name: string): Recipe {
  return { ...fieldsOf(name), savedAt: EARLIER };
}

function fieldsOf(name: string): RecipeFields {
  return { name, description: `What ${name} does`, sites: [SITE], steps: `Steps of ${name}` };
}

async function seed(fake: FakeBrowser, ...recipes: Recipe[]): Promise<void> {
  await fake.browser.storage.local.set(
    Object.fromEntries(recipes.map((stored) => [`recipe:${stored.name}`, stored])),
  );
}

function problems(fields: Parameters<typeof checkRecipe>[0]): RecipeProblem[] {
  const result = checkRecipe(fields);
  if (result.ok) assert.fail(`checkRecipe took ${JSON.stringify(fields)}`);
  return result.problems;
}
