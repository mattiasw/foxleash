import type { BrowserApi, Timers } from "./browser-api.ts";
import { createConnection } from "./connection.ts";
import { createConsoleRecording } from "./console-recording.ts";
import { createDownloads } from "./downloads.ts";
import { createHandlers } from "./handlers.ts";
import { createIndicator } from "./indicator.ts";
import { createNetworkLog } from "./network-log.ts";
import { createPageScripts } from "./page-scripts.ts";
import { probePage } from "./probe-page.ts";
import { createRecipePrompts, type RecipePrompts } from "./recipe-prompts.ts";
import { createSessionGroups } from "./session-groups.ts";
import { createSiteAccess } from "./site-access.ts";
import { createTabNavigations } from "./tab-navigations.ts";
import { createUploads } from "./uploads.ts";

declare const browser: BrowserApi;

// Wrapped: Firefox's setTimeout throws when called on anything but the window.
const timers: Timers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

const groups = createSessionGroups(
  browser,
  (tabId) => indicator.refresh(tabId),
  (url) => recipes.isBlankPage(url),
);
const indicator = createIndicator({ browser, groups });
const access = createSiteAccess({
  browser,
  groups,
  sessions: new Map(),
  timers,
  onWithdraw: (session, site) => {
    recordings.withdraw(session, site);
    network.withdraw(session, site);
  },
  otherPrompt: (session) => recipes.openPrompt(session),
});
const recipes: RecipePrompts = createRecipePrompts({ browser, groups, access, timers });
const recordings = createConsoleRecording({ browser, groups, access, timers });
const network = createNetworkLog({ browser, groups, access });
const navigations = createTabNavigations({ browser, timers });
const pages = createPageScripts({ browser, groups, access, timers, navigations });
const uploads = createUploads(timers);
// Wrapped for the same reason as the timers.
const downloads = createDownloads({
  browser,
  access,
  timers,
  fetch: (url, init) => fetch(url, init),
  objectUrls: {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
});
const handleRequest = createHandlers({
  browser,
  groups,
  timers,
  access,
  probe: probePage,
  pages,
  navigations,
  uploads,
  recordings,
  network,
  downloads,
  recipes,
});
const connection = createConnection({
  browser,
  handleRequest,
  endSession: (session) => {
    access.endSession(session);
    uploads.endSession(session);
    recipes.endSession(session);
    return groups.endSession(session);
  },
  timers,
});

connection.start();
// Firefox starts an event page at browser launch only when it listens for one of these.
browser.runtime.onStartup.addListener(() => connection.start());
browser.runtime.onInstalled.addListener(() => connection.start());
