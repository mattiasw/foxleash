import type { BrowserApi, Timers } from "./browser-api.ts";
import { createConnection } from "./connection.ts";
import { createHandlers } from "./handlers.ts";
import { createSessionGroups } from "./session-groups.ts";
import { createSiteAccess } from "./site-access.ts";

declare const browser: BrowserApi;

// Wrapped: Firefox's setTimeout throws when called on anything but the window.
const timers: Timers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

const groups = createSessionGroups(browser);
const access = createSiteAccess({ browser, sessions: new Map() });
const handleRequest = createHandlers({ browser, groups, timers, access });
const connection = createConnection({
  browser,
  handleRequest,
  endSession: (session) => groups.endSession(session),
  timers,
});

connection.start();
// Firefox starts an event page at browser launch only when it listens for one of these.
browser.runtime.onStartup.addListener(() => connection.start());
browser.runtime.onInstalled.addListener(() => connection.start());
