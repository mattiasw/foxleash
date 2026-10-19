import { type ChildProcess, type ExecFileException, execFile, spawn } from "node:child_process";

export type RunResult =
  | { status: "ok" | "failed"; code: number; stdout: string; stderr: string }
  | { status: "missing" }
  | { status: "timeout" };

export type Run = typeof runCommand;

export type LaunchResult =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "failed"; error: string };

export type Launch = typeof launchDetached;

export function runCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    // Our own flag, not execFile's timeout: a child that exits cleanly on SIGTERM must not read as ok.
    let timedOut = false;
    const child = execFile(
      command,
      [...args],
      { shell: false, encoding: "utf8" },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        resolve(timedOut ? { status: "timeout" } : toResult(error, stdout, stderr));
      },
    );
    child.stdin?.end();
    const timer = setTimeout(() => {
      timedOut = true;
      // A grandchild holding the pipes would otherwise keep the call open past the bound.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill();
    }, options.timeoutMs);
  });
}

function toResult(error: ExecFileException | null, stdout: string, stderr: string): RunResult {
  if (error === null) {
    return { status: "ok", code: 0, stdout, stderr };
  }
  if (error.code === "ENOENT") {
    return { status: "missing" };
  }
  if (typeof error.code === "number") {
    return { status: "failed", code: error.code, stdout, stderr };
  }
  return { status: "failed", code: -1, stdout, stderr: stderr === "" ? error.message : stderr };
}

export function launchDetached(command: string, args: readonly string[]): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Not waited for: the program may be the user's Firefox, which keeps running. Its own
      // session keeps a Ctrl-C in our terminal away from it.
      child = spawn(command, [...args], { detached: true, stdio: "ignore", shell: false });
    } catch (error: unknown) {
      // spawn throws for some execve errors and for invalid arguments; the rest arrive as an error event.
      resolve({ status: "failed", error: launchError(error) });
      return;
    }
    child.once("spawn", () => resolve({ status: "ok" }));
    // on, not once: a second error event without a listener would crash the process.
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve(
        error.code === "ENOENT"
          ? { status: "missing" }
          : { status: "failed", error: launchError(error) },
      );
    });
    child.unref();
  });
}

function launchError(error: unknown): string {
  if (error instanceof Error) {
    return "code" in error && typeof error.code === "string" ? error.code : error.message;
  }
  return String(error);
}
