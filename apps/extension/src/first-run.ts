import type { BrowserApi, InstalledDetails } from "./browser-api.ts";
import { warn } from "./log.ts";

/** The page that opens once, when Firefox installs the add-on. */
export const WELCOME_PAGE = "welcome.html";

/**
 * Opens the welcome page when Firefox installs the add-on, temporary installs included, and on
 * no update. Call it at load: Firefox starts an event page for `onInstalled` only when it listens
 * then.
 */
export function watchInstall({ browser }: { browser: Pick<BrowserApi, "runtime" | "tabs"> }): void {
  browser.runtime.onInstalled.addListener(installed);

  function installed(details: InstalledDetails): void {
    if (details.reason !== "install") return;
    browser.tabs
      .create({ url: browser.runtime.getURL(WELCOME_PAGE), active: true })
      .catch((error: unknown) => warn({ event: "open_welcome_failed", error: String(error) }));
  }
}
