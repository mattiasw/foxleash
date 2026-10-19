import type { BrowserApi } from "./browser-api.ts";
import { warn } from "./log.ts";
import { siteOf } from "./site.ts";

/** A site allowed always is stored as `site:<site>` holding `{ grantedAt }`, one key per site. */
export const SITE_KEY_PREFIX = "site:";

export type SettingsBrowser = Pick<BrowserApi, "storage">;

export interface Settings {
  /** The sites allowed always, sorted. */
  sites: string[];
}

/** Reads the stored settings, ignoring (and warning about) every key that is not a site grant. */
export async function readSettings(browser: SettingsBrowser): Promise<Settings> {
  const items = await browser.storage.local.get(null);
  const sites: string[] = [];
  for (const key of Object.keys(items)) {
    const site = grantedSite(key, items[key]);
    if (site === undefined) warn({ event: "ignored_setting", key });
    else sites.push(site);
  }
  return { sites: sites.sort() };
}

export function grantSite(browser: SettingsBrowser, site: string): Promise<void> {
  return browser.storage.local.set({
    [SITE_KEY_PREFIX + site]: { grantedAt: new Date().toISOString() },
  });
}

export function revokeSite(browser: SettingsBrowser, site: string): Promise<void> {
  return browser.storage.local.remove(SITE_KEY_PREFIX + site);
}

/** Calls `listener` whenever the stored settings change. */
export function onSettingsChanged(browser: SettingsBrowser, listener: () => void): void {
  browser.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName === "local") listener();
  });
}

function grantedSite(key: string, value: unknown): string | undefined {
  if (!key.startsWith(SITE_KEY_PREFIX)) return undefined;
  const site = key.slice(SITE_KEY_PREFIX.length);
  if (siteOf(site) !== site) return undefined;
  if (!isRecord(value) || !Object.hasOwn(value, "grantedAt")) return undefined;
  return typeof value.grantedAt === "string" ? site : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
