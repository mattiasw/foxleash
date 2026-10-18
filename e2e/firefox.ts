import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Firefox's own lifetime, enforced by a watchdog inside its process group (LIFETIME_WRAPPER).
 * Above the sum of a test file's deadlines (setup hook 120 s, six tests at 60 s, teardown hook
 * 60 s = 540 s), so it never cuts a slow run short. It fires only when the harness could not
 * clean up, for example when node was killed with SIGKILL and none of its handlers ran.
 */
export const FIREFOX_LIFETIME_SECONDS = 900;

/**
 * Starts a watchdog that SIGKILLs the process group whose id is the wrapper's own pid ($$, which
 * a subshell keeps) after $1 seconds, then execs Firefox, which so keeps that pid. The spawn is
 * detached, so that group is Firefox's alone. Named by id rather than `kill 0` on purpose: were
 * the spawn ever not detached, `kill 0` would kill the caller's group (the test runner, the
 * shell); a group id that does not exist is only an ESRCH. The watchdog holds no pipe open, so it
 * cannot keep node waiting, and it stays a member of the group until it fires, so the id cannot
 * be reused under it.
 *
 * Not `timeout -s KILL`: GNU timeout signals the whole group, but uutils coreutils' timeout
 * (0.8.0) sends the KILL to the command only, which was measured leaving a grandchild running.
 */
const LIFETIME_WRAPPER =
  'lifetime=$1; shift; (sleep "$lifetime"; kill -s KILL -- "-$$") </dev/null >/dev/null 2>&1 & exec "$@"';

const TAIL_BYTES = 8 * 1024;
const LISTEN_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface FirefoxOutput {
  stdout: string;
  stderr: string;
}

export interface Firefox {
  /** Installs the unpacked extension in `path` as a temporary add-on and returns its id. */
  installExtension(path: string): Promise<string>;
  output(): FirefoxOutput;
  close(): Promise<void>;
}

export interface LaunchOptions {
  binary: string;
  profileDir: string;
  env: Record<string, string>;
  lifetimeSeconds?: number;
}

/**
 * Starts Firefox headless in its own process group under a hard lifetime, connects to its
 * WebDriver BiDi listener and opens the session, so this run holds Firefox's single BiDi session
 * from the start. Any failure kills the group before it rejects.
 */
export async function launchFirefox({
  binary,
  profileDir,
  env,
  lifetimeSeconds = FIREFOX_LIFETIME_SECONDS,
}: LaunchOptions): Promise<Firefox> {
  writeFileSync(join(profileDir, "user.js"), buildUserJs());
  const child = spawn(
    "sh",
    [
      "-c",
      LIFETIME_WRAPPER,
      "foxhand-e2e",
      String(lifetimeSeconds),
      binary,
      "--headless",
      "--no-remote",
      "--profile",
      profileDir,
      "--remote-debugging-port=0",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // No crash reporter: its helper process puts itself in a session and process group of its
      // own, out of reach of the group kill and the watchdog, and a crash would write a minidump
      // outside the throwaway profile and try to upload it.
      env: { ...env, MOZ_CRASHREPORTER_DISABLE: "1" },
    },
  );
  track(child);

  const stdoutTail = tailBuffer();
  const stderrTail = tailBuffer();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdoutTail.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderrTail.push(chunk));
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  function output(): FirefoxOutput {
    return { stdout: stdoutTail.read(), stderr: stderrTail.read() };
  }

  let bidi: Bidi | undefined;
  try {
    const wsUrl = await waitForListening(child, stderrTail.read);
    bidi = await connectBidi(wsUrl);
    await bidi.send("session.new", { capabilities: {} });
  } catch (error: unknown) {
    killGroupSync(child);
    untrack(child);
    bidi?.close();
    throw new Error(`Firefox did not start: ${messageOf(error)}${describeOutput(output())}`, {
      cause: error,
    });
  }
  const session = bidi;

  let closing: Promise<void> | undefined;
  return {
    async installExtension(path) {
      const result = await session.send("webExtension.install", {
        extensionData: { type: "path", path },
      });
      const extension = isRecord(result) ? result.extension : undefined;
      if (typeof extension !== "string") {
        throw new Error(`webExtension.install returned ${JSON.stringify(result)}`);
      }
      return extension;
    },
    output,
    close() {
      closing ??= (async () => {
        killGroupSync(child);
        try {
          await withDeadline(closed, CLOSE_TIMEOUT_MS, "Firefox to exit after the group kill");
        } finally {
          untrack(child);
          session.close();
        }
      })();
      return closing;
    },
  };
}

/** The throwaway profile's user.js. Every pref carries its reason. */
function buildUserJs(): string {
  const prefs: Array<[string, string | number | boolean, string]> = [
    [
      "browser.startup.page",
      0,
      "Start blank: the default about:home is a privileged page that fetches remote content.",
    ],
    ["browser.startup.homepage", "about:blank", "Same reason."],
    [
      "devtools.console.stdout.content",
      true,
      "Echo console output, the extension's warnings included, to stdout, whose tail a failing test shows.",
    ],
  ];
  return prefs
    .map(
      ([name, value, reason]) =>
        `// ${reason}\nuser_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`,
    )
    .join("");
}

// Every launched group, killed by the exit and signal handlers below while it is running.
const running = new Set<ChildProcess>();

function track(child: ChildProcess): void {
  running.add(child);
  if (running.size === 1) {
    process.on("exit", killAllSync);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
}

function untrack(child: ChildProcess): void {
  running.delete(child);
  if (running.size === 0) removeHandlers();
}

function killAllSync(): void {
  for (const child of running) killGroupSync(child);
}

// Ctrl-C would otherwise end node without its exit handlers and leave Firefox to the watchdog.
function onSignal(signal: NodeJS.Signals): void {
  killAllSync();
  running.clear();
  removeHandlers();
  process.kill(process.pid, signal);
}

function removeHandlers(): void {
  process.off("exit", killAllSync);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}

/** Kills Firefox's whole process group: Firefox, its content processes and the watchdog. */
export function killGroupSync(child: ChildProcess): void {
  // No pid: the spawn itself failed, so there is no group to kill.
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

interface Tail {
  push(chunk: string): void;
  read(): string;
}

function tailBuffer(): Tail {
  let text = "";
  return {
    push(chunk) {
      text = (text + chunk).slice(-TAIL_BYTES);
    },
    read: () => text,
  };
}

/** Resolves with the BiDi WebSocket URL once Firefox prints its listening line. */
function waitForListening(child: ChildProcess, stderr: () => string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    finish();
    reject(new Error(`no BiDi listening line within ${LISTEN_TIMEOUT_MS} ms`));
  }, LISTEN_TIMEOUT_MS);

  function onData(): void {
    const url = parseListeningLine(stderr());
    if (url === null) return;
    finish();
    resolve(url);
  }

  // 'close', not 'exit': 'exit' can arrive before the last of stderr is read, and the failure
  // would then quote an empty tail.
  function onClose(code: number | null, signal: NodeJS.Signals | null): void {
    finish();
    reject(new Error(`Firefox exited (code ${code}, signal ${signal}) before listening`));
  }

  function onError(error: Error): void {
    finish();
    reject(new Error(`could not start Firefox: ${error.message}`));
  }

  function finish(): void {
    clearTimeout(timer);
    child.stderr?.off("data", onData);
    child.off("close", onClose);
    child.off("error", onError);
  }

  // Added after launchFirefox's own listener, so the tail already holds the chunk.
  child.stderr?.on("data", onData);
  child.once("close", onClose);
  child.once("error", onError);
  return promise;
}

/**
 * The BiDi WebSocket URL from Firefox's stderr, or null. Pass the whole accumulated text: the
 * line can arrive split across chunks, so it counts only once its line end is in (a URL cut
 * inside the port names another port).
 */
export function parseListeningLine(text: string): string | null {
  const match = /WebDriver BiDi listening on (ws:\/\/\S+)\r?\n/.exec(text);
  return match?.[1] ?? null;
}

interface Bidi {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface Waiter {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** A BiDi client over Node's global WebSocket, connected to `${wsUrl}/session`. */
async function connectBidi(wsUrl: string): Promise<Bidi> {
  const socket = new WebSocket(`${wsUrl}/session`);
  const pending = new Map<number, Waiter>();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    // Events carry no id; a reply to a command that already timed out finds no waiter.
    if (!isRecord(message) || typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.type === "success") {
      waiter.resolve(message.result);
    } else if (message.type === "error") {
      waiter.reject(new Error(`BiDi error ${String(message.error)}: ${String(message.message)}`));
    } else {
      waiter.reject(new Error(`BiDi reply of unknown type ${JSON.stringify(message.type)}`));
    }
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the BiDi connection closed"));
    }
    pending.clear();
  });

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error(`could not connect to ${wsUrl}/session`)),
    );
  });
  try {
    await withDeadline(opened, CONNECT_TIMEOUT_MS, `the BiDi connection to ${wsUrl}/session`);
  } catch (error: unknown) {
    socket.close();
    throw error;
  }

  return {
    send(method, params) {
      // A closing or closed WebSocket drops what is sent, and the command would then wait out
      // its whole deadline for a reply that cannot come.
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`the BiDi connection is closed; cannot send ${method}`));
      }
      nextId += 1;
      const id = nextId;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to BiDi ${method} within ${COMMAND_TIMEOUT_MS} ms`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() {
      socket.close();
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The output tails, for a failure message. */
export function describeOutput({ stdout, stderr }: FirefoxOutput): string {
  return (
    `\n--- Firefox stderr (last ${TAIL_BYTES} bytes) ---\n${stderr || "(empty)"}` +
    `\n--- Firefox stdout (last ${TAIL_BYTES} bytes) ---\n${stdout || "(empty)"}`
  );
}
