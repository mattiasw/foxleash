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
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type CliDeps, COMMANDS, type CommandOptions } from "./cli.ts";
import {
  claudeAddArgs,
  type ExtensionSource,
  extensionPath,
  install,
  installPaths,
  launcherScript,
  nativeManifest,
  shellQuote,
  uninstall,
} from "./install.ts";
import { type LaunchResult, type RunResult, runCommand } from "./run-command.ts";
import { SERVER_VERSION } from "./version.ts";

type Call = [string, string[], { timeoutMs: number }];

const NODE = "/opt/my node/it's/node";
const MAIN = "/src/fox 'hand'/main.ts";
const QUOTED_NODE = "'/opt/my node/it'\\''s/node'";
const QUOTED_MAIN = "'/src/fox '\\''hand'\\''/main.ts'";
const REMOVE: Call = ["claude", ["mcp", "remove", "-s", "user", "foxhand"], { timeoutMs: 30000 }];
const ADD: Call = [
  "claude",
  ["mcp", "add", "-s", "user", "foxhand", "--", NODE, MAIN, "mcp"],
  { timeoutMs: 30000 },
];
const OK: RunResult = { status: "ok", code: 0, stdout: "", stderr: "" };
const RELEASE: ExtensionSource = { kind: "release", version: "1.2.3" };
const GH_MISSING_HINT =
  "GitHub CLI (gh) was not found on PATH; install it and run gh auth login, or pass --xpi <path> with a signed Foxhand .xpi";
const GH_AUTH_HINT =
  "run gh auth login with an account that can read github.com/mattiasw/foxhand, pass --xpi <path> with a signed Foxhand .xpi, or skip the extension with --no-extension";
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
      ".local/share/foxhand",
      ".mozilla",
      ".mozilla/native-messaging-hosts",
    ]) {
      assert.equal(mode(join(home, dir)), 0o700, dir);
    }
    const expected = {
      name: "foxhand",
      description: "Foxhand native messaging host",
      path: t.launcher,
      type: "stdio",
      allowed_extensions: ["foxhand@mattiasw.com"],
    };
    const text = readFileSync(t.manifest, "utf8");
    assert.deepEqual(JSON.parse(text), expected);
    assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`);
    assert.equal(mode(t.manifest), 0o600);
    assert.deepEqual(installPaths(home), { launcher: t.launcher, manifest: t.manifest });
  });

  it("replaces the Claude Code registration even when the remove fails", async () => {
    const t = setup(tempDir(), [{ status: "failed", code: 1, stdout: "", stderr: "x\n" }, OK]);
    assert.equal(await install(t.options), 0);
    assert.deepEqual(t.calls, [REMOVE, ADD]);
    assert.equal(
      t.output(),
      `wrote ${t.launcher}\nwrote ${t.manifest}\nregistered Foxhand with Claude Code\nNext: npm run doctor\n`,
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
    assert.equal(t.output(), `wrote ${t.launcher}\nwrote ${t.manifest}\nNext: npm run doctor\n`);
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
        "Claude Code (claude) was not found on PATH; to register Foxhand yourself, run:",
        `'claude' 'mcp' 'add' '-s' 'user' 'foxhand' '--' ${QUOTED_NODE} ${QUOTED_MAIN} 'mcp'`,
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
    const options = { ...second.options, node: "/usr/bin/node", main: "/other/main.ts" };
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
    const dir = join(home, ".local", "share", "foxhand");
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
    const link = join(home, ".local", "share", "foxhand");
    symlinkSync(other, link);
    const t = setup(home, []);
    assert.equal(await install({ ...t.options, claude: false }), 0);
    assert.equal(readFileSync(join(other, "foxhand-host"), "utf8"), launcherScript(NODE, MAIN));
    const out = setup(home, []);
    assert.equal(await uninstall({ ...out.options, claude: false }), 0);
    assert.equal(out.output(), `removed ${t.manifest}\nremoved ${t.launcher}\n`);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.deepEqual(readdirSync(other), []);
  });
});

describe("the extension step", () => {
  it("downloads this version's release and opens it in Firefox", async () => {
    const home = tempDir();
    const t = setup(home, [OK, OK, writingGh(OK)]);
    const xpi = extensionPath(home, "1.2.3");
    assert.equal(await install({ ...t.options, extension: RELEASE }), 0);
    assert.deepEqual(t.calls, [REMOVE, ADD, gh(home)]);
    assert.deepEqual(t.launches, [["firefox", [xpi]]]);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        "registered Foxhand with Claude Code",
        `downloaded ${xpi}`,
        `opened ${xpi} in Firefox; confirm the installation there`,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
    assert.equal(readFileSync(xpi, "utf8"), "signed");
    assert.equal(mode(join(home, ".cache")), 0o700);
    assert.equal(mode(join(home, ".cache", "foxhand")), 0o700);
  });

  it("leaves the mode of an existing cache directory alone", async () => {
    const home = tempDir();
    const dir = join(home, ".cache", "foxhand");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const t = setup(home, [writingGh(OK)]);
    assert.equal(await install({ ...t.options, claude: false, extension: RELEASE }), 0);
    assert.equal(mode(dir), 0o755);
  });

  const failures: [string, RunResult, string[]][] = [
    ["missing", { status: "missing" }, [GH_MISSING_HINT]],
    [
      "failed",
      { status: "failed", code: 1, stdout: "", stderr: "  release not found\n" },
      ["gh release download: release not found", GH_AUTH_HINT],
    ],
    ["timeout", { status: "timeout" }, ["gh release download did not finish in 120 s"]],
  ];
  for (const [name, result, lines] of failures) {
    it(`returns 1 without opening anything when gh is ${name}`, async () => {
      const home = tempDir();
      const t = setup(home, [result]);
      assert.equal(await install({ ...t.options, claude: false, extension: RELEASE }), 1);
      assert.deepEqual(t.calls, [gh(home)]);
      assert.deepEqual(t.launches, []);
      assert.equal(
        t.output(),
        [`wrote ${t.launcher}`, `wrote ${t.manifest}`, ...lines, ""].join("\n"),
      );
    });
  }

  it("returns 1 without opening anything when gh wrote no file", async () => {
    const home = tempDir();
    const t = setup(home, [OK]);
    assert.equal(await install({ ...t.options, claude: false, extension: RELEASE }), 1);
    assert.deepEqual(t.launches, []);
    assert.equal(
      t.output(),
      `wrote ${t.launcher}\nwrote ${t.manifest}\ngh release download did not write ${extensionPath(home, "1.2.3")}\n`,
    );
  });

  it("opens a local file as given, without gh", async () => {
    const xpi = join(tempDir(), "my foxhand.xpi");
    writeFileSync(xpi, "signed");
    const t = setup(tempDir(), []);
    const extension: ExtensionSource = { kind: "file", path: xpi };
    assert.equal(await install({ ...t.options, claude: false, extension }), 0);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.launches, [["firefox", [xpi]]]);
    assert.equal(
      t.output(),
      `wrote ${t.launcher}\nwrote ${t.manifest}\nopened ${xpi} in Firefox; confirm the installation there\nNext: npm run doctor\n`,
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
      assert.equal(t.output(), `wrote ${t.launcher}\nwrote ${t.manifest}\nno file at ${xpi}\n`);
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
    assert.equal(t.output(), `wrote ${t.launcher}\nwrote ${t.manifest}\nNext: npm run doctor\n`);
    assert.equal(existsSync(join(home, ".cache")), false);
  });

  it("prints the file to open and returns 0 when firefox is not on PATH", async () => {
    const home = tempDir();
    const t = setup(home, [writingGh(OK)], { status: "missing" });
    const xpi = extensionPath(home, "1.2.3");
    assert.equal(await install({ ...t.options, claude: false, extension: RELEASE }), 0);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        `downloaded ${xpi}`,
        `Firefox (firefox) was not found on PATH; open ${xpi} in Firefox to install the extension`,
        "Next: npm run doctor",
        "",
      ].join("\n"),
    );
  });

  it("returns 1 when firefox could not be started", async () => {
    const home = tempDir();
    const t = setup(home, [writingGh(OK)], { status: "failed", error: "EACCES" });
    const xpi = extensionPath(home, "1.2.3");
    assert.equal(await install({ ...t.options, claude: false, extension: RELEASE }), 1);
    assert.equal(
      t.output(),
      [
        `wrote ${t.launcher}`,
        `wrote ${t.manifest}`,
        `downloaded ${xpi}`,
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
    it(`skips the extension when ${name}`, async () => {
      const t = setup(tempDir(), results);
      assert.equal(await install({ ...t.options, extension: RELEASE }), 1);
      assert.deepEqual(t.calls, calls);
      assert.deepEqual(t.launches, []);
    });
  }
});

describe("extensionPath", () => {
  it("puts the version's file in the Foxhand cache directory under HOME", () => {
    assert.equal(extensionPath("/home/u", "4.5.6"), "/home/u/.cache/foxhand/foxhand-4.5.6.xpi");
  });
});

describe("a HOME that is not absolute", () => {
  for (const home of ["", "relative/home"]) {
    for (const name of ["install", "uninstall"]) {
      it(`makes ${name} refuse ${JSON.stringify(home)}`, async () => {
        const cwd = tempDir();
        const previous = process.cwd();
        process.chdir(cwd);
        try {
          const t = setup(home, []);
          const code = name === "install" ? await install(t.options) : await uninstall(t.options);
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
  for (const name of ["install", "uninstall"]) {
    it(`makes ${name} refuse it`, async () => {
      const home = tempDir();
      const t = setup(home, []);
      const options = { ...t.options, uid: statSync(home).uid + 1 };
      const code = name === "install" ? await install(options) : await uninstall(options);
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
        stderr: '  No MCP server named "foxhand" in user scope\n',
      },
      'claude mcp remove: No MCP server named "foxhand" in user scope',
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
      assert.equal(existsSync(join(home, ".local", "share", "foxhand")), false);
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
    const kept = join(home, ".local", "share", "foxhand", "other");
    writeFileSync(kept, "mine");
    assert.equal(await uninstall({ ...t.options, claude: false }), 0);
    assert.equal(existsSync(t.launcher), false);
    assert.equal(readFileSync(kept, "utf8"), "mine");
  });

  it("removes a dangling symlink at the launcher path", async () => {
    const home = tempDir();
    const t = setup(home, []);
    mkdirSync(join(home, ".local", "share", "foxhand"), { recursive: true });
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
    mkdirSync(join(home, ".local", "share", "foxhand"), { recursive: true });
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

describe("the install and uninstall commands", () => {
  it("install and uninstall under $HOME", async () => {
    const home = tempDir();
    const previous = saveEnv();
    process.env.HOME = home;
    process.env.PATH = tempDir();
    try {
      const installCommand = COMMANDS.get("install");
      const uninstallCommand = COMMANDS.get("uninstall");
      assert.ok(installCommand !== undefined && uninstallCommand !== undefined);
      const out: string[] = [];
      const deps: CliDeps = { stdout: collector(out), stderr: collector(out), commands: COMMANDS };
      const launcher = join(home, ".local", "share", "foxhand", "foxhand-host");
      const manifest = join(home, ".mozilla", "native-messaging-hosts", "foxhand.json");
      assert.equal(await installCommand({ noClaude: true, noExtension: true }, deps), 0);
      assert.equal(
        readFileSync(launcher, "utf8"),
        launcherScript(process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url))),
      );
      assert.equal(await uninstallCommand({ noClaude: true }, deps), 0);
      assert.equal(existsSync(launcher), false);
      assert.equal(existsSync(manifest), false);
      assert.equal(
        out.join(""),
        `wrote ${launcher}\nwrote ${manifest}\nNext: npm run doctor\nremoved ${manifest}\nremoved ${launcher}\n`,
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

  it("downloads the release of this checkout's version by default", async () => {
    const previous = saveEnv();
    const home = tempDir();
    const bin = tempDir();
    writeFileSync(
      join(bin, "gh"),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$HOME/gh-args"\necho "not logged in" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    process.env.HOME = home;
    process.env.PATH = bin;
    try {
      const { code, output } = await runInstallCommand({ noClaude: true });
      assert.equal(code, 1);
      assert.ok(output.endsWith(`gh release download: not logged in\n${GH_AUTH_HINT}\n`), output);
      assert.equal(
        readFileSync(join(home, "gh-args"), "utf8"),
        `${gh(home, SERVER_VERSION)[1].join("\n")}\n`,
      );
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
    const xpi = join(initCwd, "foxhand.xpi");
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
      const { code, output } = await runInstallCommand({ noClaude: true, xpi: "foxhand.xpi" });
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
  const dir = mkdtempSync(join(tmpdir(), "foxhand-install-"));
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
  return {
    calls,
    launches,
    launcher: join(home, ".local", "share", "foxhand", "foxhand-host"),
    manifest: join(home, ".mozilla", "native-messaging-hosts", "foxhand.json"),
    output: () => chunks.join(""),
    options: {
      home,
      node: NODE,
      main: MAIN,
      claude: true,
      extension,
      run,
      launch,
      out: collector(chunks),
    },
  };
}

/** A gh that writes the asset into the --dir it was given, then returns `result`. */
function writingGh(result: RunResult): (args: readonly string[]) => RunResult {
  return (args) => {
    const dir = args[args.indexOf("--dir") + 1];
    const pattern = args[args.indexOf("--pattern") + 1];
    assert.ok(dir !== undefined && pattern !== undefined);
    writeFileSync(join(dir, pattern), "signed");
    return result;
  };
}

function gh(home: string, version = "1.2.3"): Call {
  return [
    "gh",
    [
      "release",
      "download",
      `v${version}`,
      "--repo",
      "github.com/mattiasw/foxhand",
      "--pattern",
      `foxhand-${version}.xpi`,
      "--dir",
      join(home, ".cache", "foxhand"),
      "--clobber",
    ],
    { timeoutMs: 120000 },
  ];
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
