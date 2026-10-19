import type { BrowserApi } from "./browser-api.ts";
import { DEFAULT_BLOCKLIST } from "./default-blocklist.ts";
import {
  effectiveBlocklist,
  isRecord,
  onSettingsChanged,
  readSettings,
  revokeSite,
  type SettingsBrowser,
  saveBlocklist,
} from "./settings.ts";
import { parseBlocklist } from "./site.ts";
import type { SessionAnswers } from "./site-access.ts";

declare const browser: SettingsBrowser & { runtime: Pick<BrowserApi["runtime"], "sendMessage"> };

const READ_FAILED = "Could not read Foxhand's settings.";
const ANSWERS_FAILED = "Could not read the answers of running sessions.";

interface AnswerRow {
  key: string;
  text: string;
  forget(): void;
}

const list = element("sites");
const empty = element("sites-empty");
const status = element("status");
const heading = element("sites-heading");
const answers = element("answers");
const answersEmpty = element("answers-empty");
const answersStatus = element("answers-status");
const answersHeading = element("answers-heading");
const field = element("blocklist");
if (!(field instanceof HTMLTextAreaElement)) {
  throw new Error("The settings page's #blocklist is not a textarea.");
}
const blocklist: HTMLTextAreaElement = field;
const blocklistErrors = element("blocklist-errors");
const blocklistStatus = element("blocklist-status");
// Each live region's latest announcement, written to it on the next frame.
const messages = new Map<HTMLElement, string>();
// Counts renders, so a read that finishes after a newer render started is discarded.
let renders = 0;
// Counts reads of the session answers, for the same reason.
let answerReads = 0;
// The answer rows shown, so a refresh that finds the same rows leaves them (and focus) alone.
let shownAnswers = "";
// Whether the textarea holds a whole list. Until then it is read-only and Save stores nothing,
// so a failed or unfinished read cannot save an empty list.
let filled = false;

onSettingsChanged(browser, render);
render();
refreshAnswers();
// The background has no event for changed answers; coming back to the page reads them again.
window.addEventListener("focus", refreshAnswers);
// Inline in the add-ons manager, coming back to its tab need not focus this page.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAnswers();
});
fillBlocklist("");
element("blocklist-save").addEventListener("click", save);
element("blocklist-default").addEventListener("click", fillDefault);

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The settings page has no #${id}.`);
  return found;
}

function render(): void {
  renders += 1;
  const current = renders;
  readSettings(browser).then(
    ({ sites }) => {
      if (current === renders) show(sites);
    },
    () => {
      if (current === renders) announce(status, READ_FAILED);
    },
  );
}

function show(sites: string[]): void {
  const focused = focusedRow(list);
  list.replaceChildren(...sites.map(siteRow));
  list.hidden = sites.length === 0;
  empty.hidden = sites.length > 0;
  if (messages.get(status) === READ_FAILED) announce(status, "");
  if (focused !== undefined) restoreFocus(list, heading, focused, sites);
}

/** The key and position of the row button in `rows` that has focus, if one has. */
function focusedRow(rows: HTMLElement): { key: string; index: number } | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement) || !rows.contains(active)) return undefined;
  const key = active.dataset.key;
  if (key === undefined) return undefined;
  return { key, index: rowButtons(rows).indexOf(active) };
}

function siteRow(site: string): HTMLLIElement {
  const item = row(site, "Revoke", site, () => revoke(site));
  const button = item.querySelector("button");
  if (button !== null) button.dataset.site = site;
  return item;
}

function row(text: string, action: string, key: string, onClick: () => void): HTMLLIElement {
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action;
  button.setAttribute("aria-label", `${action} ${text}`);
  button.dataset.key = key;
  button.addEventListener("click", (event) => {
    // The second click of a double-click would land on the next row, moved up under the pointer.
    if (event.detail > 1) return;
    onClick();
  });
  // A held Enter would go on to act on each row that takes focus after this one.
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
  });
  item.append(name, button);
  return item;
}

function revoke(site: string): void {
  revokeSite(browser, site).then(
    () => announce(status, `Revoked ${site}`),
    () => announce(status, `Could not revoke ${site}.`),
  );
}

/** Focuses the same row's button, else the next row's, else the previous row's, else `fallback`. */
function restoreFocus(
  rows: HTMLElement,
  fallback: HTMLElement,
  focused: { key: string; index: number },
  keys: string[],
): void {
  const buttons = rowButtons(rows);
  const kept = keys.indexOf(focused.key);
  const target = buttons[kept >= 0 ? kept : Math.min(focused.index, buttons.length - 1)];
  (target ?? fallback).focus();
}

function rowButtons(rows: HTMLElement): HTMLButtonElement[] {
  return [...rows.querySelectorAll("button")];
}

/** Clears the live region first, so a repeated message is announced again. */
function announce(region: HTMLElement, text: string): void {
  messages.set(region, text);
  region.textContent = "";
  if (text !== "") {
    requestAnimationFrame(() => {
      region.textContent = messages.get(region) ?? "";
    });
  }
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
    typeof value.closed === "number"
  );
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry: unknown): boolean => typeof entry === "string")
  );
}

function showAnswers(held: SessionAnswers[]): void {
  if (messages.get(answersStatus) === ANSWERS_FAILED) announce(answersStatus, "");
  const rows = held.flatMap(answerRows);
  const shown = JSON.stringify(rows.map(({ key, text }) => [key, text]));
  // Replacing identical rows would announce them again and could swap a button under a click.
  if (shown === shownAnswers) return;
  shownAnswers = shown;
  const focused = focusedRow(answers);
  answers.replaceChildren(...rows.map(({ key, text, forget }) => row(text, "Forget", key, forget)));
  answers.hidden = rows.length === 0;
  answersEmpty.hidden = rows.length > 0;
  if (focused !== undefined) {
    restoreFocus(
      answers,
      answersHeading,
      focused,
      rows.map(({ key }) => key),
    );
  }
}

function answerRows({ session, label, allowed, refused, closed }: SessionAnswers): AnswerRow[] {
  const siteAnswer = (site: string, answer: string): AnswerRow => ({
    key: JSON.stringify([session, site]),
    text: `${site}: ${answer} this session (${label})`,
    forget: () => forget(session, site, `${site} for this session`),
  });
  const rows = [
    ...allowed.map((site) => siteAnswer(site, "allowed")),
    ...refused.map((site) => siteAnswer(site, "refused")),
  ];
  if (closed > 0) {
    const prompts = closed === 1 ? "1 prompt" : `${closed} prompts`;
    rows.push({
      // No site is "closed": a site is a scheme and a host.
      key: JSON.stringify([session, "closed"]),
      text: `${prompts} closed without an answer (${label})`,
      forget: () => forget(session, "closed", "the closed prompts"),
    });
  }
  return rows;
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
    showErrors(parsed.errors);
    return;
  }
  const { patterns } = parsed;
  clearErrors();
  saveBlocklist(browser, patterns).then(
    () => {
      fillBlocklist(text);
      announce(
        blocklistStatus,
        patterns.length === 0 ? "Saved. Foxhand blocks no sites now." : "Saved",
      );
    },
    () => announce(blocklistStatus, "Could not save the blocklist."),
  );
}

function showErrors(errors: { line: number; text: string }[]): void {
  blocklistErrors.replaceChildren(
    ...errors.map(({ line, text }) => {
      const item = document.createElement("li");
      item.textContent = `Line ${line}: ${text}`;
      return item;
    }),
  );
  blocklistErrors.hidden = false;
  blocklist.setAttribute("aria-invalid", "true");
  blocklist.focus();
  const first = errors[0];
  if (first !== undefined) selectLine(first.line);
  announce(
    blocklistStatus,
    errors.length === 1
      ? "Not saved: 1 line needs fixing"
      : `Not saved: ${errors.length} lines need fixing`,
  );
}

/** Selects line `line`, counted from 1; a textarea's value separates lines with "\n" only. */
function selectLine(line: number): void {
  const lines = blocklist.value.split("\n");
  const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  blocklist.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
}

function clearErrors(): void {
  blocklistErrors.replaceChildren();
  blocklistErrors.hidden = true;
  blocklist.removeAttribute("aria-invalid");
}

function fillDefault(): void {
  blocklist.value = DEFAULT_BLOCKLIST.join("\n");
  blocklist.readOnly = false;
  filled = true;
  clearErrors();
  announce(blocklistStatus, "Filled in the built-in list. Save to use it.");
}
