import { createActSettle } from "./act-settle.ts";
import type { BrowserApi, Timers } from "./browser-api.ts";
import { createConnection } from "./connection.ts";
import { createConsoleRecording } from "./console-recording.ts";
import { createDownloads } from "./downloads.ts";
import { watchInstall } from "./first-run.ts";
import { createHandlers } from "./handlers.ts";
import { createIndicator } from "./indicator.ts";
import { createNetworkLog } from "./network-log.ts";
import { createPageScripts } from "./page-scripts.ts";
import { createPageViews } from "./page-view.ts";
import { probePage } from "./probe-page.ts";
import { createRecipePrompts, type RecipePrompts } from "./recipe-prompts.ts";
import { answerAs } from "./served-protocols.ts";
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
const indicator = createIndicator({
  browser,
  groups,
  stopped: (session) => access.stopped(session),
});
const access = createSiteAccess({
  browser,
  groups,
  sessions: new Map(),
  timers,
  otherPrompt: (session) => recipes.openPrompt(session),
});
const recipes: RecipePrompts = createRecipePrompts({ browser, groups, access, timers });
access.onStop((session) => {
  recipes.endSession(session);
  void indicator.refreshSession(session);
});
const recordings = createConsoleRecording({
  browser,
  groups,
  access,
  timers,
  now: () => Date.now(),
});
const network = createNetworkLog({ browser, groups, access, now: () => Date.now() });
const views = createPageViews({ browser, groups, access });
const navigations = createTabNavigations({ browser, timers });
const pages = createPageScripts({ browser, groups, access, timers, navigations });
const settle = createActSettle({
  browser,
  groups,
  access,
  timers,
  navigations,
  network,
  pages,
  now: () => Date.now(),
});
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
  settle,
  views,
  now: () => Date.now(),
});
const connection = createConnection({
  browser,
  handleRequest: (request, protocol) => answerAs(protocol, request, handleRequest),
  endSession: (session) => {
    access.endSession(session);
    uploads.endSession(session);
    views.endSession(session);
    recipes.endSession(session);
    return groups.endSession(session);
  },
  timers,
  onStateChange: (state) => void indicator.showProgram(state),
});

connection.start();
// Firefox starts an event page at browser launch only when it listens for one of these.
browser.runtime.onStartup.addListener(() => connection.start());
browser.runtime.onInstalled.addListener(() => connection.start());
watchInstall({ browser });
