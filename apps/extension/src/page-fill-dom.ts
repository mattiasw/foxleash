import {
  FILL_START_LIMIT_MS,
  type FillOutcome,
  type FillResult,
  type FillValue,
  type Result,
} from "@foxleash/protocol";
import { refError } from "./element-refs.ts";
import { viewOf } from "./page-actions-dom.ts";
import { type FillFormOptions, optionMatcher } from "./page-fill.ts";
import { isTypeableInput, lengthLimit, lineFeeds, singleLine } from "./page-input.ts";
import {
  execCommand,
  type Field,
  type InputPage,
  isFocused,
  noEffect,
  refuseLockedField,
  SETTLE_MS,
  setValue,
  wait,
} from "./page-input-dom.ts";
import { PageError } from "./page-messages.ts";

// No text goes in after this, the bound type has, so nothing changes after the page reply could
// time out.
const FILL_FALLBACK_BEFORE_MS = 5_000;

/** The page fill_form acts in. */
export interface FillPage extends InputPage {
  /** Notes the password fields the page holds now, as is done before every request. */
  notePasswordFields(): void;
}

/**
 * fill_form in the page: each field in order, set by its kind, with one result each. A field's
 * failure is its own result; the fields after it are still filled.
 */
export async function fillForm(
  options: FillFormOptions,
  page: FillPage,
): Promise<Result<"fill_form">> {
  const started = performance.now();
  const fields: FillResult[] = [];
  for (const { ref, value } of options.fields) {
    // A field before may have added a password field, which this one could turn into text.
    if (fields.length > 0 && !pastStart(started)) page.notePasswordFields();
    fields.push(await fillField(ref, value, page, started));
  }
  return { fields };
}

function pastStart(started: number): boolean {
  return performance.now() - started > FILL_START_LIMIT_MS;
}

async function fillField(
  ref: string,
  value: FillValue,
  page: InputPage,
  started: number,
): Promise<FillResult> {
  if (pastStart(started)) {
    return {
      ref,
      ok: false,
      code: "not_attempted",
      message: `fill_form ran out of time before element ${ref}; fill it in another call.`,
    };
  }
  try {
    return { ref, ok: true, outcome: await fillElement(ref, value, page, started) };
  } catch (error: unknown) {
    if (error instanceof PageError) {
      return { ref, ok: false, code: error.code, message: error.message };
    }
    return {
      ref,
      ok: false,
      code: "page_error",
      message: `Foxleash could not fill element ${ref}; read the page to see what it holds.`,
    };
  }
}

/** Resolves the ref now, since an earlier field's events may have changed the page. */
async function fillElement(
  ref: string,
  value: FillValue,
  page: InputPage,
  started: number,
): Promise<FillOutcome> {
  const lookup = page.refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const { element } = lookup;
  const view = viewOf(element);
  if (isTextField(element)) return fillText(element, ref, value, started);
  if (element instanceof view.HTMLSelectElement) return fillSelect(element, ref, value);
  if (
    element instanceof view.HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  ) {
    return fillCheck(element, ref, value);
  }
  throw notFillable(ref);
}

function isTextField(element: Element): element is Field {
  const view = viewOf(element);
  return (
    (element instanceof view.HTMLInputElement && isTypeableInput(element.type)) ||
    element instanceof view.HTMLTextAreaElement
  );
}

/**
 * Replaces what a text field holds: selects it all and inserts the text with execCommand, or
 * deletes it, falling back once to the native setter; then blurs the field so that the page sees
 * the edit end, with one change event, and reads it back.
 */
async function fillText(
  field: Field,
  ref: string,
  value: FillValue,
  started: number,
): Promise<FillOutcome> {
  if (typeof value !== "string") {
    throw new PageError("invalid_params", `fill_form needs a string for text field ${ref}.`);
  }
  refuseLockedField(field, ref, "fill_form");
  let expected = valueFor(field, value, ref);
  // Firefox records the value at focus, and on blur sends change when the value differs from it;
  // a field focused already is blurred so that it records it at the focus below.
  if (isFocused(field)) field.blur();
  let changes = 0;
  const onChange = (): void => {
    changes += 1;
  };
  field.addEventListener("change", onChange, true);
  try {
    field.focus();
    if (!isFocused(field)) {
      throw new PageError(
        "not_editable",
        `Foxleash could not focus element ${ref}, so fill_form cannot fill it.`,
      );
    }
    try {
      // The page's focus listeners have run, and may have changed the field.
      if (!isTextField(field)) throw notFillable(ref);
      refuseLockedField(field, ref, "fill_form");
      expected = valueFor(field, value, ref);
      // After the focus listeners, whose value setter calls move what Firefox recorded.
      const held = field.value;
      if (late(started)) throw outOfTime(ref);
      const compared = await putText(field, expected, ref, started, held);
      // Where Firefox sends no change on blur, Foxleash sends it just before: the page sees the
      // same events in the same order whatever the field held.
      if (expected === compared && isFocused(field)) sendChange(field);
    } finally {
      if (isFocused(field)) field.blur();
    }
    if (changes === 0) sendChange(field);
    if (field.value !== expected) {
      throw new PageError(
        "no_effect",
        `Element ${ref} lost the given text when it lost focus: the page changed or cleared it. Read the page to see what it holds; a field that suggests options as you type may need type and a click on an option.`,
      );
    }
    return "typed";
  } finally {
    field.removeEventListener("change", onChange, true);
  }
}

/**
 * The value the field is to hold for the text; refused when it is longer than the field's
 * maxlength, or the browser would change it as an input of the field's type stores it.
 */
function valueFor(field: Field, text: string, ref: string): string {
  const input = field instanceof viewOf(field).HTMLInputElement ? field : undefined;
  const expected = input !== undefined ? singleLine(text) : lineFeeds(text);
  const limit = lengthLimit(field.type, field.maxLength);
  if (limit >= 0 && expected.length > limit) {
    throw new PageError(
      "invalid_params",
      `Element ${ref} takes at most ${limit} characters; give fill_form a text that fits.`,
    );
  }
  if (input !== undefined && sanitizedValue(input, expected) !== expected) {
    throw new PageError(
      "invalid_params",
      `Element ${ref} would not keep that value: the browser changes it as the field stores it, as a number field does with letters or an email field with spaces around it.`,
    );
  }
  return expected;
}

/**
 * The value an input of the field's type keeps for `value`: the browser's own sanitization, on a
 * detached input the page cannot observe.
 */
function sanitizedValue(field: HTMLInputElement, value: string): string {
  const probe = field.ownerDocument.createElement("input");
  probe.type = field.type;
  probe.multiple = field.multiple;
  setValue(probe, value);
  return probe.value;
}

/**
 * Puts `expected` in place of all the focused field holds, and gives the value Firefox then
 * compares the field's with on blur: `focused`, unless a value setter moved it. Whether the text
 * goes in never depends on what the field held, so a protected field's value cannot be guessed.
 */
async function putText(
  field: Field,
  expected: string,
  ref: string,
  started: number,
  focused: string,
): Promise<string> {
  const doc = field.ownerDocument;
  field.select();
  let received = false;
  const onInput = (event: Event): void => {
    if (event.isTrusted) received = true;
  };
  doc.addEventListener("input", onInput, true);
  try {
    // Not insertText with "", which the editor may take as no edit at all.
    if (expected === "") execDelete(doc);
    else execCommand(doc, expected);
    await wait(SETTLE_MS);
  } finally {
    doc.removeEventListener("input", onInput, true);
  }
  if (received) {
    // No fallback: it would overwrite what the page made of the text, such as a mask's format.
    if (field.value !== expected) throw notHeld(ref);
    return focused;
  }
  // The page cancelled beforeinput, or execCommand did nothing.
  if (late(started)) throw outOfTime(ref);
  // The page's beforeinput listeners have run, and may have locked the field.
  refuseLockedField(field, ref, "fill_form");
  const before = field.value;
  setValue(field, expected);
  if (field.value !== expected) {
    setValue(field, before);
    throw noEffect(ref);
  }
  field.dispatchEvent(
    new (viewOf(field).InputEvent)("input", {
      bubbles: true,
      composed: true,
      inputType: expected === "" ? "deleteContentBackward" : "insertText",
      data: expected === "" ? null : expected,
    }),
  );
  await wait(SETTLE_MS);
  if (field.value !== expected) throw notHeld(ref);
  // Firefox's value setter moves it along when the field still held it.
  return before === focused ? expected : focused;
}

function sendChange(field: Field): void {
  field.dispatchEvent(new (viewOf(field).Event)("change", { bubbles: true }));
}

/** execCommand delete, and whether Firefox says it ran. */
function execDelete(doc: Document): boolean {
  try {
    return doc.execCommand("delete");
  } catch {
    return false;
  }
}

function late(started: number): boolean {
  return performance.now() - started > FILL_FALLBACK_BEFORE_MS;
}

function outOfTime(ref: string): PageError {
  return new PageError(
    "no_effect",
    `fill_form ran out of time before it could put the text in element ${ref}; read the page before filling it again.`,
  );
}

function notHeld(ref: string): PageError {
  return new PageError(
    "no_effect",
    `Element ${ref} does not hold the given text after it went in: the page changed or refused it. Read the page to see what the field holds.`,
  );
}

/**
 * Chooses the options of a select by value, else by label: the whole selection becomes the given
 * options, with input and change events when it changes.
 */
function fillSelect(select: HTMLSelectElement, ref: string, value: FillValue): FillOutcome {
  if (typeof value === "boolean" || (Array.isArray(value) && !select.multiple)) {
    throw new PageError(
      "invalid_params",
      select.multiple
        ? `Element ${ref} takes options; give the value or label of one as a string, or a list of them.`
        : `Element ${ref} takes one option; give its value or label as a string.`,
    );
  }
  if (select.matches(":disabled")) {
    throw new PageError(
      "not_editable",
      `Element ${ref} is a disabled select, so fill_form cannot change it.`,
    );
  }
  const options = Array.from(select.options);
  const match = optionMatcher(
    options.map((option) => ({
      value: option.value,
      label: option.label,
      disabled: option.matches(":disabled"),
    })),
  );
  const chosen = new Set<number>();
  const wanted = typeof value === "string" ? [value] : value;
  for (const [index, entry] of wanted.entries()) {
    const found = match(entry);
    const which = typeof value === "string" ? "" : ` (entry ${index + 1})`;
    if (found === "none") {
      throw new PageError(
        "invalid_params",
        `Element ${ref} has no option with that value or label${which}.`,
      );
    }
    if (found === "disabled") {
      throw new PageError(
        "invalid_params",
        `The option of element ${ref} that matches${which} is disabled.`,
      );
    }
    chosen.add(found);
  }
  if (holds(options, chosen)) return "unchanged";
  for (const [index, option] of options.entries()) {
    // On a single select, choosing one option deselects the others.
    if (select.multiple || chosen.has(index)) option.selected = chosen.has(index);
  }
  const view = viewOf(select);
  select.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new view.Event("change", { bubbles: true }));
  if (!holds(options, chosen)) {
    throw new PageError(
      "no_effect",
      `Element ${ref} did not keep the chosen options: the page set it back.`,
    );
  }
  return "selected";
}

function holds(options: readonly HTMLOptionElement[], chosen: ReadonlySet<number>): boolean {
  return options.every((option, index) => option.selected === chosen.has(index));
}

/** Clicks a checkbox or radio button whose state differs from the one given. */
function fillCheck(box: HTMLInputElement, ref: string, value: FillValue): FillOutcome {
  const radio = box.type === "radio";
  if (typeof value !== "boolean") {
    throw new PageError(
      "invalid_params",
      radio
        ? `fill_form needs true for radio button ${ref}.`
        : `fill_form needs true or false for checkbox ${ref}.`,
    );
  }
  if (radio && !value) {
    throw new PageError(
      "invalid_params",
      `Radio button ${ref} is turned off by choosing another one in its group; give true for the one to choose.`,
    );
  }
  if (box.matches(":disabled")) {
    throw new PageError(
      "not_editable",
      `Element ${ref} is disabled, so fill_form cannot change it.`,
    );
  }
  if (box.checked === value) return "unchanged";
  box.click();
  if (box.checked !== value) {
    throw new PageError(
      "no_effect",
      `Element ${ref} did not change: the page cancelled the click or set it back.`,
    );
  }
  return "clicked";
}

function notFillable(ref: string): PageError {
  return new PageError(
    "not_editable",
    `fill_form fills text fields, textareas, selects, checkboxes and radio buttons, and element ${ref} is none of them; use type for an editable area and upload_file for a file field.`,
  );
}
