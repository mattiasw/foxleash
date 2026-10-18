import { chmodSync, mkdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@foxhand/protocol";
import type { Run, RunResult } from "./run-command.ts";

const CLAUDE_SERVER_NAME = "foxhand";
const CLAUDE_TIMEOUT_MS = 30_000;
const REMOVE_ARGS = ["mcp", "remove", "-s", "user", CLAUDE_SERVER_NAME];

export interface InstallOptions {
  home: string;
  node: string;
  main: string;
  claude: boolean;
  run: Run;
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
  const { home, node, main, claude, run, out, uid = process.getuid?.() } = options;
  const refusal = homeRefusal(home, uid);
  if (refusal !== undefined) {
    out.write(refusal);
    return 1;
  }
  const { launcher, manifest } = installPaths(home);
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  // Only Foxhand uses this directory; the shared native-messaging-hosts one keeps its mode.
  chmodSync(dirname(launcher), 0o700);
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
      out.write("registered Foxhand with Claude Code\n");
    } else if (added.status === "missing") {
      out.write("Claude Code (claude) was not found on PATH; to register Foxhand yourself, run:\n");
      out.write(`${["claude", ...addArgs].map(shellQuote).join(" ")}\n`);
    } else if (added.status === "failed") {
      out.write(`claude mcp add: ${detail(added)}\n`);
      return 1;
    } else {
      out.write("claude mcp add did not finish in 30 s\n");
      return 1;
    }
  }
  out.write("Next: npm run doctor\n");
  return 0;
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
  const { launcher, manifest } = installPaths(home);
  const removed = [manifest, launcher].filter((path) => removeFile(path));
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

export function installPaths(home: string): { launcher: string; manifest: string } {
  return {
    launcher: join(home, ".local", "share", "foxhand", "foxhand-host"),
    manifest: join(home, ".mozilla", "native-messaging-hosts", `${NATIVE_HOST_NAME}.json`),
  };
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
    description: "Foxhand native messaging host",
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
