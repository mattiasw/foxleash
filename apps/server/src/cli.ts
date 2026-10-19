import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { doctor } from "./doctor.ts";
import { hostCommand } from "./host.ts";
import { install, uninstall } from "./install.ts";
import { mcpCommand } from "./mcp.ts";
import { probeCommand } from "./probe.ts";
import { runCommand } from "./run-command.ts";
import { resolveSocketDir } from "./socket-dir.ts";
import { SERVER_VERSION } from "./version.ts";

export interface CommandOptions {
  noClaude: boolean;
  /** probe's report path, without its extension. */
  out?: string;
  /** probe's http(s) URLs, in order. */
  urls?: string[];
}

export type Command = (options: CommandOptions, deps: CliDeps) => Promise<number>;

export interface CliDeps {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  commands: ReadonlyMap<string, Command>;
}

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

export const COMMANDS = new Map<string, Command>();
COMMANDS.set("host", () => hostCommand(process));
COMMANDS.set("mcp", () => mcpCommand(process));
COMMANDS.set("install", (options, deps) =>
  install({
    home: homedir(),
    node: process.execPath,
    main: MAIN,
    claude: !options.noClaude,
    run: runCommand,
    out: deps.stdout,
  }),
);
COMMANDS.set("uninstall", (options, deps) =>
  uninstall({ home: homedir(), claude: !options.noClaude, run: runCommand, out: deps.stdout }),
);
COMMANDS.set("doctor", (_options, deps) => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    deps.stdout.write("FAIL platform: Foxhand runs on Linux only\n");
    return Promise.resolve(1);
  }
  const { dir, skipped } = resolveSocketDir(process.env, uid);
  return doctor({
    home: homedir(),
    socketDir: dir,
    skipped,
    uid,
    version: SERVER_VERSION,
    node: process.execPath,
    main: MAIN,
    run: runCommand,
    spawn,
    out: deps.stdout,
  });
});

COMMANDS.set("probe", (options, deps) =>
  probeCommand({
    urls: options.urls ?? [],
    out: options.out,
    stdout: deps.stdout,
    stderr: deps.stderr,
  }),
);

export const USAGE = `Usage: foxhand <command>

Commands:
  mcp                      Run the MCP server (your MCP client starts it)
  host                     Run the native messaging host (Firefox starts it)
  install [--no-claude]    Set up the native host and add Foxhand to Claude Code
  uninstall [--no-claude]  Remove the native host and Foxhand from Claude Code
  doctor                   Check the installation and the connection to Firefox
  probe [--out <path>] <url>...
                           Measure which synthetic input works on each page

--no-claude leaves your Claude Code configuration unchanged.
probe writes <path>.json and .md, by default ./foxhand-probe-<date>-<time>.
`;

export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  const name = args[0];
  if (name === "--help" || name === "-h") {
    deps.stdout.write(USAGE);
    return 0;
  }
  if (name === undefined) {
    return usageError(deps);
  }
  const command = deps.commands.get(name);
  if (command === undefined) {
    return usageError(deps);
  }
  const options = parseOptions(name, args.slice(1));
  if (options === undefined) {
    return usageError(deps);
  }
  return await command(options, deps);
}

export function realDeps(): CliDeps {
  return { stdout: process.stdout, stderr: process.stderr, commands: COMMANDS };
}

function usageError(deps: CliDeps): number {
  deps.stderr.write(USAGE);
  return 2;
}

function parseOptions(name: string, rest: string[]): CommandOptions | undefined {
  // Firefox appends the native manifest path and, on some versions, the extension id.
  if (name === "host") {
    return { noClaude: false };
  }
  if (name === "probe") {
    return probeOptions(rest);
  }
  if (rest.length === 0) {
    return { noClaude: false };
  }
  const noClaude =
    (name === "install" || name === "uninstall") && rest.length === 1 && rest[0] === "--no-claude";
  return noClaude ? { noClaude } : undefined;
}

/** `[--out <path>] <url>...`: at least one http or https URL, and --out at most once. */
function probeOptions(rest: string[]): CommandOptions | undefined {
  const urls: string[] = [];
  let out: string | undefined;
  const queue = [...rest];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (arg === "--out") {
      const value = queue.shift();
      if (out !== undefined || value === undefined || value === "") return undefined;
      out = value;
    } else if (arg.startsWith("-")) {
      return undefined;
    } else {
      const parsed = URL.parse(arg);
      if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        return undefined;
      }
      urls.push(arg);
    }
  }
  if (urls.length === 0) return undefined;
  return out === undefined ? { noClaude: false, urls } : { noClaude: false, urls, out };
}
