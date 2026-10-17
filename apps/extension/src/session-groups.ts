import type { BrowserApi, TabGroup } from "./browser-api.ts";

export interface SessionGroups {
  /** The session's tab group, or undefined when it has none or the user closed it. */
  groupOf(session: string): Promise<TabGroup | undefined>;
  /** Puts the tab in the session's group, creating the group when needed; returns its id. */
  ensureGroup(session: string, tab: { id: number; windowId: number }): Promise<number>;
}

export function createSessionGroups(browser: BrowserApi): SessionGroups {
  // Maps, not objects: "__proto__" and "constructor" are valid session ids.
  const groups = new Map<string, number>();
  const pending = new Map<string, Promise<number>>();

  return { groupOf, ensureGroup };

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
    const previous = pending.get(session) ?? Promise.resolve(0);
    const chain = previous.catch(() => 0).then(() => addToGroup(session, tab));
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
    if (group !== undefined) {
      try {
        await browser.tabs.group({ groupId: group.id, tabIds: [tab.id] });
        return group.id;
      } catch {
        // The user closed the group after groupOf found it: make a new one.
      }
    }
    // Without a window, Firefox creates the group in the focused window and moves the tab there.
    const id = await browser.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: tab.windowId },
    });
    groups.set(session, id);
    await browser.tabGroups.update(id, { title: "Foxhand", color: "orange" });
    return id;
  }

  function forget(session: string, id: number): void {
    if (groups.get(session) === id) groups.delete(session);
  }
}
