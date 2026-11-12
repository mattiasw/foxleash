import type { BrowserApi } from "./browser-api.ts";
import { warn } from "./log.ts";
import type { SessionGroups } from "./session-groups.ts";

const BADGE_ON = "ON";
const TITLE_ON = "Foxleash: an agent session can use this tab";
// The manifest's default_title.
const TITLE_OFF = "Foxleash";

export interface Indicator {
  /** Sets the tab's badge and title from its current group; never rejects. */
  refresh(tabId: number): Promise<void>;
}

/**
 * Shows ON on the toolbar button for tabs in a session's group, and opens the settings on a
 * click. Registers its listeners at once, so the event page can be started for them.
 */
export function createIndicator({
  browser,
  groups,
}: {
  browser: BrowserApi;
  groups: Pick<SessionGroups, "isSessionGroup">;
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

  return { refresh };

  async function show(tabId: number, groupId: number | undefined): Promise<void> {
    const on = groups.isSessionGroup(groupId);
    try {
      await Promise.all([
        browser.action.setBadgeText({ tabId, text: on ? BADGE_ON : "" }),
        browser.action.setTitle({ tabId, title: on ? TITLE_ON : TITLE_OFF }),
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
}
