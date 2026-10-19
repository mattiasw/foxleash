import type { Port, Timers } from "./browser-api.ts";
import { createArming } from "./prompt-arming.ts";

declare const browser: { runtime: { connect(connectInfo: { name: string }): Port } };

type Answer = "once" | "always" | "no";
type State = "waiting" | "prompt" | "saving" | "done" | "ended";

const MAX_URL_LENGTH = 500;
const UNARMED = "The buttons respond a moment after this window is focused.";

// Wrapped: Firefox's setTimeout throws when called on anything but the window.
const timers: Timers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

const heading = element("heading");
const target = element("target");
const credentials = element("credentials");
const answers = element("answers");
const status = element("status");
const after = element("after");
const back = element("back");
const close = element("close");
const buttons = [...answers.querySelectorAll<HTMLButtonElement>("button[data-answer]")];
const arming = createArming(timers, renderButtons);
let state: State = "waiting";
let port: Port | undefined;
// Whether the press that starts the coming click happened while armed; undefined without one.
let pressArmed: boolean | undefined;
// The latest announcement, written to the live region on the next frame.
let message = "";

for (const button of buttons) {
  // Fires when the press starts, also for touch and pen, whose mousedown comes after the tap.
  button.addEventListener("pointerdown", () => {
    pressArmed = arming.armed();
  });
  button.addEventListener("keydown", (event) => {
    // A held key is one press, started when it went down. A held Enter would also answer
    // again as soon as the buttons re-arm.
    if (event.repeat) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    // Only the keys that click a button; Tab moving focus on is no press.
    if (event.key === "Enter" || event.key === " ") pressArmed = arming.armed();
  });
  button.addEventListener("click", (event) => onClick(event, button));
}
back.addEventListener("click", () => history.back());

const id = new URLSearchParams(location.search).get("id");
if (id === null) end();
else connect(id);

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The prompt page has no #${id}.`);
  return found;
}

/** Buttons answer only while armed and asking; `aria-disabled`, not `disabled`, keeps them focusable. */
function renderButtons(): void {
  const enabled = state === "prompt" && arming.armed();
  for (const button of buttons) {
    if (enabled) button.removeAttribute("aria-disabled");
    else button.setAttribute("aria-disabled", "true");
  }
}

function onClick(event: MouseEvent, button: HTMLButtonElement): void {
  const pressed = pressArmed;
  pressArmed = undefined;
  // Only the user's own click answers, and not the second click of a double click.
  if (!event.isTrusted || event.detail > 1 || state !== "prompt") return;
  if (!arming.armed() || pressed === false) {
    announce(UNARMED);
    return;
  }
  const answer = button.dataset.answer;
  if (!isAnswer(answer)) return;
  state = "saving";
  renderButtons();
  announce("Saving");
  try {
    port?.postMessage({ type: "answer", answer });
  } catch {
    end();
  }
}

function connect(promptId: string): void {
  const opened = browser.runtime.connect({ name: "approve" });
  port = opened;
  opened.onMessage.addListener(receive);
  opened.onDisconnect.addListener(() => end());
  opened.postMessage({ type: "ready", id: promptId });
}

function receive(received: unknown): void {
  const fields = fieldsOf(received);
  if (fields === undefined) return;
  if (fields.type === "prompt" && typeof fields.site === "string") {
    if (state === "waiting" && typeof fields.url === "string") ask(fields.site, fields.url);
  } else if (fields.type === "error") {
    if (state !== "saving") return;
    state = "prompt";
    renderButtons();
    announce("Firefox could not save the answer. Try again.");
  } else if (fields.type === "done") {
    const { answer, loadsHere, late } = fields;
    if (isAnswer(answer) && typeof loadsHere === "boolean" && typeof late === "boolean") {
      done(answer, loadsHere, late);
    }
  } else if (fields.type === "ended") {
    end();
  }
}

function ask(site: string, url: string): void {
  const question = `Allow Foxhand on ${site}?`;
  document.title = question;
  heading.textContent = question;
  const shown = displayedUrl(url);
  target.textContent = shown.text;
  credentials.hidden = !shown.credentials;
  state = "prompt";
  renderButtons();
  // From now on, so the second before arming counts from when the question can be read.
  arming.visible(document.visibilityState === "visible");
  arming.focused(document.hasFocus());
  document.addEventListener("visibilitychange", () => {
    arming.visible(document.visibilityState === "visible");
  });
  window.addEventListener("focus", () => arming.focused(true));
  window.addEventListener("blur", () => arming.focused(false));
}

/** The URL without a user name or password, which could make another site look like the one asked for. */
function displayedUrl(url: string): { text: string; credentials: boolean } {
  const parsed = URL.parse(url);
  let text = url;
  let hasCredentials = false;
  if (parsed !== null) {
    hasCredentials = parsed.username !== "" || parsed.password !== "";
    parsed.username = "";
    parsed.password = "";
    text = parsed.href;
  }
  if (text.length > MAX_URL_LENGTH) text = `${text.slice(0, MAX_URL_LENGTH)}…`;
  return { text, credentials: hasCredentials };
}

function done(answer: Answer, loadsHere: boolean, late: boolean): void {
  if (state === "done" || state === "ended") return;
  state = "done";
  answers.remove();
  const loading = answer !== "no" && loadsHere;
  let text: string;
  if (answer === "no") {
    text = late ? "Not allowed." : "Not allowed. The agent was told.";
  } else if (loading) {
    text = "Allowed. The agent is loading the page.";
  } else {
    text = answer === "once" ? "Allowed for this session." : "Allowed always.";
    if (late) text += " Ask the agent to try again.";
  }
  if (!loading) showAfter();
  status.focus();
  announce(text);
}

function showAfter(): void {
  after.hidden = false;
  if (history.length > 1) back.hidden = false;
  else close.hidden = false;
}

function end(): void {
  if (state === "done" || state === "ended") return;
  state = "ended";
  answers.remove();
  status.focus();
  announce("This request has ended. Ask the agent to try again.");
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

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return { ...value };
}

function isAnswer(value: unknown): value is Answer {
  return value === "once" || value === "always" || value === "no";
}
