import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { createLog, type Log } from "./log.ts";
import { resolveSocketDir } from "./socket-dir.ts";
import { registerTools, type ToolBridge } from "./tools.ts";
import { SERVER_VERSION } from "./version.ts";

export interface McpProcess {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  getuid?: () => number;
}

export interface McpOptions {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  uid: number;
  log: Log;
}

export async function mcpCommand(proc: McpProcess): Promise<number> {
  let stderrBroken = false;
  // A client that closed our stderr must not turn the next log line into an uncaught EPIPE.
  proc.stderr.on("error", () => {
    stderrBroken = true;
  });
  const write = createLog("foxhand mcp:", proc.stderr);
  const log: Log = (message, detail) => {
    if (!stderrBroken) {
      write(message, detail);
    }
  };
  if (proc.getuid === undefined) {
    log("The Foxhand MCP server runs on Linux only.");
    return 1;
  }
  return runMcp({
    stdin: proc.stdin,
    stdout: proc.stdout,
    env: proc.env,
    uid: proc.getuid(),
    log,
  });
}

export async function runMcp(options: McpOptions): Promise<number> {
  const { stdin, stdout, env, uid, log } = options;
  const bridge = new Bridge({
    socketDir: resolveSocketDir(env, uid).dir,
    uid,
    version: SERVER_VERSION,
    session: randomUUID(),
    log,
  });
  const server = createMcpServer({ bridge, version: SERVER_VERSION });
  const { promise: done, resolve } = Promise.withResolvers<number>();
  let closing = false;

  stdin.on("end", onEnd);
  stdin.on("close", onEnd);
  stdin.on("error", (error: NodeJS.ErrnoException) => {
    // The transport drops its own error listener when it closes.
    log("cannot read from the MCP client", error.code);
    void shutdown();
  });
  stdout.on("error", (error: NodeJS.ErrnoException) => {
    log("cannot write to the MCP client", error.code);
    void shutdown();
  });
  // Also fires when the transport closes itself, e.g. on a line over its 10 MiB buffer.
  server.server.onclose = onEnd;
  server.server.onerror = (error) => log("MCP transport error", error.message);
  await server.connect(new StdioServerTransport(stdin, stdout));
  return done;

  function onEnd(): void {
    void shutdown();
  }

  async function shutdown(): Promise<void> {
    // server.close() fires onclose again.
    if (closing) {
      return;
    }
    closing = true;
    try {
      await server.close();
    } finally {
      bridge.close();
      resolve(0);
    }
  }
}

export function createMcpServer(options: { bridge: ToolBridge; version: string }): McpServer {
  const server = new McpServer(
    { name: "foxhand", version: options.version },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, options.bridge);
  return server;
}
