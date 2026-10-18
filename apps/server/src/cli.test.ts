import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import {
  type CliDeps,
  COMMANDS,
  type Command,
  type CommandOptions,
  realDeps,
  runCli,
  USAGE,
} from "./cli.ts";

describe("runCli usage", () => {
  for (const args of [[], ["nope"], ["constructor"], ["__proto__"], ["toString"]]) {
    it(`prints usage on stderr and returns 2 for ${JSON.stringify(args)}`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli(args, deps), 2);
      assert.equal(stderr(), USAGE);
      assert.equal(stdout(), "");
      assert.deepEqual(calls, []);
    });
  }

  for (const args of [["--help"], ["-h"], ["--help", "install"], ["-h", "nope"]]) {
    it(`prints usage on stdout and returns 0 for ${JSON.stringify(args)}`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli(args, deps), 0);
      assert.equal(stdout(), USAGE);
      assert.equal(stderr(), "");
      assert.deepEqual(calls, []);
    });
  }

  it("writes the usage text in one write", async () => {
    const { deps, writes } = setup();
    await runCli([], deps);
    await runCli(["--help"], deps);
    assert.deepEqual(writes, [USAGE, USAGE]);
  });

  it("lists every subcommand, on lines of at most 80 columns", () => {
    assert.equal(
      USAGE,
      [
        "Usage: foxhand <command>",
        "",
        "Commands:",
        "  mcp                      Run the MCP server (your MCP client starts it)",
        "  host                     Run the native messaging host (Firefox starts it)",
        "  install [--no-claude]    Set up the native host and add Foxhand to Claude Code",
        "  uninstall [--no-claude]  Remove the native host and Foxhand from Claude Code",
        "  doctor                   Check the installation and the connection to Firefox",
        "",
        "--no-claude leaves your Claude Code configuration unchanged.",
        "",
      ].join("\n"),
    );
    for (const line of USAGE.split("\n")) {
      assert.ok(line.length <= 80, line);
    }
  });
});

describe("runCli subcommands", () => {
  for (const name of ["install", "uninstall"]) {
    it(`passes noClaude true to ${name} with --no-claude and returns its exit code`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli([name, "--no-claude"], deps), 7);
      assert.deepEqual(calls, [{ name, options: { noClaude: true }, deps }]);
      assert.equal(stdout(), "");
      assert.equal(stderr(), "");
    });

    it(`passes noClaude false to ${name} without arguments`, async () => {
      const { deps, calls } = setup();
      assert.equal(await runCli([name], deps), 7);
      assert.deepEqual(calls, [{ name, options: { noClaude: false }, deps }]);
    });

    for (const rest of [["--no-claude", "--no-claude"], ["--nope"], ["--help"], ["-h"], ["x"]]) {
      it(`refuses ${name} ${rest.join(" ")} with usage and 2`, async () => {
        const { deps, stdout, stderr, calls } = setup();
        assert.equal(await runCli([name, ...rest], deps), 2);
        assert.equal(stderr(), USAGE);
        assert.equal(stdout(), "");
        assert.deepEqual(calls, []);
      });
    }
  }

  it("runs host and ignores the arguments Firefox appends", async () => {
    const { deps, calls } = setup();
    assert.equal(await runCli(["host", "/path/to/foxhand.json", "foxhand@mattiasw.com"], deps), 7);
    assert.deepEqual(calls, [{ name: "host", options: { noClaude: false }, deps }]);
  });

  it("runs host with --no-claude as noClaude false", async () => {
    const { deps, calls } = setup();
    assert.equal(await runCli(["host", "--no-claude"], deps), 7);
    assert.deepEqual(calls, [{ name: "host", options: { noClaude: false }, deps }]);
  });

  it("runs mcp without arguments", async () => {
    const { deps, calls } = setup();
    assert.equal(await runCli(["mcp"], deps), 7);
    assert.deepEqual(calls, [{ name: "mcp", options: { noClaude: false }, deps }]);
  });

  for (const extra of ["extra", "--no-claude"]) {
    it(`refuses mcp ${extra} with usage and 2`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli(["mcp", extra], deps), 2);
      assert.equal(stderr(), USAGE);
      assert.equal(stdout(), "");
      assert.deepEqual(calls, []);
    });
  }

  it("runs doctor without arguments", async () => {
    const { deps, calls } = setup();
    assert.equal(await runCli(["doctor"], deps), 7);
    assert.deepEqual(calls, [{ name: "doctor", options: { noClaude: false }, deps }]);
  });

  for (const extra of ["extra", "--no-claude"]) {
    it(`refuses doctor ${extra} with usage and 2`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli(["doctor", extra], deps), 2);
      assert.equal(stderr(), USAGE);
      assert.equal(stdout(), "");
      assert.deepEqual(calls, []);
    });
  }

  it("lets a command's rejection propagate", async () => {
    const { deps } = setup({
      mcp: async () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(runCli(["mcp"], deps), { message: "boom" });
  });
});

describe("realDeps", () => {
  it("returns the process streams and the command map", () => {
    const deps = realDeps();
    assert.equal(deps.stdout, process.stdout);
    assert.equal(deps.stderr, process.stderr);
    assert.equal(deps.commands, COMMANDS);
  });
});

describe("COMMANDS", () => {
  it("registers the host command", () => {
    assert.equal(typeof COMMANDS.get("host"), "function");
  });

  it("registers the mcp command", () => {
    assert.equal(typeof COMMANDS.get("mcp"), "function");
  });

  it("registers the doctor command", () => {
    assert.equal(typeof COMMANDS.get("doctor"), "function");
  });
});

interface Call {
  name: string;
  options: CommandOptions;
  deps: CliDeps;
}

function setup(overrides: Record<string, Command> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const writes: string[] = [];
  const calls: Call[] = [];
  const commands = new Map<string, Command>();
  for (const name of ["mcp", "host", "install", "uninstall", "doctor"]) {
    commands.set(name, async (options, deps) => {
      calls.push({ name, options, deps });
      return 7;
    });
  }
  for (const [name, command] of Object.entries(overrides)) {
    commands.set(name, command);
  }
  const deps: CliDeps = {
    stdout: collector(out, writes),
    stderr: collector(err, writes),
    commands,
  };
  return {
    deps,
    writes,
    calls,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function collector(chunks: string[], writes: string[]): Writable {
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      const text = String(chunk);
      chunks.push(text);
      writes.push(text);
      callback();
    },
  });
}
