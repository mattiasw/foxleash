import {
  MAX_RECIPE_DESCRIPTION,
  MAX_RECIPE_NAME,
  MAX_RECIPE_SITES,
  MAX_RECIPE_STEPS,
  MAX_RECIPES,
  type Recipe,
  type RecipeFields,
} from "@foxhand/protocol";
import { warn } from "./log.ts";
import { isRecord, RECIPE_KEY_PREFIX, type SettingsBrowser } from "./settings.ts";
import { siteOf } from "./site.ts";

/** One thing to fix in a recipe, as one sentence the settings page shows verbatim. */
export type RecipeProblem = {
  field: "name" | "description" | "sites" | "steps";
  text: string;
  /** Counted from 1. */
  line?: number;
  /** Counted from 1, in code points. */
  column?: number;
};

type CheckResult = { ok: true; recipe: RecipeFields } | { ok: false; problems: RecipeProblem[] };

type SaveResult =
  | { ok: true; recipe: Recipe }
  | { ok: false; reason: "changed" | "exists" | "full"; current?: Recipe };

// Characters that draw as nothing, or reorder or hide text: controls, format characters, line and
// paragraph separators, bidi controls, default-ignorables, and three that fonts draw blank: the
// braille blank, the Khitan filler and the musical null notehead. Joiners and variation selectors
// are left to MISPLACED, which keeps them where emoji and scripts need them.
const HIDDEN_IN_LINE =
  /(?!\u200c|\u200d|[\ufe00-\ufe0f\u{e0100}-\u{e01ef}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2800\u{16fe4}\u{1d159}]/u;
const HIDDEN_IN_TEXT =
  /(?![\t\n]|\u200c|\u200d|[\ufe00-\ufe0f\u{e0100}-\u{e01ef}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2800\u{16fe4}\u{1d159}]/u;
// A run of these after one emoji or between letters would carry hidden bytes.
const MISPLACED =
  /(?<!\p{Emoji})[\ufe0e\ufe0f]|(?<!\p{Ideographic})[\ufe00-\ufe0d\u{e0100}-\u{e01ef}]|(?<![\p{L}\p{M}\p{Emoji}]|\ufe0f)(?:\u200c|\u200d)|(?:\u200c|\u200d)(?![\p{L}\p{M}\p{Emoji}])/u;
// What two names that look the same can differ by.
const INVISIBLE_IN_NAME = /\u200c|\u200d|[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
// The most a DNS name has; siteOf gives the host in its ASCII form.
const MAX_SITE_HOST = 253;
const MAX_PROBLEMS = 10;
const NOT_AN_ADDRESS = "this is not an http or https address.";

const CHARACTER_NAMES = new Map<number, string>([
  [0x09, "tab"],
  [0x0a, "line feed"],
  [0x0d, "carriage return"],
  [0xad, "soft hyphen"],
  [0x61c, "Arabic letter mark"],
  [0x200b, "zero width space"],
  [0x200c, "zero width non-joiner"],
  [0x200d, "zero width joiner"],
  [0x200e, "left-to-right mark"],
  [0x200f, "right-to-left mark"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0x202a, "left-to-right embedding"],
  [0x202b, "right-to-left embedding"],
  [0x202c, "pop directional formatting"],
  [0x202d, "left-to-right override"],
  [0x202e, "right-to-left override"],
  [0x2060, "word joiner"],
  [0x2066, "left-to-right isolate"],
  [0x2067, "right-to-left isolate"],
  [0x2068, "first strong isolate"],
  [0x2069, "pop directional isolate"],
  [0x2800, "braille pattern blank"],
  [0xfeff, "zero width no-break space"],
  [0x16fe4, "Khitan small script filler"],
  [0x1d159, "musical symbol null notehead"],
]);

/** The stored recipes, sorted by name; a malformed one is ignored with a warning. */
export async function readRecipes(browser: SettingsBrowser): Promise<Recipe[]> {
  const items = await browser.storage.local.get(null);
  const recipes: Recipe[] = [];
  for (const key of Object.keys(items)) {
    if (!key.startsWith(RECIPE_KEY_PREFIX)) continue;
    const recipe = recipeOf(key, items[key]);
    if (recipe === undefined) warn({ event: "ignored_recipe", key });
    else recipes.push(recipe);
  }
  return recipes.sort(byName);
}

/** The recipe a stored key and value hold, with exactly its five fields, or undefined. */
export function recipeOf(key: string, value: unknown): Recipe | undefined {
  if (!key.startsWith(RECIPE_KEY_PREFIX) || !isRecord(value)) return undefined;
  const fields = ["name", "description", "sites", "steps", "savedAt"];
  if (!fields.every((field) => Object.hasOwn(value, field))) return undefined;
  const { name, description, sites, steps, savedAt } = value;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof steps !== "string" ||
    typeof savedAt !== "string" ||
    name !== key.slice(RECIPE_KEY_PREFIX.length) ||
    !Array.isArray(sites)
  ) {
    return undefined;
  }
  // Array.from turns holes into undefined, which every() would skip.
  const entries: unknown[] = Array.from(sites);
  if (!entries.every((site): site is string => typeof site === "string" && siteOf(site) === site)) {
    return undefined;
  }
  return { name, description, sites: entries, steps, savedAt };
}

/** The recipe as the user typed it, normalized, or every problem with it. */
export function checkRecipe(fields: {
  name: unknown;
  description: unknown;
  sites: unknown;
  steps: unknown;
}): CheckResult {
  const name = checkLine(fields.name, "name", MAX_RECIPE_NAME, "Give the recipe a name.");
  const description = checkLine(
    fields.description,
    "description",
    MAX_RECIPE_DESCRIPTION,
    "Give the recipe a one-line description.",
  );
  const sites = checkSites(fields.sites);
  const steps = checkSteps(fields.steps);
  if (
    typeof name === "string" &&
    typeof description === "string" &&
    Array.isArray(sites) &&
    typeof steps === "string"
  ) {
    return { ok: true, recipe: { name, description, sites, steps } };
  }
  const problems = [name, description, sites, steps].flatMap((result) =>
    isProblems(result) ? result.problems : [],
  );
  return { ok: false, problems };
}

/**
 * Stores the recipe under its name, when what is stored is what the editor showed (`shown`, with
 * `savedAt` null for a recipe not stored). With `replaceShown`, a renamed recipe's old key is
 * removed after the write; a failed removal rejects and leaves both. Rejects, storing nothing,
 * a recipe that `checkRecipe` refuses.
 */
export async function saveRecipe(
  browser: SettingsBrowser,
  given: RecipeFields,
  options: { shown: { name: string; savedAt: string | null }; replaceShown?: boolean },
): Promise<SaveResult> {
  const checked = checkRecipe(given);
  if (!checked.ok) throw new Error("The recipe has problems that checkRecipe reports.");
  const fields = checked.recipe;
  const { shown, replaceShown = false } = options;
  const items = await browser.storage.local.get(null);
  const stored = new Map<string, Recipe>();
  for (const key of Object.keys(items)) {
    const recipe = recipeOf(key, items[key]);
    if (recipe !== undefined) stored.set(recipe.name, recipe);
  }
  const { name } = fields;
  if (name === shown.name) {
    if ((stored.get(name)?.savedAt ?? null) !== shown.savedAt) return refused("changed", name);
  } else {
    if (stored.has(name)) return refused("exists", name);
    if (replaceShown && (stored.get(shown.name)?.savedAt ?? null) !== shown.savedAt) {
      return refused("changed", shown.name);
    }
  }
  const adds = !stored.has(name);
  if (adds) {
    const look = lookOf(name);
    for (const other of stored.keys()) {
      if (replaceShown && other === shown.name) continue;
      if (lookOf(other) === look) return refused("exists", other);
    }
  }
  const removes = replaceShown && name !== shown.name && stored.has(shown.name);
  if (adds && !removes && stored.size >= MAX_RECIPES) return { ok: false, reason: "full" };
  const recipe: Recipe = {
    name,
    description: fields.description,
    sites: fields.sites,
    steps: fields.steps,
    savedAt: new Date().toISOString(),
  };
  await browser.storage.local.set({ [RECIPE_KEY_PREFIX + name]: recipe });
  if (removes) await browser.storage.local.remove(RECIPE_KEY_PREFIX + shown.name);
  return { ok: true, recipe };

  function refused(reason: "changed" | "exists", key: string): SaveResult {
    const current = stored.get(key);
    return current === undefined ? { ok: false, reason } : { ok: false, reason, current };
  }
}

export function deleteRecipe(browser: SettingsBrowser, name: string): Promise<void> {
  return browser.storage.local.remove(RECIPE_KEY_PREFIX + name);
}

function byName(a: Recipe, b: Recipe): number {
  const compared = a.name.localeCompare(b.name, "en");
  if (compared !== 0) return compared;
  // Names are storage keys, so no two are equal.
  return a.name < b.name ? -1 : 1;
}

/** A name or description: one line, folded spaces, trimmed, 1 to `max` characters. */
function checkLine(
  value: unknown,
  field: "name" | "description",
  max: number,
  missing: string,
): string | { problems: RecipeProblem[] } {
  if (typeof value !== "string")
    return { problems: [{ field, text: `The ${field} must be text.` }] };
  const hidden = hiddenProblems(value, field, HIDDEN_IN_LINE);
  if (hidden.length > 0) return { problems: hidden };
  const text = value
    .normalize("NFC")
    .replace(/\p{Zs}+/gu, " ")
    .trim();
  const length = [...text].length;
  if (length === 0) return { problems: [{ field, text: missing }] };
  if (length > max) {
    return {
      problems: [
        { field, text: `The ${field} has ${count(length)} characters; the most is ${count(max)}.` },
      ],
    };
  }
  return text;
}

/** One problem per hidden or misplaced character, positioned on `value` as the field shows it. */
function hiddenProblems(
  value: string,
  field: RecipeProblem["field"],
  hidden: RegExp,
): RecipeProblem[] {
  // NFC can compose a mark beside a joiner into a symbol ("<" and U+0338 into U+226E), so joiners
  // and selectors are judged on the NFC text too. NFC keeps each of them, in order.
  const misplacedInNfc = new Set<number>();
  const nfcScan = new RegExp(`(?<misplaced>${MISPLACED.source})|${INVISIBLE_IN_NAME.source}`, "gu");
  let selector = 0;
  for (const match of value.normalize("NFC").matchAll(nfcScan)) {
    if (match.groups?.misplaced !== undefined) misplacedInNfc.add(selector);
    selector += 1;
  }
  const scan = new RegExp(
    `(?<hidden>${hidden.source})|(?<misplaced>${MISPLACED.source})|${INVISIBLE_IN_NAME.source}`,
    "gu",
  );
  const problems: RecipeProblem[] = [];
  let found = 0;
  selector = 0;
  for (const match of value.matchAll(scan)) {
    const alwaysHidden = match.groups?.hidden !== undefined;
    if (!alwaysHidden) {
      const index = selector;
      selector += 1;
      if (match.groups?.misplaced === undefined && !misplacedInNfc.has(index)) continue;
    }
    found += 1;
    // Only a listed problem gets a position, which costs a pass over the text before it.
    if (found > MAX_PROBLEMS) continue;
    // A name or description is one line: a line feed in it is one of its hidden characters.
    const lineStart = field === "steps" ? value.lastIndexOf("\n", match.index - 1) + 1 : 0;
    const line = countLines(value.slice(0, lineStart));
    const column = [...value.slice(lineStart, match.index)].length + 1;
    const where = field === "steps" ? `Line ${line}, column ${column}` : `Character ${column}`;
    const text = `${where}: ${describe(match[0], alwaysHidden)}; remove it.`;
    problems.push(field === "steps" ? { field, text, line, column } : { field, text, column });
  }
  return capped(problems, found, field);
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/** What the character is: "U+00AD (soft hyphen) is invisible", or "is invisible here" when misplaced. */
function describe(character: string, alwaysHidden: boolean): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const code = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  const name = nameOf(codePoint);
  if (name === undefined) return `${code} is a hidden or formatting character`;
  return `${code} (${name}) is invisible${alwaysHidden ? "" : " here"}`;
}

function nameOf(codePoint: number): string | undefined {
  const named = CHARACTER_NAMES.get(codePoint);
  if (named !== undefined) return named;
  if (/\p{Cc}/u.test(String.fromCodePoint(codePoint))) return "control character";
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return "variation selector";
  }
  if (codePoint >= 0xfff9 && codePoint <= 0xfffb) return "interlinear annotation character";
  return codePoint >= 0xe0000 && codePoint <= 0xe007f ? "tag character" : undefined;
}

/** The first problems, and one more saying how many of the `found` are not listed. */
function capped(
  problems: RecipeProblem[],
  found: number,
  field: RecipeProblem["field"],
): RecipeProblem[] {
  const more = found - MAX_PROBLEMS;
  if (more <= 0) return problems;
  const text =
    more === 1
      ? "1 more problem in this field is not listed."
      : `${count(more)} more problems in this field are not listed.`;
  return [...problems.slice(0, MAX_PROBLEMS), { field, text }];
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** The sites, from a list or one entry per line: each reduced to its site, without duplicates. */
function checkSites(value: unknown): string[] | { problems: RecipeProblem[] } {
  const field = "sites";
  let entries: unknown[];
  if (typeof value === "string") entries = value.split("\n");
  else if (Array.isArray(value)) entries = Array.from(value);
  else return { problems: [{ field, text: "The sites must be a list of addresses." }] };
  const sites = new Set<string>();
  const problems: RecipeProblem[] = [];
  entries.forEach((entry, index) => {
    const line = index + 1;
    const result = siteOfEntry(entry);
    if (result === undefined) return;
    if (typeof result === "string") sites.add(result);
    else problems.push({ field, text: `Line ${line}: ${result.problem}`, line });
  });
  if (problems.length > 0) return { problems: capped(problems, problems.length, field) };
  if (sites.size === 0) {
    return { problems: [{ field, text: "List at least one site, such as https://example.com." }] };
  }
  if (sites.size > MAX_RECIPE_SITES) {
    return {
      problems: [
        {
          field,
          text: `The recipe lists ${count(sites.size)} sites; the most is ${count(MAX_RECIPE_SITES)}.`,
        },
      ],
    };
  }
  return [...sites];
}

/** An entry's site, undefined for a blank one, or why it is not a site. */
function siteOfEntry(entry: unknown): string | undefined | { problem: string } {
  if (typeof entry !== "string") return { problem: NOT_AN_ADDRESS };
  const text = entry.trim();
  if (text === "") return undefined;
  // The URL parser deletes tabs and line breaks anywhere in an address.
  if (/[\t\n\r]/.test(text)) return { problem: NOT_AN_ADDRESS };
  const site = siteOf(text);
  if (site === undefined) return { problem: NOT_AN_ADDRESS };
  const parsed = URL.parse(text);
  if (parsed !== null && (parsed.username !== "" || parsed.password !== "")) {
    return { problem: "this address has a user name before the site; give the site only." };
  }
  const host = URL.parse(site)?.hostname ?? "";
  if (host.length > MAX_SITE_HOST) {
    return { problem: `this address's host is longer than ${MAX_SITE_HOST} characters.` };
  }
  // The URL parser keeps a "*" in a host, which would make a site that matches no tab.
  if (host.includes("*")) return { problem: "this address has a wildcard; list each site." };
  return site;
}

/** The steps: line breaks as "\n", invisible spacing gone, 1 to MAX_RECIPE_STEPS characters. */
function checkSteps(value: unknown): string | { problems: RecipeProblem[] } {
  const field = "steps";
  if (typeof value !== "string") return { problems: [{ field, text: "The steps must be text." }] };
  const given = value.replaceAll("\r\n", "\n");
  const hidden = hiddenProblems(given, field, HIDDEN_IN_TEXT);
  if (hidden.length > 0) return { problems: hidden };
  const steps = given
    .normalize("NFC")
    // U+3000 is the visible full-width space of CJK text.
    .replace(/(?![ \u3000])\p{Zs}/gu, " ")
    // The lookbehind tries each run of spacing once, from its start, not from every character.
    .replace(/(?<![\t\p{Zs}])[\t\p{Zs}]+$/gmu, "");
  if (!/\S/u.test(steps)) return { problems: [{ field, text: "Write the steps." }] };
  const length = [...steps].length;
  if (length > MAX_RECIPE_STEPS) {
    return {
      problems: [
        {
          field,
          text: `The steps have ${count(length)} characters; the most is ${count(MAX_RECIPE_STEPS)}.`,
        },
      ],
    };
  }
  return steps;
}

function isProblems(
  result: string | string[] | { problems: RecipeProblem[] },
): result is { problems: RecipeProblem[] } {
  return typeof result === "object" && !Array.isArray(result);
}

/** A name as it looks: two names that look the same cannot both be stored. */
export function lookOf(name: string): string {
  // A joiner between a letter and its mark keeps NFC from composing them.
  return name.replace(INVISIBLE_IN_NAME, "").normalize("NFC");
}
