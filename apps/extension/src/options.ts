import { MAX_RECIPES, type Recipe, type RecipeFields } from "@foxleash/protocol";
import type { BrowserApi } from "./browser-api.ts";
import { DEFAULT_BLOCKLIST } from "./default-blocklist.ts";
import {
  announce,
  announced,
  clearErrors,
  element as pageElement,
  selectLine,
  showErrors,
  showProblems,
  type TextField,
} from "./page-ui.ts";
import { watchProgram } from "./program-status.ts";
import {
  checkRecipe,
  deleteRecipe,
  type RecipeProblem,
  readRecipes,
  saveRecipe,
} from "./recipes.ts";
import {
  effectiveBlocklist,
  isRecord,
  onSettingsChanged,
  readSettings,
  revokeSite,
  type SettingsBrowser,
  saveBlocklist,
  saveSessionWindow,
} from "./settings.ts";
import { parseBlocklist } from "./site.ts";
import type { SessionAnswers } from "./site-access.ts";

declare const browser: SettingsBrowser & { runtime: Pick<BrowserApi["runtime"], "sendMessage"> };

const READ_FAILED = "Could not read Foxleash's settings.";
const ANSWERS_FAILED = "Could not read the answers of running sessions.";
const RECIPES_READ_FAILED = "Could not read the recipes.";
const RECIPE_FIELDS = ["name", "description", "sites", "steps"] as const;

interface AnswerRow {
  key: string;
  text: string;
  /** Follows each button's label in its accessible name. */
  name: string;
  actions: RowAction[];
}

/** One button of a row; its accessible name is `label` followed by the row's name. */
interface RowAction {
  label: string;
  action: string;
  run(): void;
}

/** The row button that had focus: its row's key, its action, and its row's position. */
interface FocusedRow {
  key: string;
  action: string;
  index: number;
}

const list = element("sites");
const empty = element("sites-empty");
const status = element("status");
const heading = element("sites-heading");
const answers = element("answers");
const answersEmpty = element("answers-empty");
const answersStatus = element("answers-status");
const answersHeading = element("answers-heading");
const blocklist = textArea("blocklist");
const blocklistErrors = element("blocklist-errors");
const blocklistStatus = element("blocklist-status");
const sessionWindow = input("session-window");
const sessionWindowStatus = element("session-window-status");
const recipeList = element("recipes");
const recipesEmpty = element("recipes-empty");
const recipesStatus = element("recipes-status");
const recipesHeading = element("recipes-heading");
const recipeAdd = element("recipe-add");
const recipeUndo = element("recipe-undo");
const editor = element("recipe-editor");
const editorHeading = element("recipe-editor-heading");
const editorFields: Record<RecipeProblem["field"], { field: TextField; errors: HTMLElement }> = {
  name: { field: input("recipe-name"), errors: element("recipe-name-errors") },
  description: { field: input("recipe-description"), errors: element("recipe-description-errors") },
  sites: { field: textArea("recipe-sites"), errors: element("recipe-sites-errors") },
  steps: { field: textArea("recipe-steps"), errors: element("recipe-steps-errors") },
};
// Counts renders, so a read that finishes after a newer render started is discarded.
let renders = 0;
// Counts reads of the session answers, for the same reason.
let answerReads = 0;
// The answer rows shown, so a refresh that finds the same rows leaves them (and focus) alone.
let shownAnswers = "";
// Each listed session's label as last read: a kept Stop button announces the current one.
let sessionLabels = new Map<string, string>();
// Whether the textarea holds a whole list. Until then it is read-only and Save stores nothing,
// so a failed or unfinished read cannot save an empty list.
let filled = false;
// The stored recipe the editor opened, or undefined for a new one.
let editing: { name: string; savedAt: string | null } | undefined;
// The recipe whose Edit button opened the editor, or undefined when Add did.
let returnTo: string | undefined;
// While the editor's save is out, Save, Add, Edit and Cancel do nothing, so its result applies to
// the editor that started it.
let saving = false;
// The row button the next shown recipe list focuses, once.
let pendingFocus: { key: string; action: string } | undefined;
// The recipe the last delete removed, which Undo saves again.
let undoable: RecipeFields | undefined;

onSettingsChanged(browser, render);
render();
refreshAnswers();
watchProgram({
  elements: {
    status: element("program-status"),
    setup: element("program-setup"),
    command: element("program-command"),
    requirement: element("program-requirement"),
  },
  browser,
  page: document,
  // Wrapped: Firefox's setTimeout throws when called on anything but the window.
  timers: {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  },
});
// The background has no event for changed answers; coming back to the page reads them again.
window.addEventListener("focus", refreshAnswers);
// Inline in the add-ons manager, coming back to its tab need not focus this page.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAnswers();
});
fillBlocklist("");
element("blocklist-save").addEventListener("click", save);
element("blocklist-default").addEventListener("click", fillDefault);
sessionWindow.addEventListener("change", saveWindowSetting);
recipeAdd.addEventListener("click", () => openEditor(undefined));
element("recipe-save").addEventListener("click", saveEditor);
element("recipe-cancel").addEventListener("click", cancelEditor);
recipeUndo.addEventListener("click", undo);
// Delete moves focus to Undo, and Cancel to Add, where a held Enter would go on to act.
ignoreHeldEnter(recipeUndo);
ignoreHeldEnter(recipeAdd);

function element(id: string): HTMLElement {
  return pageElement(id, "settings page");
}

function textArea(id: string): HTMLTextAreaElement {
  const found = element(id);
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new Error(`The settings page's #${id} is not a textarea.`);
  }
  return found;
}

function input(id: string): HTMLInputElement {
  const found = element(id);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`The settings page's #${id} is not an input.`);
  }
  return found;
}

function render(): void {
  renders += 1;
  const current = renders;
  readSettings(browser).then(
    (settings) => {
      if (current !== renders) return;
      show(settings.sites);
      sessionWindow.checked = settings.sessionWindow;
    },
    () => {
      if (current === renders) announce(status, READ_FAILED);
    },
  );
  readRecipes(browser).then(
    (recipes) => {
      if (current === renders) showRecipes(recipes);
    },
    () => {
      if (current !== renders) return;
      // A later render must not move focus out of an editor the user has gone on to type in.
      pendingFocus = undefined;
      announce(recipesStatus, RECIPES_READ_FAILED);
    },
  );
}

function show(sites: string[]): void {
  const focused = focusedRow(list);
  list.replaceChildren(...sites.map(siteRow));
  list.hidden = sites.length === 0;
  empty.hidden = sites.length > 0;
  if (announced(status) === READ_FAILED) announce(status, "");
  if (focused !== undefined) restoreFocus(list, heading, focused, sites);
}

/** The row button in `rows` that has focus, if one has. */
function focusedRow(rows: HTMLElement): FocusedRow | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement) || !rows.contains(active)) return undefined;
  const { key, action } = active.dataset;
  const item = active.closest("li");
  if (key === undefined || action === undefined || item === null) return undefined;
  return { key, action, index: [...rows.children].indexOf(item) };
}

function siteRow(site: string): HTMLLIElement {
  const item = row(site, site, site, [
    { label: "Revoke", action: "revoke", run: () => revoke(site) },
  ]);
  const button = item.querySelector("button");
  if (button !== null) button.dataset.site = site;
  return item;
}

function row(text: string, name: string, key: string, actions: RowAction[]): HTMLLIElement {
  const item = document.createElement("li");
  const span = document.createElement("span");
  span.textContent = text;
  const buttons = document.createElement("div");
  buttons.className = "actions";
  for (const { label, action, run } of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${name}`);
    button.dataset.key = key;
    button.dataset.action = action;
    button.addEventListener("click", (event) => {
      // The second click of a double-click would land on the next row, moved up under the pointer.
      if (event.detail > 1) return;
      run();
    });
    // A held Enter would go on to act on each row that takes focus after this one.
    ignoreHeldEnter(button);
    buttons.append(button);
  }
  item.append(span, buttons);
  return item;
}

function ignoreHeldEnter(button: HTMLElement): void {
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
  });
}

function revoke(site: string): void {
  revokeSite(browser, site).then(
    () => announce(status, `Revoked ${site}`),
    () => announce(status, `Could not revoke ${site}.`),
  );
}

/**
 * Focuses the same row's button for the same action, else the next row's, else the previous
 * row's, else `fallback`.
 */
function restoreFocus(
  rows: HTMLElement,
  fallback: HTMLElement,
  focused: FocusedRow,
  keys: string[],
): void {
  const kept = keys.indexOf(focused.key);
  const item = [...rows.children][kept >= 0 ? kept : Math.min(focused.index, keys.length - 1)];
  const target = [...(item?.querySelectorAll("button") ?? [])].find(
    (button) => button.dataset.action === focused.action,
  );
  (target ?? fallback).focus();
}

function showRecipes(recipes: Recipe[]): void {
  const focused = focusedRow(recipeList);
  recipeList.replaceChildren(...recipes.map(recipeRow));
  recipeList.hidden = recipes.length === 0;
  recipesEmpty.hidden = recipes.length > 0;
  if (announced(recipesStatus) === RECIPES_READ_FAILED) announce(recipesStatus, "");
  if (pendingFocus !== undefined) {
    const { key, action } = pendingFocus;
    pendingFocus = undefined;
    (rowButton(recipeList, key, action) ?? recipesHeading).focus();
  } else if (focused !== undefined) {
    restoreFocus(
      recipeList,
      recipesHeading,
      focused,
      recipes.map(({ name }) => name),
    );
  }
}

function recipeRow(recipe: Recipe): HTMLLIElement {
  const { name, description } = recipe;
  return row(`${name}: ${description}`, name, name, [
    { label: "Edit", action: "edit", run: () => openEditor(recipe) },
    { label: "Delete", action: "delete", run: () => removeRecipe(recipe) },
  ]);
}

/** Opens the editor on a stored recipe, or empty for a new one, replacing what it held. */
function openEditor(recipe: Recipe | undefined): void {
  if (saving) return;
  clearEditorErrors();
  editorFields.name.field.value = recipe?.name ?? "";
  editorFields.description.field.value = recipe?.description ?? "";
  editorFields.sites.field.value = recipe?.sites.join("\n") ?? "";
  editorFields.steps.field.value = recipe?.steps ?? "";
  editorHeading.textContent = recipe === undefined ? "New recipe" : `Edit ${recipe.name}`;
  editing = recipe === undefined ? undefined : { name: recipe.name, savedAt: recipe.savedAt };
  returnTo = recipe?.name;
  editor.hidden = false;
  editorHeading.focus();
}

function clearEditorErrors(): void {
  for (const name of RECIPE_FIELDS) {
    const { field, errors } = editorFields[name];
    clearErrors(field, errors);
  }
}

function removeRecipe({ name, description, sites, steps }: Recipe): void {
  clearUndo();
  deleteRecipe(browser, name).then(
    () => {
      undoable = { name, description, sites, steps };
      // The visible text stays "Undo", which the accessible name starts with.
      recipeUndo.setAttribute("aria-label", `Undo deleting ${name}`);
      recipeUndo.hidden = false;
      recipeUndo.focus();
      announce(recipesStatus, `Deleted ${name}`);
    },
    () => announce(recipesStatus, `Could not delete ${name}.`),
  );
}

function clearUndo(): void {
  undoable = undefined;
  recipeUndo.hidden = true;
}

/** The row button for `key` and `action`, compared on its data, never through a selector. */
function rowButton(rows: HTMLElement, key: string, action: string): HTMLButtonElement | undefined {
  return [...rows.querySelectorAll("button")].find(
    (button) => button.dataset.key === key && button.dataset.action === action,
  );
}

function refreshAnswers(): void {
  answerReads += 1;
  const current = answerReads;
  browser.runtime.sendMessage({ type: "session_answers" }).then(
    (reply) => {
      if (current !== answerReads) return;
      const held = answersOf(reply);
      if (held === undefined) announce(answersStatus, ANSWERS_FAILED);
      else showAnswers(held);
    },
    () => {
      if (current === answerReads) announce(answersStatus, ANSWERS_FAILED);
    },
  );
}

function answersOf(reply: unknown): SessionAnswers[] | undefined {
  if (!Array.isArray(reply)) return undefined;
  const entries: unknown[] = reply;
  return entries.every(isSessionAnswers) ? entries : undefined;
}

function isSessionAnswers(value: unknown): value is SessionAnswers {
  return (
    isRecord(value) &&
    typeof value.session === "string" &&
    typeof value.label === "string" &&
    isStrings(value.allowed) &&
    isStrings(value.refused) &&
    typeof value.closed === "number" &&
    typeof value.stopped === "boolean"
  );
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry: unknown): boolean => typeof entry === "string")
  );
}

function showAnswers(held: SessionAnswers[]): void {
  if (announced(answersStatus) === ANSWERS_FAILED) announce(answersStatus, "");
  sessionLabels = new Map(held.map(({ session, label }) => [session, label]));
  const rows = held.flatMap(answerRows);
  const shown = JSON.stringify(rows.map(({ key, text }) => [key, text]));
  // Unchanged rows need no update, nor a focus move.
  if (shown === shownAnswers) return;
  shownAnswers = shown;
  const focused = focusedRow(answers);
  updateAnswerRows(rows);
  answers.hidden = rows.length === 0;
  answersEmpty.hidden = rows.length > 0;
  if (focused === undefined) return;
  const keys = rows.map(({ key }) => key);
  // Another session's Stop button, at the same place, must not take focus: Enter would stop it.
  if (focused.action === "stop" && !keys.includes(focused.key)) answersHeading.focus();
  else restoreFocus(answers, answersHeading, focused, keys);
}

function answerRows({
  session,
  label,
  allowed,
  refused,
  closed,
  stopped,
}: SessionAnswers): AnswerRow[] {
  if (stopped) {
    // No site is "stopped", as none is "closed": the key differs from the running session's row.
    return [
      {
        key: JSON.stringify([session, "stopped"]),
        text: `Agent ${label}, stopped`,
        name: "",
        actions: [],
      },
    ];
  }
  const sessionRow: AnswerRow = {
    key: JSON.stringify([session]),
    text: `Agent ${label}`,
    name: `(${label})`,
    actions: [{ label: "Stop this session", action: "stop", run: () => stop(session, label) }],
  };
  const answerRow = (key: string, text: string, forgetting: () => void): AnswerRow => ({
    key,
    text,
    name: text,
    actions: [{ label: "Forget", action: "forget", run: forgetting }],
  });
  const siteAnswer = (site: string, answer: string): AnswerRow =>
    answerRow(JSON.stringify([session, site]), `${site}: ${answer} this session (${label})`, () =>
      forget(session, site, `${site} for this session`),
    );
  const rows = [
    sessionRow,
    ...allowed.map((site) => siteAnswer(site, "allowed")),
    ...refused.map((site) => siteAnswer(site, "refused")),
  ];
  if (closed > 0) {
    const prompts = closed === 1 ? "1 prompt" : `${closed} prompts`;
    rows.push(
      // No site is "closed": a site is a scheme and a host.
      answerRow(
        JSON.stringify([session, "closed"]),
        `${prompts} closed without an answer (${label})`,
        () => forget(session, "closed", "the closed prompts"),
      ),
    );
  }
  return rows;
}

function stop(session: string, created: string): void {
  const label = sessionLabels.get(session) ?? created;
  browser.runtime
    .sendMessage({ type: "stop", session })
    .then(
      (reply) =>
        reply === true ? `Stopped the agent ${label}` : `Could not stop the agent ${label}.`,
      () => `Could not stop the agent ${label}.`,
    )
    .then((text) => {
      announce(answersStatus, text);
      refreshAnswers();
    });
}

function forget(session: string, site: string, what: string): void {
  browser.runtime
    .sendMessage({ type: "forget", session, site })
    .then(
      (reply) => (reply === true ? `Forgot ${what}` : `Could not forget ${what}.`),
      () => `Could not forget ${what}.`,
    )
    .then((text) => {
      announce(answersStatus, text);
      refreshAnswers();
    });
}

/**
 * Updates the answer rows in place by key, so a press on a row's button survives a change of its
 * text: a new button under the release would get no click.
 */
function updateAnswerRows(rows: AnswerRow[]): void {
  const wanted = new Set(rows.map(({ key }) => key));
  const kept = new Map<string, Element>();
  // Stale rows go before the survivors are placed, or a survivor after one would be moved.
  for (const item of [...answers.children]) {
    const key = item instanceof HTMLElement ? item.dataset.key : undefined;
    if (key !== undefined && wanted.has(key) && !kept.has(key)) kept.set(key, item);
    else item.remove();
  }
  let next = answers.firstElementChild;
  for (const { key, text, name, actions } of rows) {
    let item = kept.get(key);
    if (item === undefined) {
      const created = row(text, name, key, actions);
      created.dataset.key = key;
      item = created;
    } else {
      kept.delete(key);
      // A kept button's handler acts on the session and site its key names, not on the text.
      const span = item.querySelector("span");
      if (span !== null && span.textContent !== text) span.textContent = text;
      for (const button of item.querySelectorAll("button")) {
        const accessible = `${button.textContent} ${name}`;
        if (button.getAttribute("aria-label") !== accessible) {
          button.setAttribute("aria-label", accessible);
        }
      }
    }
    if (item === next) next = next.nextElementSibling;
    else answers.insertBefore(item, next);
  }
}

function saveWindowSetting(): void {
  const on = sessionWindow.checked;
  saveSessionWindow(browser, on).then(
    () =>
      announce(
        sessionWindowStatus,
        on
          ? "Saved. Each agent session opens in its own window."
          : "Saved. Agent sessions open their tabs in your window.",
      ),
    () => {
      sessionWindow.checked = !on;
      announce(sessionWindowStatus, "Could not save the setting.");
    },
  );
}

/**
 * Fills the textarea from storage, on load and after a save, unless the user changed it from
 * `shown` while the read was out.
 */
function fillBlocklist(shown: string): void {
  readSettings(browser).then(
    (settings) => {
      if (blocklist.value !== shown) return;
      blocklist.value = effectiveBlocklist(settings).join("\n");
      blocklist.readOnly = false;
      filled = true;
    },
    () => {
      // After a save, the textarea already holds the saved list.
      if (!filled) {
        announce(blocklistStatus, "Could not read the blocklist. Reload the page to try again.");
      }
    },
  );
}

function save(): void {
  if (!filled) {
    announce(
      blocklistStatus,
      "Could not read the blocklist, so nothing was saved. Reload the page to try again.",
    );
    return;
  }
  const text = blocklist.value;
  const parsed = parseBlocklist(text);
  if ("errors" in parsed) {
    const { errors } = parsed;
    showErrors(
      blocklist,
      blocklistErrors,
      errors.map(({ line, text }) => `Line ${line}: ${text}`),
    );
    blocklist.focus();
    const first = errors[0];
    if (first !== undefined) selectLine(blocklist, first.line);
    announce(
      blocklistStatus,
      errors.length === 1
        ? "Not saved: 1 line needs fixing"
        : `Not saved: ${errors.length} lines need fixing`,
    );
    return;
  }
  const { patterns } = parsed;
  clearErrors(blocklist, blocklistErrors);
  saveBlocklist(browser, patterns).then(
    () => {
      fillBlocklist(text);
      announce(
        blocklistStatus,
        patterns.length === 0 ? "Saved. Foxleash blocks no sites now." : "Saved",
      );
    },
    () => announce(blocklistStatus, "Could not save the blocklist."),
  );
}

function fillDefault(): void {
  blocklist.value = DEFAULT_BLOCKLIST.join("\n");
  blocklist.readOnly = false;
  filled = true;
  clearErrors(blocklist, blocklistErrors);
  announce(blocklistStatus, "Filled in the built-in list. Save to use it.");
}

function saveEditor(event: Event): void {
  // Only a user's click saves a recipe.
  if (!event.isTrusted || saving) return;
  clearEditorErrors();
  const checked = checkRecipe({
    name: editorFields.name.field.value,
    description: editorFields.description.field.value,
    sites: editorFields.sites.field.value,
    steps: editorFields.steps.field.value,
  });
  if (!checked.ok) {
    showRecipeProblems(checked.problems);
    return;
  }
  const { recipe } = checked;
  const opened = editing;
  clearUndo();
  saving = true;
  saveRecipe(browser, recipe, {
    shown: opened ?? { name: recipe.name, savedAt: null },
    replaceShown: opened !== undefined,
  }).then(
    (result) => {
      saving = false;
      if (result.ok) {
        editor.hidden = true;
        clearEditorErrors();
        editing = undefined;
        returnTo = undefined;
        pendingFocus = { key: recipe.name, action: "edit" };
        announce(recipesStatus, `Saved ${recipe.name}`);
        render();
      } else if (result.reason === "full") {
        announce(recipesStatus, `Foxleash keeps at most ${MAX_RECIPES} recipes. Delete one first.`);
      } else if (result.reason === "exists" || opened === undefined) {
        // A new recipe whose name is stored is "changed": nothing was shown under that name.
        const taken = result.current?.name ?? recipe.name;
        showRecipeProblems([{ field: "name", text: `A recipe named ${taken} exists.` }]);
      } else if (result.current === undefined) {
        announce(recipesStatus, `${opened.name} was deleted meanwhile.`);
      } else {
        announce(
          recipesStatus,
          `${opened.name} changed since you opened it. Cancel and open it again to see the current version.`,
        );
      }
    },
    () => {
      saving = false;
      announce(recipesStatus, `Could not save ${recipe.name}.`);
    },
  );
}

function showRecipeProblems(problems: RecipeProblem[]): void {
  const invalid = showProblems(editorFields, RECIPE_FIELDS, problems);
  announce(
    recipesStatus,
    invalid === 1 ? "Not saved: 1 field needs fixing" : `Not saved: ${invalid} fields need fixing`,
  );
}

function cancelEditor(): void {
  if (saving) return;
  editor.hidden = true;
  clearEditorErrors();
  editing = undefined;
  const target = returnTo === undefined ? undefined : rowButton(recipeList, returnTo, "edit");
  returnTo = undefined;
  (target ?? recipeAdd).focus();
}

function undo(event: Event): void {
  // Only a user's click saves a recipe.
  if (!event.isTrusted || undoable === undefined) return;
  const fields = undoable;
  const { name } = fields;
  clearUndo();
  saveRecipe(browser, fields, { shown: { name, savedAt: null } }).then(
    (result) => {
      if (result.ok) {
        pendingFocus = { key: name, action: "edit" };
        announce(recipesStatus, `Restored ${name}`);
        render();
        return;
      }
      announce(
        recipesStatus,
        result.reason === "full"
          ? `Foxleash keeps at most ${MAX_RECIPES} recipes, so ${name} was not restored.`
          : `A recipe named ${name} was saved meanwhile; nothing was restored.`,
      );
      recipesHeading.focus();
    },
    () => {
      announce(recipesStatus, `Could not restore ${name}.`);
      recipesHeading.focus();
    },
  );
}
