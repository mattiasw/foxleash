import { MAX_TAB_TITLE, MAX_TAB_URL, type TabInfo } from "@foxleash/protocol";
import type { BrowserApi, MessageSender, Port, RuntimePort, Tab, Timers } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { capText } from "./page-messages.ts";
import type { SessionGroups } from "./session-groups.ts";
import { effectiveBlocklist, grantSite, readSettings } from "./settings.ts";
import { hasPlainHost, hostOf, MAX_SITE_HOST, matchesDomain, redactedUrl, siteOf } from "./site.ts";

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
/** How long after a question's window was shown Foxleash checks that it is in front. */
export const FRONT_CHECK_MS = 2_000;
/** The extension page that asks the user. */
export const PROMPT_PAGE = "approve.html";
/** The settings page, the only page that may read or forget session answers. */
export const OPTIONS_PAGE = "options.html";

const PORT_NAME = "approve";
// Refused and closed prompts a session may have before Foxleash stops asking.
const PROMPT_BUDGET = 3;

/** The check whether a shown question's window is in front, from arming until it runs. */
export interface FrontCheck<Handle> {
  windowId: number;
  /** Its delay; undefined once the delay passed while the page had not connected. */
  timer: Handle | undefined;
}

/** What a session may do with a site: load it, never, never in this session, or ask the user. */
export type SiteState = "allowed" | "blocked" | "refused" | "askable";

/**
 * Why a session's approval of a site ended: the user withdrew it, the session ended, or the user
 * stopped the session.
 */
export type WithdrawCause = "forget" | "end" | "stop";

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
  groups: Pick<SessionGroups, "groupOf" | "showPromptWindow" | "windowInFront">;
  sessions: SessionMemory;
  timers: Timers<Handle>;
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
   * Whether the URL's site is on the effective blocklist, as stored at the time of the call. It
   * takes no session, so a session the user stopped does not change it. Rejects when the
   * settings cannot be read.
   */
  blocklisted(url: string): Promise<boolean>;
  /**
   * The gate before a load: throws `invalid_url`, `site_blocked`, `site_refused` or
   * `approval_pending` (also while the session's recipe page is open), else says whether the
   * site is allowed, must be asked for, or can join the session's open prompt. Changes nothing.
   */
  check(session: string, url: string): Promise<Decision>;
  /**
   * Asks the user in `tabId` whether the session may load `url`'s site, or joins the session's
   * open prompt for that site. Rejects when it shows nothing; resolves once the prompt is shown.
   * `options.generation` is `generation(session)` as read when the request was dispatched; when
   * the session ended since, it rejects with `approval_closed`, showing and recording nothing.
   * With `options.promptUrl` (from `newPromptUrl`), the tab was created unloaded on that URL, and
   * the prompt is loaded in place of the tab's one history entry.
   */
  ask(
    session: string,
    url: string,
    tabId: number,
    options: { generation: number; promptUrl?: string },
  ): Promise<Approval>;
  /** How often the session has ended; a request reads it on arrival and passes it to `ask`. */
  generation(session: string): number;
  /** A new, unique URL for a prompt page, for a tab created on it before `ask` shows it there. */
  newPromptUrl(): string;
  openPrompt(session: string): OpenPrompt | undefined;
  /** The URL the session's answered prompt asked about, while `tab` still shows that prompt. */
  askedUrl(session: string, tab: Tab): string | undefined;
  /**
   * Forgets the session's answers, closes its open prompt and lists it as running no more. A
   * stopped session stays stopped.
   */
  endSession(session: string): void;
  /**
   * Records the session as running, until `endSession`, numbered in the order sessions started.
   * Throws `session_stopped` when the user stopped it. Called on each request's arrival.
   */
  admit(session: string): void;
  /**
   * The user's click on the settings page: from now on every gate refuses the session with
   * `session_stopped`, also on sites allowed always. Drops its open prompt uncounted, forgets its
   * answers and calls the `onStop` listeners. Nothing undoes it; a second stop does nothing.
   */
  stop(session: string): void;
  /** Whether the user stopped the session. */
  stopped(session: string): boolean;
  /**
   * True from the session's `admit` until its `endSession`. A session the user stopped counts as
   * running until it ends, and again after an `admit`, which records it before refusing it.
   */
  running(session: string): boolean;
  /** Each running session, and any other that holds answers, with its answers, sites sorted. */
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
  /**
   * Calls `listener` each time the session's approval of a site ends, with the cause: `"forget"`
   * when the user withdrew it, `"end"` when the session ended, `"stop"` when the user stopped it.
   * Synchronously, at the end of `forget`, `endSession` or `stop`, in the order added.
   */
  onWithdraw(listener: (session: string, site: string, cause: WithdrawCause) => void): void;
  /**
   * Calls `listener` once per session the user stops, synchronously at the end of `stop`, in the
   * order added. Covers sites allowed always, which `onWithdraw` never reports.
   */
  onStop(listener: (session: string) => void): void;
  /**
   * Calls `listener` each time the session starts or stops running, as `running` reports it:
   * synchronously in `admit` when it records a session that was not running (also one the user
   * stopped, before `admit` refuses it), and at the end of `endSession` for a session that was
   * running, in the order added. Not on an `admit` of a running session, nor on `endSession` of
   * one that is not running.
   */
  onRunningChange(listener: (session: string) => void): void;
  /**
   * Calls `listener` each time the session gains a site by the user's click: a prompt answered
   * once, or always once the answer is saved, and each site `allowForSession` grants.
   * Synchronously, at the end of `answer` or `allowForSession`, in the order added. A stored grant
   * reaches every session: storage changes tell the others.
   */
  onGrant(listener: (session: string, site: string) => void): void;
}

/** What the settings page lists for one session. */
export interface SessionAnswers {
  session: string;
  /** The session as the user can recognize it: by the tabs in its group. */
  label: string;
  allowed: string[];
  refused: string[];
  closed: number;
  /** The user stopped this session; it holds no answers. */
  stopped: boolean;
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
  front: FrontCheck<Handle> | undefined;
}

export function createSiteAccess<Handle>({
  browser,
  groups,
  sessions,
  timers,
  otherPrompt,
}: SiteAccessDeps<Handle>): SiteAccess {
  // The open prompt of each session; at most one.
  const prompts = new Map<string, Prompt<Handle>>();
  // By tab: the answered prompt each tab shows, so a reload there loads what it asked about.
  const answered = new Map<number, Answered>();
  // By session: how often it ended, so a request that was running when it ended shows no prompt.
  const generations = new Map<string, number>();
  const withdrawals = new Set<(session: string, site: string, cause: WithdrawCause) => void>();
  const grants = new Set<(session: string, site: string) => void>();
  const stops = new Set<(session: string) => void>();
  const runningChanges = new Set<(session: string) => void>();
  // Sessions the user stopped, for the background page's life: `endSession` keeps them.
  const stoppedSessions = new Set<string>();
  // Each running session's number, given at its first `admit`.
  const runningSessions = new Map<string, number>();
  let admitted = 0;

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
    blocklisted,
    check,
    ask,
    generation: generationOf,
    newPromptUrl,
    openPrompt,
    askedUrl,
    endSession,
    admit,
    stop,
    stopped: isStopped,
    running: isRunning,
    sessionAnswers,
    siteStates,
    allowForSession,
    refuseIfStoppedAsking,
    forget,
    onWithdraw,
    onStop,
    onRunningChange,
    onGrant,
  };

  async function view(session: string): Promise<SiteView> {
    const settings = await readSettings(browser);
    // After the only await, so a stop before or during the read is seen.
    if (stoppedSessions.has(session)) throw sessionStopped();
    const stored = new Set(settings.sites);
    const blocklist = effectiveBlocklist(settings);
    const granted = sessions.get(session);
    const blocked = (url: string): boolean => onBlocklist(blocklist, url);
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
        return {
          id: tab.id,
          url: shownTabText(url, MAX_TAB_URL),
          title: shownTabText(title, MAX_TAB_TITLE),
          active: tab.active,
        };
      }
      const shownUrl = shownTabText(redactedUrl(tab.url), MAX_TAB_URL);
      return { id: tab.id, url: shownUrl, title: "", active: tab.active };
    };
    return { blocked, allowed, tabInfo };
  }

  async function blocklisted(url: string): Promise<boolean> {
    return onBlocklist(effectiveBlocklist(await readSettings(browser)), url);
  }

  async function check(session: string, url: string): Promise<Decision> {
    const site = webSite(url);
    const current = await view(session);
    if (current.blocked(url)) throw siteBlocked(site);
    if (current.allowed(url)) return { decision: "allowed" };
    refuseIfNotPlain(site);
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
    options: { generation: number; promptUrl?: string },
  ): Promise<Approval> {
    const site = webSite(url);
    const current = await view(session);
    // The session ended since the request was dispatched: an answer would give the ended session
    // an approval that a reconnect with its id finds.
    if (generationOf(session) !== options.generation) {
      throw new ToolError(
        "approval_closed",
        `The session ended before Foxleash could ask whether to allow ${site}.`,
      );
    }
    // No await from here until the prompt is recorded, so parallel requests see one prompt.
    if (current.blocked(url)) throw siteBlocked(site);
    const open = prompts.get(session);
    // Before the approved check: Foxleash must not navigate away from its own live prompt.
    if (open?.tabId === tabId) return join(joinable(open, site), tabId, options.generation);
    if (current.allowed(url)) return { answer: Promise.resolve(), promptInTab: false };
    refuseIfNotPlain(site);
    refuseIfAnswered(session, site);
    refuseBesideOtherPrompt(session);
    if (open !== undefined) return join(joinable(open, site), tabId, options.generation);
    return show(session, site, url, tabId, options.promptUrl, options.generation);
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
    generations.set(session, generationOf(session) + 1);
    const state = sessions.get(session);
    sessions.delete(session);
    const wasRunning = runningSessions.delete(session);
    const prompt = prompts.get(session);
    if (prompt !== undefined) drop(prompt, false);
    // A session that reconnects with the same id asks again for these sites. Its documents on
    // every site stop being live through the running-change listeners.
    for (const site of state?.allowed ?? []) withdrawn(session, site, "end");
    if (wasRunning) runningChanged(session);
  }

  function admit(session: string): void {
    if (!runningSessions.has(session)) {
      admitted += 1;
      runningSessions.set(session, admitted);
      runningChanged(session);
    }
    if (stoppedSessions.has(session)) throw sessionStopped();
  }

  function stop(session: string): void {
    if (stoppedSessions.has(session)) return;
    stoppedSessions.add(session);
    const state = sessions.get(session);
    sessions.delete(session);
    const prompt = prompts.get(session);
    if (prompt !== undefined) drop(prompt, false, sessionStopped());
    for (const site of state?.allowed ?? []) withdrawn(session, site, "stop");
    for (const listener of stops) listener(session);
  }

  function isStopped(session: string): boolean {
    return stoppedSessions.has(session);
  }

  function isRunning(session: string): boolean {
    return runningSessions.has(session);
  }

  function generationOf(session: string): number {
    return generations.get(session) ?? 0;
  }

  async function sessionAnswers(): Promise<SessionAnswers[]> {
    // Copied before any await, so the reply shows one moment.
    const ids = new Set([...runningSessions.keys(), ...sessions.keys()]);
    const held = [...ids]
      .map((session) => {
        const state = sessions.get(session);
        return {
          session,
          allowed: [...(state?.allowed ?? [])].sort(),
          refused: [...(state?.refused ?? [])].sort(),
          closed: state?.closed ?? 0,
          stopped: stoppedSessions.has(session),
        };
      })
      .filter(
        (entry) =>
          runningSessions.has(entry.session) ||
          entry.allowed.length > 0 ||
          entry.refused.length > 0 ||
          entry.closed > 0,
      );
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
      if (
        states.get(site) !== "askable" ||
        siteOf(site) !== site ||
        !hasPlainHost(site) ||
        granted.includes(site)
      ) {
        continue;
      }
      stateOf(session).allowed.add(site);
      granted.push(site);
    }
    for (const site of granted) grantedSite(session, site);
    return granted;
  }

  function forget(session: string, site: string): void {
    const state = sessions.get(session);
    if (state === undefined) return;
    let ended = false;
    if (site === "closed") state.closed = 0;
    else {
      ended = state.allowed.delete(site);
      state.refused.delete(site);
    }
    if (state.allowed.size === 0 && state.refused.size === 0 && state.closed === 0) {
      sessions.delete(session);
    }
    if (ended) withdrawn(session, site, "forget");
  }

  function onWithdraw(
    listener: (session: string, site: string, cause: WithdrawCause) => void,
  ): void {
    withdrawals.add(listener);
  }

  function withdrawn(session: string, site: string, cause: WithdrawCause): void {
    for (const listener of withdrawals) listener(session, site, cause);
  }

  function onStop(listener: (session: string) => void): void {
    stops.add(listener);
  }

  function onRunningChange(listener: (session: string) => void): void {
    runningChanges.add(listener);
  }

  function runningChanged(session: string): void {
    for (const listener of runningChanges) listener(session);
  }

  function onGrant(listener: (session: string, site: string) => void): void {
    grants.add(listener);
  }

  function grantedSite(session: string, site: string): void {
    for (const listener of grants) listener(session, site);
  }

  async function labelOf(session: string): Promise<string> {
    // Read before the awaits: the session may end while its tabs are counted.
    const number = runningSessions.get(session);
    const name = number === undefined ? "session" : `session ${number}`;
    const group = await groups.groupOf(session);
    const tabs =
      group === undefined
        ? 0
        : (await browser.tabs.query({ groupId: group.id }).catch(() => [])).length;
    if (tabs === 0) return `${name} with no tabs`;
    return tabs === 1 ? `${name} with 1 tab` : `${name} with ${tabs} tabs`;
  }

  function webSite(url: string): string {
    const site = siteOf(url);
    if (site === undefined) {
      throw new ToolError("invalid_url", "Foxleash acts only on http and https URLs.");
    }
    return site;
  }

  function refuseIfNotPlain(site: string): void {
    if (hasPlainHost(site)) return;
    throw new ToolError(
      "invalid_url",
      `Foxleash asks only about a site whose host is a domain name or an IP address, at most ${MAX_SITE_HOST} characters long.`,
    );
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
    if (stoppedSessions.has(session)) throw sessionStopped();
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

  async function join(
    prompt: Prompt<Handle>,
    tabId: number,
    generation: number,
  ): Promise<Approval> {
    const { answer } = wait(prompt, tabId);
    // Only attention: activating the tab would move the prompt's buttons under the cursor.
    try {
      const tab = await browser.tabs.get(prompt.tabId);
      if (!stoppedSessions.has(prompt.session) && generationOf(prompt.session) === generation) {
        await browser.windows.update(tab.windowId, { drawAttention: true });
      }
    } catch {}
    return { answer, promptInTab: prompt.tabId === tabId };
  }

  async function show(
    session: string,
    site: string,
    url: string,
    tabId: number,
    promptUrl: string | undefined,
    generation: number,
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
    const { answer, waiter } = wait(prompt, tabId);
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
    // Stopped or ended while the page loaded: no window comes to the front for it.
    const wanted = () => !stoppedSessions.has(session) && generationOf(session) === generation;
    await groups.showPromptWindow(session, tab.windowId, wanted);
    if (
      wanted() &&
      prompts.get(session) === prompt &&
      prompt.waiter === waiter &&
      !prompt.answering
    ) {
      armFront(prompt, waiter, tab.windowId);
    }
    return { answer, promptInTab: true };
  }

  function newPromptUrl(): string {
    return `${browser.runtime.getURL(PROMPT_PAGE)}?id=${crypto.randomUUID()}`;
  }

  function wait(
    prompt: Prompt<Handle>,
    tabId: number,
  ): { answer: Promise<void>; waiter: Waiter<Handle> } {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // A caller that stopped listening must not leave an unhandled rejection behind.
    promise.catch(() => {});
    const waiter: Waiter<Handle> = {
      tabId,
      resolve,
      reject,
      timer: timers.setTimeout(() => timeOut(prompt, waiter), APPROVAL_WAIT_MS),
      front: undefined,
    };
    prompt.waiter = waiter;
    return { answer: promise, waiter };
  }

  function armFront(prompt: Prompt<Handle>, waiter: Waiter<Handle>, windowId: number): void {
    waiter.front = {
      windowId,
      timer: timers.setTimeout(() => frontDue(prompt, waiter), FRONT_CHECK_MS),
    };
  }

  function frontDue(prompt: Prompt<Handle>, waiter: Waiter<Handle>): void {
    if (prompt.waiter !== waiter || waiter.front === undefined) return;
    waiter.front.timer = undefined;
    // A page that has not connected yet runs the check from `connect`.
    if (prompt.seen) void checkFront(prompt, waiter);
  }

  async function checkFront(prompt: Prompt<Handle>, waiter: Waiter<Handle>): Promise<void> {
    const front = waiter.front;
    if (front === undefined) return;
    waiter.front = undefined;
    const inFront = await groups.windowInFront(front.windowId);
    if (
      inFront ||
      prompts.get(prompt.session) !== prompt ||
      prompt.waiter !== waiter ||
      prompt.answering
    ) {
      return;
    }
    stopWaiting(prompt);
    waiter.reject(
      new ToolError(
        "approval_timeout",
        `Foxleash is asking the user in tab ${prompt.tabId} whether to allow ${prompt.site}, but that tab's Firefox window is not in front, so the user may not have seen the question. Tell the user to answer it in Firefox, then make the same tab_open or navigate call again; if the user closed that tab, call tab_open with the page's URL instead.`,
      ),
    );
  }

  function timeOut(prompt: Prompt<Handle>, waiter: Waiter<Handle>): void {
    if (prompt.waiter !== waiter) return;
    // The page never showed, perhaps because the user left the tab before it loaded.
    if (!prompt.seen) drop(prompt, false);
    else {
      stopWaiting(prompt);
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
    if (waiter !== undefined) {
      timers.clearTimeout(waiter.timer);
      stopFront(waiter);
    }
    return waiter;
  }

  function stopFront(waiter: Waiter<Handle>): void {
    if (waiter.front?.timer !== undefined) timers.clearTimeout(waiter.front.timer);
    waiter.front = undefined;
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
    if (prompt.waiter?.front !== undefined && prompt.waiter.front.timer === undefined) {
      void checkFront(prompt, prompt.waiter);
    }
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
    if (fields?.type === "stop" && typeof fields.session === "string") {
      stop(fields.session);
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
    if (prompt.waiter !== undefined) {
      timers.clearTimeout(prompt.waiter.timer);
      stopFront(prompt.waiter);
    }
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
      settle(prompt, given);
      grantedSite(prompt.session, prompt.site);
    } else if (given === "once") {
      const { allowed } = stateOf(prompt.session);
      const fresh = !allowed.has(prompt.site);
      allowed.add(prompt.site);
      settle(prompt, given);
      if (fresh) grantedSite(prompt.session, prompt.site);
    } else {
      stateOf(prompt.session).refused.add(prompt.site);
      settle(prompt, given);
    }
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

  /**
   * Closes an open prompt without an answer; `counted` charges the session's budget. The waiting
   * request gets `error`, by default `approval_closed`.
   */
  function drop(prompt: Prompt<Handle>, counted: boolean, error?: ToolError): void {
    if (prompts.get(prompt.session) !== prompt) return;
    prompts.delete(prompt.session);
    if (counted && prompt.seen && !prompt.answering) stateOf(prompt.session).closed += 1;
    stopWaiting(prompt)?.reject(
      error ??
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

function onBlocklist(blocklist: readonly string[], url: string): boolean {
  const site = siteOf(url);
  if (site === undefined) return false;
  const host = hostOf(site);
  return blocklist.some((pattern) => matchesDomain(host, pattern));
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

export function sessionStopped(): ToolError {
  return new ToolError(
    "session_stopped",
    "The user stopped this agent session in Firefox. Foxleash refuses every tool call of this session from now on: stop the browser task and tell the user.",
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

/** Page text in a tab's TabInfo, cut to `max` UTF-16 units and ending with … when cut. */
function shownTabText(text: string, max: number): string {
  const cut = capText(text, max);
  return cut.truncated ? `${cut.text}…` : cut.text;
}

function isAnswer(value: unknown): value is Answer {
  return value === "once" || value === "always" || value === "no";
}
