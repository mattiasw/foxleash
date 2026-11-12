import type { Recipe, RecipeFields } from "@foxleash/protocol";
import type { Port, Timers } from "./browser-api.ts";
import { type DiffLine, lineDiff } from "./line-diff.ts";
import {
  announce,
  armButtons,
  clearErrors,
  element,
  type FieldProblem,
  fieldsOf,
  showProblems,
  type TextField,
} from "./page-ui.ts";

declare const browser: { runtime: { connect(connectInfo: { name: string }): Port } };

type Field = "name" | "description" | "sites" | "steps";
type State = "waiting" | "asking" | "saving" | "done" | "ended";
type Values = Record<Field, string>;

/** What the page shows a save against: the proposal's name and the stored version's savedAt. */
interface Shown {
  name: string;
  savedAt: string | null;
}

/** A problem the background sends; one without a field is about the whole recipe. */
interface Problem {
  field?: Field;
  text: string;
  line?: number;
  column?: number;
}

const PAGE = "recipe page";
const UNARMED = "The buttons respond a moment after this window is focused.";
const CHANGED =
  "This recipe changed since this page opened. Check the current version, then save again.";
const OUT_OF_VIEW =
  "Not saved: part of the recipe was out of view. Read the recipe again, then save.";
// The fields in page order; each has class="whole" and grows to show all of its text.
const ORDER: readonly Field[] = ["name", "description", "sites", "steps"];
// checkRecipe refuses a line break in these.
const LINES: readonly Field[] = ["name", "description"];
// A run of more unchanged lines than this shows as one item that counts them.
const MAX_SAME_RUN = 3;
const WORDS: Record<DiffLine["kind"], string> = {
  same: "unchanged ",
  removed: "removed ",
  added: "added ",
};
const PREFIXES: Record<DiffLine["kind"], string> = { same: "  ", removed: "- ", added: "+ " };

// Wrapped: Firefox's setTimeout throws when called on anything but the window.
const timers: Timers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

const heading = element("heading", PAGE);
const currentSection = element("current", PAGE);
const currentHeading = element("current-heading", PAGE);
const currentValues: Record<Exclude<Field, "steps">, HTMLElement> = {
  name: element("current-name", PAGE),
  description: element("current-description", PAGE),
  sites: element("current-sites", PAGE),
};
const changeTexts: Record<Field, HTMLElement> = {
  name: element("current-name-change", PAGE),
  description: element("current-description-change", PAGE),
  sites: element("current-sites-change", PAGE),
  steps: element("current-steps-change", PAGE),
};
const diff = element("diff", PAGE);
const answers = element("answers", PAGE);
const status = element("status", PAGE);
const after = element("after", PAGE);
const fields: Record<Field, { field: TextField; errors: HTMLElement }> = {
  name: { field: textField("recipe-name"), errors: element("recipe-name-errors", PAGE) },
  description: {
    field: textField("recipe-description"),
    errors: element("recipe-description-errors", PAGE),
  },
  sites: { field: textField("recipe-sites"), errors: element("recipe-sites-errors", PAGE) },
  steps: { field: textField("recipe-steps"), errors: element("recipe-steps-errors", PAGE) },
};
const buttons = [...answers.querySelectorAll<HTMLButtonElement>("button[data-answer]")];
let state: State = "waiting";
let port: Port | undefined;
// The proposal as the background sent it, and the stored recipe of that name, if any.
let proposal: RecipeFields | undefined;
let current: Recipe | undefined;
let token: Shown = { name: "", savedAt: null };
// Whether a diff is waiting for the next frame.
let diffPending = false;
// What a click before the buttons arm says: after a change, the change again.
let unarmedText = UNARMED;
const { renderButtons, watch, rearm } = armButtons({
  buttons,
  timers,
  asking: () => state === "asking",
  onAnswer,
  onUnarmed: () => announce(status, unarmedText),
});

for (const name of LINES) {
  const { field } = fields[name];
  field.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
    }
  });
  field.addEventListener("input", () => spaceLineBreaks(field));
}
for (const name of ORDER) fields[name].field.addEventListener("input", () => edited(name));
for (const name of ORDER) fields[name].field.addEventListener("input", showWhole);
// The label is as wide as the fields and its text scales with theirs, so its box changes whenever
// their wrapping can, and fitting them leaves it alone unless the page's own scrollbar comes or
// goes.
new ResizeObserver(showWhole).observe(element("recipe-steps-label", PAGE));

const id = new URLSearchParams(location.search).get("id");
if (id === null) end();
else connect();

function textField(fieldId: string): TextField {
  const found = element(fieldId, PAGE);
  if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)) {
    throw new Error(`The ${PAGE}'s #${fieldId} is not a text field.`);
  }
  return found;
}

function onAnswer(button: HTMLButtonElement): void {
  const answer = button.dataset.answer;
  unarmedText = UNARMED;
  if (answer === "save") {
    // A reflow after the last fit (a late font, a style change) can hide text with no scrollbar.
    const hidden = ORDER.find((name) => !inView(fields[name].field));
    if (hidden !== undefined) {
      showWhole();
      rearm();
      renderButtons();
      fields[hidden].field.focus();
      unarmedText = OUT_OF_VIEW;
      announce(status, OUT_OF_VIEW);
      return;
    }
    for (const name of ORDER) clearErrors(fields[name].field, fields[name].errors);
    state = "saving";
    setEditable(false);
    renderButtons();
    announce(status, "Saving");
    send({ type: "answer", answer: "save", fields: values(), shown: token });
  } else if (answer === "discard") {
    state = "saving";
    setEditable(false);
    renderButtons();
    send({ type: "answer", answer: "discard" });
  }
}

/** Whether the field shows all of its text; 1 px allows for rounding, and hides no character. */
function inView(field: TextField): boolean {
  return field.scrollHeight <= field.clientHeight + 1 && field.scrollWidth <= field.clientWidth + 1;
}

/** No edits while an answer is out or after the last one, so the fields show what was answered. */
function setEditable(editable: boolean): void {
  for (const name of ORDER) fields[name].field.readOnly = !editable;
}

/** Replaces each line break with a space, as Firefox does when pasting into a one-line input. */
function spaceLineBreaks(field: TextField): void {
  const { value, selectionStart, selectionEnd, selectionDirection } = field;
  if (!/[\r\n]/.test(value)) return;
  field.value = spaced(value);
  field.setSelectionRange(
    spaced(value.slice(0, selectionStart ?? value.length)).length,
    spaced(value.slice(0, selectionEnd ?? value.length)).length,
    selectionDirection ?? undefined,
  );
}

function spaced(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, " ");
}

function edited(name: Field): void {
  if (state !== "asking" && state !== "saving") return;
  showChanges();
  if (name === "steps") scheduleDiff();
  keepDraft();
}

function end(): void {
  if (state === "done" || state === "ended") return;
  state = "ended";
  setEditable(false);
  answers.remove();
  status.focus();
  announce(status, "This request has ended.");
}

function connect(): void {
  const opened = browser.runtime.connect({ name: "recipe" });
  port = opened;
  opened.onMessage.addListener(receive);
  opened.onDisconnect.addListener(() => end());
  opened.postMessage({ type: "ready" });
}

function send(message: unknown): void {
  try {
    port?.postMessage(message);
  } catch {
    end();
  }
}

function values(): Values {
  return {
    name: fields.name.field.value,
    description: fields.description.field.value,
    sites: fields.sites.field.value,
    steps: fields.steps.field.value,
  };
}

function receive(received: unknown): void {
  const message = fieldsOf(received);
  if (message === undefined) return;
  if (message.type === "propose") {
    const given = recipeFieldsOf(message.fields);
    const stored = message.current === undefined ? undefined : recipeOf(message.current);
    if (
      state === "waiting" &&
      given !== undefined &&
      (message.current === undefined || stored !== undefined)
    ) {
      propose(given, stored);
    }
  } else if (message.type === "problems") {
    const problems = problemsOf(message.problems);
    if (problems !== undefined) showReplyProblems(problems);
  } else if (message.type === "changed") {
    const stored = message.current === undefined ? undefined : recipeOf(message.current);
    if (state === "saving" && (message.current === undefined || stored !== undefined)) {
      changed(stored);
    }
  } else if (message.type === "done") {
    if (message.answer === "saved" || message.answer === "discarded") done(message.answer);
  } else if (message.type === "ended") {
    end();
  }
}

function propose(given: RecipeFields, stored: Recipe | undefined): void {
  proposal = given;
  current = stored;
  token = { name: given.name, savedAt: stored?.savedAt ?? null };
  fill(shownValues(given));
  const draft = readDraft(given.name);
  if (draft !== undefined) fill(draft.values);
  showCurrent();
  state = "asking";
  renderButtons();
  // From now on, so the second before arming counts from when the recipe can be read.
  watch();
  if (draft === undefined) return;
  // The edits stay, but never move silently onto a version the user has not seen.
  if (draft.shown.savedAt !== token.savedAt) announceChanged();
  keepDraft();
}

function fill(given: Values): void {
  for (const name of ORDER) fields[name].field.value = given[name];
  // Setting a value fires no input event. Synchronous, so it also fits in a background tab.
  showWhole();
}

/** Grows each field to its text, never below its rows or its min-height. */
function showWhole(): void {
  const { scrollX, scrollY } = window;
  for (const name of ORDER) {
    const { field } = fields[name];
    field.style.height = "auto";
    // scrollHeight leaves out the border, which the border-box height includes.
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }
  // Measuring at "auto" shortens the page for a moment, which can move its scroll position.
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
}

/** The recipe's fields as the page's fields show them. */
function shownValues(recipe: RecipeFields): Values {
  return {
    name: recipe.name,
    description: recipe.description,
    sites: recipe.sites.join("\n"),
    steps: recipe.steps,
  };
}

function showCurrent(): void {
  if (current === undefined) {
    currentSection.hidden = true;
    ask("Save this recipe?");
    diff.replaceChildren();
    return;
  }
  currentSection.hidden = false;
  ask(`Update the recipe ${current.name}?`);
  const stored = shownValues(current);
  currentValues.name.textContent = stored.name;
  currentValues.description.textContent = stored.description;
  currentValues.sites.textContent = stored.sites;
  showChanges();
  showDiff();
}

function ask(question: string): void {
  heading.textContent = question;
  document.title = question;
}

/** Says for each field whether the edited value differs from the stored one. */
function showChanges(): void {
  if (current === undefined) return;
  const stored = shownValues(current);
  const edits = values();
  for (const name of ORDER) {
    changeTexts[name].textContent =
      edits[name] === stored[name] ? "Unchanged above." : "Changed above.";
  }
}

/** One diff per frame, however many edits come before it. */
function scheduleDiff(): void {
  if (diffPending) return;
  diffPending = true;
  requestAnimationFrame(() => {
    diffPending = false;
    showDiff();
  });
}

function showDiff(): void {
  if (current === undefined) {
    diff.replaceChildren();
    return;
  }
  const lines = lineDiff(current.steps, fields.steps.field.value);
  const items: HTMLLIElement[] = [];
  let index = 0;
  while (index < lines.length) {
    let next = index;
    while (lines[next]?.kind === "same") next += 1;
    if (next - index > MAX_SAME_RUN) {
      items.push(unchangedRun(next - index));
      index = next;
      continue;
    }
    const line = lines[index];
    if (line !== undefined) items.push(diffItem(line));
    index += 1;
  }
  diff.replaceChildren(...items);
}

function unchangedRun(count: number): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "same";
  item.textContent = `${count.toLocaleString("en-US")} unchanged lines`;
  return item;
}

/** The line with a word for screen readers and a sign for the eye, so no colour carries it alone. */
function diffItem(line: DiffLine): HTMLLIElement {
  const item = document.createElement("li");
  item.className = line.kind;
  const word = document.createElement("span");
  word.className = "visually-hidden";
  word.textContent = WORDS[line.kind];
  const sign = document.createElement("span");
  sign.setAttribute("aria-hidden", "true");
  sign.textContent = PREFIXES[line.kind];
  item.append(word, sign, document.createTextNode(line.text));
  return item;
}

function announceChanged(): void {
  unarmedText =
    current === undefined
      ? `The recipe ${token.name} was deleted meanwhile. Saving creates it again.`
      : CHANGED;
  announce(status, unarmedText);
}

function showReplyProblems(problems: Problem[]): void {
  const texts = problems.filter(({ field }) => field === undefined).map(({ text }) => text);
  if (state === "waiting") {
    announce(status, texts.join(" "));
    return;
  }
  if (state !== "saving") return;
  state = "asking";
  setEditable(true);
  renderButtons();
  const onFields = problems.flatMap(({ field, text, line, column }): FieldProblem<Field>[] => {
    if (field === undefined) return [];
    const problem: FieldProblem<Field> = { field, text };
    if (line !== undefined) problem.line = line;
    if (column !== undefined) problem.column = column;
    return [problem];
  });
  const invalid = onFields.length === 0 ? 0 : showProblems(fields, ORDER, onFields);
  const parts =
    invalid === 0
      ? texts
      : [
          invalid === 1
            ? "Not saved: 1 field needs fixing"
            : `Not saved: ${invalid} fields need fixing`,
          ...texts,
        ];
  announce(status, parts.join(" "));
}

function changed(stored: Recipe | undefined): void {
  state = "asking";
  setEditable(true);
  renderButtons();
  current = stored;
  token = { name: token.name, savedAt: stored?.savedAt ?? null };
  showCurrent();
  keepDraft();
  // Re-armed and off Save, so a second click or Enter cannot store over a version the user has
  // not read yet.
  rearm();
  (current === undefined ? status : currentHeading).focus();
  announceChanged();
}

function done(answer: "saved" | "discarded"): void {
  if (state === "done" || state === "ended") return;
  state = "done";
  setEditable(false);
  answers.remove();
  removeDraft();
  after.hidden = false;
  status.focus();
  announce(status, answer === "saved" ? "Saved." : "Discarded.");
}

/** Keeps the edits for a reload of the page while they differ from the proposal. */
function keepDraft(): void {
  if (proposal === undefined || id === null) return;
  const edits = values();
  const proposed = shownValues(proposal);
  if (ORDER.every((name) => edits[name] === proposed[name])) {
    removeDraft();
    return;
  }
  try {
    sessionStorage.setItem(id, JSON.stringify({ fields: edits, shown: token }));
  } catch {}
}

/** The kept edits for the proposal `name`, or undefined, removing a draft that is not one. */
function readDraft(name: string): { values: Values; shown: Shown } | undefined {
  if (id === null) return undefined;
  let text: string | null;
  try {
    text = sessionStorage.getItem(id);
  } catch {
    return undefined;
  }
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const draft = fieldsOf(parsed);
  const kept = valuesOf(draft?.fields);
  const shown = shownOf(draft?.shown);
  if (kept === undefined || shown?.name !== name) {
    removeDraft();
    return undefined;
  }
  return { values: kept, shown };
}

function removeDraft(): void {
  if (id === null) return;
  try {
    sessionStorage.removeItem(id);
  } catch {}
}

function valuesOf(value: unknown): Values | undefined {
  const given = fieldsOf(value);
  if (given === undefined) return undefined;
  const { name, description, sites, steps } = given;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof sites !== "string" ||
    typeof steps !== "string"
  ) {
    return undefined;
  }
  return { name, description, sites, steps };
}

function shownOf(value: unknown): Shown | undefined {
  const given = fieldsOf(value);
  if (given === undefined) return undefined;
  const { name, savedAt } = given;
  if (typeof name !== "string" || (savedAt !== null && typeof savedAt !== "string")) {
    return undefined;
  }
  return { name, savedAt };
}

function recipeFieldsOf(value: unknown): RecipeFields | undefined {
  const given = fieldsOf(value);
  if (given === undefined) return undefined;
  const { name, description, sites, steps } = given;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof steps !== "string" ||
    !Array.isArray(sites)
  ) {
    return undefined;
  }
  const entries: unknown[] = Array.from(sites);
  if (!entries.every((site): site is string => typeof site === "string")) return undefined;
  return { name, description, sites: entries, steps };
}

function recipeOf(value: unknown): Recipe | undefined {
  const fieldsGiven = recipeFieldsOf(value);
  const savedAt = fieldsOf(value)?.savedAt;
  if (fieldsGiven === undefined || typeof savedAt !== "string") return undefined;
  return { ...fieldsGiven, savedAt };
}

function problemsOf(value: unknown): Problem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const problems: Problem[] = [];
  for (const entry of Array.from<unknown>(value)) {
    const given = fieldsOf(entry);
    if (given === undefined || typeof given.text !== "string") return undefined;
    const problem: Problem = { text: given.text };
    const { field, line, column } = given;
    if (field !== undefined) {
      if (!isField(field)) return undefined;
      problem.field = field;
    }
    if (typeof line === "number") problem.line = line;
    if (typeof column === "number") problem.column = column;
    problems.push(problem);
  }
  return problems;
}

function isField(value: unknown): value is Field {
  return value === "name" || value === "description" || value === "sites" || value === "steps";
}
