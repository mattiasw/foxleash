import type { BrowserApi, Port, Timers } from "./browser-api.ts";
import { announce, armButtons, element, fieldsOf, REFOCUS } from "./page-ui.ts";
import { watchWebsiteAccess } from "./website-access.ts";

declare const browser: {
  runtime: { connect(connectInfo: { name: string }): Port };
  permissions: Pick<BrowserApi["permissions"], "contains" | "request" | "onAdded" | "onRemoved">;
};

type Answer = "allow" | "no";
type SiteState = "allowed" | "blocked" | "refused" | "askable";
type State = "waiting" | "asking" | "answering" | "done" | "ended";

const PAGE = "run page";
const REQUEST_INTRO =
  "The agent asks to use these sites for its task. Only the addresses come from the agent.";
const UNARMED = "The buttons respond a moment after this window is focused.";
const WORDS: Record<SiteState, string> = {
  askable: "will be allowed for this session",
  allowed: "already allowed",
  blocked: "blocked by your blocklist, stays blocked",
  refused: "refused earlier in this session, stays refused",
};

// Wrapped: Firefox's setTimeout throws when called on anything but the window.
const timers: Timers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

const heading = element("heading", PAGE);
const recipe = element("recipe", PAGE);
const sites = element("sites", PAGE);
const answers = element("answers", PAGE);
const status = element("status", PAGE);
const after = element("after", PAGE);
const websiteAccess = element("website-access", PAGE);
const websiteAccessGive = element("website-access-give", PAGE);
const websiteAccessStatus = element("website-access-status", PAGE);
const buttons = [...answers.querySelectorAll<HTMLButtonElement>("button[data-answer]")];
let state: State = "waiting";
let port: Port | undefined;
// True while Firefox's prompt for the access is open: keys meant for it must not answer.
let accessRequested = false;
const { renderButtons, watch, rearm } = armButtons({
  buttons,
  timers,
  asking: () => state === "asking" && !accessRequested,
  onAnswer,
  onUnarmed: (reason) => announce(status, reason === "refocus" ? REFOCUS : UNARMED),
  rest: () => heading,
});
watchWebsiteAccess({
  elements: {
    warning: websiteAccess,
    button: websiteAccessGive,
    steps: element("website-access-steps", PAGE),
  },
  browser,
  announce: (text) => announce(websiteAccessStatus, text),
  // The warning sits above the answers: whatever it changes moves them (ADR 0057).
  beforeChange: (hiding) => {
    rearm();
    if (hiding && websiteAccess.contains(document.activeElement)) websiteAccessStatus.focus();
  },
  onRequest: (pending) => {
    accessRequested = pending;
    // A Tab path built while the prompt was open must not carry over.
    rearm();
    renderButtons();
  },
});

const id = new URLSearchParams(location.search).get("id");
if (id === null) end();
else connect();

function onAnswer(button: HTMLButtonElement): void {
  const answer = button.dataset.answer;
  if (!isAnswer(answer)) return;
  state = "answering";
  renderButtons();
  send({ type: "answer", answer });
}

function end(): void {
  if (state === "done" || state === "ended") return;
  state = "ended";
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

function receive(received: unknown): void {
  const message = fieldsOf(received);
  if (message === undefined) return;
  if (message.type === "run") {
    const { name, description } = message;
    const shown = sitesOf(message.sites);
    if (
      state === "waiting" &&
      typeof name === "string" &&
      typeof description === "string" &&
      shown !== undefined
    ) {
      ask(`Recipe ${name}: ${description}`, shown);
    }
  } else if (message.type === "sites") {
    const shown = sitesOf(message.sites);
    if (state === "waiting" && shown !== undefined) ask(REQUEST_INTRO, shown);
  } else if (message.type === "done") {
    const { answer, late } = message;
    if (isAnswer(answer) && typeof late === "boolean") done(answer, late);
  } else if (message.type === "ended") {
    end();
  }
}

function ask(intro: string, shown: { site: string; state: SiteState }[]): void {
  recipe.textContent = intro;
  sites.replaceChildren(
    ...shown.map(({ site, state: siteState }) => {
      const item = document.createElement("li");
      // In a span, so a long host wraps.
      const text = document.createElement("span");
      text.textContent = `${site}: ${WORDS[siteState]}`;
      item.append(text);
      return item;
    }),
  );
  state = "asking";
  renderButtons();
  heading.focus();
  // From now on, so the second before arming counts from when the sites can be read.
  watch();
}

function done(answer: Answer, late: boolean): void {
  if (state === "done" || state === "ended") return;
  state = "done";
  answers.remove();
  after.hidden = false;
  status.focus();
  let text: string;
  if (answer === "allow") {
    text = late
      ? "Allowed for this session. Ask the agent to try again."
      : "Allowed for this session. The agent is continuing.";
  } else {
    text = late ? "Not allowed." : "Not allowed. The agent was told.";
  }
  announce(status, text);
}

/** The sites with their states, or undefined when any entry is not one. */
function sitesOf(value: unknown): { site: string; state: SiteState }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const given: unknown[] = value;
  const entries: { site: string; state: SiteState }[] = [];
  for (const entry of given) {
    const fields = fieldsOf(entry);
    if (fields === undefined || typeof fields.site !== "string" || !isSiteState(fields.state)) {
      return undefined;
    }
    entries.push({ site: fields.site, state: fields.state });
  }
  return entries;
}

function isAnswer(value: unknown): value is Answer {
  return value === "allow" || value === "no";
}

function isSiteState(value: unknown): value is SiteState {
  return value === "allowed" || value === "blocked" || value === "refused" || value === "askable";
}
