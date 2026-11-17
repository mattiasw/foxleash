import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  assertMatchesList,
  assertNoNodeModulesAbove,
  assertNoTrackedLinks,
  childEnv,
  listFiles,
  main,
  partitionTrackedFiles,
  readmePattern,
  renderReadme,
  run,
  runBytes,
  selectShippedFiles,
} from "./build-amo.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LINK_ERROR = /tracked symlinks or submodules/;
const RULE_ERROR = /Add a ship or exclude rule/;

const SHIPPED = [
  ".npmrc",
  ".nvmrc",
  "apps/extension/build.ts",
  "apps/extension/icons/foxleash.svg",
  "apps/extension/manifest.json",
  "apps/extension/src/background.ts",
  "apps/extension/tsconfig.json",
  "package-lock.json",
  "package.json",
  "packages/protocol/src/index.ts",
  "packages/tsconfig/base.json",
  "turbo.json",
];

const EXCLUDED = [
  "AGENTS.md",
  "README.md",
  "apps/extension/dev.ts",
  "apps/extension/src/fake-browser.ts",
  "apps/extension/src/handlers.test.ts",
  "apps/server/src/cli.ts",
  "bin/build-amo.ts",
  "docs/development.md",
  "packages/protocol/src/index.test.ts",
];

function nul(items: readonly string[]): string {
  return `${items.join("\0")}\0`;
}

function stage(entries: ReadonlyArray<readonly [mode: string, file: string]>): string {
  return nul(entries.map(([mode, file]) => `${mode} ${SHA} 0\t${file}`));
}

function regularStage(files: readonly string[]): string {
  return stage(files.map((file) => ["100644", file] as const));
}

describe("partitionTrackedFiles", () => {
  test("ships build input and excludes everything else, sorted in byte order", () => {
    const input = [...EXCLUDED, ...SHIPPED].reverse();
    const { ship, unclassified } = partitionTrackedFiles(input);
    assert.deepEqual(ship, SHIPPED);
    assert.deepEqual(unclassified, []);
  });

  test("sorts uppercase before lowercase, as LC_ALL=C sort does", () => {
    const { ship } = partitionTrackedFiles(["apps/extension/src/b.ts", "apps/extension/src/B.ts"]);
    assert.deepEqual(ship, ["apps/extension/src/B.ts", "apps/extension/src/b.ts"]);
  });

  test("ships the extension's html and css, and fails closed on other extensions", () => {
    const input = [
      "apps/extension/src/x.txt",
      "apps/extension/src/x.html",
      "apps/extension/src/x.css",
      "apps/extension/src/x.htm",
    ];
    assert.deepEqual(partitionTrackedFiles(input), {
      ship: ["apps/extension/src/x.css", "apps/extension/src/x.html"],
      unclassified: ["apps/extension/src/x.txt", "apps/extension/src/x.htm"],
    });
  });

  test("calls new files outside every rule unclassified", () => {
    const input = [
      "LICENSE.txt",
      "apps/extension/notes.md",
      "apps/other/index.ts",
      "packages/foo/index.ts",
      "packages/tsconfig",
    ];
    assert.deepEqual(partitionTrackedFiles(input), { ship: [], unclassified: input });
  });
});

describe("selectShippedFiles", () => {
  test("returns the sorted ship list", () => {
    const tracked = [...SHIPPED, ...EXCLUDED].reverse();
    assert.deepEqual(selectShippedFiles(nul(tracked), regularStage(tracked)), SHIPPED);
  });

  test("throws, naming each file that matches no rule", () => {
    const tracked = [...SHIPPED, "apps/extension/notes.md", "LICENSE.txt"];
    assert.throws(
      () => selectShippedFiles(nul(tracked), regularStage(tracked)),
      (error: Error) => {
        assert.match(error.message, RULE_ERROR);
        assert.match(error.message, /"apps\/extension\/notes\.md"/);
        assert.match(error.message, /"LICENSE\.txt"/);
        return true;
      },
    );
  });

  test("names a symlinked directory as a link, not as an unclassified file", () => {
    const tracked = ["package.json", "packages/tsconfig"];
    const stageZ = stage([
      ["100644", "package.json"],
      ["120000", "packages/tsconfig"],
    ]);
    assert.throws(
      () => selectShippedFiles(nul(tracked), stageZ),
      (error: Error) => {
        assert.match(error.message, LINK_ERROR);
        assert.match(error.message, /"packages\/tsconfig"/);
        assert.doesNotMatch(error.message, RULE_ERROR);
        return true;
      },
    );
  });

  test("names a submodule as a link, not as an unclassified file", () => {
    const tracked = ["package.json", "packages/protocol"];
    const stageZ = stage([
      ["100644", "package.json"],
      ["160000", "packages/protocol"],
    ]);
    assert.throws(() => selectShippedFiles(nul(tracked), stageZ), LINK_ERROR);
  });

  test("refuses a link above the README template", () => {
    assert.throws(
      () => selectShippedFiles(nul(["package.json"]), stage([["120000", "bin"]])),
      LINK_ERROR,
    );
  });

  test("passes a symlink in an excluded tree", () => {
    const tracked = ["package.json", "docs/link.md"];
    const stageZ = stage([
      ["100644", "package.json"],
      ["120000", "docs/link.md"],
    ]);
    assert.deepEqual(selectShippedFiles(nul(tracked), stageZ), ["package.json"]);
  });

  test("reads git ls-tree records, refusing a symlink and a submodule", () => {
    const tree = (entries: ReadonlyArray<readonly [string, string, string]>): string =>
      nul(entries.map(([mode, type, file]) => `${mode} ${type} ${SHA}\t${file}`));
    const tracked = ["package.json", "apps/extension/icons", "packages/protocol"];
    assert.throws(
      () =>
        selectShippedFiles(
          nul(tracked),
          tree([
            ["100644", "blob", "package.json"],
            ["120000", "blob", "apps/extension/icons"],
            ["160000", "commit", "packages/protocol"],
          ]),
        ),
      (error: Error) => {
        assert.match(error.message, LINK_ERROR);
        assert.match(error.message, /"apps\/extension\/icons"/);
        assert.match(error.message, /"packages\/protocol"/);
        assert.doesNotMatch(error.message, /"package\.json"/);
        return true;
      },
    );
    assert.deepEqual(
      selectShippedFiles(nul(["package.json"]), tree([["100644", "blob", "package.json"]])),
      ["package.json"],
    );
  });

  test("refuses a shipped path that is not a plain relative name, naming each", () => {
    const refused = [
      "apps/extension/../../../x.ts",
      "apps/extension/./a.ts",
      "apps/extension//a.ts",
      "apps/extension/icons/icon@2x.svg",
      "apps/extension/src/a+b.ts",
      "apps/extension/src/é.ts",
    ];
    const tracked = ["package.json", ...refused];
    assert.throws(
      () => selectShippedFiles(nul(tracked), regularStage(tracked)),
      (error: Error) => {
        assert.match(error.message, /these shipped paths are not plain relative names/);
        for (const file of refused) {
          assert.ok(error.message.includes(`\n  ${JSON.stringify(file)}`), file);
        }
        assert.doesNotMatch(error.message, /"package\.json"/);
        return true;
      },
    );
  });

  test("refuses an unsafe shipped path before naming unclassified files", () => {
    const tracked = ["apps/extension/src/a+b.ts", "LICENSE.txt"];
    assert.throws(
      () => selectShippedFiles(nul(tracked), regularStage(tracked)),
      (error: Error) => {
        assert.match(error.message, /not plain relative names/);
        assert.doesNotMatch(error.message, RULE_ERROR);
        return true;
      },
    );
  });

  test("passes top-level dotfiles and a name that only starts with two dots", () => {
    const tracked = [".npmrc", ".nvmrc", "apps/extension/src/..a.ts"];
    assert.deepEqual(selectShippedFiles(nul(tracked), regularStage(tracked)), tracked);
  });
});

describe("assertNoTrackedLinks", () => {
  const checked = ["apps/extension/src/background.ts", "package.json"];

  test("refuses a symlink at a checked path", () => {
    assert.throws(
      () => assertNoTrackedLinks(stage([["120000", "package.json"]]), checked),
      (error: Error) => {
        assert.match(error.message, LINK_ERROR);
        assert.match(error.message, /"package\.json"/);
        return true;
      },
    );
  });

  test("refuses a symlink at an ancestor directory of a checked path", () => {
    assert.throws(
      () => assertNoTrackedLinks(stage([["120000", "apps/extension"]]), checked),
      /"apps\/extension"/,
    );
  });

  test("refuses a submodule at an ancestor directory of a checked path", () => {
    assert.throws(() => assertNoTrackedLinks(stage([["160000", "apps"]]), checked), LINK_ERROR);
  });

  test("names every refused link", () => {
    const stageZ = stage([
      ["120000", "package.json"],
      ["160000", "apps"],
    ]);
    assert.throws(
      () => assertNoTrackedLinks(stageZ, checked),
      (error: Error) => {
        assert.match(error.message, /"package\.json"/);
        assert.match(error.message, /"apps"/);
        return true;
      },
    );
  });

  test("passes a symlink outside the checked paths", () => {
    assertNoTrackedLinks(stage([["120000", "docs/link.md"]]), checked);
  });

  test("passes a symlink whose name is a prefix but not an ancestor", () => {
    assertNoTrackedLinks(stage([["120000", "apps/ext"]]), checked);
  });

  test("passes regular and executable files at checked paths", () => {
    const stageZ = stage([
      ["100644", "package.json"],
      ["100755", "apps/extension/src/background.ts"],
    ]);
    assertNoTrackedLinks(stageZ, checked);
  });
});

describe("assertMatchesList", () => {
  const files = ["README.md", "apps/extension/build.ts", "package.json"];

  test("passes when the list matches, whatever order the files are in", () => {
    assertMatchesList([...files].reverse(), `${files.join("\n")}\n`);
  });

  test("passes a list without a trailing newline", () => {
    assertMatchesList(files, files.join("\n"));
  });

  test("passes an empty archive against an empty list", () => {
    assertMatchesList([], "");
  });

  test("reports an unlisted file and a missing file in one error", () => {
    assert.throws(
      () => assertMatchesList(["README.md", "extra.ts"], "README.md\nmissing.ts\n"),
      (error: Error) => {
        assert.match(error.message, /In the archive but not listed:\n {2}"extra\.ts"/);
        assert.match(error.message, /Listed but not in the archive:\n {2}"missing\.ts"/);
        assert.match(error.message, /does not match bin\/amo-source-files\.txt in HEAD's commit/);
        assert.match(error.message, /order, and commit it\.$/);
        return true;
      },
    );
  });

  test("reports a line with a trailing carriage return in its JSON form", () => {
    assert.throws(
      () => assertMatchesList(files, "README.md\napps/extension/build.ts\npackage.json\r\n"),
      (error: Error) => {
        assert.ok(error.message.includes('"package.json\\r"'), error.message);
        assert.match(error.message, /not listed:\n {2}"package\.json"\n/);
        return true;
      },
    );
  });

  test("refuses two lines out of order", () => {
    assert.throws(
      () => assertMatchesList(files, "apps/extension/build.ts\nREADME.md\npackage.json\n"),
      /Listed out of order or twice:\n {2}"README\.md"/,
    );
  });

  test("refuses a duplicated line", () => {
    assert.throws(
      () => assertMatchesList(files, `${files.join("\n")}\npackage.json\n`),
      /Listed out of order or twice:\n {2}"package\.json"/,
    );
  });

  test("reports a blank middle line", () => {
    assert.throws(
      () => assertMatchesList(files, "README.md\n\napps/extension/build.ts\npackage.json\n"),
      /Listed but not in the archive:\n {2}""/,
    );
  });
});

describe("renderReadme", () => {
  const template = readFileSync(path.join(import.meta.dirname, "amo-source-readme.md"), "utf8");

  test("fills in the exact Node and npm versions", () => {
    const rendered = renderReadme(template, { node: "24.99.1", npm: "11.98.7" });
    assert.match(rendered, /Node\.js 24\.99\.1/);
    assert.match(rendered, /npm 11\.98\.7/);
    assert.ok(!rendered.includes("{{"), rendered);
  });

  test("replaces every occurrence of a placeholder", () => {
    assert.equal(renderReadme("{{node}} {{npm}} {{node}}", { node: "1", npm: "2" }), "1 2 1");
  });

  test("keeps no em dash in the template", () => {
    assert.ok(!template.includes("—"));
  });

  test("throws on an unknown placeholder", () => {
    assert.throws(
      () => renderReadme("Node {{node}}, {{x}}", { node: "1", npm: "2" }),
      /unknown placeholders: \{\{x\}\}/,
    );
  });
});

describe("readmePattern", () => {
  const template = readFileSync(path.join(import.meta.dirname, "amo-source-readme.md"), "utf8");
  const pattern = readmePattern(template);
  const rendered = renderReadme(template, { node: "24.11.0", npm: "11.6.2" });

  test("matches the rendered template with any x.y.z versions", () => {
    assert.match(rendered, pattern);
    assert.match(renderReadme(template, { node: "1.2.3", npm: "100.0.99" }), pattern);
  });

  const refused: [string, string][] = [
    [
      "a line added",
      rendered.replace("## Build\n", "## Build\n\nRun npm ci --ignore-scripts=false.\n"),
    ],
    ["a Node version that is not x.y.z", renderReadme(template, { node: "24", npm: "11.6.2" })],
    ["a prerelease version", renderReadme(template, { node: "24.0.0-pre", npm: "11.6.2" })],
    ["text before", `x${rendered}`],
    ["text after", `${rendered}x`],
    ["a final newline dropped", rendered.slice(0, -1)],
    ["the placeholders left", template],
  ];
  for (const [name, text] of refused) {
    test(`refuses the rendering with ${name}`, () => {
      assert.doesNotMatch(text, pattern);
    });
  }

  test("matches a template's special characters only literally", () => {
    const special = "(a*) .$ \\d [x] {{node}} ^b+ c? {2} | /{{npm}}\n";
    const literal = readmePattern(special);
    assert.match(renderReadme(special, { node: "1.2.3", npm: "4.5.6" }), literal);
    assert.doesNotMatch("(aaa) x$ 7 x 1.2.3 b c {2} | /4.5.6\n", literal);
    assert.doesNotMatch("(a*) .$ \\d [x] 1.2.3 ^b+ c? {2}  /4.5.6\n", literal);
    assert.doesNotMatch("(a*) .$ \\d [x] 1.2.3 ^b+ c? {2} | /4.5.6\n\n", literal);
  });
});

describe("run", () => {
  const cwd = os.tmpdir();

  test("returns the stdout of a command that exits 0", () => {
    assert.equal(run(process.execPath, ["-e", "process.stdout.write('ok')"], cwd), "ok");
  });

  test("throws with the status, stdout and stderr of a command that fails", () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    assert.throws(
      () => run(process.execPath, ["-e", script], cwd),
      (error: Error) => {
        assert.match(error.message, /status: 3\n/);
        assert.match(error.message, /stdout:\nout\n/);
        assert.match(error.message, /stderr:\nerr$/);
        return true;
      },
    );
  });

  test("throws for a command killed by a signal", () => {
    const script = "process.kill(process.pid, 'SIGTERM')";
    assert.throws(
      () => run(process.execPath, ["-e", script], cwd),
      /status: null\nsignal: SIGTERM/,
    );
  });

  test("runs the command without zip's option variables", (t) => {
    process.env.ZIPOPT = "-x README.md";
    t.after(() => Reflect.deleteProperty(process.env, "ZIPOPT"));
    const script = "process.stdout.write(String(process.env.ZIPOPT))";
    assert.equal(run(process.execPath, ["-e", script], cwd), "undefined");
  });

  test("throws for a command that cannot start", () => {
    assert.throws(() => run("foxleash-no-such-command", [], cwd), /error: .*ENOENT/);
  });

  test("runBytes returns stdout byte for byte", () => {
    const script = "process.stdout.write(Buffer.from([0xff, 0x00, 0x0a]))";
    assert.deepEqual(
      runBytes(process.execPath, ["-e", script], cwd),
      Buffer.from([0xff, 0x00, 0x0a]),
    );
  });

  test("runBytes throws with run's error text", () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    assert.throws(
      () => runBytes(process.execPath, ["-e", script], cwd),
      (error: Error) => {
        assert.match(error.message, /^bin\/build-amo\.ts: `.+` in .+ failed\nstatus: 3\n/);
        assert.match(error.message, /stdout:\nout\n/);
        assert.match(error.message, /stderr:\nerr$/);
        return true;
      },
    );
    assert.throws(() => runBytes("foxleash-no-such-command", [], cwd), /error: .*ENOENT/);
  });
});

describe("files in the checkout", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxleash-build-amo-test-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "");
  writeFileSync(path.join(root, "src", "deep", "b.ts"), "");
  symlinkSync("a.ts", path.join(root, "src", "link.ts"));
  symlinkSync("src", path.join(root, "linked-dir"));

  test("lists every file below a directory, links included, and no directories", async () => {
    const files = await listFiles(path.join(root, "src"));
    assert.deepEqual(files.sort(), ["a.ts", "deep/b.ts", "link.ts"]);
  });
});

describe("childEnv", () => {
  test("drops the option variables of zip and unzip and keeps the rest", () => {
    const env = { ZIP: "-x a", ZIPOPT: "-x b", UNZIP: "-x c", UNZIPOPT: "-x d", HOME: "/home/u" };
    assert.deepEqual(childEnv(env), { HOME: "/home/u" });
  });

  test("drops every node_modules folder from PATH", () => {
    const PATH = [
      "/work/foxleash/node_modules/.bin",
      "/usr/bin",
      "/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
      "/home/u/node_modules_old/bin",
      "/bin",
    ].join(path.delimiter);
    assert.deepEqual(childEnv({ PATH }), {
      PATH: ["/usr/bin", "/home/u/node_modules_old/bin", "/bin"].join(path.delimiter),
    });
  });

  test("leaves an environment without PATH without one", () => {
    assert.deepEqual(childEnv({ HOME: "/home/u" }), { HOME: "/home/u" });
  });
});

describe("assertNoNodeModulesAbove", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxleash-build-amo-test-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("refuses a node_modules folder in a folder above", () => {
    mkdirSync(path.join(base, "above", "node_modules"), { recursive: true });
    mkdirSync(path.join(base, "above", "a", "clean"), { recursive: true });
    assert.throws(
      () => assertNoNodeModulesAbove(path.join(base, "above", "a", "clean")),
      (error: Error) => {
        assert.ok(error.message.includes(path.join(base, "above", "node_modules")), error.message);
        return true;
      },
    );
  });

  test("passes a node_modules folder inside the folder itself", () => {
    mkdirSync(path.join(base, "inside", "clean", "node_modules"), { recursive: true });
    assertNoNodeModulesAbove(path.join(base, "inside", "clean"));
  });
});

// A repository whose build needs no packages, so the whole run works offline.
describe("main", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxleash-build-amo-test-")));
  // A private TMPDIR, so a temporary directory left behind is seen.
  const tmpdir = path.join(base, "tmp");
  mkdirSync(tmpdir);
  const settings = {
    TMPDIR: tmpdir,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  // A git hook in a linked worktree exports GIT_DIR, which would point the fixture's git
  // commands at the real repository's index.
  const gitVariables = Object.keys(process.env).filter((name) => name.startsWith("GIT_"));
  const saved = [...Object.keys(settings), ...gitVariables].map(
    (name) => [name, process.env[name]] as const,
  );
  for (const name of gitVariables) Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, settings);
  after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  const list = [
    "README.md",
    "apps/extension/build.ts",
    "apps/extension/icons/icon.svg",
    "apps/extension/package.json",
    "apps/extension/src/unused.ts",
    "package-lock.json",
    "package.json",
  ];
  // Not valid UTF-8, so a copy that decodes it would change it.
  const unused = Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a]);
  const buildLines = [
    'import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    // Through the workspace link, so the build fails without npm ci.
    'const pkg = "../../node_modules/@foxleash/extension/package.json";',
    'const { version } = JSON.parse(readFileSync(pkg, "utf8"));',
    'rmSync("dist", { recursive: true, force: true });',
    'mkdirSync("dist");',
    'writeFileSync("dist/manifest.json", JSON.stringify({ version }));',
    'cpSync("icons", "dist/icons", { recursive: true });',
  ];
  const files: Record<string, string | Buffer> = {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      workspaces: ["apps/*"],
      scripts: { build: "npm run build -w @foxleash/extension" },
    }),
    "package-lock.json": JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "fixture", workspaces: ["apps/*"] },
        "apps/extension": { name: "@foxleash/extension", version: "1.2.3" },
        "node_modules/@foxleash/extension": { resolved: "apps/extension", link: true },
      },
    }),
    "apps/extension/package.json": JSON.stringify({
      name: "@foxleash/extension",
      version: "1.2.3",
      private: true,
      type: "module",
      scripts: { build: "node build.ts" },
    }),
    "apps/extension/build.ts": buildLines.join("\n"),
    "apps/extension/icons/icon.svg": "<svg/>",
    "apps/extension/src/unused.ts": unused,
    "bin/amo-source-readme.md": "Node {{node}}, npm {{npm}}\n",
    "bin/amo-source-files.txt": `${list.join("\n")}\n`,
  };

  function fixture(name: string, overrides: Record<string, string> = {}): string {
    const root = path.join(base, name);
    for (const [file, content] of Object.entries({ ...files, ...overrides })) {
      write(root, file, content);
    }
    git(root, "init", "-q");
    for (const [setting, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
    ] as const) {
      git(root, "config", setting, value);
    }
    commitAll(root);
    execFileSync("npm", ["ci"], { cwd: root, stdio: "ignore" });
    return root;
  }

  function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  }

  function commitAll(root: string): void {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "Fixture");
  }

  function write(root: string, file: string, content: string | Buffer): void {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }

  // npm keeps its own compile cache in TMPDIR.
  function leftovers(): string[] {
    return readdirSync(tmpdir).filter((name) => name.startsWith("foxleash-amo-"));
  }

  function zipEntries(file: string): string[] {
    const names = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n");
    return names.filter((name) => name !== "" && !name.endsWith("/")).sort();
  }

  function sourceZip(root: string): string {
    return path.join(root, "artifacts", "foxleash-source-1.2.3.zip");
  }

  function entry(zip: string, name: string): Buffer {
    return execFileSync("unzip", ["-p", zip, name]);
  }

  test("writes the listed source zip and the XPI built from it, and nothing else", async (t) => {
    const root = fixture("passes");
    write(root, "artifacts/stale.txt", "");
    write(root, "amo-dist/leftover.ts", "");
    const log = t.mock.method(console, "log", () => {});
    await main(root);
    const artifacts = path.join(root, "artifacts");
    assert.deepEqual(
      log.mock.calls.slice(-2).map((call) => call.arguments),
      [
        [`Source archive: ${path.join(artifacts, "foxleash-source-1.2.3.zip")}`],
        [`Extension built from it: ${path.join(artifacts, "foxleash-1.2.3.xpi")}`],
      ],
    );
    assert.deepEqual(readdirSync(artifacts).sort(), [
      "foxleash-1.2.3.xpi",
      "foxleash-source-1.2.3.zip",
    ]);
    const probe = path.join(root, "mode-probe");
    mkdirSync(probe);
    assert.equal(statSync(artifacts).mode & 0o777, statSync(probe).mode & 0o777);
    assert.deepEqual(zipEntries(sourceZip(root)), list);
    const readme = entry(sourceZip(root), "README.md").toString("utf8");
    assert.match(readme, /^Node \d+\.\d+\.\d+, npm \d+\.\d+\.\d+\n$/);
    assert.deepEqual(entry(sourceZip(root), "apps/extension/src/unused.ts"), unused);
    const xpi = path.join(artifacts, "foxleash-1.2.3.xpi");
    assert.deepEqual(zipEntries(xpi), ["icons/icon.svg", "manifest.json"]);
    assert.equal(existsSync(path.join(root, "amo-dist")), false);
    assert.deepEqual(leftovers(), []);
  });

  test("refuses a shipped file missing from the list and writes no artifacts", async () => {
    const root = fixture("unlisted");
    write(root, "apps/extension/icons/extra.svg", "<svg/>");
    commitAll(root);
    write(root, "artifacts/foxleash-1.2.3.xpi", "from an earlier run");
    await assert.rejects(
      main(root),
      /In the archive but not listed:\n {2}"apps\/extension\/icons\/extra\.svg"/,
    );
    assert.equal(existsSync(path.join(root, "artifacts")), false);
    assert.deepEqual(leftovers(), []);
  });

  test("refuses a checkout build that reads an untracked file and writes no artifacts", async () => {
    const root = fixture("untracked");
    write(root, "artifacts/foxleash-1.2.3.xpi", "from an earlier run");
    write(root, "apps/extension/icons/extra.svg", "<svg/>");
    await assert.rejects(main(root), /Only in .*icons: extra\.svg/);
    assert.equal(existsSync(path.join(root, "artifacts")), false);
    assert.deepEqual(leftovers(), []);
  });

  test("refuses an uncommitted edit the build reads and writes no artifacts", async () => {
    const root = fixture("edited-read");
    write(root, "artifacts/foxleash-1.2.3.xpi", "from an earlier run");
    write(root, "apps/extension/icons/icon.svg", "<svg><script/></svg>");
    await assert.rejects(
      main(root),
      /stdout:\ndiff -r \S*\/icons\/icon\.svg \S*\/icons\/icon\.svg\n/,
    );
    assert.equal(existsSync(path.join(root, "artifacts")), false);
    assert.deepEqual(leftovers(), []);
  });

  test("archives the committed files the build does not read, not their staged edits", async () => {
    const root = fixture("edited-unread");
    write(root, "apps/extension/src/unused.ts", "// edited\n");
    write(root, "apps/extension/src/staged.ts", "// staged\n");
    git(root, "add", "apps/extension/src");
    await main(root);
    assert.deepEqual(entry(sourceZip(root), "apps/extension/src/unused.ts"), unused);
    assert.deepEqual(zipEntries(sourceZip(root)), list);
  });

  test("takes the README template and the list from the commit, not the checkout or the index", async () => {
    const root = fixture("edited-template");
    write(root, "bin/amo-source-readme.md", "Run npm ci --ignore-scripts=false {{node}}\n");
    write(root, "bin/amo-source-files.txt", "");
    git(root, "add", "bin");
    await main(root);
    const readme = entry(sourceZip(root), "README.md").toString("utf8");
    assert.match(readme, /^Node \d+\.\d+\.\d+, npm \d+\.\d+\.\d+\n$/);
    assert.deepEqual(zipEntries(sourceZip(root)), list);
  });

  test("archives the committed bytes whatever replace refs say", async () => {
    const root = fixture("replaced");
    const committed = git(root, "rev-parse", "HEAD:apps/extension/src/unused.ts");
    const other = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "// replaced\n",
      encoding: "utf8",
    }).trim();
    git(root, "replace", committed, other);
    assert.equal(git(root, "cat-file", "blob", committed), "// replaced");
    await main(root);
    assert.deepEqual(entry(sourceZip(root), "apps/extension/src/unused.ts"), unused);
  });

  test("leaves artifacts written by another run alone and fails", async () => {
    // Only the checkout build reaches the checkout's artifacts/; the clean copy's lands in its
    // own temporary folder.
    const root = fixture("concurrent", {
      "apps/extension/build.ts": [
        ...buildLines,
        'mkdirSync("../../artifacts", { recursive: true });',
        'writeFileSync("../../artifacts/other.txt", "");',
      ].join("\n"),
    });
    await assert.rejects(
      main(root),
      /could not move the artifacts to .*artifacts, which another run/,
    );
    assert.deepEqual(readdirSync(path.join(root, "artifacts")), ["other.txt"]);
    assert.deepEqual(leftovers(), []);
  });

  test("refuses a temporary directory with node_modules above it and writes no artifacts", async (t) => {
    const root = fixture("above");
    const nested = path.join(base, "nested");
    mkdirSync(path.join(nested, "node_modules"), { recursive: true });
    mkdirSync(path.join(nested, "tmp"));
    process.env.TMPDIR = path.join(nested, "tmp");
    t.after(() => {
      process.env.TMPDIR = tmpdir;
    });
    await assert.rejects(main(root), /could load packages from folders above it/);
    assert.equal(existsSync(path.join(root, "artifacts")), false);
  });
});
