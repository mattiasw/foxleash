import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { hostCommand } from "./host.ts";
import { install, uninstall } from "./install.ts";
import { mcpCommand } from "./mcp.ts";
import { runCommand } from "./run-command.ts";

export interface CommandOptions {
  noClaude: boolean;
}

export type Command = (options: CommandOptions, deps: CliDeps) => Promise<number>;

export interface CliDeps {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  commands: ReadonlyMap<string, Command>;
}

export const COMMANDS = new Map<string, Command>();
COMMANDS.set("host", () => hostCommand(process));
COMMANDS.set("mcp", () => mcpCommand(process));
COMMANDS.set("install", (options, deps) =>
  install({
    home: homedir(),
    node: process.execPath,
    main: fileURLToPath(new URL("./main.ts", import.meta.url)),
    claude: !options.noClaude,
    run: runCommand,
    out: deps.stdout,
  }),
);
COMMANDS.set("uninstall", (options, deps) =>
  uninstall({ home: homedir(), claude: !options.noClaude, run: runCommand, out: deps.stdout }),
);

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
