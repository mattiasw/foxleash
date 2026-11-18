import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EXTENSION_ID, type TabInfo } from "@foxleash/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UNTRUSTED_FRAME } from "../apps/server/src/tools.ts";
import { ensureFirefox } from "../bin/install-firefox.ts";
import {
  describeOutput,
  type Firefox,
  isRecord,
  type LaunchOptions,
  launchFirefox,
  PAGE_TIMEOUT_MS,
  pollUntil,
} from "./firefox.ts";

export const CHECKOUT = join(import.meta.dirname, "..");
export const EXTENSION_DIST = join(CHECKOUT, "apps", "extension", "dist");
const MAIN = join(CHECKOUT, "apps", "server", "src", "main.ts");
const SETTINGS_PAGE = "options.html";
const WELCOME_PAGE = "welcome.html";
const SETTINGS_TITLE = "Foxleash settings";
const PROMPT_PAGE = "approve.html";
// With the focus and visibility the arming reads, so a prompt that never arms says which one
// is missing.
const ARMED_STATE = `(() => {
  const buttons = document.querySelectorAll("button[data-answer]");
  const unarmed = document.querySelectorAll('button[data-answer][aria-disabled="true"]');
  return buttons.length + " buttons, " + unarmed.length + " unarmed; document.hasFocus() " +
    document.hasFocus() + ", document.visibilityState " + document.visibilityState;
})()`;

const SHOWN = "document.hasFocus() true, document.visibilityState visible";
const VIEWPORT = 'window.innerWidth + "x" + window.innerHeight';

// The longest socket path the host can make must fit in sun_path (108 bytes with its NUL).
const MAX_SOCKET_PATH_BYTES = 107;
const LONGEST_SOCKET_TAIL = join("fh-e2e-XXXXXX", "run", "foxleash", "2147483647.sock");
const SOCKET_NAME = /^[1-9][0-9]*\.sock$/;
const TAIL_BYTES = 8 * 1024;
const POLL_MS = 100;
const READY_POLL_MS = 250;
const HOST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 30_000;
// Above the extension's 30 s load wait and below the 60 s per-test timeout, so a call that hangs
// fails here, with the diagnostics, rather than as a bare test timeout.
const CALL_TIMEOUT_MS = 45_000;

export interface ToolResult {
  isError: boolean;
  /** The first text item. */
  text: string;
  /** Every text item, in order. */
  texts: string[];
  /** Every image item, in order. */
  images: { data: string; mimeType: string }[];
}

export interface Session {
  client: Client;
  stderr(): string;
  close(): Promise<void>;
}

type StartOptions = Pick<LaunchOptions, "holdBeforeUnloadPrompts" | "restoreSession"> & {
  /** Leaves open the welcome page the extension opens when it is installed. */
  keepWelcome?: boolean;
};

export interface Harness {
  root: string;
  run: string;
  /** The folder Firefox saves downloads in. */
  downloads: string;
  env: Record<string, string>;
  /** Installs the native host into the temp home only (`install --no-claude --no-extension`). */
  install(): void;
  /**
   * Starts Firefox and installs the extension. The install opens the extension's welcome page,
   * which this waits for and closes unless `keepWelcome`.
   */
  startFirefox(extensionDir: string, options?: StartOptions): Promise<Firefox>;
  /**
   * Quits the Firefox started last and starts Firefox again on the same profile, installing the
   * extension again. Connect a new session afterwards: sessions end with the Firefox that quit.
   * The extension's storage.local carries over, though the add-on is installed again. The quit
   * Firefox's output stays in the diagnostics. Firefox removes a temporary add-on when it quits, so
   * the reinstall is an install again: the welcome page opens and is closed as by `startFirefox`.
   */
  restartFirefox(extensionDir: string, options?: StartOptions): Promise<Firefox>;
  /**
   * Reloads the extension as `browser.runtime.reload()` does, from its settings page, and resolves
   * once the reloaded add-on serves its settings page again. Unlike an install, a reload opens no
   * page.
   */
  reloadExtension(): Promise<void>;
  /**
   * Writes `entries` into the extension's storage.local from its settings page, in the Firefox
   * started last. The only way tests write settings: the extension has no test hook.
   */
  seedSettings(entries: Record<string, unknown>): Promise<void>;
  /** Opens the settings page in a new tab, waits for its first render, and returns the tab. */
  settingsPage(): Promise<string>;
  /** Starts `foxleash mcp`, in `options.cwd` when given. */
  connect(overrides?: Record<string, string>, options?: { cwd?: string }): Promise<Session>;
  /** Waits for a tab showing the approval prompt, other than the tabs in `except`. */
  promptContext(except?: readonly string[]): Promise<string>;
  /** Waits for a tab showing the extension's page `page`, other than the tabs in `except`. */
  pageContext(page: string, except?: readonly string[]): Promise<string>;
  /**
   * Shows and focuses the page's tab, then waits until its answer buttons, three unless given,
   * are armed.
   */
  waitForArmed(context: string, buttons?: number): Promise<void>;
  /**
   * Requires the page's answer buttons, three unless given, to be armed in a focused, visible
   * page; resizes the window through `session`; waits until the page's viewport has changed and
   * its `resize` event has run; then requires every button to be unarmed with the page still
   * focused and visible.
   */
  resizeUnarms(
    session: Session,
    context: string,
    size: { width: number; height: number },
    buttons?: number,
  ): Promise<void>;
  waitForHost(): Promise<number>;
  waitUntilReady(session: Session, accept?: (result: ToolResult) => boolean): Promise<ToolResult>;
  /**
   * Calls a tool and returns its result, whether it failed or not. A call waits `timeoutMs` for
   * its result, 45 s unless given.
   */
  call(
    session: Session,
    name: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResult>;
  /** Calls a tool that must succeed and returns its parsed JSON. */
  ok(
    session: Session,
    name: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** Calls a tool that must fail and returns its text. */
  refused(session: Session, name: string, args?: Record<string, unknown>): Promise<string>;
  /** Runs every teardown step even when one fails, then rethrows the first failure. */
  close(): Promise<void>;
}

/**
 * One temp root per test file: `home/` (HOME), `run/` (XDG_RUNTIME_DIR, mode 0700) and
 * `profile/` (Firefox's). Every child gets the same env, so the install, Firefox, the native host
 * Firefox starts and every `foxleash mcp` meet in this root and never in the developer's own.
 */
export function createHarness(): Harness {
  const root = mkdtempSync(join(tempBase(), "fh-e2e-"));
  const home = join(root, "home");
  const run = join(root, "run");
  const profile = join(root, "profile");
  const downloads = join(home, "Downloads");
  mkdirSync(home);
  mkdirSync(downloads);
  mkdirSync(run, { mode: 0o700 });
  mkdirSync(profile);
  const env = childEnv(home, run);

  // Recorded before their first fallible step, so close() can always reach them.
  const sessions: Session[] = [];
  const firefoxes: Firefox[] = [];
  const hostPids = new Set<number>();
  // A setup hook that times out gets its after() hook at once, while its own awaits run on.
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error("the harness is already closed");
  }

  function diagnostics(session?: Session): string {
    const parts: string[] = [];
    if (session !== undefined) {
      parts.push(
        `\n--- foxleash mcp stderr (last ${TAIL_BYTES} bytes) ---\n${session.stderr() || "(empty)"}`,
      );
    }
    for (const firefox of firefoxes) parts.push(describeOutput(firefox.output()));
    return parts.join("");
  }

  async function call(
    session: Session,
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResult> {
    try {
      return await callTool(session, name, args, timeoutMs);
    } catch (error: unknown) {
      throw new Error(`${name} returned no result: ${messageOf(error)}${diagnostics(session)}`, {
        cause: error,
      });
    }
  }

  async function ok(
    session: Session,
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    const result = await call(session, name, args, timeoutMs);
    if (result.isError) {
      throw new Error(`${name} failed:\n${result.text}${diagnostics(session)}`);
    }
    return parseResult(result.text);
  }

  async function expectArming(
    firefox: Firefox,
    context: string,
    expected: string,
    when: string,
  ): Promise<void> {
    const state = await firefox.evaluate(context, ARMED_STATE);
    if (state !== expected) {
      throw new Error(`${when}, the page has ${String(state)}, not ${expected}${diagnostics()}`);
    }
  }

  function currentFirefox(): Firefox {
    const firefox = firefoxes.at(-1);
    if (firefox === undefined) throw new Error("start Firefox first");
    return firefox;
  }

  /** Opens the settings page and checks it is ours, so a wrong extension UUID fails here. */
  async function openSettingsPage(firefox: Firefox): Promise<string> {
    const context = await firefox.openContext(firefox.extensionUrl(SETTINGS_PAGE));
    const title = await firefox.evaluate(context, "document.title");
    assert.equal(
      title,
      SETTINGS_TITLE,
      `the settings page is titled ${String(title)}${diagnostics()}`,
    );
    return context;
  }

  function pageContext(page: string, except: readonly string[] = []): Promise<string> {
    assertOpen();
    const firefox = currentFirefox();
    const prefix = firefox.extensionUrl(page);
    return firefox.waitForContext(
      (tab) => tab.url.startsWith(prefix) && !except.includes(tab.context),
      PAGE_TIMEOUT_MS,
    );
  }

  async function waitForHost(): Promise<number> {
    const deadline = Date.now() + HOST_TIMEOUT_MS;
    const socketDir = join(run, "foxleash");
    for (;;) {
      const pid = newestHost(socketDir);
      if (pid !== undefined) {
        hostPids.add(pid);
        return pid;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no foxleash host socket appeared in ${socketDir} within ${HOST_TIMEOUT_MS} ms${diagnostics()}`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  async function startFirefox(extensionDir: string, options?: StartOptions): Promise<Firefox> {
    const { keepWelcome = false, ...launch } = options ?? {};
    assertOpen();
    assert.ok(
      existsSync(join(extensionDir, "manifest.json")),
      `${extensionDir} holds no built extension: run npm run build`,
    );
    const binary = await ensureFirefox();
    assertOpen();
    const firefox = await launchFirefox({
      binary,
      profileDir: profile,
      env,
      downloadDir: downloads,
      ...launch,
    });
    if (closed) {
      // close() ran while Firefox started and could not reach it.
      await firefox.close();
      assertOpen();
    }
    firefoxes.push(firefox);
    let id: string;
    try {
      id = await firefox.installExtension(extensionDir);
    } catch (error: unknown) {
      throw new Error(`installing ${extensionDir} failed: ${messageOf(error)}${diagnostics()}`, {
        cause: error,
      });
    }
    assert.equal(id, EXTENSION_ID, `Firefox installed the extension as ${id}${diagnostics()}`);
    if (!keepWelcome) {
      let welcome: string;
      try {
        welcome = await pageContext(WELCOME_PAGE);
      } catch (error: unknown) {
        throw new Error(
          `the extension opened no welcome page: ${messageOf(error)}${diagnostics()}`,
          { cause: error },
        );
      }
      await firefox.closeContext(welcome);
    }
    return firefox;
  }

  return {
    root,
    run,
    downloads,
    env,

    install() {
      assertOpen();
      const result = spawnSync(
        process.execPath,
        [MAIN, "install", "--no-claude", "--no-extension"],
        {
          env,
          encoding: "utf8",
          timeout: INSTALL_TIMEOUT_MS,
        },
      );
      assert.equal(
        result.status,
        0,
        `foxleash install --no-claude --no-extension failed (${result.error?.message ?? `status ${result.status}`}):\n${result.stdout}${result.stderr}`,
      );
    },

    startFirefox,

    async restartFirefox(extensionDir, options) {
      assertOpen();
      try {
        await currentFirefox().quit();
      } catch (error: unknown) {
        throw new Error(`quitting Firefox failed: ${messageOf(error)}${diagnostics()}`, {
          cause: error,
        });
      }
      return startFirefox(extensionDir, options);
    },

    async reloadExtension() {
      assertOpen();
      const firefox = currentFirefox();
      const context = await openSettingsPage(firefox);
      // Not awaited: the page goes away with the add-on, and the call may go unanswered with it.
      void firefox.evaluate(context, "browser.runtime.reload(); true").catch(() => undefined);
      // The reload is asynchronous: until Firefox closed the old add-on's pages, a page opened
      // can still be the old add-on's.
      await pollUntil(
        async () =>
          (await firefox.contexts()).some((tab) => tab.context === context) ? undefined : true,
        PAGE_TIMEOUT_MS,
        "the reload to close the settings page",
      );
      const reloaded = await pollUntil(
        async () => {
          const attempt = await firefox.openContext(firefox.extensionUrl(SETTINGS_PAGE));
          const title = await firefox.evaluate(attempt, "document.title").catch(() => undefined);
          if (title === SETTINGS_TITLE) return attempt;
          await firefox.closeContext(attempt);
          return undefined;
        },
        PAGE_TIMEOUT_MS,
        "the reloaded add-on to serve its settings page",
      );
      await firefox.closeContext(reloaded);
    },

    async seedSettings(entries) {
      assertOpen();
      const firefox = currentFirefox();
      const context = await openSettingsPage(firefox);
      try {
        // JSON.parse keeps an own __proto__ key, which an object literal would make a prototype.
        const json = JSON.stringify(JSON.stringify(entries));
        const stored = await firefox.evaluate(
          context,
          `browser.storage.local.set(JSON.parse(${json})).then(() => true)`,
        );
        assert.equal(stored, true, `storage.local.set returned ${String(stored)}`);
      } finally {
        await firefox.closeContext(context);
      }
    },

    async settingsPage() {
      assertOpen();
      const firefox = currentFirefox();
      const context = await openSettingsPage(firefox);
      // Its first storage read can still be pending once the document has loaded.
      await pollUntil(
        async () => {
          const rendered = await firefox.evaluate(
            context,
            '!document.getElementById("sites").hidden || !document.getElementById("sites-empty").hidden',
          );
          return rendered === true ? true : undefined;
        },
        PAGE_TIMEOUT_MS,
        "the settings page to show its sites",
      );
      return context;
    },

    async connect(overrides = {}, options = {}) {
      assertOpen();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, "mcp"],
        env: { ...env, ...overrides },
        stderr: "pipe",
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-TAIL_BYTES);
      });
      const client = new Client({ name: "foxleash-e2e", version: "0" });
      const session: Session = {
        client,
        stderr: () => stderr,
        async close() {
          try {
            await client.close();
          } finally {
            await transport.close();
          }
        },
      };
      sessions.push(session);
      await client.connect(transport);
      return session;
    },

    promptContext(except = []) {
      return pageContext(PROMPT_PAGE, except);
    },

    pageContext,

    async waitForArmed(context, buttons = 3) {
      assertOpen();
      const firefox = currentFirefox();
      const armed = `${buttons} buttons, 0 unarmed;`;
      await firefox.activate(context);
      await pollUntil(
        async () => {
          const state = await firefox.evaluate(context, ARMED_STATE);
          if (typeof state === "string" && state.startsWith(armed)) return true;
          throw new Error(`the page has ${String(state)}`);
        },
        PAGE_TIMEOUT_MS,
        "the page's answer buttons to arm",
      );
    },

    async resizeUnarms(session, context, size, buttons = 3) {
      assertOpen();
      const firefox = currentFirefox();
      await expectArming(
        firefox,
        context,
        `${buttons} buttons, 0 unarmed; ${SHOWN}`,
        "before the resize",
      );
      const before = await firefox.evaluate(context, VIEWPORT);
      await ok(session, "resize_window", size);
      // The resize event fires in the rendering update before that update's animation frames: one
      // frame after the size is seen to change, it has run.
      await firefox.evaluate(
        context,
        `new Promise((resolve, reject) => {
          const deadline = performance.now() + ${PAGE_TIMEOUT_MS};
          const frame = () => {
            if (${VIEWPORT} !== ${JSON.stringify(before)}) requestAnimationFrame(() => resolve(null));
            else if (performance.now() > deadline) reject(new Error("the viewport stayed " + ${VIEWPORT}));
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        })`,
      );
      await expectArming(
        firefox,
        context,
        `${buttons} buttons, ${buttons} unarmed; ${SHOWN}`,
        "right after the resize",
      );
    },

    waitForHost,

    async waitUntilReady(session, accept = (result) => !result.isError) {
      await waitForHost();
      // The extension connects to the host asynchronously, so the first calls can find no host
      // or a host whose extension has not said hello yet.
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        const result = await call(session, "tabs_list", {});
        if (accept(result)) return result;
        if (Date.now() > deadline) {
          throw new Error(
            `tabs_list was not ready within ${READY_TIMEOUT_MS} ms; last result (isError ${result.isError}):\n${result.text}${diagnostics(session)}`,
          );
        }
        await sleep(READY_POLL_MS);
      }
    },

    call(session, name, args = {}, timeoutMs) {
      return call(session, name, args, timeoutMs);
    },

    ok,

    async refused(session, name, args = {}) {
      const result = await call(session, name, args);
      if (!result.isError) {
        throw new Error(
          `${name} succeeded but should have failed:\n${result.text}${diagnostics(session)}`,
        );
      }
      return result.text;
    },

    async close() {
      closed = true;
      const errors: unknown[] = [];
      async function step(action: () => unknown): Promise<void> {
        try {
          await action();
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      for (const session of sessions) await step(() => session.close());
      for (const firefox of firefoxes) await step(() => firefox.close());
      // Normally gone already, with Firefox's group or when its stdin ended.
      for (const pid of hostPids) await step(() => killHostIfOurs(pid, run));
      await step(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
      if (errors.length > 0) throw errors[0];
    },
  };
}

/**
 * Asserts that a tool call has not settled after `ms`. Its handlers are attached here, so a later
 * `await` of the same promise still sees the outcome and nothing goes unhandled meanwhile.
 */
export async function stillPending(promise: Promise<unknown>, ms: number): Promise<void> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  await sleep(ms);
  assert.equal(settled, false, `the call settled within ${ms} ms`);
}

/** `os.tmpdir()`, or literal /tmp when the host's longest socket path would not fit under it. */
function tempBase(): string {
  const base = tmpdir();
  const longest = join(base, LONGEST_SOCKET_TAIL);
  return Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES ? base : "/tmp";
}

function childEnv(home: string, run: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_RUNTIME_DIR: run,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pid of the newest live host socket in `socketDir`, after checking that it runs this
 * checkout's `main.ts host`; undefined while there is none.
 */
function newestHost(socketDir: string): number | undefined {
  let names: string[];
  try {
    names = readdirSync(socketDir);
  } catch {
    return undefined;
  }
  const sockets = names
    .filter((name) => SOCKET_NAME.test(name))
    .map((name) => ({ pid: Number.parseInt(name, 10), mtimeMs: mtimeOf(join(socketDir, name)) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { pid } of sockets) {
    const argv = readCmdline(pid);
    // A socket whose process is gone is a leftover; the host removes its own on a clean exit.
    if (argv === undefined) continue;
    assert.ok(
      isOurHost(argv),
      `the socket of pid ${pid} in ${socketDir} belongs to ${JSON.stringify(argv)}, not ${MAIN} host`,
    );
    return pid;
  }
  return undefined;
}

function mtimeOf(path: string): number {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readCmdline(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((part) => part !== "");
  } catch {
    return undefined;
  }
}

function isOurHost(argv: string[]): boolean {
  const [, script, command] = argv;
  if (script === undefined || command !== "host") return false;
  try {
    return realpathSync(script) === realpathSync(MAIN);
  } catch {
    return false;
  }
}

/** SIGKILLs `pid` only while it is still this checkout's host and runs in this run's root. */
function killHostIfOurs(pid: number, run: string): void {
  const argv = readCmdline(pid);
  if (argv === undefined || !isOurHost(argv)) return;
  let environ: string[];
  try {
    environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return;
  }
  if (!environ.includes(`XDG_RUNTIME_DIR=${run}`)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/**
 * The items of a result's view of the page: those after its first framed item, which is the
 * result's own JSON (upload_file's after). Each framed item is given as the text inside its frame.
 */
export function viewItemsOf(result: ToolResult): { own: string[]; framed: string[] } {
  const first = result.texts.findIndex((text) => untrustedContent(text) !== undefined);
  assert.ok(first !== -1, `the result has no framed part:\n${result.texts.join("\n")}`);
  const items = result.texts.slice(first + 1);
  return {
    own: items.filter((text) => untrustedContent(text) === undefined),
    framed: items.flatMap((text) => {
      const inner = untrustedContent(text);
      return inner === undefined ? [] : [inner];
    }),
  };
}

/** Calls a tool and returns whether it failed and its text content. */
async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<ToolResult> {
  const result: unknown = await session.client.callTool({ name, arguments: args }, undefined, {
    timeout: timeoutMs,
  });
  assert.ok(isRecord(result), `${name} returned ${JSON.stringify(result)}`);
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  const texts = content.flatMap((item: unknown) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
  );
  const images = content.flatMap((item: unknown) =>
    isRecord(item) &&
    item.type === "image" &&
    typeof item.data === "string" &&
    typeof item.mimeType === "string"
      ? [{ data: item.data, mimeType: item.mimeType }]
      : [],
  );
  const first = texts[0];
  assert.ok(first !== undefined, `${name} returned no text: ${JSON.stringify(result)}`);
  return { isError: result.isError === true, text: first, texts, images };
}

/** A success result's JSON, from inside its untrusted frame. */
export function parseResult(text: string): unknown {
  const content = untrustedContent(text);
  assert.ok(content !== undefined, `the result is not one untrusted frame:\n${text}`);
  return JSON.parse(content);
}

/** The values an act's after.page can have. */
const ACT_PAGES: readonly unknown[] = [
  "loaded",
  "loading",
  "changed",
  "unchanged",
  "unsettled",
  "closed",
  "unknown",
];

/**
 * An act's result without its after, once after is checked to be a record with a page it can
 * have: for tests about what the act did rather than what followed it.
 */
export function withoutAfter(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), `expected an act's result, got ${JSON.stringify(value)}`);
  const { after, ...rest } = value;
  assert.ok(
    isRecord(after) && ACT_PAGES.includes(after.page),
    `expected an act's after, got ${JSON.stringify(after)}`,
  );
  return rest;
}

/** The text inside an untrusted frame whose start and end lines carry the same id. */
export function untrustedContent(text: string): string | undefined {
  return UNTRUSTED_FRAME.exec(text)?.[2];
}

export function tabOf(value: unknown): TabInfo {
  assert.ok(isRecord(value), `expected { tab }, got ${JSON.stringify(value)}`);
  return checkTab(value.tab);
}

export function tabsOf(value: unknown): TabInfo[] {
  assert.ok(
    isRecord(value) && Array.isArray(value.tabs),
    `expected { tabs }, got ${JSON.stringify(value)}`,
  );
  const tabs: unknown[] = value.tabs;
  return tabs.map(checkTab);
}

export function checkTab(value: unknown): TabInfo {
  assert.ok(
    isRecord(value) &&
      typeof value.id === "number" &&
      typeof value.url === "string" &&
      typeof value.title === "string" &&
      typeof value.active === "boolean",
    `expected a tab, got ${JSON.stringify(value)}`,
  );
  return { id: value.id, url: value.url, title: value.title, active: value.active };
}
