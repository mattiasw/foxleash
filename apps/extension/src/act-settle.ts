import {
  ACT_QUIET_MS,
  ACT_RESPONSE_WAIT_MS,
  ACT_SETTLE_CAP_MS,
  type ActAfter,
  type ActPage,
} from "@foxleash/protocol";
import type { BrowserApi, Tab, Timers } from "./browser-api.ts";
import { type FileGuard, MAX_REFUSALS } from "./file-guard.ts";
import { NAVIGATION_WAIT_MS } from "./handlers.ts";
import type { NetworkLog } from "./network-log.ts";
import { isRecord, ownField } from "./page-messages.ts";
import { PAGE_REQUEST_MS, type PageScripts } from "./page-scripts.ts";
import { ARIA_ROLES, MAX_FIELD_CHARS } from "./page-tree.ts";
import type { SessionGroups } from "./session-groups.ts";
import type { SiteAccess } from "./site-access.ts";
import type { NavigationOutcome, TabNavigations } from "./tab-navigations.ts";

/** How long the page must show no change, with no request it began after the act open. */
export const QUIET_MS = ACT_QUIET_MS;
/** After a fetch the page began after the act answers, the longest the settle waits for a change. */
export const RESPONSE_WAIT_MS = ACT_RESPONSE_WAIT_MS;
/** The longest the settle polls the page, from the act's reply. */
export const SETTLE_CAP_MS = ACT_SETTLE_CAP_MS;
/** The shortest gap between two polls. */
export const POLL_MS = 50;
/** The quiet path never ends sooner after the reply: a link click starts its load a turn later. */
export const MIN_SETTLE_MS = 50;
/**
 * The act's page request answers within PAGE_REQUEST_MS (55 s), and the settle is raced with a
 * deadline of PAGE_REQUEST_MS from the call's start, so the whole act call answers within 55 s
 * plus building the result: below the host's 60 s request timeout, with the same 5 s margin as
 * every page request. Without the deadline the settle alone could take SETTLE_CAP_MS +
 * NAVIGATION_WAIT_MS plus one poll raced with the cap.
 */
const DEADLINE_MS = PAGE_REQUEST_MS;
/** The longest watch id the background passes back to the page. */
const MAX_WATCH_ID = 64;

export interface ActSettleDeps<Handle> {
  browser: Pick<BrowserApi, "tabs">;
  groups: Pick<SessionGroups, "groupOf">;
  access: Pick<SiteAccess, "view">;
  timers: Timers<Handle>;
  navigations: Pick<TabNavigations, "begun" | "settled">;
  network: Pick<NetworkLog, "requestsSince">;
  /** What the file guard refused in each tab. */
  files: Pick<FileGuard, "refusedSince">;
  pages: Pick<PageScripts, "request">;
  /** The epoch clock webRequest's timeStamp is compared with: Date.now in the background. */
  now: () => number;
}

export interface ActSettle {
  /** Starts watching an act in the tab: call it at the start of the tool call. */
  begin(session: string, tabId: number, generation: number): ActWatch;
}

export interface ActWatch {
  /** Right before the act's message is sent (pages.request's onSend); synchronous. */
  sent(): void;
  /** After the act's checked reply: waits for the page to settle; never rejects. */
  after(reply: unknown): Promise<ActAfter>;
  /** Clears the watch's timers; call it in a finally, also when the act failed. */
  stop(): void;
}

/** What the page and the tab looked like right before the act's message went out. */
interface Snapshot {
  begun: number;
  since: number;
  /** The ids of the group's tabs, or undefined when they could not be listed. */
  tabs: Promise<number[] | undefined> | undefined;
}

/** The last poll that found the act's watch. */
interface Poll {
  changes: number;
  /** Since the page last changed or a request it began after the act last ended. */
  quietMs: number;
  open: number;
}

/** How the settle ended: `withUrl` asks for the tab's address. */
interface Ending {
  page: ActPage;
  withUrl?: boolean;
}

const DEADLINE = Symbol("deadline");
const CAP = Symbol("cap");
const FAILED = Symbol("failed");

export function createActSettle<Handle>(deps: ActSettleDeps<Handle>): ActSettle {
  const { browser, groups, access, timers, navigations, network, files, pages, now } = deps;
  return { begin };

  function begin(session: string, tabId: number, generation: number): ActWatch {
    const started: Handle[] = [];
    let expired = false;
    const deadline = Promise.withResolvers<typeof DEADLINE>();
    startTimer(DEADLINE_MS, () => {
      expired = true;
      deadline.resolve(DEADLINE);
    });
    let groupId: number | undefined;
    groups.groupOf(session).then(
      (group) => {
        groupId = group?.id;
      },
      () => undefined,
    );
    let snapshot: Snapshot | undefined;
    return { sent, after, stop };

    function sent(): void {
      snapshot = { begun: navigations.begun(tabId), since: now(), tabs: groupTabs() };
    }

    /**
     * The group's tab ids, asked for at once: before the act's message when called from `sent`.
     * The executor runs synchronously, and turns a throw into a rejection.
     */
    function groupTabs(): Promise<number[] | undefined> | undefined {
      if (groupId === undefined) return undefined;
      const query = { groupId };
      return new Promise<Tab[]>((resolve) => resolve(browser.tabs.query(query))).then(
        (tabs) => tabs.map((tab) => tab.id),
        () => undefined,
      );
    }

    async function after(reply: unknown): Promise<ActAfter> {
      const element = elementOf(reply);
      const result: ActAfter = { page: "unknown" };
      if (element !== undefined) result.element = element;
      const before = snapshot;
      if (before === undefined) return result;
      const ending = await settle(before, watchOf(reply));
      result.page = ending.page;
      if (ending.withUrl === true && !expired) {
        const url = await raced(urlOf().catch(() => undefined));
        if (url !== DEADLINE && url !== undefined) result.url = url;
      }
      const opened = expired ? undefined : await raced(openedSince(before));
      if (opened !== DEADLINE && opened !== undefined && opened.length > 0) {
        result.openedTabs = opened;
      }
      const refused = refusedSince(before, result.openedTabs ?? []);
      if (refused.length > 0) result.refusedFiles = refused;
      if (ending.page !== "loaded" && ending.page !== "loading") {
        const { begun } = network.requestsSince(tabId, before.since);
        if (begun > 0) result.requests = begun;
      }
      return result;
    }

    /** Waits for the page after the act, raced with the cap and the deadline. */
    async function settle(before: Snapshot, watch: string | undefined): Promise<Ending> {
      const cap = Promise.withResolvers<typeof CAP>();
      let capped = false;
      const capTimer = startTimer(SETTLE_CAP_MS, () => {
        capped = true;
        cap.resolve(CAP);
      });
      let early = true;
      const earlyTimer = startTimer(MIN_SETTLE_MS, () => {
        early = false;
      });
      let pauseTimer: Handle | undefined;
      let seen = before.begun;
      let stepped = false;
      let last: Poll | undefined;
      try {
        for (;;) {
          if (expired) return atDeadline(before, last);
          if (navigations.begun(tabId) > seen) {
            // A second navigation after the one waited for.
            if (stepped) return { page: "loading" };
            stepped = true;
            const step = await raced(navigations.settled(tabId, NAVIGATION_WAIT_MS));
            if (step === DEADLINE) continue;
            seen = navigations.begun(tabId);
            const ending = NAVIGATION_ENDINGS[step];
            if (ending !== undefined) return ending;
            continue;
          }
          if (capped) return atCap(last);
          if (watch === undefined) return { page: "unknown" };
          const asked = now();
          const poll = await raced(
            pages.request(session, tabId, "page_changes", { watch }, generation).then(
              (answer) => answer,
              () => FAILED,
            ),
            cap.promise,
          );
          if (poll === DEADLINE || poll === CAP) continue;
          if (poll === FAILED) {
            if (navigations.begun(tabId) <= before.begun) return { page: "unknown" };
            // The navigation step first; once it ran, the new document refused the poll.
            if (!stepped) continue;
            return { page: "loaded", withUrl: true };
          }
          const read = readOf(poll);
          if (read === "other") return { page: "loaded", withUrl: true };
          if (read === undefined || read === "superseded") return { page: "unknown" };
          const { open, lastEnd, lastFetchEnd } = network.requestsSince(tabId, before.since);
          const at = now();
          // A page shows what a request brought only after the request ended.
          const quietMs =
            lastEnd === undefined ? read.quietMs : Math.min(read.quietMs, at - lastEnd);
          last = { changes: read.changes, quietMs, open };
          // Some pages show a fetch's answer only in a timer of their own: while the page has not
          // changed since the answer, wait until it read itself RESPONSE_WAIT_MS after it, which is
          // after `asked`. With no change, quietMs counts from the watch's start, which a fetch that
          // answers at once can trail by less than the poll's return trip.
          const answered = lastFetchEnd ?? Number.NEGATIVE_INFINITY;
          const sinceAnswer = at - answered;
          const awaiting =
            asked - answered < RESPONSE_WAIT_MS &&
            (read.changes === 0 || read.quietMs >= sinceAnswer);
          if (!awaiting && quietMs >= QUIET_MS && open === 0 && !early) {
            return { page: read.changes > 0 ? "changed" : "unchanged" };
          }
          const { promise: paused, resolve } = Promise.withResolvers<void>();
          // A pause the cap or the deadline cut short is cleared below.
          const pause = awaiting ? POLL_MS : Math.max(QUIET_MS - quietMs, POLL_MS);
          pauseTimer = startTimer(pause, resolve);
          await raced(paused, cap.promise);
        }
      } finally {
        timers.clearTimeout(capTimer);
        timers.clearTimeout(earlyTimer);
        if (pauseTimer !== undefined) timers.clearTimeout(pauseTimer);
      }
    }

    /** The promise's value, or DEADLINE once the deadline passed first; `cap` also wins. */
    function raced<T, C = never>(
      promise: Promise<T>,
      cap?: Promise<C>,
    ): Promise<T | typeof DEADLINE | C> {
      if (expired) return Promise.resolve(DEADLINE);
      const racers: Promise<T | typeof DEADLINE | C>[] = [promise, deadline.promise];
      if (cap !== undefined) racers.push(cap);
      return Promise.race(racers);
    }

    /** The tab's address as tabs_list shows it, while the tab is in the session's group. */
    async function urlOf(): Promise<string | undefined> {
      const tab = await browser.tabs.get(tabId);
      const group = await groups.groupOf(session);
      if (group === undefined || tab.groupId !== group.id) return undefined;
      return (await access.view(session)).tabInfo(tab).url;
    }

    /** The ids of the group's tabs now that were not in it right before the act, sorted. */
    async function openedSince(before: Snapshot): Promise<number[] | undefined> {
      const earlier = await before.tabs;
      if (earlier === undefined) return undefined;
      const now = await groupTabs();
      if (now === undefined) return undefined;
      return now.filter((id) => !earlier.includes(id)).sort((a, b) => a - b);
    }

    /**
     * The sites of what the file guard refused since the act, in the tab and in the tabs the act
     * opened: a link that opens a tab has its file refused there. Each site once.
     */
    function refusedSince(before: Snapshot, opened: readonly number[]): string[] {
      const sites = [tabId, ...opened].flatMap((id) => files.refusedSince(id, before.since));
      return [...new Set(sites)].slice(0, MAX_REFUSALS);
    }

    /** Clears every timer the watch started; clearing one that already ran does nothing. */
    function stop(): void {
      for (const timer of started) timers.clearTimeout(timer);
    }

    function startTimer(ms: number, callback: () => void): Handle {
      const timer = timers.setTimeout(callback, ms);
      started.push(timer);
      return timer;
    }

    /** What is known when the deadline passes: nothing more is awaited. */
    function atDeadline(before: Snapshot, last: Poll | undefined): Ending {
      if (navigations.begun(tabId) > before.begun) return { page: "loading" };
      return atCap(last);
    }
  }
}

/**
 * The ending a finished wait for a navigation gives. None for idle or ended (a 204, a download, a
 * page from the back-forward cache): the page's own check follows.
 */
const NAVIGATION_ENDINGS: Partial<Record<NavigationOutcome, Ending>> = {
  ready: { page: "loaded", withUrl: true },
  committed: { page: "loading", withUrl: true },
  timeout: { page: "loading" },
  removed: { page: "closed" },
};

/** The outcome at the cap, from the last poll that found the watch. */
function atCap(last: Poll | undefined): Ending {
  if (last === undefined) return { page: "unknown" };
  if (last.quietMs < QUIET_MS || last.open > 0) return { page: "unsettled" };
  return { page: last.changes > 0 ? "changed" : "unchanged" };
}

/**
 * The element in the act's reply, which comes from the page's content process: own fields only, a
 * role read_page can show and a name no longer than read_page's cut.
 */
function elementOf(reply: unknown): { role: string; name: string } | undefined {
  if (!isRecord(reply)) return undefined;
  const element = ownField(reply, "element");
  if (!isRecord(element)) return undefined;
  const role = ownField(element, "role");
  const name = ownField(element, "name");
  if (typeof role !== "string" || !ARIA_ROLES.has(role)) return undefined;
  // The cut keeps MAX_FIELD_CHARS characters and adds an ellipsis.
  if (typeof name !== "string" || name.length > MAX_FIELD_CHARS + 1) return undefined;
  return { role, name };
}

function watchOf(reply: unknown): string | undefined {
  if (!isRecord(reply)) return undefined;
  const watch = ownField(reply, "watch");
  return typeof watch === "string" && watch.length <= MAX_WATCH_ID ? watch : undefined;
}

/** A page_changes answer: the read of the act's watch, or undefined when it cannot be read. */
function readOf(
  answer: unknown,
): { changes: number; quietMs: number } | "superseded" | "other" | undefined {
  if (!isRecord(answer)) return undefined;
  const state = ownField(answer, "state");
  if (state === "superseded" || state === "other") return state;
  if (state !== "current") return undefined;
  const changes = ownField(answer, "changes");
  const quietMs = ownField(answer, "quietMs");
  if (typeof changes !== "number" || !Number.isSafeInteger(changes) || changes < 0) {
    return undefined;
  }
  if (typeof quietMs !== "number" || !Number.isFinite(quietMs) || quietMs < 0) return undefined;
  return { changes, quietMs };
}
