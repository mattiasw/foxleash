import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import {
  type CliDeps,
  COMMANDS,
  type Command,
  type CommandOptions,
  programOf,
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
        "Usage: foxleash <command>",
        "",
        "Commands:",
        "  mcp                      Run the MCP server (your MCP client starts it)",
        "  host                     Run the native messaging host (Firefox starts it)",
        "  setup [--no-claude] [--no-extension | --xpi <path>]",
        "                           Set up the native host, Claude Code and the extension",
        "  uninstall [--no-claude]  Remove the native host and Foxleash from Claude Code",
        "  doctor                   Check the installation and the connection to Firefox",
        "  probe [--out <path>] <url>...",
        "                           Measure which synthetic input works on each page",
        "",
        "--no-claude leaves your Claude Code configuration unchanged.",
        "setup names the add-on's page on Firefox Add-ons; --xpi opens a local .xpi",
        "file in Firefox instead, and --no-extension skips it.",
        "probe writes <path>.json and .md, by default ./foxleash-probe-<date>-<time>.",
        "",
      ].join("\n"),
    );
    for (const line of USAGE.split("\n")) {
      assert.ok(line.length <= 80, line);
    }
  });
});

describe("runCli on an old Node.js", () => {
  const invocations: [string, string[]][] = [
    ["setup", ["setup"]],
    ["install", ["install"]],
    ["uninstall", ["uninstall"]],
    ["doctor", ["doctor"]],
    ["mcp", ["mcp"]],
    ["host", ["host", "/path/to/foxleash.json", "foxleash@mattiasw.com"]],
    ["probe", ["probe", "https://a.example/"]],
    ["--help", ["--help"]],
    ["-h", ["-h"]],
    ["no command", []],
    ["an unknown command", ["nope"]],
    ["a usage error", ["setup", "--nope"]],
  ];
  for (const nodeVersion of ["18.20.8", "20.20.2", "22.23.3", "23.11.1"]) {
    for (const [label, args] of invocations) {
      it(`refuses ${label} on Node.js ${nodeVersion} on stderr and returns 1`, async () => {
        const { deps, stdout, stderr, writes, calls } = setup({}, nodeVersion);
        assert.equal(await runCli(args, deps), 1);
        assert.deepEqual(calls, []);
        assert.equal(stdout(), "");
        assert.equal(
          stderr(),
          `Foxleash needs Node.js 24 or later, and this is Node.js ${nodeVersion}.\n`,
        );
        assert.equal(writes.length, 1);
      });
    }
  }

  for (const nodeVersion of ["24.0.0", "25.2.1"]) {
    it(`runs the command on Node.js ${nodeVersion}`, async () => {
      const { deps, stderr, calls } = setup({}, nodeVersion);
      assert.equal(await runCli(["doctor"], deps), 7);
      assert.deepEqual(calls, [{ name: "doctor", options: { noClaude: false }, deps }]);
      assert.equal(stderr(), "");
    });
  }

  for (const nodeVersion of ["", "x", "v24.0.0", "24"]) {
    it(`refuses the unreadable version ${JSON.stringify(nodeVersion)}`, async () => {
      const { deps, stdout, stderr, calls } = setup({}, nodeVersion);
      assert.equal(await runCli(["doctor"], deps), 1);
      assert.deepEqual(calls, []);
      assert.equal(stdout(), "");
      assert.equal(
        stderr(),
        `Foxleash needs Node.js 24 or later, and this is Node.js ${nodeVersion}.\n`,
      );
    });
  }
});

describe("runCli subcommands", () => {
  for (const name of ["setup", "install", "uninstall"]) {
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

  const installCases: [string[], CommandOptions][] = [
    [["--no-extension"], { noClaude: false, noExtension: true }],
    [["--xpi", "a.xpi"], { noClaude: false, xpi: "a.xpi" }],
    [["--no-claude", "--xpi", "a.xpi"], { noClaude: true, xpi: "a.xpi" }],
    [["--xpi", "a.xpi", "--no-claude"], { noClaude: true, xpi: "a.xpi" }],
    [["--no-claude", "--no-extension"], { noClaude: true, noExtension: true }],
    [["--xpi", "./-P.xpi"], { noClaude: false, xpi: "./-P.xpi" }],
  ];
  for (const name of ["setup", "install"]) {
    for (const [rest, options] of installCases) {
      it(`passes ${name} ${rest.join(" ")} as ${JSON.stringify(options)}`, async () => {
        const { deps, stdout, stderr, calls } = setup();
        assert.equal(await runCli([name, ...rest], deps), 7);
        assert.deepEqual(calls, [{ name, options, deps }]);
        assert.equal(stdout(), "");
        assert.equal(stderr(), "");
      });
    }
  }

  for (const rest of [
    ["--xpi"],
    ["--xpi", ""],
    ["--xpi", "a", "--xpi", "b"],
    ["--xpi", "a", "--no-extension"],
    ["--no-extension", "--xpi", "a"],
    ["--no-extension", "--no-extension"],
    ["--xpi", "--no-claude"],
    ["--xpi", "--no-extension"],
    ["--xpi", "-P"],
  ]) {
    for (const name of ["setup", "install"]) {
      it(`refuses ${name} ${JSON.stringify(rest)} with usage and 2`, async () => {
        const { deps, stdout, stderr, calls } = setup();
        assert.equal(await runCli([name, ...rest], deps), 2);
        assert.equal(stderr(), USAGE);
        assert.equal(stdout(), "");
        assert.deepEqual(calls, []);
      });
    }
  }

  for (const rest of [["--xpi", "a"], ["--no-extension"]]) {
    it(`refuses uninstall ${rest.join(" ")} with usage and 2`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli(["uninstall", ...rest], deps), 2);
      assert.equal(stderr(), USAGE);
      assert.equal(stdout(), "");
      assert.deepEqual(calls, []);
    });
  }

  it("runs host and ignores the arguments Firefox appends", async () => {
    const { deps, calls } = setup();
    assert.equal(
      await runCli(["host", "/path/to/foxleash.json", "foxleash@mattiasw.com"], deps),
      7,
    );
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

  for (const rest of [
    [],
    ["--out"],
    ["https://a.example/", "--out"],
    ["--out", "", "https://a.example/"],
    ["--out", "/tmp/x", "--out", "/tmp/y", "https://a.example/"],
    ["--out", "/tmp/x"],
    ["--verbose", "https://a.example/"],
    ["-h", "https://a.example/"],
    ["ftp://x"],
    ["https://a.example/", "not a url"],
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
  ]) {
    it(`refuses probe ${JSON.stringify(rest)} with usage and 2`, async () => {
      const { deps, stdout, stderr, calls } = setup();
      assert.equal(await runCli(["probe", ...rest], deps), 2);
      assert.equal(stderr(), USAGE);
      assert.equal(stdout(), "");
      assert.deepEqual(calls, []);
    });
  }

  it("passes probe its URLs in order and --out wherever it stands", async () => {
    const { deps, calls } = setup();
    assert.equal(
      await runCli(["probe", "https://a.example/", "--out", "/tmp/x", "http://b.example/"], deps),
      7,
    );
    assert.deepEqual(calls, [
      {
        name: "probe",
        options: {
          noClaude: false,
          urls: ["https://a.example/", "http://b.example/"],
          out: "/tmp/x",
        },
        deps,
      },
    ]);
  });

  it("passes probe no out without --out, and the URLs as given", async () => {
    const { deps, calls } = setup();
    assert.equal(await runCli(["probe", "HTTPS://A.example"], deps), 7);
    assert.deepEqual(calls, [
      { name: "probe", options: { noClaude: false, urls: ["HTTPS://A.example"] }, deps },
    ]);
  });

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
    assert.equal(deps.nodeVersion, process.versions.node);
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

  it("registers the probe command", () => {
    assert.equal(typeof COMMANDS.get("probe"), "function");
  });

  it("registers setup, and install as another name for it", () => {
    assert.equal(typeof COMMANDS.get("setup"), "function");
    assert.equal(COMMANDS.get("install"), COMMANDS.get("setup"));
  });
});

describe("programOf", () => {
  it("runs the checkout's main.ts beside a TypeScript source file", () => {
    assert.deepEqual(programOf("/src/fox leash/apps/server/src/cli.ts"), {
      kind: "source",
      main: "/src/fox leash/apps/server/src/main.ts",
    });
  });

  it("copies the running file when it is the bundle", () => {
    assert.deepEqual(programOf("/home/u/.npm/_npx/1/node_modules/foxleash/foxleash.mjs"), {
      kind: "bundle",
      file: "/home/u/.npm/_npx/1/node_modules/foxleash/foxleash.mjs",
    });
  });
});

interface Call {
  name: string;
  options: CommandOptions;
  deps: CliDeps;
}

function setup(overrides: Record<string, Command> = {}, nodeVersion = "24.0.0") {
  const out: string[] = [];
  const err: string[] = [];
  const writes: string[] = [];
  const calls: Call[] = [];
  const commands = new Map<string, Command>();
  for (const name of ["mcp", "host", "setup", "install", "uninstall", "doctor", "probe"]) {
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
    nodeVersion,
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
