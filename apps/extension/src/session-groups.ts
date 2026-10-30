import type { BrowserApi, Tab, TabGroup } from "./browser-api.ts";
import { PROMPT_PAGE } from "./site-access.ts";

export interface SessionGroups {
  /** The session's tab group, or undefined when it has none or the user closed it. */
  groupOf(session: string): Promise<TabGroup | undefined>;
  /** Puts the tab in the session's group, creating the group when needed; returns its id. */
  ensureGroup(session: string, tab: { id: number; windowId: number }): Promise<number>;
  /** Closes the session's group when it holds only blank tabs; otherwise leaves it. */
  endSession(session: string): Promise<void>;
  /**
   * Asks Firefox to remove the tab, one ask at a time across sessions together with
   * endSession's. The tab and its window are read when its turn comes. `check` gets the tab as
   * read then and runs right before the removal is asked for, with no await in between, and may
   * throw to refuse it. Resolves false, asking nothing, for a window's last tab; a tab this
   * already asked Firefox to remove counts as gone until Firefox removes it. Otherwise resolves
   * once Firefox was asked, with `removed`, which settles when Firefox has removed the tab or
   * refused to; a beforeunload prompt holds it until the user answers. While that removal has not
   * settled, closing the tab again asks Firefox nothing and hands back the same `removed`.
   * `removed` carries a handler, so a caller may stop waiting for it.
   */
  closeTab(tabId: number, check: (tab: Tab) => void): Promise<false | { removed: Promise<void> }>;
  /**
   * True when the group is one this created for a session and has not forgotten; false for
   * undefined and -1.
   */
  isSessionGroup(groupId: number | undefined): boolean;
  /** The session whose group this is; undefined for undefined, -1 and any other group. */
  sessionOf(groupId: number | undefined): string | undefined;
}

/**
 * `onGrouped` runs after a tab joins a session's group, once the group is known to
 * `isSessionGroup`. It must not reject: a rejection would skip the title of a new group.
 * `blankPage` says whether a Foxhand page in one of the group's tabs may close with it.
 */
export function createSessionGroups(
  browser: BrowserApi,
  onGrouped: (tabId: number) => Promise<void> = async () => {},
  blankPage: (url: string) => boolean = () => false,
): SessionGroups {
  // Maps, not objects: "__proto__" and "constructor" are valid session ids.
  const groups = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  // One at a time across sessions: two ending at once would each count the other's tabs as
  // keeping their window open, and close it between them.
  let closing: Promise<unknown> = Promise.resolve();
  // Tabs handed to tabs.remove that Firefox has not removed yet. A tab the user keeps with Stay
  // on its beforeunload prompt stays here, so later closes in its window refuse.
  const removing = new Set<number>();
  // closeTab's removals Firefox has not settled yet. Asked again while the page's beforeunload
  // prompt is open, Firefox closes the tab without waiting for the user's answer.
  const unsettled = new Map<number, Promise<void>>();
  browser.tabs.onRemoved.addListener((tabId) => removing.delete(tabId));

  return { groupOf, ensureGroup, endSession, closeTab, isSessionGroup, sessionOf };

  async function groupOf(session: string): Promise<TabGroup | undefined> {
    const id = groups.get(session);
    if (id === undefined) return undefined;
    try {
      return await browser.tabGroups.get(id);
    } catch {
      forget(session, id);
      return undefined;
    }
  }

  function ensureGroup(session: string, tab: { id: number; windowId: number }): Promise<number> {
    return serialize(session, () => addToGroup(session, tab));
  }

  function endSession(session: string): Promise<void> {
    return serialize(session, async () => {
      const step = closing.catch(() => undefined).then(() => startClosingIfBlank(session));
      closing = step;
      const started = await step;
      if (started === undefined) return;
      await started.removed;
      forget(session, started.groupId);
    });
  }

  function closeTab(
    tabId: number,
    check: (tab: Tab) => void,
  ): Promise<false | { removed: Promise<void> }> {
    const close = closing
      .catch(() => undefined)
      .then(async () => {
        // Read again here: the user may have moved the tab while it waited its turn.
        const tab = await browser.tabs.get(tabId);
        const windowTabs = await browser.tabs.query({ windowId: tab.windowId });
        // Removing a window's last tab closes the window, and closing the last window quits Firefox.
        if (!windowTabs.some((other) => other.id !== tabId && !removing.has(other.id))) {
          return false;
        }
        check(tab);
        // Not awaited: a page's beforeunload prompt holds tabs.remove until the user answers, and
        // `removing` already counts the tab as gone for the closes after this one.
        return { removed: removeTab(tabId) };
      });
    closing = close;
    return close;
  }

  function isSessionGroup(groupId: number | undefined): boolean {
    return [...groups.values()].some((id) => id === groupId);
  }

  function sessionOf(groupId: number | undefined): string | undefined {
    return [...groups].find(([, id]) => id === groupId)?.[0];
  }

  /** Runs the task after every task already queued for the session has settled. */
  function serialize<T>(session: string, task: () => Promise<T>): Promise<T> {
    const previous = pending.get(session) ?? Promise.resolve();
    const chain = previous.catch(() => undefined).then(task);
    pending.set(session, chain);
    // Not `finally`: its promise would reject with the chain, and nothing would handle that.
    const cleanUp = () => {
      if (pending.get(session) === chain) pending.delete(session);
    };
    chain.then(cleanUp, cleanUp);
    return chain;
  }

  async function addToGroup(
    session: string,
    tab: { id: number; windowId: number },
  ): Promise<number> {
    const group = await groupOf(session);
    if (group !== undefined && (await joinGroup(group.id, tab.id))) {
      await onGrouped(tab.id);
      return group.id;
    }
    // Without a window, Firefox creates the group in the focused window and moves the tab there.
    const id = await browser.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: tab.windowId },
    });
    groups.set(session, id);
    await onGrouped(tab.id);
    await browser.tabGroups.update(id, { title: "Foxhand", color: "orange" });
    return id;
  }

  async function joinGroup(groupId: number, tabId: number): Promise<boolean> {
    try {
      await browser.tabs.group({ groupId, tabIds: [tabId] });
      return true;
    } catch {
      // The user closed the group after groupOf found it: make a new one.
      return false;
    }
  }

  async function startClosingIfBlank(
    session: string,
  ): Promise<{ removed: Promise<void>; groupId: number } | undefined> {
    const group = await groupOf(session);
    if (group === undefined) return;
    // One query for the whole window: the blank check and the empty-window check see one state.
    const windowTabs = await browser.tabs.query({ windowId: group.windowId });
    const tabs = windowTabs.filter((tab) => tab.groupId === group.id);
    if (tabs.length === 0) {
      forget(session, group.id);
      return;
    }
    const promptPage = browser.runtime.getURL(PROMPT_PAGE);
    if (!tabs.every((tab) => isBlank(tab, promptPage, blankPage))) return;
    // Removing a window's last tabs closes the window, and closing the last window quits Firefox.
    if (!windowTabs.some((tab) => tab.groupId !== group.id && !removing.has(tab.id))) return;
    return { removed: removeTabs(tabs.map((tab) => tab.id)), groupId: group.id };
  }

  /** Asks Firefox to remove the tab, unless an earlier ask has not settled; returns that removal. */
  function removeTab(tabId: number): Promise<void> {
    const earlier = unsettled.get(tabId);
    if (earlier !== undefined) return earlier;
    const removal = removeTabs([tabId]);
    unsettled.set(tabId, removal);
    const settle = () => unsettled.delete(tabId);
    removal.then(settle, settle);
    return removal;
  }

  /**
   * Records the tabs as being removed and asks Firefox to remove them, both before it returns.
   * The promise settles once Firefox has removed them or refused to; it carries a handler, so a
   * caller may stop waiting for it.
   */
  function removeTabs(tabIds: number[]): Promise<void> {
    const removal = askFirefoxToRemove(tabIds);
    removal.catch(() => undefined);
    return removal;
  }

  async function askFirefoxToRemove(tabIds: number[]): Promise<void> {
    // An earlier removal that Firefox has not finished keeps its ids when this one fails.
    const added = tabIds.filter((id) => !removing.has(id));
    for (const id of added) removing.add(id);
    try {
      await browser.tabs.remove(tabIds);
    } catch (error) {
      for (const id of added) removing.delete(id);
      throw error;
    }
  }

  function forget(session: string, id: number): void {
    if (groups.get(session) === id) groups.delete(session);
  }
}

const BLANK_URLS: ReadonlySet<string | undefined> = new Set([
  "about:blank",
  "about:newtab",
  "about:home",
]);

/**
 * A tab still loading may be leaving a new-tab page for an address the user typed. A prompt page
 * counts as blank: after the session it can only say that its request has ended.
 */
function isBlank(tab: Tab, promptPage: string, blankPage: (url: string) => boolean): boolean {
  return (
    tab.status === "complete" &&
    (BLANK_URLS.has(tab.url) ||
      tab.url?.startsWith(promptPage) === true ||
      (tab.url !== undefined && blankPage(tab.url)))
  );
}
