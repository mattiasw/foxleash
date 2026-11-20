import type {
  BrowserApi,
  Cancel,
  CompletedDetails,
  CreatedNavigationTargetDetails,
  DownloadItem,
  ErrorDetails,
  HeadersReceivedDetails,
  HttpHeader,
  NavigationDetails,
  RequestDetails,
  Tab,
  TabChangeInfo,
} from "./browser-api.ts";
import { warn } from "./log.ts";
import { MAX_REMEMBERED_GROUPS, type SessionGroups } from "./session-groups.ts";
import { redactedUrl, siteOf, withoutFragment } from "./site.ts";
import type { SiteAccess, SiteView, WithdrawCause } from "./site-access.ts";

/** The most refusals kept per tab, and so the most sites `refusedSince` returns. */
export const MAX_REFUSALS = 20;
/** The most tabs whose refusals are kept; the tab whose first one is the oldest goes first. */
export const MAX_REFUSAL_TABS = 100;
/**
 * How long a page or frame load whose response headers never came is kept, so a download from it
 * can still be matched: a service worker can hold the load at least 10 minutes (ADR 0081).
 */
export const HOP_AGE_MS = 600_000;
/** The most such loads kept per tab; past it, the tab's flood mark matches by site. */
export const MAX_TAB_HOPS = 200;
/**
 * How long a load is kept once it is known to have ended some other way or to be no session's,
 * a closed tab's loads are kept, and a download that matched nothing waits for its load.
 */
export const HOP_GRACE_MS = 2_000;
/**
 * The most closed tabs, past those closed in the last HOP_GRACE_MS, whose group still ties a window
 * opened from them: how long after a tab's close Firefox can report such a window is not measured.
 */
export const MAX_GONE_TABS = 200;
/**
 * How long a tab keeps the site of a document from its last event, so a file the document's page
 * builds itself can be matched with it (ADR 0081).
 */
export const DOCUMENT_AGE_MS = 60_000;
/** The most sites whose documents a tab keeps; past it, the tab's document flood mark. */
export const MAX_TAB_SITES = 200;

export interface FileGuardDeps {
  browser: Pick<BrowserApi, "webRequest" | "tabs" | "webNavigation" | "downloads" | "runtime">;
  groups: Pick<SessionGroups, "sessionOf" | "rememberedSessionOf">;
  access: Pick<SiteAccess, "view" | "onRunningChange" | "onWithdraw" | "running">;
  /** The epoch clock webRequest's timeStamp is on: Date.now in the background. */
  now: () => number;
}

export interface FileGuard {
  /**
   * The sites of what was refused in the tab at or after `since` (webRequest's clock), oldest
   * first, each once. A refusal in a tab or window opened from the tab, or from a chain of them,
   * is listed for the tab too.
   */
  refusedSince(tabId: number, since: number): string[];
  /** Calls `listener` at each refusal; returns the function that removes it. */
  onRefused(listener: RefusalListener): () => void;
  /**
   * Resolves once the download judgements under way when it is called have ended; never rejects.
   * A download still waiting for its load is not waited for.
   */
  settled(): Promise<void>;
}

export type RefusalListener = (tabId: number, site: string, frameId: number) => void;

interface Refusal {
  site: string;
  frameId: number;
  /** The response's `timeStamp`. */
  at: number;
}

/** What a tab is judged as. */
interface Judgement {
  session: string;
  /** With a tie: the tab in a session's group that the chain of openers began in. */
  opener?: number;
}

/** The judgement of a tab or window opened from a tab judged as a session's. */
interface Tie {
  session: string;
  opener: number;
}

/** A tab or window opened from another tab's frame. */
interface Opened {
  /** The tab whose frame opened it. */
  source: number;
  /** Settles to undefined when the source was no session's; never rejects. */
  tie: Promise<Tie | undefined>;
}

/** A page or frame load of a tab whose response headers have not come (ADR 0081). */
interface Hop {
  requestId: string;
  /** Without its fragment. */
  url: string;
  tabId: number;
  frameId: number;
  timeStamp: number;
  /** now() when it was seen to end some other way; it is still matched for HOP_GRACE_MS. */
  ended?: number;
}

/** What a tab's lookup settled to. */
type Lookup = { judged: Judgement } | { none: true } | { failed: true };

/** A tab's kept loads, and what the tab is judged as. */
interface Loads {
  /** At most MAX_TAB_HOPS, oldest first. */
  hops: Hop[];
  /** The last lookup started; never rejects. */
  lookup: Promise<Lookup>;
  /** What that lookup settled to; unset while it runs. */
  outcome?: Lookup;
  /** A lookup was asked for while one was under way: it runs once more after it. */
  again?: boolean;
  /** The group tabs.onUpdated last showed the tab in. */
  group?: number;
  /**
   * Set when a load came while the tab kept MAX_TAB_HOPS: `from` is the first such load's
   * timeStamp, `until` HOP_AGE_MS after the last one's, cut to HOP_GRACE_MS after the tab closed.
   */
  flood?: Flood;
  /**
   * By site, the newest document of that site the tab's frames showed in the last
   * DOCUMENT_AGE_MS; at most MAX_TAB_SITES.
   */
  documents: Map<string, ShownDocument>;
  /**
   * Set when a document of a site the tab did not keep came while it kept MAX_TAB_SITES: `from`
   * is the first such document's timeStamp, `until` DOCUMENT_AGE_MS after the last one's, cut to
   * HOP_GRACE_MS after the tab closed.
   */
  documentFlood?: Flood;
  /**
   * The site and timeStamp of the newest document committed in the top frame, of any age; no site
   * for a page with none, such as about:blank.
   */
  top?: { site?: string; timeStamp: number };
  /** now() when the tab closed. */
  closed?: number;
}

/** A flood mark: in force for downloads begun from `from` on, until `until`. */
type Flood = { from: number; until: number };

/** The frame and the event's timeStamp of a document a tab showed. */
interface ShownDocument {
  frameId: number;
  timeStamp: number;
}

/** A download Foxleash did not start, from an http(s) address. */
interface Download {
  id: number;
  /** Without its fragment. */
  url: string;
  /** Its startTime in ms since the epoch; Infinity when unreadable. */
  started: number;
  /** now() at its onCreated. */
  at: number;
  /**
   * The kept loads of its address at its onCreated, its candidates then: a refusal another load
   * made is not reported to them.
   */
  early: ReadonlySet<Hop>;
  /**
   * Set when a judgement took it to refuse: that refusal, which no other judgement repeats; it
   * resolves to whether the file is gone.
   */
  refusal?: Promise<boolean>;
  /** Set when a load refused it: the tab and frame pairs its refusal is recorded for. */
  told?: Set<string>;
}

/** A kept load, with its tab's entry: the entry may leave the map while the load is judged. */
interface Candidate {
  hop: Hop;
  loads: Loads;
}

/** A file a page built itself, such as a Blob, which Foxleash did not start (ADR 0081). */
interface Built {
  id: number;
  /** The site it came from; unset for a page with no origin of its own, as in a sandbox. */
  site?: string;
  /** Its startTime in ms since the epoch; Infinity when unreadable. */
  started: number;
  /** Set when its judgement took it to refuse; resolves to whether the file is gone. */
  refusal?: Promise<boolean>;
}

/** A kept document a built file is matched with, with its tab's entry, taken before any await. */
interface DocumentCandidate {
  tabId: number;
  loads: Loads;
  site: string;
  document: ShownDocument;
  /** The frame a file is recorded for: the top frame while the tab's top page is of the site. */
  frameId: number;
  /** A later top page of another site replaced it, and every frame, before the file began. */
  replaced: boolean;
}

/** How a built file was matched: a tab and frame to record it for, unless it names none. */
interface BuiltMatch {
  tie?: Pick<Hop, "tabId" | "frameId">;
  judged?: Judgement;
}

/** How a load judges a download from its address. */
type Verdict = { refuse: true; judged?: Judgement } | { refuse: false; allowed: boolean };

/** The redirects Firefox follows. It follows no 300, so that and every other 3xx is judged. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/**
 * 204 and 205 load nothing and save nothing. A 304 is no response of its own: Firefox reports the
 * one it then takes from its cache in a second event, with status 200 and the cached headers.
 */
const NO_CONTENT: ReadonlySet<number> = new Set([204, 205, 304]);
const PAGE_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

/**
 * In the tabs of a session's group, cancels the response to a page or frame load that is anything
 * other than a web page and comes from a site that session may not act on, so Firefox neither
 * saves nor shows it (ADR 0081). A tab or window opened from a tab judged as a session's is judged
 * as that session's too, until it closes. A tab of a group the extension remembers
 * creating for a session, also before a restart, an update or a reload, is judged as that session's.
 * An ended session's tabs also pass files of the sites it was allowed for itself when it
 * ended, until the background restarts. Call it at the top level of the background
 * script. Its listeners, for the responses and for the tabs that tabs open, are added when the
 * first session starts running, or as soon as a tab of a remembered group is seen, from the
 * background's start on; never at the top level: Firefox wakes a suspended background
 * for a listener added there, and holds the request meanwhile (ADR 0071). They are never removed:
 * a session's group outlives its session, and a page left open in it can load a file at any time.
 */
export function createFileGuard({ browser, groups, access, now }: FileGuardDeps): FileGuard {
  const refusals = new Map<number, Refusal[]>();
  const listeners = new Set<RefusalListener>();
  const opened = new Map<number, Opened>();
  const loads = new Map<number, Loads>();
  /** Each tab's group, -1 for none, as its latest event showed it, kept while the tab is open. */
  const tabGroups = new Map<number, number>();
  /** Tabs closed in the last HOP_GRACE_MS, with their `opened` entry: for a load's lookup only. */
  const closedTabs = new Map<number, { at: number; entry: Opened | undefined }>();
  /**
   * Every tab closed in the last HOP_GRACE_MS and the MAX_GONE_TABS closed last, with their
   * `opened` entry and group: for the tie of a window the tab opened as it closed. Firefox never
   * reuses a tab id, so only such a window names one.
   */
  const goneTabs = new Map<
    number,
    { at: number; entry: Opened | undefined; group: number | undefined }
  >();
  /** Commits in the last HOP_GRACE_MS that came before their load. */
  let commits: { tabId: number; frameId: number; url: string; timeStamp: number; at: number }[] =
    [];
  /** Downloads that matched nothing yet, kept HOP_GRACE_MS from their onCreated. */
  const unmatched = new Map<number, Download>();
  /**
   * Downloads a load refused, kept HOP_GRACE_MS from their onCreated: a load of their address heard
   * later is told.
   */
  const refusedDownloads = new Map<number, Download>();
  const judging = new Set<Promise<void>>();
  /**
   * By ended session, oldest end first, the sites it was allowed for itself only when it ended:
   * for judging files only, never stored.
   */
  const endedSites = new Map<string, Set<string>>();
  let listening = false;

  access.onRunningChange(listen);
  access.onWithdraw(keepEnded);
  access.onRunningChange(dropEnded);
  browser.tabs.onRemoved.addListener((tabId) => {
    if (listening) closeLoads(tabId);
    keepGone(tabId);
    refusals.delete(tabId);
    opened.delete(tabId);
    tabGroups.delete(tabId);
  });
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) tabGroups.set(tab.id, tab.groupId ?? -1);
    void listenFor(tab);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Seen from the tab's own group, as Firefox does not always name a change of it.
    tabGroups.set(tabId, changeInfo.groupId ?? tab.groupId ?? -1);
    void listenFor(tab);
    regroup(tabId, changeInfo, tab);
  });
  // A group stays in its window, so a tab moved to another window has left it.
  browser.tabs.onDetached.addListener((tabId) => {
    tabGroups.set(tabId, -1);
  });
  void listenForOpenTabs();

  return { refusedSince, onRefused, settled };

  function keepEnded(session: string, site: string, cause: WithdrawCause): void {
    if (cause === "end") {
      // Always a new entry: the session's admit dropped any older one.
      const sites = endedSites.get(session) ?? new Set<string>();
      sites.add(site);
      endedSites.set(session, sites);
      if (endedSites.size <= MAX_REMEMBERED_GROUPS) return;
      const oldest = endedSites.keys().next();
      if (oldest.done !== true) endedSites.delete(oldest.value);
    } else {
      const sites = endedSites.get(session);
      sites?.delete(site);
      if (sites?.size === 0) endedSites.delete(session);
    }
  }

  /** A session that runs again asks again for the sites it had. */
  function dropEnded(session: string): void {
    if (access.running(session)) endedSites.delete(session);
  }

  /** Never rejects. */
  async function listenFor(tab: Tab): Promise<void> {
    if (listening) return;
    if ((await groups.rememberedSessionOf(tab.groupId)) !== undefined) listen();
  }

  /** Never rejects: a failed query leaves it to the tab events. */
  async function listenForOpenTabs(): Promise<void> {
    let tabs: Tab[];
    try {
      tabs = await browser.tabs.query({});
    } catch (error) {
      warn({ event: "file_guard_tabs_unread", error: String(error) });
      return;
    }
    for (const tab of tabs) {
      // An event is newer than the query's answer.
      if (tab.id !== undefined && !tabGroups.has(tab.id)) tabGroups.set(tab.id, tab.groupId ?? -1);
      void listenFor(tab);
    }
  }

  function listen(): void {
    if (listening) return;
    listening = true;
    browser.webRequest.onHeadersReceived.addListener(
      onHeaders,
      { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
      ["blocking", "responseHeaders"],
    );
    browser.webNavigation.onCreatedNavigationTarget.addListener(tie);
    // The second layer (ADR 0081): a load whose headers never came, as when another site's
    // service worker answers it, is matched with the download it becomes. None of these blocks.
    const loadTypes = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] };
    browser.webRequest.onBeforeRequest.addListener(onHop, loadTypes);
    browser.webRequest.onCompleted.addListener(onEnded, loadTypes);
    browser.webRequest.onErrorOccurred.addListener(onEnded, loadTypes);
    browser.webNavigation.onCommitted.addListener(onCommitted);
    browser.webNavigation.onHistoryStateUpdated.addListener(onHistoryState);
    browser.downloads.onCreated.addListener(onDownload);
  }

  /** Answers at once, with nothing, for everything but a file: only that waits for a lookup. */
  function onHeaders(details: HeadersReceivedDetails): Promise<Cancel | undefined> | undefined {
    // The header layer has this load.
    forgetHop(details.tabId, details.requestId, withoutFragment(details.url));
    if (details.tabId < 0) return undefined;
    // Only these carry a response a site sent.
    if (!/^https?:/i.test(details.url)) return undefined;
    if (NO_CONTENT.has(details.statusCode)) return undefined;
    const headers = details.responseHeaders ?? [];
    // The next hop's own response is judged by its own address.
    if (REDIRECTS.has(details.statusCode) && named(headers, "location").length > 0) {
      return undefined;
    }
    if (isPage(headers)) return undefined;
    return judge(details);
  }

  async function judge(details: HeadersReceivedDetails): Promise<Cancel | undefined> {
    let judged: Judgement | undefined;
    try {
      judged = await judgedSession(details.tabId);
    } catch {
      // The tab is gone, so nothing is lost; a lookup that fails lets no file through.
      return { cancel: true };
    }
    if (judged === undefined) return undefined;
    if (await allows(judged.session, details.url)) return undefined;
    refused(
      details.tabId,
      redactedUrl(details.url),
      details.frameId,
      details.timeStamp,
      judged.opener,
    );
    return { cancel: true };
  }

  /** Rejects when the tab is gone. */
  async function judgedSession(tabId: number): Promise<Judgement | undefined> {
    // Taken before the lookup: the tab can close meanwhile, and its entry with it.
    const entry = opened.get(tabId);
    const tab = await browser.tabs.get(tabId);
    return sessionOfTab(tab, entry);
  }

  async function sessionOfTab(tab: Tab, entry: Opened | undefined): Promise<Judgement | undefined> {
    const session = groups.sessionOf(tab.groupId);
    // The group wins over a tie, and a refusal there is not the old opener's.
    if (session !== undefined) return { session };
    if (entry !== undefined) {
      const tied = await judgedByEntry(entry);
      if (tied !== undefined) return tied;
    }
    // Last: a tie or a current group says more about the tab than the group it was left in.
    const remembered = await groups.rememberedSessionOf(tab.groupId);
    return remembered === undefined ? undefined : { session: remembered };
  }

  /** The judgement of a tab opened from another tab, by its tie; never rejects. */
  async function judgedByEntry(entry: Opened): Promise<Judgement | undefined> {
    const tie = await entry.tie;
    if (tie !== undefined) return tie;
    // The source was no session's when it opened the tab, but may have joined a group since.
    return tieOf(entry.source).catch(() => undefined);
  }

  /** The only place a refusal is recorded. The opener hears of it for `refusedSince` only. */
  function refused(
    tabId: number,
    site: string,
    frameId: number,
    at: number,
    opener?: number,
  ): void {
    const refusal = { site, frameId, at };
    // Nothing from here on can turn the cancel into a pass.
    attempt(() => record(tabId, refusal));
    if (opener !== undefined) attempt(() => record(opener, refusal));
    for (const listener of [...listeners]) {
      attempt(() => listener(tabId, site, frameId));
    }
  }

  function tie(details: CreatedNavigationTargetDetails): void {
    const source = details.sourceTabId;
    const closed = goneTabs.get(source);
    // Taken now: a page can close its own tab at once, and Firefox forgets the tab, its group and
    // its entry with it; the group's last tab may be the source.
    const group = closed === undefined ? tabGroups.get(source) : closed.group;
    const session = groups.sessionOf(group);
    const fallback = opened.get(source)?.tie ?? closed?.entry?.tie;
    const gone = () => tieOfGone(source, group, session, fallback);
    opened.set(details.tabId, {
      source,
      tie: tieOf(source).then((tied) => tied ?? gone(), gone),
    });
    const entry = loads.get(details.tabId);
    if (entry !== undefined) rerun(details.tabId, entry);
  }

  /** Rejects when the source is gone. */
  async function tieOf(source: number): Promise<Tie | undefined> {
    const judged = await judgedSession(source);
    if (judged === undefined) return undefined;
    // A chain of tabs points at the tab in a session's group it began in.
    return { session: judged.session, opener: judged.opener ?? source };
  }

  /**
   * The tie of a tab whose source is gone, or now in no session's group, by what was seen of the
   * source as it opened the tab; never rejects.
   */
  async function tieOfGone(
    source: number,
    group: number | undefined,
    session: string | undefined,
    fallback: Promise<Tie | undefined> | undefined,
  ): Promise<Tie | undefined> {
    if (session !== undefined) return { session, opener: source };
    const tied = await fallback;
    if (tied !== undefined) return tied;
    const remembered = await groups.rememberedSessionOf(group);
    return remembered === undefined ? undefined : { session: remembered, opener: source };
  }

  function record(tabId: number, refusal: Refusal): void {
    const kept = refusals.get(tabId) ?? [];
    kept.push(refusal);
    if (kept.length > MAX_REFUSALS) kept.shift();
    // A tab keeps its place in the map: the order is that of each tab's first refusal.
    refusals.set(tabId, kept);
    if (refusals.size <= MAX_REFUSAL_TABS) return;
    const oldest = refusals.keys().next();
    if (oldest.done !== true) refusals.delete(oldest.value);
  }

  function refusedSince(tabId: number, since: number): string[] {
    const sites = (refusals.get(tabId) ?? [])
      .filter((refusal) => refusal.at >= since)
      .map((refusal) => refusal.site);
    return [...new Set(sites)];
  }

  function onRefused(listener: RefusalListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function settled(): Promise<void> {
    return Promise.all([...judging]).then(() => undefined);
  }

  function closeLoads(tabId: number): void {
    const at = now();
    closedTabs.set(tabId, { at, entry: opened.get(tabId) });
    const entry = loads.get(tabId);
    if (entry === undefined) return;
    entry.closed = at;
    if (entry.flood !== undefined)
      entry.flood.until = Math.min(entry.flood.until, at + HOP_GRACE_MS);
    if (entry.documentFlood !== undefined)
      entry.documentFlood.until = Math.min(entry.documentFlood.until, at + HOP_GRACE_MS);
  }

  /** Keeps a closed tab's group and entry, oldest out first, for a window Firefox reports late. */
  function keepGone(tabId: number): void {
    const at = now();
    goneTabs.set(tabId, { at, entry: opened.get(tabId), group: tabGroups.get(tabId) });
    for (const [id, gone] of goneTabs) {
      if (goneTabs.size <= MAX_GONE_TABS || at - gone.at < HOP_GRACE_MS) return;
      goneTabs.delete(id);
    }
  }

  function regroup(tabId: number, changeInfo: TabChangeInfo, tab: Tab): void {
    const entry = loads.get(tabId);
    if (entry === undefined) return;
    // Seen from the tab's own group, as Firefox does not always name a change of it.
    const group = changeInfo.groupId ?? tab.groupId ?? -1;
    if (group === entry.group) return;
    entry.group = group;
    rerun(tabId, entry);
  }

  function onHop(details: RequestDetails): void {
    if (details.tabId < 0 || !/^https?:/i.test(details.url)) return;
    const at = now();
    prune(at);
    const { tabId, requestId, frameId, timeStamp } = details;
    const url = withoutFragment(details.url);
    const entry = loadsOf(tabId);
    let kept: Hop | undefined;
    if (!entry.hops.some((hop) => hop.requestId === requestId && hop.url === url)) {
      if (entry.hops.length >= MAX_TAB_HOPS) {
        entry.flood = flooded(entry.flood, entry.closed, timeStamp, at, HOP_AGE_MS);
      } else {
        kept = { requestId, url, tabId, frameId, timeStamp };
        entry.hops.push(kept);
        endIfCommitted(kept, at);
      }
    }
    // One lookup at a time: the loads that come while it runs share it.
    if (entry.outcome !== undefined) void lookUp(tabId, entry);
    for (const download of [...unmatched.values()]) {
      const hop = kept !== undefined && matches(kept, download) ? kept : undefined;
      track(download, recheck(download, hop === undefined ? [] : [{ hop, loads: entry }]));
    }
    if (kept === undefined) return;
    for (const download of [...refusedDownloads.values()]) {
      if (matches(kept, download)) track(download, tell(download, { hop: kept, loads: entry }));
    }
  }

  /** The tab's entry; a new one with its lookup started. */
  function loadsOf(tabId: number): Loads {
    const known = loads.get(tabId);
    if (known !== undefined) return known;
    const entry: Loads = { hops: [], documents: new Map(), lookup: lookupOf(tabId) };
    watch(tabId, entry);
    // The load came after its tab's onRemoved.
    const closed = closedTabs.get(tabId);
    if (closed !== undefined) entry.closed = closed.at;
    loads.set(tabId, entry);
    return entry;
  }

  /**
   * The mark after a load or document past the cap at `timeStamp`, kept `age` from it. Never ended
   * by the count: a load or document past the cap can still bring a download.
   */
  function flooded(
    mark: Flood | undefined,
    closed: number | undefined,
    timeStamp: number,
    at: number,
    age: number,
  ): Flood {
    const live = mark !== undefined && at <= mark.until;
    const from = live ? mark.from : timeStamp;
    const until =
      closed === undefined ? timeStamp + age : Math.min(timeStamp + age, closed + HOP_GRACE_MS);
    return { from, until };
  }

  /** A commit can reach the background before its own load. */
  function endIfCommitted(hop: Hop, at: number): void {
    const index = commits.findIndex(
      (commit) =>
        commit.tabId === hop.tabId &&
        commit.frameId === hop.frameId &&
        commit.url === hop.url &&
        hop.timeStamp <= commit.timeStamp,
    );
    if (index < 0) return;
    hop.ended = at;
    commits.splice(index, 1);
  }

  function onEnded(details: CompletedDetails | ErrorDetails): void {
    const at = now();
    for (const hop of loads.get(details.tabId)?.hops ?? []) {
      if (hop.requestId === details.requestId) hop.ended ??= at;
    }
  }

  /** The load became a page: only the newest such load ended, so a page cannot end an older one. */
  function onCommitted(details: NavigationDetails): void {
    const at = now();
    // Commits of documents with no load of their own, such as data: frames, come with no load
    // event that would prune them.
    prune(at);
    noteDocument(details, at, true);
    const url = withoutFragment(details.url);
    const hop = (loads.get(details.tabId)?.hops ?? []).findLast(
      (each) =>
        each.frameId === details.frameId && each.url === url && each.timeStamp <= details.timeStamp,
    );
    if (hop !== undefined) {
      hop.ended ??= at;
      return;
    }
    commits.push({
      tabId: details.tabId,
      frameId: details.frameId,
      url,
      timeStamp: details.timeStamp,
      at,
    });
  }

  /** Keeps the site of a document a tab's frame shows, for a file its page builds itself. */
  function noteDocument(details: NavigationDetails, at: number, committed: boolean): void {
    if (details.tabId < 0) return;
    const site = documentSite(details.url);
    // Only a commit replaces the top page, and every frame with it, also one of a page with no site.
    const replacesTop = committed && details.frameId === 0;
    if (site === undefined) {
      // A tab with no entry keeps no document to replace.
      const known = loads.get(details.tabId);
      if (replacesTop && known !== undefined) known.top = { timeStamp: details.timeStamp };
      return;
    }
    const entry = loadsOf(details.tabId);
    if (entry.outcome !== undefined) void lookUp(details.tabId, entry);
    if (replacesTop) entry.top = { site, timeStamp: details.timeStamp };
    if (!entry.documents.has(site) && entry.documents.size >= MAX_TAB_SITES) {
      // Nothing is evicted: a page could otherwise push out the document a file came from.
      entry.documentFlood = flooded(
        entry.documentFlood,
        entry.closed,
        details.timeStamp,
        at,
        DOCUMENT_AGE_MS,
      );
      return;
    }
    entry.documents.set(site, { frameId: details.frameId, timeStamp: details.timeStamp });
  }

  /** An address the History API set is a document's too, and keeps its site. */
  function onHistoryState(details: NavigationDetails): void {
    const at = now();
    prune(at);
    noteDocument(details, at, false);
  }

  function forgetHop(tabId: number, requestId: string, url: string): void {
    const entry = loads.get(tabId);
    const hop = entry?.hops.find((each) => each.requestId === requestId && each.url === url);
    if (entry !== undefined && hop !== undefined) drop(entry, hop);
  }

  function drop(entry: Loads, hop: Hop): void {
    entry.hops = entry.hops.filter((each) => each !== hop);
  }

  /** Starts a lookup unless one is under way, or asks for one more after it. */
  function rerun(tabId: number, entry: Loads): void {
    if (entry.outcome === undefined) entry.again = true;
    else void lookUp(tabId, entry);
  }

  function lookUp(tabId: number, entry: Loads): Promise<Lookup> {
    entry.lookup = lookupOf(tabId);
    delete entry.outcome;
    entry.again = false;
    watch(tabId, entry);
    return entry.lookup;
  }

  /** Added first, so it runs before anything that awaits the lookup. */
  function watch(tabId: number, entry: Loads): void {
    void entry.lookup.then((outcome) => looked(tabId, entry, outcome));
  }

  /** Never rejects. */
  async function lookupOf(tabId: number): Promise<Lookup> {
    // A tab Firefox closes as its download starts is judged by its opener, also when it closed
    // before its load reached the background.
    const entry = opened.get(tabId) ?? closedTabs.get(tabId)?.entry;
    let judged: Judgement | undefined;
    try {
      judged = await judgedSession(tabId);
    } catch {
      if (entry === undefined) return { failed: true };
      judged = await judgedByEntry(entry);
    }
    return judged === undefined ? { none: true } : { judged };
  }

  function looked(tabId: number, entry: Loads, outcome: Lookup): void {
    entry.outcome = outcome;
    if (entry.again === true) void lookUp(tabId, entry);
    prune(now());
    if (!("judged" in outcome)) return;
    // The tab became a session's after its load and the download.
    for (const download of [...unmatched.values()]) {
      const candidates = entry.hops
        .filter((hop) => matches(hop, download))
        .map((hop) => ({ hop, loads: entry }));
      track(download, recheck(download, newestFirst(candidates), [[tabId, entry]]));
    }
    for (const download of [...refusedDownloads.values()]) {
      for (const hop of entry.hops) {
        if (matches(hop, download)) track(download, tell(download, { hop, loads: entry }));
      }
    }
  }

  function onDownload(item: DownloadItem): void {
    const at = now();
    prune(at);
    // Foxleash's own `download` tool judges its address itself.
    if (item.byExtensionId === browser.runtime.id) return;
    if (!/^https?:/i.test(item.url)) {
      judgeBuilt(item, at);
      return;
    }
    const url = withoutFragment(item.url);
    const started = startOf(item);
    const candidates: Candidate[] = [];
    for (const entry of loads.values()) {
      for (const hop of entry.hops) {
        if (matches(hop, { url, started })) candidates.push({ hop, loads: entry });
      }
    }
    const download: Download = {
      id: item.id,
      url,
      started,
      at,
      early: new Set(candidates.map(({ hop }) => hop)),
    };
    // Before any await: a load that arrives meanwhile finds it.
    unmatched.set(download.id, download);
    track(download, recheck(download, newestFirst(candidates)));
  }

  /**
   * A file a page builds itself comes with no load, and Firefox gives it no referrer: it is judged
   * by its site against the documents that judged tabs show or showed.
   */
  function judgeBuilt(item: DownloadItem, at: number): void {
    const blob = /^blob:/i.test(item.url);
    const site = blob ? siteOf(URL.parse(item.url)?.origin ?? "") : siteOf(item.referrer ?? "");
    // A page in a sandbox has no origin, and Firefox names its Blob `blob:null/<uuid>`: the
    // approved page can frame the other site's page in one, so such a Blob is judged against every
    // site. Matched by its address, not by an origin of "null": another add-on's Blob,
    // `blob:moz-extension://...`, can parse to that origin too.
    const opaque = /^blob:null\//i.test(item.url);
    if (site === undefined && !opaque) return;
    const built: Built = { id: item.id, started: startOf(item) };
    if (site !== undefined) built.site = site;
    // Before any await: a closed tab's entry leaves the map, and documents age out, meanwhile.
    const candidates: DocumentCandidate[] = [];
    const floods: [number, Loads][] = [];
    for (const [tabId, entry] of loads) {
      for (const [shown, document] of entry.documents) {
        if (site !== undefined && shown !== site) continue;
        const replaced = replacedInTop(entry, shown, document, built.started);
        const frameId = entry.top?.site === shown ? 0 : document.frameId;
        candidates.push({ tabId, loads: entry, site: shown, document, frameId, replaced });
      }
      const mark = entry.documentFlood;
      if (mark !== undefined && Math.floor(mark.from) <= built.started && at <= mark.until) {
        floods.push([tabId, entry]);
      }
    }
    candidates.sort((a, b) => b.document.timeStamp - a.document.timeStamp);
    track(built, matchBuilt(built, candidates, floods));
  }

  /** startTime in ms since the epoch; an unreadable one is Infinity, which matches every load. */
  function startOf(item: DownloadItem): number {
    const parsed = Date.parse(item.startTime);
    // A NaN comparison would match none.
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  }

  function replacedInTop(
    entry: Loads,
    site: string,
    document: ShownDocument,
    started: number,
  ): boolean {
    const { top } = entry;
    return (
      top !== undefined &&
      top.site !== site &&
      top.timeStamp > document.timeStamp &&
      Math.floor(top.timeStamp) <= started
    );
  }

  async function matchBuilt(
    built: Built,
    candidates: DocumentCandidate[],
    floods: [number, Loads][],
  ): Promise<void> {
    const match =
      (await byDocuments(built, candidates)) ??
      (await byFrames(built)) ??
      (await byDocumentFlood(built, floods));
    if (match === undefined) return;
    built.refusal = refuse(built.id, match.tie, built.site, match.judged);
  }

  /** The first kept document, newest first, of a judged tab whose session may not act on it. */
  async function byDocuments(
    built: Built,
    candidates: DocumentCandidate[],
  ): Promise<BuiltMatch | undefined> {
    for (const candidate of candidates) {
      const outcome = await shownOutcomeOf(candidate.tabId, candidate.loads);
      if ("none" in outcome) continue;
      const judged = "judged" in outcome ? outcome.judged : undefined;
      if (judged !== undefined && (await allows(judged.session, candidate.site))) continue;
      // Neither a site-less file nor a page the tab no longer shows is the tab's to hear of.
      if (built.site === undefined || candidate.replaced) return {};
      const tie = { tabId: candidate.tabId, frameId: candidate.frameId };
      return judged === undefined ? { tie } : { tie, judged };
    }
    return undefined;
  }

  /**
   * The tab's outcome, but a closed tab once found to be no session's stays so when looking it up
   * again fails, as it does once the tab is gone: a tab of the user's own would refuse otherwise.
   */
  async function shownOutcomeOf(tabId: number, entry: Loads): Promise<Lookup> {
    const settled = await entry.lookup;
    const outcome = await outcomeOf(tabId, entry);
    if ("none" in settled && "failed" in outcome && entry.closed !== undefined) return settled;
    return outcome;
  }

  /** The first frame a judged tab shows now of a site its session may not act on. */
  async function byFrames(built: Built): Promise<BuiltMatch | undefined> {
    const tabs = await browser.tabs.query({}).catch((): Tab[] => []);
    const matches = await Promise.all(tabs.map((tab) => byFramesOf(built, tab)));
    return matches.find((match) => match !== undefined);
  }

  async function byFramesOf(built: Built, tab: Tab): Promise<BuiltMatch | undefined> {
    let judged: Judgement | undefined;
    try {
      judged = await sessionOfTab(tab, opened.get(tab.id));
      // A tab of the user's own lets no file through and refuses none.
      if (judged === undefined) return undefined;
    } catch {
      // A tab that cannot be looked up lets no file through, as for a load.
    }
    const frames =
      (await browser.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) ?? [];
    for (const frame of frames) {
      const shown = documentSite(frame.url ?? "");
      if (shown === undefined || (built.site !== undefined && shown !== built.site)) continue;
      if (judged !== undefined && (await allows(judged.session, shown))) continue;
      if (built.site === undefined) return {};
      const tie = { tabId: tab.id, frameId: frame.frameId };
      return judged === undefined ? { tie } : { tie, judged };
    }
    return undefined;
  }

  /** A document flood of a judged tab whose session may not act on the file's site. */
  async function byDocumentFlood(
    built: Built,
    floods: [number, Loads][],
  ): Promise<BuiltMatch | undefined> {
    for (const [tabId, entry] of floods) {
      const outcome = await shownOutcomeOf(tabId, entry);
      if ("none" in outcome) continue;
      if (
        "judged" in outcome &&
        built.site !== undefined &&
        (await allows(outcome.judged.session, built.site))
      ) {
        continue;
      }
      return {};
    }
    return undefined;
  }

  function matches(hop: Hop, download: Pick<Download, "url" | "started">): boolean {
    // startTime has whole milliseconds; a timeStamp may carry a fraction.
    return hop.url === download.url && Math.floor(hop.timeStamp) <= download.started;
  }

  function newestFirst(candidates: Candidate[]): Candidate[] {
    return candidates.sort((a, b) => b.hop.timeStamp - a.hop.timeStamp);
  }

  /** A judgement ends once the download's refusal has, whichever judgement made it. */
  function track(
    download: { refusal?: Promise<unknown> | undefined },
    judgement: Promise<void>,
  ): void {
    const tracked: Promise<void> = judgement
      .then(() => download.refusal)
      .then(() => {
        judging.delete(tracked);
      });
    judging.add(tracked);
  }

  async function recheck(
    download: Download,
    candidates: Candidate[],
    floods?: [number, Loads][],
  ): Promise<void> {
    await byHops(download, candidates);
    await byFlood(download, floods);
  }

  /** Refuses the download when one of these loads, newest first, refuses it. */
  async function byHops(download: Download, candidates: Candidate[]): Promise<void> {
    let allowed: Candidate | undefined;
    for (const [index, candidate] of candidates.entries()) {
      const verdict = await verdictOf(candidate, download.url);
      if (download.refusal !== undefined) {
        // Another load refused it meanwhile: a load heard after it is told.
        await Promise.all(candidates.slice(index).map((each) => tell(download, each)));
        return;
      }
      if (verdict.refuse) {
        // Decided at once: a download is refused once. The load is kept: which load a download
        // came from cannot be told, and a page could otherwise spend the load on a download of the
        // same address from a window it opened and then closed, before the load's own.
        take(
          download,
          refuse(download.id, candidate.hop, redactedUrl(download.url), verdict.judged),
        );
        download.told = new Set([pairOf(candidate.hop)]);
        refusedDownloads.set(download.id, download);
        return;
      }
      if (verdict.allowed && allowed === undefined) allowed = candidate;
    }
    // Its load ended in this download.
    if (allowed !== undefined) drop(allowed.loads, allowed.hop);
  }

  /**
   * Records a load's refusal for a load of its address heard after the download, once per tab and
   * frame.
   */
  async function tell(download: Download, candidate: Candidate): Promise<void> {
    const { told } = download;
    const pair = pairOf(candidate.hop);
    if (told === undefined || download.early.has(candidate.hop) || told.has(pair)) return;
    const verdict = await verdictOf(candidate, download.url);
    // Checked again: another path may have told this tab and frame meanwhile.
    if (!verdict.refuse || told.has(pair)) return;
    told.add(pair);
    if (await download.refusal) {
      refused(
        candidate.hop.tabId,
        redactedUrl(download.url),
        candidate.hop.frameId,
        now(),
        verdict.judged?.opener,
      );
    }
  }

  function pairOf({ tabId, frameId }: Pick<Hop, "tabId" | "frameId">): string {
    return `${tabId}/${frameId}`;
  }

  async function verdictOf({ hop, loads: entry }: Candidate, url: string): Promise<Verdict> {
    const outcome = await outcomeOf(hop.tabId, entry);
    if ("none" in outcome) return { refuse: false, allowed: false };
    // A tab that cannot be looked up lets no file through, as for the header layer.
    if ("failed" in outcome) return { refuse: true };
    const { judged } = outcome;
    if (await allows(judged.session, url)) return { refuse: false, allowed: true };
    return { refuse: true, judged };
  }

  /** The tab's lookup, made again when it said no session. */
  async function outcomeOf(tabId: number, entry: Loads): Promise<Lookup> {
    const outcome = await entry.lookup;
    if (!("none" in outcome)) return outcome;
    // The tab may have joined a group, or been tied, since: a lookup under way began after the
    // outcome settled.
    return entry.outcome === undefined ? entry.lookup : lookUp(tabId, entry);
  }

  /**
   * During a flood, a download of a site the flooding tab's session may not act on, from any tab,
   * Foxleash did not start: refused, and reported to nobody.
   */
  async function byFlood(download: Download, floods?: [number, Loads][]): Promise<void> {
    for (const [tabId, entry] of floods ?? [...loads]) {
      const flood = entry.flood;
      if (flood === undefined || Math.floor(flood.from) > download.started) continue;
      if (now() > flood.until) continue;
      const outcome = await outcomeOf(tabId, entry);
      if ("none" in outcome) continue;
      if ("judged" in outcome && (await allows(outcome.judged.session, download.url))) continue;
      // Decided at once, as for a load.
      if (download.refusal !== undefined) continue;
      take(download, refuse(download.id));
    }
  }

  /**
   * Whether the session's tabs may load a file of the site of `url`: a site it may act on, or one
   * it was allowed for itself when it ended.
   */
  async function allows(session: string, url: string): Promise<boolean> {
    let view: SiteView;
    try {
      // Read anew each time: an approval the user withdrew a moment ago no longer counts.
      view = await access.view(session);
    } catch {
      // A session the user stopped, or settings that cannot be read: refused.
      return false;
    }
    if (view.allowed(url)) return true;
    // Read after the view: a session that ran again or a site withdrawn meanwhile no longer counts.
    const site = siteOf(url);
    return site !== undefined && endedSites.get(session)?.has(site) === true && !view.blocked(url);
  }

  /** Its judgements end with the refusal: `track` waits for it. */
  function take(download: Download, refusal: Promise<boolean>): void {
    download.refusal = refusal;
    unmatched.delete(download.id);
  }

  /**
   * Cancels the download and removes its file; one matched in a tab's frame is recorded for it, by
   * `site`, once the file is gone.
   */
  async function refuse(
    id: number,
    tie?: Pick<Hop, "tabId" | "frameId">,
    site?: string,
    judged?: Judgement,
  ): Promise<boolean> {
    try {
      await browser.downloads.cancel(id);
    } catch {
      // Firefox rejects for a download already complete: its file is removed below.
    }
    let gone = false;
    try {
      const [item] = await browser.downloads.search({ id });
      if (item?.state === "complete") {
        // Resolving means the file is gone; a search right after can still say it exists.
        await browser.downloads.removeFile(id);
        gone = true;
      } else {
        // Firefox deletes the partial file of a download it interrupts, and removes the file of
        // no other download that is not complete.
        gone = item?.state === "interrupted" && item.exists !== true;
      }
    } catch {
      // Not removed.
    }
    if (!gone) {
      warn({ event: "file_guard_download_kept", id });
      return false;
    }
    if (tie !== undefined && site !== undefined) {
      refused(tie.tabId, site, tie.frameId, now(), judged?.opener);
    }
    return true;
  }

  /** Forgets what is too old to match. */
  function prune(at: number): void {
    for (const [tabId, entry] of loads) {
      const none = entry.outcome !== undefined && "none" in entry.outcome;
      entry.hops = entry.hops.filter(
        (hop) =>
          at - hop.timeStamp < HOP_AGE_MS &&
          (hop.ended === undefined || at - hop.ended < HOP_GRACE_MS) &&
          !(none && at - hop.timeStamp >= HOP_GRACE_MS),
      );
      for (const [site, document] of entry.documents) {
        const age = at - document.timeStamp;
        // Only a tab that gives a session keeps its documents.
        if (age >= DOCUMENT_AGE_MS || (none && age >= HOP_GRACE_MS)) entry.documents.delete(site);
      }
      if (entry.flood !== undefined && at > entry.flood.until) delete entry.flood;
      if (entry.documentFlood !== undefined && at > entry.documentFlood.until) {
        delete entry.documentFlood;
      }
      const closed = entry.closed !== undefined && at - entry.closed >= HOP_GRACE_MS;
      const empty =
        entry.hops.length === 0 &&
        entry.documents.size === 0 &&
        entry.flood === undefined &&
        entry.documentFlood === undefined &&
        entry.outcome !== undefined;
      if (closed || empty) loads.delete(tabId);
    }
    for (const [tabId, closed] of closedTabs) {
      if (at - closed.at >= HOP_GRACE_MS) closedTabs.delete(tabId);
    }
    commits = commits.filter((commit) => at - commit.at < HOP_GRACE_MS);
    for (const [id, download] of unmatched) {
      if (at - download.at >= HOP_GRACE_MS) unmatched.delete(id);
    }
    for (const [id, download] of refusedDownloads) {
      if (at - download.at >= HOP_GRACE_MS) refusedDownloads.delete(id);
    }
  }
}

/**
 * Whether Firefox shows the response as a web page: no Content-Disposition or one of the type
 * `inline` (RFC 6266 section 4.2 treats an unknown type as `attachment`), and one Content-Type
 * that is HTML or XHTML. Everything else counts as a file, also a type Firefox would show: which
 * types it shows instead of saving depends on the user's settings.
 */
function isPage(headers: readonly HttpHeader[]): boolean {
  const dispositions = named(headers, "content-disposition");
  const types = named(headers, "content-type");
  if (dispositions.length > 1 || types.length !== 1) return false;
  if (dispositions.some(({ value }) => tokenOf(value) !== "inline")) return false;
  const type = types[0]?.value ?? "";
  // Firefox hands a repeated Content-Type over as one entry, joined with a comma, and goes by the
  // last type in it.
  return !type.includes(",") && PAGE_TYPES.has(tokenOf(type));
}

function named(headers: readonly HttpHeader[], name: string): HttpHeader[] {
  return headers.filter((header) => header.name.toLowerCase() === name);
}

/**
 * A header value's part before its first `;`, with spaces and tabs stripped from its ends and A to
 * Z lowercased. Deliberately not `trim()` and `toLowerCase()`, which also take away characters
 * that Firefox may keep in the token, and so would let through a value Firefox reads as another.
 */
function tokenOf(value: string | undefined): string {
  const [token = ""] = (value ?? "").split(";");
  const characters = [...token];
  // With nothing but spaces and tabs both indexes are -1, and the slice is empty.
  return characters
    .slice(characters.findIndex(isNotBlank), characters.findLastIndex(isNotBlank) + 1)
    .join("")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isNotBlank(character: string): boolean {
  return character !== " " && character !== "\t";
}

/** Runs a step whose failure must stop nothing that follows it. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // The response is cancelled all the same.
  }
}

/** A document's site; a `blob:` document, which a page can open, has its origin's. */
function documentSite(url: string): string | undefined {
  return /^blob:/i.test(url) ? siteOf(URL.parse(url)?.origin ?? "") : siteOf(url);
}
