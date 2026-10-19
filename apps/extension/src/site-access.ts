import type { TabInfo } from "@foxhand/protocol";
import type { BrowserApi, Tab } from "./browser-api.ts";
import { readSettings } from "./settings.ts";
import { redactedUrl, siteOf } from "./site.ts";

/** Per MCP session, the sites approved for that session only. A Map: `__proto__` is a valid id. */
export type SessionMemory = Map<string, { allowed: Set<string> }>;

export interface SiteAccessDeps {
  browser: Pick<BrowserApi, "storage">;
  sessions: SessionMemory;
}

export interface SiteAccess {
  /** What one session may see, as stored and granted at the time of the call. */
  view(session: string): Promise<SiteView>;
}

export interface SiteView {
  allowed(url: string): boolean;
  /** The tab as the agent sees it: in full on an allowed site, otherwise redacted. */
  tabInfo(tab: Tab): TabInfo;
}

export function createSiteAccess({ browser, sessions }: SiteAccessDeps): SiteAccess {
  return {
    view: async (session) => {
      const stored = new Set((await readSettings(browser)).sites);
      const granted = sessions.get(session);
      const allowed = (url: string): boolean => {
        const site = siteOf(url);
        return site !== undefined && (stored.has(site) || granted?.allowed.has(site) === true);
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
      return { allowed, tabInfo };
    },
  };
}
