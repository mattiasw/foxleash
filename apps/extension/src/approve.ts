import type { Port, Timers } from "./browser-api.ts";
import { announce, armButtons, element, fieldsOf, REFOCUS } from "./page-ui.ts";

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

const PAGE = "prompt page";
const heading = element("heading", PAGE);
const target = element("target", PAGE);
const credentials = element("credentials", PAGE);
const answers = element("answers", PAGE);
const status = element("status", PAGE);
const after = element("after", PAGE);
const back = element("back", PAGE);
const close = element("close", PAGE);
const buttons = [...answers.querySelectorAll<HTMLButtonElement>("button[data-answer]")];
let state: State = "waiting";
let port: Port | undefined;
const { renderButtons, watch, rearm } = armButtons({
  buttons,
  timers,
  asking: () => state === "prompt",
  onAnswer,
  onUnarmed: (reason) => announce(status, reason === "refocus" ? REFOCUS : UNARMED),
  rest: () => heading,
});

back.addEventListener("click", () => history.back());

const id = new URLSearchParams(location.search).get("id");
if (id === null) end();
else connect(id);

function onAnswer(button: HTMLButtonElement): void {
  const answer = button.dataset.answer;
  if (!isAnswer(answer)) return;
  state = "saving";
  renderButtons();
  announce(status, "Saving");
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
    // Asking again: the second before arming counts from now.
    rearm();
    announce(status, "Firefox could not save the answer. Try again.");
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
  const question = `Allow Foxleash on ${site}?`;
  document.title = question;
  heading.textContent = question;
  const shown = displayedUrl(url);
  target.textContent = shown.text;
  credentials.hidden = !shown.credentials;
  state = "prompt";
  renderButtons();
  heading.focus();
  // From now on, so the second before arming counts from when the question can be read.
  watch();
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
  announce(status, text);
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
  announce(status, "This request has ended. Ask the agent to try again.");
}

function isAnswer(value: unknown): value is Answer {
  return value === "once" || value === "always" || value === "no";
}
