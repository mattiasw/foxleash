import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { CHECKOUT, createHarness, EXTENSION_DIST, tabOf } from "./harness.ts";

// A public page with no account, ads or banner. The view is fixed because the bare front page
// centres the map on the visitor's country.
const FIRST_PAGE = "https://www.openstreetmap.org/#map=4/50/10";
const SECOND_PAGE = "https://www.openstreetmap.org/about";
// AMO's recommended screenshot size.
const SCREEN = { width: 1280, height: 800 };
const SCREENSHOTS = join(CHECKOUT, "docs", "amo", "screenshots");
const CAPTURE_TIMEOUT_MS = 30_000;
const COMMAND = `xvfb-run --auto-servernum --server-args='-screen 0 ${SCREEN.width}x${SCREEN.height}x24' npm run screenshots:amo`;
// Copied from apps/extension/src/program-status.ts, which the e2e type check cannot load.
const CONNECTED = "The Foxleash program is connected.";
const PROMPT_SHOT = "1-approval-prompt.png";
const TAB_GROUP_SHOT = "2-tab-group.png";
const SETTINGS_SHOT = "3-settings.png";
const SHOTS = [PROMPT_SHOT, TAB_GROUP_SHOT, SETTINGS_SHOT];

const FILL_SCREEN = `browser.windows.getCurrent().then((window) => browser.windows.update(window.id, {
  state: "normal", left: 0, top: 0, width: ${SCREEN.width}, height: ${SCREEN.height},
})).then(() => true)`;
const WINDOW_RECT = `browser.windows.getCurrent().then((window) =>
  [window.left, window.top, window.width, window.height].join(","))`;
const FILLED = `0,0,${SCREEN.width},${SCREEN.height}`;
const PROMPT_QUESTION = 'document.getElementById("heading").textContent';
const UNARMED = `document.querySelectorAll('button[data-answer][aria-disabled="true"]').length`;
// Images outside the viewport load lazily and may never complete. An image that failed to load
// is complete too, so a drawn one also needs a natural width.
const DRAWING = `(() => {
  const pending = Array.from(document.images).filter((image) => {
    const box = image.getBoundingClientRect();
    const inView = box.width > 0 && box.bottom > 0 && box.right > 0 &&
      box.top < window.innerHeight && box.left < window.innerWidth;
    return inView && !(image.complete && image.naturalWidth > 0);
  });
  return document.readyState + " " + document.fonts.status + ", " + pending.length +
    " images in view not drawn";
})()`;
const DRAWN = "complete loaded, 0 images in view not drawn";
const NEXT_FRAMES =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";
// program-update names an AI client in its text, so it must be hidden in the shot.
const SETTINGS_STATE = `JSON.stringify({
  status: document.getElementById("program-status").textContent,
  setupHidden: document.getElementById("program-setup").hidden,
  updateHidden: document.getElementById("program-update").hidden,
  addonUpdateHidden: document.getElementById("program-addon-update").hidden,
  answersHidden: document.getElementById("answers").hidden,
})`;
const SETTINGS_SHOWN = JSON.stringify({
  status: CONNECTED,
  setupHidden: true,
  updateHidden: true,
  addonUpdateHidden: true,
  answersHidden: false,
});

// biome-ignore lint/suspicious/noUndeclaredEnvVars: npm runs this script, not a turbo task
const display = process.env.DISPLAY;
if (display === undefined || display === "") {
  console.error(
    `There is no X display. Run this under xvfb-run with a ${SCREEN.width}x${SCREEN.height}x24 screen: ${COMMAND}`,
  );
  process.exit(1);
}

const harness = createHarness();
try {
  harness.install();
  const firefox = await harness.startFirefox(EXTENSION_DIST, { headless: false });
  await fillScreen(firefox, await harness.settingsPage());
  const session = await harness.connect();
  await harness.waitUntilReady(session);

  const opening = harness.ok(session, "tab_open", { url: FIRST_PAGE });
  opening.catch(() => undefined);
  const prompt = await harness.promptContext();
  const origin = new URL(FIRST_PAGE).origin;
  await pollUntil(
    async () => {
      const question = await firefox.evaluate(prompt, PROMPT_QUESTION);
      if (typeof question === "string" && question.includes(origin)) return true;
      throw new Error(`the prompt asks ${JSON.stringify(question)}`);
    },
    PAGE_TIMEOUT_MS,
    `the prompt to ask about ${origin}`,
  );
  await harness.waitForArmed(prompt);
  await drawn(firefox, prompt);
  capture(display, harness.root, PROMPT_SHOT);
  const unarmed = await firefox.evaluate(prompt, UNARMED);
  if (unarmed !== 0) {
    throw new Error(
      `the prompt's buttons were not armed when its screenshot was taken: ${String(unarmed)} unarmed`,
    );
  }
  await firefox.click(prompt, 'button[data-answer="once"]');

  const first = await contextOf(firefox, tabOf(await opening).url);
  tabOf(await harness.ok(session, "tab_open", { url: SECOND_PAGE }));
  await firefox.activate(first);
  await drawn(firefox, first);
  capture(display, harness.root, TAB_GROUP_SHOT);

  const settings = await harness.settingsPage();
  await firefox.activate(settings);
  await pollUntil(
    async () => {
      const state = await firefox.evaluate(settings, SETTINGS_STATE);
      if (state === SETTINGS_SHOWN) return true;
      throw new Error(`the page shows ${String(state)}`);
    },
    PAGE_TIMEOUT_MS,
    "the settings page to show the connected program and the running session",
  );
  await drawn(firefox, settings);
  capture(display, harness.root, SETTINGS_SHOT);

  // Copied only once all three exist, so a failed run never leaves a mixed set.
  mkdirSync(SCREENSHOTS, { recursive: true });
  for (const name of SHOTS) {
    const target = join(SCREENSHOTS, name);
    copyFileSync(join(harness.root, name), target);
    console.error(`wrote ${relative(CHECKOUT, target)}`);
  }
} finally {
  try {
    await harness.close();
  } catch (error: unknown) {
    console.error("closing the browser and the temp folder failed:", error);
    process.exitCode = 1;
  }
}

/** Sizes the window to the screen. Under Xvfb no window manager maximizes it. */
async function fillScreen(firefox: Firefox, settings: string): Promise<void> {
  await firefox.evaluate(settings, FILL_SCREEN);
  await pollUntil(
    async () => {
      const rect = await firefox.evaluate(settings, WINDOW_RECT);
      if (rect === FILLED) return true;
      throw new Error(`the window is at ${String(rect)} (left, top, width, height)`);
    },
    PAGE_TIMEOUT_MS,
    `the window to fill the ${SCREEN.width}x${SCREEN.height} screen`,
  );
  await firefox.closeContext(settings);
}

/** Waits until the page has loaded its fonts and the images in view, then for two frames. */
async function drawn(firefox: Firefox, context: string): Promise<void> {
  await pollUntil(
    async () => {
      const state = await firefox.evaluate(context, DRAWING);
      if (state === DRAWN) return true;
      throw new Error(`the page reports ${String(state)}`);
    },
    PAGE_TIMEOUT_MS,
    "the page to finish drawing",
  );
  await firefox.evaluate(context, NEXT_FRAMES);
}

/** Captures the whole screen, the window with its tab strip and toolbar, into `folder/name`. */
function capture(display: string, folder: string, name: string): void {
  const file = join(folder, name);
  const result = spawnSync(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "x11grab",
      // Otherwise the X pointer is drawn in the shot.
      "-draw_mouse",
      "0",
      "-video_size",
      `${SCREEN.width}x${SCREEN.height}`,
      "-i",
      display,
      "-frames:v",
      "1",
      file,
    ],
    { encoding: "utf8", timeout: CAPTURE_TIMEOUT_MS },
  );
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? `exit status ${String(result.status)}`;
    const missing =
      result.error !== undefined && "code" in result.error && result.error.code === "ENOENT";
    // spawnSync leaves stderr undefined when ffmpeg could not be started.
    const detail = missing ? "ffmpeg must be installed" : (result.stderr ?? "").trim();
    throw new Error(`capturing ${name} with ffmpeg failed (${reason}): ${detail}`);
  }
}

/** The tab showing `url`, whatever its fragment: OpenStreetMap rewrites it as the map settles. */
function contextOf(firefox: Firefox, url: string): Promise<string> {
  const wanted = withoutFragment(url);
  return firefox.waitForContext(
    (context) => withoutFragment(context.url) === wanted,
    PAGE_TIMEOUT_MS,
  );
}

function withoutFragment(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}
