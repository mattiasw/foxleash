import type {
  ChildProcessByStdio,
  SpawnOptionsWithStdioTuple,
  StdioNull,
  StdioPipe,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  EXTENSION_ID,
  NATIVE_HOST_NAME,
  type PartInfo,
  PROTOCOL_VERSION,
  parseMessage,
  protocolMismatch,
  versionsOf,
  type WelcomeMessage,
} from "@foxleash/protocol";
import { BridgeError, connectToHost } from "./bridge.ts";
import { createFrameReader, encodeFrame, NATIVE_MESSAGE_LIMIT } from "./framing.ts";
import { installPaths, launcherScript } from "./install.ts";
import type { Run } from "./run-command.ts";
import { checkSocketDir, isAlive, listSockets } from "./socket-dir.ts";

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>,
) => ChildProcessByStdio<Writable, Readable, null>;

export interface DoctorOptions {
  home: string;
  socketDir: string;
  skipped: readonly string[];
  uid: number;
  version: string;
  node: string;
  main: string;
  run: Run;
  spawn: Spawn;
  out: NodeJS.WritableStream;
  timeouts?: { welcomeMs?: number; exitMs?: number; killMs?: number };
}

type Status = "ok" | "warn" | "FAIL";

interface Report {
  line(status: Status, check: string, detail: string): void;
  continuation(text: string): void;
  summary(): number;
}

type FileRead = { ok: true; text: string } | { ok: false; reason: string };

type LauncherOutcome =
  | { kind: "cannot-run"; code: string }
  | { kind: "no-answer" }
  | { kind: "exited-early"; how: string }
  | { kind: "not-welcome" }
  | { kind: "no-exit" }
  | { kind: "exited-after"; how: string }
  | { kind: "ok"; welcome: WelcomeMessage };

interface LauncherRun {
  outcome: LauncherOutcome;
  dir: string | undefined;
  removeError: string | undefined;
}

type LauncherChild = ChildProcessByStdio<Writable, Readable, null>;

type Probe =
  | { ok: true; welcome: WelcomeMessage }
  | { ok: false; code: string | undefined; message: string };

const SETUP = "run npm run setup";
const NO_FIREFOX = "is Firefox running with the Foxleash extension?";
const FLATPAK_FIREFOX = ".var/app/org.mozilla.firefox";
const PORTAL_SETTING = "widget.use-xdg-desktop-portal.native-messaging";
const TEMP_PREFIX = "/tmp/foxleash-doctor-";
const LAUNCHER_PATH = "/usr/bin:/bin";
const CLAUDE_TIMEOUT_MS = 15_000;
const OTHER_LIMIT = 200;

export async function doctor(options: DoctorOptions): Promise<number> {
  const report = createReport(options.out);
  const launcher = checkManifest(options.home, report);
  if (launcher !== undefined) {
    await checkLauncher(launcher, options, report);
  }
  await checkClaude(options, report);
  if (checkSocketDirectory(options, report)) {
    await checkHosts(options, report);
  }
  return report.summary() > 0 ? 1 : 0;
}

function createReport(out: NodeJS.WritableStream): Report {
  let checks = 0;
  let failed = 0;
  return {
    line(status, check, detail) {
      checks += 1;
      if (status === "FAIL") {
        failed += 1;
      }
      write(`${status} ${check}: ${detail}`);
    },
    continuation(text) {
      write(`  ${text}`);
    },
    summary() {
      write(`${checks} checks, ${failed} failed`);
      return failed;
    },
  };

  function write(text: string): void {
    out.write(`${escapeControls(text)}\n`);
  }
}

// A manifest path or another program's output must not put an escape code or a line break here.
function escapeControls(text: string): string {
  return text.replace(
    /\p{Cc}/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function checkManifest(home: string, report: Report): string | undefined {
  const { manifest } = installPaths(home);
  const fail = (detail: string): void =>
    report.line("FAIL", "native manifest", `${manifest} ${detail}; ${SETUP}`);
  const read = readRegularFile(manifest);
  if (!read.ok) {
    fail(read.reason);
    return undefined;
  }
  const value = parseJson(read.text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("is not a JSON object");
    return undefined;
  }
  const failures: string[] = [];
  if (own(value, "name") !== NATIVE_HOST_NAME) {
    failures.push(`has a name other than "${NATIVE_HOST_NAME}"`);
  }
  if (own(value, "type") !== "stdio") {
    failures.push('has a type other than "stdio"');
  }
  const allowed = own(value, "allowed_extensions");
  if (!Array.isArray(allowed) || !allowed.includes(EXTENSION_ID)) {
    failures.push(`does not allow the extension ${EXTENSION_ID}`);
  }
  const path = own(value, "path");
  const launcher = typeof path === "string" && isAbsolute(path) ? path : undefined;
  if (launcher === undefined) {
    failures.push("has no absolute path to the launcher");
  }
  for (const failure of failures) {
    fail(failure);
  }
  if (failures.length === 0) {
    report.line("ok", "native manifest", manifest);
  }
  return launcher;
}

// Stat first: opening a FIFO blocks with no timer to end it, and a device can read forever.
function readRegularFile(path: string): FileRead {
  try {
    if (!statSync(path).isFile()) {
      return { ok: false, reason: "is not a regular file" };
    }
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error: unknown) {
    const code = errorCode(error);
    return { ok: false, reason: code === "ENOENT" ? "does not exist" : `cannot be read: ${code}` };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

async function checkLauncher(
  launcher: string,
  options: DoctorOptions,
  report: Report,
): Promise<void> {
  const fail = (detail: string): void => report.line("FAIL", "launcher", `${detail}; ${SETUP}`);
  const read = readRegularFile(launcher);
  if (!read.ok) {
    fail(`${launcher} ${read.reason}`);
    return;
  }
  const { outcome, dir, removeError } = await runLauncher(launcher, options);
  switch (outcome.kind) {
    case "cannot-run":
      fail(`cannot run ${launcher}: ${outcome.code}`);
      break;
    case "no-answer":
      fail(`${launcher} did not answer within ${seconds(welcomeMsOf(options))} s`);
      break;
    case "exited-early":
      fail(`${launcher} exited with ${outcome.how} before answering`);
      break;
    case "not-welcome":
      fail(`${launcher} did not answer with a welcome`);
      break;
    case "no-exit":
      fail(
        `${launcher} did not exit within ${seconds(exitMsOf(options))} s after its input closed`,
      );
      break;
    case "exited-after":
      fail(`${launcher} exited with ${outcome.how} after answering`);
      break;
    case "ok": {
      const { protocol, version } = outcome.welcome;
      report.line(
        "ok",
        "launcher",
        `${launcher} runs host version ${version}, protocol ${protocol}`,
      );
      const mismatch = protocolMismatch(
        { part: "host", protocol, version },
        { part: "mcp", protocol: PROTOCOL_VERSION, version: options.version },
      );
      if (mismatch !== null) {
        report.line("FAIL", "launcher", mismatch);
      }
      break;
    }
  }
  if (removeError !== undefined) {
    report.line("warn", "launcher", `cannot remove ${dir}: ${removeError}`);
  }
  if (read.text !== launcherScript(options.node, options.main)) {
    report.line(
      "warn",
      "launcher",
      `the launcher runs ${launcherCommand(read.text)}; run npm run setup here to switch`,
    );
  }
}

function runLauncher(launcher: string, options: DoctorOptions): Promise<LauncherRun> {
  let dir: string | undefined;
  let child: LauncherChild;
  try {
    dir = mkdtempSync(TEMP_PREFIX);
    // Only these three, as a clean session would give them; the private XDG_RUNTIME_DIR keeps
    // the host this starts out of the real socket directory.
    child = options.spawn(launcher, [], {
      env: { HOME: options.home, PATH: LAUNCHER_PATH, XDG_RUNTIME_DIR: dir },
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error: unknown) {
    // spawn throws for most execve errors (ELOOP, ETXTBSY); only a few arrive as an error event.
    return Promise.resolve({
      outcome: { kind: "cannot-run", code: errorCode(error) },
      dir,
      removeError: dir === undefined ? undefined : removeDir(dir),
    });
  }
  return watchLauncher(child, dir, options);
}

function watchLauncher(
  child: LauncherChild,
  dir: string,
  options: DoctorOptions,
): Promise<LauncherRun> {
  const killMs = options.timeouts?.killMs ?? 1_000;
  const { promise, resolve } = Promise.withResolvers<LauncherRun>();
  const reader = createFrameReader(NATIVE_MESSAGE_LIMIT);
  let spawnError: string | undefined;
  let answered = false;
  let welcome: WelcomeMessage | null = null;
  let expired: "welcome" | "exit" | undefined;
  let exitTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  // A launcher without its exec bit gives EACCES here, then close, and never exit.
  child.on("error", (error) => {
    spawnError ??= errorCode(error);
  });
  // EPIPE when the child is already gone; without a listener it would be an uncaught error.
  child.stdin.on("error", ignore);
  child.stdout.on("error", ignore);
  child.on("close", onClose);
  const welcomeTimer = setTimeout(() => expire("welcome"), welcomeMsOf(options));
  child.stdout.on("data", onData);
  child.stdin.write(
    encodeFrame(
      JSON.stringify({
        type: "hello",
        role: "extension",
        protocol: PROTOCOL_VERSION,
        version: options.version,
      }),
    ),
  );
  return promise;

  function onData(chunk: Buffer): void {
    const [first] = reader.push(chunk);
    if (first === undefined || answered) {
      return;
    }
    answered = true;
    welcome = first.ok ? welcomeOf(first.value) : null;
    clearTimeout(welcomeTimer);
    child.stdin.end();
    exitTimer = setTimeout(() => expire("exit"), exitMsOf(options));
  }

  function expire(which: "welcome" | "exit"): void {
    expired = which;
    // A grandchild holding the pipe would otherwise keep close from ever firing.
    child.stdout.destroy();
    child.kill();
    killTimer = setTimeout(() => child.kill("SIGKILL"), killMs);
  }

  function onClose(code: number | null, signal: NodeJS.Signals | null): void {
    clearTimeout(welcomeTimer);
    clearTimeout(exitTimer);
    clearTimeout(killTimer);
    const removeError = removeDir(dir);
    resolve({ outcome: outcomeOf(code, signal), dir, removeError });
  }

  function outcomeOf(code: number | null, signal: NodeJS.Signals | null): LauncherOutcome {
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    if (spawnError !== undefined) {
      return { kind: "cannot-run", code: spawnError };
    }
    if (expired === "welcome") {
      return { kind: "no-answer" };
    }
    if (!answered) {
      return { kind: "exited-early", how };
    }
    if (welcome === null) {
      return { kind: "not-welcome" };
    }
    if (expired === "exit") {
      return { kind: "no-exit" };
    }
    if (code !== 0) {
      return { kind: "exited-after", how };
    }
    return { kind: "ok", welcome };
  }
}

function ignore(): void {}

function welcomeMsOf(options: DoctorOptions): number {
  return options.timeouts?.welcomeMs ?? 10_000;
}

function exitMsOf(options: DoctorOptions): number {
  return options.timeouts?.exitMs ?? 5_000;
}

function welcomeOf(value: unknown): WelcomeMessage | null {
  const parsed = parseMessage(value);
  return parsed.ok && parsed.message.type === "welcome" ? parsed.message : null;
}

// A throw here, in a close listener, would be an uncaught exception with no summary.
function removeDir(dir: string): string | undefined {
  try {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  } catch (error: unknown) {
    return errorCode(error);
  }
}

function seconds(ms: number): number {
  return ms / 1000;
}

function launcherCommand(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined) {
    return "nothing";
  }
  const command = last.startsWith("exec ") ? last.slice("exec ".length) : last;
  return command.length > OTHER_LIMIT ? `${command.slice(0, OTHER_LIMIT)}...` : command;
}

async function checkClaude(options: DoctorOptions, report: Report): Promise<void> {
  const result = await options.run("claude", ["mcp", "get", "foxleash"], {
    timeoutMs: CLAUDE_TIMEOUT_MS,
  });
  switch (result.status) {
    case "ok": {
      const lines = result.stdout.split("\n");
      const command = field(lines, /^\s*Command:(.*)$/);
      const args = field(lines, /^\s*Args:(.*)$/);
      const expected = [options.node, options.main, "mcp"].join(" ");
      if (command !== undefined && args !== undefined && `${command} ${args}` !== expected) {
        report.line(
          "warn",
          "claude code",
          `registered as ${command} ${args}, expected ${expected}; ${SETUP}`,
        );
        return;
      }
      report.line("ok", "claude code", "foxleash is registered");
      if (command !== undefined) {
        report.continuation(`Command: ${command}`);
      }
      if (args !== undefined) {
        report.continuation(`Args: ${args}`);
      }
      return;
    }
    case "failed":
      report.line("FAIL", "claude code", `not registered; ${SETUP}`);
      return;
    case "missing":
      report.line("warn", "claude code", "claude is not on PATH; skipped");
      return;
    case "timeout":
      report.line(
        "warn",
        "claude code",
        `claude mcp get did not finish in ${seconds(CLAUDE_TIMEOUT_MS)} s`,
      );
      return;
  }
}

function field(lines: readonly string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) {
      return match[1]?.trim();
    }
  }
  return undefined;
}

function checkSocketDirectory(options: DoctorOptions, report: Report): boolean {
  const { socketDir, skipped, uid } = options;
  for (const reason of skipped) {
    report.line("warn", "socket directory", `skipped ${reason}`);
  }
  const check = checkSocketDir(socketDir, uid);
  if (check.ok) {
    report.line("ok", "socket directory", socketDir);
    return true;
  }
  if (check.reason === "does not exist") {
    report.line(
      "FAIL",
      "socket directory",
      `no host has started yet in ${socketDir}; ${NO_FIREFOX}`,
    );
    flatpakStep(options.home, report);
  } else {
    report.line(
      "FAIL",
      "socket directory",
      `${socketDir} ${check.reason}; remove it and restart Firefox`,
    );
  }
  return false;
}

async function checkHosts(options: DoctorOptions, report: Report): Promise<void> {
  const { socketDir, uid } = options;
  let entries: ReturnType<typeof listSockets>;
  try {
    entries = listSockets(socketDir, uid);
  } catch (error: unknown) {
    report.line("FAIL", "hosts", errorMessage(error));
    return;
  }
  let answered = 0;
  for (const entry of entries) {
    const host = `host ${entry.path}`;
    if (!isAlive(entry.pid)) {
      report.line("warn", host, `stale (no process ${entry.pid})`);
      continue;
    }
    const probe = await probeHost(entry.path, options.version);
    if (probe.ok) {
      answered += 1;
      const { protocol, version } = probe.welcome;
      report.line("ok", `${host} (pid ${entry.pid})`, `version ${version}, protocol ${protocol}`);
      const mismatch = protocolMismatch(
        { part: "mcp", protocol: PROTOCOL_VERSION, version: options.version },
        { part: "host", protocol, version },
      );
      if (mismatch !== null) {
        report.line("FAIL", host, mismatch);
      }
      checkExtension(entry.path, probe.welcome, report);
    } else {
      reportHostFailure(host, probe.code, probe.message, report);
    }
  }
  if (answered === 0) {
    report.line("FAIL", "hosts", `no running host answered in ${socketDir}; ${NO_FIREFOX}`);
    flatpakStep(options.home, report);
  }
}

function flatpakStep(home: string, report: Report): void {
  if (!hasFlatpakFirefox(home)) {
    return;
  }
  report.continuation(
    `Firefox from Flatpak is installed (${join(home, FLATPAK_FIREFOX)}). It starts the`,
  );
  report.continuation(
    "Foxleash host only after one setting: open about:config in that Firefox, set",
  );
  report.continuation(`${PORTAL_SETTING} to 2, and click Allow when it asks to`);
  report.continuation(
    "start the WebExtension backend. The README's install section has the steps.",
  );
}

// Flatpak keeps each app's data under ~/.var/app.
function hasFlatpakFirefox(home: string): boolean {
  try {
    return statSync(join(home, FLATPAK_FIREFOX)).isDirectory();
  } catch {
    return false;
  }
}

async function probeHost(path: string, version: string): Promise<Probe> {
  try {
    const { socket, welcome } = await connectToHost(path, { version, log: ignore });
    socket.on("error", ignore);
    socket.destroy();
    return { ok: true, welcome };
  } catch (error: unknown) {
    const code = error instanceof BridgeError ? error.code : undefined;
    return { ok: false, code, message: errorMessage(error) };
  }
}

function reportHostFailure(
  host: string,
  code: string | undefined,
  message: string,
  report: Report,
): void {
  if (code === "ECONNREFUSED") {
    report.line("warn", host, "stale (nothing listening)");
  } else if (code === "ENOENT") {
    // The host exited between listing and connecting, e.g. Firefox closing during the run.
    report.line("warn", host, "stale (the socket is gone)");
  } else {
    report.line("FAIL", host, code ?? message);
  }
}

function checkExtension(path: string, welcome: WelcomeMessage, report: Report): void {
  const extension = welcome.extension;
  if (extension === undefined || !extension.connected) {
    report.line(
      "FAIL",
      "extension",
      `not connected to the host at ${path}; is the Foxleash extension installed and enabled?`,
    );
    return;
  }
  const { protocol, version, allUrls, oldestProtocol } = extension;
  const part: PartInfo = {
    part: "extension",
    protocol,
    version,
    ...(oldestProtocol === undefined ? {} : { oldest: oldestProtocol }),
  };
  report.line("ok", "extension", versionsOf(part));
  const mismatch = protocolMismatch(part, {
    part: "host",
    protocol: welcome.protocol,
    version: welcome.version,
  });
  if (mismatch !== null) {
    report.line("FAIL", "extension", mismatch);
  }
  if (allUrls === false) {
    report.line(
      "FAIL",
      "extension permissions",
      "access to all websites is not granted; open about:addons, Foxleash, Permissions, and allow it",
    );
  } else if (allUrls === true) {
    report.line("ok", "extension permissions", "access to all websites granted");
  } else {
    report.line("warn", "extension permissions", "not reported by this extension version");
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") {
      return code;
    }
  }
  return "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
