import type { BrowserApi, Tab, TabGroup } from "./browser-api.ts";
import { readSettings } from "./settings.ts";
import { PROMPT_PAGE } from "./site-access.ts";

export interface SessionGroups {
  /** The session's tab group, or undefined when it has none or the user closed it. */
  groupOf(session: string): Promise<TabGroup | undefined>;
  /** Puts the tab in the session's group, creating the group when needed; returns its id. */
  ensureGroup(session: string, tab: { id: number; windowId: number }): Promise<number>;
  /**
   * Creates the session's new tab as `tabs.create` does: in its group's window; in the session's
   * own window once it has one; with neither and the setting on, in a new window made for the
   * session, whose own blank tab a blank tab request takes; otherwise where Firefox puts it.
   * `check` runs right before each `tabs.create` and `windows.create`, and right before the
   * window's own first tab is handed back, with no await in between, and may throw to refuse; it
   * runs again once Firefox made a tab in a window made in this call. A throw makes `createTab`
   * reject with that error and create nothing; a window made in this call for the tab is removed
   * again, with the tab.
   */
  createTab(
    session: string,
    properties: Omit<Parameters<BrowserApi["tabs"]["create"]>[0], "windowId">,
    check: () => void,
  ): Promise<Tab>;
  /** Closes the session's group when it holds only blank tabs; otherwise leaves it. */
  endSession(session: string): Promise<void>;
  /**
   * Asks Firefox to remove the tab, one ask at a time across sessions together with
   * endSession's. The tab and its window are read when its turn comes. `check` gets the tab as
   * read then and runs right before the removal is asked for, with no await in between, and may
   * throw to refuse it. Resolves false, asking nothing, for a window's last tab; a tab this
   * already asked Firefox to remove counts as gone until Firefox removes it or the user keeps it.
   * Otherwise resolves once Firefox was asked, with `removed`, which settles when Firefox has
   * removed the tab, refused to, or the user kept it; a beforeunload prompt holds it until the user
   * answers. While that removal has not settled, closing the tab again asks Firefox nothing and
   * hands back the same `removed`.
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
  /**
   * Brings the session's own window to the front when `windowId` is that window, restoring it when
   * minimized; otherwise draws attention to `windowId`. `wanted` runs right before each
   * `windows.update`, with no await in between, and the update is skipped when it returns false.
   * Never rejects.
   */
  showPromptWindow(session: string, windowId: number, wanted: () => boolean): Promise<void>;
}

/**
 * `onGrouped` runs after a tab joins a session's group, once the group is known to
 * `isSessionGroup`. It must not reject: a rejection would skip the title of a new group.
 * `blankPage` says whether a Foxleash page in one of the group's tabs may close with it.
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
  // Removals asked for each tab that have not ended: Firefox has not removed the tab, refused
  // to, or settled with the tab kept (Stay on its beforeunload prompt).
  const removing = new Map<number, number>();
  // closeTab's removals Firefox has not settled yet. Asked again while the page's beforeunload
  // prompt is open, Firefox closes the tab without waiting for the user's answer.
  const unsettled = new Map<number, Promise<void>>();
  // The window this created for each session while the setting was on, until it closes or the
  // session ends (and, once its first tab is settled, until the session's group is forgotten).
  const ownWindows = new Map<string, OwnWindow>();
  browser.tabs.onRemoved.addListener(tabRemoved);
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => removeFirstTab(tabId, windowId));
  browser.windows.onRemoved.addListener((windowId) => {
    for (const [session, own] of ownWindows) {
      if (own.id === windowId) ownWindows.delete(session);
    }
  });

  return {
    groupOf,
    ensureGroup,
    createTab,
    endSession,
    closeTab,
    isSessionGroup,
    sessionOf,
    showPromptWindow,
  };

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

  async function createTab(
    session: string,
    properties: Omit<Parameters<BrowserApi["tabs"]["create"]>[0], "windowId">,
    check: () => void,
  ): Promise<Tab> {
    const group = await groupOf(session);
    const own = ownWindows.get(session);
    if (own === undefined || (group !== undefined && group.windowId !== own.id)) {
      if (group !== undefined) {
        check();
        return browser.tabs.create({ ...properties, windowId: group.windowId });
      }
      // A failed read opens the tab as with the setting off.
      const on = await readSettings(browser).then(
        (settings) => settings.sessionWindow,
        () => false,
      );
      if (!on) {
        check();
        return browser.tabs.create(properties);
      }
    }
    return serialize(session, () => createInOwnWindow(session, properties, check));
  }

  function endSession(session: string): Promise<void> {
    return serialize(session, async () => {
      try {
        const step = closing.catch(() => undefined).then(() => startClosingIfBlank(session));
        closing = step;
        const started = await step;
        if (started === undefined) return;
        await started.removed;
        if (started.groupId !== undefined) forget(session, started.groupId);
      } finally {
        ownWindows.delete(session);
      }
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
        // `removing` counts the tab as gone for the closes after this one while it is pending.
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

  async function showPromptWindow(
    session: string,
    windowId: number,
    wanted: () => boolean,
  ): Promise<void> {
    try {
      if (ownWindows.get(session)?.id !== windowId) {
        if (!wanted()) return;
        await browser.windows.update(windowId, { drawAttention: true });
        return;
      }
      const state = await browser.windows.get(windowId).then(
        (window) => window.state,
        () => undefined,
      );
      if (!wanted()) return;
      // Only for a minimized window: "normal" would also un-maximize one or leave full screen.
      await browser.windows.update(
        windowId,
        state === "minimized" ? { focused: true, state: "normal" } : { focused: true },
      );
    } catch {}
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
    await browser.tabGroups.update(id, { title: "Foxleash", color: "orange" });
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

  /** Runs under the session's `serialize`, so no other create or close of its window interleaves. */
  async function createInOwnWindow(
    session: string,
    properties: Omit<Parameters<BrowserApi["tabs"]["create"]>[0], "windowId">,
    check: () => void,
  ): Promise<Tab> {
    const group = await groupOf(session);
    let own = ownWindows.get(session);
    if (group !== undefined && group.windowId !== own?.id) {
      check();
      return browser.tabs.create({ ...properties, windowId: group.windowId });
    }
    const made = own === undefined;
    if (own === undefined) {
      check();
      own = await openOwnWindow(session);
    }
    const going = [own.first];
    try {
      if (properties.url === "about:blank" && own.firstPending) {
        own.firstPending = false;
        const first = await browser.tabs.get(own.first).catch(() => undefined);
        if (first !== undefined && first.windowId === own.id && isFirstTabUnused(first)) {
          check();
          return first;
        }
      }
      check();
      const tab = await browser.tabs.create({ ...properties, windowId: own.id });
      going.push(tab.id);
      // Refused while Firefox made the tab: the window made for it goes too, with the tab.
      if (made) check();
      return tab;
    } catch (error) {
      if (made) {
        if (ownWindows.get(session) === own) ownWindows.delete(session);
        // Counted as going, so a session ending meanwhile does not close the last window.
        const windowId = own.id;
        removeTabs(going, () => browser.windows.remove(windowId));
      }
      throw error;
    }
  }

  async function openOwnWindow(session: string): Promise<OwnWindow> {
    // Firefox cannot open a window on a tab it has not loaded, so the page waits for a tab of its
    // own in it: a window opened on the page would load it before it joins the group.
    const window = await browser.windows.create({ url: "about:blank", focused: false });
    const first = window.tabs?.[0]?.id;
    if (window.id === undefined || first === undefined) {
      if (window.id !== undefined) browser.windows.remove(window.id).catch(() => {});
      throw new Error("Firefox opened the session's window without a tab.");
    }
    const own: OwnWindow = { id: window.id, first, firstPending: true };
    ownWindows.set(session, own);
    return own;
  }

  /** The window's own first tab, as Firefox opened it: blank and in no group. */
  function isFirstTabUnused(tab: Tab): boolean {
    return (
      (tab.groupId ?? -1) === -1 && isBlank(tab, browser.runtime.getURL(PROMPT_PAGE), blankPage)
    );
  }

  async function startClosingIfBlank(
    session: string,
  ): Promise<{ removed: Promise<void>; groupId: number | undefined } | undefined> {
    // Before groupOf, which may forget the window along with a group that is gone.
    const own = ownWindows.get(session);
    const group = await groupOf(session);
    if (own !== undefined) {
      // A group that left the window before a tab there was selected leaves its own first tab.
      const inOwn = group === undefined || group.windowId === own.id;
      const started = await startClosingOwnWindow(own, inOwn ? group?.id : undefined);
      if (started !== undefined && inOwn) return started;
    }
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

  /**
   * Closes the session's window when every tab in it is blank and in the group, or is the
   * window's own first tab, and another window stays open.
   */
  async function startClosingOwnWindow(
    own: OwnWindow,
    groupId: number | undefined,
  ): Promise<{ removed: Promise<void>; groupId: number | undefined } | undefined> {
    if (!(await anotherWindowStays(own.id))) return;
    // The last read before the removal.
    const windowTabs = await browser.tabs.query({ windowId: own.id });
    if (windowTabs.length === 0) return;
    const promptPage = browser.runtime.getURL(PROMPT_PAGE);
    const closable = windowTabs.every(
      (tab) =>
        (groupId !== undefined && tab.groupId === groupId && isBlank(tab, promptPage, blankPage)) ||
        (tab.id === own.first && isFirstTabUnused(tab)),
    );
    if (!closable) return;
    const removal = () => browser.windows.remove(own.id);
    return {
      removed: removeTabs(
        windowTabs.map((tab) => tab.id),
        removal,
      ),
      groupId,
    };
  }

  /** Closing the last window quits Firefox. */
  async function anotherWindowStays(windowId: number): Promise<boolean> {
    const windows = await browser.windows.getAll({ windowTypes: ["normal"], populate: true });
    return windows.some(
      (window) =>
        window.id !== windowId && (window.tabs ?? []).some((tab) => !removing.has(tab.id)),
    );
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
   * Records the tabs as being removed and asks Firefox to remove them, with `closeWindow` when
   * given, both before it returns. The promise settles once Firefox has removed them, refused to,
   * or the user kept them; it carries a handler, so a caller may stop waiting for it.
   */
  function removeTabs(tabIds: number[], closeWindow?: () => Promise<void>): Promise<void> {
    const removal = askFirefoxToRemove(tabIds, closeWindow);
    removal.catch(() => undefined);
    return removal;
  }

  async function askFirefoxToRemove(
    tabIds: number[],
    closeWindow: (() => Promise<void>) | undefined,
  ): Promise<void> {
    // Each ask holds its own claim, so an earlier removal not yet ended keeps counting its tabs.
    for (const id of tabIds) removing.set(id, (removing.get(id) ?? 0) + 1);
    try {
      await (closeWindow === undefined ? browser.tabs.remove(tabIds) : closeWindow());
    } catch (error) {
      for (const id of tabIds) release(id);
      throw error;
    }
    // windows.remove settles once any window has closed, maybe before this one: its tabs count as
    // going until onRemoved.
    if (closeWindow !== undefined) return;
    // Firefox also settles the removal when the user chooses to stay on the page.
    const kept = await Promise.all(
      tabIds
        .filter((id) => removing.has(id))
        .map((id) =>
          browser.tabs.get(id).then(
            () => id,
            () => undefined,
          ),
        ),
    );
    for (const id of kept) if (id !== undefined) release(id);
  }

  function release(id: number): void {
    const count = removing.get(id);
    if (count === undefined) return;
    if (count > 1) removing.set(id, count - 1);
    else removing.delete(id);
  }

  function forget(session: string, id: number): void {
    if (groups.get(session) !== id) return;
    groups.delete(session);
    // A window whose first tab is pending is still being set up for the session; once settled, a
    // window that outlives the group may be the user's by then.
    if (ownWindows.get(session)?.firstPending === false) ownWindows.delete(session);
  }

  function tabRemoved(
    tabId: number,
    { windowId, isWindowClosing }: { windowId: number; isWindowClosing: boolean },
  ): void {
    removing.delete(tabId);
    for (const [session, own] of ownWindows) {
      if (own.first === tabId) own.firstPending = false;
      else if (!isWindowClosing && own.id === windowId && own.firstPending) {
        // The session's first tab failed and was removed: the window holds only its own tab.
        serialize(session, () => closeIfOnlyFirst(session, own)).catch(() => {});
      }
    }
  }

  /** In the order endSession takes them: the session's turn, then the closing turn. */
  async function closeIfOnlyFirst(session: string, own: OwnWindow): Promise<void> {
    const step = closing.catch(() => undefined).then(() => startClosingIfOnlyFirst(session, own));
    closing = step;
    const started = await step;
    if (started !== undefined) await started.removed;
  }

  async function startClosingIfOnlyFirst(
    session: string,
    own: OwnWindow,
  ): Promise<{ removed: Promise<void> } | undefined> {
    if (!own.firstPending) return;
    const stays = await anotherWindowStays(own.id);
    // The last read before the removal.
    const windowTabs = await browser.tabs.query({ windowId: own.id });
    const first = windowTabs.find((tab) => tab.id === own.first);
    if (
      !own.firstPending ||
      first === undefined ||
      !windowTabs.every((tab) => tab.id === own.first || removing.has(tab.id))
    ) {
      return;
    }
    if (!isFirstTabUnused(first)) {
      // The user took the first tab over before the session's tab was selected: the window is
      // theirs now, and `forget` drops it along with the session's group.
      own.firstPending = false;
      return;
    }
    if (!stays) return;
    if (ownWindows.get(session) === own) ownWindows.delete(session);
    const removal = () => browser.windows.remove(own.id);
    return {
      removed: removeTabs(
        windowTabs.map((tab) => tab.id),
        removal,
      ),
    };
  }

  /** The session's tab was selected in its window: the window's own first tab has done its job. */
  function removeFirstTab(tabId: number, windowId: number): void {
    for (const own of ownWindows.values()) {
      if (own.id !== windowId || !own.firstPending || tabId === own.first) continue;
      own.firstPending = false;
      // Not awaited: its removal carries a handler.
      closeTab(own.first, (tab) => {
        // A first tab the user typed an address into, or grouped, is the user's now.
        if (tab.windowId !== windowId || !isFirstTabUnused(tab)) {
          throw new Error("The window's first tab is in use.");
        }
      }).catch(() => {});
    }
  }
}

interface OwnWindow {
  id: number;
  /** The blank tab Firefox opened the window with, kept for the window's life. */
  first: number;
  /**
   * True until the session takes `first` as its blank tab, another tab is selected in the
   * window, or `first` is removed.
   */
  firstPending: boolean;
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
