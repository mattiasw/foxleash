import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { doctor } from "./doctor.ts";
import { hostCommand } from "./host.ts";
import { install, uninstall } from "./install.ts";
import { mcpCommand } from "./mcp.ts";
import { runCommand } from "./run-command.ts";
import { resolveSocketDir } from "./socket-dir.ts";
import { SERVER_VERSION } from "./version.ts";

export interface CommandOptions {
  noClaude: boolean;
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

export const USAGE = `Usage: foxhand <command>

Commands:
  mcp                      Run the MCP server (your MCP client starts it)
  host                     Run the native messaging host (Firefox starts it)
  install [--no-claude]    Set up the native host and add Foxhand to Claude Code
  uninstall [--no-claude]  Remove the native host and Foxhand from Claude Code
  doctor                   Check the installation and the connection to Firefox

--no-claude leaves your Claude Code configuration unchanged.
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
  if (rest.length === 0) {
    return { noClaude: false };
  }
  const noClaude =
    (name === "install" || name === "uninstall") && rest.length === 1 && rest[0] === "--no-claude";
  return noClaude ? { noClaude } : undefined;
}
