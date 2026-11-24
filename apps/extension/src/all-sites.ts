import type { BrowserApi } from "./browser-api.ts";

/** Whether Firefox gives Foxleash access to all websites; an answer that fails counts as no. */
export async function mayReachAllSites(browser: Pick<BrowserApi, "permissions">): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    return false;
  }
}
