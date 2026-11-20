import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINIMUM_NODE_MAJOR, NODE_REQUIREMENT, SETUP_COMMAND } from "@foxleash/protocol";
import { doctor } from "./doctor.ts";
import { hostCommand } from "./host.ts";
import { type ExtensionSource, install, type Program, programPath, uninstall } from "./install.ts";
import { mcpCommand } from "./mcp.ts";
import { probeCommand } from "./probe.ts";
import { launchDetached, runCommand } from "./run-command.ts";
import { resolveSocketDir } from "./socket-dir.ts";
import { SERVER_VERSION } from "./version.ts";

export interface CommandOptions {
  noClaude: boolean;
  /** setup's --xpi value, as given. */
  xpi?: string;
  noExtension?: boolean;
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
  /** The running Node.js version as `process.versions.node` gives it, without a leading `v`. */
  nodeVersion: string;
}

const PROGRAM = programOf(fileURLToPath(import.meta.url));

export const COMMANDS = new Map<string, Command>();
COMMANDS.set("host", () => hostCommand(process));
COMMANDS.set("mcp", () => mcpCommand(process));
const setup: Command = (options, deps) =>
  install({
    home: homedir(),
    node: process.execPath,
    program: PROGRAM,
    claude: !options.noClaude,
    extension: extensionSource(options),
    run: runCommand,
    launch: launchDetached,
    out: deps.stdout,
  });
COMMANDS.set("setup", setup);
// The name before setup, which existing scripts still call.
COMMANDS.set("install", setup);
COMMANDS.set("uninstall", (options, deps) =>
  uninstall({ home: homedir(), claude: !options.noClaude, run: runCommand, out: deps.stdout }),
);
COMMANDS.set("doctor", (_options, deps) => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    deps.stdout.write("FAIL platform: Foxleash runs on Linux only\n");
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
    main: programPath(PROGRAM, homedir()),
    setupCommand: PROGRAM.kind === "bundle" ? SETUP_COMMAND : "npm run setup",
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

export const USAGE = `Usage: foxleash <command>

Commands:
  mcp                      Run the MCP server (your MCP client starts it)
  host                     Run the native messaging host (Firefox starts it)
  setup [--no-claude] [--no-extension | --xpi <path>]
                           Set up the native host, Claude Code and the extension
  uninstall [--no-claude]  Remove the native host and Foxleash from Claude Code
  doctor                   Check the installation and the connection to Firefox
  probe [--out <path>] <url>...
                           Measure which synthetic input works on each page

--no-claude leaves your Claude Code configuration unchanged.
setup names the add-on's page on Firefox Add-ons; --xpi opens a local .xpi
file in Firefox instead, and --no-extension skips it.
probe writes <path>.json and .md, by default ./foxleash-probe-<date>-<time>.
`;

export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  if (!nodeIsSupported(deps.nodeVersion)) {
    deps.stderr.write(
      `Foxleash needs ${NODE_REQUIREMENT}, and this is Node.js ${deps.nodeVersion}.\n`,
    );
    return 1;
  }
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

// An unparseable version reads as unsupported.
function nodeIsSupported(version: string): boolean {
  const major = Number(/^(\d+)\./.exec(version)?.[1]);
  return major >= MINIMUM_NODE_MAJOR;
}

/** The checkout's main.ts when this runs from the TypeScript source, else the running bundle. */
export function programOf(self: string): Program {
  return self.endsWith(".ts")
    ? { kind: "source", main: join(dirname(self), "main.ts") }
    : { kind: "bundle", file: self };
}

export function realDeps(): CliDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    commands: COMMANDS,
    nodeVersion: process.versions.node,
  };
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
  if (name === "setup" || name === "install") {
    return installOptions(rest);
  }
  if (rest.length === 0) {
    return { noClaude: false };
  }
  const noClaude = name === "uninstall" && rest.length === 1 && rest[0] === "--no-claude";
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

/** `[--no-claude] [--no-extension | --xpi <path>]`, each at most once. */
function installOptions(rest: string[]): CommandOptions | undefined {
  let noClaude = false;
  let noExtension = false;
  let xpi: string | undefined;
  const queue = [...rest];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (arg === "--no-claude" && !noClaude) {
      noClaude = true;
    } else if (arg === "--no-extension" && !noExtension) {
      noExtension = true;
    } else if (arg === "--xpi" && xpi === undefined) {
      const value = queue.shift();
      // A value starting with - is a forgotten path swallowing the next flag; ./-name works.
      if (value === undefined || value === "" || value.startsWith("-")) return undefined;
      xpi = value;
    } else {
      return undefined;
    }
  }
  if (noExtension && xpi !== undefined) return undefined;
  if (noExtension) return { noClaude, noExtension };
  return xpi === undefined ? { noClaude } : { noClaude, xpi };
}

function extensionSource(options: CommandOptions): ExtensionSource {
  if (options.noExtension === true) {
    return { kind: "none" };
  }
  if (options.xpi !== undefined) {
    // npm runs `npm run setup` in the package root and puts the user's directory in INIT_CWD.
    // Every process below any npm command inherits INIT_CWD, so it counts only under setup.
    const initCwd = process.env.npm_lifecycle_event === "setup" ? process.env.INIT_CWD : undefined;
    return { kind: "file", path: resolve(initCwd ?? process.cwd(), options.xpi) };
  }
  return { kind: "page" };
}
