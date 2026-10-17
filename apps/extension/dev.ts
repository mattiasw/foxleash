import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { context } from "esbuild";
import { dist, esbuildOptions, prepareDist } from "./build.ts";

const profile = join(cacheHome(), "foxhand", "dev-profile");
// web-ext creates the profile folder, but not its parents.
await mkdir(dirname(profile), { recursive: true });

await prepareDist();
const watcher = await context(esbuildOptions);
await watcher.rebuild();
await watcher.watch();

let stopping = false;
const firefox = spawn(
  "web-ext",
  [
    "run",
    "--source-dir",
    dist,
    "--firefox-profile",
    profile,
    "--profile-create-if-missing",
    "--keep-profile-changes",
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => firefox.kill(signal));
}
firefox.on("exit", (code) => stop(code ?? 1));
firefox.on("error", (error) => {
  console.error(`Could not start web-ext: ${error.message}`);
  stop(1);
});

/** `$XDG_CACHE_HOME`, or `~/.cache` when it is unset or relative, as the XDG spec says. */
function cacheHome(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
}

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  const exit = () => process.exit(code);
  watcher.dispose().then(exit, exit);
}
