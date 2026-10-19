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
   * True when the group is one this created for a session and has not forgotten; false for
   * undefined and -1.
   */
  isSessionGroup(groupId: number | undefined): boolean;
}

/**
 * `onGrouped` runs after a tab joins a session's group, once the group is known to
 * `isSessionGroup`. It must not reject: a rejection would skip the title of a new group.
 */
export function createSessionGroups(
  browser: BrowserApi,
  onGrouped: (tabId: number) => Promise<void> = async () => {},
): SessionGroups {
  // Maps, not objects: "__proto__" and "constructor" are valid session ids.
  const groups = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  // One at a time across sessions: two ending at once would each count the other's tabs as
  // keeping their window open, and close it between them.
  let closing: Promise<unknown> = Promise.resolve();

  return { groupOf, ensureGroup, endSession, isSessionGroup };

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
    return serialize(session, () => {
      const close = closing.catch(() => undefined).then(() => closeIfBlank(session));
      closing = close;
      return close;
    });
  }

  function isSessionGroup(groupId: number | undefined): boolean {
    return [...groups.values()].some((id) => id === groupId);
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

  async function closeIfBlank(session: string): Promise<void> {
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
    if (!tabs.every((tab) => isBlank(tab, promptPage))) return;
    // Removing a window's last tabs closes the window, and closing the last window quits Firefox.
    if (windowTabs.length === tabs.length) return;
    await browser.tabs.remove(tabs.map((tab) => tab.id));
    forget(session, group.id);
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
function isBlank(tab: Tab, promptPage: string): boolean {
  return (
    tab.status === "complete" &&
    (BLANK_URLS.has(tab.url) || tab.url?.startsWith(promptPage) === true)
  );
}
