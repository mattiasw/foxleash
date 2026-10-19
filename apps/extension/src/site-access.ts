import type { TabInfo } from "@foxhand/protocol";
import type { BrowserApi, Port, RuntimePort, Tab, Timers } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
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

const PORT_NAME = "approve";
// Refused and closed prompts a session may have before Foxhand stops asking.
const PROMPT_BUDGET = 3;

export type Decision =
  | { decision: "allowed" }
  | { decision: "ask" }
  /** Wait on the session's open prompt for the same site, in `tabId`. */
  | { decision: "join"; tabId: number };

export interface Approval {
  /** Resolves when the site may load; rejects with the answer's ToolError. Never unhandled. */
  answer: Promise<void>;
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
  sessions: SessionMemory;
  timers: Timers<Handle>;
}

export interface SiteAccess {
  /** What one session may see, as stored and granted at the time of the call. */
  view(session: string): Promise<SiteView>;
  /**
   * The gate before a load: throws `invalid_url`, `site_blocked`, `site_refused` or
   * `approval_pending`, else says whether the site is allowed, must be asked for, or can join
   * the session's open prompt. Changes nothing.
   */
  check(session: string, url: string): Promise<Decision>;
  /**
   * Asks the user in `tabId` whether the session may load `url`'s site, or joins the session's
   * open prompt for that site. Rejects when it shows nothing; resolves once the prompt is shown.
   */
  ask(session: string, url: string, tabId: number): Promise<Approval>;
  openPrompt(session: string): OpenPrompt | undefined;
  /** The URL the session's answered prompt asked about, while `tab` still shows that prompt. */
  askedUrl(session: string, tab: Tab): string | undefined;
  /** Forgets the session's answers and closes its open prompt. */
  endSession(session: string): void;
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
  sessions,
  timers,
}: SiteAccessDeps<Handle>): SiteAccess {
  // The open prompt of each session; at most one.
  const prompts = new Map<string, Prompt<Handle>>();
  // By tab: the answered prompt each tab shows, so a reload there loads what it asked about.
  const answered = new Map<number, Answered>();

  browser.runtime.onConnect.addListener(connect);
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

  return { view, check, ask, openPrompt, askedUrl, endSession };

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
    const prompt = prompts.get(session);
    if (prompt !== undefined) return { decision: "join", tabId: joinable(prompt, site).tabId };
    return { decision: "ask" };
  }

  async function ask(session: string, url: string, tabId: number): Promise<Approval> {
    const site = webSite(url);
    const current = await view(session);
    // No await from here until the prompt is recorded, so parallel requests see one prompt.
    if (current.blocked(url)) throw siteBlocked(site);
    const open = prompts.get(session);
    // Before the approved check: Foxhand must not navigate away from its own live prompt.
    if (open?.tabId === tabId) return join(joinable(open, site), tabId);
    if (current.allowed(url)) return { answer: Promise.resolve() };
    refuseIfAnswered(session, site);
    if (open !== undefined) return join(joinable(open, site), tabId);
    return show(session, site, url, tabId);
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
    sessions.delete(session);
    const prompt = prompts.get(session);
    if (prompt !== undefined) drop(prompt, false);
  }

  function webSite(url: string): string {
    const site = siteOf(url);
    if (site === undefined) {
      throw new ToolError("invalid_url", "Foxhand acts only on http and https URLs.");
    }
    return site;
  }

  function refuseIfAnswered(session: string, site: string): void {
    const state = sessions.get(session);
    if (state === undefined) return;
    if (state.refused.has(site)) {
      throw new ToolError(
        "site_refused",
        `The user did not allow Foxhand on ${site} in this session.`,
      );
    }
    if (state.refused.size + state.closed >= PROMPT_BUDGET) {
      throw new ToolError(
        "site_refused",
        "Foxhand asks no more in this session after three refused or closed prompts. Start a new session to be asked again.",
      );
    }
  }

  /** The prompt, when a request for `site` may wait on it. */
  function joinable(prompt: Prompt<Handle>, site: string): Prompt<Handle> {
    if (prompt.site !== site || prompt.waiter !== undefined) {
      throw approvalPending(prompt.tabId, prompt.site);
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
    return { answer };
  }

  async function show(
    session: string,
    site: string,
    url: string,
    tabId: number,
  ): Promise<Approval> {
    const prompt: Prompt<Handle> = {
      session,
      site,
      url,
      tabId,
      promptUrl: `${browser.runtime.getURL(PROMPT_PAGE)}?id=${crypto.randomUUID()}`,
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
      tab = await browser.tabs.update(tabId, { url: prompt.promptUrl, active: true });
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
    return { answer };
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
          `Foxhand is still asking the user in tab ${prompt.tabId} whether to allow ${prompt.site}. Tell the user to answer there, then call navigate with tab ${prompt.tabId} and action reload.`,
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
    const sender = port.sender;
    if (port.name !== PORT_NAME || sender?.id !== browser.runtime.id) return undefined;
    return [...prompts.values()].find(
      (prompt) => prompt.promptUrl === sender.url && sender.tab?.id === prompt.tabId,
    );
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
          `The user did not allow Foxhand on ${prompt.site} in this session.`,
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

/** The refusal while a session's prompt waits for the user. */
export function approvalPending(tabId: number, site: string): ToolError {
  return new ToolError(
    "approval_pending",
    `Foxhand is waiting for the user to answer in tab ${tabId} whether to allow ${site}. Try again after the user has answered.`,
  );
}

export function siteBlocked(site: string): ToolError {
  return new ToolError(
    "site_blocked",
    `Foxhand does not act on ${site}: it is on Foxhand's blocklist, which by default lists common financial and health sites.`,
  );
}

/** A page that is reloading can still be attached, and posting to it then throws. */
function post(port: Port, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {}
}

/** A message's own fields, or undefined when it is not an object. */
function fieldsOf(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  return { ...message };
}

function isAnswer(value: unknown): value is Answer {
  return value === "once" || value === "always" || value === "no";
}
