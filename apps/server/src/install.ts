import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ADDON_PAGE_URL, EXTENSION_ID, NATIVE_HOST_NAME } from "@foxleash/protocol";
import type { Launch, Run, RunResult } from "./run-command.ts";

const CLAUDE_SERVER_NAME = "foxleash";
const CLAUDE_TIMEOUT_MS = 30_000;
const REMOVE_ARGS = ["mcp", "remove", "-s", "user", CLAUDE_SERVER_NAME];

/** The program setup points Firefox and Claude Code at. */
export type Program = { kind: "source"; main: string } | { kind: "bundle"; file: string };

export type ExtensionSource = { kind: "page" } | { kind: "file"; path: string } | { kind: "none" };

export interface InstallOptions {
  home: string;
  node: string;
  program: Program;
  claude: boolean;
  extension: ExtensionSource;
  run: Run;
  launch: Launch;
  out: NodeJS.WritableStream;
  uid?: number;
}

export interface UninstallOptions {
  home: string;
  claude: boolean;
  run: Run;
  out: NodeJS.WritableStream;
  uid?: number;
}

export async function install(options: InstallOptions): Promise<number> {
  const { home, node, program, claude, run, out, uid = process.getuid?.() } = options;
  const refusal = homeRefusal(home, uid);
  if (refusal !== undefined) {
    out.write(refusal);
    return 1;
  }
  const paths = installPaths(home);
  const { launcher, manifest } = paths;
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  // Only Foxleash uses this directory; the shared native-messaging-hosts one keeps its mode.
  chmodSync(dirname(launcher), 0o700);
  if (program.kind === "bundle") {
    // Before the launcher and the manifest, so they never name a missing file.
    copyProgram(program.file, paths.program);
    out.write(`wrote ${paths.program}\n`);
  }
  const main = programPath(program, home);
  writeFileSync(launcher, launcherScript(node, main), { mode: 0o700 });
  // writeFileSync's mode applies only when it creates the file; this repairs an existing one.
  chmodSync(launcher, 0o700);
  mkdirSync(dirname(manifest), { recursive: true, mode: 0o700 });
  writeFileSync(manifest, nativeManifest(launcher), { mode: 0o600 });
  chmodSync(manifest, 0o600);
  out.write(`wrote ${launcher}\n`);
  out.write(`wrote ${manifest}\n`);
  if (claude) {
    const removed = await run("claude", REMOVE_ARGS, { timeoutMs: CLAUDE_TIMEOUT_MS });
    if (removed.status === "timeout") {
      // A remove still running in a grandchild could undo the add that follows.
      out.write("claude mcp remove did not finish in 30 s\n");
      return 1;
    }
    const addArgs = claudeAddArgs(node, main);
    const added = await run("claude", addArgs, { timeoutMs: CLAUDE_TIMEOUT_MS });
    if (added.status === "ok") {
      out.write("registered Foxleash with Claude Code\n");
    } else if (added.status === "missing") {
      out.write(
        "Claude Code (claude) was not found on PATH; to register Foxleash yourself, run:\n",
      );
      out.write(`${["claude", ...addArgs].map(shellQuote).join(" ")}\n`);
    } else if (added.status === "failed") {
      out.write(`claude mcp add: ${detail(added)}\n`);
      return 1;
    } else {
      out.write("claude mcp add did not finish in 30 s\n");
      return 1;
    }
  }
  out.write("For another MCP client, register this stdio server:\n");
  out.write(
    `${JSON.stringify({ mcpServers: { foxleash: { command: node, args: [main, "mcp"] } } })}\n`,
  );
  if (!(await installExtension(options))) {
    return 1;
  }
  out.write(`Next: ${program.kind === "bundle" ? "npx foxleash doctor" : "npm run doctor"}\n`);
  return 0;
}

/**
 * Writes `from`'s bytes to `to` at mode 0600: under a new random name in the same folder, then
 * renamed onto `to`, so a host Firefox starts meanwhile runs the old file or the new one.
 */
function copyProgram(from: string, to: string): void {
  // Read first: setup run from the installed copy replaces the file it runs from.
  const bytes = readFileSync(from);
  const temp = join(
    dirname(to),
    `.foxleash.mjs.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  // O_EXCL: never through a symlink at the name, and never over an existing file.
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      // The umask may have removed bits from the mode openSync created the file with.
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    // Replaces a file or a symlink at `to`, without following it.
    renameSync(temp, to);
  } catch (error) {
    removeFile(temp);
    throw error;
  }
}

/** False after it printed why the extension step failed. */
async function installExtension(options: InstallOptions): Promise<boolean> {
  const { extension, launch, out } = options;
  if (extension.kind === "none") {
    return true;
  }
  if (extension.kind === "page") {
    out.write(`Install the Foxleash add-on in Firefox from ${ADDON_PAGE_URL}\n`);
    return true;
  }
  const path = localExtension(extension.path, out);
  if (path === undefined) {
    return false;
  }
  // The file stays: Firefox reads it again when the user confirms the installation.
  const launched = await launch("firefox", [path]);
  if (launched.status === "ok") {
    out.write(`opened ${path} in Firefox; confirm the installation there\n`);
    return true;
  }
  if (launched.status === "missing") {
    out.write(
      `Firefox (firefox) was not found on PATH; open ${path} in Firefox to install the extension\n`,
    );
    return true;
  }
  out.write(
    `could not start firefox: ${launched.error}; open ${path} in Firefox to install the extension\n`,
  );
  return false;
}

function localExtension(path: string, out: NodeJS.WritableStream): string | undefined {
  if (!isFile(path)) {
    out.write(`no file at ${path}\n`);
    return undefined;
  }
  return path;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

export async function uninstall(options: UninstallOptions): Promise<number> {
  const { home, claude, run, out, uid = process.getuid?.() } = options;
  const refusal = homeRefusal(home, uid);
  if (refusal !== undefined) {
    out.write(refusal);
    return 1;
  }
  if (claude) {
    const result = await run("claude", REMOVE_ARGS, { timeoutMs: CLAUDE_TIMEOUT_MS });
    out.write(`${removeMessage(result)}\n`);
  }
  const { launcher, manifest, program } = installPaths(home);
  const removed = [manifest, launcher, program].filter((path) => removeFile(path));
  for (const path of removed) {
    out.write(`removed ${path}\n`);
  }
  removeEmptyDir(dirname(launcher));
  if (removed.length === 0) {
    out.write("the native host was not installed\n");
  }
  return 0;
}

function homeRefusal(home: string, uid: number | undefined): string | undefined {
  if (!isAbsolute(home)) {
    return `HOME is not an absolute path: ${JSON.stringify(home)}\n`;
  }
  if (statSync(home).uid !== uid) {
    return `HOME belongs to another user: ${JSON.stringify(home)}\n`;
  }
  return undefined;
}

export function installPaths(home: string): {
  launcher: string;
  manifest: string;
  program: string;
} {
  return {
    launcher: join(home, ".local", "share", "foxleash", "foxleash-host"),
    manifest: join(home, ".mozilla", "native-messaging-hosts", `${NATIVE_HOST_NAME}.json`),
    program: join(home, ".local", "share", "foxleash", "foxleash.mjs"),
  };
}

/** The file Firefox and Claude Code run: the checkout's main.ts, or the installed copy. */
export function programPath(program: Program, home: string): string {
  return program.kind === "source" ? program.main : installPaths(home).program;
}

export function launcherScript(node: string, main: string): string {
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(main)} host\n`;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function nativeManifest(launcherPath: string): string {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Foxleash native messaging host",
    path: launcherPath,
    type: "stdio",
    allowed_extensions: [EXTENSION_ID],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function claudeAddArgs(node: string, main: string): string[] {
  return ["mcp", "add", "-s", "user", CLAUDE_SERVER_NAME, "--", node, main, "mcp"];
}

function detail(result: { code: number; stderr: string }): string {
  const stderr = result.stderr.trim();
  return stderr === "" ? `exited with code ${result.code}` : stderr;
}

function removeMessage(result: RunResult): string {
  switch (result.status) {
    case "ok":
      return "removed the Claude Code registration";
    case "missing":
      return "claude is not on PATH; registration not touched";
    case "failed":
      return `claude mcp remove: ${detail(result)}`;
    case "timeout":
      return "claude mcp remove did not finish in 30 s; registration unknown";
  }
}

function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function removeEmptyDir(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    const code = errorCode(error);
    // ENOTDIR: the directory is a symlink (dotfile managers make those); the link stays.
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "ENOTDIR") {
      throw error;
    }
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
