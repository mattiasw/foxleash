import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Metafile } from "esbuild";
import { build, bundledPackageDirs, thirdPartyNotices } from "../build.ts";
import { USAGE } from "./cli.ts";
import { installPaths, launcherScript, nativeManifest } from "./install.ts";
import { SERVER_VERSION } from "./version.ts";

const CHILD_MS = 15_000;
const LIMIT = { timeout: 30_000 };
const REPO = join(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const FILES = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "foxleash.mjs", "package.json"];
let out = "";
let metafile: Metafile;
// Read the moment build() resolves: a write it did not wait for would be missing or short here.
let built = new Map<string, Buffer>();

before(
  async () => {
    // A folder whose parent does not exist yet.
    out = join(tempDir(), "nested", "dist");
    metafile = await build(out);
    built = new Map(readdirSync(out).map((file) => [file, readFileSync(join(out, file))]));
  },
  { timeout: 60_000 },
);

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the npm package", () => {
  it("holds exactly its five files, written in full by the time the build resolves", () => {
    assert.deepEqual([...built.keys()].sort(), FILES);
    for (const file of FILES) {
      assert.deepEqual(built.get(file), readFileSync(join(out, file)), file);
    }
  });

  it("replaces an earlier build's folder", { timeout: 60_000 }, async () => {
    const again = tempDir();
    writeFileSync(join(again, "stale"), "old");
    await build(again);
    assert.deepEqual(readdirSync(again).sort(), FILES);
  });

  it("bundles the program unminified, so reviewers can read it", () => {
    const program = String(built.get("foxleash.mjs"));
    assert.ok(program.startsWith("#!/usr/bin/env node\n"));
    assert.ok(program.includes("function copyProgram(from, to) {"));
  });

  it("has a package.json with no dependencies, scripts or private flag", () => {
    assert.deepEqual(JSON.parse(String(built.get("package.json"))), {
      name: "foxleash",
      version: SERVER_VERSION,
      description: "Let an AI agent use your own Firefox through MCP tools",
      license: "GPL-3.0-or-later",
      type: "module",
      bin: { foxleash: "foxleash.mjs" },
      engines: { node: ">=24" },
      os: ["linux"],
      repository: { type: "git", url: "git+https://github.com/mattiasw/foxleash.git" },
    });
  });

  it("carries the license and the README of the repository", () => {
    assert.equal(String(built.get("LICENSE")), read("LICENSE"));
    assert.equal(String(built.get("README.md")), read("README.md"));
  });

  it("lists every bundled package with its license text, and no workspace code", () => {
    const notices = String(built.get("THIRD_PARTY_NOTICES.md"));
    for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
      const dir = join(REPO, "node_modules", name);
      const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const license = readFileSync(join(dir, "LICENSE"), "utf8").trim();
      assert.ok(
        notices.includes(`## ${name} ${version}\n\nLicense: MIT\n\n${license}\n`),
        `${name} ${version} with its license text`,
      );
    }
    const bundled = new Set<string>();
    for (const input of Object.keys(metafile.inputs)) {
      const at = input.lastIndexOf("node_modules/");
      if (at === -1) continue;
      const parts = input.slice(at + "node_modules/".length).split("/");
      bundled.add(parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? ""));
    }
    assert.ok(bundled.size >= 2);
    for (const name of bundled) {
      assert.ok(notices.includes(`\n## ${name} `), `${name} has a section`);
    }
    assert.ok(!notices.includes("@foxleash/"));
  });
});

describe("the bundled program", () => {
  it("prints the usage for --help", () => {
    const result = run(["--help"], tempDir());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, USAGE);
  });

  it("answers MCP initialize and tools/list, and exits 0 when stdin ends", LIMIT, async () => {
    const home = tempDir();
    const child = spawn(process.execPath, [join(out, "foxleash.mjs"), "mcp"], {
      env: env(home),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CHILD_MS,
    });
    children.push(child);
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async (): Promise<Record<string, unknown>> => {
      const line = await lines.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    };
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    const initialized = await next();
    assert.equal(initialized.id, 1);
    assert.deepEqual(field(initialized.result, "serverInfo"), {
      name: "foxleash",
      version: SERVER_VERSION,
    });
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await next();
    assert.equal(list.id, 2);
    const tools = field(list.result, "tools");
    assert.ok(Array.isArray(tools) && tools.length > 0);
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  });

  it("sets up a copy of itself under HOME and removes it at uninstall", () => {
    const home = tempDir();
    const bundle = join(out, "foxleash.mjs");
    const setup = run(["setup", "--no-claude", "--no-extension"], home);
    assert.equal(setup.status, 0, setup.stderr);
    const { launcher, manifest, program } = installPaths(home);
    assert.deepEqual(readFileSync(program), readFileSync(bundle));
    assert.equal(statSync(program).mode & 0o777, 0o600);
    assert.equal(readFileSync(launcher, "utf8"), launcherScript(process.execPath, program));
    assert.equal(readFileSync(manifest, "utf8"), nativeManifest(launcher));
    assert.ok(
      setup.stdout.includes(
        `${JSON.stringify({ mcpServers: { foxleash: { command: process.execPath, args: [program, "mcp"] } } })}\n`,
      ),
      setup.stdout,
    );
    assert.ok(setup.stdout.endsWith("Next: npx foxleash doctor\n"), setup.stdout);

    const uninstall = run(["uninstall", "--no-claude"], home);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    for (const path of [program, launcher, manifest]) {
      assert.equal(existsSync(path), false, path);
    }
  });

  const routes: [string, () => string, string][] = [
    ["the bundle", () => join(out, "foxleash.mjs"), "npx foxleash setup"],
    ["the source", () => join(import.meta.dirname, "main.ts"), "npm run setup"],
  ];
  for (const [route, file, command] of routes) {
    it(`makes doctor run from ${route} name ${command}`, LIMIT, () => {
      const home = tempDir();
      // An empty PATH: doctor's claude check must not reach a real claude.
      const result = spawnSync(process.execPath, [file(), "doctor"], {
        env: { ...env(home), PATH: tempDir() },
        encoding: "utf8",
        timeout: CHILD_MS,
      });
      assert.equal(result.status, 1, result.stderr);
      const { manifest } = installPaths(home);
      assert.ok(
        result.stdout.includes(
          `FAIL native manifest: ${manifest} does not exist; run ${command}\n`,
        ),
        result.stdout,
      );
    });
  }
});

describe("bundledPackageDirs", () => {
  const repo = "/r";
  const work = "/r/apps/server";

  it("gives each package folder once, sorted, and skips the workspace's code", () => {
    assert.deepEqual(
      bundledPackageDirs(
        [
          "../../node_modules/zod/index.js",
          "../../node_modules/@scope/name/lib/a.js",
          "../../node_modules/zod/v4/b.js",
          "../../node_modules/a/node_modules/b/c.js",
          "../../node_modules/a/d.js",
          "src/main.ts",
          "package.json",
          "../../packages/protocol/src/index.ts",
          "node_modules/local/x.js",
        ],
        work,
        repo,
      ),
      [
        "/r/apps/server/node_modules/local",
        "/r/node_modules/@scope/name",
        "/r/node_modules/a",
        "/r/node_modules/a/node_modules/b",
        "/r/node_modules/zod",
      ],
    );
  });

  for (const input of [
    "../../node_modules/x.js",
    "../../node_modules/@scope/x.js",
    "../../node_modules/a/node_modules/@scope/x.js",
    "../../../elsewhere/lib/i.js",
    "../extension/src/x.ts",
    "../server-other/x.ts",
    "../../packages-other/x.ts",
  ]) {
    it(`throws naming ${input}`, () => {
      assert.throws(
        () => bundledPackageDirs([input], work, repo),
        (error: Error) => {
          assert.ok(error.message.startsWith(`${input} is `), error.message);
          return true;
        },
      );
    });
  }
});

describe("thirdPartyNotices", () => {
  it("lists each package sorted by name, with its license and notice texts", async () => {
    const root = tempDir();
    const zed = fixturePackage(root, "zed", { license: "ISC" }, { "LICENCE.txt": "  zed text \n" });
    const apache = fixturePackage(
      root,
      "apache",
      { license: "Apache-2.0" },
      { LICENSE: "apache license", NOTICE: "apache notice", "license.md": "second" },
    );
    assert.equal(
      await thirdPartyNotices([zed, apache]),
      [
        "# Third-party notices",
        "",
        "foxleash.mjs contains code from the packages below. Each is listed with its version, its license",
        "and the text of its license file.",
        "",
        "## apache 1.0.0",
        "",
        "License: Apache-2.0",
        "",
        "apache license",
        "",
        "second",
        "",
        "apache notice",
        "",
        "## zed 1.0.0",
        "",
        "License: ISC",
        "",
        "zed text",
        "",
      ].join("\n"),
    );
  });

  it("orders two versions of one package by version", async () => {
    const root = tempDir();
    const newer = fixturePackage(root, "p2", { name: "p", version: "2.0.0" }, { LICENSE: "x" });
    const older = fixturePackage(root, "p1", { name: "p", version: "1.0.0" }, { LICENSE: "x" });
    for (const dirs of [
      [newer, older],
      [older, newer],
    ]) {
      const text = await thirdPartyNotices(dirs);
      assert.ok(text.indexOf("## p 1.0.0") < text.indexOf("## p 2.0.0"), text);
    }
  });

  for (const license of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"]) {
    it(`accepts ${license}`, async () => {
      const dir = fixturePackage(tempDir(), "p", { license }, { LICENSE: "text" });
      assert.ok((await thirdPartyNotices([dir])).includes(`License: ${license}\n`));
    });
  }

  const ALLOWED = "is not one of MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0.";
  const refused: [string, Record<string, unknown>, string][] = [
    ["GPL-2.0", { license: "GPL-2.0" }, `p: license "GPL-2.0" ${ALLOWED}`],
    [
      "an SPDX expression",
      { license: "MIT OR Apache-2.0" },
      `p: license "MIT OR Apache-2.0" ${ALLOWED}`,
    ],
    ["a license object", { license: { type: "MIT" } }, `p: license {"type":"MIT"} ${ALLOWED}`],
    [
      "a licenses array",
      { license: undefined, licenses: [{ type: "MIT" }] },
      `p: license undefined ${ALLOWED}`,
    ],
    ["no version", { version: undefined }, "p: package.json has no version."],
    ["an empty version", { version: "" }, "p: package.json has no version."],
  ];
  for (const [name, fields, message] of refused) {
    it(`refuses a package with ${name}`, async () => {
      const dir = fixturePackage(tempDir(), "p", fields, { LICENSE: "text" });
      await assert.rejects(thirdPartyNotices([dir]), { message });
    });
  }

  for (const [name, value] of [
    ["no name", undefined],
    ["an empty name", ""],
  ] as const) {
    it(`refuses a package with ${name}, naming its folder`, async () => {
      const dir = fixturePackage(tempDir(), "p", { name: value }, { LICENSE: "text" });
      await assert.rejects(thirdPartyNotices([dir]), {
        message: `${dir}: package.json has no name.`,
      });
    });
  }

  it("refuses a package without a license file", async () => {
    const dir = fixturePackage(tempDir(), "p", {}, { "README.md": "x", "LICENSE-MIT": "x" });
    await assert.rejects(thirdPartyNotices([dir]), {
      message: "p: no license file (LICENSE, LICENCE, LICENSE.md, LICENSE.txt).",
    });
  });

  it("refuses an empty license file", async () => {
    const dir = fixturePackage(tempDir(), "p", {}, { LICENSE: " \n\t\n" });
    await assert.rejects(thirdPartyNotices([dir]), { message: "p: LICENSE is empty." });
  });

  it("refuses an empty notice file", async () => {
    const dir = fixturePackage(tempDir(), "p", {}, { LICENSE: "x", "NOTICE.txt": "" });
    await assert.rejects(thirdPartyNotices([dir]), { message: "p: NOTICE.txt is empty." });
  });

  it("refuses a license file that is a symlink to a readable file", async () => {
    const root = tempDir();
    const dir = fixturePackage(root, "p", {}, {});
    writeFileSync(join(root, "elsewhere"), "secret");
    symlinkSync(join(root, "elsewhere"), join(dir, "LICENSE"));
    await assert.rejects(thirdPartyNotices([dir]), {
      message: "p: LICENSE is not a regular file.",
    });
  });

  it("refuses a license file that is a directory", async () => {
    const dir = fixturePackage(tempDir(), "p", {}, {});
    mkdirSync(join(dir, "LICENSE.md"));
    await assert.rejects(thirdPartyNotices([dir]), {
      message: "p: LICENSE.md is not a regular file.",
    });
  });

  it("names the folder of a package without a package.json", async () => {
    const dir = join(tempDir(), "gone");
    mkdirSync(dir);
    await assert.rejects(thirdPartyNotices([dir]), (error: Error) => {
      assert.ok(error.message.startsWith(`${dir}: `), error.message);
      return true;
    });
  });
});

function run(
  args: string[],
  home: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(out, "foxleash.mjs"), ...args], {
    env: env(home),
    encoding: "utf8",
    timeout: CHILD_MS,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Never the inherited HOME: setup writes under it.
function env(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: home };
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function field(value: unknown, key: string): unknown {
  assert.ok(typeof value === "object" && value !== null);
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function read(file: string): string {
  return readFileSync(join(REPO, file), "utf8");
}

function tempDir(): string {
  const dir = mkdtempSync("/tmp/foxleash-test-");
  dirs.push(dir);
  return dir;
}

function fixturePackage(
  root: string,
  folder: string,
  fields: Record<string, unknown>,
  files: Record<string, string>,
): string {
  const dir = join(root, folder);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: folder, version: "1.0.0", license: "MIT", ...fields }),
  );
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
