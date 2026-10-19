import { onSettingsChanged, readSettings, revokeSite, type SettingsBrowser } from "./settings.ts";

declare const browser: SettingsBrowser;

const READ_FAILED = "Could not read Foxhand's settings.";

const list = element("sites");
const empty = element("sites-empty");
const status = element("status");
const heading = element("sites-heading");
// Counts renders, so a read that finishes after a newer render started is discarded.
let renders = 0;
// The latest announcement, written to the live region on the next frame.
let message = "";

onSettingsChanged(browser, render);
render();

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
      if (current === renders) announce(READ_FAILED);
    },
  );
}

function show(sites: string[]): void {
  const focused = focusedRow();
  list.replaceChildren(...sites.map(row));
  list.hidden = sites.length === 0;
  empty.hidden = sites.length > 0;
  if (message === READ_FAILED) announce("");
  if (focused !== undefined) restoreFocus(focused, sites);
}

/** The site and position of the Revoke button that has focus, if one has. */
function focusedRow(): { site: string; index: number } | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement) || !list.contains(active)) return undefined;
  const site = active.dataset.site;
  if (site === undefined) return undefined;
  return { site, index: revokeButtons().indexOf(active) };
}

function row(site: string): HTMLLIElement {
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = site;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Revoke";
  button.setAttribute("aria-label", `Revoke ${site}`);
  button.dataset.site = site;
  button.addEventListener("click", (event) => {
    // The second click of a double-click would land on the next row, moved up under the pointer.
    if (event.detail > 1) return;
    revokeSite(browser, site).then(
      () => announce(`Revoked ${site}`),
      () => announce(`Could not revoke ${site}.`),
    );
  });
  // A held Enter would go on to revoke each row that takes focus after this one.
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
  });
  item.append(name, button);
  return item;
}

/** Focuses the same site's button, else the next row's, else the previous row's, else the heading. */
function restoreFocus(focused: { site: string; index: number }, sites: string[]): void {
  const buttons = revokeButtons();
  const kept = sites.indexOf(focused.site);
  const target = buttons[kept >= 0 ? kept : Math.min(focused.index, buttons.length - 1)];
  (target ?? heading).focus();
}

function revokeButtons(): HTMLButtonElement[] {
  return [...list.querySelectorAll("button")];
}

/** Clears the live region first, so a repeated message is announced again. */
function announce(text: string): void {
  message = text;
  status.textContent = "";
  if (text !== "") {
    requestAnimationFrame(() => {
      status.textContent = message;
    });
  }
}
