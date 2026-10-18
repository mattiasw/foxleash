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
import { EXTENSION_ID } from "@foxhand/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UNTRUSTED_LINE } from "../apps/server/src/tools.ts";
import { ensureFirefox } from "../bin/install-firefox.ts";
import { describeOutput, type Firefox, isRecord, launchFirefox } from "./firefox.ts";

export const CHECKOUT = join(import.meta.dirname, "..");
export const EXTENSION_DIST = join(CHECKOUT, "apps", "extension", "dist");
const MAIN = join(CHECKOUT, "apps", "server", "src", "main.ts");

// The longest socket path the host can make must fit in sun_path (108 bytes with its NUL).
const MAX_SOCKET_PATH_BYTES = 107;
const LONGEST_SOCKET_TAIL = join("fh-e2e-XXXXXX", "run", "foxhand", "2147483647.sock");
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
  text: string;
}

export interface Session {
  client: Client;
  stderr(): string;
  close(): Promise<void>;
}

export interface Harness {
  root: string;
  run: string;
  env: Record<string, string>;
  /** Installs the native host into the temp home only (`install --no-claude`). */
  install(): void;
  startFirefox(extensionDir: string): Promise<Firefox>;
  connect(overrides?: Record<string, string>): Promise<Session>;
  waitForHost(): Promise<number>;
  waitUntilReady(session: Session, accept?: (result: ToolResult) => boolean): Promise<ToolResult>;
  /** Calls a tool that must succeed and returns its parsed JSON. */
  ok(session: Session, name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Calls a tool that must fail and returns its text. */
  refused(session: Session, name: string, args?: Record<string, unknown>): Promise<string>;
  /** Runs every teardown step even when one fails, then rethrows the first failure. */
  close(): Promise<void>;
}

/**
 * One temp root per test file: `home/` (HOME), `run/` (XDG_RUNTIME_DIR, mode 0700) and
 * `profile/` (Firefox's). Every child gets the same env, so the install, Firefox, the native host
 * Firefox starts and every `foxhand mcp` meet in this root and never in the developer's own.
 */
export function createHarness(): Harness {
  const root = mkdtempSync(join(tempBase(), "fh-e2e-"));
  const home = join(root, "home");
  const run = join(root, "run");
  const profile = join(root, "profile");
  mkdirSync(home);
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
        `\n--- foxhand mcp stderr (last ${TAIL_BYTES} bytes) ---\n${session.stderr() || "(empty)"}`,
      );
    }
    for (const firefox of firefoxes) parts.push(describeOutput(firefox.output()));
    return parts.join("");
  }

  async function call(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      return await callTool(session, name, args);
    } catch (error: unknown) {
      throw new Error(`${name} returned no result: ${messageOf(error)}${diagnostics(session)}`, {
        cause: error,
      });
    }
  }

  async function waitForHost(): Promise<number> {
    const deadline = Date.now() + HOST_TIMEOUT_MS;
    const socketDir = join(run, "foxhand");
    for (;;) {
      const pid = newestHost(socketDir);
      if (pid !== undefined) {
        hostPids.add(pid);
        return pid;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no foxhand host socket appeared in ${socketDir} within ${HOST_TIMEOUT_MS} ms${diagnostics()}`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  return {
    root,
    run,
    env,

    install() {
      assertOpen();
      const result = spawnSync(process.execPath, [MAIN, "install", "--no-claude"], {
        env,
        encoding: "utf8",
        timeout: INSTALL_TIMEOUT_MS,
      });
      assert.equal(
        result.status,
        0,
        `foxhand install --no-claude failed (${result.error?.message ?? `status ${result.status}`}):\n${result.stdout}${result.stderr}`,
      );
    },

    async startFirefox(extensionDir) {
      assertOpen();
      assert.ok(
        existsSync(join(extensionDir, "manifest.json")),
        `${extensionDir} holds no built extension: run npm run build`,
      );
      const binary = await ensureFirefox();
      assertOpen();
      const firefox = await launchFirefox({ binary, profileDir: profile, env });
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
      return firefox;
    },

    async connect(overrides = {}) {
      assertOpen();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, "mcp"],
        env: { ...env, ...overrides },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-TAIL_BYTES);
      });
      const client = new Client({ name: "foxhand-e2e", version: "0" });
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

    async ok(session, name, args = {}) {
      const result = await call(session, name, args);
      if (result.isError) {
        throw new Error(`${name} failed:\n${result.text}${diagnostics(session)}`);
      }
      return parseResult(result.text);
    },

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

/** Calls a tool and returns whether it failed and its first text content. */
async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result: unknown = await session.client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  assert.ok(isRecord(result), `${name} returned ${JSON.stringify(result)}`);
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  const first: unknown = content.find(
    (item: unknown) => isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  assert.ok(
    isRecord(first) && typeof first.text === "string",
    `${name} returned no text: ${JSON.stringify(result)}`,
  );
  return { isError: result.isError === true, text: first.text };
}

/** A success result's JSON: the untrusted-content line, a newline, then the JSON. */
export function parseResult(text: string): unknown {
  const prefix = `${UNTRUSTED_LINE}\n`;
  assert.ok(text.startsWith(prefix), `the result does not start with the untrusted line:\n${text}`);
  return JSON.parse(text.slice(prefix.length));
}
