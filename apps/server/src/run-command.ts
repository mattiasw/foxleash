import { type ExecFileException, execFile } from "node:child_process";

export type RunResult =
  | { status: "ok" | "failed"; code: number; stdout: string; stderr: string }
  | { status: "missing" }
  | { status: "timeout" };

export type Run = typeof runCommand;

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
