import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ADDON_PAGE_URL } from "@foxleash/protocol";
import { type CliDeps, COMMANDS, type CommandOptions } from "./cli.ts";
import {
  claudeAddArgs,
  type ExtensionSource,
  install,
  installPaths,
  launcherScript,
  nativeManifest,
  type Program,
  programPath,
  shellQuote,
  uninstall,
} from "./install.ts";
import { type LaunchResult, type RunResult, runCommand } from "./run-command.ts";

type Call = [string, string[], { timeoutMs: number }];

const NODE = "/opt/my node/it's/node";
const MAIN = "/src/fox 'hand'/main.ts";
const QUOTED_NODE = "'/opt/my node/it'\\''s/node'";
const QUOTED_MAIN = "'/src/fox '\\''hand'\\''/main.ts'";
const REMOVE: Call = ["claude", ["mcp", "remove", "-s", "user", "foxleash"], { timeoutMs: 30000 }];
const ADD: Call = [
  "claude",
  ["mcp", "add", "-s", "user", "foxleash", "--", NODE, MAIN, "mcp"],
  { timeoutMs: 30000 },
];
const OK: RunResult = { status: "ok", code: 0, stdout: "", stderr: "" };
const PAGE: ExtensionSource = { kind: "page" };
const MCP_HEADER = "For another MCP client, register this stdio server:";
const MCP_CONFIG =
  '{"mcpServers":{"foxleash":{"command":"/opt/my node/it\'s/node","args":["/src/fox \'hand\'/main.ts","mcp"]}}}';
const PAGE_LINE = `Install the Foxleash add-on in Firefox from ${ADDON_PAGE_URL}`;
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("shellQuote", () => {
  for (const s of ["a b", "it's", '"x"', "$(echo no)", "`echo no`", "\\n", "a\nb", "*", "''", ""]) {
    it(`round-trips ${JSON.stringify(s)} through /bin/sh`, { timeout: 10_000 }, async () => {
      const result = await runCommand("/bin/sh", ["-c", `printf '%s' ${shellQuote(s)}`], {
        timeoutMs: 5000,
      });
      assert.deepEqual(result, { status: "ok", code: 0, stdout: s, stderr: "" });
    });
  }

  it("closes and reopens the quotes around a single quote", () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });
});

describe("install", () => {
  it("writes the launcher and the native manifest under HOME", async () => {
    const home = tempDir();
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.equal(
      readFileSync(t.launcher, "utf8"),
      `#!/bin/sh\nexec ${QUOTED_NODE} ${QUOTED_MAIN} host\n`,
    );
    assert.equal(mode(t.launcher), 0o700);
    for (const dir of [
      ".local",
      ".local/share",
      ".local/share/foxleash",
      ".mozilla",
      ".mozilla/native-messaging-hosts",
    ]) {
      assert.equal(mode(join(home, dir)), 0o700, dir);
    }
    const expected = {
      name: "foxleash",
      description: "Foxleash native messaging host",
      path: t.launcher,
      type: "stdio",
      allowed_extensions: ["foxleash@mattiasw.com"],
    };
    const text = readFileSync(t.manifest, "utf8");
    assert.deepEqual(JSON.parse(text), expected);
    assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`);
    assert.equal(mode(t.manifest), 0o600);
    assert.deepEqual(installPaths(home), {
      launcher: t.launcher,
      manifest: t.manifest,
      program: join(home, ".local", "share", "foxleash", "foxleash.mjs"),
    });
    assert.deepEqual(readdirSync(join(home, ".local", "share", "foxleash")), ["foxleash-host"]);
  });

  it("replaces the Claude Code registration even when the remove fails", async () => {
    const t = setup(tempDir(), [{ status: "failed", code: 1, stdout: "", stderr: "x\n" }, OK]);
    assert.equal(await install(t.options), 0);
    assert.deepEqual(t.calls, [REMOVE, ADD]);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        "registered Foxleash with Claude Code",
        MCP_HEADER,
        MCP_CONFIG,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  it("returns 1 without adding when the remove times out", async () => {
    const t = setup(tempDir(), [{ status: "timeout" }]);
    assert.equal(await install(t.options), 1);
    assert.deepEqual(t.calls, [REMOVE]);
    assert.equal(
      t.output(),
      `wrote ${t.launcher}\nwrote ${t.manifest}\nclaude mcp remove did not finish in 30 s\n`,
    );
  });

  it("never runs claude with claude false", async () => {
    const t = setup(tempDir(), []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.deepEqual(t.calls, []);
    assert.ok(existsSync(t.launcher));
    assert.ok(existsSync(t.manifest));
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        MCP_HEADER,
        MCP_CONFIG,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  it("prints the command to run when claude is not on PATH", async () => {
    const t = setup(tempDir(), [{ status: "missing" }, { status: "missing" }]);
    assert.equal(await install(t.options), 0);
    assert.deepEqual(t.calls, [REMOVE, ADD]);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        "Claude Code (claude) was not found on PATH; to register Foxleash yourself, run:",
        `'claude' 'mcp' 'add' '-s' 'user' 'foxleash' '--' ${QUOTED_NODE} ${QUOTED_MAIN} 'mcp'`,
        MCP_HEADER,
        MCP_CONFIG,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  it("prints the trimmed stderr and returns 1 when the add fails", async () => {
    const t = setup(tempDir(), [OK, { status: "failed", code: 1, stdout: "", stderr: "  boom\n" }]);
    assert.equal(await install(t.options), 1);
    assert.equal(t.output(), `wrote ${t.launcher}\nwrote ${t.manifest}\nclaude mcp add: boom\n`);
  });

  it("prints the exit code when a failed add printed nothing", async () => {
    const t = setup(tempDir(), [OK, { status: "failed", code: 5, stdout: "", stderr: "" }]);
    assert.equal(await install(t.options), 1);
    assert.equal(
      t.output(),
      `wrote ${t.launcher}\nwrote ${t.manifest}\nclaude mcp add: exited with code 5\n`,
    );
  });

  it("returns 1 without the next step when the add times out", async () => {
    const t = setup(tempDir(), [OK, { status: "timeout" }]);
    assert.equal(await install(t.options), 1);
    assert.equal(
      t.output(),
      `wrote ${t.launcher}\nwrote ${t.manifest}\nclaude mcp add did not finish in 30 s\n`,
    );
  });

  it("overwrites an existing install and repairs the file modes", async () => {
    const home = tempDir();
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    chmodSync(t.launcher, 0o644);
    chmodSync(t.manifest, 0o664);
    writeFileSync(t.launcher, "junk");
    writeFileSync(t.manifest, "junk");
    const second = setup(home, []);
    const program: Program = { kind: "source", main: "/other/main.ts" };
    const options = { ...second.options, node: "/usr/bin/node", program };
    assert.equal(await install({ ...options, claude: false }), 0);
    assert.equal(mode(t.launcher), 0o700);
    assert.equal(mode(t.manifest), 0o600);
    assert.equal(
      readFileSync(t.launcher, "utf8"),
      "#!/bin/sh\nexec '/usr/bin/node' '/other/main.ts' host\n",
    );
    assert.equal(readFileSync(t.manifest, "utf8"), nativeManifest(t.launcher));
  });

  it("makes an existing launcher directory private again", async () => {
    const home = tempDir();
    const dir = join(home, ".local", "share", "foxleash");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.equal(mode(dir), 0o700);
  });

  it("writes through a launcher directory that is a symlink", async () => {
    const home = tempDir();
    const other = tempDir();
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    const link = join(home, ".local", "share", "foxleash");
    symlinkSync(other, link);
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.equal(readFileSync(join(other, "foxleash-host"), "utf8"), launcherScript(NODE, MAIN));
    const out = setup(home, []);
    assert.equal(await uninstall({ ...out.options, claude: false }), 0);
    assert.equal(out.output(), `removed ${t.manifest}\nremoved ${t.launcher}\n`);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.deepEqual(readdirSync(other), []);
  });
});

describe("the extension step", () => {
  it("names the add-on's page and launches nothing", async () => {
    const home = tempDir();
    const t = setup(home, [OK, OK]);
    assert.equal(await install({ ...t.options, extension: PAGE }), 0);
    assert.deepEqual(t.calls, [REMOVE, ADD]);
    assert.deepEqual(t.launches, []);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        "registered Foxleash with Claude Code",
        MCP_HEADER,
        MCP_CONFIG,
        PAGE_LINE,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
    assert.equal(existsSync(join(home, ".cache")), false);
  });

  it("opens a local file as given", async () => {
    const xpi = join(tempDir(), "my foxleash.xpi");
    writeFileSync(xpi, "signed");
    const t = setup(tempDir(), []);
    const extension: ExtensionSource = { kind: "file", path: xpi };
    assert.equal(await install({ ...t.options, claude: false, extension }), 0);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.launches, [["firefox", [xpi]]]);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        MCP_HEADER,
        MCP_CONFIG,
        `opened ${xpi} in Firefox; confirm the installation there`,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  for (const [name, path] of [
    ["a missing file", (dir: string) => join(dir, "missing.xpi")],
    ["a directory", (dir: string) => dir],
    ["a path through a file", (dir: string) => join(dir, "file.xpi", "x")],
  ] as const) {
    it(`returns 1 for ${name} given as the local file`, async () => {
      const dir = tempDir();
      writeFileSync(join(dir, "file.xpi"), "signed");
      const xpi = path(dir);
      const t = setup(tempDir(), []);
      const extension: ExtensionSource = { kind: "file", path: xpi };
      assert.equal(await install({ ...t.options, claude: false, extension }), 1);
      assert.deepEqual(t.calls, []);
      assert.deepEqual(t.launches, []);
      assert.equal(
        t.output(),
        [
          `wrote ${t.launcher}`,
          `wrote ${t.manifest}`,
          MCP_HEADER,
          MCP_CONFIG,
          `no file at ${xpi}`,
          "",
        ].join("\n"),
      );
      assert.ok(existsSync(t.launcher));
      assert.ok(existsSync(t.manifest));
    });
  }

  it("does nothing for the extension without a source", async () => {
    const home = tempDir();
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.launches, []);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        MCP_HEADER,
        MCP_CONFIG,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  it("prints the file to open and returns 0 when firefox is not on PATH", async () => {
    const xpi = localXpi();
    const t = setup(tempDir(), [], { status: "missing" });
    const extension: ExtensionSource = { kind: "file", path: xpi };
    assert.equal(await install({ ...t.options, claude: false, extension }), 0);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        MCP_HEADER,
        MCP_CONFIG,
        `Firefox (firefox) was not found on PATH; open ${xpi} in Firefox to install the extension`,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  it("returns 1 when firefox could not be started", async () => {
    const xpi = localXpi();
    const t = setup(tempDir(), [], { status: "failed", error: "EACCES" });
    const extension: ExtensionSource = { kind: "file", path: xpi };
    assert.equal(await install({ ...t.options, claude: false, extension }), 1);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        MCP_HEADER,
        MCP_CONFIG,
        `could not start firefox: EACCES; open ${xpi} in Firefox to install the extension`,
        "",
      ].join("\n"),
    );
  });

  const claudeFailures: [string, RunResult[], Call[]][] = [
    ["the remove times out", [{ status: "timeout" }], [REMOVE]],
    ["the add fails", [OK, { status: "failed", code: 1, stdout: "", stderr: "x" }], [REMOVE, ADD]],
  ];
  for (const [name, results, calls] of claudeFailures) {
    it(`skips the extension and the MCP configuration when ${name}`, async () => {
      const t = setup(tempDir(), results);
      const extension: ExtensionSource = { kind: "file", path: localXpi() };
      assert.equal(await install({ ...t.options, extension }), 1);
      assert.deepEqual(t.calls, calls);
      assert.deepEqual(t.launches, []);
      assert.ok(!t.output().includes(MCP_HEADER), t.output());
    });
  }
});

describe("the MCP configuration", () => {
  const routes: [string, Program, string][] = [
    ["the source", { kind: "source", main: MAIN }, MAIN],
    ["the bundle", { kind: "bundle", file: "" }, ""],
  ];
  for (const [name, given, expectedMain] of routes) {
    for (const [claude, results] of [
      ["without Claude Code", []],
      ["after a registration", [OK, OK]],
      ["when claude is not on PATH", [{ status: "missing" }, { status: "missing" }]],
    ] as const) {
      it(`names node and the program run from ${name} ${claude}`, async () => {
        const home = tempDir();
        const program: Program =
          given.kind === "bundle" ? { kind: "bundle", file: bundleFile("x") } : given;
        const main = expectedMain === "" ? installPaths(home).program : expectedMain;
        const t = setup(home, [...results]);
        assert.equal(await install({ ...t.options, claude: results.length > 0, program }), 0);
        const lines = t.output().split("\n");
        const config = lines[lines.indexOf(MCP_HEADER) + 1];
        assert.ok(config !== undefined, t.output());
        assert.deepEqual(JSON.parse(config), {
          mcpServers: { foxleash: { command: NODE, args: [main, "mcp"] } },
        });
      });
    }
  }
});

describe("the bundle route", () => {
  it("copies the bundle and points the launcher and Claude Code at the copy", async () => {
    const home = tempDir();
    const file = bundleFile("#!/usr/bin/env node\nconsole.log(1);\n");
    const t = setup(home, [OK, OK]);
    assert.equal(await install({ ...t.options, program: { kind: "bundle", file } }), 0);
    const copy = installPaths(home).program;
    assert.deepEqual(readFileSync(copy), readFileSync(file));
    assert.equal(mode(copy), 0o600);
    assert.equal(readFileSync(t.launcher, "utf8"), launcherScript(NODE, copy));
    assert.deepEqual(t.calls, [
      REMOVE,
      ["claude", claudeAddArgs(NODE, copy), { timeoutMs: 30000 }],
    ]);
    assert.equal(
      t.output(),
      [
        `wrote ${copy}`,
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        "registered Foxleash with Claude Code",
        MCP_HEADER,
        JSON.stringify({ mcpServers: { foxleash: { command: NODE, args: [copy, "mcp"] } } }),
        "Next: npx foxleash doctor",
        "",
      ].join("\n"),
    );
    assert.deepEqual(readdirSync(dirname(copy)).sort(), ["foxleash-host", "foxleash.mjs"]);
  });

  it("makes the copy 0600 under a umask that removes the owner's write bit", async () => {
    const home = tempDir();
    const program: Program = { kind: "bundle", file: bundleFile("x") };
    // The folders exist first: under this umask, mkdir would make ones no file can go into.
    assert.equal(await install({ ...setup(home, []).options, claude: false }), 0);
    const t = setup(home, []);
    const previous = process.umask(0o277);
    try {
      assert.equal(await install({ ...t.options, claude: false, program }), 0);
    } finally {
      process.umask(previous);
    }
    assert.equal(mode(installPaths(home).program), 0o600);
  });

  it("closes the copy it wrote", async () => {
    const home = tempDir();
    const program: Program = { kind: "bundle", file: bundleFile("x") };
    // The first run opens whatever Node opens once, so the second shows only what install leaks.
    assert.equal(await install({ ...setup(home, []).options, claude: false, program }), 0);
    const before = readdirSync("/proc/self/fd").length;
    assert.equal(await install({ ...setup(home, []).options, claude: false, program }), 0);
    assert.equal(readdirSync("/proc/self/fd").length, before);
  });

  it("replaces an existing copy", async () => {
    const home = tempDir();
    const first: Program = { kind: "bundle", file: bundleFile("old") };
    const second: Program = { kind: "bundle", file: bundleFile("new") };
    assert.equal(await install({ ...setup(home, []).options, claude: false, program: first }), 0);
    chmodSync(installPaths(home).program, 0o644);
    assert.equal(await install({ ...setup(home, []).options, claude: false, program: second }), 0);
    assert.equal(readFileSync(installPaths(home).program, "utf8"), "new");
    assert.equal(mode(installPaths(home).program), 0o600);
  });

  it("works when run from the installed copy itself", async () => {
    const home = tempDir();
    const first: Program = { kind: "bundle", file: bundleFile("same") };
    assert.equal(await install({ ...setup(home, []).options, claude: false, program: first }), 0);
    const copy = installPaths(home).program;
    const self: Program = { kind: "bundle", file: copy };
    assert.equal(await install({ ...setup(home, []).options, claude: false, program: self }), 0);
    assert.equal(readFileSync(copy, "utf8"), "same");
    assert.deepEqual(readdirSync(dirname(copy)).sort(), ["foxleash-host", "foxleash.mjs"]);
  });

  it("replaces a symlink at the copy's name without writing through it", async () => {
    const home = tempDir();
    const target = join(tempDir(), "target");
    writeFileSync(target, "theirs");
    const copy = installPaths(home).program;
    mkdirSync(dirname(copy), { recursive: true });
    symlinkSync(target, copy);
    const program: Program = { kind: "bundle", file: bundleFile("ours") };
    assert.equal(await install({ ...setup(home, []).options, claude: false, program }), 0);
    assert.ok(lstatSync(copy).isFile());
    assert.equal(readFileSync(copy, "utf8"), "ours");
    assert.equal(readFileSync(target, "utf8"), "theirs");
  });

  it("fails before the launcher when a directory holds the copy's name", async () => {
    const home = tempDir();
    const copy = installPaths(home).program;
    mkdirSync(copy, { recursive: true });
    const t = setup(home, []);
    const program: Program = { kind: "bundle", file: bundleFile("x") };
    await assert.rejects(install({ ...t.options, claude: false, program }), { code: "EISDIR" });
    assert.deepEqual(readdirSync(dirname(copy)), ["foxleash.mjs"]);
    assert.equal(existsSync(t.manifest), false);
    assert.equal(t.output(), "");
  });

  it("copies nothing from the source", async () => {
    const home = tempDir();
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.equal(existsSync(installPaths(home).program), false);
    assert.equal(programPath({ kind: "source", main: MAIN }, home), MAIN);
  });

  it("removes the copy at uninstall", async () => {
    const home = tempDir();
    const program: Program = { kind: "bundle", file: bundleFile("x") };
    assert.equal(await install({ ...setup(home, []).options, claude: false, program }), 0);
    const t = setup(home, []);
    assert.equal(await uninstall({ ...t.options, claude: false }), 0);
    const copy = installPaths(home).program;
    assert.equal(t.output(), `removed ${t.manifest}\nremoved ${t.launcher}\nremoved ${copy}\n`);
    assert.equal(existsSync(dirname(copy)), false);
  });
});

describe("a HOME that is not absolute", () => {
  for (const home of ["", "relative/home"]) {
    for (const name of ["install", "install from the bundle", "uninstall"]) {
      it(`makes ${name} refuse ${JSON.stringify(home)}`, async () => {
        const cwd = tempDir();
        const previous = process.cwd();
        const file = bundleFile("x");
        process.chdir(cwd);
        try {
          const t = setup(home, []);
          const program: Program = { kind: "bundle", file };
          const code =
            name === "uninstall"
              ? await uninstall(t.options)
              : await install(name === "install" ? t.options : { ...t.options, program });
          assert.equal(code, 1);
          assert.equal(t.output(), `HOME is not an absolute path: ${JSON.stringify(home)}\n`);
          assert.deepEqual(t.calls, []);
          assert.deepEqual(readdirSync(cwd), []);
        } finally {
          process.chdir(previous);
        }
      });
    }
  }
});

describe("a HOME owned by another user", () => {
  for (const name of ["install", "install from the bundle", "uninstall"]) {
    it(`makes ${name} refuse it`, async () => {
      const home = tempDir();
      const t = setup(home, []);
      const options = { ...t.options, uid: statSync(home).uid + 1 };
      const program: Program = { kind: "bundle", file: bundleFile("x") };
      const code =
        name === "uninstall"
          ? await uninstall(options)
          : await install(name === "install" ? options : { ...options, program });
      assert.equal(code, 1);
      assert.equal(t.output(), `HOME belongs to another user: ${JSON.stringify(home)}\n`);
      assert.deepEqual(t.calls, []);
      assert.deepEqual(readdirSync(home), []);
    });
  }
});

describe("uninstall", () => {
  const outcomes: [RunResult, string][] = [
    [OK, "removed the Claude Code registration"],
    [{ status: "missing" }, "claude is not on PATH; registration not touched"],
    [
      {
        status: "failed",
        code: 1,
        stdout: "",
        stderr: '  No MCP server named "foxleash" in user scope\n',
      },
      'claude mcp remove: No MCP server named "foxleash" in user scope',
    ],
    [{ status: "timeout" }, "claude mcp remove did not finish in 30 s; registration unknown"],
  ];
  for (const [result, line] of outcomes) {
    it(`removes the files and reports a ${result.status} remove`, async () => {
      const home = tempDir();
      await install({ ...setup(home, []).options, claude: false });
      const t = setup(home, [result]);
      assert.equal(await uninstall(t.options), 0);
      assert.deepEqual(t.calls, [REMOVE]);
      assert.equal(t.output(), `${line}\nremoved ${t.manifest}\nremoved ${t.launcher}\n`);
      assert.equal(existsSync(t.manifest), false);
      assert.equal(existsSync(t.launcher), false);
      assert.equal(existsSync(join(home, ".local", "share", "foxleash")), false);
      assert.ok(statSync(join(home, ".mozilla", "native-messaging-hosts")).isDirectory());
    });
  }

  it("prints the exit code when a failed remove printed nothing", async () => {
    const t = setup(tempDir(), [{ status: "failed", code: 4, stdout: "", stderr: "" }]);
    assert.equal(await uninstall(t.options), 0);
    assert.equal(
      t.output(),
      "claude mcp remove: exited with code 4\nthe native host was not installed\n",
    );
  });

  it("never runs claude with claude false", async () => {
    const home = tempDir();
    await install({ ...setup(home, []).options, claude: false });
    const t = setup(home, []);
    assert.equal(await uninstall({ ...t.options, claude: false }), 0);
    assert.deepEqual(t.calls, []);
    assert.equal(t.output(), `removed ${t.manifest}\nremoved ${t.launcher}\n`);
    assert.equal(existsSync(t.manifest), false);
    assert.equal(existsSync(t.launcher), false);
  });

  it("says so when nothing was installed", async () => {
    const t = setup(tempDir(), []);
    assert.equal(await uninstall({ ...t.options, claude: false }), 0);
    assert.equal(t.output(), "the native host was not installed\n");
  });

  it("keeps the launcher directory when it holds another file", async () => {
    const home = tempDir();
    await install({ ...setup(home, []).options, claude: false });
    const t = setup(home, []);
    const kept = join(home, ".local", "share", "foxleash", "other");
    writeFileSync(kept, "mine");
    assert.equal(await uninstall({ ...t.options, claude: false }), 0);
    assert.equal(existsSync(t.launcher), false);
    assert.equal(readFileSync(kept, "utf8"), "mine");
  });

  it("removes a dangling symlink at the launcher path", async () => {
    const home = tempDir();
    const t = setup(home, []);
    mkdirSync(join(home, ".local", "share", "foxleash"), { recursive: true });
    symlinkSync(join(home, "missing"), t.launcher);
    assert.equal(await uninstall({ ...t.options, claude: false }), 0);
    assert.equal(t.output(), `removed ${t.launcher}\n`);
    assert.throws(() => lstatSync(t.launcher), { code: "ENOENT" });
  });

  it("rethrows an error other than a missing file", async () => {
    const home = tempDir();
    const t = setup(home, []);
    mkdirSync(t.manifest, { recursive: true });
    await assert.rejects(uninstall({ ...t.options, claude: false }), { code: "EISDIR" });
  });

  it("rethrows an error other than a missing or non-empty directory", async () => {
    const home = tempDir();
    const t = setup(home, []);
    mkdirSync(join(home, ".local", "share", "foxleash"), { recursive: true });
    chmodSync(join(home, ".local", "share"), 0o500);
    try {
      await assert.rejects(uninstall({ ...t.options, claude: false }), { code: "EACCES" });
    } finally {
      chmodSync(join(home, ".local", "share"), 0o700);
    }
  });
});

describe("claudeAddArgs", () => {
  it("passes the node and main paths after --", () => {
    assert.deepEqual(claudeAddArgs(NODE, MAIN), ADD[1]);
  });
});

describe("the setup and uninstall commands", () => {
  it("setup and uninstall under $HOME", async () => {
    const home = tempDir();
    const previous = saveEnv();
    process.env.HOME = home;
    process.env.PATH = tempDir();
    try {
      const installCommand = COMMANDS.get("setup");
      const uninstallCommand = COMMANDS.get("uninstall");
      assert.ok(installCommand !== undefined && uninstallCommand !== undefined);
      const out: string[] = [];
      const deps: CliDeps = { stdout: collector(out), stderr: collector(out), commands: COMMANDS };
      const launcher = join(home, ".local", "share", "foxleash", "foxleash-host");
      const manifest = join(home, ".mozilla", "native-messaging-hosts", "foxleash.json");
      assert.equal(await installCommand({ noClaude: true, noExtension: true }, deps), 0);
      const main = fileURLToPath(new URL("./main.ts", import.meta.url));
      assert.equal(readFileSync(launcher, "utf8"), launcherScript(process.execPath, main));
      assert.equal(await uninstallCommand({ noClaude: true }, deps), 0);
      assert.equal(existsSync(launcher), false);
      assert.equal(existsSync(manifest), false);
      assert.equal(
        out.join(""),
        [
          `wrote ${launcher}`,
          `wrote ${manifest}`,
          MCP_HEADER,
          JSON.stringify({
            mcpServers: { foxleash: { command: process.execPath, args: [main, "mcp"] } },
          }),
          "Next: npm run doctor",
          `removed ${manifest}`,
          `removed ${launcher}`,
          "",
        ].join("\n"),
      );
    } finally {
      restoreEnv(previous);
    }
  });

  it("resolves a relative --xpi against INIT_CWD under npm run setup", async () => {
    const previous = saveEnv();
    const initCwd = tempDir();
    process.env.HOME = tempDir();
    process.env.PATH = tempDir();
    process.env.INIT_CWD = initCwd;
    process.env.npm_lifecycle_event = "setup";
    try {
      const { code, output } = await runInstallCommand({ noClaude: true, xpi: "missing.xpi" });
      assert.equal(code, 1);
      assert.ok(output.endsWith(`no file at ${join(initCwd, "missing.xpi")}\n`), output);
    } finally {
      restoreEnv(previous);
    }
  });

  it("resolves a relative --xpi against the working directory outside npm run setup", async () => {
    const previous = saveEnv();
    const cwd = tempDir();
    process.env.HOME = tempDir();
    process.env.PATH = tempDir();
    process.env.INIT_CWD = tempDir();
    delete process.env.npm_lifecycle_event;
    process.chdir(cwd);
    try {
      const { code, output } = await runInstallCommand({ noClaude: true, xpi: "missing.xpi" });
      assert.equal(code, 1);
      assert.ok(output.endsWith(`no file at ${join(cwd, "missing.xpi")}\n`), output);
    } finally {
      restoreEnv(previous);
    }
  });

  it("resolves a relative --xpi against the working directory without INIT_CWD", async () => {
    const previous = saveEnv();
    const cwd = tempDir();
    process.env.HOME = tempDir();
    process.env.PATH = tempDir();
    delete process.env.INIT_CWD;
    process.env.npm_lifecycle_event = "setup";
    process.chdir(cwd);
    try {
      const { code, output } = await runInstallCommand({ noClaude: true, xpi: "missing.xpi" });
      assert.equal(code, 1);
      assert.ok(output.endsWith(`no file at ${join(cwd, "missing.xpi")}\n`), output);
    } finally {
      restoreEnv(previous);
    }
  });

  it("names the add-on's page by default and runs neither gh nor firefox", async () => {
    const previous = saveEnv();
    const home = tempDir();
    const bin = tempDir();
    for (const name of ["gh", "firefox"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n: > "$HOME/${name}-ran"\n`, { mode: 0o755 });
    }
    process.env.HOME = home;
    process.env.PATH = bin;
    try {
      const { code, output } = await runInstallCommand({ noClaude: true });
      assert.equal(code, 0);
      assert.ok(output.endsWith(`${PAGE_LINE}\nNext: npm run doctor\n`), output);
      await sleep(200);
      assert.equal(existsSync(join(home, "gh-ran")), false);
      assert.equal(existsSync(join(home, "firefox-ran")), false);
    } finally {
      restoreEnv(previous);
    }
  });

  it("starts firefox with the absolute path of an existing --xpi", {
    timeout: 10_000,
  }, async () => {
    const previous = saveEnv();
    const home = tempDir();
    const initCwd = tempDir();
    const bin = tempDir();
    const xpi = join(initCwd, "foxleash.xpi");
    writeFileSync(xpi, "signed");
    writeFileSync(
      join(bin, "firefox"),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$HOME/firefox-args.tmp"\n/bin/mv "$HOME/firefox-args.tmp" "$HOME/firefox-args"\n',
      { mode: 0o755 },
    );
    process.env.HOME = home;
    process.env.PATH = bin;
    process.env.INIT_CWD = initCwd;
    process.env.npm_lifecycle_event = "setup";
    try {
      const { code, output } = await runInstallCommand({ noClaude: true, xpi: "foxleash.xpi" });
      assert.equal(code, 0);
      assert.ok(
        output.endsWith(
          `opened ${xpi} in Firefox; confirm the installation there\nNext: npm run doctor\n`,
        ),
        output,
      );
      const args = join(home, "firefox-args");
      for (let i = 0; i < 250 && !existsSync(args); i += 1) {
        await sleep(20);
      }
      assert.equal(readFileSync(args, "utf8"), `${xpi}\n`);
    } finally {
      restoreEnv(previous);
    }
  });
});

async function runInstallCommand(
  options: CommandOptions,
): Promise<{ code: number; output: string }> {
  const installCommand = COMMANDS.get("install");
  assert.ok(installCommand !== undefined);
  const out: string[] = [];
  const deps: CliDeps = { stdout: collector(out), stderr: collector(out), commands: COMMANDS };
  const code = await installCommand(options, deps);
  return { code, output: out.join("") };
}

interface SavedEnv {
  cwd: string;
  values: Record<"HOME" | "PATH" | "INIT_CWD" | "npm_lifecycle_event", string | undefined>;
}

function saveEnv(): SavedEnv {
  const { HOME, PATH, INIT_CWD, npm_lifecycle_event } = process.env;
  return { cwd: process.cwd(), values: { HOME, PATH, INIT_CWD, npm_lifecycle_event } };
}

function restoreEnv(saved: SavedEnv): void {
  process.chdir(saved.cwd);
  for (const [name, value] of Object.entries(saved.values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foxleash-install-"));
  temps.push(dir);
  return dir;
}

type Scripted = RunResult | ((args: readonly string[]) => RunResult);

function setup(home: string, results: Scripted[], launchResult: LaunchResult = { status: "ok" }) {
  const calls: Call[] = [];
  const launches: [string, string[]][] = [];
  const chunks: string[] = [];
  const queue = [...results];
  let running = false;
  async function run(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ): Promise<RunResult> {
    calls.push([command, [...args], options]);
    if (running) {
      throw new Error(`call before the previous one finished: ${command} ${args.join(" ")}`);
    }
    const scripted = queue.shift();
    if (scripted === undefined) {
      throw new Error(`unscripted call: ${command} ${args.join(" ")}`);
    }
    running = true;
    await new Promise((resolve) => setImmediate(resolve));
    running = false;
    return typeof scripted === "function" ? scripted(args) : scripted;
  }
  async function launch(command: string, args: readonly string[]): Promise<LaunchResult> {
    launches.push([command, [...args]]);
    return launchResult;
  }
  const extension: ExtensionSource = { kind: "none" };
  const program: Program = { kind: "source", main: MAIN };
  return {
    calls,
    launches,
    launcher: join(home, ".local", "share", "foxleash", "foxleash-host"),
    manifest: join(home, ".mozilla", "native-messaging-hosts", "foxleash.json"),
    output: () => chunks.join(""),
    options: {
      home,
      node: NODE,
      program,
      claude: true,
      extension,
      run,
      launch,
      out: collector(chunks),
    },
  };
}

function localXpi(): string {
  const xpi = join(tempDir(), "foxleash.xpi");
  writeFileSync(xpi, "signed");
  return xpi;
}

function bundleFile(text: string): string {
  const file = join(tempDir(), "foxleash.mjs");
  writeFileSync(file, text);
  return file;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function collector(chunks: string[]): Writable {
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
}
