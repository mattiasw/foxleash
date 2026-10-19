import type { TabInfo } from "@foxhand/protocol";
import type { BrowserApi, Tab } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { effectiveBlocklist, readSettings } from "./settings.ts";
import { hostOf, matchesDomain, redactedUrl, siteOf } from "./site.ts";

/** Per MCP session, the sites approved for that session only. A Map: `__proto__` is a valid id. */
export type SessionMemory = Map<string, { allowed: Set<string> }>;

export interface SiteAccessDeps {
  browser: Pick<BrowserApi, "storage">;
  sessions: SessionMemory;
}

export interface SiteAccess {
  /** What one session may see, as stored and granted at the time of the call. */
  view(session: string): Promise<SiteView>;
  /**
   * The gate before a load: throws `invalid_url` for a URL with no site and `site_blocked` for a
   * blocked one. Changes nothing.
   */
  check(session: string, url: string): Promise<{ decision: "allowed" | "ask" }>;
}

export interface SiteView {
  /** Whether the URL's site is on the effective blocklist. */
  blocked(url: string): boolean;
  allowed(url: string): boolean;
  /** The tab as the agent sees it: in full on an allowed site, otherwise redacted. */
  tabInfo(tab: Tab): TabInfo;
}

export function createSiteAccess({ browser, sessions }: SiteAccessDeps): SiteAccess {
  return { view, check };

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

  async function check(session: string, url: string): Promise<{ decision: "allowed" | "ask" }> {
    const site = siteOf(url);
    if (site === undefined) {
      throw new ToolError("invalid_url", "Foxhand acts only on http and https URLs.");
    }
    const current = await view(session);
    if (current.blocked(url)) {
      throw new ToolError(
        "site_blocked",
        `Foxhand does not act on ${site}: it is on Foxhand's blocklist, which by default lists common financial and health sites.`,
      );
    }
    return { decision: current.allowed(url) ? "allowed" : "ask" };
  }
}
