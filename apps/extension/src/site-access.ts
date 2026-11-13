import type { TabInfo } from "@foxleash/protocol";
import type { BrowserApi, MessageSender, Port, RuntimePort, Tab, Timers } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import type { SessionGroups } from "./session-groups.ts";
import { effectiveBlocklist, grantSite, readSettings } from "./settings.ts";
import { hostOf, matchesDomain, redactedUrl, siteOf } from "./site.ts";

/** Per MCP session, its answers and refusals. A Map: `__proto__` is a valid id. Never stored. */
export type SessionMemory = Map<string, SessionState>;

export interface SessionState {
  /** Sites the user allowed for this session only. */
  allowed: Set<string>;
  /** Sites the user did not allow in this session. */
  refused: Set<string>;
  /** Prompts closed without an answer. */
  closed: number;
}

/** How long a request waits for the user's answer. */
export const APPROVAL_WAIT_MS = 30_000;
/** The extension page that asks the user. */
export const PROMPT_PAGE = "approve.html";
/** The settings page, the only page that may read or forget session answers. */
export const OPTIONS_PAGE = "options.html";

const PORT_NAME = "approve";
// Refused and closed prompts a session may have before Foxleash stops asking.
const PROMPT_BUDGET = 3;

/** What a session may do with a site: load it, never, never in this session, or ask the user. */
export type SiteState = "allowed" | "blocked" | "refused" | "askable";

export type Decision =
  | { decision: "allowed" }
  | { decision: "ask" }
  /** Wait on the session's open prompt for the same site, in `tabId`. */
  | { decision: "join"; tabId: number };

export interface Approval {
  /** Resolves when the site may load; rejects with the answer's ToolError. Never unhandled. */
  answer: Promise<void>;
  /**
   * Whether the prompt this approval waits on is shown in the asked tab. False when the site was
   * allowed meanwhile or the request waits on a prompt in another tab.
   */
  promptInTab: boolean;
}

export interface OpenPrompt {
  tabId: number;
  site: string;
  /** The URL the prompt asks about. */
  url: string;
  /** Whether a request is waiting for the answer. */
  waiting: boolean;
}

export interface SiteAccessDeps<Handle> {
  browser: Pick<BrowserApi, "storage" | "runtime" | "tabs" | "windows">;
  groups: Pick<SessionGroups, "groupOf">;
  sessions: SessionMemory;
  timers: Timers<Handle>;
  /** The session's approval of the site ended: the user withdrew it, or the session ended. */
  onWithdraw?: (session: string, site: string) => void;
  /**
   * The session's open recipe page, which no site prompt may open beside; `question` says what it
   * asks, such as "whether to save a recipe".
   */
  otherPrompt?: (session: string) => { tabId: number; question: string } | undefined;
}

export interface SiteAccess {
  /** What one session may see, as stored and granted at the time of the call. */
  view(session: string): Promise<SiteView>;
  /**
   * The gate before a load: throws `invalid_url`, `site_blocked`, `site_refused` or
   * `approval_pending` (also while the session's recipe page is open), else says whether the
   * site is allowed, must be asked for, or can join the session's open prompt. Changes nothing.
   */
  check(session: string, url: string): Promise<Decision>;
  /**
   * Asks the user in `tabId` whether the session may load `url`'s site, or joins the session's
   * open prompt for that site. Rejects when it shows nothing; resolves once the prompt is shown.
   * With `promptUrl` (from `newPromptUrl`), the tab was created unloaded on that URL, and the
   * prompt is loaded in place of the tab's one history entry.
   */
  ask(session: string, url: string, tabId: number, promptUrl?: string): Promise<Approval>;
  /** A new, unique URL for a prompt page, for a tab created on it before `ask` shows it there. */
  newPromptUrl(): string;
  openPrompt(session: string): OpenPrompt | undefined;
  /** The URL the session's answered prompt asked about, while `tab` still shows that prompt. */
  askedUrl(session: string, tab: Tab): string | undefined;
  /** Forgets the session's answers and closes its open prompt. */
  endSession(session: string): void;
  /** The answers each session holds, sites sorted. */
  sessionAnswers(): Promise<SessionAnswers[]>;
  /** For a recipe's sites: what the session may do with each, as stored and granted now. Changes nothing. */
  siteStates(session: string, sites: readonly string[]): Promise<Map<string, SiteState>>;
  /**
   * Allows for this session only the given sites that are still askable after a fresh read, and
   * returns them; allows nothing and returns [] when `stillOpen()` is false after the read.
   * Stores nothing.
   */
  allowForSession(
    session: string,
    sites: readonly string[],
    stillOpen: () => boolean,
  ): Promise<string[]>;
  /**
   * Refuses once the session's refused and closed prompts reach the budget: from then on Foxleash
   * asks the user nothing about sites in that session.
   */
  refuseIfStoppedAsking(session: string): void;
  /**
   * Forgets one answer of the session: a site it allowed or refused, or with `"closed"` its
   * closed prompts. Only removes; never allows anything.
   */
  forget(session: string, site: string): void;
}

/** What the settings page lists for one session. */
export interface SessionAnswers {
  session: string;
  /** The session as the user can recognize it: by the tabs in its group. */
  label: string;
  allowed: string[];
  refused: string[];
  closed: number;
}

export interface SiteView {
  /** Whether the URL's site is on the effective blocklist. */
  blocked(url: string): boolean;
  allowed(url: string): boolean;
  /** The tab as the agent sees it: in full on an allowed site, otherwise redacted. */
  tabInfo(tab: Tab): TabInfo;
}

type Answer = "once" | "always" | "no";

interface Prompt<Handle> {
  session: string;
  site: string;
  url: string;
  tabId: number;
  promptUrl: string;
  /** The tab has shown the prompt page, so leaving it closes the prompt. */
  committed: boolean;
  /** The connected prompt page; messages count only from this port. */
  port: Port | undefined;
  /** A prompt page ever connected, so the user could have seen the question. */
  seen: boolean;
  answering: boolean;
  waiter: Waiter<Handle> | undefined;
}

/** A prompt the user answered, still shown in its tab. */
interface Answered {
  session: string;
  promptUrl: string;
  url: string;
}

interface Waiter<Handle> {
  /** The tab the waiting request loads after an allowing answer. */
  tabId: number;
  resolve(): void;
  reject(error: ToolError): void;
  timer: Handle;
}

export function createSiteAccess<Handle>({
  browser,
  groups,
  sessions,
  timers,
  onWithdraw,
  otherPrompt,
}: SiteAccessDeps<Handle>): SiteAccess {
  // The open prompt of each session; at most one.
  const prompts = new Map<string, Prompt<Handle>>();
  // By tab: the answered prompt each tab shows, so a reload there loads what it asked about.
  const answered = new Map<number, Answered>();

  browser.runtime.onConnect.addListener(connect);
  browser.runtime.onMessage.addListener(receiveFromSettings);
  browser.tabs.onRemoved.addListener((tabId) => {
    answered.delete(tabId);
    for (const prompt of promptsIn(tabId)) drop(prompt, true);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined && changeInfo.url !== answered.get(tabId)?.promptUrl) {
      answered.delete(tabId);
    }
    for (const prompt of promptsIn(tabId)) {
      if (changeInfo.url !== undefined && changeInfo.url !== prompt.promptUrl) {
        // Before the prompt commits, a URL can be a late event of the page it replaces.
        if (prompt.committed) drop(prompt, true);
      } else if (
        changeInfo.url === prompt.promptUrl ||
        (changeInfo.status === "complete" && tab.url === prompt.promptUrl)
      ) {
        prompt.committed = true;
      }
    }
  });

  return {
    view,
    check,
    ask,
    newPromptUrl,
    openPrompt,
    askedUrl,
    endSession,
    sessionAnswers,
    siteStates,
    allowForSession,
    refuseIfStoppedAsking,
    forget,
  };

  async function view(session: string): Promise<SiteView> {
    const settings = await readSettings(browser);
    const stored = new Set(settings.sites);
    const blocklist = effectiveBlocklist(settings);
    const granted = sessions.get(session);
    const blocked = (url: string): boolean => {
      const site = siteOf(url);
      if (site === undefined) return false;
      const host = hostOf(site);
      return blocklist.some((pattern) => matchesDomain(host, pattern));
    };
    const allowed = (url: string): boolean => {
      const site = siteOf(url);
      return (
        site !== undefined &&
        (stored.has(site) || granted?.allowed.has(site) === true) &&
        !blocked(url)
      );
    };
    const tabInfo = (tab: Tab): TabInfo => {
      const url = tab.url ?? "";
      if (allowed(url)) {
        // A loading tab can report the new URL while its title is still the previous page's.
        const title = tab.status === "complete" ? (tab.title ?? "") : "";
        return { id: tab.id, url, title, active: tab.active };
      }
      return { id: tab.id, url: redactedUrl(tab.url), title: "", active: tab.active };
    };
    return { blocked, allowed, tabInfo };
  }

  async function check(session: string, url: string): Promise<Decision> {
    const site = webSite(url);
    const current = await view(session);
    if (current.blocked(url)) throw siteBlocked(site);
    if (current.allowed(url)) return { decision: "allowed" };
    refuseIfAnswered(session, site);
    refuseBesideOtherPrompt(session);
    const prompt = prompts.get(session);
    if (prompt !== undefined) return { decision: "join", tabId: joinable(prompt, site).tabId };
    return { decision: "ask" };
  }

  async function ask(
    session: string,
    url: string,
    tabId: number,
    promptUrl?: string,
  ): Promise<Approval> {
    const site = webSite(url);
    const current = await view(session);
    // No await from here until the prompt is recorded, so parallel requests see one prompt.
    if (current.blocked(url)) throw siteBlocked(site);
    const open = prompts.get(session);
    // Before the approved check: Foxleash must not navigate away from its own live prompt.
    if (open?.tabId === tabId) return join(joinable(open, site), tabId);
    if (current.allowed(url)) return { answer: Promise.resolve(), promptInTab: false };
    refuseIfAnswered(session, site);
    refuseBesideOtherPrompt(session);
    if (open !== undefined) return join(joinable(open, site), tabId);
    return show(session, site, url, tabId, promptUrl);
  }

  function openPrompt(session: string): OpenPrompt | undefined {
    const prompt = prompts.get(session);
    if (prompt === undefined) return undefined;
    const { tabId, site, url } = prompt;
    return { tabId, site, url, waiting: prompt.waiter !== undefined };
  }

  function askedUrl(session: string, tab: Tab): string | undefined {
    const shown = answered.get(tab.id);
    if (shown?.session !== session || tab.url !== shown.promptUrl) return undefined;
    return shown.url;
  }

  function endSession(session: string): void {
    const state = sessions.get(session);
    sessions.delete(session);
    // A session that reconnects with the same id asks again, so nothing from the gap is read.
    for (const site of state?.allowed ?? []) onWithdraw?.(session, site);
    const prompt = prompts.get(session);
    if (prompt !== undefined) drop(prompt, false);
  }

  async function sessionAnswers(): Promise<SessionAnswers[]> {
    // Copied before any await, so the reply shows one moment.
    const held = [...sessions]
      .map(([session, state]) => ({
        session,
        allowed: [...state.allowed].sort(),
        refused: [...state.refused].sort(),
        closed: state.closed,
      }))
      .filter((entry) => entry.allowed.length > 0 || entry.refused.length > 0 || entry.closed > 0);
    return Promise.all(
      held.map(async (entry) => ({ ...entry, label: await labelOf(entry.session) })),
    );
  }

  async function siteStates(
    session: string,
    sites: readonly string[],
  ): Promise<Map<string, SiteState>> {
    const current = await view(session);
    // Read, not stateOf: asking creates no session entry.
    const refused = sessions.get(session)?.refused;
    const states = new Map<string, SiteState>();
    for (const site of sites) {
      if (current.blocked(site)) states.set(site, "blocked");
      else if (current.allowed(site)) states.set(site, "allowed");
      else if (refused?.has(site) === true) states.set(site, "refused");
      else states.set(site, "askable");
    }
    return states;
  }

  async function allowForSession(
    session: string,
    sites: readonly string[],
    stillOpen: () => boolean,
  ): Promise<string[]> {
    const states = await siteStates(session, sites);
    // An ended session's memory must not come back: a session reconnecting with its id asks again.
    if (!stillOpen()) return [];
    const granted: string[] = [];
    for (const site of sites) {
      if (states.get(site) !== "askable" || siteOf(site) !== site || granted.includes(site)) {
        continue;
      }
      stateOf(session).allowed.add(site);
      granted.push(site);
    }
    return granted;
  }

  function forget(session: string, site: string): void {
    const state = sessions.get(session);
    if (state === undefined) return;
    if (site === "closed") state.closed = 0;
    else {
      if (state.allowed.delete(site)) onWithdraw?.(session, site);
      state.refused.delete(site);
    }
    if (state.allowed.size === 0 && state.refused.size === 0 && state.closed === 0) {
      sessions.delete(session);
    }
  }

  async function labelOf(session: string): Promise<string> {
    const group = await groups.groupOf(session);
    const tabs =
      group === undefined
        ? 0
        : (await browser.tabs.query({ groupId: group.id }).catch(() => [])).length;
    if (tabs === 0) return "session with no tabs";
    return tabs === 1 ? "session with 1 tab" : `session with ${tabs} tabs`;
  }

  function webSite(url: string): string {
    const site = siteOf(url);
    if (site === undefined) {
      throw new ToolError("invalid_url", "Foxleash acts only on http and https URLs.");
    }
    return site;
  }

  function refuseIfAnswered(session: string, site: string): void {
    const state = sessions.get(session);
    if (state === undefined) return;
    if (state.refused.has(site)) {
      throw new ToolError(
        "site_refused",
        `The user did not allow Foxleash on ${site} in this session.`,
      );
    }
    refuseIfStoppedAsking(session);
  }

  function refuseIfStoppedAsking(session: string): void {
    const state = sessions.get(session);
    if (state !== undefined && state.refused.size + state.closed >= PROMPT_BUDGET) {
      throw new ToolError(
        "site_refused",
        "Foxleash asks no more in this session after three refused or closed prompts. The user can forget those answers in Foxleash's settings, or start a new session, to be asked again.",
      );
    }
  }

  /** The user is never asked two things at once in one session. */
  function refuseBesideOtherPrompt(session: string): void {
    const page = otherPrompt?.(session);
    if (page !== undefined) throw approvalPending(page.tabId, page.question);
  }

  /** The prompt, when a request for `site` may wait on it. */
  function joinable(prompt: Prompt<Handle>, site: string): Prompt<Handle> {
    if (prompt.site !== site || prompt.waiter !== undefined) {
      throw approvalPending(prompt.tabId, `whether to allow ${prompt.site}`);
    }
    return prompt;
  }

  async function join(prompt: Prompt<Handle>, tabId: number): Promise<Approval> {
    const answer = wait(prompt, tabId);
    // Only attention: activating the tab would move the prompt's buttons under the cursor.
    try {
      const tab = await browser.tabs.get(prompt.tabId);
      await browser.windows.update(tab.windowId, { drawAttention: true });
    } catch {}
    return { answer, promptInTab: prompt.tabId === tabId };
  }

  async function show(
    session: string,
    site: string,
    url: string,
    tabId: number,
    promptUrl: string | undefined,
  ): Promise<Approval> {
    const prompt: Prompt<Handle> = {
      session,
      site,
      url,
      tabId,
      promptUrl: promptUrl ?? newPromptUrl(),
      committed: false,
      port: undefined,
      seen: false,
      answering: false,
      waiter: undefined,
    };
    prompts.set(session, prompt);
    const answer = wait(prompt, tabId);
    let tab: Tab;
    try {
      tab = await browser.tabs.update(
        tabId,
        promptUrl === undefined
          ? { url: prompt.promptUrl, active: true }
          : // Loaded rather than only selected: a prompt page the user selected before the
            // prompt was recorded loads again and connects.
            { url: prompt.promptUrl, active: true, loadReplace: true },
      );
    } catch (error) {
      if (prompts.get(session) === prompt) {
        prompts.delete(session);
        stopWaiting(prompt);
      }
      throw error;
    }
    try {
      await browser.windows.update(tab.windowId, { drawAttention: true });
    } catch {}
    return { answer, promptInTab: true };
  }

  function newPromptUrl(): string {
    return `${browser.runtime.getURL(PROMPT_PAGE)}?id=${crypto.randomUUID()}`;
  }

  function wait(prompt: Prompt<Handle>, tabId: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // A caller that stopped listening must not leave an unhandled rejection behind.
    promise.catch(() => {});
    const waiter: Waiter<Handle> = {
      tabId,
      resolve,
      reject,
      timer: timers.setTimeout(() => timeOut(prompt, waiter), APPROVAL_WAIT_MS),
    };
    prompt.waiter = waiter;
    return promise;
  }

  function timeOut(prompt: Prompt<Handle>, waiter: Waiter<Handle>): void {
    if (prompt.waiter !== waiter) return;
    // The page never showed, perhaps because the user left the tab before it loaded.
    if (!prompt.seen) drop(prompt, false);
    else {
      prompt.waiter = undefined;
      waiter.reject(
        new ToolError(
          "approval_timeout",
          `Foxleash is still asking the user in tab ${prompt.tabId} whether to allow ${prompt.site}. Tell the user to answer there, then make the same tab_open or navigate call again; if the user closed that tab, call tab_open with the page's URL instead.`,
        ),
      );
    }
  }

  /** Takes the waiter off the prompt and stops its clock. */
  function stopWaiting(prompt: Prompt<Handle>): Waiter<Handle> | undefined {
    const waiter = prompt.waiter;
    prompt.waiter = undefined;
    if (waiter !== undefined) timers.clearTimeout(waiter.timer);
    return waiter;
  }

  function connect(port: RuntimePort): void {
    // Other extension pages' ports are theirs to answer.
    if (port.name !== PORT_NAME) return;
    const prompt = promptOf(port);
    if (prompt === undefined) {
      post(port, { type: "ended" });
      try {
        port.disconnect();
      } catch {}
      return;
    }
    prompt.port = port;
    prompt.seen = true;
    prompt.committed = true;
    port.onMessage.addListener((message) => receive(prompt, port, message));
    port.onDisconnect.addListener(() => {
      if (prompt.port === port) prompt.port = undefined;
    });
  }

  /** The open prompt this page shows: this extension's exact prompt URL, in the prompt's tab. */
  function promptOf(port: RuntimePort): Prompt<Handle> | undefined {
    return [...prompts.values()].find((prompt) =>
      portShowsPage(port, browser.runtime.id, PORT_NAME, prompt.promptUrl, prompt.tabId),
    );
  }

  /** Not async: a listener that returns a promise replies, and only the settings page gets one. */
  function receiveFromSettings(
    message: unknown,
    sender: MessageSender,
  ): Promise<unknown> | undefined {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL(OPTIONS_PAGE)) {
      return undefined;
    }
    const fields = fieldsOf(message);
    if (fields?.type === "session_answers") return sessionAnswers();
    if (
      fields?.type === "forget" &&
      typeof fields.session === "string" &&
      typeof fields.site === "string"
    ) {
      forget(fields.session, fields.site);
      return Promise.resolve(true);
    }
    return undefined;
  }

  function receive(prompt: Prompt<Handle>, port: Port, message: unknown): void {
    if (prompt.port !== port || prompts.get(prompt.session) !== prompt) return;
    const fields = fieldsOf(message);
    if (fields?.type === "ready") {
      post(port, { type: "prompt", site: prompt.site, url: prompt.url });
    } else if (fields?.type === "answer" && isAnswer(fields.answer)) {
      void answer(prompt, fields.answer);
    }
  }

  async function answer(prompt: Prompt<Handle>, given: Answer): Promise<void> {
    if (prompt.answering) return;
    prompt.answering = true;
    // The answer is in time even when saving it is slow.
    if (prompt.waiter !== undefined) timers.clearTimeout(prompt.waiter.timer);
    if (given === "always") {
      try {
        // Not added to the session's memory, so a revocation applies to the next request.
        await grantSite(browser, prompt.site);
      } catch {
        if (prompts.get(prompt.session) !== prompt) return;
        prompt.answering = false;
        stopWaiting(prompt)?.reject(
          new ToolError(
            "settings_write_failed",
            `Firefox could not save the user's answer to always allow ${prompt.site}. The question is still open in tab ${prompt.tabId}.`,
          ),
        );
        if (prompt.port !== undefined) post(prompt.port, { type: "error" });
        return;
      }
      // Dropped while saving: the grant stays, as it was the user's click.
      if (prompts.get(prompt.session) !== prompt) return;
    } else if (given === "once") {
      stateOf(prompt.session).allowed.add(prompt.site);
    } else {
      stateOf(prompt.session).refused.add(prompt.site);
    }
    settle(prompt, given);
  }

  function settle(prompt: Prompt<Handle>, given: Answer): void {
    prompts.delete(prompt.session);
    const { session, promptUrl, url } = prompt;
    answered.set(prompt.tabId, { session, promptUrl, url });
    const waiter = stopWaiting(prompt);
    const allowed = given !== "no";
    if (allowed) waiter?.resolve();
    else {
      waiter?.reject(
        new ToolError(
          "site_refused",
          `The user did not allow Foxleash on ${prompt.site} in this session.`,
        ),
      );
    }
    if (prompt.port !== undefined) {
      post(prompt.port, {
        type: "done",
        answer: given,
        loadsHere: allowed && waiter?.tabId === prompt.tabId,
        late: waiter === undefined,
      });
    }
  }

  /** Closes an open prompt without an answer; `counted` charges the session's budget. */
  function drop(prompt: Prompt<Handle>, counted: boolean): void {
    if (prompts.get(prompt.session) !== prompt) return;
    prompts.delete(prompt.session);
    if (counted && prompt.seen && !prompt.answering) stateOf(prompt.session).closed += 1;
    stopWaiting(prompt)?.reject(
      new ToolError(
        "approval_closed",
        `The question whether to allow ${prompt.site} in tab ${prompt.tabId} was closed without an answer.`,
      ),
    );
    if (prompt.port !== undefined) post(prompt.port, { type: "ended" });
  }

  function promptsIn(tabId: number): Prompt<Handle>[] {
    return [...prompts.values()].filter((prompt) => prompt.tabId === tabId);
  }

  function stateOf(session: string): SessionState {
    let state = sessions.get(session);
    if (state === undefined) {
      state = { allowed: new Set(), refused: new Set(), closed: 0 };
      sessions.set(session, state);
    }
    return state;
  }
}

/** Whether the port is this extension's page `name` at exactly `pageUrl`, in tab `tabId`. */
export function portShowsPage(
  port: RuntimePort,
  extensionId: string,
  name: string,
  pageUrl: string,
  tabId: number,
): boolean {
  const sender = port.sender;
  return (
    port.name === name &&
    sender?.id === extensionId &&
    sender.url === pageUrl &&
    sender.tab?.id === tabId
  );
}

/**
 * The refusal while a session's prompt waits for the user; `question` says what is asked, such
 * as "whether to allow https://example.com".
 */
export function approvalPending(tabId: number, question: string): ToolError {
  return new ToolError(
    "approval_pending",
    `Foxleash is waiting for the user to answer in tab ${tabId} ${question}. Try again after the user has answered.`,
  );
}

export function siteBlocked(site: string): ToolError {
  return new ToolError(
    "site_blocked",
    `Foxleash does not act on ${site}: it is on Foxleash's blocklist, which by default lists common financial and health sites.`,
  );
}

/** A page that is reloading can still be attached, and posting to it then throws. */
export function post(port: Port, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {}
}

/** A message's own fields, or undefined when it is not an object. */
export function fieldsOf(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  return { ...message };
}

function isAnswer(value: unknown): value is Answer {
  return value === "once" || value === "always" || value === "no";
}
