import type { BrowserApi } from "./browser-api.ts";
import { DEFAULT_BLOCKLIST } from "./default-blocklist.ts";
import { warn } from "./log.ts";
import { normalizeDomain, siteOf } from "./site.ts";

/** A site allowed always is stored as `site:<site>` holding `{ grantedAt }`, one key per site. */
export const SITE_KEY_PREFIX = "site:";

const BLOCKLIST_KEY = "blocklist";

export type SettingsBrowser = Pick<BrowserApi, "storage">;

export interface Settings {
  /** The sites allowed always, sorted. */
  sites: string[];
  /** The user's blocklist, normalized; undefined when none is stored or it is malformed. */
  blocklist: string[] | undefined;
}

/**
 * Reads the site grants and the blocklist, ignoring (and warning about) every other key and every
 * malformed one.
 */
export async function readSettings(browser: SettingsBrowser): Promise<Settings> {
  const items = await browser.storage.local.get(null);
  const sites: string[] = [];
  let blocklist: string[] | undefined;
  for (const key of Object.keys(items)) {
    if (key === BLOCKLIST_KEY) {
      blocklist = storedBlocklist(items[key]);
      continue;
    }
    const site = grantedSite(key, items[key]);
    if (site === undefined) warn({ event: "ignored_setting", key });
    else sites.push(site);
  }
  return { sites: sites.sort(), blocklist };
}

/** The user's blocklist when one is stored, else the built-in one. */
export function effectiveBlocklist(settings: Settings): readonly string[] {
  return settings.blocklist ?? DEFAULT_BLOCKLIST;
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

/** A non-empty list that kept no valid entry is ignored too, so the built-in list applies. */
function storedBlocklist(value: unknown): string[] | undefined {
  // Array.from turns holes into undefined, which every() would skip.
  const entries = Array.isArray(value) ? Array.from(value) : undefined;
  if (
    entries === undefined ||
    !entries.every((entry: unknown): entry is string => typeof entry === "string")
  ) {
    warn({ event: "ignored_setting", key: BLOCKLIST_KEY });
    return undefined;
  }
  const patterns = new Set<string>();
  entries.forEach((entry, index) => {
    const result = normalizeDomain(entry);
    if ("error" in result) warn({ event: "ignored_blocklist_entry", index, reason: result.error });
    else patterns.add(result.host);
  });
  if (entries.length > 0 && patterns.size === 0) {
    warn({ event: "ignored_setting", key: BLOCKLIST_KEY });
    return undefined;
  }
  return [...patterns];
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
