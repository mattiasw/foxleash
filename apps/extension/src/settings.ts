import type { BrowserApi } from "./browser-api.ts";
import { DEFAULT_BLOCKLIST } from "./default-blocklist.ts";
import { warn } from "./log.ts";
import { normalizeDomain, siteOf } from "./site.ts";

/** A site allowed always is stored as `site:<site>` holding `{ grantedAt }`, one key per site. */
export const SITE_KEY_PREFIX = "site:";

/** A recipe is stored as `recipe:<name>`; recipes.ts reads and writes them. */
export const RECIPE_KEY_PREFIX = "recipe:";

/**
 * The highest document tag number page-scripts.ts has reserved, so tags never repeat across
 * restarts; not a setting.
 */
export const TAG_MARK_KEY = "tagMark";

const BLOCKLIST_KEY = "blocklist";
const SESSION_WINDOW_KEY = "sessionWindow";

export type SettingsBrowser = Pick<BrowserApi, "storage">;

export interface Settings {
  /** The sites allowed always, sorted. */
  sites: string[];
  /** The user's blocklist, normalized; undefined when none is stored or it is malformed. */
  blocklist: string[] | undefined;
  /** Whether each agent session opens in its own window; false unless `true` is stored. */
  sessionWindow: boolean;
}

/**
 * Reads the site grants, the blocklist and the session window setting, ignoring recipes, and
 * ignoring (and warning about) every other key and every malformed one.
 */
export async function readSettings(browser: SettingsBrowser): Promise<Settings> {
  const items = await browser.storage.local.get(null);
  const sites: string[] = [];
  let blocklist: string[] | undefined;
  let sessionWindow = false;
  for (const key of Object.keys(items)) {
    if (key === BLOCKLIST_KEY) {
      blocklist = storedBlocklist(items[key]);
      continue;
    }
    if (key === SESSION_WINDOW_KEY) {
      sessionWindow = items[key] === true;
      if (!sessionWindow) warn({ event: "ignored_setting", key });
      continue;
    }
    if (key.startsWith(RECIPE_KEY_PREFIX) || key === TAG_MARK_KEY) continue;
    const site = grantedSite(key, items[key]);
    if (site === undefined) warn({ event: "ignored_setting", key });
    else sites.push(site);
  }
  return { sites: sites.sort(), blocklist, sessionWindow };
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

/**
 * Stores the blocklist, `patterns` as `parseBlocklist` returns them. The built-in set is stored
 * as no key, so later built-in additions apply.
 */
export function saveBlocklist(
  browser: SettingsBrowser,
  patterns: readonly string[],
): Promise<void> {
  const saved = new Set(patterns);
  const builtIn = new Set(DEFAULT_BLOCKLIST);
  if (saved.size === builtIn.size && [...saved].every((pattern) => builtIn.has(pattern))) {
    return browser.storage.local.remove(BLOCKLIST_KEY);
  }
  return browser.storage.local.set({ [BLOCKLIST_KEY]: [...patterns] });
}

/** Stores the session window setting; off is stored as no key. */
export function saveSessionWindow(browser: SettingsBrowser, on: boolean): Promise<void> {
  if (!on) return browser.storage.local.remove(SESSION_WINDOW_KEY);
  return browser.storage.local.set({ [SESSION_WINDOW_KEY]: true });
}

/** Calls `listener` whenever the stored settings change. */
export function onSettingsChanged(browser: SettingsBrowser, listener: () => void): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const keys = Object.keys(changes);
    if (keys.length === 1 && keys[0] === TAG_MARK_KEY) return;
    listener();
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
