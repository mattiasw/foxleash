import type { BrowserApi } from "./browser-api.ts";
import type { ProgramState } from "./connection.ts";
import { warn } from "./log.ts";
import type { SessionGroups } from "./session-groups.ts";

const BADGE_ON = "ON";
const TITLE_ON = "Foxleash: an agent session can use this tab";
const TITLE_STOPPED = "Foxleash: the agent session of this tab was stopped";
const BADGE_PROGRAM = "!";
/** The button's title in each state of the program that needs the user. */
const PROGRAM_TITLES: Readonly<Record<"too_old" | "addon_older", string>> = {
  too_old:
    "Foxleash: the program on this computer is too old for this add-on. Open the settings to see what to do.",
  addon_older:
    "Foxleash: this add-on is older than the program on this computer. Open the settings to see what to do.",
};

export interface Indicator {
  /** Sets the tab's badge and title from its current group; never rejects. */
  refresh(tabId: number): Promise<void>;
  /** Sets the badge and title of every tab in the session's group; never rejects. */
  refreshSession(session: string): Promise<void>;
  /** Sets the button's global badge and title from the program's state; never rejects. */
  showProgram(state: ProgramState): Promise<void>;
}

/**
 * Shows ON on the toolbar button for tabs in a session's group, unless the user stopped that
 * session, and ! elsewhere while the program needs the user, and opens the settings on a click.
 * Registers its listeners at once, so the event page can be started for them.
 */
export function createIndicator({
  browser,
  groups,
  stopped,
}: {
  browser: BrowserApi;
  groups: Pick<SessionGroups, "sessionOf" | "groupOf">;
  stopped: (session: string) => boolean;
}): Indicator {
  // Every update: Firefox clears a tab's badge and title when it navigates to another document.
  browser.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    void show(tabId, tab.groupId);
  });
  browser.tabs.onCreated.addListener((tab) => {
    void show(tab.id, tab.groupId);
  });
  browser.action.onClicked.addListener(() => {
    void openSettings();
  });

  return { refresh, refreshSession, showProgram };

  async function show(tabId: number, groupId: number | undefined): Promise<void> {
    const session = groups.sessionOf(groupId);
    const halted = session !== undefined && stopped(session);
    const on = session !== undefined && !halted;
    // Null removes the tab's own value, so the tab shows the global one.
    const text = on ? BADGE_ON : halted ? "" : null;
    const title = on ? TITLE_ON : halted ? TITLE_STOPPED : null;
    try {
      await Promise.all([
        browser.action.setBadgeText({ tabId, text }),
        browser.action.setTitle({ tabId, title }),
      ]);
    } catch (error) {
      warn({ event: "indicator_failed", tabId, error: String(error) });
    }
  }

  async function openSettings(): Promise<void> {
    try {
      await browser.runtime.openOptionsPage();
    } catch (error) {
      warn({ event: "open_settings_failed", error: String(error) });
    }
  }

  async function refresh(tabId: number): Promise<void> {
    try {
      const tab = await browser.tabs.get(tabId);
      await show(tabId, tab.groupId);
    } catch (error) {
      warn({ event: "indicator_failed", tabId, error: String(error) });
    }
  }

  async function refreshSession(session: string): Promise<void> {
    try {
      const group = await groups.groupOf(session);
      if (group === undefined) return;
      const tabs = await browser.tabs.query({ groupId: group.id });
      await Promise.all(tabs.map((tab) => show(tab.id, tab.groupId)));
    } catch (error) {
      warn({ event: "indicator_failed", session, error: String(error) });
    }
  }

  async function showProgram(state: ProgramState): Promise<void> {
    const notice = state === "too_old" || state === "addon_older";
    try {
      await Promise.all([
        browser.action.setBadgeText({ text: notice ? BADGE_PROGRAM : "" }),
        browser.action.setTitle({ title: notice ? PROGRAM_TITLES[state] : null }),
      ]);
    } catch (error) {
      warn({ event: "indicator_failed", state, error: String(error) });
    }
  }
}
