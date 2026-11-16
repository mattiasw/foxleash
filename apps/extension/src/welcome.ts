import type { BrowserApi, Timers } from "./browser-api.ts";
import { element } from "./page-ui.ts";
import { watchProgram } from "./program-status.ts";

declare const browser: { runtime: Pick<BrowserApi["runtime"], "sendMessage"> };

// Wrapped: Firefox's setTimeout throws when called on anything but the window.
const timers: Timers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

watchProgram({
  elements: {
    status: element("program-status", "welcome page"),
    setup: element("program-setup", "welcome page"),
    command: element("program-command", "welcome page"),
    requirement: element("program-requirement", "welcome page"),
  },
  browser,
  page: document,
  timers,
});
